import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { updateCallName } from '@/services/firestore';

interface RenameCallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  callId: string;
  currentName?: string;
  onRenamed?: () => void;
}

/** Renders the RenameCallDialog component. */
export function RenameCallDialog({
  open,
  onOpenChange,
  callId,
  currentName,
  onRenamed,
}: RenameCallDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(currentName || '');
  const [saving, setSaving] = useState(false);

  // Reset name when dialog opens
  useEffect(/** Handles the callback for this operation. */() => {
    if (open) {
      setName(currentName || '');
    }
  }, [open, currentName]);

  const handleSave = /** Handles the handleSave interaction. */ async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    setSaving(true);
    try {
      await updateCallName(callId, trimmedName);
      toast.success(t('calls.renameSuccess'));
      onOpenChange(false);
      onRenamed?.();
    } catch (error) {
      console.error('Rename failed:', error);
      toast.error(t('calls.renameError'));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = /** Handles the handleKeyDown interaction. */ (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && name.trim()) {
      handleSave();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('calls.renameTitle')}</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <Input
            value={name}
            onChange={/** Handles the onChange interaction. */ (e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('calls.renamePlaceholder')}
            maxLength={100}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={/** Handles the onClick interaction. */ () => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
