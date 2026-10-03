import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Settings2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AnalyzerModelFields } from './AnalyzerModelFields';
import { Button } from './primitives';
import { analyzerModelSettings, type AnalyzerModelSettings } from '@/lib/analyzerModelSettings';
import { loadKespUploadPromptSettings, saveKespUploadPromptSettings, validateKespUploadPromptSettings } from '@/lib/kespUploadPromptSettings';
import type { AvailablePromptsResponse } from '@/services/functions';

export type AnalyzerSettingsButtonProps = {
  catalog: AvailablePromptsResponse | null;
  scope: string;
  disabled?: boolean;
  load: () => Parameters<typeof analyzerModelSettings>[0] | Promise<Parameters<typeof analyzerModelSettings>[0]>;
  save: (value: AnalyzerModelSettings) => void | Promise<void>;
};

/** Mounts a fresh draft for each opening and keeps failed saves editable. */
function SettingsDraft({ catalog, load, save, onSaved, onBusyChange }: AnalyzerSettingsButtonProps & {
  onSaved: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AnalyzerModelSettings | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(/** Loads a fresh browser/environment snapshot, ignoring responses after close. */ () => {
    let cancelled = false;
    if (!catalog) return;
    Promise.resolve().then(load).then(/** Initializes only this mounted draft. */ (saved) => {
      if (!cancelled) setDraft(analyzerModelSettings(saved, catalog));
    }).catch(/** Leaves a failed load unsaveable. */ () => {
      if (!cancelled) setError(true);
    });
    return /** Ignores requests that finish after close or environment change. */ () => { cancelled = true; };
  }, [catalog, load]);

  /** Saves only after explicit confirmation; rejection preserves every draft selection. */
  async function submit() {
    if (!draft || saving) return;
    setSaving(true);
    onBusyChange(true);
    setError(false);
    try {
      // Writes only the confirmed manual-upload settings to browser storage.
      await save(draft);
      onSaved();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  }

  return (
    <>
      <div className="kesp-model-body" aria-busy={!draft && !error}>
        {draft && catalog ? <AnalyzerModelFields value={draft} catalog={catalog} onChange={setDraft} disabled={saving} /> :
          !error ? <p role="status">{t('kesp.common.loading')}</p> : null}
        {error ? <p role="alert" className="kesp-model-error">{t(draft ? 'kesp.analyzerSettings.saveError' : 'kesp.analyzerSettings.loadError')}</p> : null}
      </div>
      <footer className="kesp-model-footer">
        <Dialog.Close asChild><Button kind="ghost" disabled={saving}>{t('common.cancel')}</Button></Dialog.Close>
        <Button kind="primary" onClick={submit} disabled={!draft || saving}>
          {saving ? t('kesp.common.loading') : t('kesp.analyzerSettings.save')}
        </Button>
      </footer>
    </>
  );
}

/** Radix provides focus trapping, Escape dismissal, and focus restoration to the icon. */
export function AnalyzerSettingsButton(props: AnalyzerSettingsButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={/** Prevents dismissal during an in-flight save. */ (next) => { if (!busy) setOpen(next); }}>
      <Dialog.Trigger asChild>
        <button type="button" className="nav-icon-btn" disabled={props.disabled || !props.catalog?.analyzerModels?.available.length}
          title={t('kesp.analyzerSettings.title')} aria-label={t('kesp.analyzerSettings.title')}>
          <Settings2 size={16} aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      {open ? <Dialog.Portal>
        <Dialog.Overlay className="kesp-model-overlay" />
        <Dialog.Content className="kesp-root kesp-model-dialog">
          <header className="kesp-model-header">
            <div>
              <Dialog.Title>{t('kesp.analyzerSettings.title')}</Dialog.Title>
              <Dialog.Description>{props.scope}</Dialog.Description>
            </div>
            <Dialog.Close asChild><button type="button" className="nav-icon-btn" disabled={busy}
              title={t('common.close')} aria-label={t('common.close')}><X size={16} aria-hidden="true" /></button></Dialog.Close>
          </header>
          <SettingsDraft {...props} onBusyChange={setBusy} onSaved={/** Confirms a successful save and discards the committed draft. */ () => {
            toast.success(t('kesp.analyzerSettings.saved'));
            setOpen(false);
          }} />
        </Dialog.Content>
      </Dialog.Portal> : null}
    </Dialog.Root>
  );
}

/** Uses the existing browser-wide manual-upload settings, never a human-agent record. */
export function UploadAnalyzerSettingsButton({ catalog, disabled }: { catalog: AvailablePromptsResponse | null; disabled?: boolean }) {
  const { t } = useTranslation();
  const save = useCallback(/** Preserves prompt selections while updating only analyzer settings. */ (value: AnalyzerModelSettings) => {
    if (!catalog) throw new Error('Missing analyzer catalog');
    const settings = validateKespUploadPromptSettings({ ...loadKespUploadPromptSettings(), ...value }, catalog);
    if (!saveKespUploadPromptSettings(settings)) throw new Error('Unable to save browser settings');
  }, [catalog]);
  return <AnalyzerSettingsButton catalog={catalog} disabled={disabled} scope={t('kesp.analyzerSettings.browserScope')}
    load={loadKespUploadPromptSettings} save={save} />;
}
