import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { deleteAgentAnalysis } from '@/services/functions';
import type { AgentAnalysis } from '@/types/agentAnalysis';

interface DeleteAgentProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentAnalysis;
  onDeleted?: () => void;
}

interface MaybeFirebaseError {
  code?: string;
  message?: string;
}

/** Documents the isPresetGuardError behavior. */
function isPresetGuardError(error: unknown): boolean {
  const fnError = error as MaybeFirebaseError | null;
  const code = fnError?.code ?? '';
  // Firebase Functions client surfaces the server-side `failed-precondition`
  // either as `failed-precondition` or `functions/failed-precondition`.
  return code.includes('failed-precondition');
}

/** Renders the DeleteAgentProfileDialog component. */
export function DeleteAgentProfileDialog({
  open,
  onOpenChange,
  agent,
  onDeleted,
}: DeleteAgentProfileDialogProps) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = /** Handles the handleDelete interaction. */ async () => {
    setDeleting(true);
    try {
      await deleteAgentAnalysis(agent.id);
      toast.success(t('kesp.deleteAgent.toasts.success'));
      onOpenChange(false);
      onDeleted?.();
    } catch (error) {
      console.error('Failed to delete agent analysis:', error);
      if (isPresetGuardError(error)) {
        toast.error(t('kesp.deleteAgent.toasts.presetError'));
      } else {
        toast.error(t('kesp.deleteAgent.toasts.error'));
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('kesp.deleteAgent.title')}</DialogTitle>
          <DialogDescription>
            {t('kesp.deleteAgent.description', { name: agent.salesAgentName })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={/** Handles the onClick interaction. */ () => onOpenChange(false)}
            disabled={deleting}
          >
            {t('kesp.common.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('kesp.common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
