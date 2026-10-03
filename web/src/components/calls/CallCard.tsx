import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Phone, Clock, Loader2, CheckCircle, AlertCircle, ArrowRight, MoreVertical, Edit2, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DeleteCallDialog } from './DeleteCallDialog';
import { RenameCallDialog } from './RenameCallDialog';
import type { Call } from '@/types';
import { cn } from '@/lib/utils';
import { getCallErrorMessageKey, getCallStatusLabelKey } from '@/lib/callStatus';

interface CallCardProps {
  call: Call;
}

/** Documents the getStatusIcon behavior. */
function getStatusIcon(status: Call['status']) {
  switch (status) {
    case 'transcribing':
    case 'analyzing':
      return <Loader2 className="h-4 w-4 animate-spin" />;
    case 'complete':
      return <CheckCircle className="h-4 w-4 text-green-600" />;
    case 'error':
      return <AlertCircle className="h-4 w-4 text-red-600" />;
    default:
      return null;
  }
}

/** Documents the getStatusBadgeVariant behavior. */
function getStatusBadgeVariant(status: Call['status']) {
  switch (status) {
    case 'complete':
      return 'default' as const;
    case 'error':
      return 'destructive' as const;
    case 'transcribing':
    case 'analyzing':
      return 'secondary' as const;
    default:
      return 'outline' as const;
  }
}

/** Documents the getCategoryStyles behavior. */
function getCategoryStyles(category: Call['category']) {
  switch (category) {
    case 'good':
      return {
        border: 'border-l-green-500',
        bg: 'bg-green-50',
        text: 'text-green-700',
      };
    case 'medium':
      return {
        border: 'border-l-yellow-500',
        bg: 'bg-yellow-50',
        text: 'text-yellow-700',
      };
    case 'bad':
      return {
        border: 'border-l-red-500',
        bg: 'bg-red-50',
        text: 'text-red-700',
      };
    case 'unknown':
      return {
        border: 'border-l-gray-400',
        bg: 'bg-gray-50',
        text: 'text-gray-600',
      };
  }
}

/** Renders the CallCard component. */
export function CallCard({ call }: CallCardProps) {
  const { t } = useTranslation();
  const categoryStyles = getCategoryStyles(call.category);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);

  const displayName = call.displayName || call.name || call.id;
  const errorMessageKey = getCallErrorMessageKey(call);

  return (
    <Card className={cn('border-l-4', categoryStyles.border)}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start space-x-4">
            <div
              className={cn(
                'w-10 h-10 rounded-full flex items-center justify-center',
                categoryStyles.bg
              )}
            >
              <Phone className={cn('h-5 w-5', categoryStyles.text)} />
            </div>
            <div className="space-y-1">
              <p className="font-medium truncate max-w-[300px]" title={displayName}>
                {displayName}
              </p>
              <div className="flex items-center space-x-4 text-sm text-muted-foreground">
                <span>{call.createdAt.toLocaleDateString()}</span>
                {(/** Handles the callback for this operation. */ () => {
                  // Show processing time (transcription start → analysis complete) for completed calls
                  const processingTimeSec = call.analysisCompletedAt && call.transcriptionStartedAt
                    ? Math.round((call.analysisCompletedAt.getTime() - call.transcriptionStartedAt.getTime()) / 1000)
                    : null;

                  if (processingTimeSec !== null) {
                    return (
                      <span className="flex items-center" title={t('calls.processingTime')}>
                        <Clock className="h-3 w-3 mr-1" />
                        {processingTimeSec}s
                      </span>
                    );
                  }
                  // Fallback: show audio duration for old/in-progress calls
                  if (call.duration) {
                    return (
                      <span className="flex items-center">
                        <Clock className="h-3 w-3 mr-1" />
                        {Math.round(call.duration)}s
                      </span>
                    );
                  }
                  return null;
                })()}
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <Badge variant={getStatusBadgeVariant(call.status)}>
              <span className="flex items-center space-x-1">
                {getStatusIcon(call.status)}
                <span>{t(getCallStatusLabelKey(call))}</span>
              </span>
            </Badge>
            <Badge variant="outline" className={categoryStyles.text}>
              {t(`calls.${call.category}`)}
            </Badge>
            <Link to={`/calls/${call.id}`}>
              <Button variant="ghost" size="sm">
                {t('calls.viewDetails')}
                <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            </Link>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={/** Handles the onClick interaction. */ () => setRenameDialogOpen(true)}>
                  <Edit2 className="h-4 w-4 mr-2" />
                  {t('calls.rename')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={/** Handles the onClick interaction. */ () => setDeleteDialogOpen(true)}
                  className="text-red-600 focus:text-red-600"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  {t('calls.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {call.error && (
          <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            {errorMessageKey ? t(errorMessageKey) : call.error}
          </div>
        )}
      </CardContent>

      <DeleteCallDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        callId={call.id}
        audioPath={call.audioPath}
      />
      <RenameCallDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        callId={call.id}
        currentName={displayName}
      />
    </Card>
  );
}
