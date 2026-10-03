import * as admin from "firebase-admin";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall, type CallableRequest } from "./demoHttps";
import { CONSUBANCO_ORGANIZATION_ID } from "./callIdentity";
import { assertConsubancoAdmin } from "./cccAutomaticWorkflowMonitor";

export const CCC_WORKFLOW_FEED_COLLECTION = "ccc_workflow_feed";
const CCC_PIPELINE_RUNS_COLLECTION = "ccc_pipeline_runs";
export const CCC_WORKFLOW_FEED_DEFAULT_PAGE_SIZE = 10;
export const CCC_WORKFLOW_FEED_MAX_PAGE_SIZE = 25;

export type CccWorkflowFeedCategory =
  | "missing-mapping"
  | "invalid-format"
  | "likely-corrupt"
  | "ingest-copy-failure"
  | "runtime-error"
  | "short-call"
  | "production-call"
  | "dry-run"
  | "pipeline-run"
  | "other-error";

export type CccWorkflowFeedFilter =
  | "all-errors"
  | "missing-mapping"
  | "invalid-format"
  | "likely-corrupt"
  | "ingest-copy-failures"
  | "runtime-errors"
  | "short-call"
  | "production-calls"
  | "dry-runs"
  | "guarded-copy-completed"
  | "guarded-copy-failures"
  | "queued-pipeline-runs";

export type CccWorkflowEnvironment = "testing" | "production";

export interface CccWorkflowFeedCursor {
  eventTimestamp: string;
  id: string;
}

export interface CccWorkflowFeedRow {
  id: string;
  organizationId: string;
  workflowEnvironment: CccWorkflowEnvironment;
  feedCategory: CccWorkflowFeedCategory;
  feedFilterKeys: CccWorkflowFeedFilter[];
  isAttention: boolean;
  severityRank: number;
  eventTimestamp: string;
  callTimestamp?: string | null;
  callId?: string | null;
  canonicalCallId?: string | null;
  pipelineRunId?: string | null;
  runMode?: string | null;
  salesAgentId?: string | null;
  salesAgentName?: string | null;
  sourceObjectPath?: string | null;
  destinationObjectPath?: string | null;
  status?: string | null;
  errorCode?: string | null;
  routingClass?: string | null;
  displayTitle: string;
  displayBody: string;
  detailPath?: string | null;
}

export interface GetCccAutomaticWorkflowFeedRequest {
  filter?: CccWorkflowFeedFilter;
  workflowEnvironment?: CccWorkflowEnvironment;
  startDate?: string | null;
  endDate?: string | null;
  pageSize?: number;
  cursor?: CccWorkflowFeedCursor | null;
  snapshotBefore?: string | null;
}

export interface GetCccAutomaticWorkflowFeedResponse {
  success: true;
  generatedAt: string;
  snapshotBefore: string;
  filter: CccWorkflowFeedFilter;
  workflowEnvironment: CccWorkflowEnvironment;
  rows: CccWorkflowFeedRow[];
  preloadRows: CccWorkflowFeedRow[];
  nextCursor: CccWorkflowFeedCursor | null;
  hasMore: boolean;
}

export interface CccWorkflowFeedSourceRow {
  id: string;
  organizationId?: string;
  workflowEnvironment?: CccWorkflowEnvironment | null;
  feedCategory: CccWorkflowFeedCategory;
  feedFilterKeys?: CccWorkflowFeedFilter[];
  eventTimestamp?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue | Date | string | null;
  callTimestamp?: FirebaseFirestore.Timestamp | Date | string | null;
  callId?: string | null;
  canonicalCallId?: string | null;
  pipelineRunId?: string | null;
  runMode?: string | null;
  salesAgentId?: string | null;
  salesAgentName?: string | null;
  sourceObjectPath?: string | null;
  destinationObjectPath?: string | null;
  status?: string | null;
  errorCode?: string | null;
  routingClass?: string | null;
  displayTitle: string;
  displayBody: string;
  detailPath?: string | null;
}

interface WorkflowFeedDependencies {
  db: FirebaseFirestore.Firestore;
  now: () => Date;
}

/** Documents the defaultWorkflowFeedDependencies behavior. */
function defaultWorkflowFeedDependencies(): WorkflowFeedDependencies {
  return {
    db: admin.firestore(),
    now: () => new Date(),
  };
}

