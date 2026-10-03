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
import { deleteCallDeep } from '@/services/functions';

interface DeleteCallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  callId: string;
  /** Kept for API compatibility; the Cloud Function reads audioPath from the call doc. */
  audioPath?: string;
  onDeleted?: () => void;
}

/** Renders the DeleteCallDialog component. */
export function DeleteCallDialog({
  open,
  onOpenChange,
  callId,
  onDeleted,
}: DeleteCallDialogProps) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = /** Handles the handleDelete interaction. */ async () => {
    setDeleting(true);
    try {
      // Server-side cascade: transcript + feedback subcollections,
      // agent_activity call_snapshots + reminders, audio file, then the call doc.
      await deleteCallDeep(callId);

      toast.success(t('calls.deleteSuccess'));
      onOpenChange(false);
      onDeleted?.();
    } catch (error) {
      console.error('Delete failed:', error);
      toast.error(t('calls.deleteError'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('calls.deleteConfirmTitle')}</DialogTitle>
          <DialogDescription>{t('calls.deleteConfirmMessage')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={/** Handles the onClick interaction. */ () => onOpenChange(false)} disabled={deleting}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('calls.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
