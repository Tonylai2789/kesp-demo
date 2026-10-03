import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import * as admin from 'firebase-admin';
import { getFunctions } from 'firebase-admin/functions';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { dispatchSubagentTasks } from './analysisSubagents';
import {
  MANUAL_SHORT_CALL_ANALYSIS_PIPELINE,
  dispatchManualShortCallReview,
} from './manualShortCallReview';
import { dispatchAgentAnalysisRun } from './agentAnalyses';
import { OPENAI_API_KEY_SECRET } from './secrets';
import { requireAnalyzerModel, validateAnalyzerModelOverrides } from './promptConfig';
import { serializeCallError } from './analysisErrors';
import { buildCallErrorUpdate, getProcessingGeneration } from './callState';
import { acquireDemoCallSlot, releaseDemoCallSlot } from './demoBudget';
import { isLegacyTestCallCategory } from './callCategory';
import { finalizePreparedTranscriptionUpload, PreparedUploadRejection } from './preparedTranscriptionUpload';
import {
  buildPausedCallUpdate,
  shouldHoldAutomaticCccCall,
} from './cccPipelinePause';
import {
  markAutomaticRuntimeRetryComplete,
  recordRuntimeFailureForDelayedRetry,
} from './runtimeRetry';
import { DEMO_BUCKET, isDemoManualCall } from './demoConfig';
import {
  enqueueAgentAnalysisTask,
  enqueueShortCallReviewTask,
  enqueueSubagentAnalysisTask,
  enqueueTranscriptionChunkTask,
} from './processingTaskQueue';

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

/** Redelivery uses the same queue identity and the worker's existing generation guard. */
async function enqueueDemoTranscription(callId: string, generation: number): Promise<void> {
  const current = (await db.collection('calls').doc(callId).get()).data();
  if (!isDemoManualCall(current) || current?.status !== 'uploaded' ||
      getProcessingGeneration(current) !== generation || !current.audioPath) return;
  try {
    await getFunctions().taskQueue('processTranscriptionTask').enqueue({ callId, demoAdmissionGeneration: generation }, {
      id: 'demo-transcribe-' + callId + '-' + generation,
      dispatchDeadlineSeconds: 1800,
    });
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code !== 'functions/task-already-exists' && code !== 'already-exists' && code !== 6) throw error;
  }
}

/** Serialize dispatch per generation; ambiguous interrupted dispatch must not repeat paid work. */
async function claimDemoAnalysisDispatch(callId: string, generation: number): Promise<boolean> {
  const ref = db.collection('calls').doc(callId);
  return db.runTransaction(async (transaction) => {
    const current = (await transaction.get(ref)).data();
    if (!isDemoManualCall(current) || current?.status !== 'analyzing' || getProcessingGeneration(current) !== generation) return false;
    const claim = current.demoAnalysisDispatch;
    if (claim?.generation === generation) {
      if (claim.status === 'complete') return false;
      // Longer than this function's 540-second deadline: no live owner can be displaced.
      if (claim.claimedAt instanceof Timestamp && Date.now() - claim.claimedAt.toMillis() < 600_000) {
        throw Object.assign(new Error('Demo analysis dispatch is already in progress'), { code: 'demo_analysis_dispatch_busy' });
      }
      throw Object.assign(new Error('Demo analysis dispatch was interrupted; explicit recovery is required'), {
        code: 'demo_analysis_dispatch_interrupted', status: 503,
      });
    }
    transaction.update(ref, { demoAnalysisDispatch: { generation, status: 'running', claimedAt: Timestamp.now() } });
    return true;
  });
}

/** Finish the claim without overwriting cancellation or a newer processing generation. */
async function completeDemoAnalysisDispatch(callId: string, generation: number): Promise<void> {
  const ref = db.collection('calls').doc(callId);
  await db.runTransaction(async (transaction) => {
    const current = (await transaction.get(ref)).data();
    if (getProcessingGeneration(current) !== generation || current?.demoAnalysisDispatch?.generation !== generation) return;
    transaction.update(ref, { 'demoAnalysisDispatch.status': 'complete' });
  });
}

