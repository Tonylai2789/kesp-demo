import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TranscriptionModel } from '@/types/call';
import { transcriptionModelLabel } from '@/lib/transcriptionUpload';

interface TranscriptionUploadSelectorProps {
  model: TranscriptionModel;
  comparison: boolean;
  canCompare: boolean;
  disabled?: boolean;
  onChange: (selection: { model: TranscriptionModel; comparison: boolean }) => void;
}

/** Render the same TEST model control at both upload entry points. */
export function TranscriptionUploadSelector({ model, comparison, canCompare, disabled, onChange }: TranscriptionUploadSelectorProps) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div style={{ marginBottom: 16, minWidth: 0 }}>
      <label className="field-label" htmlFor={id}>{t('kesp.transcriptionUpload.model')}</label>
      <select id={id} className="select" value={model} disabled={disabled}
        style={{ width: '100%', maxWidth: '100%' }}
        onChange={/** Change only the selection for files added next. */ (event) => onChange({
          model: event.target.value as TranscriptionModel, comparison,
        })}>
        <option value="gpt-4o-transcribe-diarize">{transcriptionModelLabel('gpt-4o-transcribe-diarize')}</option>
        <option value="scribe_v2">{transcriptionModelLabel('scribe_v2')}</option>
      </select>
      {canCompare && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 13 }}>
          <input type="checkbox" checked={comparison} disabled={disabled}
            onChange={/** Request an admin-only paired comparison for subsequently queued files. */ (event) =>
              onChange({ model, comparison: event.target.checked })} />
          <span>{t('kesp.transcriptionUpload.comparison')}</span>
        </label>
      )}
    </div>
  );
}
