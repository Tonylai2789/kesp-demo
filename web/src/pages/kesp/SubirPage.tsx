import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/useAuth';
import { useDemoProcessingStatus } from '@/hooks/useDemoProcessingStatus';
import { DemoProcessingStatus } from '@/components/kesp/DemoProcessingStatus';
import { useTranscriptionUploadSelection } from '@/hooks/useTranscriptionUploadSelection';
import { TranscriptionUploadSelector } from '@/components/kesp/TranscriptionUploadSelector';
import { DEFAULT_TRANSCRIPTION_MODEL, transcriptionModelLabel } from '@/lib/transcriptionUpload';
import { maskKespDemoAgentDisplayName, maskKespDemoCallString } from '@/lib/kespDemoRedaction';
import { subscribeToAgentAnalyses } from '@/services/agentAnalyses';
import type { AgentAnalysis } from '@/types/agentAnalysis';
import { subscribeToCall } from '@/services/firestore';
import {
  uploadAudioFile,
  validateAudioFile,
  type UploadProgress,
} from '@/services/storage';
import {
  getAvailablePrompts,
  notifyUploadBatchCompleted,
  type AvailablePromptsResponse,
} from '@/services/functions';
import {
  loadKespUploadPromptSettings,
  validateKespUploadPromptSettings,
} from '@/lib/kespUploadPromptSettings';
import { Icon } from '@/components/kesp/icons';
import { UploadAnalyzerSettingsButton } from '@/components/kesp/AnalyzerSettingsButton';
import { Button, Pill } from '@/components/kesp/primitives';
import {
  KESP_GENERAL_AGENTS,
  KESP_NO_AGENT,
  useKespUploadDraft,
} from '@/components/kesp/KespUploadDraftContext';

