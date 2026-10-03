import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, FileAudio, Loader2, RefreshCw, Settings, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { PatternExamplesSection } from '@/components/call-analyzer/PatternExamplesSection';
import { AgentProgressView } from '@/components/call-analyzer/AgentProgressView';
import { AgentReminderView } from '@/components/call-analyzer/AgentReminderView';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { buildAgentKey } from '@/lib/agentActivity';
import {
  subscribeToAgentAnalysis,
  subscribeToAgentAnalysisReport,
  triggerAgentAnalysisRun,
  updateAgentAnalysisProcessingConfig,
} from '@/services/agentAnalyses';
import {
  getAvailablePrompts,
  refreshAgentActivity,
  type AvailablePromptsResponse,
} from '@/services/functions';
import { subscribeToAgentCallSnapshots } from '@/services/agentActivity';
import { subscribeToAgentLinkedCalls } from '@/services/firestore';
import {
  uploadAudioFile,
  validateAudioFile,
  type UploadProgress,
} from '@/services/storage';
import { useAuth } from '@/contexts/useAuth';
import type { AgentAnalysis, AgentAnalysisReport, AgentCallSnapshot, Call } from '@/types';
import { appendReturnTo } from '@/lib/returnTo';
import { cn } from '@/lib/utils';

const severityOrder = [
  'severe',
  'moderate-severe',
  'moderate',
  'moderate-minor',
  'minor',
] as const;

const linkedCallsPreviewCount = 10;
const REPORT_PROGRESS_RUNNING_CAP = 92;
const REPORT_PROGRESS_COMPLETE_HOLD_MS = 900;

/** Documents the normalizeDisplayName behavior. */
function normalizeDisplayName(value: string | null | undefined): string {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized && normalized.length > 0 ? normalized : '';
}

/** Documents the normalizeComparisonText behavior. */
function normalizeComparisonText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Documents the isGenericCustomerPlaceholder behavior. */
function isGenericCustomerPlaceholder(value: string | null | undefined): boolean {
  return normalizeComparisonText(value ?? '').startsWith('cliente sin nombre');
}

/** Documents the getMeaningfulLinkedCallTitle behavior. */
function getMeaningfulLinkedCallTitle(
  call: Call,
  snapshot: AgentCallSnapshot | undefined
): string {
  const candidates = [snapshot?.customerName, snapshot?.callName, call.name];
  for (const candidate of candidates) {
    const normalized = normalizeDisplayName(candidate);
    if (normalized && !isGenericCustomerPlaceholder(normalized)) {
      return normalized;
    }
  }
  return call.id;
}

/** Documents the getCallCategoryClasses behavior. */
function getCallCategoryClasses(category?: string | null) {
  switch (category) {
    case 'good':
      return {
        dot: 'bg-green-500',
        row: 'border-l-green-500',
      };
    case 'medium':
      return {
        dot: 'bg-yellow-500',
        row: 'border-l-yellow-500',
      };
    case 'bad':
      return {
        dot: 'bg-red-500',
        row: 'border-l-red-500',
      };
    default:
      return {
        dot: 'bg-gray-400',
        row: 'border-l-gray-300',
      };
  }
}

/** Documents the easeOutCubic behavior. */
function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}

/** Documents the computeRunningProgress behavior. */
function computeRunningProgress(elapsedMs: number, seed = 0): number {
  let base = 0;

  if (elapsedMs <= 1800) {
    base = easeOutCubic(elapsedMs / 1800) * 42;
  } else if (elapsedMs <= 9000) {
    const stageElapsed = elapsedMs - 1800;
    base = 42 + (1 - Math.exp(-stageElapsed / 3200)) * 46;
  } else {
    const stageElapsed = elapsedMs - 9000;
    base = 88 + (1 - Math.exp(-stageElapsed / 12000)) * 4;
  }

  const clampedBase = Math.min(base, REPORT_PROGRESS_RUNNING_CAP);
  if (seed <= 0) {
    return clampedBase;
  }

  return seed + (clampedBase / REPORT_PROGRESS_RUNNING_CAP) * (REPORT_PROGRESS_RUNNING_CAP - seed);
}

/** Documents the computeFinishedProgress behavior. */
function computeFinishedProgress(elapsedMs: number, fromValue: number): number {
  const durationMs = 650;
  const ratio = Math.max(0, Math.min(elapsedMs / durationMs, 1));
  return fromValue + easeOutCubic(ratio) * (100 - fromValue);
}

