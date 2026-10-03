import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, AlertCircle, Loader2, Play, Pause } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getAudioDownloadUrl } from '@/services/storage';

interface AudioPlayerProps {
  audioUrl?: string;
  audioPath?: string;
}

// Full-width card-based audio player
export function AudioPlayer({ audioUrl, audioPath }: AudioPlayerProps) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(audioUrl || null);
  const [loading, setLoading] = useState(!audioUrl && !!audioPath);
  const [error, setError] = useState<string | null>(null);

  useEffect(/** Handles the callback for this operation. */() => {
    if (audioUrl) {
      setUrl(audioUrl);
      setLoading(false);
      return;
    }

    if (!audioPath) {
      setError('No audio available');
      setLoading(false);
      return;
    }

    const fetchUrl = /** Documents the fetchUrl behavior. */ async () => {
      setLoading(true);
      setError(null);
      try {
        const downloadUrl = await getAudioDownloadUrl(audioPath);
        setUrl(downloadUrl);
      } catch (err) {
        console.error('Failed to fetch audio URL:', err);
        setError('Failed to load audio');
      } finally {
        setLoading(false);
      }
    };

    fetchUrl();
  }, [audioUrl, audioPath]);

  const handleAudioError = /** Handles the handleAudioError interaction. */ () => {
    setError('Failed to play audio');
  };

  if (!audioUrl && !audioPath) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center text-base">
          <Volume2 className="h-5 w-5 mr-2" />
          {t('callDetail.recording', 'Call Recording')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">Loading audio...</span>
          </div>
        )}

        {error && !loading && (
          <div className="flex items-center justify-center py-4 text-destructive">
            <AlertCircle className="h-5 w-5 mr-2" />
            <span>{error}</span>
          </div>
        )}

        {url && !loading && !error && (
          <audio
            ref={audioRef}
            controls
            className="w-full"
            onError={handleAudioError}
            preload="metadata"
          >
            <source src={url} />
            Your browser does not support the audio element.
          </audio>
        )}
      </CardContent>
    </Card>
  );
}

// Compact inline audio player for embedding in other components
export function AudioPlayerInline({ audioUrl, audioPath }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(audioUrl || null);
  const [loading, setLoading] = useState(!audioUrl && !!audioPath);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(/** Handles the callback for this operation. */() => {
    if (audioUrl) {
      setUrl(audioUrl);
      setLoading(false);
      return;
    }

    if (!audioPath) {
      setLoading(false);
      return;
    }

    const fetchUrl = /** Documents the fetchUrl behavior. */ async () => {
      setLoading(true);
      setError(null);
      try {
        const downloadUrl = await getAudioDownloadUrl(audioPath);
        setUrl(downloadUrl);
      } catch (err) {
        console.error('Failed to fetch audio URL:', err);
        // Don't show error in inline mode - just hide the player
        setError('unavailable');
      } finally {
        setLoading(false);
      }
    };

    fetchUrl();
  }, [audioUrl, audioPath]);

  useEffect(/** Handles the callback for this operation. */() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = /** Handles the handleTimeUpdate interaction. */ () => setCurrentTime(audio.currentTime);
    const handleDurationChange = /** Handles the handleDurationChange interaction. */ () => setDuration(audio.duration || 0);
    const handleEnded = /** Handles the handleEnded interaction. */ () => setIsPlaying(false);
    const handlePlay = /** Handles the handlePlay interaction. */ () => setIsPlaying(true);
    const handlePause = /** Handles the handlePause interaction. */ () => setIsPlaying(false);
    const handleError = /** Handles the handleError interaction. */ () => {
      setError('unavailable');
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
  }, [url]);

  const togglePlay = /** Documents the togglePlay behavior. */ () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch(/** Handles the callback for this operation. */() => {
        setError('unavailable');
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

  // Don't render if no audio source or error
  if ((!audioUrl && !audioPath) || error) {
    return null;
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 bg-muted rounded-lg px-2 py-1">
      <audio ref={audioRef} src={url || undefined} preload="metadata" />

      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0 hover:bg-muted"
        onClick={togglePlay}
      >
        {isPlaying ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" />
        )}
      </Button>

      <span className="text-xs text-muted-foreground min-w-[70px]">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>

      <input
        type="range"
        min={0}
        max={duration || 0}
        value={currentTime}
        onChange={handleSeek}
        className="w-24 h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
      />
    </div>
  );
}
