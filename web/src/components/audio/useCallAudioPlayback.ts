import { useCallback, useEffect, useRef, useState } from 'react';
import { acquireAudioPlayback, subscribeAudioPlaybackInvalidation } from '@/services/audioPlayback';
import type { PlaybackInterval } from './transcriptPlayback';

type Selection = { key: string; interval: PlaybackInterval | null };
type Lease = Awaited<ReturnType<typeof acquireAudioPlayback>>;
export type CallAudioPlaybackState = {
  selectedKey: string | null;
  playing: boolean;
  loading: boolean;
  progress: { loaded: number; total: number | null };
  error: 'download' | 'playback' | 'unauthorized' | 'not-found' | 'timeout' | 'network' | null;
  elapsed: number;
  duration: number;
};
const INITIAL: CallAudioPlaybackState = {
  selectedKey: null, playing: false, loading: false, progress: { loaded: 0, total: null },
  error: null, elapsed: 0, duration: 0,
};

/** Owns one private recording while its transcript is mounted; the service owns the cache. */
export function useCallAudioPlayback(audioPath: string | undefined) {
  const [state, setState] = useState<CallAudioPlaybackState>(INITIAL);
  const commands = useRef<{ toggle: (selection: Selection) => void; cancel: () => void } | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const audioHost = useRef<HTMLDivElement | null>(null);

  useEffect(/** Creates and releases a single audio element and authenticated lease per call view. */ () => {
    const audio = new Audio();
    audio.hidden = true;
    audioElement.current = audio;
    audioHost.current?.appendChild(audio);
    audio.preload = 'metadata';
    audio.playbackRate = 1;
    let disposed = false;
    let lease: Lease | null = null;
    let pending: Promise<void> | null = null;
    let controller = new AbortController();
    let selection: Selection | null = null;
    let epoch = 0;
    let loading = false;
    let finished = false;
    let end = Infinity;
    let start = 0;
    let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
    setState(INITIAL);

    /** Publishes state only while this call view owns the element. */
    function update(patch: Partial<CallAudioPlaybackState>) {
      if (!disposed) setState(/** Retains independent progress and player fields. */ (previous) => ({ ...previous, ...patch }));
    }
    /** Stops the boundary timer on pause, navigation, and disposal. */
    function clearBoundary() { clearTimeout(boundaryTimer); }
    /** Stops at the precise stored boundary, including any following silence. */
    function tick() {
      if (audio.currentTime >= end) {
        finished = true;
        audio.pause();
        audio.currentTime = end;
      }
      update({ elapsed: Math.max(0, audio.currentTime - start), playing: !audio.paused });
    }
    /** Schedules the endpoint independently of the browser's coarse timeupdate event. */
    function scheduleBoundary() {
      clearBoundary();
      if (!audio.paused && Number.isFinite(end)) boundaryTimer = setTimeout(
        /** Rechecks actual playback position in case the stream stalled. */ () => { tick(); scheduleBoundary(); },
        Math.max(15, Math.min(250, (end - audio.currentTime) * 1000)),
      );
    }
    /** Mirrors user-agent playback state and enforces normal speed. */
    function onPlay() { audio.playbackRate = 1; update({ playing: true }); scheduleBoundary(); }
    /** Preserves the cursor when paused for a later resume. */
    function onPause() { clearBoundary(); update({ playing: false }); }
    /** Makes the next click replay rather than resume at the recording's end. */
    function onEnded() { finished = true; tick(); update({ playing: false }); }
    /** Surfaces decoding/network playback failures without exposing credentials or URLs. */
    function onError() { audio.pause(); update({ error: 'playback', playing: false }); }
    audio.addEventListener('timeupdate', tick);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    /** Releases both cached-lease ownership and pending work on access invalidation. */
    function reset() {
      epoch++;
      controller.abort();
      controller = new AbortController();
      pending = null;
      loading = false;
      audio.pause();
      clearBoundary();
      audio.removeAttribute('src');
      audio.load();
      lease?.release();
      lease = null;
      selection = null;
      finished = false;
      update(INITIAL);
    }

    /** Waits for media metadata with bounded cancellation, even for legacy URL playback. */
    function metadata(signal: AbortSignal): Promise<void> {
      if (audio.readyState >= 1) return Promise.resolve();
      return new Promise(/** Registers one-shot metadata listeners. */ (resolve, reject) => {
        /** Detaches all listeners and deadlines regardless of completion path. */
        function clean() {
          clearTimeout(timer);
          audio.removeEventListener('loadedmetadata', ready);
          audio.removeEventListener('error', failed);
          signal.removeEventListener('abort', failed);
        }
        /** Resolves only after duration and seeking metadata exist. */
        function ready() { clean(); resolve(); }
        /** Ends stalled loads rather than leaving an invisible pending player. */
        function failed() { clean(); reject(new Error('Audio metadata unavailable')); }
        const timer = setTimeout(failed, 30_000);
        audio.addEventListener('loadedmetadata', ready);
        audio.addEventListener('error', failed);
        signal.addEventListener('abort', failed);
        if (signal.aborted) failed();
      });
    }

    /** Shares the same acquisition across rapid segment changes. */
    function ensureAudio(): Promise<void> {
      if (pending) return pending;
      if (lease) return metadata(controller.signal);
      if (!audioPath) return Promise.reject(new Error('No audio path'));
      const signal = controller.signal;
      loading = true;
      update({ loading: true, progress: { loaded: 0, total: null }, error: null });
      /** Obtains authenticated audio through the shared bounded cache service. */
      const request = acquireAudioPlayback({ audioPath, signal,
        onProgress: /** Reflects only this active request's progress. */ (progress) => { if (!signal.aborted) update({ progress }); },
      }).then(/** Attaches the owned audio without permitting stale selection autoplay. */ async (result) => {
        if (disposed || signal.aborted) { result.release(); throw new Error('Canceled'); }
        lease = result;
        audio.src = result.url;
        audio.load();
        await metadata(signal);
      }).catch(/** Makes an unsuccessful load retryable and drops its lease. */ (error: unknown) => {
        if (!signal.aborted) { lease?.release(); lease = null; audio.removeAttribute('src'); audio.load(); }
        throw error;
      }).finally(/** Clears progress only if this is still the current request. */ () => {
        if (pending === request) { pending = null; loading = false; update({ loading: false }); }
      });
      pending = request;
      return request;
    }

    /** Plays or pauses a single selected interval and suppresses outdated async requests. */
    async function toggle(next: Selection) {
      const same = selection?.key === next.key;
      if (same && (loading || !audio.paused)) {
        epoch++;
        audio.pause();
        if (loading) reset();
        return;
      }
      const resume = same && !finished && audio.currentTime >= start && audio.currentTime < end;
      const token = ++epoch;
      audio.pause();
      selection = next;
      update({ selectedKey: next.key, error: null, playing: false,
        ...(!resume ? { elapsed: 0, duration: next.interval ? next.interval.end - next.interval.start : 0 } : {}) });
      try {
        await ensureAudio();
        if (disposed || token !== epoch) return;
        const duration = audio.duration;
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid duration');
        start = next.interval?.start ?? 0;
        end = Math.min(next.interval?.end ?? duration, duration);
        if (!Number.isFinite(start) || start < 0 || end <= start) throw new Error('Invalid segment');
        if (!resume || audio.currentTime >= end) audio.currentTime = start;
        finished = false;
        update({ duration: end - start, elapsed: Math.max(0, audio.currentTime - start) });
        audio.playbackRate = 1;
        await audio.play();
        // Another selection may supersede this promise; it owns subsequent playback.
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const known = ['unauthorized', 'not-found', 'timeout', 'network'].includes(code);
        if (!disposed && token === epoch) {
          finished = true;
          update({ error: known ? code as CallAudioPlaybackState['error'] : lease ? 'playback' : 'download', playing: false, loading: false });
        }
      }
    }
    commands.current = { toggle: /** Does not expose an unhandled promise to click handlers. */ (next) => { void toggle(next); }, cancel: reset };
    /** Auth/account invalidation must immediately stop private audio already in memory. */
    const unsubscribe = subscribeAudioPlaybackInvalidation(/** Preserve a denial message after fully clearing private playback. */ (reason) => {
      const affected = Boolean(selection || loading || lease);
      reset();
      if (reason === 'unauthorized' && affected) update({ error: 'unauthorized' });
    });
    return /** Cancels acquisition and stops audio before releasing the lease on tab/call exit. */ () => {
      disposed = true;
      reset();
      commands.current = null;
      unsubscribe();
      audio.removeEventListener('timeupdate', tick);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.remove();
      audioElement.current = null;
    };
  }, [audioPath]);

  const toggle = useCallback(/** Routes all segment and full-recording controls to one player. */ (key: string, interval: PlaybackInterval | null) => {
    commands.current?.toggle({ key, interval });
  }, []);
  const cancel = useCallback(/** Cancels a stalled download without leaving audio running. */ () => { commands.current?.cancel(); }, []);
  const attachAudioHost = useCallback(/** Keeps the single owned media element inside the current transcript DOM. */ (node: HTMLDivElement | null) => {
    audioHost.current = node;
    if (node && audioElement.current) node.appendChild(audioElement.current);
  }, []);
  return { ...state, toggle, cancel, attachAudioHost };
}