/** Documents the isPlainDateKey behavior. */
export function isPlainDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Documents the dateKeyToDate behavior. */
export function dateKeyToDate(value: string, endExclusive = false): Date {
  const [year, month, day] = value.split("-").map(Number);
  const localDay = day + (endExclusive ? 1 : 0);
  const utcMidnight = Date.UTC(year, month - 1, localDay, 0, 0, 0, 0);
  const offsetMinutes = timeZoneOffsetMinutes("America/Los_Angeles", new Date(utcMidnight));
  let result = new Date(utcMidnight - offsetMinutes * 60_000);
  const correctedOffsetMinutes = timeZoneOffsetMinutes("America/Los_Angeles", result);
  if (correctedOffsetMinutes !== offsetMinutes) {
    result = new Date(utcMidnight - correctedOffsetMinutes * 60_000);
  }
  return result;
}

/** Documents the timeZoneOffsetMinutes behavior. */
function timeZoneOffsetMinutes(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return (zonedAsUtc - date.getTime()) / 60_000;
}

function isFirestoreTimestamp(value: unknown): value is FirebaseFirestore.Timestamp {
  return typeof Timestamp === "function" && value instanceof Timestamp;
}

export function timestampFromDate(value: Date): FirebaseFirestore.Timestamp {
  return Timestamp.fromDate(value);
}

/** Documents the timestampToIso behavior. */
function timestampToIso(value: unknown): string | null {
  if (isFirestoreTimestamp(value)) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  if (value && typeof value === "object" && "toDate" in value) {
    const maybeTimestamp = value as { toDate?: () => Date };
    if (typeof maybeTimestamp.toDate === "function") return maybeTimestamp.toDate().toISOString();
  }
  return null;
}

/** Documents the firestoreTimestampFromIso behavior. */
export function firestoreTimestampFromIso(value: string): FirebaseFirestore.Timestamp {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpsError("invalid-argument", "Invalid timestamp cursor.");
  return timestampFromDate(date);
}

/** Documents the cleanString behavior. */
function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Documents the categorySeverityRank behavior. */
export function categorySeverityRank(category: CccWorkflowFeedCategory): number {
  if (category === "likely-corrupt") return 10;
  if (category === "ingest-copy-failure") return 20;
  if (category === "invalid-format") return 30;
  if (category === "missing-mapping") return 40;
  if (category === "runtime-error") return 45;
  if (category === "short-call") return 50;
  if (category === "other-error") return 60;
  if (category === "pipeline-run") return 70;
  if (category === "dry-run") return 80;
  return 90;
}

function isAttentionFeedRow(row: CccWorkflowFeedSourceRow): boolean {
  if (row.feedCategory !== "production-call" && row.feedCategory !== "dry-run" && row.feedCategory !== "pipeline-run") return true;
  return row.feedFilterKeys?.includes("guarded-copy-failures") === true;
}

function compactStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item)).filter((item): item is string => Boolean(item)).slice(0, limit);
}

/** Documents the filterKeysForCategory behavior. */
export function filterKeysForCategory(category: CccWorkflowFeedCategory): CccWorkflowFeedFilter[] {
  if (category === "production-call") return ["production-calls"];
  if (category === "dry-run") return ["dry-runs"];
  if (category === "pipeline-run") return [];
  if (category === "short-call") return ["short-call"];
  const keys: CccWorkflowFeedFilter[] = ["all-errors"];
  if (category === "ingest-copy-failure") keys.push("ingest-copy-failures");
  else if (category === "runtime-error") keys.push("runtime-errors");
  else if (category !== "other-error") keys.push(category);
  return keys;
}

/** Documents the normalizeWorkflowEnvironment behavior. */
function normalizeWorkflowEnvironment(value: unknown): CccWorkflowEnvironment | null {
  return value === "testing" || value === "production" ? value : null;
}

/** Documents the inferWorkflowEnvironment behavior. */
export function inferWorkflowEnvironment(row: {
  workflowEnvironment?: CccWorkflowEnvironment | string | null;
  sourceObjectPath?: string | null;
  destinationObjectPath?: string | null;
}): CccWorkflowEnvironment {
  const explicit = normalizeWorkflowEnvironment(row.workflowEnvironment);
  if (explicit) return explicit;
  const pathText = `${row.sourceObjectPath ?? ""} ${row.destinationObjectPath ?? ""}`.toLowerCase();
  if (pathText.includes("test-samples/landing/")) return "testing";
  return "production";
}

