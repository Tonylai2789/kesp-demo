import { isDemoManualCall } from "./demoConfig";
import * as admin from "firebase-admin";
import { HttpsError, onCall, onPaidCall, type CallableRequest } from "./demoHttps";
import { CONSUBANCO_ORGANIZATION_ID } from "./callIdentity";
import { assertConsubancoSupervisorOrAdmin } from "./cccAutomaticWorkflowMonitor";
import {
  MAX_AUTOMATIC_RUNTIME_RETRIES,
  automaticRetryCount,
  requeueRuntimeFailure,
  runtimeRetryStageFromErrorSource,
  type RequeueRuntimeFailureResult,
  type RuntimeRetryStage,
  type RuntimeRetryState,
  type RuntimeRetrySource,
} from "./runtimeRetry";

const db = admin.firestore();
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 250;
const DEFAULT_RETRY_LIMIT = 25;
const MAX_RETRY_LIMIT = 100;
const ERROR_DATE_TIME_ZONE = "America/Mexico_City";

export type CccRuntimeFailureStageFilter = "all" | RuntimeRetryStage;
export type CccRuntimeFailureRetryStateFilter = "all" | RuntimeRetryState;
export type CccRuntimeFailureEnvironmentFilter = "all" | "testing" | "production";
export type RetryCccRuntimeFailuresMode = "selected" | "all_eligible" | "agent";

export interface ListCccRuntimeFailuresRequest {
  stage?: CccRuntimeFailureStageFilter;
  retryState?: CccRuntimeFailureRetryStateFilter;
  workflowEnvironment?: CccRuntimeFailureEnvironmentFilter;
  salesAgentId?: string;
  dateKey?: string;
  limit?: number;
}

export interface CccRuntimeFailureRow {
  callId: string;
  stage: RuntimeRetryStage;
  retryState: RuntimeRetryState | "unknown";
  retryEligible: boolean;
  retryCount: number;
  maxRetryCount: number;
  salesAgentId: string | null;
  salesAgentName: string | null;
  sourceObjectPath: string | null;
  sourceFilename: string | null;
  callTimestamp: string | null;
  updatedAt: string | null;
  errorDateKey: string | null;
  workflowEnvironment: "testing" | "production" | "unknown";
  lastError: string | null;
  errorSource: string | null;
  status: string | null;
}

export interface ListCccRuntimeFailuresResponse {
  success: true;
  generatedAt: string;
  allErrorCount: number;
  selectedDateKey: string | null;
  selectedDateErrorCount: number;
  latestErrorDateKey: string | null;
  rows: CccRuntimeFailureRow[];
}

export interface RetryCccRuntimeFailuresRequest {
  mode: RetryCccRuntimeFailuresMode;
  callIds?: string[];
  salesAgentId?: string;
  stage?: CccRuntimeFailureStageFilter;
  retryState?: CccRuntimeFailureRetryStateFilter;
  workflowEnvironment?: CccRuntimeFailureEnvironmentFilter;
  dateKey?: string;
  limit?: number;
}

export interface RetryCccRuntimeFailuresResponse {
  success: true;
  mode: RetryCccRuntimeFailuresMode;
  scanned: number;
  queued: number;
  skipped: number;
  skippedByReason: Record<string, number>;
  results: Array<RequeueRuntimeFailureResult>;
}

/** Converts Firestore timestamp-like values to API-safe ISO strings. */
function timestampToIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  return null;
}

/** Keeps string fields API-safe without translating backend-generated values. */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Normalizes user-provided limits so admin actions stay bounded. */
function boundedLimit(value: unknown, fallback: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) <= 0) return fallback;
  return Math.min(value as number, max);
}

/** Accepts only YYYY-MM-DD runtime-error date keys. */
function normalizedDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

