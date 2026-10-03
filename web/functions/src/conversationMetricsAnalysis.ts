import { createDemoOpenAI } from './demoPaidProviders';
import * as admin from "firebase-admin";
import { analyzerRequestOptions } from "./analyzerRequestOptions";
import { getFunctions } from "firebase-admin/functions";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { OPENAI_API_KEY_SECRET } from "./secrets";
import { sanitizeSubagentOutputForFirestore } from "./firestoreOutputSanitizer";
import { isSupportedAnalyzerModel, CONVERSATION_METRICS_PROMPT } from "./promptConfig";
import type { ConversationMetricsReport } from "./conversationMetrics";
import {
  CONVERSATION_METRICS_COLLECTION, conversationMetricsDocumentMatches, conversationMetricsSourceMatches,
  validConversationCallId, type ConversationMetricsDocument, type ConversationObservation,
} from "./conversationMetricsStore";

export interface ConversationMetricsTaskPayload { callId: string; generation: number; transcriptHash: string }
export { CONVERSATION_METRICS_PROMPT } from "./promptConfig";
export const CONVERSATION_METRICS_TASK_OPTIONS = {
  timeoutSeconds: 540, memory: "512MiB" as const, secrets: [OPENAI_API_KEY_SECRET],
  retryConfig: { maxAttempts: 3, minBackoffSeconds: 30, maxBackoffSeconds: 120 },
  rateLimits: { maxConcurrentDispatches: 2, maxDispatchesPerSecond: 1 },
};
const MAX_ATTEMPTS = 3;

/** Builds bounded immutable model input from the restricted evidence projection, not raw provider output. */
export function buildConversationMetricsInterpretationInput(callId: string, metrics: ConversationMetricsReport) {
  return { call_id: callId, schemaVersion: metrics.schemaVersion, method: metrics.method, status: metrics.status,
    calculationVersion: metrics.calculationVersion ?? "legacy", coverage: metrics.coverage,
    availability: metrics.availability, summary: metrics.summary, limitations: metrics.limitations,
    segments: metrics.segments.filter(/** Never ask the interpreter to assess excluded timing. */ (segment) => !segment.timingExcluded),
    interruptions: metrics.interruptions, gaps: metrics.gaps, fillers: metrics.fillers,
    evidenceTruncated: metrics.evidenceTruncated === true };
}

/** Rejects malformed output and references not present in the model's bounded input. */
export function validateConversationMetricsObservations(
  callId: string, output: unknown, metrics: ConversationMetricsReport
): ConversationObservation[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("invalid_metrics_output");
  const data = output as Record<string, unknown>;
  if (data.call_id !== callId || !Array.isArray(data.observations) || data.observations.length > 20 ||
      Object.keys(data).some(/** Rejects model-authored measurements and extra output fields. */ (key) => !["call_id", "observations"].includes(key))) {
    throw new Error("invalid_metrics_output");
  }
  const retainedSegments = metrics.segments.filter(/** Reject excluded evidence even if a model invents its ID. */ (segment) => !segment.timingExcluded);
  const categories = {
    speed: retainedSegments.filter(/** Speed claims require qualifying agent evidence. */ (segment) => segment.speedEligible),
    talk_balance: retainedSegments, turn: retainedSegments.filter(/** Turn coaching is agent-scoped. */ (segment) => segment.role === "agent"),
    response_gap: metrics.gaps, interruption_candidate: metrics.interruptions, filler_candidate: metrics.fillers,
  };
  const availability = {
    speed: metrics.availability.speed, talk_balance: metrics.availability.talkBalance,
    turn: metrics.availability.turns, response_gap: metrics.availability.gaps,
    interruption_candidate: metrics.availability.interruptions, filler_candidate: metrics.availability.fillers,
  };
  const observations: ConversationObservation[] = [];
  for (const value of data.observations) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_metrics_observation");
    const row = value as Record<string, unknown>;
    if (typeof row.category !== "string" || !Object.hasOwn(categories, row.category) ||
        typeof row.text !== "string" || !row.text.trim() || row.text.length > 600 ||
        !Array.isArray(row.evidenceIds) || row.evidenceIds.length < 1 || row.evidenceIds.length > 8 ||
        Object.keys(row).some(/** Rejects any extra observation fields. */ (key) => !["category", "text", "evidenceIds"].includes(key))) {
      throw new Error("invalid_metrics_observation");
    }
    const category = row.category as ConversationObservation["category"];
    if (!availability[category].available) throw new Error("invalid_metrics_evidence");
    const ids = new Set(categories[category].map(/** Allows only supplied evidence-row IDs for the selected feature. */ (e) => e.id));
    if (row.evidenceIds.some(/** Rejects invented or omitted references. */ (id) => typeof id !== "string" || !ids.has(id))) {
      throw new Error("invalid_metrics_evidence");
    }
    observations.push({ category, text: row.text.trim(), evidenceIds: [...new Set(row.evidenceIds as string[])] });
  }
  return sanitizeSubagentOutputForFirestore(observations).output as ConversationObservation[];
}