/** Documents the eventTimestampForWrite behavior. */
function eventTimestampForWrite(value: CccWorkflowFeedSourceRow["eventTimestamp"]): FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue | string {
  if (isFirestoreTimestamp(value)) return value;
  if (value instanceof Date) return timestampFromDate(value);
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : timestampFromDate(date);
  }
  if (value && typeof value === "object") return value as FirebaseFirestore.FieldValue;
  return FieldValue.serverTimestamp();
}

/** Documents the buildWorkflowFeedWrite behavior. */
export function buildWorkflowFeedWrite(row: CccWorkflowFeedSourceRow): FirebaseFirestore.DocumentData {
  const filterKeys = row.feedFilterKeys ?? filterKeysForCategory(row.feedCategory);
  return {
    organizationId: row.organizationId ?? CONSUBANCO_ORGANIZATION_ID,
    workflowEnvironment: inferWorkflowEnvironment(row),
    feedCategory: row.feedCategory,
    feedFilterKeys: filterKeys,
    isAttention: isAttentionFeedRow({ ...row, feedFilterKeys: filterKeys }),
    severityRank: categorySeverityRank(row.feedCategory),
    eventTimestamp: eventTimestampForWrite(row.eventTimestamp),
    callTimestamp: row.callTimestamp ?? null,
    callId: row.callId ?? null,
    canonicalCallId: row.canonicalCallId ?? null,
    pipelineRunId: row.pipelineRunId ?? null,
    runMode: row.runMode ?? null,
    salesAgentId: row.salesAgentId ?? null,
    salesAgentName: row.salesAgentName ?? null,
    sourceObjectPath: row.sourceObjectPath ?? null,
    destinationObjectPath: row.destinationObjectPath ?? null,
    status: row.status ?? null,
    errorCode: row.errorCode ?? null,
    routingClass: row.routingClass ?? null,
    displayTitle: row.displayTitle,
    displayBody: row.displayBody,
    detailPath: row.detailPath ?? null,
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  };
}

/** Documents the upsertCccWorkflowFeedRow behavior. */
export async function upsertCccWorkflowFeedRow(db: FirebaseFirestore.Firestore, row: CccWorkflowFeedSourceRow): Promise<void> {
  await db.collection(CCC_WORKFLOW_FEED_COLLECTION).doc(row.id).set(buildWorkflowFeedWrite(row), { merge: true });
}

/** Documents the classifyIngestEventCategory behavior. */
export function classifyIngestEventCategory(data: FirebaseFirestore.DocumentData): CccWorkflowFeedCategory {
  const errorCode = cleanString(data.ingestErrorCode ?? data.ingest_error_code);
  const status = cleanString(data.ingestStatus ?? data.ingest_status);
  if (errorCode === "DUPLICATE_CCC_CALL" || status === "blocked_duplicate") return "production-call";
  if (errorCode === "AGENT_MAPPING_MISSING" || status === "blocked_agent_mapping_missing") return "missing-mapping";
  if (["INVALID_FILENAME_FORMAT", "PATH_METADATA_MISMATCH", "UNSUPPORTED_EXTENSION", "INVALID_PREFIX"].includes(errorCode ?? "")) return "invalid-format";
  if (errorCode === "STORAGE_COPY_FAILED" || status === "copy_failed") return "ingest-copy-failure";
  if (errorCode || (status && status !== "copied_to_arvo_storage")) return "other-error";
  return "production-call";
}

/** Documents the workflowFeedRowFromIngestEvent behavior. */
export function workflowFeedRowFromIngestEvent(id: string, data: FirebaseFirestore.DocumentData): CccWorkflowFeedSourceRow | null {
  const category = classifyIngestEventCategory(data);
  if (category === "production-call") return null;
  const sourceObjectPath = cleanString(data.sourceObjectPath ?? data.source_object_path ?? data.sourcePath);
  const errorCode = cleanString(data.ingestErrorCode ?? data.ingest_error_code);
  return {
    id: `ingest_${id}`,
    feedCategory: category,
    eventTimestamp: data.updatedAt ?? data.createdAt ?? null,
    callId: cleanString(data.callDocumentId ?? data.call_document_id),
    canonicalCallId: cleanString(data.canonicalCallId ?? data.canonical_call_id),
    salesAgentId: cleanString(data.salesAgentId ?? data.arvo_sales_agent_id),
    sourceObjectPath,
    destinationObjectPath: cleanString(data.audioPath ?? data.audio_path),
    status: cleanString(data.ingestStatus ?? data.ingest_status),
    errorCode,
    routingClass: category,
    displayTitle: errorCode ?? "CCC ingest issue",
    displayBody: cleanString(data.ingestErrorDetail ?? data.ingest_error_detail) ?? sourceObjectPath ?? "CCC ingest requires attention.",
  };
}

