import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getAvailablePrompts, type AvailablePromptsResponse } from '@/services/functions';
import { Icon } from '@/components/kesp/icons';
import { Button } from '@/components/kesp/primitives';
import {
  clearKespUploadPromptSettings,
  loadKespUploadPromptSettings,
  saveKespUploadPromptSettings,
  type KespUploadPromptSettingsV1,
  validateKespUploadPromptSettings,
} from '@/lib/kespUploadPromptSettings';

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; availablePrompts: AvailablePromptsResponse };

const PER_CALL_TASK_IDS = [
  'core_fields',
  'coaching',
  'rubric_analysis_A',
  'rubric_analysis_B',
  'rubric_analysis_C',
  'rubric_analysis_D',
  'severity_analysis_A',
  'severity_analysis_B',
  'severity_analysis_C',
  'severity_analysis_D',
] as const;

const AGENT_ANALYSIS_TASK_IDS = [
  'behavior_pattern_detector',
  'behavior_pattern_consolidator',
] as const;

const ACTIVITY_TASK_IDS = ['call_activity_extractor'] as const;

/** Documents the buildPromptVersionState behavior. */
function buildPromptVersionState(
  taskIds: readonly string[],
  availableVersions: Record<string, string[]> | undefined,
  defaults: Record<string, string> | undefined,
  savedVersions?: Record<string, string>
): Record<string, string> {
  const nextVersions: Record<string, string> = {};
  for (const taskId of taskIds) {
    const versions = availableVersions?.[taskId] ?? [];
    const backendDefault = defaults?.[taskId];
    nextVersions[taskId] = savedVersions?.[taskId] ?? backendDefault ?? versions[0] ?? '';
  }
  return nextVersions;
}

/** Documents the persistPromptSettings behavior. */
function persistPromptSettings(
  availablePrompts: AvailablePromptsResponse,
  nextAnalyzerModel: string,
  nextPromptVersions: Record<string, string>,
  nextReportPromptVersions: Record<string, string>,
  nextActivityPromptVersions: Record<string, string>,
  analyzerModelChanged = false
): void {
  const saved = loadKespUploadPromptSettings();
  const next: KespUploadPromptSettingsV1 = {
    analyzerModel: saved.analyzerModel,
    analyzerModelOverrides: saved.analyzerModelOverrides,
  };

  // Prompt-only edits must not turn the displayed fallback into an explicit model choice.
  if (
    analyzerModelChanged &&
    availablePrompts.analyzerModels?.available.includes(nextAnalyzerModel)
  ) {
    next.analyzerModel = nextAnalyzerModel;
  }

  if (Object.keys(nextPromptVersions).length > 0) {
    next.promptVersions = nextPromptVersions;
  }
  if (Object.keys(nextReportPromptVersions).length > 0) {
    next.reportPromptVersions = nextReportPromptVersions;
  }
  if (Object.keys(nextActivityPromptVersions).length > 0) {
    next.activityPromptVersions = nextActivityPromptVersions;
  }

  const validated = validateKespUploadPromptSettings(next, availablePrompts);
  saveKespUploadPromptSettings(validated);
}

