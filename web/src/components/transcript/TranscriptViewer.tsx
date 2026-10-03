import { useTranslation } from 'react-i18next';
import { Clock, User, Headphones } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { Transcript, TranscriptSegment } from '@/types';
import { cn } from '@/lib/utils';

interface TranscriptViewerProps {
  transcript: Transcript | null;
  agentSpeaker?: string;
  agentName?: string | null;
  customerName?: string | null;
  loading?: boolean;
}

interface SegmentItemProps {
  segment: TranscriptSegment;
  isAgent: boolean;
  speakerName?: string | null;
}

/** Documents the formatTime behavior. */
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Renders the SegmentItem component. */
function SegmentItem({ segment, isAgent, speakerName }: SegmentItemProps) {
  const { t } = useTranslation();

  const roleLabel = isAgent ? t('callDetail.agent') : t('callDetail.customer');
  const displayLabel = speakerName
    ? `${speakerName} (${segment.speaker})`
    : `${roleLabel} (${segment.speaker})`;

  return (
    <div
      className={cn(
        'p-3 rounded-lg mb-3',
        isAgent
          ? 'bg-blue-50 dark:bg-blue-950 border-l-4 border-l-blue-500'
          : 'bg-muted border-l-4 border-l-border'
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <Badge variant={isAgent ? 'default' : 'secondary'} className="flex items-center gap-1">
          {isAgent ? (
            <Headphones className="h-3 w-3" />
          ) : (
            <User className="h-3 w-3" />
          )}
          <span>{displayLabel}</span>
        </Badge>
        <span className="text-xs text-muted-foreground flex items-center">
          <Clock className="h-3 w-3 mr-1" />
          {formatTime(segment.start)} - {formatTime(segment.end)}
        </span>
      </div>
      <p className="text-sm leading-relaxed">{segment.text}</p>
    </div>
  );
}

/** Renders the TranscriptSkeleton component. */
function TranscriptSkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(5)].map(/** Handles the callback for this operation. */(_, i) => (
        <div key={i} className="p-3 rounded-lg bg-muted">
          <div className="flex justify-between mb-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-20" />
          </div>
          <Skeleton className="h-4 w-full mb-1" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ))}
    </div>
  );
}

/** Renders the TranscriptViewer component. */
export function TranscriptViewer({
  transcript,
  agentSpeaker,
  agentName,
  customerName,
  loading,
}: TranscriptViewerProps) {
  const { t } = useTranslation();

  if (loading) {
    return <TranscriptSkeleton />;
  }

  if (!transcript) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        {t('callDetail.noTranscript')}
      </div>
    );
  }

  // If agentSpeaker is not provided, try to determine it
  // Usually the agent speaks first and more frequently
  const speakerToUse = agentSpeaker || (transcript.segments[0]?.speaker ?? 'A');

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {transcript.segments.length} segments
        </span>
        <span className="flex items-center">
          <Clock className="h-4 w-4 mr-1" />
          {formatTime(transcript.duration)} total
        </span>
      </div>

      {/* Segments */}
      <ScrollArea className="h-[500px] pr-4">
        {transcript.segments.map(/** Handles the callback for this operation. */(segment, index) => {
          const isAgent = segment.speaker === speakerToUse;
          return (
            <SegmentItem
              key={segment.id || index}
              segment={segment}
              isAgent={isAgent}
              speakerName={isAgent ? agentName : customerName}
            />
          );
        })}
      </ScrollArea>
    </div>
  );
}