/** Documents the workflowFeedRowFromProdCopyEvent behavior. */
export function workflowFeedRowFromProdCopyEvent(id: string, data: FirebaseFirestore.DocumentData): CccWorkflowFeedSourceRow | null {
  const routingClass = cleanString(data.routingClass);
  const copyStatus = cleanString(data.copyStatus);
  const verificationStatus = cleanString(data.verificationStatus);
  let category: CccWorkflowFeedCategory | null = null;
  if (routingClass === "missing-mapping") category = "missing-mapping";
  else if (routingClass === "invalid-format") category = "invalid-format";
  else if (routingClass === "likely-corrupt") category = "likely-corrupt";
  else if (routingClass === "short-call") category = "short-call";
  else if (copyStatus === "failed" || verificationStatus === "failed") category = "ingest-copy-failure";
  if (!category) return null;
  const parsed = data.parsedCccFields && typeof data.parsedCccFields === "object" ? data.parsedCccFields as Record<string, unknown> : {};
  return {
    id: `copy_${id}`,
    feedCategory: category,
    eventTimestamp: data.updatedAt ?? data.createdAt ?? null,
    canonicalCallId: cleanString(parsed.canonicalCallId),
    salesAgentId: cleanString(parsed.canonicalSalesAgentId),
    sourceObjectPath: cleanString(data.sourceObjectPath),
    destinationObjectPath: cleanString(data.destinationObjectPath),
    status: copyStatus ?? verificationStatus,
    errorCode: cleanString(data.copyError ?? data.deleteError),
    routingClass,
    displayTitle: routingClass ?? "CCC copy event",
    displayBody: cleanString(data.copyError ?? data.deleteError ?? data.sourceObjectPath) ?? "CCC copy event requires review.",
  };
}

/** Documents the workflowFeedRowFromShortCallReview behavior. */
export function workflowFeedRowFromShortCallReview(id: string, data: FirebaseFirestore.DocumentData): CccWorkflowFeedSourceRow {
  const duration = typeof data.durationSeconds === "number" ? `${Math.round(data.durationSeconds)}s` : "short duration";
  return {
    id: `short_${id}`,
    feedCategory: "short-call",
    eventTimestamp: data.updatedAt ?? data.createdAt ?? null,
    callTimestamp: data.cccCallTimestamp ?? null,
    callId: cleanString(data.callId),
    canonicalCallId: id,
    pipelineRunId: cleanString(data.pipelineRunId),
    salesAgentId: cleanString(data.salesAgentId),
    salesAgentName: cleanString(data.salesAgentName),
    sourceObjectPath: cleanString(data.sourceObjectPath ?? data.originalLandingObjectPath),
    destinationObjectPath: cleanString(data.sourceObjectPath),
    status: cleanString(data.reviewStatus),
    routingClass: "short-call",
    displayTitle: "Short call review",
    displayBody: `${duration} call awaiting review.`,
    detailPath: cleanString(data.callId) ? `/kesp/short-calls/${encodeURIComponent(String(data.callId))}` : null,
  };
}