/** Validates upload model metadata before creating any call document. */
export function parseUploadAnalyzerSettings(metadata?: Record<string, string | undefined>) {
  return {
    ...(metadata?.analyzerModel !== undefined ? { analyzerModel: requireAnalyzerModel(metadata.analyzerModel) } : {}),
    analyzerModelOverrides: validateAnalyzerModelOverrides(metadata?.analyzerModelOverrides === undefined
      ? undefined : JSON.parse(metadata.analyzerModelOverrides)),
  };
}

// Shared routing also serves backend-prepared uploads.

/** Documents the buildAiAgentUploadFields behavior. */
export function buildAiAgentUploadFields(
  customMetadata: Record<string, string> | undefined
): { aiAgentUpload?: true } {
  return customMetadata?.aiAgentUpload === 'true' ? { aiAgentUpload: true } : {};
}

/** Documents the normalizeStorageAudioCategory behavior. */
export function normalizeStorageAudioCategory(rawCategory: string): {
  storedCategory: 'good' | 'medium' | 'bad' | 'unknown';
  isCompatibilityTestCategory: boolean;
} | null {
  if (isLegacyTestCallCategory(rawCategory)) {
    return {
      storedCategory: 'unknown',
      isCompatibilityTestCategory: true,
    };
  }

  if (rawCategory === 'good' || rawCategory === 'medium' || rawCategory === 'bad' || rawCategory === 'unknown') {
    return {
      storedCategory: rawCategory,
      isCompatibilityTestCategory: false,
    };
  }

  return null;
}

/**
 * Triggered when an audio file is uploaded to Firebase Storage.
 * Creates the corresponding Firestore document.
 */
export const onAudioUpload = onObjectFinalized({ retry: true }, async (event) => {
  if (event.data.bucket !== DEMO_BUCKET || !event.data.name?.startsWith('prepared-uploads/')) return;
  try {
    await finalizePreparedTranscriptionUpload(event.data);
  } catch (error) {
    if (!(error instanceof PreparedUploadRejection)) throw error;
    console.warn('Prepared demo upload rejected:', error.code);
  }
});

/**
 * Triggered when a call document is updated.
 * Automatically starts analysis when status changes to 'analyzing'.
 * Also handles re-transcription when status resets to 'uploaded'.
 */
