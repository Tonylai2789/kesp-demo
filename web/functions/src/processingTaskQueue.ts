import { getFunctions } from "firebase-admin/functions";

export interface TranscriptionTaskPayload {
  callId: string;
}

export interface TranscriptionChunkTaskPayload {
  callId: string;
  chunkIndex: number;
}

export interface SubagentAnalysisTaskPayload {
  callId: string;
  runId: string;
  taskId: string;
}

export interface ShortCallReviewTaskPayload {
  callId: string;
  runId: string;
  taskId: string;
}

export interface AgentAnalysisTaskPayload {
  agentAnalysisId: string;
  runId: string;
  taskId: string;
}

export interface AgentEmailReportTaskPayload {
  salesAgentId: string;
  reportType: "daily" | "weekly";
  periodKey: string;
  source: "scheduled";
  recipientMode?: "agent" | "global";
  globalRecipientId?: string;
  force?: boolean;
}

export interface PostCallEventDetectionTaskPayload {
  callId: string;
  runId: string;
  source: "automatic" | "backfill";
}

export const TRANSCRIPTION_TASK_FUNCTION = "processTranscriptionTask";
export const TRANSCRIPTION_CHUNK_TASK_FUNCTION = "processTranscriptionChunkTask";
export const SUBAGENT_ANALYSIS_TASK_FUNCTION = "processSubagentAnalysisTask";
export const SHORT_CALL_REVIEW_TASK_FUNCTION = "processShortCallReviewTask";
export const AGENT_ANALYSIS_TASK_FUNCTION = "processAgentAnalysisTask";
export const AGENT_EMAIL_REPORT_TASK_FUNCTION = "processAgentEmailReportTask";
export const POST_CALL_EVENT_DETECTION_TASK_FUNCTION = "processPostCallEventDetectionTask";

const DISPATCH_DEADLINE_SECONDS = 1800;

/** Enqueues one call-level transcription worker task. */
export async function enqueueTranscriptionTask(task: TranscriptionTaskPayload): Promise<void> {
  await getFunctions().taskQueue<TranscriptionTaskPayload>(TRANSCRIPTION_TASK_FUNCTION).enqueue(task, {
    dispatchDeadlineSeconds: DISPATCH_DEADLINE_SECONDS,
  });
}

/** Enqueues one audio chunk transcription worker task. */
export async function enqueueTranscriptionChunkTask(task: TranscriptionChunkTaskPayload): Promise<void> {
  await getFunctions().taskQueue<TranscriptionChunkTaskPayload>(TRANSCRIPTION_CHUNK_TASK_FUNCTION).enqueue(task, {
    dispatchDeadlineSeconds: DISPATCH_DEADLINE_SECONDS,
  });
}

/** Enqueues one per-call subagent analysis worker task. */
export async function enqueueSubagentAnalysisTask(task: SubagentAnalysisTaskPayload): Promise<void> {
  await getFunctions().taskQueue<SubagentAnalysisTaskPayload>(SUBAGENT_ANALYSIS_TASK_FUNCTION).enqueue(task, {
    dispatchDeadlineSeconds: DISPATCH_DEADLINE_SECONDS,
  });
}

/** Enqueues one short-call review worker task. */
export async function enqueueShortCallReviewTask(task: ShortCallReviewTaskPayload): Promise<void> {
  await getFunctions().taskQueue<ShortCallReviewTaskPayload>(SHORT_CALL_REVIEW_TASK_FUNCTION).enqueue(task, {
    dispatchDeadlineSeconds: DISPATCH_DEADLINE_SECONDS,
  });
}

/** Enqueues one aggregate agent-analysis worker task. */
export async function enqueueAgentAnalysisTask(task: AgentAnalysisTaskPayload): Promise<void> {
  await getFunctions().taskQueue<AgentAnalysisTaskPayload>(AGENT_ANALYSIS_TASK_FUNCTION).enqueue(task, {
    dispatchDeadlineSeconds: DISPATCH_DEADLINE_SECONDS,
  });
}

/** Enqueues one scheduled agent email report worker task. */
export async function enqueueAgentEmailReportTask(task: AgentEmailReportTaskPayload): Promise<void> {
  await getFunctions().taskQueue<AgentEmailReportTaskPayload>(AGENT_EMAIL_REPORT_TASK_FUNCTION).enqueue(task, {
    dispatchDeadlineSeconds: 540,
  });
}

/** Enqueues one post-call event detection worker task. */
export async function enqueuePostCallEventDetectionTask(task: PostCallEventDetectionTaskPayload): Promise<void> {
  await getFunctions().taskQueue<PostCallEventDetectionTaskPayload>(POST_CALL_EVENT_DETECTION_TASK_FUNCTION).enqueue(task, {
    dispatchDeadlineSeconds: DISPATCH_DEADLINE_SECONDS,
  });
}
