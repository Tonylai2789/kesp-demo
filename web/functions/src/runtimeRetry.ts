import { isDemoManualCall } from "./demoConfig";
import { DEMO_BUDGET_PATH, DEMO_MAX_ACTIVE_CALLS, readDemoBudget, admitDemoReservation } from "./demoBudget";
import { FieldValue } from "firebase-admin/firestore";
import type { DocumentData, DocumentReference, Transaction } from "firebase-admin/firestore";
import { CONSUBANCO_ORGANIZATION_ID } from "./callIdentity";
import { buildClearCallErrorUpdate, getProcessingGeneration } from "./callState";
import type { CallErrorSource, SerializedCallError } from "./analysisErrors";

export const MAX_AUTOMATIC_RUNTIME_RETRIES = 2;

export type RuntimeRetryStage = "analysis" | "transcription";
export type RuntimeRetryState = "eligible" | "not_retryable" | "exhausted" | "running" | "complete";
export type RuntimeRetrySource = "scheduled_sweep" | "manual_admin";

const RETRYABLE_CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const ANALYSIS_RETRY_SOURCES = new Set([
  "analysis_dispatch",
  "analysis_task",
  "analysis_finalizer",
]);

function errorMessage(error: SerializedCallError): string {
  return typeof error.message === "string" && error.message.trim().length > 0 ? error.message : "Runtime processing failed";
}

export function automaticRetryCount(data: DocumentData, stage: RuntimeRetryStage): number {
  const counts = data.automaticRetryCounts;
  if (!counts || typeof counts !== "object") return 0;
  const count = (counts as Record<string, unknown>)[stage];
  return Number.isInteger(count) && (count as number) > 0 ? count as number : 0;
}

export function runtimeRetryStageFromErrorSource(errorSource?: unknown): RuntimeRetryStage | null {
  if (typeof errorSource !== "string") return null;
  if (errorSource === "transcription") return "transcription";
  if (ANALYSIS_RETRY_SOURCES.has(errorSource)) return "analysis";
  return null;
}

export function isConnectionRetryableTranscriptionError(error: SerializedCallError): boolean {
  if (!error.retryable) return false;
  if (error.errorCode === "insufficient_quota" || error.errorType === "insufficient_quota") return false;
  if (typeof error.errorStatus === "number") {
    return error.errorStatus === 502 || error.errorStatus === 503 || error.errorStatus === 504;
  }
  const code = typeof error.errorCode === "string" ? error.errorCode.toUpperCase() : "";
  if (RETRYABLE_CONNECTION_ERROR_CODES.has(code)) return true;
  const message = errorMessage(error).toLowerCase();
  return message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("connection error") ||
    message.includes("connection reset") ||
    message.includes("socket hang up");
}

export function shouldRetryRuntimeError(stage: RuntimeRetryStage, error: SerializedCallError): boolean {
  if (error.errorCode === "stale_generation") return false;
  if (error.errorCode?.startsWith('demo_') || error.errorCode === 'insufficient_quota') return false;
  if (stage === "transcription") return isConnectionRetryableTranscriptionError(error);
  return ANALYSIS_RETRY_SOURCES.has(error.errorSource);
}

function serializedRuntimeError(error: SerializedCallError, failedRunId?: string | null): Record<string, unknown> {
  return {
    message: errorMessage(error),
    errorSource: error.errorSource,
    errorCode: error.errorCode ?? null,
    errorType: error.errorType ?? null,
    errorStatus: error.errorStatus ?? null,
    retryable: error.retryable,
    failedRunId: failedRunId ?? null,
  };
}

export interface RecordRuntimeFailureForDelayedRetryInput {
  callRef: DocumentReference;
  stage: RuntimeRetryStage;
  error: SerializedCallError;
  failedRunId?: string | null;
}

export interface RecordRuntimeFailureForDelayedRetryResult {
  retried: false;
  retryCount: number;
  exhausted: boolean;
  eligible: boolean;
  state: RuntimeRetryState;
}

