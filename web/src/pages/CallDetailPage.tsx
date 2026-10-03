import { useEffect, useState } from 'react';
import { useLocation, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Clock, Calendar, RefreshCw, Loader2, Trash2, Edit2, Volume2, FileText } from 'lucide-react';
import { DeleteCallDialog, RenameCallDialog } from '@/components/calls';
import { AudioPlayerDialog } from '@/components/audio';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { TranscriptViewer } from '@/components/transcript';
import { FeedbackViewer } from '@/components/feedback';
import { subscribeToCall, fetchTranscript, fetchFeedback } from '@/services/firestore';
import type { Call, Transcript, Feedback } from '@/types';
import { cn } from '@/lib/utils';
import { getCallErrorMessageKey, getCallStatusLabelKey } from '@/lib/callStatus';
import { appendReturnTo, getReturnToFromSearch } from '@/lib/returnTo';

/** Documents the getStatusBadgeVariant behavior. */
function getStatusBadgeVariant(status: Call['status']) {
  switch (status) {
    case 'complete':
      return 'default' as const;
    case 'error':
      return 'destructive' as const;
    case 'canceled':
      return 'outline' as const;
    case 'transcribing':
    case 'analyzing':
      return 'secondary' as const;
    default:
      return 'outline' as const;
  }
}

/** Documents the getCategoryColor behavior. */
function getCategoryColor(category: Call['category']) {
  switch (category) {
    case 'good':
      return 'bg-green-100 text-green-800 border-green-300';
    case 'medium':
      return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    case 'bad':
      return 'bg-red-100 text-red-800 border-red-300';
    case 'unknown':
      return 'bg-gray-100 text-gray-700 border-gray-300';
  }
}

/**
 * Format duration in seconds as MM:SS
 * Rounds to nearest second, then calculates minutes/seconds to avoid "5:60" bug
 */