/** Documents the workflowFeedRowFromCall behavior. */
export function workflowFeedRowFromCall(id: string, data: FirebaseFirestore.DocumentData): CccWorkflowFeedSourceRow | null {
  if (data.callSource !== "ccc_gcs" || data.organizationId !== CONSUBANCO_ORGANIZATION_ID) return null;
  const status = cleanString(data.status);
  const isError = status === "error";
  const isShortCallReview = data.analysisPipeline === "manual_short_call_review" ||
    data.shortCallReviewSource === "automatic_ccc_gcs";
  const displayName = cleanString(data.displayName ?? data.name ?? data.originalFilename ?? data.cccOriginalFilename) ?? id;
  const errorSource = cleanString(data.errorSource);
  const isTranscriptionError = errorSource === "transcription";
  const isAnalysisError = errorSource === "analysis_dispatch" || errorSource === "analysis_task" || errorSource === "analysis_finalizer";
  const isRuntimeError = isError && (isTranscriptionError || isAnalysisError);
  const analysisTimestamp = data.analysisCompletedAt ?? data.analysisStartedAt ?? data.updatedAt ?? data.createdAt;
  const duration = typeof data.duration === "number" && Number.isFinite(data.duration)
    ? `${Math.round(data.duration)}s`
    : "under 90s";
  const feedCategory: CccWorkflowFeedCategory = isShortCallReview
    ? "short-call"
    : isRuntimeError
      ? "runtime-error"
      : isError
        ? "other-error"
        : "production-call";
  const routingClass = isShortCallReview
    ? "short-call"
    : isRuntimeError
      ? isTranscriptionError ? "transcription-error" : "analysis-error"
      : isError
        ? "processing-error"
        : "production-call";
  return {
    id: `call_${id}`,
    feedCategory,
    eventTimestamp: analysisTimestamp ?? null,
    callTimestamp: data.cccCallTimestamp ?? null,
    callId: id,
    canonicalCallId: cleanString(data.canonicalCallId) ?? id,
    pipelineRunId: cleanString(data.pipelineRunId),
    salesAgentId: cleanString(data.salesAgentId),
    salesAgentName: cleanString(data.salesAgentName),
    sourceObjectPath: cleanString(data.sourceObjectPath),
    destinationObjectPath: cleanString(data.audioPath),
    status,
    errorCode: cleanString(data.errorCode ?? data.errorType),
    routingClass,
    displayTitle: isShortCallReview ? "Automatic short call" : isRuntimeError ? (isTranscriptionError ? "Transcription error" : "Analysis error") : isError ? "Automatic call error" : displayName,
    displayBody: isShortCallReview
      ? `${duration} · ${cleanString(data.salesAgentName) ?? displayName}`
      : isError ? cleanString(data.error ?? data.statusReason) ?? displayName : cleanString(data.salesAgentName) ?? displayName,
    detailPath: isShortCallReview ? `/kesp/short-calls/${encodeURIComponent(id)}` : `/kesp/call/${encodeURIComponent(id)}`,
  };
}

/** Documents the workflowFeedRowFromPipelineRun behavior. */
export function workflowFeedRowFromPipelineRun(id: string, data: FirebaseFirestore.DocumentData): CccWorkflowFeedSourceRow | null {
  const request = data.request && typeof data.request === "object" ? data.request as Record<string, unknown> : {};
  const operation = cleanString(data.operation ?? request.operation);
  if (!operation) return null;
  const counts = data.counts && typeof data.counts === "object" ? data.counts as Record<string, unknown> : {};
  const status = cleanString(data.status) ?? "queued";
  const mode = cleanString(data.mode ?? request.mode) ?? "recent_sample";
  const environment = normalizeWorkflowEnvironment(data.environment ?? request.environment) ?? "testing";
  const isDryRun = operation === "dry_run";
  const category: CccWorkflowFeedCategory = isDryRun ? "dry-run" : "pipeline-run";
  const isGuardedCopy = operation === "guarded_copy";
  const feedFilterKeys: CccWorkflowFeedFilter[] = isDryRun
    ? ["dry-runs"]
    : isGuardedCopy && status === "complete"
      ? ["guarded-copy-completed"]
      : isGuardedCopy && status === "failed"
        ? ["guarded-copy-failures"]
        : status === "queued" || status === "running"
          ? ["queued-pipeline-runs"]
          : [];
  const processed = typeof data.processedObjectCount === "number" ? data.processedObjectCount : 0;
  const selected = typeof data.selectedObjectCount === "number" ? data.selectedObjectCount : null;
  const total = selected ?? (typeof counts.total === "number" ? counts.total : null);
  const eligible = typeof counts.eligible === "number" ? counts.eligible : 0;
  const shortCalls = typeof counts.shortCallReview === "number" ? counts.shortCallReview : 0;
  const issues = ["missingMapping", "invalidFormat", "likelyCorrupt", "copyFailed"]
    .reduce((sum, key) => sum + (typeof counts[key] === "number" ? Number(counts[key]) : 0), 0);
  const sampleSize = typeof request.sampleSize === "number" ? request.sampleSize : null;
  const totalText = total ?? sampleSize ?? "pending";
  const failedChunkErrors = compactStringArray(data.failedChunkErrors, 3);
  const cleanErrorMessage = cleanString(data.errorMessage);
  const errorText = failedChunkErrors.length > 0
    ? ` · errors: ${failedChunkErrors.join(" | ")}`
    : status === "failed" && cleanErrorMessage
      ? ` · error: ${cleanErrorMessage}`
      : "";
  return {
    id: `pipeline_${id}`,
    workflowEnvironment: environment,
    feedCategory: category,
    feedFilterKeys,
    eventTimestamp: data.updatedAt ?? data.completedAt ?? data.createdAt ?? null,
    pipelineRunId: id,
    runMode: mode,
    status,
    routingClass: isDryRun ? "dry-run" : operation,
    displayTitle: isDryRun ? "Dry run" : "Pipeline run",
    displayBody: `${mode} · ${operation} · ${status} · ${processed}/${totalText} processed · ${eligible} eligible · ${shortCalls} short · ${issues} issues${errorText}`,
  };
}

