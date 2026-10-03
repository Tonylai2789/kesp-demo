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
import { cancelCallProcessing } from '@/services/functions';

interface StopCallProcessingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  callId: string;
}

/** Renders the StopCallProcessingDialog component. */
export function StopCallProcessingDialog({
  open,
  onOpenChange,
  callId,
}: StopCallProcessingDialogProps) {
  const { t } = useTranslation();
  const [canceling, setCanceling] = useState(false);

  const handleCancelProcessing = /** Handles the handleCancelProcessing interaction. */ async () => {
    setCanceling(true);
    try {
      /** Calls Firebase Functions to cancel active call processing. */
      await cancelCallProcessing(callId);
      toast.success(t('kesp.callDetail.stopAnalysis.success'));
      onOpenChange(false);
    } catch (error) {
      console.error('Stop analysis failed:', error);
      toast.error(t('kesp.callDetail.stopAnalysis.error'));
    } finally {
      setCanceling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('kesp.callDetail.stopAnalysis.title')}</DialogTitle>
          <DialogDescription>{t('kesp.callDetail.stopAnalysis.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={/** Handles the onClick interaction. */ () => onOpenChange(false)}
            disabled={canceling}
          >
            {t('kesp.common.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleCancelProcessing} disabled={canceling}>
            {canceling && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('kesp.callDetail.stopAnalysis.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
