import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Pause, Volume2, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getAudioDownloadUrl } from '@/services/storage';

interface AudioPlayerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audioUrl?: string;
  audioPath?: string;
  callId?: string;  // For localStorage position persistence
  seekTo?: number;
}

/** Renders the AudioPlayerDialog component. */
export function AudioPlayerDialog({
  open,
  onOpenChange,
  audioUrl,
  audioPath,
  callId,
  seekTo,
}: AudioPlayerDialogProps) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(audioUrl || null);
  const [loading, setLoading] = useState(!audioUrl && !!audioPath);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Fetch audio URL when dialog opens
  // The storage helper returns either a normal download URL or an owned private-audio blob URL.
  useEffect(/** Handles the callback for this operation. */() => {
    if (!open) return;

    if (!audioPath) {
      setError(t('callDetail.noAudio', 'No audio available'));
      setLoading(false);
      return;
    }

    let canceled = false;
    let ownedBlobUrl: string | null = null;
    const fetchUrl = /** Loads audio without publishing results after cleanup. */ async () => {
      setLoading(true);
      setError(null);
      try {
        /** Reads normal audio URLs or authenticated private smoke audio from Firebase Storage. */
        const downloadUrl = await getAudioDownloadUrl(audioPath);
        if (downloadUrl.startsWith('blob:')) ownedBlobUrl = downloadUrl;
        if (canceled) {
          if (ownedBlobUrl) URL.revokeObjectURL(ownedBlobUrl);
          ownedBlobUrl = null;
          return;
        }
        setUrl(downloadUrl);
      } catch (err) {
        if (canceled) return;
        console.error('Failed to fetch audio URL:', err);
        setError(t('callDetail.audioLoadError', 'Failed to load audio'));
      } finally {
        if (!canceled) setLoading(false);
      }
    };

    fetchUrl();
    return /** Revokes only URLs created for this request, including close and unmount. */ () => {
      canceled = true;
      if (ownedBlobUrl) URL.revokeObjectURL(ownedBlobUrl);
      ownedBlobUrl = null;
    };
  }, [open, audioPath, t]);

  // Audio event listeners
  useEffect(/** Handles the callback for this operation. */() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = /** Handles the handleTimeUpdate interaction. */ () => setCurrentTime(audio.currentTime);
    const handleDurationChange = /** Handles the handleDurationChange interaction. */ () => setDuration(audio.duration || 0);
    const handleEnded = /** Handles the handleEnded interaction. */ () => setIsPlaying(false);
    const handlePlay = /** Handles the handlePlay interaction. */ () => setIsPlaying(true);
    const handlePause = /** Handles the handlePause interaction. */ () => setIsPlaying(false);
    const handleError = /** Handles the handleError interaction. */ () => {
      setError(t('callDetail.audioPlayError', 'Failed to play audio'));
      setIsPlaying(false);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('error', handleError);

    return /** Handles the callback for this operation. */ () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('error', handleError);
    };
  }, [url, loading, open, t]);

  // Pause audio and save position when dialog closes
  useEffect(/** Handles the callback for this operation. */() => {
    if (!open && audioRef.current) {
      // Save position to localStorage before closing
      if (callId && audioRef.current.currentTime > 0) {
        localStorage.setItem(`audio-pos-${callId}`, audioRef.current.currentTime.toString());
      }
      audioRef.current.pause();
      setIsPlaying(false);
    }
  }, [open, callId]);

  // Restore position from localStorage when audio loads
  useEffect(/** Handles the callback for this operation. */() => {
    const audio = audioRef.current;
    if (!audio || !open) return;

    const handleCanPlay = /** Handles the handleCanPlay interaction. */ () => {
      if (typeof seekTo === 'number' && Number.isFinite(seekTo)) {
        const target = Math.max(0, Math.min(seekTo, Number.isFinite(audio.duration) ? audio.duration : seekTo));
        audio.currentTime = target;
        setCurrentTime(target);
        audio.play().catch(/** Leaves playback available when the browser blocks autoplay. */ () => setIsPlaying(false));
        return;
      }
      if (!callId) return;
      const saved = localStorage.getItem(`audio-pos-${callId}`);
      if (saved) {
        const savedTime = parseFloat(saved);
        if (!isNaN(savedTime) && savedTime > 0) {
          audio.currentTime = savedTime;
          setCurrentTime(savedTime);
        }
      }
    };

    if (audio.readyState >= 2) handleCanPlay();
    else audio.addEventListener('canplay', handleCanPlay, { once: true });
    return /** Handles the callback for this operation. */ () => audio.removeEventListener('canplay', handleCanPlay);
  }, [open, url, callId, seekTo, loading]);

  const togglePlay = /** Documents the togglePlay behavior. */ () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch(/** Handles the callback for this operation. */() => {
        setError(t('callDetail.audioPlayError', 'Failed to play audio'));
      });
    }
  };

  const handleSeek = /** Handles the handleSeek interaction. */ (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const time = parseFloat(e.target.value);
    audio.currentTime = time;
    setCurrentTime(time);
  };

  const formatTime = /** Documents the formatTime behavior. */ (seconds: number) => {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Volume2 className="h-5 w-5" />
            {t('callDetail.recording', 'Call Recording')}
          </DialogTitle>
        </DialogHeader>

        <div className="py-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {error && !loading && (
            <div className="text-center py-8 text-muted-foreground">
              {error}
            </div>
          )}

          {url && !loading && !error && (
            <div className="space-y-4">
              <audio ref={audioRef} src={url} preload="metadata" />

              {/* Play/Pause and Progress */}
              <div className="flex items-center gap-4">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-12 w-12 rounded-full"
                  onClick={togglePlay}
                >
                  {isPlaying ? (
                    <Pause className="h-6 w-6" />
                  ) : (
                    <Play className="h-6 w-6 ml-1" />
                  )}
                </Button>

                <div className="flex-1 space-y-1">
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    value={currentTime}
                    onChange={handleSeek}
                    className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
