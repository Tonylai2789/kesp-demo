import * as admin from "firebase-admin";
import { createHash } from "crypto";
import { HttpsError, onCall, type CallableRequest } from "./demoHttps";
import { getProcessingGeneration } from "./callState";
import { resolveAnalyzerModel } from "./promptConfig";
import { calculateConversationMetrics, calculateOpenAiSegmentConversationMetrics, conversationRoleMapping, isOpenAiSegmentTranscript, unavailableConversationMetrics, type ConversationMetricsReport, type ConversationEvidence } from "./conversationMetrics";
import type { ConversationSpeedAdjustment } from "./conversationSpeedScoring";

export const CONVERSATION_METRICS_COLLECTION = "conversation_metrics";
export type ConversationMetricsIdentity = NonNullable<ConversationMetricsReport["identity"]>;
export type ConversationInterpretationStatus = "pending" | "queued" | "running" | "complete" | "failed" | "unavailable" | "not_requested";
export interface ConversationObservation {
  category: "speed" | "talk_balance" | "turn" | "response_gap" | "interruption_candidate" | "filler_candidate";
  text: string; evidenceIds: string[];
}
export interface ConversationMetricsDocument extends ConversationMetricsIdentity {
  callId: string; organizationId: "consubanco"; metrics: ConversationMetricsReport;
  analyzerModel: string; interpretationStatus: ConversationInterpretationStatus;
  observations: ConversationObservation[]; speedAdjustment: ConversationSpeedAdjustment | null;
  interpretationAttempts: number; leaseUntil: number; leaseToken: string | null;
}

/** Canonicalizes object keys so Firestore property ordering cannot invalidate the fingerprint. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical((value as Record<string, unknown>)[key]);
    return result;
  }
  return value === undefined ? null : value;
}

/** Hashes the exact immutable timeline, not display normalization or generated interpretation. */
export function conversationMetricsTranscriptHash(transcript: unknown, coreFields?: unknown, includeSegmentIdentity = true): string {
  const input = transcript && typeof transcript === "object" ? transcript as Record<string, unknown> : {};
  const identity = { provider: input.provider, model: input.model, schemaVersion: input.schemaVersion,
    processingGeneration: input.processingGeneration, audioIdentity: input.audioIdentity,
    transcriptId: input.transcriptId, duration: input.duration, words: input.words,
    legacyText: input.transcriptId ? null : input.text,
    ...(includeSegmentIdentity && isOpenAiSegmentTranscript(input) ? { segments: input.segments, roleMapping: conversationRoleMapping(coreFields),
      calculationVersion: "openai_segment_timing_v1" } : {}) };
  return createHash("sha256").update(JSON.stringify(canonical(identity))).digest("hex");
}

/** Validates document IDs before constructing Firestore paths. */
export function validConversationCallId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("/") && value !== "." && value !== "..";
}

/** Checks current call and canonical transcript identity without requiring inline word pages. */
export function conversationMetricsIdentityMatches(
  call: Record<string, unknown> | undefined,
  transcript: Record<string, unknown> | undefined,
  identity: ConversationMetricsIdentity
): boolean {
  if (!call || !transcript || call.status === "canceled" || call.organizationId !== "consubanco" ||
      getProcessingGeneration(call) !== identity.generation) return false;
  if (identity.calculationVersion === "openai_segment_timing_v1") {
    if (!identity.analysisRunId || (call.activeAnalysisRunId ?? call.lastTerminalRunId) !== identity.analysisRunId ||
        conversationMetricsTranscriptHash(transcript, { agent_speaker: identity.roleMapping?.agent,
          customer_speaker: identity.roleMapping?.customer }) !== identity.transcriptHash) return false;
  }
  if (identity.transcriptId) {
    return transcript.transcriptId === identity.transcriptId && transcript.audioIdentity === identity.audioIdentity &&
      transcript.provider === identity.provider && transcript.model === identity.model &&
      transcript.processingGeneration === identity.transcriptGeneration && identity.transcriptGeneration <= identity.generation &&
      (call.transcriptionTranscriptId === undefined || call.transcriptionTranscriptId === identity.transcriptId) &&
      (call.transcriptionAudioIdentity === undefined || call.transcriptionAudioIdentity === identity.audioIdentity);
  }
  // Segment fingerprints (including roles) were already verified above; missing IDs keep evidence unavailable.
  if (identity.calculationVersion === "openai_segment_timing_v1") return true;
  return conversationMetricsTranscriptHash(transcript, undefined, false) === identity.transcriptHash;
}

