import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('./useCallAudioPlayback.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** Exercise the actual hook with deterministic media time and asynchronous audio acquisition. */
function fixture({ delayed = false } = {}) {
  let state; let cleanup; let invalidated; let now = 0; let id = 0; let resolveLease;
  const timers = new Map(); const calls = { acquire: [], released: 0 }; const audios = [];
  class FakeAudio {
    constructor() { this.listeners = new Map(); this.paused = true; this.currentTime = 0; this.duration = 20; this.readyState = 0; audios.push(this); }
    addEventListener(type, fn) { const set = this.listeners.get(type) ?? new Set(); set.add(fn); this.listeners.set(type, set); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(); }
    load() { this.readyState = this.src ? 1 : 0; if (this.readyState) this.emit('loadedmetadata'); }
    removeAttribute(key) { if (key === 'src') this.src = ''; }
    remove() { this.removed = true; }
    play() { if (this.rejectPlay) return Promise.reject(new Error('Autoplay denied')); this.paused = false; this.emit('play'); return Promise.resolve(); }
    pause() { const changed = !this.paused; this.paused = true; if (changed) this.emit('pause'); }
  }
  const lease = { url: 'blob:private', release: () => { calls.released++; } };
  const acquisition = delayed ? new Promise(resolve => { resolveLease = resolve; }) : Promise.resolve(lease);
  const modules = {
    react: {
      useState: initial => { state = initial; return [state, next => { state = typeof next === 'function' ? next(state) : next; }]; },
      useRef: value => ({ current: value }), useCallback: callback => callback,
      useEffect: callback => { cleanup = callback(); },
    },
    '@/services/audioPlayback': {
      acquireAudioPlayback: options => { calls.acquire.push(options); return acquisition; },
      subscribeAudioPlaybackInvalidation: callback => { invalidated = callback; return () => {}; },
    },
  };
  const exports = {};
  runInNewContext(source, { exports, require: name => modules[name], Audio: FakeAudio, AbortController,
    setTimeout: (fn, delay) => { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimeout: key => timers.delete(key) });
  const hook = exports.useCallAudioPlayback('prepared-uploads/user/call/sample.mp3');
  async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      const end = next ? next[1].at : target;
      if (!audios[0].paused) audios[0].currentTime += (end - now) / 1000;
      now = end;
      if (!next) break;
      timers.delete(next[0]); next[1].fn(); await flush();
    }
    await flush();
  }
  return { hook, calls, audio: audios[0], state: () => state, flush, advance, cleanup: () => cleanup(),
    invalidate: reason => invalidated(reason), resolve: () => resolveLease(lease) };
}

test('one player seeks, includes the gap, stops at its endpoint, and replays on next click', async () => {
  const f = fixture(); const span = { start: 1, end: 8, includesPause: true };
  f.hook.toggle('0', span); await f.flush(); assert.equal(f.audio.currentTime, 1); assert.equal(f.audio.paused, false);
  await f.advance(7000); assert.equal(f.audio.paused, true); assert.equal(f.audio.currentTime, 8);
  f.hook.toggle('0', span); await f.flush(); assert.equal(f.audio.currentTime, 1); assert.equal(f.calls.acquire.length, 1);
  f.cleanup();
});

test('pause and resume preserve cursor; selecting another segment replaces the interval', async () => {
  const f = fixture(); const first = { start: 1, end: 8, includesPause: true };
  f.hook.toggle('0', first); await f.flush(); await f.advance(1000);
  f.hook.toggle('0', first); assert.equal(f.audio.paused, true); assert.equal(f.audio.currentTime, 2);
  f.hook.toggle('0', first); await f.flush(); assert.equal(f.audio.currentTime, 2);
  f.hook.toggle('1', { start: 9, end: 10.25, includesPause: false }); await f.flush();
  assert.equal(f.audio.currentTime, 9); await f.advance(1250); assert.equal(f.audio.currentTime, 10.25); assert.equal(f.audio.paused, true);
  f.cleanup();
});

test('rapid selections share acquisition and only the newest starts playing', async () => {
  const f = fixture({ delayed: true });
  f.hook.toggle('0', { start: 1, end: 8 }); f.hook.toggle('1', { start: 9, end: 11 });
  assert.equal(f.calls.acquire.length, 1); f.resolve(); await f.flush();
  assert.equal(f.audio.currentTime, 9); assert.equal(f.state().selectedKey, '1'); f.cleanup();
});

test('canceling a loading segment prevents late autoplay and releases its lease', async () => {
  const f = fixture({ delayed: true }); const interval = { start: 1, end: 8 };
  f.hook.toggle('0', interval); f.hook.toggle('0', interval);
  assert.equal(f.calls.acquire[0].signal.aborted, true); f.resolve(); await f.flush();
  assert.equal(f.audio.paused, true); assert.equal(f.calls.released, 1); f.cleanup();
});

test('leaving the transcript stops playback and releases ownership', async () => {
  const f = fixture(); f.hook.toggle('full', null); await f.flush(); f.cleanup();
  assert.equal(f.audio.paused, true); assert.equal(f.audio.src, ''); assert.equal(f.calls.released, 1);
});

test('auth invalidation stops active audio and clears selection', async () => {
  const f = fixture(); f.hook.toggle('0', { start: 1, end: 8 }); await f.flush(); f.invalidate();
  assert.equal(f.audio.paused, true); assert.equal(f.state().selectedKey, null); assert.equal(f.calls.released, 1); f.cleanup();
});

test('actual media duration clamps a requested endpoint', async () => {
  const f = fixture(); f.audio.duration = 3;
  f.hook.toggle('0', { start: 1, end: 8 }); await f.flush(); await f.advance(2000);
  assert.equal(f.audio.currentTime, 3); assert.equal(f.audio.paused, true); f.cleanup();
});

test('browser play rejection becomes an inline playback error', async () => {
  const f = fixture(); f.audio.rejectPlay = true;
  f.hook.toggle('0', { start: 1, end: 8 }); await f.flush();
  assert.equal(f.state().error, 'playback'); assert.equal(f.state().playing, false); f.cleanup();
});

test('permission denial during acquisition clears selection but retains a visible denial state', async () => {
  const f = fixture({ delayed: true }); f.hook.toggle('0', { start: 1, end: 8 });
  f.invalidate('unauthorized'); f.resolve(); await f.flush();
  assert.equal(f.audio.paused, true); assert.equal(f.state().selectedKey, null);
  assert.equal(f.state().error, 'unauthorized'); assert.equal(f.state().loading, false); f.cleanup();
});

test('permission loss stops playing audio without suppressing the denial message', async () => {
  const f = fixture(); f.hook.toggle('0', { start: 1, end: 8 }); await f.flush();
  f.invalidate('unauthorized'); assert.equal(f.audio.paused, true); assert.equal(f.audio.src, '');
  assert.equal(f.calls.released, 1); assert.equal(f.state().error, 'unauthorized'); f.cleanup();
});

test('logout during acquisition clears playback without a stale permission alert', async () => {
  const f = fixture({ delayed: true }); f.hook.toggle('0', { start: 1, end: 8 });
  f.invalidate(); f.resolve(); await f.flush(); assert.equal(f.state().error, null);
  assert.equal(f.state().selectedKey, null); assert.equal(f.audio.paused, true); f.cleanup();
});