/** Renders the SubirPage component. */
export function SubirPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const processing = useDemoProcessingStatus();
  const transcription = useTranscriptionUploadSelection();
  const [agentAnalyses, setAgentAnalyses] = useState<AgentAnalysis[]>([]);
  const { agentValue, setAgentValue, queue, enqueueFiles, updateQueueItem, removeFromQueue } =
    useKespUploadDraft();
  const [generalCallIds, setGeneralCallIds] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [availablePrompts, setAvailablePrompts] =
    useState<AvailablePromptsResponse | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return;
    return subscribeToAgentAnalyses(user.uid, setAgentAnalyses);
  }, [t, user?.uid]);

  const notifiedUnrecognizedRef = useRef<Set<string>>(new Set());

  useEffect(/** Handles the callback for this operation. */() => {
    if (generalCallIds.length === 0) return;
    const unsubscribers = generalCallIds.map(/** Handles the callback for this operation. */(callId) =>
      subscribeToCall(callId, /** Handles the callback for this operation. */(call) => {
        if (!call || call.agentRoutingStatus !== 'unrecognized') return;
        if (notifiedUnrecognizedRef.current.has(callId)) return;
        notifiedUnrecognizedRef.current.add(callId);
        toast.warning(t('kesp.upload.toasts.unrecognized'), {
          action: {
            label: t('kesp.upload.toasts.assignAction'),
            onClick: /** Handles the onClick interaction. */ () => navigate('/kesp/analizador/unrecognized'),
          },
        });
      })
    );
    return /** Handles the callback for this operation. */ () => {
      unsubscribers.forEach(/** Handles the callback for this operation. */(unsubscribe) => unsubscribe());
    };
  }, [generalCallIds, navigate, t]);

  useEffect(/** Handles the callback for this operation. */() => {
    let cancelled = false;
    getAvailablePrompts()
      .then(/** Handles the callback for this operation. */(data) => {
        if (!cancelled) setAvailablePrompts(data);
      })
      .catch(/** Handles the callback for this operation. */(err) => {
        console.error('Failed to fetch available prompts:', err);
      });
    return /** Handles the callback for this operation. */ () => {
      cancelled = true;
    };
  }, []);

  const selectedAgent = useMemo(/** Handles the callback for this operation. */() => {
    if (agentValue === KESP_NO_AGENT || agentValue === KESP_GENERAL_AGENTS) return null;
    return agentAnalyses.find(/** Handles the callback for this operation. */(a) => a.id === agentValue) ?? null;
  }, [agentValue, agentAnalyses]);

  const onPick = /** Handles the onPick interaction. */ (list: FileList | null) => {
    if (!list || transcription.loading || uploading || !processing.canStart) return;
    const validFiles: File[] = [];
    for (const file of Array.from(list)) {
      const validation = validateAudioFile(file);
      if (!validation.valid) {
        toast.error(t('kesp.upload.toasts.uploadError', { file: maskKespDemoCallString(file.name), error: validation.error }));
        continue;
      }
      validFiles.push(file);
    }
    enqueueFiles(validFiles, transcription.snapshot());
  };

  const start = /** Documents the start behavior. */ async () => {
    if (!user?.uid || queue.length === 0 || uploading || !processing.canStart) return;
    const pending = queue.filter(/** Handles the callback for this operation. */(q) => q.status === 'queued' || q.status === 'error');
    if (pending.length === 0) return;

    setUploading(true);
    const uploadBatchId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    let success = 0;
    let failed = 0;
    const uploadedCallIds: string[] = [];
    const uploadedCallNames: string[] = [];
    const uploadedGeneralCallIds: string[] = [];
    const agentRoutingMode =
      agentValue === KESP_GENERAL_AGENTS ? 'general' : selectedAgent ? 'specific' : 'none';

    const validatedOverrides = availablePrompts
      ? validateKespUploadPromptSettings(loadKespUploadPromptSettings(), availablePrompts)
      : {};

    for (const item of pending) {
      if (!(await processing.checkCanStart())) break;
      updateQueueItem(item.id, { status: 'uploading', progress: 0, error: undefined });
      try {
        const result = await uploadAudioFile({
          file: item.file,
          transcriptionModel: item.transcriptionModel,
          transcriptionComparison: item.transcriptionComparison,
          category: 'unknown',
          userId: user.uid,
          uploadBatchId,
          salesAgentId: agentRoutingMode === 'specific' ? selectedAgent?.salesAgentId : undefined,
          salesAgentName: agentRoutingMode === 'specific' ? selectedAgent?.salesAgentName : undefined,
          agentAnalysisId: agentRoutingMode === 'specific' ? selectedAgent?.id : undefined,
          agentRoutingMode,
          analyzerModel: validatedOverrides.analyzerModel,
          analyzerModelOverrides: validatedOverrides.analyzerModelOverrides,
          promptVersions: validatedOverrides.promptVersions,
          activityPromptVersions: validatedOverrides.activityPromptVersions,
          onProgress: /** Handles the onProgress interaction. */ (p: UploadProgress) => {
            updateQueueItem(item.id, { progress: p.progress });
          },
        });
        if (agentRoutingMode === 'general') {
          uploadedGeneralCallIds.push(result.callId);
        }
        uploadedCallIds.push(result.callId);
        uploadedCallNames.push(item.file.name);
        updateQueueItem(item.id, { status: 'uploaded', progress: 100 });
        success += 1;
      } catch (error) {
        console.error(`Failed to upload ${item.file.name}:`, error);
        updateQueueItem(item.id, {
          status: 'error',
          error: t('kesp.upload.toasts.genericUploadError'),
        });
        failed += 1;
      }
    }

    setUploading(false);
    if (uploadedGeneralCallIds.length > 0) {
      setGeneralCallIds(/** Handles the callback for this operation. */(prev) => [...prev, ...uploadedGeneralCallIds]);
    }
    if (uploadedCallIds.length > 0) {
      try {
        /** Calls an external SDK or API dependency. */
        await notifyUploadBatchCompleted({
          uploadBatchId,
          callIds: uploadedCallIds,
          callNames: uploadedCallNames.slice(0, 3),
        });
      } catch (error) {
        console.error('Failed to create upload batch inbox message:', error);
      }
    }
    if (success > 0) {
      toast.success(t('kesp.upload.toasts.success', { count: success }));
    }
    if (failed > 0) {
      toast.error(t('kesp.upload.toasts.failed', { count: failed }));
    }
  };

  const pendingCount = queue.filter(/** Handles the callback for this operation. */(q) => q.status === 'queued' || q.status === 'error').length;

  return (
    <main className="main" style={{ maxWidth: 760 }}>
      <DemoProcessingStatus />
      <div className="page-head">
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="eyebrow">{t('kesp.upload.eyebrow')}</div>
          <div className="row" style={{ gap: 8 }}>
          {queue.length === 0 ? <UploadAnalyzerSettingsButton catalog={availablePrompts} disabled={uploading} /> : null}
          <button
            type="button"
            className="nav-icon-btn"
            title={t('kesp.upload.promptSettings.open')}
            aria-label={t('kesp.upload.promptSettings.open')}
            onClick={/** Handles the onClick interaction. */ () => {
              if (uploading) return;
              navigate('/kesp/subir/prompts');
            }}
            disabled={uploading}
          >
            <Icon name="dots" size={16} />
          </button>
          </div>
        </div>
        <h1 className="page-title">
          {t('kesp.upload.titlePrefix')} <span className="italic">{t('kesp.upload.titleItalic')}</span>
        </h1>
        <p className="page-sub">
          {t('kesp.upload.subtitle')}
        </p>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <label className="field-label">{t('kesp.upload.agent.label')}</label>
        <select
          value={agentValue}
          onChange={/** Handles the onChange interaction. */ (e) => setAgentValue(e.target.value)}
          disabled={uploading}
        >
          <option value={KESP_NO_AGENT}>{t('kesp.upload.agent.none')}</option>
          <option value={KESP_GENERAL_AGENTS}>{t('kesp.upload.agent.auto')}</option>
          {agentAnalyses.map(/** Handles the callback for this operation. */(a) => (
            <option key={a.id} value={a.id}>
              {maskKespDemoAgentDisplayName(a.salesAgentName, a.salesAgentId)}
            </option>
          ))}
        </select>
        <div className="muted tiny" style={{ marginTop: 8 }}>
          {agentValue === KESP_GENERAL_AGENTS
            ? t('kesp.upload.agent.autoHelp')
            : agentAnalyses.length === 0
              ? t('kesp.upload.agent.noAgentsHelp')
              : t('kesp.upload.agent.specificHelp')}
        </div>
      </div>

      {transcription.canSelect && <TranscriptionUploadSelector
        model={transcription.model} comparison={transcription.comparison} canCompare={transcription.canCompare}
        onChange={transcription.onChange} disabled={uploading} />}

      <div
        className={'upload-zone' + (drag ? ' drag' : '')}
        aria-busy={transcription.loading}
        aria-disabled={!processing.canStart || uploading}
        onDragOver={/** Handles the onDragOver interaction. */ (e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={/** Handles the onDragLeave interaction. */ () => setDrag(false)}
        onDrop={/** Handles the onDrop interaction. */ (e) => {
          e.preventDefault();
          setDrag(false);
          onPick(e.dataTransfer.files);
        }}
        onClick={/** Wait for TEST selector privileges before choosing new files. */ () => {
          if (!transcription.loading && !uploading && processing.canStart) fileRef.current?.click();
        }}
      >
        <Icon name="upload" size={36} />
        <div className="help" style={{ marginTop: 14 }}>
          {t('kesp.upload.zone.help')}
        </div>
        <div className="sub">{t('kesp.upload.zone.sub')}</div>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="audio/*"
          hidden
          disabled={transcription.loading || uploading || !processing.canStart}
          onChange={/** Handles the onChange interaction. */ (e) => {
            const picked = e.currentTarget.files;
            onPick(picked);
            e.currentTarget.value = '';
          }}
        />
      </div>

      {queue.length > 0 && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="row row-between row-wrap" style={{ marginBottom: 14, gap: 8 }}>
            <h3 className="card-h">{t('kesp.upload.queue.title', { count: queue.length })}</h3>
            <div className="row" style={{ gap: 8 }}>
            <UploadAnalyzerSettingsButton catalog={availablePrompts} disabled={uploading} />
            <Button
              kind="primary"
              size="sm"
              icon={<Icon name="bulb" size={13} />}
              onClick={start}
              disabled={uploading || pendingCount === 0 || !user?.uid || !processing.canStart}
            >
              {uploading ? t('kesp.upload.queue.uploading') : t('kesp.upload.queue.button')}
            </Button>
            </div>
          </div>
          {queue.map(/** Handles the callback for this operation. */(q, i) => (
            <div
              key={q.id}
              className="row"
              style={{
                padding: '10px 0',
                borderBottom: i < queue.length - 1 ? '1px solid var(--line)' : '0',
                gap: 12,
              }}
            >
              <Icon name="file" size={16} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {maskKespDemoCallString(q.file.name)}
                </div>
                <div className="muted tiny">
                  {(q.file.size / 1024 / 1024).toFixed(2)} MB
                  {q.error ? ` · ${q.error}` : ''}
                </div>
                {q.transcriptionModel && <div className="muted tiny" style={{ overflowWrap: 'anywhere' }}>
                  {transcriptionModelLabel(q.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL)}
                  {q.transcriptionComparison ? ` / ${t('kesp.transcriptionUpload.comparison')}` : ''}
                </div>}
                <div className="progress-track" style={{ marginTop: 6 }}>
                  <div className="progress-fill" style={{ width: q.progress + '%' }} />
                </div>
              </div>
              {q.status === 'uploaded' ? (
                <Pill kind="good" icon={<Icon name="check" size={11} />}>
                  {t('kesp.upload.queue.uploaded')}
                </Pill>
              ) : q.status === 'uploading' ? (
                <Pill kind="info">{Math.round(q.progress)}%</Pill>
              ) : q.status === 'error' ? (
                <Pill kind="bad" icon={<Icon name="x" size={11} />}>
                  {t('kesp.upload.queue.error')}
                </Pill>
              ) : (
                <Pill kind="default">{t('kesp.upload.queue.queued')}</Pill>
              )}
              {!uploading && q.status !== 'uploading' && (
                <button
                  type="button"
                  className="nav-icon-btn"
                  title={t('kesp.common.removeFromQueue')}
                  aria-label={t('kesp.common.removeFromQueue')}
                  onClick={/** Handles the onClick interaction. */ () => removeFromQueue(q.id)}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