/** Renders the CallAnalyzerDetailPage component. */
export function CallAnalyzerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { t } = useTranslation();
  const { user } = useAuth();
  const [agentAnalysis, setAgentAnalysis] = useState<AgentAnalysis | null>(null);
  const [report, setReport] = useState<AgentAnalysisReport | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<Record<string, UploadProgress>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingActivity, setRefreshingActivity] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const settingsInitializedRef = useRef(false);
  const [availablePrompts, setAvailablePrompts] = useState<AvailablePromptsResponse | null>(null);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [callAnalyzerModel, setCallAnalyzerModel] = useState('');
  const [callPromptVersions, setCallPromptVersions] = useState<Record<string, string>>({});
  const [reportAnalyzerModel, setReportAnalyzerModel] = useState('');
  const [reportPromptVersions, setReportPromptVersions] = useState<Record<string, string>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [showCallPromptVersions, setShowCallPromptVersions] = useState(false);
  const [showReportPromptVersions, setShowReportPromptVersions] = useState(false);
  const [showPatternExamples, setShowPatternExamples] = useState<Record<string, boolean>>({});
  const [showPatternCoaching, setShowPatternCoaching] = useState<Record<string, boolean>>({});
  const [selectedPatternIdForCalls, setSelectedPatternIdForCalls] = useState<string | null>(null);
  const [showAllLinkedCalls, setShowAllLinkedCalls] = useState(false);
  const [expandedBins, setExpandedBins] = useState<Record<string, boolean>>({
    severe: true,
    'moderate-severe': true,
    moderate: false,
    'moderate-minor': false,
    minor: false,
  });
  const [manualReminderEnabled, setManualReminderEnabled] = useState(false);
  const [manualReminderNextAction, setManualReminderNextAction] = useState<'call_back' | 're_text'>(
    'call_back'
  );
  const [manualReminderDate, setManualReminderDate] = useState('');
  const [manualReminderTime, setManualReminderTime] = useState('');
  const [manualReminderNote, setManualReminderNote] = useState('');
  const [reportProgressValue, setReportProgressValue] = useState(0);
  const [reportProgressPhase, setReportProgressPhase] = useState<
    'idle' | 'starting' | 'running' | 'finishing' | 'complete'
  >('idle');
  const [snapshots, setSnapshots] = useState<AgentCallSnapshot[]>([]);
  const reportProgressStartedAtRef = useRef<number | null>(null);
  const reportProgressSeedRef = useRef(0);
  const reportProgressBaselineReportIdRef = useRef<string | undefined>(undefined);

  const resetReportProgress = /** Documents the resetReportProgress behavior. */ () => {
    setReportProgressValue(0);
    setReportProgressPhase('idle');
    reportProgressStartedAtRef.current = null;
    reportProgressSeedRef.current = 0;
    reportProgressBaselineReportIdRef.current = undefined;
  };

  useEffect(/** Handles the callback for this operation. */() => {
    settingsInitializedRef.current = false;
    setManualReminderEnabled(false);
    setManualReminderNextAction('call_back');
    setManualReminderDate('');
    setManualReminderTime('');
    setManualReminderNote('');
    setShowSettings(false);
    setShowPatternExamples({});
    setShowPatternCoaching({});
    setSelectedPatternIdForCalls(null);
    setShowAllLinkedCalls(false);
    setReportProgressValue(0);
    setReportProgressPhase('idle');
    reportProgressStartedAtRef.current = null;
    reportProgressSeedRef.current = 0;
    reportProgressBaselineReportIdRef.current = undefined;
  }, [id]);

  useEffect(/** Handles the callback for this operation. */() => {
    let cancelled = false;

    /** Documents the fetchPrompts behavior. */
    async function fetchPrompts() {
      setPromptsLoading(true);
      try {
        const data = await getAvailablePrompts();
        if (!cancelled) {
          setAvailablePrompts(data);
        }
      } catch (error) {
        console.error('Failed to fetch available prompts:', error);
        if (!cancelled) {
          setAvailablePrompts(null);
        }
      } finally {
        if (!cancelled) {
          setPromptsLoading(false);
        }
      }
    }

    fetchPrompts();
    return /** Handles the callback for this operation. */ () => {
      cancelled = true;
    };
  }, []);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!id) {
      setLoading(false);
      return undefined;
    }

    const unsubscribe = subscribeToAgentAnalysis(id, /** Handles the callback for this operation. */(nextAgentAnalysis) => {
      setAgentAnalysis(nextAgentAnalysis);
      setLoading(false);
    });

    return /** Handles the callback for this operation. */ () => unsubscribe();
  }, [id]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!id) {
      setReport(null);
      return undefined;
    }

    const unsubscribe = subscribeToAgentAnalysisReport(id, agentAnalysis?.latestReportId, setReport);
    return /** Handles the callback for this operation. */ () => unsubscribe();
  }, [agentAnalysis?.latestReportId, id]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid || !agentAnalysis?.salesAgentId) {
      setCalls([]);
      return undefined;
    }

    const unsubscribe = subscribeToAgentLinkedCalls(
      {
        userId: user.uid,
        agentAnalysisId: agentAnalysis.id,
        salesAgentId: agentAnalysis.salesAgentId,
      },
      setCalls
    );

    return /** Handles the callback for this operation. */ () => unsubscribe();
  }, [agentAnalysis?.id, agentAnalysis?.salesAgentId, user?.uid]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!agentAnalysis || !availablePrompts || settingsInitializedRef.current) {
      return;
    }

    setCallAnalyzerModel(
      agentAnalysis.callProcessingConfig?.analyzerModel ??
      availablePrompts.analyzerModels?.default ??
      ''
    );
    setCallPromptVersions(
      agentAnalysis.callProcessingConfig?.promptVersions ?? availablePrompts.defaults
    );
    setReportAnalyzerModel(
      agentAnalysis.reportProcessingConfig?.analyzerModel ??
      availablePrompts.analyzerModels?.default ??
      ''
    );
    setReportPromptVersions(
      agentAnalysis.reportProcessingConfig?.promptVersions ??
      availablePrompts.agentAnalysisDefaults
    );
    settingsInitializedRef.current = true;
  }, [agentAnalysis, availablePrompts]);

  const totalProgress = useMemo(/** Handles the callback for this operation. */() => {
    if (files.length === 0) {
      return 0;
    }

    return Object.values(progress).reduce(/** Handles the callback for this operation. */(sum, item) => sum + item.progress, 0) / files.length;
  }, [files.length, progress]);

  const agentKey = useMemo(/** Handles the callback for this operation. */() => {
    if (!user?.uid || !agentAnalysis?.salesAgentId) {
      return null;
    }
    return buildAgentKey(user.uid, agentAnalysis.salesAgentId);
  }, [agentAnalysis?.salesAgentId, user?.uid]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!agentKey) {
      setSnapshots([]);
      return undefined;
    }

    return subscribeToAgentCallSnapshots(agentKey, setSnapshots);
  }, [agentKey]);

  const returnTo = location.pathname + location.search;

  const handleFiles = /** Handles the handleFiles interaction. */ (newFiles: File[]) => {
    if (manualReminderEnabled && files.length + newFiles.length > 1) {
      toast.error(
        t('callAnalyzer.detail.manualReminderSingleFileError', {
          defaultValue: 'El recordatorio manual solo permite una carga a la vez.',
        })
      );
      return;
    }

    const validFiles: File[] = [];

    for (const file of newFiles) {
      const validation = validateAudioFile(file);
      if (validation.valid) {
        validFiles.push(file);
      } else {
        toast.error(`${file.name}: ${validation.error}`);
      }
    }

    setFiles(/** Handles the callback for this operation. */(currentFiles) => [...currentFiles, ...validFiles]);
  };

  const handleUpload = /** Handles the handleUpload interaction. */ async () => {
    if (!user?.uid || !agentAnalysis) {
      return;
    }

    if (files.length === 0) {
      fileInputRef.current?.click();
      return;
    }

    const effectiveCallAnalyzerModel =
      callAnalyzerModel || availablePrompts?.analyzerModels?.default;
    const manualReminderInput = manualReminderEnabled
      ? {
        needsFollowUp: true,
        nextAction: manualReminderNextAction,
        followUpDate: manualReminderDate || null,
        followUpTime: manualReminderTime || null,
        note: manualReminderNote || null,
      }
      : null;

    if (manualReminderEnabled && files.length !== 1) {
      toast.error(
        t('callAnalyzer.detail.manualReminderSingleFileError', {
          defaultValue: 'El recordatorio manual solo permite una carga a la vez.',
        })
      );
      return;
    }

    try {
      await updateAgentAnalysisProcessingConfig(agentAnalysis.id, {
        callProcessingConfig: {
          analyzerModel: effectiveCallAnalyzerModel,
          promptVersions: callPromptVersions,
        },
      });
    } catch (error) {
      console.error('Failed to save call processing settings:', error);
      toast.error(t('callAnalyzer.detail.settingsSaveError'));
      return;
    }

    setUploading(true);
    setProgress({});

    let successCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        await uploadAudioFile({
          file,
          userId: user.uid,
          salesAgentId: agentAnalysis.salesAgentId,
          salesAgentName: agentAnalysis.salesAgentName,
          manualReminderInput,
          promptVersions: callPromptVersions,
          analyzerModel: effectiveCallAnalyzerModel,
          onProgress: /** Handles the onProgress interaction. */ (nextProgress) => {
            setProgress(/** Handles the callback for this operation. */(currentProgress) => ({
              ...currentProgress,
              [file.name]: nextProgress,
            }));
          },
        });
        successCount++;
      } catch (error) {
        console.error(`Failed to upload ${file.name}:`, error);
        errorCount++;
      }
    }

    setUploading(false);

    if (successCount > 0) {
      toast.success(t('callAnalyzer.detail.uploadSuccess', { count: successCount }));
      setFiles([]);
      setProgress({});
      setManualReminderEnabled(false);
      setManualReminderNextAction('call_back');
      setManualReminderDate('');
      setManualReminderTime('');
      setManualReminderNote('');
    }

    if (errorCount > 0) {
      toast.error(t('callAnalyzer.detail.uploadError', { count: errorCount }));
    }
  };

  const removeFile = /** Documents the removeFile behavior. */ (index: number) => {
    setFiles(/** Handles the callback for this operation. */(currentFiles) => currentFiles.filter(/** Handles the callback for this operation. */(_, currentIndex) => currentIndex !== index));
  };

  const handleRefresh = /** Handles the handleRefresh interaction. */ async () => {
    if (!agentAnalysis) {
      return;
    }

    const effectiveReportAnalyzerModel =
      reportAnalyzerModel || availablePrompts?.analyzerModels?.default;

    setRefreshing(true);
    try {
      await updateAgentAnalysisProcessingConfig(agentAnalysis.id, {
        reportProcessingConfig: {
          analyzerModel: effectiveReportAnalyzerModel,
          promptVersions: reportPromptVersions,
        },
      });

      const result = await triggerAgentAnalysisRun(agentAnalysis.id);

      switch (result.result) {
        case 'started':
          reportProgressBaselineReportIdRef.current = agentAnalysis.latestReportId;
          reportProgressStartedAtRef.current = performance.now();
          reportProgressSeedRef.current = 0;
          setReportProgressValue(0);
          setReportProgressPhase('starting');
          toast.success(t('callAnalyzer.detail.refreshStarted'));
          break;
        case 'already_running':
          reportProgressBaselineReportIdRef.current = agentAnalysis.latestReportId;
          reportProgressStartedAtRef.current = performance.now();
          reportProgressSeedRef.current = Math.max(reportProgressValue, 18);
          setReportProgressValue(/** Handles the callback for this operation. */(current) => Math.max(current, 18));
          setReportProgressPhase('running');
          toast(t('callAnalyzer.detail.refreshAlreadyRunning'));
          break;
        case 'no_changes':
          resetReportProgress();
          toast(t('callAnalyzer.detail.refreshNoChanges'));
          break;
        case 'no_complete_calls':
          resetReportProgress();
          toast(t('callAnalyzer.detail.refreshNoCompleteCalls'));
          break;
        case 'no_eligible_calls':
          resetReportProgress();
          toast(t('callAnalyzer.detail.refreshNoEligibleCalls'));
          break;
        default:
          reportProgressBaselineReportIdRef.current = agentAnalysis.latestReportId;
          reportProgressStartedAtRef.current = performance.now();
          reportProgressSeedRef.current = 0;
          setReportProgressValue(0);
          setReportProgressPhase('starting');
          toast.success(t('callAnalyzer.detail.refreshStarted'));
          break;
      }
    } catch (error) {
      console.error('Failed to start agent analysis run:', error);
      toast.error(t('callAnalyzer.detail.refreshError'));
    } finally {
      setRefreshing(false);
    }
  };

  const handleRefreshActivity = /** Handles the handleRefreshActivity interaction. */ async () => {
    if (!agentAnalysis) {
      return;
    }

    setRefreshingActivity(true);
    try {
      const result = await refreshAgentActivity(agentAnalysis.id);
      if (result.errorCount > 0) {
        toast.error(
          t('callAnalyzer.detail.refreshActivityPartial', {
            defaultValue:
              'La actualización terminó con {{errors}} errores después de procesar {{processed}} llamadas.',
            errors: result.errorCount,
            processed: result.processedCount,
          })
        );
      } else {
        toast.success(
          t('callAnalyzer.detail.refreshActivitySuccess', {
            defaultValue: 'Se actualizaron los datos de actividad de {{count}} llamadas.',
            count: result.processedCount,
          })
        );
      }
    } catch (error) {
      console.error('Failed to refresh agent activity:', error);
      toast.error(
        t('callAnalyzer.detail.refreshActivityError', {
          defaultValue: 'No se pudieron actualizar los datos de actividad.',
        })
      );
    } finally {
      setRefreshingActivity(false);
    }
  };

  const toggleSeverityBin = /** Documents the toggleSeverityBin behavior. */ (severity: (typeof severityOrder)[number]) => {
    setExpandedBins(/** Handles the callback for this operation. */(current) => ({
      ...current,
      [severity]: !current[severity],
    }));
  };

  const analyzerModelOptions = availablePrompts?.analyzerModels;
  const orderedPatterns = useMemo(/** Handles the callback for this operation. */() => {
    if (!report || report.schemaVersion !== '2') {
      return [];
    }

    const patternsById = new Map(report.patterns.map(/** Handles the callback for this operation. */(pattern) => [pattern.patternId, pattern]));
    const ordered = report.patternOrder
      .map(/** Handles the callback for this operation. */(patternId) => patternsById.get(patternId))
      .filter(/** Handles the callback for this operation. */(pattern): pattern is NonNullable<typeof pattern> => Boolean(pattern));
    const seen = new Set(ordered.map(/** Handles the callback for this operation. */(pattern) => pattern.patternId));

    return [...ordered, ...report.patterns.filter(/** Handles the callback for this operation. */(pattern) => !seen.has(pattern.patternId))];
  }, [report]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!report || report.schemaVersion !== '2') {
      return;
    }

    setShowPatternExamples(/** Handles the callback for this operation. */(current) => {
      const next: Record<string, boolean> = {};
      orderedPatterns.forEach(/** Handles the callback for this operation. */(pattern) => {
        next[pattern.patternId] = current[pattern.patternId] ?? false;
      });
      return next;
    });
  }, [orderedPatterns, report]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!report || report.schemaVersion !== '2') {
      return;
    }

    setShowPatternCoaching(/** Handles the callback for this operation. */(current) => {
      const next: Record<string, boolean> = {};
      orderedPatterns.forEach(/** Handles the callback for this operation. */(pattern) => {
        next[pattern.patternId] = current[pattern.patternId] ?? false;
      });
      return next;
    });
  }, [orderedPatterns, report]);

  /** Documents the inferSpeakerKind behavior. */
  function inferSpeakerKind(
    evidenceItem: { speakerDisplay?: string | null; speakerLabel?: string | null } | null | undefined
  ): 'agent' | 'client' | 'unknown' {
    const raw = `${evidenceItem?.speakerDisplay ?? ''} ${evidenceItem?.speakerLabel ?? ''}`.trim();
    const normalized = normalizeComparisonText(raw);
    if (!normalized) return 'unknown';
    if (normalized === 'a' || normalized.includes('agente') || normalized.includes('agent')) {
      return 'agent';
    }
    if (normalized === 'c' || normalized.includes('cliente') || normalized.includes('customer')) {
      return 'client';
    }
    return 'unknown';
  }

  /** Documents the formatEvidenceSpeaker behavior. */
  function formatEvidenceSpeaker(
    evidenceItem: { speakerDisplay?: string | null; speakerLabel?: string | null },
    agentName: string
  ): string | null {
    const speakerKind = inferSpeakerKind(evidenceItem);
    if (speakerKind === 'agent') {
      return agentName;
    }
    if (speakerKind === 'client') {
      return 'Cliente';
    }
    const fallback = evidenceItem.speakerDisplay || evidenceItem.speakerLabel;
    return fallback && !/^speaker\s+[a-z]/i.test(fallback) ? fallback : null;
  }

  /** Documents the getTopPatternScene behavior. */
  function getTopPatternScene(
    evidence: Array<{ callId: string; quote: string; speakerDisplay?: string | null; speakerLabel?: string | null }>
  ) {
    for (let index = 0; index < evidence.length; index += 1) {
      const first = evidence[index];
      const second = evidence[index + 1];
      const third = evidence[index + 2];
      if (!first?.callId || !first.quote) continue;

      if (second && second.callId === first.callId) {
        const firstKind = inferSpeakerKind(first);
        const secondKind = inferSpeakerKind(second);
        if (firstKind === 'client' && secondKind === 'agent') {
          return { scene: [first, second], usedIndexes: new Set([index, index + 1]), label: 'real' as const };
        }
      }

      if (second && third && second.callId === first.callId && third.callId === first.callId) {
        const kinds = [inferSpeakerKind(first), inferSpeakerKind(second), inferSpeakerKind(third)];
        const distinctKinds = new Set(kinds.filter(/** Handles the callback for this operation. */(kind) => kind !== 'unknown'));
        const changes =
          (kinds[0] !== kinds[1] ? 1 : 0) +
          (kinds[1] !== kinds[2] ? 1 : 0);
        if (distinctKinds.size >= 2 && changes >= 2) {
          return {
            scene: [first, second, third],
            usedIndexes: new Set([index, index + 1, index + 2]),
            label: 'real' as const,
          };
        }
      }
    }

    return {
      scene: [] as typeof evidence,
      usedIndexes: new Set<number>(),
      label: 'fragments' as const,
    };
  }

  /** Documents the formatPatternCoveragePercent behavior. */
  function formatPatternCoveragePercent(seen: number, total: number): string | null {
    if (!total || total <= 0) {
      return null;
    }

    const rawPercent = (seen / total) * 100;
    const roundedToWhole = Math.round(rawPercent);
    if (Math.abs(rawPercent - roundedToWhole) < 0.05) {
      return `${roundedToWhole}%`;
    }
    return `${rawPercent.toFixed(1)}%`;
  }

  const snapshotByCallId = useMemo(
    /** Handles the callback for this operation. */
    () => new Map(snapshots.map(/** Handles the callback for this operation. */(snapshot) => [snapshot.sourceCallId, snapshot])),
    [snapshots]
  );

  const linkedCallsWithLabels = useMemo(/** Handles the callback for this operation. */() => {
    return calls.map(/** Handles the callback for this operation. */(call, index) => {
      const snapshot = snapshotByCallId.get(call.id);
      return {
        call,
        index,
        category: snapshot?.callCategory ?? 'unknown',
        displayLabel: getMeaningfulLinkedCallTitle(call, snapshot),
      };
    });
  }, [calls, snapshotByCallId]);
  const linkedCallById = useMemo(
    /** Handles the callback for this operation. */
    () => new Map(linkedCallsWithLabels.map(/** Handles the callback for this operation. */(item) => [item.call.id, item])),
    [linkedCallsWithLabels]
  );
  const linkedCallLabelById = useMemo(
    /** Handles the callback for this operation. */
    () =>
      Object.fromEntries(linkedCallsWithLabels.map(/** Handles the callback for this operation. */(item) => [item.call.id, item.displayLabel])),
    [linkedCallsWithLabels]
  );

  const visibleLinkedCalls = showAllLinkedCalls
    ? linkedCallsWithLabels
    : linkedCallsWithLabels.slice(0, linkedCallsPreviewCount);
  const patternCallIdsByPatternId = useMemo(/** Handles the callback for this operation. */() => {
    const next = new Map<string, string[]>();

    for (const pattern of orderedPatterns) {
      const uniqueIds: string[] = [];
      const seenIds = new Set<string>();

      for (const callId of pattern.sourceCallIds ?? []) {
        if (callId && !seenIds.has(callId)) {
          seenIds.add(callId);
          uniqueIds.push(callId);
        }
      }

      for (const evidenceItem of pattern.supportingEvidence ?? []) {
        const callId = evidenceItem.callId;
        if (callId && !seenIds.has(callId)) {
          seenIds.add(callId);
          uniqueIds.push(callId);
        }
      }

      next.set(pattern.patternId, uniqueIds);
    }

    return next;
  }, [orderedPatterns]);
  const patternDisplaySeenCountByPatternId = useMemo(
    /** Handles the callback for this operation. */
    () =>
      new Map(
        orderedPatterns.map(/** Handles the callback for this operation. */(pattern) => [
          pattern.patternId,
          patternCallIdsByPatternId.get(pattern.patternId)?.length ?? pattern.seenInCallCount,
        ])
      ),
    [orderedPatterns, patternCallIdsByPatternId]
  );
  const selectedPattern = selectedPatternIdForCalls
    ? orderedPatterns.find(/** Handles the callback for this operation. */(pattern) => pattern.patternId === selectedPatternIdForCalls) ?? null
    : null;
  const priorityRankByPatternId = useMemo(
    /** Handles the callback for this operation. */
    () => new Map(orderedPatterns.map(/** Handles the callback for this operation. */(pattern, index) => [pattern.patternId, index + 1])),
    [orderedPatterns]
  );
  const selectedPatternCallRows = useMemo(/** Handles the callback for this operation. */() => {
    if (!selectedPattern) {
      return [];
    }

    return (patternCallIdsByPatternId.get(selectedPattern.patternId) ?? []).map(/** Handles the callback for this operation. */(callId) => {
      const preview = selectedPattern.supportingEvidence.find(/** Handles the callback for this operation. */(evidenceItem) => evidenceItem.callId === callId);
      const linkedCall = linkedCallById.get(callId);
      return {
        callId,
        displayLabel: linkedCall?.displayLabel ?? callId,
        category: linkedCall?.category ?? 'unknown',
        quote: preview?.quote ?? '',
        speakerDisplay: preview?.speakerDisplay ?? preview?.speakerLabel ?? '',
      };
    });
  }, [linkedCallById, patternCallIdsByPatternId, selectedPattern]);

  const reportGenerationActive =
    reportProgressPhase === 'starting' ||
    reportProgressPhase === 'running' ||
    reportProgressPhase === 'finishing' ||
    agentAnalysis?.status === 'analyzing';

  useEffect(/** Handles the callback for this operation. */() => {
    const latestReportId = agentAnalysis?.latestReportId;
    const agentStatus = agentAnalysis?.status;
    const baselineReportId = reportProgressBaselineReportIdRef.current;
    const completedWithNewReport = Boolean(
      latestReportId &&
      latestReportId !== baselineReportId &&
      reportProgressPhase !== 'idle' &&
      reportProgressPhase !== 'complete'
    );

    if (
      agentStatus === 'analyzing' &&
      reportProgressPhase === 'idle' &&
      reportProgressValue === 0
    ) {
      reportProgressBaselineReportIdRef.current = latestReportId;
      reportProgressStartedAtRef.current = performance.now();
      reportProgressSeedRef.current = 12;
      setReportProgressValue(12);
      setReportProgressPhase('running');
      return undefined;
    }

    if (completedWithNewReport && reportProgressPhase !== 'finishing') {
      reportProgressStartedAtRef.current = performance.now();
      reportProgressSeedRef.current = reportProgressValue;
      setReportProgressPhase('finishing');
      return undefined;
    }

    if (
      reportProgressPhase !== 'idle' &&
      reportProgressPhase !== 'complete' &&
      agentStatus !== 'analyzing' &&
      !completedWithNewReport &&
      latestReportId === baselineReportId
    ) {
      resetReportProgress();
      return undefined;
    }

    if (reportProgressPhase === 'starting' || reportProgressPhase === 'running') {
      let frameId = 0;
      const startedAt = reportProgressStartedAtRef.current ?? performance.now();
      reportProgressStartedAtRef.current = startedAt;
      const seed = reportProgressSeedRef.current;

      const tick = /** Documents the tick behavior. */ (now: number) => {
        const elapsedMs = now - startedAt;
        const nextValue = computeRunningProgress(elapsedMs, seed);
        setReportProgressValue(/** Handles the callback for this operation. */(current) => (nextValue > current ? nextValue : current));
        if (reportProgressPhase === 'starting' && elapsedMs >= 250) {
          setReportProgressPhase('running');
        }
        frameId = window.requestAnimationFrame(tick);
      };

      frameId = window.requestAnimationFrame(tick);
      return /** Handles the callback for this operation. */ () => window.cancelAnimationFrame(frameId);
    }

    if (reportProgressPhase === 'finishing') {
      let frameId = 0;
      const startedAt = reportProgressStartedAtRef.current ?? performance.now();
      reportProgressStartedAtRef.current = startedAt;
      const finishFrom = reportProgressSeedRef.current || reportProgressValue;

      const tick = /** Documents the tick behavior. */ (now: number) => {
        const elapsedMs = now - startedAt;
        const nextValue = computeFinishedProgress(elapsedMs, finishFrom);
        setReportProgressValue(/** Handles the callback for this operation. */(current) => (nextValue > current ? nextValue : current));
        if (elapsedMs >= 650) {
          setReportProgressValue(100);
          setReportProgressPhase('complete');
          reportProgressStartedAtRef.current = null;
          reportProgressSeedRef.current = 0;
          reportProgressBaselineReportIdRef.current = latestReportId;
          return;
        }
        frameId = window.requestAnimationFrame(tick);
      };

      frameId = window.requestAnimationFrame(tick);
      return /** Handles the callback for this operation. */ () => window.cancelAnimationFrame(frameId);
    }

    if (reportProgressPhase === 'complete') {
      const timeoutId = window.setTimeout(/** Handles the callback for this operation. */() => {
        resetReportProgress();
      }, REPORT_PROGRESS_COMPLETE_HOLD_MS);

      return /** Handles the callback for this operation. */ () => window.clearTimeout(timeoutId);
    }

    return undefined;
  }, [
    agentAnalysis?.latestReportId,
    agentAnalysis?.status,
    reportProgressPhase,
    reportProgressValue,
  ]);

  if (loading) {
    return (
      <div className="flex items-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        {t('common.loading')}
      </div>
    );
  }

  if (!agentAnalysis) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold">{t('callAnalyzer.detail.title')}</h1>
        <p className="text-muted-foreground">{t('callAnalyzer.detail.notFound')}</p>
        <Button asChild variant="outline">
          <Link to="/call-analyzer">{t('common.back')}</Link>
        </Button>
      </div>
    );
  }

  const manualReminderBlock = (
    <Card>
      <CardHeader>
        <CardTitle>
          {t('callAnalyzer.detail.manualReminderTitle', {
            defaultValue: 'Recordatorio manual de primera llamada',
          })}
        </CardTitle>
        <CardDescription>
          {t('callAnalyzer.detail.manualReminderDescription', {
            defaultValue:
              'Opcional. Úsalo cuando la primera llamada registrada ya requiere un recordatorio para volver a llamar o reenviar mensaje.',
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={manualReminderEnabled}
            disabled={uploading}
            onChange={/** Handles the onChange interaction. */ (event) => {
              if (event.target.checked && files.length > 1) {
                toast.error(
                  t('callAnalyzer.detail.manualReminderSingleFileError', {
                    defaultValue:
                      'El recordatorio manual solo permite una carga a la vez.',
                  })
                );
                return;
              }
              setManualReminderEnabled(event.target.checked);
            }}
          />
          {t('callAnalyzer.detail.manualReminderEnable', {
            defaultValue: 'Agregar recordatorio',
          })}
        </label>

        {manualReminderEnabled ? (
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t('callAnalyzer.detail.manualReminderAction', {
                  defaultValue: 'Siguiente acción',
                })}
              </p>
              <Select
                value={manualReminderNextAction}
                onValueChange={/** Handles the onValueChange interaction. */ (value) =>
                  setManualReminderNextAction(value as 'call_back' | 're_text')
                }
                disabled={uploading}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="call_back">
                    {t('callAnalyzer.detail.manualReminderCallBack', {
                      defaultValue: 'Volver a llamar',
                    })}
                  </SelectItem>
                  <SelectItem value="re_text">
                    {t('callAnalyzer.detail.manualReminderReText', {
                      defaultValue: 'Reenviar mensaje',
                    })}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t('callAnalyzer.detail.manualReminderDate', {
                  defaultValue: 'Fecha de seguimiento',
                })}
              </p>
              <Input
                type="date"
                value={manualReminderDate}
                disabled={uploading}
                onChange={/** Handles the onChange interaction. */ (event) => setManualReminderDate(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t('callAnalyzer.detail.manualReminderTime', {
                  defaultValue: 'Hora de seguimiento',
                })}
              </p>
              <Input
                type="time"
                value={manualReminderTime}
                disabled={uploading}
                onChange={/** Handles the onChange interaction. */ (event) => setManualReminderTime(event.target.value)}
              />
            </div>

            <div className="space-y-2 md:col-span-3">
              <p className="text-sm font-medium">
                {t('callAnalyzer.detail.manualReminderNote', {
                  defaultValue: 'Nota',
                })}
              </p>
              <Input
                value={manualReminderNote}
                disabled={uploading}
                placeholder={t('callAnalyzer.detail.manualReminderNotePlaceholder', {
                  defaultValue: 'Agrega una nota opcional para el recordatorio.',
                })}
                onChange={/** Handles the onChange interaction. */ (event) => setManualReminderNote(event.target.value)}
              />
            </div>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          {t('callAnalyzer.detail.manualReminderHelp', {
            defaultValue:
              'El recordatorio manual se mantiene separado del resultado de la llamada y está pensado para cargas de una sola llamada de primera vez.',
          })}
        </p>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{agentAnalysis.salesAgentName}</h1>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('callAnalyzer.detail.status')}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {agentAnalysis.status}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('callAnalyzer.detail.linkedCalls')}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {calls.length}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('callAnalyzer.detail.latestReport')}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {agentAnalysis.latestReportId ?? t('callAnalyzer.detail.noReport')}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="upload" className="space-y-6">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="upload">
            {t('callAnalyzer.detail.uploadTab', { defaultValue: 'Carga' })}
          </TabsTrigger>
          <TabsTrigger value="report">
            {t('callAnalyzer.detail.reportTab', { defaultValue: 'Reporte' })}
          </TabsTrigger>
          <TabsTrigger value="reminders">
            {t('callAnalyzer.detail.remindersTab', {
              defaultValue: 'Recordatorio de llamadas',
            })}
          </TabsTrigger>
          <TabsTrigger value="progress">
            {t('callAnalyzer.detail.progressTab', {
              defaultValue: 'Progresión del supervisor',
            })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="upload" className="space-y-6">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={/** Handles the onClick interaction. */ () => setShowSettings(/** Handles the callback for this operation. */(current) => !current)}
              title={t('callAnalyzer.detail.settingsToggle', { defaultValue: 'Configuración' })}
              aria-label={t('callAnalyzer.detail.settingsToggle', { defaultValue: 'Configuración' })}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>

          {showSettings ? (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>{t('callAnalyzer.detail.callProcessingTitle')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {promptsLoading ? (
                    <div className="flex items-center py-2">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-sm text-muted-foreground">
                        {t('upload.analyzerModel.loading')}
                      </span>
                    </div>
                  ) : analyzerModelOptions?.available?.length ? (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        {t('upload.analyzerModel.label')}
                      </label>
                      <Select
                        value={callAnalyzerModel || analyzerModelOptions.default}
                        onValueChange={setCallAnalyzerModel}
                        disabled={uploading || analyzerModelOptions.available.length <= 1}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {analyzerModelOptions.available.map(/** Handles the callback for this operation. */(model) => (
                            <SelectItem key={model} value={model}>
                              {model}
                              {model === analyzerModelOptions.default
                                ? ` ${t('upload.promptVersions.default')}`
                                : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {t('upload.analyzerModel.help')}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t('upload.analyzerModel.fallback')}
                    </p>
                  )}

                  <div className="rounded-lg border">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                      onClick={/** Handles the onClick interaction. */ () => setShowCallPromptVersions(/** Handles the callback for this operation. */(current) => !current)}
                    >
                      <div>
                        <p className="font-medium">{t('upload.promptVersions.title')}</p>
                        <p className="text-sm text-muted-foreground">
                          {t('upload.promptVersions.description')}
                        </p>
                      </div>
                      {showCallPromptVersions ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>

                    {showCallPromptVersions && (
                      <div className="border-t px-4 py-4">
                        {promptsLoading ? (
                          <div className="flex items-center justify-center py-2">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            <span className="ml-2 text-sm text-muted-foreground">
                              {t('upload.promptVersions.loading')}
                            </span>
                          </div>
                        ) : availablePrompts ? (
                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            {Object.entries(availablePrompts.availableVersions).map(/** Handles the callback for this operation. */([taskId, versions]) => (
                              <div key={taskId} className="space-y-1.5">
                                <label className="text-sm font-medium">
                                  {t(`upload.promptVersions.${taskId}`, { defaultValue: taskId })}
                                </label>
                                <Select
                                  value={callPromptVersions[taskId] ?? availablePrompts.defaults[taskId]}
                                  onValueChange={/** Handles the onValueChange interaction. */ (value) =>
                                    setCallPromptVersions(/** Handles the callback for this operation. */(current) => ({
                                      ...current,
                                      [taskId]: value,
                                    }))
                                  }
                                  disabled={uploading || versions.length <= 1}
                                >
                                  <SelectTrigger className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {versions.map(/** Handles the callback for this operation. */(version) => (
                                      <SelectItem key={version} value={version}>
                                        v{version}
                                        {version === availablePrompts.defaults[taskId]
                                          ? ` ${t('upload.promptVersions.default')}`
                                          : ''}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            {t('upload.promptVersions.error')}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t('callAnalyzer.detail.reportProcessingTitle')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {promptsLoading ? (
                    <div className="flex items-center py-2">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-sm text-muted-foreground">
                        {t('upload.analyzerModel.loading')}
                      </span>
                    </div>
                  ) : analyzerModelOptions?.available?.length ? (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        {t('upload.analyzerModel.label')}
                      </label>
                      <Select
                        value={reportAnalyzerModel || analyzerModelOptions.default}
                        onValueChange={setReportAnalyzerModel}
                        disabled={refreshing || agentAnalysis.status === 'analyzing'}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {analyzerModelOptions.available.map(/** Handles the callback for this operation. */(model) => (
                            <SelectItem key={model} value={model}>
                              {model}
                              {model === analyzerModelOptions.default
                                ? ` ${t('upload.promptVersions.default')}`
                                : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {t('callAnalyzer.detail.reportAnalyzerHelp')}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t('upload.analyzerModel.fallback')}
                    </p>
                  )}

                  <div className="rounded-lg border">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                      onClick={/** Handles the onClick interaction. */ () => setShowReportPromptVersions(/** Handles the callback for this operation. */(current) => !current)}
                    >
                      <div>
                        <p className="font-medium">
                          {t('callAnalyzer.detail.reportPromptVersionsTitle')}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {t('callAnalyzer.detail.reportPromptVersionsDescription')}
                        </p>
                      </div>
                      {showReportPromptVersions ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>

                    {showReportPromptVersions ? (
                      <div className="border-t px-4 py-4">
                        {promptsLoading ? (
                          <div className="flex items-center justify-center py-2">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            <span className="ml-2 text-sm text-muted-foreground">
                              {t('upload.promptVersions.loading')}
                            </span>
                          </div>
                        ) : availablePrompts ? (
                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            {Object.entries(availablePrompts.agentAnalysisVersions).map(
                              /** Handles the callback for this operation. */
                              ([taskId, versions]) => (
                                <div key={taskId} className="space-y-1.5">
                                  <label className="text-sm font-medium">
                                    {t(`callAnalyzer.detail.reportPromptVersions.${taskId}`, {
                                      defaultValue: taskId,
                                    })}
                                  </label>
                                  <Select
                                    value={
                                      reportPromptVersions[taskId] ??
                                      availablePrompts.agentAnalysisDefaults[taskId]
                                    }
                                    onValueChange={/** Handles the onValueChange interaction. */ (value) =>
                                      setReportPromptVersions(/** Handles the callback for this operation. */(current) => ({
                                        ...current,
                                        [taskId]: value,
                                      }))
                                    }
                                    disabled={
                                      refreshing ||
                                      agentAnalysis.status === 'analyzing' ||
                                      versions.length <= 1
                                    }
                                  >
                                    <SelectTrigger className="w-full">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {versions.map(/** Handles the callback for this operation. */(version) => (
                                        <SelectItem key={version} value={version}>
                                          v{version}
                                          {version ===
                                            availablePrompts.agentAnalysisDefaults[taskId]
                                            ? ` ${t('upload.promptVersions.default')}`
                                            : ''}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              )
                            )}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            {t('upload.promptVersions.error')}
                          </p>
                        )}
                      </div>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t('callAnalyzer.detail.uploadTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {t('callAnalyzer.detail.uploadLabel')}
                </p>
                <input
                  ref={fileInputRef}
                  id="call-analyzer-files"
                  type="file"
                  accept="audio/wav,audio/mpeg,audio/mp3,.wav,.mp3"
                  multiple={!manualReminderEnabled}
                  className="sr-only"
                  disabled={uploading}
                  onChange={/** Handles the onChange interaction. */ (event) => {
                    if (event.target.files) {
                      handleFiles(Array.from(event.target.files));
                      event.target.value = '';
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={/** Handles the onClick interaction. */ () => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  {t('callAnalyzer.detail.selectFilesButton')}
                </Button>
              </div>

              {files.length > 0 && (
                <div className="space-y-2 rounded-lg border p-3">
                  {files.map(/** Handles the callback for this operation. */(file, index) => (
                    <div key={file.name} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <FileAudio className="h-4 w-4 text-muted-foreground" />
                        <span>{file.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                        </span>
                        {!uploading ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={/** Handles the onClick interaction. */ () => removeFile(index)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {uploading && (
                <div className="space-y-2">
                  <Progress value={totalProgress} />
                  <p className="text-sm text-muted-foreground">{Math.round(totalProgress)}%</p>
                </div>
              )}

              <Button onClick={handleUpload} disabled={uploading || !user?.uid} className="w-full">
                {uploading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {t('upload.uploading')}
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 mr-2" />
                    {files.length === 0
                      ? t('callAnalyzer.detail.selectFilesButton')
                      : t('callAnalyzer.detail.uploadButton')}
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('callAnalyzer.detail.generateReportTitle', { defaultValue: 'Generación del reporte' })}</CardTitle>
              <CardDescription>
                {t('callAnalyzer.detail.generateReportDescription', {
                  defaultValue: 'Primero sube llamadas y después genera o actualiza el análisis del agente.',
                })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={handleRefresh}
                  disabled={reportGenerationActive}
                >
                  {reportGenerationActive ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  {reportGenerationActive
                    ? t('callAnalyzer.detail.refreshRunning')
                    : t('callAnalyzer.detail.refreshButton')}
                </Button>

                <Button
                  onClick={handleRefreshActivity}
                  disabled={refreshingActivity}
                  variant="outline"
                >
                  {refreshingActivity ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  {t('callAnalyzer.detail.refreshActivityButton', {
                    defaultValue: 'Actualizar datos de actividad',
                  })}
                </Button>
              </div>

              {reportGenerationActive ? (
                <div className="space-y-2">
                  <div className="h-2 overflow-hidden rounded-full bg-emerald-200/40">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-[width] duration-150 ease-out"
                      style={{ width: `${Math.max(0, Math.min(reportProgressValue, 100))}%` }}
                    />
                  </div>
                  <p className="text-sm text-emerald-600">
                    {t('callAnalyzer.detail.refreshRunning', { defaultValue: 'Generando reporte...' })}
                  </p>
                </div>
              ) : reportProgressPhase === 'complete' || agentAnalysis.latestReportId ? (
                <div className="space-y-2">
                  <div className="h-2 overflow-hidden rounded-full bg-emerald-200/40">
                    <div className="h-full w-full rounded-full bg-emerald-500" />
                  </div>
                  <p className="text-sm text-emerald-600">
                    {t('callAnalyzer.detail.reportReady', { defaultValue: 'Reporte listo' })}
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('callAnalyzer.detail.callsTitle')}</CardTitle>
              <CardDescription>{t('callAnalyzer.detail.callsDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              {calls.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('callAnalyzer.detail.noCalls')}</p>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {t('callAnalyzer.detail.linkedCallsShowing', {
                      defaultValue: 'Mostrando {{shown}} de {{total}} llamadas asociadas',
                      shown: visibleLinkedCalls.length,
                      total: calls.length,
                    })}
                  </p>
                  <div className="space-y-2">
                    {visibleLinkedCalls.map(/** Handles the callback for this operation. */(call) => (
                      <div
                        key={call.call.id}
                        className={cn(
                          'flex items-center justify-between rounded-lg border border-l-4 px-3 py-2 text-sm',
                          getCallCategoryClasses(call.category).row
                        )}
                      >
                        <Link
                          to={appendReturnTo(`/calls/${call.call.id}`, returnTo)}
                          className="flex items-center gap-2 font-medium hover:underline"
                        >
                          <span
                            className={cn(
                              'h-2.5 w-2.5 rounded-full',
                              getCallCategoryClasses(call.category).dot
                            )}
                          />
                          {call.displayLabel}
                        </Link>
                        <span className="text-muted-foreground">{call.call.status}</span>
                      </div>
                    ))}
                  </div>
                  {calls.length > linkedCallsPreviewCount ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={/** Handles the onClick interaction. */ () => setShowAllLinkedCalls(/** Handles the callback for this operation. */(current) => !current)}
                    >
                      {showAllLinkedCalls
                        ? t('callAnalyzer.detail.showLessCalls', { defaultValue: 'Ver menos' })
                        : t('callAnalyzer.detail.showAllCalls', { defaultValue: 'Ver todas' })}
                    </Button>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="report" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('callAnalyzer.detail.reportTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              {report ? (
                report.schemaVersion === '2' ? (
                  <div className="space-y-4">
                    {orderedPatterns.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t('callAnalyzer.detail.noPatterns')}
                      </p>
                    ) : (
                      orderedPatterns.map(/** Handles the callback for this operation. */(pattern) => {
                        const visibleTips = pattern.mentorshipTips.slice(0, 2);
                        const topScene = getTopPatternScene(pattern.supportingEvidence);
                        const visibleEvidence = topScene.scene;
                        const featuredExample = pattern.examples[0] ?? null;
                        const featuredExampleCall = featuredExample
                          ? linkedCallById.get(featuredExample.callId)
                          : undefined;

                        return (
                          <div key={pattern.patternId} className="rounded-lg border p-4">
                            <div className="space-y-3">
                              <div className="flex flex-wrap items-start justify-between gap-4">
                                <div className="space-y-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <h3 className="font-semibold">{pattern.patternName}</h3>
                                    <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                                      {t('callAnalyzer.detail.patternPriority', {
                                        score:
                                          priorityRankByPatternId.get(pattern.patternId) ??
                                          pattern.priorityScore,
                                      })}
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    className="text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
                                    onClick={/** Handles the onClick interaction. */ () => setSelectedPatternIdForCalls(pattern.patternId)}
                                  >
                                    {t('callAnalyzer.detail.patternCoverage', {
                                      seen:
                                        patternDisplaySeenCountByPatternId.get(pattern.patternId) ??
                                        pattern.seenInCallCount,
                                      total: pattern.totalCallCount,
                                    })}
                                  </button>
                                  {formatPatternCoveragePercent(
                                    patternDisplaySeenCountByPatternId.get(pattern.patternId) ??
                                    pattern.seenInCallCount,
                                    pattern.totalCallCount
                                  ) ? (
                                    <p className="text-xs text-muted-foreground/80">
                                      {t('callAnalyzer.detail.patternCoveragePercent', {
                                        defaultValue: '{{percent}} de las llamadas analizadas',
                                        percent: formatPatternCoveragePercent(
                                          patternDisplaySeenCountByPatternId.get(pattern.patternId) ??
                                          pattern.seenInCallCount,
                                          pattern.totalCallCount
                                        ),
                                      })}
                                    </p>
                                  ) : null}
                                </div>
                              </div>

                              <>
                                <div className="grid gap-3 md:grid-cols-2">
                                  <div className="space-y-1">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                      {t('callAnalyzer.detail.behaviorSummaryCompact', {
                                        defaultValue: 'Qué está pasando',
                                      })}
                                    </p>
                                    <p className="text-sm text-muted-foreground">{pattern.behaviorSummary}</p>
                                  </div>
                                  <div className="space-y-1">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                      {t('callAnalyzer.detail.businessImpactCompact', {
                                        defaultValue: 'Por qué importa',
                                      })}
                                    </p>
                                    <p className="text-sm text-muted-foreground">{pattern.businessImpact}</p>
                                  </div>
                                </div>

                                <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    {t('callAnalyzer.detail.coachingFocusCompact', {
                                      defaultValue: 'Qué hacer ya',
                                    })}
                                  </p>
                                  <p className="text-base font-semibold leading-snug">{pattern.coachingFocus}</p>
                                  {visibleTips.length > 0 ? (
                                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                                      {visibleTips.map(/** Handles the callback for this operation. */(tip, tipIndex) => (
                                        <li key={`${pattern.patternId}-tip-${tipIndex}`}>{tip.tip}</li>
                                      ))}
                                    </ul>
                                  ) : null}
                                  {pattern.executionGuide ? (
                                    <div className="border-t pt-2">
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={/** Handles the onClick interaction. */ () =>
                                          setShowPatternCoaching(/** Handles the callback for this operation. */(current) => ({
                                            ...current,
                                            [pattern.patternId]: !current[pattern.patternId],
                                          }))
                                        }
                                      >
                                        {showPatternCoaching[pattern.patternId]
                                          ? t('callAnalyzer.detail.hidePatternCoaching', {
                                            defaultValue: 'Ocultar coaching',
                                          })
                                          : t('callAnalyzer.detail.showPatternCoaching', {
                                            defaultValue: 'Ver cómo hacerlo',
                                          })}
                                      </Button>
                                    </div>
                                  ) : null}
                                  {showPatternCoaching[pattern.patternId] && pattern.executionGuide ? (
                                    <div className="space-y-3 rounded-md border bg-background/70 p-3 text-sm">
                                      {pattern.executionGuide.whenToUse ? (
                                        <div className="space-y-1">
                                          <p className="font-medium">
                                            {t('callAnalyzer.detail.executionGuideWhenToUse', {
                                              defaultValue: 'Cuándo usarlo',
                                            })}
                                          </p>
                                          <p className="text-muted-foreground">
                                            {pattern.executionGuide.whenToUse}
                                          </p>
                                        </div>
                                      ) : null}
                                      {pattern.executionGuide.sayThis ? (
                                        <div className="space-y-1">
                                          <p className="font-medium">
                                            {t('callAnalyzer.detail.executionGuideSayThis', {
                                              defaultValue: 'Di esto',
                                            })}
                                          </p>
                                          <p className="text-muted-foreground">
                                            {pattern.executionGuide.sayThis}
                                          </p>
                                        </div>
                                      ) : null}
                                      {pattern.executionGuide.avoidThis ? (
                                        <div className="space-y-1">
                                          <p className="font-medium">
                                            {t('callAnalyzer.detail.executionGuideAvoidThis', {
                                              defaultValue: 'No hagas esto',
                                            })}
                                          </p>
                                          <p className="text-muted-foreground">
                                            {pattern.executionGuide.avoidThis}
                                          </p>
                                        </div>
                                      ) : null}
                                      {pattern.executionGuide.nextStep ? (
                                        <div className="space-y-1">
                                          <p className="font-medium">
                                            {t('callAnalyzer.detail.executionGuideNextStep', {
                                              defaultValue: 'Busca este siguiente paso',
                                            })}
                                          </p>
                                          <p className="text-muted-foreground">
                                            {pattern.executionGuide.nextStep}
                                          </p>
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>

                                {featuredExample ? (
                                  <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                      <div className="space-y-1">
                                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                          {t('callAnalyzer.detail.evidenceCompact', {
                                            defaultValue: 'Ejemplo real',
                                          })}
                                        </p>
                                        <div className="flex flex-wrap items-center gap-2 text-sm">
                                          <Link
                                            to={appendReturnTo(`/calls/${featuredExample.callId}`, returnTo)}
                                            className="font-medium underline-offset-2 hover:underline"
                                          >
                                            {featuredExampleCall?.displayLabel ?? featuredExample.callId}
                                          </Link>
                                          {featuredExampleCall?.displayLabel &&
                                            featuredExampleCall.displayLabel !== featuredExample.callId ? (
                                            <span className="text-xs text-muted-foreground">
                                              {featuredExample.callId}
                                            </span>
                                          ) : null}
                                        </div>
                                      </div>
                                      <Button asChild size="sm" variant="outline">
                                        <Link
                                          to={appendReturnTo(`/calls/${featuredExample.callId}`, returnTo)}
                                        >
                                          {t('callAnalyzer.detail.patternCallsOpenCall', {
                                            defaultValue: 'Ver llamada',
                                          })}
                                        </Link>
                                      </Button>
                                    </div>
                                    <div className="space-y-1">
                                      <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">
                                        {featuredExample.observedFragment}
                                      </blockquote>
                                    </div>
                                    <div className="space-y-1">
                                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {t('callAnalyzer.detail.patternExampleWhyWrong', {
                                          defaultValue: 'Por qué está mal aquí',
                                        })}
                                      </p>
                                      <p className="text-sm text-muted-foreground">
                                        {featuredExample.whyItIsWrong}
                                      </p>
                                    </div>
                                    <div className="space-y-1">
                                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {t('callAnalyzer.detail.executionGuideSayThis', {
                                          defaultValue: 'Lo que debió decir el agente',
                                        })}
                                      </p>
                                      <p className="text-sm font-medium">
                                        {featuredExample.whatShouldHaveDone}
                                      </p>
                                    </div>
                                    {featuredExample.whyItHelps ? (
                                      <div className="space-y-1">
                                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                          {t('callAnalyzer.detail.patternExampleWhyHelps', {
                                            defaultValue: 'Por qué ayuda',
                                          })}
                                        </p>
                                        <p className="text-sm text-muted-foreground">
                                          {featuredExample.whyItHelps}
                                        </p>
                                      </div>
                                    ) : null}
                                  </div>
                                ) : visibleEvidence.length > 0 ? (
                                  <div className="space-y-2">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                      {t('callAnalyzer.detail.evidenceCompact', {
                                        defaultValue: 'Ejemplo real',
                                      })}
                                    </p>
                                    {visibleEvidence.map(/** Handles the callback for this operation. */(evidenceItem, evidenceIndex) => (
                                      <blockquote
                                        key={`${pattern.patternId}-evidence-${evidenceIndex}`}
                                        className="border-l-2 pl-3 text-sm text-muted-foreground"
                                      >
                                        {formatEvidenceSpeaker(evidenceItem, agentAnalysis.salesAgentName) ? (
                                          <span className="font-medium">
                                            {formatEvidenceSpeaker(evidenceItem, agentAnalysis.salesAgentName)}
                                            {': '}
                                          </span>
                                        ) : null}
                                        “{evidenceItem.quote}”
                                      </blockquote>
                                    ))}
                                  </div>
                                ) : null}

                                {pattern.examples.length > 0 ? (
                                  <>
                                    <div className="border-t pt-3">
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={/** Handles the onClick interaction. */ () =>
                                          setShowPatternExamples(/** Handles the callback for this operation. */(current) => ({
                                            ...current,
                                            [pattern.patternId]: !current[pattern.patternId],
                                          }))
                                        }
                                      >
                                        {showPatternExamples[pattern.patternId]
                                          ? t('callAnalyzer.detail.hidePatternExamples', {
                                            defaultValue: 'Ocultar explicación de ejemplos',
                                          })
                                          : t('callAnalyzer.detail.patternExamplesCta', {
                                            defaultValue:
                                              pattern.examples.length > 1
                                                ? 'Ver explicación de ejemplos ({{count}})'
                                                : 'Ver explicación de ejemplos',
                                            count: pattern.examples.length,
                                          })}
                                      </Button>
                                    </div>

                                    {showPatternExamples[pattern.patternId] ? (
                                      <PatternExamplesSection
                                        pattern={pattern}
                                        returnTo={location.pathname + location.search}
                                        callLabelById={linkedCallLabelById}
                                      />
                                    ) : null}
                                  </>
                                ) : null}
                              </>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {severityOrder
                      .filter(/** Handles the callback for this operation. */(severity) => Boolean(report.severityBins[severity]))
                      .map(/** Handles the callback for this operation. */(severity) => {
                        const severityBin = report.severityBins[severity];
                        if (!severityBin) {
                          return null;
                        }

                        return (
                          <div key={severity} className="rounded-lg border p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <h3 className="font-semibold">
                                  {t(`callDetail.${severity}`, { defaultValue: severity })}{' '}
                                  <span className="text-sm font-normal text-muted-foreground">
                                    ({severityBin.summaryDepth})
                                  </span>
                                </h3>
                                <p className="mt-2 text-sm text-muted-foreground">
                                  {severityBin.summarizedWeaknesses.length}{' '}
                                  {t('callAnalyzer.detail.summariesInBin')}
                                </p>
                              </div>

                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={/** Handles the onClick interaction. */ () => toggleSeverityBin(severity)}
                              >
                                {expandedBins[severity] ? (
                                  <ChevronUp className="mr-2 h-4 w-4" />
                                ) : (
                                  <ChevronDown className="mr-2 h-4 w-4" />
                                )}
                                {expandedBins[severity]
                                  ? t('callAnalyzer.detail.hideBin')
                                  : t('callAnalyzer.detail.showBin')}
                              </Button>
                            </div>

                            {expandedBins[severity] && (
                              <div className="mt-4 space-y-3">
                                {severityBin.summarizedWeaknesses.map(/** Handles the callback for this operation. */(weakness) => (
                                  <div key={weakness.summaryId} className="rounded-md bg-muted/30 p-3">
                                    <div className="space-y-1">
                                      <h4 className="font-medium">{weakness.critique.headline}</h4>
                                      <p className="text-sm text-muted-foreground">
                                        {weakness.critique.summary}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {t('callAnalyzer.detail.callCount', {
                                          calls: weakness.critique.affectedCallCount,
                                          occurrences: weakness.critique.occurrenceCount,
                                        })}
                                      </p>
                                    </div>

                                    {weakness.evidence.length > 0 && (
                                      <div className="mt-3 space-y-2">
                                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                          {t('callAnalyzer.detail.evidenceTitle')}
                                        </p>
                                        {weakness.evidence.map(/** Handles the callback for this operation. */(evidenceItem, index) => (
                                          <blockquote
                                            key={`${weakness.summaryId}-evidence-${index}`}
                                            className="border-l-2 pl-3 text-sm text-muted-foreground"
                                          >
                                            {evidenceItem.speakerDisplay || evidenceItem.speakerLabel ? (
                                              <span className="font-medium">
                                                {evidenceItem.speakerDisplay || evidenceItem.speakerLabel}
                                                {': '}
                                              </span>
                                            ) : null}
                                            “{evidenceItem.quote}”
                                          </blockquote>
                                        ))}
                                      </div>
                                    )}

                                    {weakness.mentorshipTips.length > 0 && (
                                      <div className="mt-3 space-y-2">
                                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                          {t('callAnalyzer.detail.mentorshipTitle')}
                                        </p>
                                        <ul className="list-disc pl-5 text-sm text-muted-foreground">
                                          {weakness.mentorshipTips.map(/** Handles the callback for this operation. */(tip, index) => (
                                            <li key={`${weakness.summaryId}-tip-${index}`}>
                                              {tip.tip}
                                            </li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                  </div>
                                ))}

                                {severityBin.overflowSummary && (
                                  <div className="rounded-md border border-dashed p-3">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                      {t('callAnalyzer.detail.overflowTitle')}
                                    </p>
                                    {severityBin.overflowSummary.critique ? (
                                      <p className="mt-2 text-sm text-muted-foreground">
                                        {severityBin.overflowSummary.critique}
                                      </p>
                                    ) : null}

                                    {severityBin.overflowSummary.evidence.length > 0 && (
                                      <div className="mt-3 space-y-2">
                                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                          {t('callAnalyzer.detail.evidenceTitle')}
                                        </p>
                                        {severityBin.overflowSummary.evidence.map(/** Handles the callback for this operation. */(evidenceItem, index) => (
                                          <blockquote
                                            key={`${severity}-overflow-evidence-${index}`}
                                            className="border-l-2 pl-3 text-sm text-muted-foreground"
                                          >
                                            “{evidenceItem.quote}”
                                          </blockquote>
                                        ))}
                                      </div>
                                    )}

                                    {severityBin.overflowSummary.mentorshipTips.length > 0 && (
                                      <div className="mt-3 space-y-2">
                                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                          {t('callAnalyzer.detail.mentorshipTitle')}
                                        </p>
                                        <ul className="list-disc pl-5 text-sm text-muted-foreground">
                                          {severityBin.overflowSummary.mentorshipTips.map(/** Handles the callback for this operation. */(tip, index) => (
                                            <li key={`${severity}-overflow-tip-${index}`}>{tip.tip}</li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('callAnalyzer.detail.noReportDescription')}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reminders" className="space-y-6">
          {agentKey ? (
            <AgentReminderView agentKey={agentKey} manualReminderContent={manualReminderBlock} />
          ) : (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">
                {t('callAnalyzer.detail.activityUnavailable', {
                  defaultValue: 'Los datos de actividad del agente no están disponibles en este espacio.',
                })}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="progress" className="space-y-6">
          {agentKey ? (
            <AgentProgressView agentKey={agentKey} />
          ) : (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">
                {t('callAnalyzer.detail.activityUnavailable', {
                  defaultValue: 'Los datos de actividad del agente no están disponibles en este espacio.',
                })}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(selectedPattern)} onOpenChange={/** Handles the onOpenChange interaction. */ (open) => !open && setSelectedPatternIdForCalls(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t('callAnalyzer.detail.patternCallsTitle', {
                defaultValue: 'Llamadas en este patrón',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('callAnalyzer.detail.patternCallsCount', {
                defaultValue: '{{count}} llamadas',
                count: selectedPatternCallRows.length,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {selectedPatternCallRows.map(/** Handles the callback for this operation. */(item) => (
              <div
                key={item.callId}
                className={cn(
                  'rounded-lg border border-l-4 p-3 space-y-2',
                  getCallCategoryClasses(item.category).row
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="flex items-center gap-2 font-medium">
                      <span
                        className={cn(
                          'h-2.5 w-2.5 rounded-full',
                          getCallCategoryClasses(item.category).dot
                        )}
                      />
                      {item.displayLabel}
                    </p>
                    {item.quote ? (
                      <p className="text-sm text-muted-foreground">
                        {item.speakerDisplay ? `${item.speakerDisplay}: ` : ''}
                        “{item.quote}”
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t('callAnalyzer.detail.patternCallsNoEvidence', {
                          defaultValue: 'Sin evidencia visible para esta llamada',
                        })}
                      </p>
                    )}
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link to={appendReturnTo(`/calls/${item.callId}`, returnTo)}>
                      {t('callAnalyzer.detail.patternCallsOpenCall', {
                        defaultValue: 'Ver llamada',
                      })}
                    </Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