export async function recordRuntimeFailureForDelayedRetry(
  input: RecordRuntimeFailureForDelayedRetryInput
): Promise<RecordRuntimeFailureForDelayedRetryResult> {
  const callDoc = await input.callRef.get();
  const callData = callDoc.data() ?? {};
  const currentCount = automaticRetryCount(callData, input.stage);
  const exhausted = currentCount >= MAX_AUTOMATIC_RUNTIME_RETRIES;
  const retryable = shouldRetryRuntimeError(input.stage, input.error);
  const state: RuntimeRetryState = exhausted ? "exhausted" : retryable ? "eligible" : "not_retryable";
  const update: Record<string, unknown> = {
    automaticRetryStage: input.stage,
    automaticRetryState: state,
    automaticRetryEligible: state === "eligible",
    automaticRetryRecordedAt: FieldValue.serverTimestamp(),
    lastAutomaticRetryReason: errorMessage(input.error),
    lastFailedRuntimeError: serializedRuntimeError(input.error, input.failedRunId),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (state === "exhausted") {
    update.automaticRetryExhaustedAt = FieldValue.serverTimestamp();
  } else {
    update.automaticRetryExhaustedAt = FieldValue.delete();
  }

  await input.callRef.update(update);
  console.log(`Recorded delayed ${input.stage} retry state ${state} for ${input.callRef.id}`);
  return { retried: false, retryCount: currentCount, exhausted, eligible: state === "eligible", state };
}

export type ScheduleAutomaticRuntimeRetryInput = RecordRuntimeFailureForDelayedRetryInput;
export type ScheduleAutomaticRuntimeRetryResult = RecordRuntimeFailureForDelayedRetryResult;

export async function scheduleAutomaticRuntimeRetry(
  input: ScheduleAutomaticRuntimeRetryInput
): Promise<ScheduleAutomaticRuntimeRetryResult> {
  return recordRuntimeFailureForDelayedRetry(input);
}

export interface RequeueRuntimeFailureInput {
  callRef: DocumentReference;
  stage?: RuntimeRetryStage | null;
  source: RuntimeRetrySource;
  requestedBy?: string | null;
}

export interface RequeueRuntimeFailureResult {
  queued: boolean;
  callId: string;
  stage?: RuntimeRetryStage;
  retryCount?: number;
  skippedReason?: string;
}

function isCccRuntimeCall(data: DocumentData): boolean {
  return data.organizationId === CONSUBANCO_ORGANIZATION_ID &&
    data.visibilityScope === "organization" &&
    isDemoManualCall(data);
}

const RUNTIME_ERROR_SOURCES: ReadonlySet<CallErrorSource> = new Set([
  "transcription",
  "analysis_dispatch",
  "analysis_task",
  "analysis_finalizer",
  "reconcile",
]);

function runtimeErrorFromCallData(data: DocumentData): SerializedCallError | null {
  const runtimeError = data.lastFailedRuntimeError;
  if (!runtimeError || typeof runtimeError !== "object") return null;
  const record = runtimeError as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "Runtime processing failed";
  const rawErrorSource = typeof record.errorSource === "string" ? record.errorSource : null;
  const errorSource = rawErrorSource && RUNTIME_ERROR_SOURCES.has(rawErrorSource as CallErrorSource) ? rawErrorSource as CallErrorSource : null;
  if (!errorSource) return null;
  return {
    message,
    errorSource,
    errorCode: typeof record.errorCode === "string" ? record.errorCode : undefined,
    errorType: typeof record.errorType === "string" ? record.errorType : undefined,
    errorStatus: typeof record.errorStatus === "number" ? record.errorStatus : undefined,
    retryable: record.retryable === true,
  };
}

function buildRequeueUpdate(
  data: DocumentData,
  stage: RuntimeRetryStage,
  nextCount: number,
  source: RuntimeRetrySource,
  requestedBy?: string | null
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    status: stage === "analysis" ? "analyzing" : "uploaded",
    processingGeneration: getProcessingGeneration(data) + 1,
    [`automaticRetryCounts.${stage}`]: nextCount,
    automaticRetryState: "running",
    automaticRetryEligible: false,
    automaticRetrySource: source,
    lastAutomaticRetryAt: FieldValue.serverTimestamp(),
    lastAutomaticRetryStage: stage,
    lastAutomaticRetryBy: requestedBy ?? null,
    activeAnalysisRunId: FieldValue.delete(),
    analysisCompletedAt: FieldValue.delete(),
    automaticRetryExhaustedAt: FieldValue.delete(),
    ...buildClearCallErrorUpdate(),
  };

  if (stage === "transcription") {
    update.transcriptionStartedAt = FieldValue.delete();
    update.transcriptionCompletedAt = FieldValue.delete();
    update.transcriptSegments = FieldValue.delete();
    update.transcriptText = FieldValue.delete();
    update.transcriptStoragePath = FieldValue.delete();
  }

  return update;
}