/** Queues optional interpretation separately so enqueue failures never erase deterministic metrics. */
export async function enqueueConversationMetricsInterpretation(
  callId: string, firestore: FirebaseFirestore.Firestore = admin.firestore()
): Promise<boolean> {
  if (!validConversationCallId(callId)) return false;
  const ref = firestore.collection(CONVERSATION_METRICS_COLLECTION).doc(callId);
  const callRef = firestore.collection("calls").doc(callId);
  /** Claims a current pending interpretation with its immutable analyzer snapshot. */
  const document = await firestore.runTransaction(/** Validates source identity before dispatch. */ async (transaction) => {
    const root = await transaction.get(ref);
    const call = await transaction.get(callRef);
    const timeline = await transaction.get(callRef.collection("transcript").doc("data"));
    const data = root.data() as ConversationMetricsDocument | undefined;
    if (!data || data.provider === "openai" || timeline.data()?.provider === "openai" || data.interpretationStatus !== "pending" || !await conversationMetricsSourceMatches(transaction, callRef, call.data(), timeline.data(), data)) return null;
    transaction.update(ref, { interpretationStatus: "queued", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return data;
  });
  if (!document) return false;
  const payload: ConversationMetricsTaskPayload = { callId, generation: document.generation, transcriptHash: document.transcriptHash };
  const id = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  try {
    /** Calls Cloud Tasks with deterministic identity and a single bounded worker retry budget. */
    await getFunctions().taskQueue<ConversationMetricsTaskPayload>("processConversationMetricsTask").enqueue(payload, {
      id: `metrics-${id}`, dispatchDeadlineSeconds: 540,
    });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "functions/task-already-exists") return true;
    /** Records dispatch failure explicitly; it must not remain indefinitely pending after finalization. */
    await firestore.runTransaction(/** Does not reset a newer or already running task. */ async (transaction) => {
      const current = await transaction.get(ref);
      if (conversationMetricsDocumentMatches(current.data(), document) && current.data()?.interpretationStatus === "queued") {
        transaction.update(ref, { interpretationStatus: "failed", interpretationError: "enqueue_failed" });
      }
    });
    return false;
  }
}

/** Runs a bounded, idempotent interpretation attempt isolated from the rubric task graph. */
export async function runConversationMetricsAnalysisTask(
  payload: ConversationMetricsTaskPayload, firestore: FirebaseFirestore.Firestore = admin.firestore()
): Promise<void> {
  if (!payload || !validConversationCallId(payload.callId) || !Number.isInteger(payload.generation) ||
      typeof payload.transcriptHash !== "string") return;
  const ref = firestore.collection(CONVERSATION_METRICS_COLLECTION).doc(payload.callId);
  const callRef = firestore.collection("calls").doc(payload.callId);
  const token = randomUUID();
  /** Claims a lease while rejecting canceled, superseded, exhausted, and completed tasks. */
  const document = await firestore.runTransaction(/** Atomically claims only matching identity. */ async (transaction) => {
    const root = await transaction.get(ref);
    const call = await transaction.get(callRef);
    const timeline = await transaction.get(callRef.collection("transcript").doc("data"));
    const data = root.data() as ConversationMetricsDocument | undefined;
    if (!data || data.provider === "openai" || timeline.data()?.provider === "openai" || data.generation !== payload.generation || data.transcriptHash !== payload.transcriptHash ||
        !await conversationMetricsSourceMatches(transaction, callRef, call.data(), timeline.data(), data) ||
        ["complete", "unavailable", "not_requested"].includes(data.interpretationStatus)) return null;
    if (data.interpretationAttempts >= MAX_ATTEMPTS) {
      if (data.interpretationStatus === "running" && data.leaseUntil <= Date.now()) {
        transaction.update(ref, { interpretationStatus: "failed", interpretationError: "attempts_exhausted", leaseToken: null, leaseUntil: 0 });
      }
      return null;
    }
    if (data.interpretationStatus === "running" && data.leaseUntil > Date.now()) throw new Error("metrics_interpretation_lease_active");
    transaction.update(ref, { interpretationStatus: "running", leaseToken: token,
      leaseUntil: Date.now() + 480000, interpretationAttempts: data.interpretationAttempts + 1 });
    return data;
  });
  if (!document) return;
  /** Finishes only the attempt that still owns the current transcript lease. */
  const finish = async (fields: Record<string, unknown>): Promise<void> => {
    /** Rechecks source and root identity after model execution, before persisting any output. */
    await firestore.runTransaction(/** Prevents canceled or superseded inference output from landing. */ async (transaction) => {
      const root = await transaction.get(ref);
      const call = await transaction.get(callRef);
      const timeline = await transaction.get(callRef.collection("transcript").doc("data"));
      if (!conversationMetricsDocumentMatches(root.data(), document) || root.data()?.leaseToken !== token ||
          !await conversationMetricsSourceMatches(transaction, callRef, call.data(), timeline.data(), document)) return;
      transaction.update(ref, { ...fields, leaseToken: null, leaseUntil: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
  };
  try {
    if (!isSupportedAnalyzerModel(document.analyzerModel)) throw new Error("invalid_metrics_analyzer_snapshot");
    const prompt = fs.readFileSync(path.join(__dirname, CONVERSATION_METRICS_PROMPT), "utf8");
    const input = buildConversationMetricsInterpretationInput(payload.callId, document.metrics);
    const openai = createDemoOpenAI({ purpose: 'conversation_metrics' });
    /** Calls the call's snapshotted analyzer once; Cloud Tasks owns the bounded retry policy. */
    const response = await openai.chat.completions.create({ model: document.analyzerModel,
      ...analyzerRequestOptions(document.analyzerModel, null),
      messages: [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(input) }],
      response_format: { type: "json_object" }, max_completion_tokens: 4000 });
    const output = JSON.parse(response.choices[0]?.message?.content ?? "null");
    const observations = validateConversationMetricsObservations(payload.callId, output, document.metrics);
    await finish({ interpretationStatus: "complete", observations, interpretationError: null, interpretationPrompt: CONVERSATION_METRICS_PROMPT });
  } catch (error) {
    await finish({ interpretationStatus: "failed", interpretationError: "interpretation_failed" });
    throw error;
  }
}