export const onStartAnalyzing = onDocumentUpdated(
  {
    document: 'calls/{callId}',
    retry: true,
    timeoutSeconds: 540,
    memory: '512MiB',
    cpu: 1,
    concurrency: 10,
  },
  /** Handles the callback for this operation. */
  async (event) => {
    const beforeData = event.data?.before.data();
    const afterData = event.data?.after.data();

    if (!beforeData || !afterData) {
      console.log('No data in event');
      return null;
    }

    const callId = event.params.callId;
    if (!isDemoManualCall(afterData)) return null;
    const beforeStatus = beforeData.status;
    const afterStatus = afterData.status;

    if (['complete', 'error', 'canceled', 'deleted'].includes(afterStatus)) {
      await releaseDemoCallSlot(callId, getProcessingGeneration(afterData), db);
      if (getProcessingGeneration(beforeData) !== getProcessingGeneration(afterData)) {
        await releaseDemoCallSlot(callId, getProcessingGeneration(beforeData), db);
      }
    }

    const holdWasReleased = beforeData.pipelineHoldState === 'paused' && afterData.pipelineHoldState !== 'paused';
    if (((beforeStatus !== 'uploaded' && afterStatus === 'uploaded') || holdWasReleased) && afterData.audioPath) {
      if (await shouldHoldAutomaticCccCall(db, afterData)) {
        await db.collection('calls').doc(callId).update(buildPausedCallUpdate());
        console.log('Holding queued automatic CCC call while pipeline is paused: ' + callId);
        return null;
      }
      await enqueueDemoTranscription(callId, getProcessingGeneration(afterData));
      console.log('Queued transcription task for call: ' + callId);
      return null;
    }

    if (beforeStatus !== 'analyzing' && afterStatus === 'analyzing') {
      console.log("Status changed to 'analyzing' for call: " + callId);

      try {
        if (!(await claimDemoAnalysisDispatch(callId, getProcessingGeneration(afterData)))) return null;
        await acquireDemoCallSlot(callId, getProcessingGeneration(afterData), db);
        if (afterData.analysisPipeline === MANUAL_SHORT_CALL_ANALYSIS_PIPELINE) {
          await dispatchManualShortCallReview(callId);
          console.log('Manual short-call review tasks dispatched for call: ' + callId);
        } else {
          await dispatchSubagentTasks(callId);
          console.log('Subagent tasks dispatched for call: ' + callId);
        }
        await completeDemoAnalysisDispatch(callId, getProcessingGeneration(afterData));
      } catch (error: any) {
        if (error?.code === 'demo_analysis_dispatch_busy') throw error;
        if (error?.code === 'stale_generation') return null;
        console.error('Analysis dispatch failed for call ' + callId + ':', error);

        try {
          /** Calls Firebase Firestore to read or write persisted application data. */
          const callRef = db.collection('calls').doc(callId);
          const serializedError = serializeCallError(error, 'analysis_dispatch');
          const recorded = await db.runTransaction(async (transaction) => {
            const currentData = (await transaction.get(callRef)).data();
            if (currentData?.status !== 'analyzing' || getProcessingGeneration(currentData) !== getProcessingGeneration(afterData)) return false;
            transaction.update(callRef, {
              status: 'error',
              activeAnalysisRunId: FieldValue.delete(),
              analysisCompletedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
              ...buildCallErrorUpdate(serializedError),
            });
            return true;
          });
          if (recorded) {
            await recordRuntimeFailureForDelayedRetry({ callRef, stage: 'analysis', error: serializedError });
            console.log('Fallback: Updated call ' + callId + " status to 'error'");
          }
        } catch (fallbackError) {
          console.error('Fallback error handling failed for ' + callId + ':', fallbackError);
          throw fallbackError;
        }
      }
    }

    if (beforeStatus !== 'complete' && afterStatus === 'complete') {
      console.log('Call processing complete: ' + callId);
      await markAutomaticRuntimeRetryComplete(db.collection('calls').doc(callId), afterData);
    }

    return null;
  }
);

/**
 * Triggered when a chunk document is created in calls/{callId}/chunks/{chunkIndex}.
 * Enqueues the queued worker that performs one chunk transcription attempt.
 */
