import { useEffect, useState } from 'react';
import { useLocation, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fetchCall, fetchAnalysisRunWithTasks } from '@/services/firestore';
import type { Call } from '@/types';
import type { AnalysisRunInfo, TaskInfo } from '@/services/firestore';
import { appendReturnTo, getReturnToFromSearch } from '@/lib/returnTo';

/** Extract version string from a prompt file path, e.g. "prompts/...A-v4.md" → "v4" */
function parseVersionFromPath(path: string): string | null {
  const match = path.match(/-v(\d+(?:\.\d+)?)\.md$/);
  return match ? `v${match[1]}` : null;
}

/** Extract just the filename from a path */
function filenameFromPath(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Renders the PromptVersionsPage component. */
export function PromptVersionsPage() {
  const { id: callId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  const [, setCall] = useState<Call | null>(null);
  const [runInfo, setRunInfo] = useState<AnalysisRunInfo | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const returnTo = getReturnToFromSearch(location.search);
  const callDetailPath = callId
    ? appendReturnTo(`/calls/${callId}`, returnTo)
    : returnTo ?? '/calls';

  useEffect(/** Handles the callback for this operation. */() => {
    if (!callId) return;
    let cancelled = false;

    /** Documents the load behavior. */
    async function load() {
      try {
        const callDoc = await fetchCall(callId!);
        if (cancelled) return;
        if (!callDoc) {
          setError(t('common.error'));
          setLoading(false);
          return;
        }
        setCall(callDoc);

        const runId = callDoc.lastTerminalRunId ?? callDoc.activeAnalysisRunId;
        if (!runId) {
          // No analysis run — legacy call or not yet analyzed
          setLoading(false);
          return;
        }

        const result = await fetchAnalysisRunWithTasks(callId!, runId);
        if (cancelled) return;
        if (result) {
          setRunInfo(result.run);
          setTasks(result.tasks);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return /** Handles the callback for this operation. */ () => { cancelled = true; };
  }, [callId, t]);

  // Build the display rows: prefer task docs, fall back to run-level promptPaths
  const displayRows = buildDisplayRows(runInfo, tasks);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[300px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Button variant="ghost" size="sm" onClick={/** Handles the onClick interaction. */ () => navigate(callDetailPath)}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('common.back')}
        </Button>
        <p className="mt-4 text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={/** Handles the onClick interaction. */ () => navigate(callDetailPath)}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('common.back')}
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{t('callDetail.promptVersionsTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('callDetail.promptVersionsDescription')}</p>
        </div>
      </div>

      {/* No data fallback */}
      {!runInfo && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">{t('callDetail.noAnalysisRun')}</p>
            <p className="text-sm text-muted-foreground mt-1">{t('callDetail.noAnalysisRunHint')}</p>
          </CardContent>
        </Card>
      )}

      {/* Run info */}
      {runInfo && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-3">
                {t('callDetail.analysisMode')}
                <Badge variant="secondary">
                  {runInfo.analysisMode === 'subagent_2_0' ? t('callDetail.subagent_2_0') :
                    runInfo.analysisMode === 'legacy_tmk' ? t('callDetail.legacy_tmk') :
                      runInfo.analysisMode}
                </Badge>
                <Badge variant="outline">{t(`calls.${runInfo.status}`, runInfo.status)}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                {runInfo.finalizedAt && (
                  <div>
                    <span className="text-muted-foreground">{t('callDetail.analyzedAt')}</span>
                    <p className="font-medium">{runInfo.finalizedAt.toLocaleString()}</p>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">{t('callDetail.runStatus')}</span>
                  <p className="font-medium">{runInfo.completedTasks} / {runInfo.totalTasks} tasks</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Prompt versions table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('callDetail.promptVersions')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">{t('callDetail.task')}</th>
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">{t('callDetail.version')}</th>
                      <th className="pb-2 pr-4 font-medium text-muted-foreground">{t('callDetail.model')}</th>
                      <th className="pb-2 font-medium text-muted-foreground">{t('callDetail.promptFile')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map(/** Handles the callback for this operation. */(row) => (
                      <tr key={row.taskId} className="border-b last:border-0">
                        <td className="py-3 pr-4 font-medium">
                          {t(`upload.promptVersions.${row.taskId}`, row.taskId)}
                        </td>
                        <td className="py-3 pr-4">
                          {row.version ? (
                            <Badge variant="secondary" className="font-mono text-xs">{row.version}</Badge>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          {row.model ? (
                            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{row.model}</code>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="py-3">
                          <code className="text-xs text-muted-foreground break-all">{row.filename}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface DisplayRow {
  taskId: string;
  version: string | null;
  model: string;
  filename: string;
}

/** Documents the buildDisplayRows behavior. */
function buildDisplayRows(run: AnalysisRunInfo | null, tasks: TaskInfo[]): DisplayRow[] {
  if (!run) return [];

  // If we have task docs, use those (more accurate — they record the actual prompt used)
  if (tasks.length > 0) {
    return tasks.map(/** Handles the callback for this operation. */(task) => ({
      taskId: task.taskId,
      version: parseVersionFromPath(task.prompt),
      model: task.model,
      filename: filenameFromPath(task.prompt),
    }));
  }

  // Fall back to run-level promptPaths (no per-task model info available)
  return Object.entries(run.promptPaths).map(/** Handles the callback for this operation. */([taskId, path]) => ({
    taskId,
    version: parseVersionFromPath(path),
    model: '',
    filename: filenameFromPath(path),
  }));
}
