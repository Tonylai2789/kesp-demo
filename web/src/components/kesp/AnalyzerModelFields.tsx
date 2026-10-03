import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { AvailablePromptsResponse } from '@/services/functions';
import { ANALYZER_TASK_IDS, type AnalyzerModelSettings } from '@/lib/analyzerModelSettings';

/** Shared model controls for browser settings, environment settings, and a single dry run. */
export function AnalyzerModelFields({ value, catalog, onChange, disabled = false }: {
  value: AnalyzerModelSettings;
  catalog: AvailablePromptsResponse;
  onChange: (value: AnalyzerModelSettings) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const models = catalog.analyzerModels?.available ?? [];
  return (
    <fieldset className="kesp-model-fields" disabled={disabled}>
      <legend className="sr-only">{t('kesp.analyzerSettings.title')}</legend>
      <label className="kesp-model-field kesp-model-default" htmlFor={`${id}-default`}>
        <span>{t('kesp.analyzerSettings.defaultModel')}</span>
        <select id={`${id}-default`} value={value.analyzerModel}
          onChange={/** Updates only the draft default; explicit overrides remain pinned. */ (event) => onChange({ ...value, analyzerModel: event.target.value })}>
          {models.map(/** Renders models from the backend catalog. */ (model) => <option key={model} value={model}>{model}</option>)}
        </select>
      </label>
      {ANALYZER_TASK_IDS.map(/** Renders the ten supported analysis-task overrides. */ (taskId) => (
        <label key={taskId} className="kesp-model-field" htmlFor={`${id}-${taskId}`}>
          <span>{t(`upload.promptVersions.${taskId}`, { defaultValue: taskId })}</span>
          <select id={`${id}-${taskId}`} value={value.analyzerModelOverrides[taskId] ?? ''}
            onChange={/** Removes inheritance entries instead of materializing effective models. */ (event) => {
              const analyzerModelOverrides = { ...value.analyzerModelOverrides };
              if (event.target.value) analyzerModelOverrides[taskId] = event.target.value;
              else delete analyzerModelOverrides[taskId];
              onChange({ ...value, analyzerModelOverrides });
            }}>
            <option value="">{t('kesp.analyzerSettings.inherit', { model: value.analyzerModel })}</option>
            {models.map(/** Renders a supported explicit model. */ (model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
      ))}
    </fieldset>
  );
}