function formatDuration(seconds: number): string {
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Renders the CallDetailPage component. */
export function CallDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  const [call, setCall] = useState<Call | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [loading, setLoading] = useState(true);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [audioDialogOpen, setAudioDialogOpen] = useState(false);
  const returnTo = getReturnToFromSearch(location.search);

  // Subscribe to real-time call updates
  useEffect(/** Handles the callback for this operation. */() => {
    if (!id) return;

    const unsubscribe = subscribeToCall(id, /** Handles the callback for this operation. */(updatedCall) => {
      setCall(updatedCall);
      setLoading(false);

      // Fetch transcript and feedback when call is complete
      if (updatedCall?.status === 'complete') {
        loadTranscriptAndFeedback(id);
      }
    });

    return /** Handles the callback for this operation. */ () => unsubscribe();
  }, [id]);

  const loadTranscriptAndFeedback = /** Documents the loadTranscriptAndFeedback behavior. */ async (callId: string) => {
    setTranscriptLoading(true);
    setFeedbackLoading(true);

    try {
      const [transcriptData, feedbackData] = await Promise.all([
        fetchTranscript(callId),
        fetchFeedback(callId),
      ]);
      setTranscript(transcriptData);
      setFeedback(feedbackData);
    } catch (error) {
      console.error('Failed to load transcript/feedback:', error);
    } finally {
      setTranscriptLoading(false);
      setFeedbackLoading(false);
    }
  };


  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!call) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold">Call not found</h2>
        <Button variant="link" onClick={/** Handles the onClick interaction. */ () => navigate(returnTo ?? '/calls')}>
          {t('common.back')}
        </Button>
      </div>
    );
  }

  const isProcessing = call.status === 'transcribing' || call.status === 'analyzing';
  const errorMessageKey = getCallErrorMessageKey(call);
  const promptVersionsPath = appendReturnTo(`/calls/${call.id}/prompt-versions`, returnTo);
  const weaknessPath = /** Documents the weaknessPath behavior. */ (index: number) =>
    appendReturnTo(`/calls/${call.id}/weaknesses/${index}`, returnTo);
  const resolvedAgentName = feedback?.agent_name?.trim() || call.salesAgentName?.trim() || null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Button variant="ghost" size="icon" onClick={/** Handles the onClick interaction. */ () => navigate(returnTo ?? '/calls')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold truncate max-w-lg" title={call.displayName || call.name || call.id}>
              {call.displayName || call.name || call.id}
            </h1>
            <div className="flex items-center space-x-2 mt-1">
              <Badge variant={getStatusBadgeVariant(call.status)}>
                {isProcessing && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                {t(getCallStatusLabelKey(call))}
              </Badge>
              <Badge variant="outline" className={cn(getCategoryColor(call.category))}>
                {t(`calls.${call.category}`)}
              </Badge>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {call.audioPath && (
            <Button variant="outline" size="icon" onClick={/** Handles the onClick interaction. */ () => setAudioDialogOpen(true)}>
              <Volume2 className="h-4 w-4" />
            </Button>
          )}
          <Button variant="outline" size="icon" onClick={/** Handles the onClick interaction. */ () => setRenameDialogOpen(true)}>
            <Edit2 className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={/** Handles the onClick interaction. */ () => setDeleteDialogOpen(true)}>
            <Trash2 className="h-4 w-4 text-red-600" />
          </Button>
          {call.status === 'complete' && (
            <Button variant="outline" size="sm" onClick={/** Handles the onClick interaction. */ () => navigate(promptVersionsPath)}>
              <FileText className="h-4 w-4 mr-2" />
              {t('callDetail.promptVersions')}
            </Button>
          )}
          {call.status === 'error' && (
            <Button variant="outline" onClick={() => navigate('/kesp/runtime-errors')}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('kesp.nav.runtimeErrors')}
            </Button>
          )}
        </div>
      </div>

      {/* Call Info Card */}
      <Card>
        <CardHeader>
          <CardTitle>{t('callDetail.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">{t('callDetail.category')}</p>
              <p className="font-medium">{t(`calls.${call.category}`)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('callDetail.status')}</p>
              <p className="font-medium">{t(getCallStatusLabelKey(call))}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('callDetail.createdAt')}</p>
              <p className="font-medium flex items-center">
                <Calendar className="h-4 w-4 mr-1" />
                {call.createdAt.toLocaleDateString()}
              </p>
            </div>
            {call.duration && (
              <div>
                <p className="text-sm text-muted-foreground">{t('callDetail.duration')}</p>
                <p className="font-medium flex items-center">
                  <Clock className="h-4 w-4 mr-1" />
                  {formatDuration(call.duration)}
                </p>
              </div>
            )}
          </div>

          {call.error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-red-700">
              <p className="font-medium">Error:</p>
              <p className="text-sm">{errorMessageKey ? t(errorMessageKey) : call.error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Transcript and Feedback Tabs */}
      {call.status === 'complete' && (
        <Tabs defaultValue="feedback" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="feedback">{t('callDetail.feedback')}</TabsTrigger>
            <TabsTrigger value="transcript">{t('callDetail.transcript')}</TabsTrigger>
          </TabsList>
          <TabsContent value="feedback" className="mt-6 space-y-6">
            <FeedbackViewer
              feedback={feedback}
              loading={feedbackLoading}
              callId={call.id}
              transcript={transcript}
              agentNameFallback={resolvedAgentName}
              onWeaknessSelect={/** Handles the onWeaknessSelect interaction. */ (_, index) => navigate(weaknessPath(index))}
            />
          </TabsContent>
          <TabsContent value="transcript" className="mt-6">
            <TranscriptViewer
              transcript={transcript}
              agentSpeaker={feedback?.agent_speaker}
              agentName={resolvedAgentName}
              customerName={feedback?.customer_name}
              loading={transcriptLoading}
            />
          </TabsContent>
        </Tabs>
      )}

      {/* Processing State */}
      {isProcessing && (
        <Card>
          <CardContent className="py-12 text-center">
            <Loader2 className="h-12 w-12 mx-auto mb-4 animate-spin text-primary" />
            <h3 className="text-lg font-semibold">
              {call.status === 'transcribing'
                ? 'Transcribing audio...'
                : 'Analyzing transcript...'}
            </h3>
            {call.status === 'transcribing' && call.isChunked && call.totalChunks && (
              <p className="text-muted-foreground mt-1">
                Chunk {call.completedChunks || 0} of {call.totalChunks} complete
              </p>
            )}
            <p className="text-muted-foreground mt-1">
              This may take a few minutes
            </p>
          </CardContent>
        </Card>
      )}

      {/* Dialogs */}
      <DeleteCallDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        callId={call.id}
        audioPath={call.audioPath}
        onDeleted={/** Handles the onDeleted interaction. */ () => navigate(returnTo ?? '/calls')}
      />
      <RenameCallDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        callId={call.id}
        currentName={call.displayName || call.name || call.id}
      />
      <AudioPlayerDialog
        open={audioDialogOpen}
        onOpenChange={setAudioDialogOpen}
        audioUrl={call.audioUrl}
        audioPath={call.audioPath}
        callId={call.id}
      />
    </div>
  );
}