/** Rechecks immutable segment content and the current run's authoritative speaker-role output. */
export async function conversationMetricsSourceMatches(
  transaction: FirebaseFirestore.Transaction, callRef: FirebaseFirestore.DocumentReference,
  call: Record<string, unknown> | undefined, transcript: Record<string, unknown> | undefined,
  identity: ConversationMetricsIdentity
): Promise<boolean> {
  if (!conversationMetricsIdentityMatches(call, transcript, identity)) return false;
  if (identity.calculationVersion !== "openai_segment_timing_v1") return true;
  // Firestore reads the exact finalizer run's core-fields task, never cached feedback roles.
  const runRef = callRef.collection("analysis_runs").doc(identity.analysisRunId!);
  const run = await transaction.get(runRef);
  const core = await transaction.get(runRef.collection("tasks").doc("core_fields"));
  return run.exists && getProcessingGeneration(run.data()) === identity.generation && core.data()?.status === "complete" &&
    JSON.stringify(canonical(conversationRoleMapping(core.data()?.output))) === JSON.stringify(canonical(identity.roleMapping));
}

/** Matches a restricted root with the report being consumed or finalized. */
export function conversationMetricsDocumentMatches(value: Record<string, unknown> | undefined, identity: ConversationMetricsIdentity): boolean {
  return !!value && value.generation === identity.generation && value.transcriptHash === identity.transcriptHash &&
    value.transcriptGeneration === identity.transcriptGeneration &&
    value.audioIdentity === identity.audioIdentity && value.transcriptId === identity.transcriptId &&
    value.provider === identity.provider && value.model === identity.model &&
    value.analysisRunId === identity.analysisRunId && value.calculationVersion === identity.calculationVersion &&
    JSON.stringify(canonical(value.roleMapping)) === JSON.stringify(canonical(identity.roleMapping));
}

/** Bounds reviewer payloads while retaining exact aggregates and canonical source references. */
export function projectConversationMetricsForStorage(callId: string, report: ConversationMetricsReport): ConversationMetricsReport {
  /** Marks every row-level truncation instead of implying a complete quote or word list. */
  const row = <T extends ConversationEvidence>(value: T): T => ({ ...value,
    text: value.text.slice(0, 600), evidenceIds: value.evidenceIds.slice(0, 40),
    textTruncated: value.text.length > 600, evidenceIdsTruncated: value.evidenceIds.length > 40 });
  const segments = report.segments.slice(0, 60);
  const fast = report.segments.find(/** Keeps explicit evidence for a speed deduction even late in a long call. */ (s) => s.tooFast === true);
  if (fast && !segments.includes(fast)) segments.push(fast);
  const projection: ConversationMetricsReport = { ...report, words: [],
    ...(report.timingSource === "segment" ? { segmentEvidenceLocation: `calls/${callId}/transcript` }
      : { wordEvidenceLocation: `calls/${callId}/transcript` }),
    segments: segments.map(row), interruptions: report.interruptions.slice(0, 60).map(row),
    gaps: report.gaps.slice(0, 60).map(row), fillers: report.fillers.slice(0, 60).map(row),
    evidenceTotals: { words: report.words.length, segments: report.segments.length,
      interruptions: report.interruptions.length, gaps: report.gaps.length, fillers: report.fillers.length },
    evidenceTruncated: report.words.length > 0 || report.segments.length > segments.length ||
      report.interruptions.length > 60 || report.gaps.length > 60 || report.fillers.length > 60 };
  // Long IDs/non-ASCII text can cost more bytes than typical transcripts: shrink rows, never aggregates.
  while (Buffer.byteLength(JSON.stringify(projection), "utf8") > 500 * 1024) {
    projection.segments = projection.segments.slice(0, Math.max(1, Math.floor(projection.segments.length / 2)));
    if (fast && !projection.segments.some(/** Retains at least one auditable penalty span. */ (s) => s.id === fast.id)) projection.segments.push(row(fast));
    projection.interruptions = projection.interruptions.slice(0, Math.floor(projection.interruptions.length / 2));
    projection.gaps = projection.gaps.slice(0, Math.floor(projection.gaps.length / 2));
    projection.fillers = projection.fillers.slice(0, Math.floor(projection.fillers.length / 2));
    projection.evidenceTruncated = true;
  }
  return projection;
}