/** Renders the SubirPromptSettingsPage component. */
export function SubirPromptSettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [analyzerModel, setAnalyzerModel] = useState<string>('');
  const [promptVersionsByTaskId, setPromptVersionsByTaskId] = useState<Record<string, string>>({});
  const [reportPromptVersionsByTaskId, setReportPromptVersionsByTaskId] = useState<
    Record<string, string>
  >({});
  const [activityPromptVersionsByTaskId, setActivityPromptVersionsByTaskId] = useState<
    Record<string, string>
  >({});

  const perCallTaskIds = useMemo(/** Handles the callback for this operation. */() => {
    if (state.status !== 'ready') return [];
    return PER_CALL_TASK_IDS.filter(/** Handles the callback for this operation. */(taskId) =>
      Array.isArray(state.availablePrompts.availableVersions?.[taskId])
    );
  }, [state]);

  useEffect(/** Handles the callback for this operation. */() => {
    let cancelled = false;

    getAvailablePrompts()
      .then(/** Handles the callback for this operation. */(availablePrompts) => {
        if (cancelled) return;
        setState({ status: 'ready', availablePrompts });

        const saved = loadKespUploadPromptSettings();
        const validated = validateKespUploadPromptSettings(saved, availablePrompts);

        setAnalyzerModel(
          validated.analyzerModel ?? availablePrompts.analyzerModels?.default ?? ''
        );

        setPromptVersionsByTaskId(
          buildPromptVersionState(
            PER_CALL_TASK_IDS,
            availablePrompts.availableVersions,
            availablePrompts.defaults,
            validated.promptVersions
          )
        );
        setReportPromptVersionsByTaskId(
          buildPromptVersionState(
            AGENT_ANALYSIS_TASK_IDS,
            availablePrompts.agentAnalysisVersions,
            availablePrompts.agentAnalysisDefaults,
            validated.reportPromptVersions
          )
        );
        setActivityPromptVersionsByTaskId(
          buildPromptVersionState(
            ACTIVITY_TASK_IDS,
            availablePrompts.activityVersions,
            availablePrompts.activityDefaults,
            validated.activityPromptVersions
          )
        );
      })
      .catch(/** Handles the callback for this operation. */(err) => {
        console.error('Failed to fetch available prompts:', err);
        if (!cancelled) setState({ status: 'error' });
      });

    return /** Handles the callback for this operation. */ () => {
      cancelled = true;
    };
  }, []);

  const onReset = /** Handles the onReset interaction. */ () => {
    if (state.status !== 'ready') return;
    clearKespUploadPromptSettings();

    setAnalyzerModel(state.availablePrompts.analyzerModels?.default ?? '');
    setPromptVersionsByTaskId(
      buildPromptVersionState(
        PER_CALL_TASK_IDS,
        state.availablePrompts.availableVersions,
        state.availablePrompts.defaults
      )
    );
    setReportPromptVersionsByTaskId(
      buildPromptVersionState(
        AGENT_ANALYSIS_TASK_IDS,
        state.availablePrompts.agentAnalysisVersions,
        state.availablePrompts.agentAnalysisDefaults
      )
    );
    setActivityPromptVersionsByTaskId(
      buildPromptVersionState(
        ACTIVITY_TASK_IDS,
        state.availablePrompts.activityVersions,
        state.availablePrompts.activityDefaults
      )
    );
  };

  const onAnalyzerModelChange = /** Handles the onAnalyzerModelChange interaction. */ (nextAnalyzerModel: string) => {
    if (state.status !== 'ready') return;
    setAnalyzerModel(nextAnalyzerModel);
    persistPromptSettings(
      state.availablePrompts,
      nextAnalyzerModel,
      promptVersionsByTaskId,
      reportPromptVersionsByTaskId,
      activityPromptVersionsByTaskId,
      true
    );
  };

  const onPromptVersionChange = /** Handles the onPromptVersionChange interaction. */ (taskId: string, version: string) => {
    if (state.status !== 'ready') return;
    const nextVersions = { ...promptVersionsByTaskId, [taskId]: version };
    setPromptVersionsByTaskId(nextVersions);
    persistPromptSettings(
      state.availablePrompts,
      analyzerModel,
      nextVersions,
      reportPromptVersionsByTaskId,
      activityPromptVersionsByTaskId
    );
  };

  const onReportPromptVersionChange = /** Handles the onReportPromptVersionChange interaction. */ (taskId: string, version: string) => {
    if (state.status !== 'ready') return;
    const nextVersions = { ...reportPromptVersionsByTaskId, [taskId]: version };
    setReportPromptVersionsByTaskId(nextVersions);
    persistPromptSettings(
      state.availablePrompts,
      analyzerModel,
      promptVersionsByTaskId,
      nextVersions,
      activityPromptVersionsByTaskId
    );
  };

  const onActivityPromptVersionChange = /** Handles the onActivityPromptVersionChange interaction. */ (taskId: string, version: string) => {
    if (state.status !== 'ready') return;
    const nextVersions = { ...activityPromptVersionsByTaskId, [taskId]: version };
    setActivityPromptVersionsByTaskId(nextVersions);
    persistPromptSettings(
      state.availablePrompts,
      analyzerModel,
      promptVersionsByTaskId,
      reportPromptVersionsByTaskId,
      nextVersions
    );
  };

  return (
    <main className="main" style={{ maxWidth: 760 }}>
      <div className="page-head">
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <button
            type="button"
            className="nav-icon-btn"
            onClick={/** Handles the onClick interaction. */ () => navigate('/kesp/subir')}
            title={t('kesp.common.back')}
            aria-label={t('kesp.common.back')}
          >
            <Icon name="arrowLeft" size={14} />
          </button>
        </div>
        <h1 className="page-title">{t('kesp.upload.promptSettings.title')}</h1>
        <p className="page-sub">{t('kesp.upload.promptSettings.description')}</p>
      </div>

      {state.status === 'loading' ? (
        <div className="card">
          <div className="muted small">{t('kesp.common.loading')}</div>
        </div>
      ) : state.status === 'error' ? (
        <div className="card">
          <div className="muted small" style={{ marginBottom: 12 }}>
            {t('upload.promptVersions.error')}
          </div>
          <Button kind="ghost" size="sm" onClick={/** Handles the onClick interaction. */ () => navigate('/kesp/subir')}>
            {t('kesp.common.back')}
          </Button>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            {state.availablePrompts.analyzerModels ? (
              <>
                <label className="field-label" style={{ marginBottom: 8 }}>
                  {t('upload.analyzerModel.label')}
                </label>
                <select
                  value={analyzerModel}
                  onChange={/** Handles the onChange interaction. */ (e) => onAnalyzerModelChange(e.target.value)}
                >
                  {state.availablePrompts.analyzerModels.available.map(/** Handles the callback for this operation. */(model) => (
                    <option key={model} value={model}>
                      {model}
                      {model === state.availablePrompts.analyzerModels?.default
                        ? ` ${t('upload.promptVersions.default')}`
                        : ''}
                    </option>
                  ))}
                </select>
                <div className="muted tiny" style={{ marginTop: 8 }}>
                  {t('upload.analyzerModel.help')}
                </div>
              </>
            ) : (
              <div className="muted small">{t('upload.analyzerModel.fallback')}</div>
            )}
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="field-label" style={{ marginBottom: 8 }}>
              {t('upload.promptVersions.title')}
            </div>
            <div className="muted tiny" style={{ marginBottom: 12 }}>
              {t('upload.promptVersions.description')}
            </div>

            <div className="col" style={{ gap: 12 }}>
              {perCallTaskIds.map(/** Handles the callback for this operation. */(taskId) => {
                const versions = state.availablePrompts.availableVersions?.[taskId] ?? [];
                const backendDefault = state.availablePrompts.defaults?.[taskId];
                const value = promptVersionsByTaskId[taskId] ?? backendDefault ?? '';
                return (
                  <div key={taskId} className="row" style={{ gap: 12, alignItems: 'center' }}>
                    <div style={{ width: 240, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {t(`upload.promptVersions.${taskId}`, { defaultValue: taskId })}
                      </div>
                      <div className="muted tiny" style={{ wordBreak: 'break-all' }}>
                        {taskId}
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      {versions.length === 0 ? (
                        <div className="muted small">{t('upload.promptVersions.loading')}</div>
                      ) : (
                        <select
                          value={value}
                          onChange={/** Handles the onChange interaction. */ (e) => onPromptVersionChange(taskId, e.target.value)}
                        >
                          {versions.map(/** Handles the callback for this operation. */(version) => (
                            <option key={version} value={version}>
                              v{version}
                              {typeof backendDefault === 'string' && version === backendDefault
                                ? ` ${t('upload.promptVersions.default')}`
                                : ''}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="field-label" style={{ marginBottom: 8 }}>
              {t('kesp.upload.promptSettings.agentAnalysisTitle')}
            </div>
            <div className="muted tiny" style={{ marginBottom: 12 }}>
              {t('kesp.upload.promptSettings.agentAnalysisDescription')}
            </div>

            <div className="col" style={{ gap: 12 }}>
              {AGENT_ANALYSIS_TASK_IDS.map(/** Handles the callback for this operation. */(taskId) => {
                const versions = state.availablePrompts.agentAnalysisVersions?.[taskId] ?? [];
                const backendDefault = state.availablePrompts.agentAnalysisDefaults?.[taskId];
                const value = reportPromptVersionsByTaskId[taskId] ?? backendDefault ?? '';
                return (
                  <div key={taskId} className="row" style={{ gap: 12, alignItems: 'center' }}>
                    <div style={{ width: 240, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {t(`upload.promptVersions.${taskId}`, { defaultValue: taskId })}
                      </div>
                      <div className="muted tiny" style={{ wordBreak: 'break-all' }}>
                        {taskId}
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      {versions.length === 0 ? (
                        <div className="muted small">{t('upload.promptVersions.loading')}</div>
                      ) : (
                        <select
                          value={value}
                          onChange={/** Handles the onChange interaction. */ (e) =>
                            onReportPromptVersionChange(taskId, e.target.value)
                          }
                        >
                          {versions.map(/** Handles the callback for this operation. */(version) => (
                            <option key={version} value={version}>
                              v{version}
                              {typeof backendDefault === 'string' && version === backendDefault
                                ? ` ${t('upload.promptVersions.default')}`
                                : ''}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="field-label" style={{ marginBottom: 8 }}>
              {t('kesp.upload.promptSettings.activityTitle')}
            </div>
            <div className="muted tiny" style={{ marginBottom: 12 }}>
              {t('kesp.upload.promptSettings.activityDescription')}
            </div>

            <div className="col" style={{ gap: 12 }}>
              {ACTIVITY_TASK_IDS.map(/** Handles the callback for this operation. */(taskId) => {
                const versions = state.availablePrompts.activityVersions?.[taskId] ?? [];
                const backendDefault = state.availablePrompts.activityDefaults?.[taskId];
                const value = activityPromptVersionsByTaskId[taskId] ?? backendDefault ?? '';
                return (
                  <div key={taskId} className="row" style={{ gap: 12, alignItems: 'center' }}>
                    <div style={{ width: 240, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {t(`upload.promptVersions.${taskId}`, { defaultValue: taskId })}
                      </div>
                      <div className="muted tiny" style={{ wordBreak: 'break-all' }}>
                        {taskId}
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      {versions.length === 0 ? (
                        <div className="muted small">{t('upload.promptVersions.loading')}</div>
                      ) : (
                        <select
                          value={value}
                          onChange={/** Handles the onChange interaction. */ (e) =>
                            onActivityPromptVersionChange(taskId, e.target.value)
                          }
                        >
                          {versions.map(/** Handles the callback for this operation. */(version) => (
                            <option key={version} value={version}>
                              v{version}
                              {typeof backendDefault === 'string' && version === backendDefault
                                ? ` ${t('upload.promptVersions.default')}`
                                : ''}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="row" style={{ gap: 10, justifyContent: 'flex-end' }}>
            <Button kind="ghost" onClick={onReset}>
              {t('kesp.upload.promptSettings.reset')}
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