/** Documents the serializeWorkflowFeedDoc behavior. */
function serializeWorkflowFeedDoc(doc: FirebaseFirestore.QueryDocumentSnapshot): CccWorkflowFeedRow {
  const data = doc.data();
  const category = data.feedCategory as CccWorkflowFeedCategory;
  return {
    id: doc.id,
    organizationId: cleanString(data.organizationId) ?? CONSUBANCO_ORGANIZATION_ID,
    workflowEnvironment: inferWorkflowEnvironment({
      workflowEnvironment: cleanString(data.workflowEnvironment),
      sourceObjectPath: cleanString(data.sourceObjectPath),
      destinationObjectPath: cleanString(data.destinationObjectPath),
    }),
    feedCategory: category,
    feedFilterKeys: Array.isArray(data.feedFilterKeys) ? data.feedFilterKeys as CccWorkflowFeedFilter[] : filterKeysForCategory(category),
    isAttention: data.isAttention === true,
    severityRank: typeof data.severityRank === "number" ? data.severityRank : categorySeverityRank(category),
    eventTimestamp: timestampToIso(data.eventTimestamp) ?? new Date(0).toISOString(),
    callTimestamp: timestampToIso(data.callTimestamp) ?? cleanString(data.callTimestamp),
    callId: cleanString(data.callId),
    canonicalCallId: cleanString(data.canonicalCallId),
    pipelineRunId: cleanString(data.pipelineRunId),
    runMode: cleanString(data.runMode),
    salesAgentId: cleanString(data.salesAgentId),
    salesAgentName: cleanString(data.salesAgentName),
    sourceObjectPath: cleanString(data.sourceObjectPath),
    destinationObjectPath: cleanString(data.destinationObjectPath),
    status: cleanString(data.status),
    errorCode: cleanString(data.errorCode),
    routingClass: cleanString(data.routingClass),
    displayTitle: cleanString(data.displayTitle) ?? doc.id,
    displayBody: cleanString(data.displayBody) ?? "",
    detailPath: cleanString(data.detailPath),
  };
}

/** Documents the parseFeedRequest behavior. */
function parseFeedRequest(data: unknown, now: Date): Required<Omit<GetCccAutomaticWorkflowFeedRequest, "cursor">> & { cursor: CccWorkflowFeedCursor | null } {
  const input = data && typeof data === "object" ? data as GetCccAutomaticWorkflowFeedRequest : {};
  const filter = input.filter ?? "all-errors";
  const workflowEnvironment = normalizeWorkflowEnvironment(input.workflowEnvironment) ?? "testing";
  const allowedFilters: CccWorkflowFeedFilter[] = ["all-errors", "missing-mapping", "invalid-format", "likely-corrupt", "ingest-copy-failures", "runtime-errors", "short-call", "production-calls", "dry-runs", "guarded-copy-completed", "guarded-copy-failures", "queued-pipeline-runs"];
  if (!allowedFilters.includes(filter)) throw new HttpsError("invalid-argument", "Invalid workflow feed filter.");
  const pageSize = Math.min(Math.max(Number(input.pageSize ?? CCC_WORKFLOW_FEED_DEFAULT_PAGE_SIZE), 1), CCC_WORKFLOW_FEED_MAX_PAGE_SIZE);
  const startDate = input.startDate && isPlainDateKey(input.startDate) ? input.startDate : null;
  const endDate = input.endDate && isPlainDateKey(input.endDate) ? input.endDate : null;
  const snapshotBefore = cleanString(input.snapshotBefore) ?? now.toISOString();
  const cursor = input.cursor?.eventTimestamp && input.cursor.id ? input.cursor : null;
  return { filter, workflowEnvironment, startDate, endDate, pageSize, snapshotBefore, cursor };
}

