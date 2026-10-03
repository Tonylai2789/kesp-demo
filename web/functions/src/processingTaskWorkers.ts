import { onTaskDispatched } from "firebase-functions/v2/tasks";
import * as admin from "firebase-admin";
import { getFunctions } from "firebase-admin/functions";
import { FieldValue } from "firebase-admin/firestore";
import { getProcessingGeneration } from "./callState";
import { performTranscription, transcribeChunk } from "./transcribe";
import { runSubagentTask } from "./analysisSubagents";
import { runManualShortCallReviewTask } from "./manualShortCallReview";
import { runAgentAnalysisTask } from "./agentAnalyses";
import { OPENAI_API_KEY_SECRET } from "./secrets";
import { transcriptionWorkerSecrets } from "./transcriptionSecretBinding";
import { CONVERSATION_METRICS_TASK_OPTIONS, runConversationMetricsAnalysisTask } from "./conversationMetricsAnalysis";
import {
  type AgentAnalysisTaskPayload,
  type ShortCallReviewTaskPayload,
  type SubagentAnalysisTaskPayload,
  type TranscriptionChunkTaskPayload,
  type TranscriptionTaskPayload,
} from "./processingTaskQueue";

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

const TASK_RETRY_CONFIG = {
  maxAttempts: 3,
  minBackoffSeconds: 10,
  maxBackoffSeconds: 120,
};

const WORKER_RUNTIME = {
  timeoutSeconds: 1800,
  memory: "2GiB" as const,
  cpu: 1,
  maxInstances: 2,
  secrets: [OPENAI_API_KEY_SECRET],
};

export const DEMO_MAX_ADMISSION_WAITS = 60;
export interface DemoTranscriptionTaskPayload extends TranscriptionTaskPayload {
  demoAdmissionWait?: number;
  demoAdmissionGeneration?: number;
}

/** Capacity waits do not consume paid retry attempts and never expire another call's slot. */
export function nextDemoAdmissionWait(wait: unknown): number | null {
  const current = wait ?? 0;
  if (!Number.isInteger(current) || Number(current) < 0 || Number(current) >= DEMO_MAX_ADMISSION_WAITS) return null;
  return Number(current) + 1;
}