export async function requeueRuntimeFailure(input: RequeueRuntimeFailureInput): Promise<RequeueRuntimeFailureResult> {
  const firestore = input.callRef.firestore;
  return firestore.runTransaction(async (transaction: Transaction) => {
    const callDoc = await transaction.get(input.callRef);
    if (!callDoc.exists) return { queued: false, callId: input.callRef.id, skippedReason: "not_found" };
    const data = callDoc.data() ?? {};
    if (!isCccRuntimeCall(data)) return { queued: false, callId: input.callRef.id, skippedReason: "not_ccc_call" };
    if (data.status !== "error") return { queued: false, callId: input.callRef.id, skippedReason: "not_error" };
    const stage = runtimeRetryStageFromErrorSource(data.errorSource);
    if (stage !== "analysis" && stage !== "transcription") return { queued: false, callId: input.callRef.id, skippedReason: "missing_stage" };
    if (input.stage && input.stage !== stage) return { queued: false, callId: input.callRef.id, skippedReason: "stage_mismatch" };
    if (data.automaticRetryState !== "eligible") return { queued: false, callId: input.callRef.id, stage, skippedReason: `state_${data.automaticRetryState ?? "missing"}` };
    const currentCount = automaticRetryCount(data, stage);
    if (currentCount >= MAX_AUTOMATIC_RUNTIME_RETRIES) return { queued: false, callId: input.callRef.id, stage, retryCount: currentCount, skippedReason: "retry_limit_reached" };
    const storedError = runtimeErrorFromCallData(data);
    if (!storedError || !shouldRetryRuntimeError(stage, storedError)) return { queued: false, callId: input.callRef.id, stage, retryCount: currentCount, skippedReason: "not_retryable" };
    const nextCount = currentCount + 1;
    const budgetRef = firestore.doc(DEMO_BUDGET_PATH);
    const budgetDoc = await transaction.get(budgetRef);
    try { admitDemoReservation(readDemoBudget(budgetDoc.data()), 1); } catch {
      return { queued:false,callId:input.callRef.id,stage,skippedReason:'demo_budget_unavailable' };
    }
    const activeCalls = { ...(budgetDoc.data()?.activeCalls ?? {}) };
    if (activeCalls[input.callRef.id] === undefined && Object.keys(activeCalls).length >= DEMO_MAX_ACTIVE_CALLS) {
      return { queued:false,callId:input.callRef.id,stage,skippedReason:'demo_concurrency_limit' };
    }
    activeCalls[input.callRef.id] = getProcessingGeneration(data) + 1;
    transaction.update(budgetRef, {activeCalls,updatedAt:FieldValue.serverTimestamp()});
    transaction.update(input.callRef, buildRequeueUpdate(data, stage, nextCount, input.source, input.requestedBy));
    return { queued: true, callId: input.callRef.id, stage, retryCount: nextCount };
  });
}

export async function markAutomaticRuntimeRetryComplete(
  callRef: DocumentReference,
  data: DocumentData
): Promise<void> {
  if (data.automaticRetryState !== "running") return;
  await callRef.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(callRef);
    const current = snapshot.data();
    if (!current || current.status !== 'complete' || current.automaticRetryState !== 'running' ||
        getProcessingGeneration(current) !== getProcessingGeneration(data)) return;
    transaction.update(callRef, {
      automaticRetryState: "complete",
      automaticRetryEligible: false,
      automaticRetryCompletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

export function isAutomaticRuntimeRetryCall(data: DocumentData): boolean {
  return isCccRuntimeCall(data) && data.automaticRetryState === "running";
}