/** Documents the compareWorkflowFeedRows behavior. */
function compareWorkflowFeedRows(left: CccWorkflowFeedRow, right: CccWorkflowFeedRow): number {
  const leftTime = new Date(left.eventTimestamp).getTime();
  const rightTime = new Date(right.eventTimestamp).getTime();
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.id.localeCompare(right.id);
}

/** Documents the rowIsAfterCursor behavior. */
function rowIsAfterCursor(row: CccWorkflowFeedRow, cursor: CccWorkflowFeedCursor | null): boolean {
  if (!cursor) return true;
  const rowTime = new Date(row.eventTimestamp).getTime();
  const cursorTime = new Date(cursor.eventTimestamp).getTime();
  if (rowTime < cursorTime) return true;
  if (rowTime > cursorTime) return false;
  return row.id > cursor.id;
}

/** Documents the rowMatchesDateWindow behavior. */
function rowMatchesDateWindow(row: CccWorkflowFeedRow, parsed: ReturnType<typeof parseFeedRequest>, snapshotBefore: string): boolean {
  const eventTime = new Date(row.eventTimestamp).getTime();
  if (Number.isNaN(eventTime)) return false;
  if (eventTime > new Date(snapshotBefore).getTime()) return false;
  if (parsed.startDate && eventTime < dateKeyToDate(parsed.startDate).getTime()) return false;
  if (parsed.endDate && eventTime >= dateKeyToDate(parsed.endDate, true).getTime()) return false;
  return true;
}

/** Documents the feedResultFromRows behavior. */
function feedResultFromRows(rows: CccWorkflowFeedRow[], pageSize: number): {
  rows: CccWorkflowFeedRow[];
  preloadRows: CccWorkflowFeedRow[];
  nextCursor: CccWorkflowFeedCursor | null;
  hasMore: boolean;
} {
  const visibleRows = rows.slice(0, pageSize);
  const preloadRows = rows.slice(pageSize, pageSize * 2);
  const returnedRows = [...visibleRows, ...preloadRows];
  const last = returnedRows[returnedRows.length - 1] ?? null;
  return {
    rows: visibleRows,
    preloadRows,
    nextCursor: last ? { eventTimestamp: last.eventTimestamp, id: last.id } : null,
    hasMore: rows.length > pageSize * 2,
  };
}

/** Documents the isIndexBuildError behavior. */
function isIndexBuildError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  const message = `${candidate.message ?? ""} ${candidate.details ?? ""}`.toLowerCase();
  return candidate.code === 9 && message.includes("index");
}

const CCC_WORKFLOW_FEED_FALLBACK_INITIAL_SCAN_LIMIT = 10;
const CCC_WORKFLOW_FEED_FALLBACK_MAX_SCAN_LIMIT = 1280;

/** Documents the queryWorkflowFeedFallback behavior. */
async function queryWorkflowFeedFallback(
  db: FirebaseFirestore.Firestore,
  parsed: ReturnType<typeof parseFeedRequest>,
  snapshotBefore: string
): Promise<CccWorkflowFeedRow[]> {
  const targetCount = parsed.pageSize * 2 + 1;
  let scanLimit = CCC_WORKFLOW_FEED_FALLBACK_INITIAL_SCAN_LIMIT;
  let bestRows: CccWorkflowFeedRow[] = [];

  while (scanLimit <= CCC_WORKFLOW_FEED_FALLBACK_MAX_SCAN_LIMIT) {
    const snapshot = await db.collection(CCC_WORKFLOW_FEED_COLLECTION)
      .where("organizationId", "==", CONSUBANCO_ORGANIZATION_ID)
      .where("feedFilterKeys", "array-contains", parsed.filter)
      .limit(scanLimit)
      .get();
    bestRows = snapshot.docs
      .map(serializeWorkflowFeedDoc)
      .filter((row) => row.workflowEnvironment === parsed.workflowEnvironment)
      .filter((row) => rowMatchesDateWindow(row, parsed, snapshotBefore))
      .sort(compareWorkflowFeedRows)
      .filter((row) => rowIsAfterCursor(row, parsed.cursor));
    if (bestRows.length >= targetCount || snapshot.docs.length < scanLimit) break;
    scanLimit *= 2;
  }

  return bestRows;
}