async function markDemoAdmissionError(callId: string, generation: number, code: string): Promise<void> {
  const ref = db.collection("calls").doc(callId);
  await db.runTransaction(async (transaction) => {
    const call = await transaction.get(ref);
    const data = call.data();
    if (!data || getProcessingGeneration(data) !== generation || !["uploaded", "transcribing"].includes(data.status)) return;
    transaction.update(ref, {
      status: "error", errorSource: "transcription", errorCode: code, retryable: false,
      error: code === "demo_admission_wait_exhausted"
        ? "Demo processing capacity remained busy for one hour. Upload again after active calls finish."
        : "Demo admission failed before transcription. Ask the operator to restore the demo budget or queue configuration, then upload again.",
      statusReason: code, updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

export async function handleDemoTranscriptionTask(payload: DemoTranscriptionTaskPayload): Promise<void> {
  const callId = payload.callId;
  const ref = db.collection("calls").doc(callId);
  const snapshot = await ref.get();
  const data = snapshot.data();
  if (!data?.audioPath || !["uploaded", "transcribing"].includes(data.status)) return;
  const generation = getProcessingGeneration(data);
  if (payload.demoAdmissionGeneration !== undefined && payload.demoAdmissionGeneration !== generation) return;
  if (data.demoAdmissionGeneration === generation && (payload.demoAdmissionWait ?? 0) < (data.demoAdmissionWaitCount ?? 0)) return;
  try {
    await performTranscription(callId);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "stale_generation") return;
    if (code !== "demo_concurrency_limit") {
      // performTranscription records paid failures itself; this catches pre-provider admission failures.
      await markDemoAdmissionError(callId, generation, code?.startsWith("demo_") ? code : "demo_admission_failed");
      return;
    }
    const nextWait = nextDemoAdmissionWait(payload.demoAdmissionWait);
    if (nextWait === null) {
      await markDemoAdmissionError(callId, generation, "demo_admission_wait_exhausted");
      return;
    }
    const next: DemoTranscriptionTaskPayload = { callId, demoAdmissionWait: nextWait, demoAdmissionGeneration: generation };
    try {
      await getFunctions().taskQueue<DemoTranscriptionTaskPayload>("processTranscriptionTask").enqueue(next, {
        id: "demo-admit-" + callId + "-" + generation + "-" + nextWait,
        scheduleDelaySeconds: 60, dispatchDeadlineSeconds: 1800,
      });
    } catch (enqueueError) {
      const enqueueCode = (enqueueError as { code?: string | number })?.code;
      if (enqueueCode !== "functions/task-already-exists" && enqueueCode !== "already-exists" && enqueueCode !== 6) {
        await markDemoAdmissionError(callId, generation, "demo_admission_enqueue_failed");
        return;
      }
    }
    // Enqueue first: a process crash cannot leave a persisted wait counter with no task behind it.
    await db.runTransaction(async (transaction) => {
      const call = await transaction.get(ref);
      const current = call.data();
      if (!current || getProcessingGeneration(current) !== generation || !["uploaded", "transcribing"].includes(current.status)) return;
      if (current.demoAdmissionGeneration === generation && (current.demoAdmissionWaitCount ?? 0) > nextWait) return;
      transaction.update(ref, { demoAdmissionGeneration: generation, demoAdmissionWaitCount: nextWait,
        statusReason: "demo_waiting_for_capacity", updatedAt: FieldValue.serverTimestamp() });
    });
  }
}

export const processTranscriptionTask = onTaskDispatched<DemoTranscriptionTaskPayload>(
  {
    retryConfig: TASK_RETRY_CONFIG,
    rateLimits: {
      maxConcurrentDispatches: 2,
      maxDispatchesPerSecond: 1,
    },
    ...WORKER_RUNTIME,
    // Bind only the isolated demo's configured transcription providers.
    secrets: transcriptionWorkerSecrets(),
  },
  /** Handles one queued call-level transcription attempt. */
  async (request) => {
    await handleDemoTranscriptionTask(request.data);
  }
);

export const processConversationMetricsTask = onTaskDispatched(
  {
    ...CONVERSATION_METRICS_TASK_OPTIONS,
    maxInstances: 2,
    rateLimits: { maxConcurrentDispatches: 2, maxDispatchesPerSecond: 1 },
  },
  /** Interprets validated metrics independently of the required rubric tasks. */
  async (request) => runConversationMetricsAnalysisTask(request.data)
);

export const processTranscriptionChunkTask = onTaskDispatched<TranscriptionChunkTaskPayload>(
  {
    retryConfig: TASK_RETRY_CONFIG,
    rateLimits: {
      maxConcurrentDispatches: 2,
      maxDispatchesPerSecond: 2,
    },
    ...WORKER_RUNTIME,
  },
  /** Handles one queued audio chunk transcription attempt. */
  async (request) => {
    await transcribeChunk(request.data.callId, request.data.chunkIndex);
  }
);

export const processSubagentAnalysisTask = onTaskDispatched<SubagentAnalysisTaskPayload>(
  {
    retryConfig: TASK_RETRY_CONFIG,
    rateLimits: {
      maxConcurrentDispatches: 2,
      maxDispatchesPerSecond: 2,
    },
    ...WORKER_RUNTIME,
  },
  /** Handles one queued per-call subagent analysis attempt. */
  async (request) => {
    await runSubagentTask(request.data.callId, request.data.runId, request.data.taskId);
  }
);

export const processShortCallReviewTask = onTaskDispatched<ShortCallReviewTaskPayload>(
  {
    retryConfig: TASK_RETRY_CONFIG,
    rateLimits: {
      maxConcurrentDispatches: 2,
      maxDispatchesPerSecond: 1,
    },
    ...WORKER_RUNTIME,
  },
  /** Handles one queued short-call review task attempt. */
  async (request) => {
    await runManualShortCallReviewTask(request.data.callId, request.data.runId, request.data.taskId);
  }
);

export const processAgentAnalysisTask = onTaskDispatched<AgentAnalysisTaskPayload>(
  {
    retryConfig: TASK_RETRY_CONFIG,
    rateLimits: {
      maxConcurrentDispatches: 2,
      maxDispatchesPerSecond: 1,
    },
    ...WORKER_RUNTIME,
  },
  /** Handles one queued aggregate agent-analysis task attempt. */
  async (request) => {
    await runAgentAnalysisTask(request.data.agentAnalysisId, request.data.runId, request.data.taskId);
  }
);