/** Calculates and persists restricted deterministic evidence before rubric finalization. */
export async function ensureConversationMetrics(
  callId: string, callData: Record<string, unknown>, transcript: unknown,
  firestore: FirebaseFirestore.Firestore = admin.firestore(),
  analysis?: { runId: string; coreFields: unknown; limitation?: string }
): Promise<ConversationMetricsReport | null> {
  if (!validConversationCallId(callId) || callData.organizationId !== "consubanco") return null;
  const source = transcript && typeof transcript === "object" ? transcript as Record<string, unknown> : {};
  const segmentMode = isOpenAiSegmentTranscript(source);
  if (segmentMode && (!analysis || !validConversationCallId(analysis.runId))) return null;
  const identity: ConversationMetricsIdentity = { generation: getProcessingGeneration(callData),
    transcriptGeneration: getProcessingGeneration(source),
    transcriptHash: conversationMetricsTranscriptHash(source, analysis?.coreFields),
    audioIdentity: typeof source.audioIdentity === "string" ? source.audioIdentity : null,
    transcriptId: typeof source.transcriptId === "string" ? source.transcriptId : null,
    provider: typeof source.provider === "string" ? source.provider : null,
    model: typeof source.model === "string" ? source.model : null,
    ...(segmentMode ? { analysisRunId: analysis!.runId, roleMapping: conversationRoleMapping(analysis!.coreFields),
      calculationVersion: "openai_segment_timing_v1" as const } : {}) };
  let metrics = segmentMode ? calculateOpenAiSegmentConversationMetrics(source, analysis!.coreFields) : calculateConversationMetrics(source);
  if (metrics.status !== "unavailable" && (!identity.transcriptId || !identity.audioIdentity)) {
    metrics = { ...metrics, ...unavailableConversationMetrics("missing_transcript_identity"),
      timingSource: metrics.timingSource, calculationVersion: metrics.calculationVersion, limitations: metrics.limitations };
  }
  if (segmentMode && analysis?.limitation) metrics.limitations.push(analysis.limitation);
  metrics.identity = identity;
  const callRef = firestore.collection("calls").doc(callId);
  const metricsRef = firestore.collection(CONVERSATION_METRICS_COLLECTION).doc(callId);
  /** Reads current identities and atomically preserves completed same-generation interpretation. */
  return firestore.runTransaction(/** Refuses stale work before any write. */ async (transaction) => {
    const call = await transaction.get(callRef);
    const timeline = await transaction.get(callRef.collection("transcript").doc("data"));
    const existing = await transaction.get(metricsRef);
    if (!await conversationMetricsSourceMatches(transaction, callRef, call.data(), timeline.data(), identity)) return null;
    if (conversationMetricsDocumentMatches(existing.data(), identity)) return existing.data()!.metrics as ConversationMetricsReport;
    const document: ConversationMetricsDocument = { ...identity, callId, organizationId: "consubanco",
      metrics: projectConversationMetricsForStorage(callId, metrics),
      analyzerModel: resolveAnalyzerModel(callData.analyzerModel),
      interpretationStatus: source.provider === "openai" ? "not_requested" : metrics.status === "unavailable" ? "unavailable" : "pending",
      observations: [], speedAdjustment: null, interpretationAttempts: 0, leaseUntil: 0, leaseToken: null };
    transaction.set(metricsRef, { ...document, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return metrics;
  });
}

/** Stores a finalizer audit only beside the exact current deterministic evidence. */
export async function persistConversationSpeedAdjustment(
  callId: string, expectedGeneration: number, metrics: ConversationMetricsReport,
  adjustment: ConversationSpeedAdjustment | null, firestore: FirebaseFirestore.Firestore = admin.firestore()
): Promise<boolean> {
  const identity = metrics.identity;
  if (!validConversationCallId(callId) || !identity || identity.generation !== expectedGeneration) return false;
  const callRef = firestore.collection("calls").doc(callId);
  const metricsRef = firestore.collection(CONVERSATION_METRICS_COLLECTION).doc(callId);
  /** Rechecks cancellation and both transcript and metrics identities atomically with the audit write. */
  return firestore.runTransaction(/** Saves no audit for superseded calculations. */ async (transaction) => {
    const call = await transaction.get(callRef);
    const timeline = await transaction.get(callRef.collection("transcript").doc("data"));
    const existing = await transaction.get(metricsRef);
    if (!await conversationMetricsSourceMatches(transaction, callRef, call.data(), timeline.data(), identity) ||
        !conversationMetricsDocumentMatches(existing.data(), identity)) return false;
    transaction.update(metricsRef, { speedAdjustment: adjustment, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  });
}

/** Authenticates membership before returning any restricted call evidence. */
export async function getConversationMetricsHandler(
  request: Pick<CallableRequest, "auth" | "data">, firestore: FirebaseFirestore.Firestore = admin.firestore()
): Promise<ConversationMetricsDocument | null> {
  if (!request.auth) throw new HttpsError("unauthenticated", "Authentication required.");
  const callId: unknown = request.data?.callId;
  if (!validConversationCallId(callId)) throw new HttpsError("invalid-argument", "A valid callId is required.");
  /** Reads organization membership, call boundary, and restricted root in one consistent snapshot. */
  return firestore.runTransaction(/** Denies agents and cross-organization reads before returning metrics. */ async (transaction) => {
    const member = await transaction.get(firestore.collection("organizations").doc("consubanco").collection("members").doc(request.auth!.uid));
    const role = member.data()?.role;
    if (role !== "admin" && role !== "supervisor") throw new HttpsError("permission-denied", "Supervisor access required.");
    const callRef = firestore.collection("calls").doc(callId);
    const call = await transaction.get(callRef);
    if (!call.exists || call.data()?.organizationId !== "consubanco") throw new HttpsError("permission-denied", "Call is not in your organization.");
    const callData = call.data()!;
    const reviewers: unknown = callData.reviewerUserIds;
    const canReadCall = callData.visibilityScope === "organization" || callData.uploadedBy === request.auth!.uid ||
      (Array.isArray(reviewers) && reviewers.includes(request.auth!.uid));
    if (!canReadCall) throw new HttpsError("permission-denied", "Call access required.");
    const root = await transaction.get(firestore.collection(CONVERSATION_METRICS_COLLECTION).doc(callId));
    const timeline = await transaction.get(callRef.collection("transcript").doc("data"));
    if (!root.exists) return null;
    const data = root.data() as ConversationMetricsDocument;
    if (data.organizationId !== "consubanco" || !await conversationMetricsSourceMatches(transaction, callRef, call.data(), timeline.data(), data)) return null;
    if (data.interpretationStatus === "running" && data.leaseUntil <= Date.now()) {
      return { ...data, interpretationStatus: "failed" };
    }
    return data;
  });
}

export const getConversationMetrics = onCall({ invoker: "public" },
  /** Routes the callable through server-side organization authorization. */ async (request) => getConversationMetricsHandler(request));