export const onChunkReady = onDocumentCreated(
  {
    document: 'calls/{callId}/chunks/{chunkIndex}',
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  /** Handles the callback for this operation. */
  async (event) => {
    const callId = event.params.callId;
    const chunkIndex = parseInt(event.params.chunkIndex, 10);
    await enqueueTranscriptionChunkTask({ callId, chunkIndex });
    console.log('Queued transcription chunk task: ' + callId + '/' + chunkIndex);
    return null;
  }
);

/**
 * Triggered when a short-call review task document is created.
 * Enqueues the queued worker that performs one short-call LLM task.
 */
export const onShortCallReviewTaskCreated = onDocumentCreated(
  {
    document: 'calls/{callId}/short_call_review_runs/{runId}/tasks/{taskId}',
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  /** Handles the callback for this operation. */
  async (event) => {
    const { callId, runId, taskId } = event.params;
    await enqueueShortCallReviewTask({ callId, runId, taskId });
    console.log('Queued short-call review task: ' + callId + '/' + runId + '/' + taskId);
    return null;
  }
);

export const onSubagentTaskCreated = onDocumentCreated(
  {
    document: 'calls/{callId}/analysis_runs/{runId}/tasks/{taskId}',
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  /** Handles the callback for this operation. */
  async (event) => {
    const { callId, runId, taskId } = event.params;
    await enqueueSubagentAnalysisTask({ callId, runId, taskId });
    console.log('Queued subagent analysis task: ' + callId + '/' + runId + '/' + taskId);
    return null;
  }
);

/**
 * Triggered when an agent-analysis document is updated to status analyzing.
 * Creates a new aggregate run and dispatches behavior-pattern task docs.
 */
export const onAgentAnalysisStart = onDocumentUpdated(
  {
    document: 'agent_analyses/{agentAnalysisId}',
    timeoutSeconds: 540,
    memory: '2GiB',
    cpu: 1,
    concurrency: 1,
    secrets: [OPENAI_API_KEY_SECRET],
  },
  /** Handles the callback for this operation. */
  async (event) => {
    const beforeData = event.data?.before.data();
    const afterData = event.data?.after.data();

    if (!beforeData || !afterData) {
      console.log('No data in agent analysis update event');
      return null;
    }

    const { agentAnalysisId } = event.params;
    const beforeStatus = beforeData.status;
    const afterStatus = afterData.status;

    if (beforeStatus !== 'analyzing' && afterStatus === 'analyzing') {
      console.log('Agent analysis ' + agentAnalysisId + ' changed to analyzing');

      try {
        await dispatchAgentAnalysisRun(agentAnalysisId);
        console.log('Agent analysis run dispatched for ' + agentAnalysisId);
      } catch (error: any) {
        console.error('Agent analysis dispatch failed for ' + agentAnalysisId + ':', error);

        try {
          /** Calls Firebase Firestore to read or write persisted application data. */
          const agentAnalysisRef = db.collection('agent_analyses').doc(agentAnalysisId);
          /** Calls Firebase Firestore to persist aggregate analysis dispatch failure state. */
          await agentAnalysisRef.update({
            status: 'error',
            activeRunId: FieldValue.delete(),
            error: error.message || 'Agent analysis dispatch failed',
            updatedAt: FieldValue.serverTimestamp(),
          });
        } catch (fallbackError) {
          console.error('Fallback agent analysis error handling failed for ' + agentAnalysisId + ':', fallbackError);
        }
      }
    }

    return null;
  }
);

/**
 * Triggered when an aggregate agent-analysis task doc is created.
 * Enqueues the queued worker that performs one aggregate analyzer task.
 */
export const onAgentAnalysisTaskCreated = onDocumentCreated(
  {
    document: 'agent_analyses/{agentAnalysisId}/analysis_runs/{runId}/tasks/{taskId}',
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  /** Handles the callback for this operation. */
  async (event) => {
    const { agentAnalysisId, runId, taskId } = event.params;
    await enqueueAgentAnalysisTask({ agentAnalysisId, runId, taskId });
    console.log('Queued agent-analysis task: ' + agentAnalysisId + '/' + runId + '/' + taskId);
    return null;
  }
);

/**
 * Triggered when a call document is created.
 * Queues transcription for newly uploaded calls.
 */
export const onCallCreated = onDocumentCreated(
  {
    document: 'calls/{callId}',
    retry: true,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  /** Handles the callback for this operation. */
  async (event) => {
    const data = event.data?.data();
    const callId = event.params.callId;

    if (!data) {
      console.log('No data in event for call:', callId);
      return null;
    }

    if (!isDemoManualCall(data) || data.status !== 'uploaded' || !data.audioPath) {
      console.log('Skipping call ' + callId + ': status=' + data.status + ', audioPath=' + data.audioPath);
      return null;
    }

    if (await shouldHoldAutomaticCccCall(db, data)) {
      await db.collection('calls').doc(callId).update(buildPausedCallUpdate());
      console.log('Holding new automatic CCC call while pipeline is paused: ' + callId);
      return null;
    }

    await enqueueDemoTranscription(callId, getProcessingGeneration(data));
    console.log('Queued transcription task for new call: ' + callId);
    return null;
  }
);