async function refreshPipelineRowsFromRuns(
  db: FirebaseFirestore.Firestore,
  rows: CccWorkflowFeedRow[]
): Promise<CccWorkflowFeedRow[]> {
  const runIds = [...new Set(rows
    .filter((row) => row.feedCategory === "pipeline-run")
    .map((row) => cleanString(row.pipelineRunId))
    .filter((runId): runId is string => Boolean(runId)))];
  if (runIds.length === 0) return rows;

  const runRows = new Map<string, CccWorkflowFeedSourceRow>();
  await Promise.all(runIds.map(async (runId) => {
    const runDoc = await db.collection(CCC_PIPELINE_RUNS_COLLECTION).doc(runId).get();
    if (!runDoc.exists) return;
    const row = workflowFeedRowFromPipelineRun(runId, runDoc.data() ?? {});
    if (row) runRows.set(runId, row);
  }));
  if (runRows.size === 0) return rows;

  return rows.map((row) => {
    if (row.feedCategory !== "pipeline-run") return row;
    const runId = cleanString(row.pipelineRunId);
    const refreshed = runId ? runRows.get(runId) : null;
    if (!refreshed) return row;
    return {
      ...row,
      workflowEnvironment: refreshed.workflowEnvironment ?? row.workflowEnvironment,
      feedCategory: refreshed.feedCategory,
      feedFilterKeys: refreshed.feedFilterKeys ?? row.feedFilterKeys,
      isAttention: isAttentionFeedRow(refreshed),
      severityRank: categorySeverityRank(refreshed.feedCategory),
      eventTimestamp: timestampToIso(refreshed.eventTimestamp) ?? row.eventTimestamp,
      pipelineRunId: refreshed.pipelineRunId ?? row.pipelineRunId,
      runMode: refreshed.runMode ?? row.runMode,
      status: refreshed.status ?? row.status,
      routingClass: refreshed.routingClass ?? row.routingClass,
      displayTitle: refreshed.displayTitle,
      displayBody: refreshed.displayBody,
    };
  });
}

/** Documents the handleGetCccAutomaticWorkflowFeed behavior. */
export async function handleGetCccAutomaticWorkflowFeed(
  request: CallableRequest<unknown>,
  dependencies: WorkflowFeedDependencies = defaultWorkflowFeedDependencies()
): Promise<GetCccAutomaticWorkflowFeedResponse> {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  await assertConsubancoAdmin(request.auth.uid, dependencies.db);
  const parsed = parseFeedRequest(request.data, dependencies.now());
  const snapshotBefore = parsed.snapshotBefore ?? dependencies.now().toISOString();
  let query: FirebaseFirestore.Query = dependencies.db.collection(CCC_WORKFLOW_FEED_COLLECTION)
    .where("organizationId", "==", CONSUBANCO_ORGANIZATION_ID)
    .where("workflowEnvironment", "==", parsed.workflowEnvironment)
    .where("feedFilterKeys", "array-contains", parsed.filter)
    .where("eventTimestamp", "<=", firestoreTimestampFromIso(snapshotBefore));
  if (parsed.startDate) query = query.where("eventTimestamp", ">=", timestampFromDate(dateKeyToDate(parsed.startDate)));
  if (parsed.endDate) query = query.where("eventTimestamp", "<", timestampFromDate(dateKeyToDate(parsed.endDate, true)));
  query = query.orderBy("eventTimestamp", "desc").orderBy(FieldPath.documentId(), "asc");
  if (parsed.cursor) query = query.startAfter(firestoreTimestampFromIso(parsed.cursor.eventTimestamp), parsed.cursor.id);
  let matchedRows: CccWorkflowFeedRow[];
  try {
    const snapshot = await query.limit(parsed.pageSize * 2 + 1).get();
    matchedRows = snapshot.docs.map(serializeWorkflowFeedDoc);
  } catch (error) {
    if (!isIndexBuildError(error)) throw error;
    matchedRows = await queryWorkflowFeedFallback(dependencies.db, parsed, snapshotBefore);
  }
  const refreshedRows = await refreshPipelineRowsFromRuns(dependencies.db, matchedRows);
  const page = feedResultFromRows(refreshedRows, parsed.pageSize);
  return {
    success: true,
    generatedAt: dependencies.now().toISOString(),
    snapshotBefore,
    filter: parsed.filter,
    workflowEnvironment: parsed.workflowEnvironment,
    rows: page.rows,
    preloadRows: page.preloadRows,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export const getCccAutomaticWorkflowFeed = onCall(
  /** Handles the callback for this operation. */
  async (request: CallableRequest<unknown>) => handleGetCccAutomaticWorkflowFeed(request)
);
