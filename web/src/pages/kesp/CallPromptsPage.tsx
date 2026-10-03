import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Call } from '@/types/call';
import {
  fetchAnalysisRunWithTasks,
  subscribeToCall,
  type AnalysisRunInfo,
  type TaskInfo,
} from '@/services/firestore';
import { appendReturnTo, getReturnToFromSearch } from '@/lib/returnTo';
import { Icon } from '@/components/kesp/icons';
import { Button } from '@/components/kesp/primitives';

/** Documents the parseVersionFromPath behavior. */
function parseVersionFromPath(promptPath: string): string | null {
  const match = promptPath.match(/-v(\d+(?:\.\d+)?)\.md$/);
  if (!match) return null;
  return `v${match[1]}`;
}

type PromptRow = {
  taskId: string;
  version: string | null;
  model: string;
  promptPath: string;
};

/** Renders the CallPromptsPage component. */
export function CallPromptsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const callId = params.id ? decodeURIComponent(params.id) : '';
  const returnTo = getReturnToFromSearch(location.search);
  const backToCalls = returnTo ?? '/kesp/llamadas';

  const [call, setCall] = useState<Call | null>(null);
  const [callLoadedId, setCallLoadedId] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ run: AnalysisRunInfo; tasks: TaskInfo[] } | null>(
    null
  );
  const [runLoadedKey, setRunLoadedKey] = useState<string | null>(null);
  const [runErrorKey, setRunErrorKey] = useState<string | null>(null);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!callId) return;
    return subscribeToCall(callId, /** Handles the callback for this operation. */(next) => {
      setCall(next);
      setCallLoadedId(callId);
    });
  }, [callId]);

  const callLoading = Boolean(callId) && callLoadedId !== callId;
  const runId = call?.lastTerminalRunId ?? call?.activeAnalysisRunId ?? null;
  const runKey = runId ? `${callId}:${runId}` : null;

  useEffect(/** Handles the callback for this operation. */() => {
    if (!callId || !runId) return;

    let cancelled = false;
    fetchAnalysisRunWithTasks(callId, runId)
      .then(/** Handles the callback for this operation. */(result) => {
        if (cancelled) return;
        if (!result) {
          setRunResult(null);
          setRunLoadedKey(null);
          setRunErrorKey(`${callId}:${runId}`);
          return;
        }
        const key = `${callId}:${runId}`;
        setRunResult({ run: result.run, tasks: result.tasks });
        setRunLoadedKey(key);
        setRunErrorKey(null);
      })
      .catch(/** Handles the callback for this operation. */(err) => {
        console.error('Failed to fetch analysis run tasks:', err);
        if (cancelled) return;
        setRunResult(null);
        setRunLoadedKey(null);
        setRunErrorKey(`${callId}:${runId}`);
      });

    return /** Handles the callback for this operation. */ () => {
      cancelled = true;
    };
  }, [callId, runId]);

  const runStatus: 'idle' | 'loading' | 'error' | 'ready' = useMemo(/** Handles the callback for this operation. */() => {
    if (!runKey) return 'idle';
    if (runLoadedKey === runKey && runResult) return 'ready';
    if (runErrorKey === runKey) return 'error';
    return 'loading';
  }, [runErrorKey, runKey, runLoadedKey, runResult]);

  const rows: PromptRow[] = useMemo(/** Handles the callback for this operation. */() => {
    if (runStatus !== 'ready' || !runKey || runLoadedKey !== runKey || !runResult) return [];
    const { run, tasks } = runResult;

    if (tasks.length > 0) {
      return [...tasks]
        .map(/** Handles the callback for this operation. */(task) => ({
          taskId: task.taskId,
          version: task.prompt ? parseVersionFromPath(task.prompt) : null,
          model: task.model || run.analyzerModel || t('kesp.common.notAvailable'),
          promptPath: task.prompt || '',
        }))
        .sort(/** Handles the callback for this operation. */(a, b) => a.taskId.localeCompare(b.taskId));
    }

    const promptPaths = run.promptPaths ?? {};
    return Object.keys(promptPaths)
      .sort(/** Handles the callback for this operation. */(a, b) => a.localeCompare(b))
      .map(/** Handles the callback for this operation. */(taskId) => {
        const promptPath = promptPaths[taskId] ?? '';
        return {
          taskId,
          version: promptPath ? parseVersionFromPath(promptPath) : null,
          model: run.analyzerModel || t('kesp.common.notAvailable'),
          promptPath,
        };
      });
  }, [runKey, runLoadedKey, runResult, runStatus, t]);

  if (callLoading) {
    return (
      <main className="main main-wide">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.common.loading')}</div>
        </div>
      </main>
    );
  }

  if (!call) {
    return (
      <main className="main main-wide">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.callDetail.callNotFound', { id: callId })}</div>
          <div style={{ marginTop: 14 }}>
            <Button kind="ghost" size="sm" onClick={/** Handles the onClick interaction. */ () => navigate(backToCalls)}>
              {t('kesp.common.back')}
            </Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="main main-wide">
      <div className="row row-between" style={{ marginBottom: 16, gap: 8 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <button
            type="button"
            className="nav-icon-btn"
            title={t('kesp.common.back')}
            aria-label={t('kesp.common.back')}
            onClick={/** Handles the onClick interaction. */ () =>
              navigate(appendReturnTo(`/kesp/call/${encodeURIComponent(call.id)}`, returnTo))}
          >
            <Icon name="arrowLeft" size={14} />
          </button>
          <div>
            <div className="eyebrow">{t('kesp.callPrompts.title')}</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{call.displayName ?? call.name ?? call.id}</div>
            <div className="muted tiny">{t('kesp.callPrompts.description')}</div>
          </div>
        </div>
      </div>

      {!runId ? (
        <div className="card" style={{ padding: 16 }}>
          <div className="muted small">{t('kesp.callPrompts.empty')}</div>
        </div>
      ) : runStatus === 'loading' ? (
        <div className="card" style={{ padding: 16 }}>
          <div className="muted small">{t('kesp.common.loading')}</div>
        </div>
      ) : runStatus === 'error' ? (
        <div className="card" style={{ padding: 16 }}>
          <div className="muted small">{t('kesp.common.error')}</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div
            className="row"
            style={{
              padding: '10px 14px',
              gap: 12,
              borderBottom: '1px solid var(--line)',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--ink-3)',
            }}
          >
            <div style={{ width: 220 }}>{t('kesp.callPrompts.columns.task')}</div>
            <div style={{ width: 90 }}>{t('kesp.callPrompts.columns.version')}</div>
            <div style={{ width: 160 }}>{t('kesp.callPrompts.columns.model')}</div>
            <div style={{ flex: 1, minWidth: 0 }}>{t('kesp.callPrompts.columns.path')}</div>
          </div>
          {rows.map(/** Handles the callback for this operation. */(row, i) => (
            <div
              key={row.taskId}
              className="row"
              style={{
                padding: '10px 14px',
                gap: 12,
                borderBottom: i < rows.length - 1 ? '1px solid var(--line)' : '0',
                alignItems: 'flex-start',
                fontSize: 13,
              }}
            >
              <div style={{ width: 220, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {t(`upload.promptVersions.${row.taskId}`, { defaultValue: row.taskId })}
                </div>
                <div className="muted tiny" style={{ wordBreak: 'break-all' }}>
                  {row.taskId}
                </div>
              </div>
              <div style={{ width: 90 }} className="muted">
                {row.version ?? t('kesp.common.notAvailable')}
              </div>
              <div style={{ width: 160 }} className="muted" title={row.model}>
                {row.model || t('kesp.common.notAvailable')}
              </div>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  wordBreak: 'break-all',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  fontSize: 12,
                  lineHeight: 1.35,
                }}
                title={row.promptPath}
              >
                {row.promptPath || t('kesp.common.notAvailable')}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