/** Converts an ISO timestamp to the runtime-error day used by the recovery UI. */
export function runtimeErrorDateKeyFromIso(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ERROR_DATE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

/** Infers which workflow bucket family produced a CCC call. */
function workflowEnvironmentFromCall(data: FirebaseFirestore.DocumentData, path: string | null): "testing" | "production" | "unknown" {
  if (data.environmentTarget === "test") return "testing";
  if (data.environmentTarget === "prod") return "production";
  if (!path) return "unknown";
  if (path.startsWith("test-samples/") || path.startsWith("testing/") || path.includes("/testing/")) return "testing";
  return path.startsWith("prod/") || path.startsWith("prod-ready/") || path.startsWith("prod-review/") || path.startsWith("prod-blocked/") || path.startsWith("production/") || path.startsWith("landing/") ? "production" : "unknown";
}

/** Extracts the runtime failure stage from retry metadata or the original error source. */
function stageFromCallData(data: FirebaseFirestore.DocumentData): RuntimeRetryStage | null {
  if (data.automaticRetryStage === "analysis" || data.automaticRetryStage === "transcription") return data.automaticRetryStage;
  return runtimeRetryStageFromErrorSource(data.errorSource);
}

/** Checks whether a Firestore call document is a CCC runtime failure row. */
function isRuntimeFailure(data: FirebaseFirestore.DocumentData): boolean {
  return data.organizationId === CONSUBANCO_ORGANIZATION_ID &&
    data.visibilityScope === "organization" &&
    isDemoManualCall(data) &&
    data.status === "error" &&
    stageFromCallData(data) !== null;
}

/** Builds the compact runtime-failure row consumed by the KESP admin page. */
function rowFromCallDoc(doc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot): CccRuntimeFailureRow | null {
  const data = doc.data();
  if (!data || !isRuntimeFailure(data)) return null;
  const stage = stageFromCallData(data);
  if (!stage) return null;
  const sourceObjectPath = stringOrNull(data.sourceObjectPath) ?? stringOrNull(data.gcsObjectPath) ?? stringOrNull(data.originalStoragePath);
  const retryState = data.automaticRetryState === "eligible" ||
    data.automaticRetryState === "not_retryable" ||
    data.automaticRetryState === "exhausted" ||
    data.automaticRetryState === "running" ||
    data.automaticRetryState === "complete" ? data.automaticRetryState : "unknown";
  const lastRuntimeError = data.lastFailedRuntimeError && typeof data.lastFailedRuntimeError === "object" ? data.lastFailedRuntimeError as Record<string, unknown> : null;
  const updatedAt = timestampToIso(data.updatedAt);
  return {
    callId: doc.id,
    stage,
    retryState,
    retryEligible: data.automaticRetryEligible === true || retryState === "eligible",
    retryCount: automaticRetryCount(data, stage),
    maxRetryCount: MAX_AUTOMATIC_RUNTIME_RETRIES,
    salesAgentId: stringOrNull(data.salesAgentId),
    salesAgentName: stringOrNull(data.salesAgentName) ?? stringOrNull(data.agentName),
    sourceObjectPath,
    sourceFilename: sourceObjectPath ? sourceObjectPath.split("/").pop() ?? sourceObjectPath : stringOrNull(data.originalFilename),
    callTimestamp: timestampToIso(data.callTimestamp ?? data.createdAt),
    updatedAt,
    errorDateKey: runtimeErrorDateKeyFromIso(updatedAt),
    workflowEnvironment: workflowEnvironmentFromCall(data, sourceObjectPath),
    lastError: stringOrNull(lastRuntimeError?.message) ?? stringOrNull(data.errorMessage),
    errorSource: stringOrNull(lastRuntimeError?.errorSource) ?? stringOrNull(data.errorSource),
    status: stringOrNull(data.status),
  };
}

/** Applies request filters to runtime failure rows. */
export function filterRuntimeRows(rows: CccRuntimeFailureRow[], request: ListCccRuntimeFailuresRequest): CccRuntimeFailureRow[] {
  const stage = request.stage ?? "all";
  const retryState = request.retryState ?? "all";
  const workflowEnvironment = request.workflowEnvironment ?? "all";
  const salesAgentId = stringOrNull(request.salesAgentId);
  const dateKey = normalizedDateKey(request.dateKey);
  return rows.filter((row) => {
    if (stage !== "all" && row.stage !== stage) return false;
    if (retryState !== "all" && row.retryState !== retryState) return false;
    if (workflowEnvironment !== "all" && row.workflowEnvironment !== workflowEnvironment) return false;
    if (salesAgentId && row.salesAgentId !== salesAgentId) return false;
    if (dateKey && row.errorDateKey !== dateKey) return false;
    return true;
  });
}

/** Builds the API response from already-loaded runtime rows. */
export function buildRuntimeFailureListResponse(params: {
  rows: CccRuntimeFailureRow[];
  request: ListCccRuntimeFailuresRequest;
  limit: number;
  generatedAt: string;
}): ListCccRuntimeFailuresResponse {
  const allFilteredRows = filterRuntimeRows(params.rows, { ...params.request, dateKey: undefined });
  const latestErrorDateKey = allFilteredRows.find((row) => row.errorDateKey)?.errorDateKey ?? null;
  const selectedDateKey = normalizedDateKey(params.request.dateKey) ?? latestErrorDateKey;
  const selectedRows = selectedDateKey ? allFilteredRows.filter((row) => row.errorDateKey === selectedDateKey) : [];
  return {
    success: true,
    generatedAt: params.generatedAt,
    allErrorCount: allFilteredRows.length,
    selectedDateKey,
    selectedDateErrorCount: selectedRows.length,
    latestErrorDateKey,
    rows: selectedRows.slice(0, params.limit),
  };
}

/** Loads CCC runtime error docs in updated order so the UI can derive exact day counts. */
async function loadRuntimeFailureRows(): Promise<CccRuntimeFailureRow[]> {
  const snapshot = await db.collection("calls")
    .where("organizationId", "==", CONSUBANCO_ORGANIZATION_ID)
    .where("visibilityScope", "==", "organization")
    .where("callSource", "==", "manual_upload")
    .where("status", "==", "error")
    .orderBy("updatedAt", "desc")
    .get();
  return snapshot.docs.map(rowFromCallDoc).filter((row): row is CccRuntimeFailureRow => Boolean(row));
}

/** Lists runtime failure calls for Consubanco admins. */
export async function handleListCccRuntimeFailures(request: CallableRequest<ListCccRuntimeFailuresRequest>): Promise<ListCccRuntimeFailuresResponse> {
  if (!request.auth) throw new HttpsError("unauthenticated", "Authentication required");
  await assertConsubancoSupervisorOrAdmin(request.auth.uid, db);
  const limit = boundedLimit(request.data?.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  return buildRuntimeFailureListResponse({
    rows: await loadRuntimeFailureRows(),
    request: request.data ?? {},
    limit,
    generatedAt: new Date().toISOString(),
  });
}

/** Requeues one eligible runtime failure after optional stage-specific cleanup. */
async function requeueRuntimeFailureFromDoc(
  doc: FirebaseFirestore.DocumentSnapshot,
  source: RuntimeRetrySource,
  requestedBy: string | null,
  requestedStage?: CccRuntimeFailureStageFilter
): Promise<RequeueRuntimeFailureResult> {
  const data = doc.data() ?? {};
  const stage = stageFromCallData(data);
  if (stage !== "analysis" && stage !== "transcription") return { queued: false, callId: doc.id, skippedReason: "missing_stage" };
  if (requestedStage && requestedStage !== 'all' && stage !== requestedStage) {
    return { queued: false, callId: doc.id, skippedReason: 'stage_mismatch' };
  }
  return requeueRuntimeFailure({ callRef: doc.ref, stage, source, requestedBy });
}

/** Records one skipped result in aggregate response counters. */
function countSkipped(skippedByReason: Record<string, number>, reason: string | undefined): void {
  const key = reason ?? "unknown";
  skippedByReason[key] = (skippedByReason[key] ?? 0) + 1;
}

/** Selects target runtime-failure documents for an admin retry request. */
async function retryTargets(request: RetryCccRuntimeFailuresRequest): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  const mode = request.mode;
  const limit = boundedLimit(request.limit, DEFAULT_RETRY_LIMIT, MAX_RETRY_LIMIT);
  if (mode === "selected") {
    const callIds = Array.isArray(request.callIds) ? Array.from(new Set(request.callIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))).slice(0, MAX_RETRY_LIMIT) : [];
    if (callIds.length === 0) throw new HttpsError("invalid-argument", "callIds are required for selected retry");
    return Promise.all(callIds.map((callId) => db.collection("calls").doc(callId).get()));
  }

  const rows = await loadRuntimeFailureRows();
  const retryState = request.retryState && request.retryState !== "all" ? request.retryState : "eligible";
  const filteredRows = filterRuntimeRows(rows, {
    ...request,
    retryState,
    salesAgentId: mode === "agent" ? request.salesAgentId : undefined,
  }).slice(0, limit);

  if (mode === "agent" && !stringOrNull(request.salesAgentId)) {
    throw new HttpsError("invalid-argument", "salesAgentId is required for agent retry");
  }
  if (mode !== "agent" && mode !== "all_eligible") {
    throw new HttpsError("invalid-argument", "Unsupported retry mode");
  }
  return Promise.all(filteredRows.map((row) => db.collection("calls").doc(row.callId).get()));
}

/** Requeues eligible runtime failures for Consubanco admins. */
export async function handleRetryCccRuntimeFailures(request: CallableRequest<RetryCccRuntimeFailuresRequest>): Promise<RetryCccRuntimeFailuresResponse> {
  if (!request.auth) throw new HttpsError("unauthenticated", "Authentication required");
  await assertConsubancoSupervisorOrAdmin(request.auth.uid, db);
  const mode = request.data?.mode;
  if (mode !== "selected" && mode !== "all_eligible" && mode !== "agent") {
    throw new HttpsError("invalid-argument", "mode must be selected, all_eligible, or agent");
  }
  const docs = await retryTargets(request.data);
  const results: RequeueRuntimeFailureResult[] = [];
  const skippedByReason: Record<string, number> = {};
  for (const doc of docs) {
    const result = doc.exists && rowFromCallDoc(doc)
      ? await requeueRuntimeFailureFromDoc(doc, "manual_admin", request.auth.uid, request.data.stage)
      : { queued: false, callId: doc.id, skippedReason: doc.exists ? "not_runtime_error" : "not_found" };
    if (!result.queued) countSkipped(skippedByReason, result.skippedReason);
    results.push(result);
  }
  const queued = results.filter((result) => result.queued).length;
  return { success: true, mode, scanned: docs.length, queued, skipped: docs.length - queued, skippedByReason, results };
}

export const listCccRuntimeFailures = onCall(handleListCccRuntimeFailures);
export const retryCccRuntimeFailures = onPaidCall(handleRetryCccRuntimeFailures);
