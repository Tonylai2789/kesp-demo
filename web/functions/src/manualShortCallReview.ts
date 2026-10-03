import { createDemoOpenAI } from './demoPaidProviders';
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onPaidCall as onCall, type CallableRequest } from "./demoHttps";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { analyzerRequestOptions } from "./analyzerRequestOptions";
import * as fs from "fs";
import * as path from "path";
import { serializeCallError } from "./analysisErrors";
import {
  buildCallErrorUpdate,
  buildClearCallErrorUpdate,
  getProcessingGeneration,
} from "./callState";
import {
  DEFAULT_ANALYZER_MODEL,
  MANUAL_SHORT_CALL_CONSOLIDATOR_TASK_ID,
  MANUAL_SHORT_CALL_INITIAL_TASK_IDS,
  MANUAL_SHORT_CALL_REVIEW_PROMPTS,
  MANUAL_SHORT_CALL_REVIEW_TASK_IDS,
  resolveAnalyzerModel,
  type ManualShortCallReviewTaskId,
} from "./promptConfig";
import { upsertCccWorkflowFeedRow, workflowFeedRowFromCall } from "./cccWorkflowFeed";
import { sanitizeSubagentOutputForFirestore } from "./firestoreOutputSanitizer";
import {
  buildShortCallQualityResult,
  type ShortCallDurationBucket,
  type ShortCallEvaluableDepth,
  type ShortCallQualityBand,
  type ShortCallQualityScorecard,
} from "./shortCallQuality";

export const MANUAL_SHORT_CALL_THRESHOLD_SECONDS = 90;
export const MANUAL_SHORT_CALL_MINIMUM_SECONDS = 30;
export const MANUAL_SHORT_CALL_ANALYSIS_PIPELINE = "manual_short_call_review";
export const MANUAL_SHORT_CALL_REVIEW_SCHEMA_VERSION = "manual_short_call_review_v2";
export const MANUAL_SHORT_CALL_PATTERNS_COLLECTION = "manual_short_call_patterns";
export const AUTOMATIC_CCC_SHORT_CALL_REVIEW_SOURCE = "automatic_ccc_gcs";
export const MANUAL_SHORT_CALL_REVIEW_SOURCE = "manual_upload";

const CONTACT_STATUS_VALUES = [
  "customer_reached",
  "voicemail",
  "ivr",
  "silence",
  "wrong_number",
  "unknown",
] as const;

const QUICK_END_REASON_VALUES = [
  "no_answer",
  "voicemail",
  "ivr_or_automated_system",
  "customer_hung_up",
  "customer_declined",
  "wrong_number",
  "agent_ended_early",
  "audio_or_line_issue",
  "callback_or_transfer",
  "already_resolved",
  "do_not_call",
  "unknown",
] as const;

const AGENT_CONCERN_VALUES = [
  "none",
  "possible_premature_end",
  "protocol_gap",
  "compliance_risk",
  "audio_quality_issue",
  "not_enough_information",
] as const;

const RUBRIC_CHECK_IDS = [
  "greeting",
  "agent_identity",
  "company_or_purpose",
  "customer_availability_or_identity_attempt",
  "professional_tone",
  "respectful_ending",
] as const;

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

export type ManualShortCallContactStatus = typeof CONTACT_STATUS_VALUES[number];
export type ManualShortCallQuickEndReason = typeof QUICK_END_REASON_VALUES[number];
export type ManualShortCallAgentConcern = typeof AGENT_CONCERN_VALUES[number];
export type ManualShortCallRubricCheckId = typeof RUBRIC_CHECK_IDS[number];

export interface ManualShortCallEvidenceItem {
  quote: string;
  speaker_label?: string;
  speaker_display?: string;
  start_seconds?: number | null;
  end_seconds?: number | null;
}

export interface ManualShortCallRubricCheck {
  id: ManualShortCallRubricCheckId;
  label: string;
  status: "met" | "missed" | "not_observable";
  rationale: string;
}

export interface ManualShortCallReviewDocument {
  schemaVersion: typeof MANUAL_SHORT_CALL_REVIEW_SCHEMA_VERSION;
  callId: string;
  analysisPipeline: typeof MANUAL_SHORT_CALL_ANALYSIS_PIPELINE;
  minimumSeconds: number;
  thresholdSeconds: number;
  durationSeconds: number | null;
  contactStatus: ManualShortCallContactStatus;
  quickEndReason: ManualShortCallQuickEndReason;
  startCallRubricChecks: ManualShortCallRubricCheck[];
  agentConcern: ManualShortCallAgentConcern;
  agentConcernSummary: string;
  agentConcernEvidence: ManualShortCallEvidenceItem[];
  confidenceScore: number;
  qualityScore: number | null;
  qualityBand: ShortCallQualityBand;
  durationBucket: ShortCallDurationBucket;
  evaluableDepth: ShortCallEvaluableDepth;
  qualityScorecard: ShortCallQualityScorecard;
  promptPaths: Record<string, string>;
  sourceTaskOutputs: Record<string, unknown>;
}

interface ManualShortCallPatternAgentStats {
  salesAgentId: string;
  salesAgentName: string;
  totalShortCalls: number;
  contactStatusCounts: Record<string, number>;
  quickEndReasonCounts: Record<string, number>;
  agentConcernCounts: Record<string, number>;
  qualityBandCounts: Record<string, number>;
  durationBucketCounts: Record<string, number>;
  evaluableDepthCounts: Record<string, number>;
  scoredShortCalls: number;
  averageQualityScore: number | null;
  concernRate: number;
}

interface ManualShortCallPatternSummary {
  uploadedBy: string;
  schemaVersion: string;
  totalShortCalls: number;
  agentCount: number;
  generatedAtIso: string;
  contactStatusCounts: Record<string, number>;
  quickEndReasonCounts: Record<string, number>;
  agentConcernCounts: Record<string, number>;
  qualityBandCounts: Record<string, number>;
  durationBucketCounts: Record<string, number>;
  evaluableDepthCounts: Record<string, number>;
  scoredShortCalls: number;
  averageQualityScore: number | null;
  agentStats: ManualShortCallPatternAgentStats[];
}

/** Documents the isManualShortCallReviewTaskId behavior. */
function isManualShortCallReviewTaskId(taskId: string): taskId is ManualShortCallReviewTaskId {
  return (MANUAL_SHORT_CALL_REVIEW_TASK_IDS as readonly string[]).includes(taskId);
}

/** Documents the isShortCallReviewEligibleSource behavior. */
function isShortCallReviewEligibleSource(callData: FirebaseFirestore.DocumentData): boolean {
  return callData.callSource === "manual_upload" || callData.callSource === "ccc_gcs";
}

/** Documents the shortCallReviewSourceForCall behavior. */
function shortCallReviewSourceForCall(callData: FirebaseFirestore.DocumentData): string {
  return callData.callSource === "ccc_gcs"
    ? AUTOMATIC_CCC_SHORT_CALL_REVIEW_SOURCE
    : MANUAL_SHORT_CALL_REVIEW_SOURCE;
}

/** Documents the shouldRouteToManualShortCallReview behavior. */
export function shouldRouteToManualShortCallReview(
  callData: FirebaseFirestore.DocumentData,
  durationSeconds: unknown
): boolean {
  return isShortCallReviewEligibleSource(callData) &&
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds >= 0 &&
    durationSeconds >= MANUAL_SHORT_CALL_MINIMUM_SECONDS &&
    durationSeconds < MANUAL_SHORT_CALL_THRESHOLD_SECONDS;
}

/** Documents the buildManualShortCallAnalysisFields behavior. */
export function buildManualShortCallAnalysisFields(
  callData: FirebaseFirestore.DocumentData,
  durationSeconds: number
): Record<string, unknown> {
  if (!shouldRouteToManualShortCallReview(callData, durationSeconds)) return {};
  return {
    analysisPipeline: MANUAL_SHORT_CALL_ANALYSIS_PIPELINE,
    shortCallReviewStatus: "pending",
    shortCallReviewSource: shortCallReviewSourceForCall(callData),
    shortCallMinimumSeconds: MANUAL_SHORT_CALL_MINIMUM_SECONDS,
    shortCallThresholdSeconds: MANUAL_SHORT_CALL_THRESHOLD_SECONDS,
  };
}

/** Documents the upsertAutomaticShortCallReviewState behavior. */
async function upsertAutomaticShortCallReviewState(params: {
  callId: string;
  callData: FirebaseFirestore.DocumentData;
  reviewStatus: "pending" | "running" | "complete" | "error";
  review?: Partial<ManualShortCallReviewDocument>;
}): Promise<void> {
  if (params.callData.callSource !== "ccc_gcs") return;
  const canonicalCallId = typeof params.callData.cccCanonicalCallId === "string" && params.callData.cccCanonicalCallId.trim()
    ? params.callData.cccCanonicalCallId.trim()
    : typeof params.callData.canonicalCallId === "string" && params.callData.canonicalCallId.trim()
      ? params.callData.canonicalCallId.trim()
      : params.callId;
  const sourceObjectPath = typeof params.callData.sourceObjectPath === "string" ? params.callData.sourceObjectPath : null;
  const durationSeconds = typeof params.callData.duration === "number" && Number.isFinite(params.callData.duration)
    ? params.callData.duration
    : params.review?.durationSeconds ?? null;
  const record = {
    callId: params.callId,
    canonicalCallId,
    sourceBucket: typeof params.callData.sourceBucket === "string" ? params.callData.sourceBucket : null,
    sourceObjectPath,
    originalLandingObjectPath: sourceObjectPath,
    productionRoutingClass: "short-call",
    durationSeconds,
    salesAgentId: typeof params.callData.salesAgentId === "string" ? params.callData.salesAgentId : null,
    salesAgentName: typeof params.callData.salesAgentName === "string" ? params.callData.salesAgentName : null,
    cccUserId: typeof params.callData.cccUserId === "string" ? params.callData.cccUserId : null,
    cccCallId: typeof params.callData.cccCallId === "string" ? params.callData.cccCallId : null,
    cccCallTimestamp: typeof params.callData.cccCallTimestamp === "string" ? params.callData.cccCallTimestamp : null,
    pipelineRunId: typeof params.callData.pipelineRunId === "string" ? params.callData.pipelineRunId : null,
    reviewStatus: params.reviewStatus,
    contactDetected: params.review?.contactStatus ?? "unknown",
    quickEndReason: params.review?.quickEndReason ?? "unknown",
    agentConcern: params.review?.agentConcern ?? "not_enough_information",
    qualityScore: params.review?.qualityScore ?? null,
    qualityBand: params.review?.qualityBand ?? "not_scorable",
    durationBucket: params.review?.durationBucket ?? null,
    evaluableDepth: params.review?.evaluableDepth ?? null,
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  };
  await db.collection("ccc_short_call_review").doc(canonicalCallId).set(record, { merge: true });
  const feedRow = workflowFeedRowFromCall(params.callId, {
    ...params.callData,
    ...record,
    status: params.reviewStatus === "complete" ? "complete" : params.reviewStatus === "error" ? "error" : "analyzing",
    analysisPipeline: MANUAL_SHORT_CALL_ANALYSIS_PIPELINE,
    shortCallReviewStatus: params.reviewStatus,
    shortCallReviewSource: AUTOMATIC_CCC_SHORT_CALL_REVIEW_SOURCE,
    updatedAt: FieldValue.serverTimestamp(),
  });
  if (feedRow) await upsertCccWorkflowFeedRow(db, feedRow);
}

/** Documents the dispatchManualShortCallReview behavior. */
export async function dispatchManualShortCallReview(callId: string): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection("calls").doc(callId);
  const callDoc = await callRef.get();
  const callData = callDoc.data();
  if (!callDoc.exists || !callData) throw new Error(`Call ${callId} not found`);
  if (callData.analysisPipeline !== MANUAL_SHORT_CALL_ANALYSIS_PIPELINE) {
    throw new Error(`Call ${callId} is not marked for manual short-call review`);
  }

  const existingRunId = typeof callData.activeShortCallReviewRunId === "string"
    ? callData.activeShortCallReviewRunId
    : null;
  if (existingRunId) {
    const existingRun = await callRef.collection("short_call_review_runs").doc(existingRunId).get();
    if (existingRun.exists && existingRun.data()?.status === "running") {
      console.log(`Skipping short-call dispatch: active run ${existingRunId} already exists for ${callId}`);
      return;
    }
  }

  const runId = `short_call_review_${Date.now()}`;
  const runRef = callRef.collection("short_call_review_runs").doc(runId);
  const analyzerModel = resolveAnalyzerModel(callData.analyzerModel ?? DEFAULT_ANALYZER_MODEL);
  const processingGeneration = getProcessingGeneration(callData);

  await runRef.set({
    status: "running",
    reviewMode: MANUAL_SHORT_CALL_ANALYSIS_PIPELINE,
    analyzerModel,
    processingGeneration,
    promptPaths: MANUAL_SHORT_CALL_REVIEW_PROMPTS,
    totalTasks: MANUAL_SHORT_CALL_REVIEW_TASK_IDS.length,
    completedTasks: 0,
    consolidatorDispatchedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const runningUpdate = {
    activeShortCallReviewRunId: runId,
    shortCallReviewStatus: "running",
    analysisStartedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...buildClearCallErrorUpdate(),
  };
  await callRef.update(runningUpdate);
  await upsertAutomaticShortCallReviewState({
    callId,
    callData: { ...callData, ...runningUpdate },
    reviewStatus: "running",
  });

  const batch = db.batch();
  for (const taskId of MANUAL_SHORT_CALL_INITIAL_TASK_IDS) {
    const taskRef = runRef.collection("tasks").doc(taskId);
    batch.set(taskRef, {
      status: "pending",
      attempts: 0,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}

/** Documents the buildShortCallUserPrompt behavior. */
function buildShortCallUserPrompt(params: {
  callId: string;
  transcriptData: FirebaseFirestore.DocumentData;
  taskId: ManualShortCallReviewTaskId;
  priorOutputs: Record<string, unknown>;
}): string {
  const priorOutputBlock = Object.keys(params.priorOutputs).length > 0
    ? `\n\n**Prior short-call task outputs:**\n\`\`\`json\n${JSON.stringify(params.priorOutputs, null, 2)}\n\`\`\``
    : "";
  return `## Input Data\n\n**call_id:** "${params.callId}"\n\n**short_call_task_id:** "${params.taskId}"\n\n**Transcript JSON:**\n\`\`\`json\n${JSON.stringify(params.transcriptData, null, 2)}\n\`\`\`${priorOutputBlock}\n\nAnalyze this 30-to-90-second manual call according to the short-call review instructions and output schema in your system prompt.`;
}

/** Documents the readPriorTaskOutputs behavior. */
async function readPriorTaskOutputs(
  runRef: FirebaseFirestore.DocumentReference,
  taskIds: readonly string[]
): Promise<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  for (const taskId of taskIds) {
    const taskDoc = await runRef.collection("tasks").doc(taskId).get();
    const output = taskDoc.data()?.output;
    if (output && typeof output === "object") outputs[taskId] = output;
  }
  return outputs;
}

/** Documents the markShortCallRunError behavior. */
async function markShortCallRunError(params: {
  callRef: FirebaseFirestore.DocumentReference;
  runRef: FirebaseFirestore.DocumentReference;
  runId: string;
  error: unknown;
}): Promise<void> {
  const serializedError = serializeCallError(params.error, "analysis_task");
  await params.runRef.update({
    status: "error",
    finalizedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...buildCallErrorUpdate(serializedError),
  });
  await params.callRef.update({
    status: "error",
    activeShortCallReviewRunId: FieldValue.delete(),
    latestShortCallReviewRunId: params.runId,
    shortCallReviewStatus: "error",
    lastTerminalRunId: params.runId,
    lastRunStatus: "error",
    analysisCompletedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...buildCallErrorUpdate(serializedError),
  });
  const callDoc = await params.callRef.get();
  await upsertAutomaticShortCallReviewState({
    callId: params.callRef.id,
    callData: callDoc.data() ?? {},
    reviewStatus: "error",
  });
}

/** Documents the runManualShortCallReviewTask behavior. */
export async function runManualShortCallReviewTask(
  callId: string,
  runId: string,
  taskId: string
): Promise<void> {
  if (!isManualShortCallReviewTaskId(taskId)) throw new Error(`Unknown short-call review task: ${taskId}`);
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection("calls").doc(callId);
  const runRef = callRef.collection("short_call_review_runs").doc(runId);
  const taskRef = runRef.collection("tasks").doc(taskId);
  const [callDoc, runDoc, taskDoc] = await Promise.all([callRef.get(), runRef.get(), taskRef.get()]);
  const callData = callDoc.data() ?? {};
  const runData = runDoc.data() ?? {};
  const taskData = taskDoc.data() ?? {};
  if (!runDoc.exists || runData.status !== "running") return;
  if (!taskDoc.exists || taskData.status !== "pending") return;

  const activeRunId = typeof callData.activeShortCallReviewRunId === "string"
    ? callData.activeShortCallReviewRunId
    : null;
  if (activeRunId !== runId || getProcessingGeneration(callData) !== getProcessingGeneration(runData)) {
    await taskRef.update({
      status: "canceled",
      completedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  await taskRef.update({
    status: "running",
    attempts: (typeof taskData.attempts === "number" ? taskData.attempts : 0) + 1,
    startedAt: FieldValue.serverTimestamp(),
  });

  try {
    const transcriptDoc = await callRef.collection("transcript").doc("data").get();
    if (!transcriptDoc.exists) throw new Error("Transcript not found");
    const promptPath = (runData.promptPaths as Record<string, string> | undefined)?.[taskId] ??
      MANUAL_SHORT_CALL_REVIEW_PROMPTS[taskId];
    const systemPrompt = fs.readFileSync(path.join(__dirname, promptPath), "utf-8");
    const priorOutputs = taskId === MANUAL_SHORT_CALL_CONSOLIDATOR_TASK_ID
      ? await readPriorTaskOutputs(runRef, MANUAL_SHORT_CALL_INITIAL_TASK_IDS)
      : {};
    const userPrompt = buildShortCallUserPrompt({
      callId,
      transcriptData: transcriptDoc.data() ?? {},
      taskId,
      priorOutputs,
    });
    const analyzerModel = resolveAnalyzerModel(runData.analyzerModel ?? DEFAULT_ANALYZER_MODEL);
    const openai = createDemoOpenAI({ purpose: 'short_call_review', callId, processingGeneration: getProcessingGeneration(runData) });
    /** Calls the OpenAI API for short-call review model inference. */
    const response = await openai.chat.completions.create({
      model: analyzerModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      ...analyzerRequestOptions(analyzerModel),
    });
    const responseText = response.choices[0]?.message?.content;
    if (!responseText) throw new Error("No response from OpenAI");
    const output = JSON.parse(responseText) as Record<string, unknown>;
    const sanitizedOutput = sanitizeSubagentOutputForFirestore(output);

    await taskRef.update({
      status: "complete",
      output: sanitizedOutput.output,
      model: analyzerModel,
      prompt: promptPath,
      ...(sanitizedOutput.sanitized ? {
        outputSanitized: true,
        outputSanitizationIssues: sanitizedOutput.issues,
      } : {}),
      completedAt: FieldValue.serverTimestamp(),
    });

    const completedTasks = await db.runTransaction(async (txn) => {
      const freshRun = await txn.get(runRef);
      const freshRunData = freshRun.data() ?? {};
      const nextCompleted = (typeof freshRunData.completedTasks === "number" ? freshRunData.completedTasks : 0) + 1;
      txn.update(runRef, {
        completedTasks: nextCompleted,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return nextCompleted;
    });

    if (taskId === MANUAL_SHORT_CALL_CONSOLIDATOR_TASK_ID) {
      await finalizeManualShortCallReview(callId, runId);
      return;
    }

    if (completedTasks >= MANUAL_SHORT_CALL_INITIAL_TASK_IDS.length) {
      const latestRun = await runRef.get();
      if (!latestRun.data()?.consolidatorDispatchedAt) {
        await runRef.collection("tasks").doc(MANUAL_SHORT_CALL_CONSOLIDATOR_TASK_ID).set({
          status: "pending",
          attempts: 0,
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        await runRef.update({
          consolidatorDispatchedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
  } catch (error) {
    console.error(`Short-call review task failed for ${callId}/${runId}/${taskId}:`, error);
    const serializedError = serializeCallError(error, "analysis_task");
    await taskRef.update({
      status: "error",
      completedAt: FieldValue.serverTimestamp(),
      ...buildCallErrorUpdate(serializedError),
    });
    await markShortCallRunError({ callRef, runRef, runId, error });
  }
}

/** Documents the stringFromAllowed behavior. */
function stringFromAllowed<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T[number] : fallback;
}

/** Documents the cleanText behavior. */
function cleanText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Documents the confidenceScore behavior. */
function confidenceScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/** Documents the normalizeEvidence behavior. */
function normalizeEvidence(value: unknown): ManualShortCallEvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      quote: cleanText(row.quote),
      ...(typeof row.speaker_label === "string" ? { speaker_label: row.speaker_label } : {}),
      ...(typeof row.speaker_display === "string" ? { speaker_display: row.speaker_display } : {}),
      ...(typeof row.start_seconds === "number" ? { start_seconds: row.start_seconds } : {}),
      ...(typeof row.end_seconds === "number" ? { end_seconds: row.end_seconds } : {}),
    };
  }).filter((item) => item.quote);
}

/** Documents the normalizeRubricChecks behavior. */
function normalizeRubricChecks(value: unknown): ManualShortCallRubricCheck[] {
  const rows = Array.isArray(value) ? value : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row && typeof row === "object") {
      const record = row as Record<string, unknown>;
      if (typeof record.id === "string") byId.set(record.id, record);
    }
  }
  return RUBRIC_CHECK_IDS.map((id) => {
    const record = byId.get(id) ?? {};
    const rawStatus = record.status;
    const status = rawStatus === "met" || rawStatus === "missed" || rawStatus === "not_observable"
      ? rawStatus
      : "not_observable";
    return {
      id,
      label: cleanText(record.label, id),
      status,
      rationale: cleanText(record.rationale, "No observable en la llamada corta."),
    };
  });
}

/** Documents the normalizeShortCallReviewOutput behavior. */
export function normalizeShortCallReviewOutput(params: {
  callId: string;
  durationSeconds: number | null;
  promptPaths: Record<string, string>;
  sourceTaskOutputs: Record<string, unknown>;
  consolidatorOutput: Record<string, unknown>;
}): ManualShortCallReviewDocument {
  const output = params.consolidatorOutput;
  const contactStatus = stringFromAllowed(output.contactStatus, CONTACT_STATUS_VALUES, "unknown");
  const quickEndReason = stringFromAllowed(output.quickEndReason, QUICK_END_REASON_VALUES, "unknown");
  const agentConcern = stringFromAllowed(output.agentConcern, AGENT_CONCERN_VALUES, "not_enough_information");
  const qualityScorecardOutput = output.qualityScorecard &&
    typeof output.qualityScorecard === "object" &&
    !Array.isArray(output.qualityScorecard)
    ? output.qualityScorecard as Record<string, unknown>
    : {};
  const quality = buildShortCallQualityResult({
    durationSeconds: params.durationSeconds,
    contactStatus,
    agentConcern,
    rawCriteria: output.qualityCriteria ?? qualityScorecardOutput.criteria,
  });
  return {
    schemaVersion: MANUAL_SHORT_CALL_REVIEW_SCHEMA_VERSION,
    callId: params.callId,
    analysisPipeline: MANUAL_SHORT_CALL_ANALYSIS_PIPELINE,
    minimumSeconds: MANUAL_SHORT_CALL_MINIMUM_SECONDS,
    thresholdSeconds: MANUAL_SHORT_CALL_THRESHOLD_SECONDS,
    durationSeconds: params.durationSeconds,
    contactStatus,
    quickEndReason,
    startCallRubricChecks: normalizeRubricChecks(output.startCallRubricChecks),
    agentConcern,
    agentConcernSummary: cleanText(output.agentConcernSummary, "Sin conclusion suficiente."),
    agentConcernEvidence: normalizeEvidence(output.agentConcernEvidence),
    confidenceScore: confidenceScore(output.confidenceScore),
    ...quality,
    promptPaths: params.promptPaths,
    sourceTaskOutputs: params.sourceTaskOutputs,
  };
}

/** Documents the finalizeManualShortCallReview behavior. */
async function finalizeManualShortCallReview(callId: string, runId: string): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection("calls").doc(callId);
  const runRef = callRef.collection("short_call_review_runs").doc(runId);
  const [callDoc, runDoc, tasksSnapshot] = await Promise.all([
    callRef.get(),
    runRef.get(),
    runRef.collection("tasks").get(),
  ]);
  const callData = callDoc.data() ?? {};
  const runData = runDoc.data() ?? {};
  if (runData.finalizedAt) return;

  const sourceTaskOutputs: Record<string, unknown> = {};
  let consolidatorOutput: Record<string, unknown> | null = null;
  const errorTasks: string[] = [];
  for (const taskDoc of tasksSnapshot.docs) {
    const taskData = taskDoc.data();
    if (taskData.status === "error") errorTasks.push(taskDoc.id);
    if (taskData.output && typeof taskData.output === "object") {
      sourceTaskOutputs[taskDoc.id] = taskData.output;
      if (taskDoc.id === MANUAL_SHORT_CALL_CONSOLIDATOR_TASK_ID) {
        consolidatorOutput = taskData.output as Record<string, unknown>;
      }
    }
  }
  if (errorTasks.length > 0 || !consolidatorOutput) {
    await markShortCallRunError({
      callRef,
      runRef,
      runId,
      error: new Error(`Short-call review finalizer missing output: ${errorTasks.join(", ")}`),
    });
    return;
  }

  const review = normalizeShortCallReviewOutput({
    callId,
    durationSeconds: typeof callData.duration === "number" ? callData.duration : null,
    promptPaths: runData.promptPaths ?? MANUAL_SHORT_CALL_REVIEW_PROMPTS,
    sourceTaskOutputs,
    consolidatorOutput,
  });

  await callRef.collection("short_call_review").doc("data").set({
    ...review,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await runRef.update({
    status: "complete",
    finalizedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await callRef.update({
    status: "complete",
    activeShortCallReviewRunId: FieldValue.delete(),
    latestShortCallReviewRunId: runId,
    shortCallReviewStatus: "complete",
    lastTerminalRunId: runId,
    lastRunStatus: "complete",
    analysisCompletedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...buildClearCallErrorUpdate(),
  });
  await upsertAutomaticShortCallReviewState({
    callId,
    callData: { ...callData, status: "complete", shortCallReviewStatus: "complete" },
    reviewStatus: "complete",
    review,
  });
}

/** Documents the incrementCount behavior. */
function incrementCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

/** Documents the buildManualShortCallPatternSummary behavior. */
export function buildManualShortCallPatternSummary(params: {
  uploadedBy: string;
  generatedAtIso: string;
  rows: Array<{
    call: FirebaseFirestore.DocumentData;
    review: Partial<ManualShortCallReviewDocument>;
  }>;
}): ManualShortCallPatternSummary {
  const contactStatusCounts: Record<string, number> = {};
  const quickEndReasonCounts: Record<string, number> = {};
  const agentConcernCounts: Record<string, number> = {};
  const qualityBandCounts: Record<string, number> = {};
  const durationBucketCounts: Record<string, number> = {};
  const evaluableDepthCounts: Record<string, number> = {};
  let scoredShortCalls = 0;
  let qualityScoreTotal = 0;
  const byAgent = new Map<string, ManualShortCallPatternAgentStats>();

  for (const row of params.rows) {
    const salesAgentId = typeof row.call.salesAgentId === "string" && row.call.salesAgentId.trim()
      ? row.call.salesAgentId.trim()
      : "unassigned";
    const salesAgentName = typeof row.call.salesAgentName === "string" && row.call.salesAgentName.trim()
      ? row.call.salesAgentName.trim()
      : "Sin agente";
    const contactStatus = stringFromAllowed(row.review.contactStatus, CONTACT_STATUS_VALUES, "unknown");
    const quickEndReason = stringFromAllowed(row.review.quickEndReason, QUICK_END_REASON_VALUES, "unknown");
    const agentConcern = stringFromAllowed(row.review.agentConcern, AGENT_CONCERN_VALUES, "not_enough_information");
    const qualityBand = typeof row.review.qualityBand === "string" ? row.review.qualityBand : "not_scorable";
    const durationBucket = typeof row.review.durationBucket === "string" ? row.review.durationBucket : "unknown";
    const evaluableDepth = typeof row.review.evaluableDepth === "string" ? row.review.evaluableDepth : "unknown";
    const qualityScore = typeof row.review.qualityScore === "number" && Number.isFinite(row.review.qualityScore)
      ? row.review.qualityScore
      : null;

    incrementCount(contactStatusCounts, contactStatus);
    incrementCount(quickEndReasonCounts, quickEndReason);
    incrementCount(agentConcernCounts, agentConcern);
    incrementCount(qualityBandCounts, qualityBand);
    incrementCount(durationBucketCounts, durationBucket);
    incrementCount(evaluableDepthCounts, evaluableDepth);
    if (qualityScore !== null) {
      scoredShortCalls += 1;
      qualityScoreTotal += qualityScore;
    }

    const existing = byAgent.get(salesAgentId) ?? {
      salesAgentId,
      salesAgentName,
      totalShortCalls: 0,
      contactStatusCounts: {},
      quickEndReasonCounts: {},
      agentConcernCounts: {},
      qualityBandCounts: {},
      durationBucketCounts: {},
      evaluableDepthCounts: {},
      scoredShortCalls: 0,
      averageQualityScore: null,
      concernRate: 0,
    };
    existing.totalShortCalls += 1;
    incrementCount(existing.contactStatusCounts, contactStatus);
    incrementCount(existing.quickEndReasonCounts, quickEndReason);
    incrementCount(existing.agentConcernCounts, agentConcern);
    incrementCount(existing.qualityBandCounts, qualityBand);
    incrementCount(existing.durationBucketCounts, durationBucket);
    incrementCount(existing.evaluableDepthCounts, evaluableDepth);
    if (qualityScore !== null) {
      existing.scoredShortCalls += 1;
      existing.averageQualityScore =
        Math.round((((existing.averageQualityScore ?? 0) * (existing.scoredShortCalls - 1)) + qualityScore) /
          existing.scoredShortCalls * 10) / 10;
    }
    byAgent.set(salesAgentId, existing);
  }

  const agentStats = Array.from(byAgent.values()).map((agent) => {
    const concerning = (agent.agentConcernCounts.possible_premature_end ?? 0) +
      (agent.agentConcernCounts.protocol_gap ?? 0) +
      (agent.agentConcernCounts.compliance_risk ?? 0);
    return {
      ...agent,
      concernRate: agent.totalShortCalls > 0 ? concerning / agent.totalShortCalls : 0,
    };
  }).sort((left, right) => right.totalShortCalls - left.totalShortCalls);

  return {
    uploadedBy: params.uploadedBy,
    schemaVersion: "manual_short_call_patterns_v1",
    totalShortCalls: params.rows.length,
    agentCount: agentStats.length,
    generatedAtIso: params.generatedAtIso,
    contactStatusCounts,
    quickEndReasonCounts,
    agentConcernCounts,
    qualityBandCounts,
    durationBucketCounts,
    evaluableDepthCounts,
    scoredShortCalls,
    averageQualityScore: scoredShortCalls > 0 ? Math.round((qualityScoreTotal / scoredShortCalls) * 10) / 10 : null,
    agentStats,
  };
}

/** Documents the refreshManualShortCallPatternsForUser behavior. */
async function refreshManualShortCallPatternsForUser(
  uploadedBy: string,
  generatedAt: Date,
  firestore: FirebaseFirestore.Firestore = db
): Promise<ManualShortCallPatternSummary> {
  const callsSnapshot = await firestore
    .collection("calls")
    .where("uploadedBy", "==", uploadedBy)
    .where("analysisPipeline", "==", MANUAL_SHORT_CALL_ANALYSIS_PIPELINE)
    .where("status", "==", "complete")
    .orderBy("createdAt", "desc")
    .limit(1000)
    .get();

  const rows = [];
  for (const callDoc of callsSnapshot.docs) {
    const reviewDoc = await callDoc.ref.collection("short_call_review").doc("data").get();
    if (!reviewDoc.exists) continue;
    rows.push({ call: callDoc.data(), review: reviewDoc.data() as Partial<ManualShortCallReviewDocument> });
  }
  const summary = buildManualShortCallPatternSummary({
    uploadedBy,
    generatedAtIso: generatedAt.toISOString(),
    rows,
  });
  await firestore.collection(MANUAL_SHORT_CALL_PATTERNS_COLLECTION).doc(uploadedBy).set({
    ...summary,
    lastGeneratedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return summary;
}

/** Documents the handleRefreshManualShortCallPatterns behavior. */
export async function handleRefreshManualShortCallPatterns(
  request: CallableRequest<Record<string, never>>,
  deps: { firestore?: FirebaseFirestore.Firestore; now?: () => Date } = {}
): Promise<{ success: true; pattern: ManualShortCallPatternSummary }> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to refresh short-call patterns.");
  const now = deps.now?.() ?? new Date();
  const pattern = await refreshManualShortCallPatternsForUser(uid, now, deps.firestore ?? db);
  return { success: true, pattern };
}

export const refreshManualShortCallPatterns = onCall(
  /** Handles the callable manual short-call pattern refresh request. */
  async (request) => handleRefreshManualShortCallPatterns(request)
);

export const refreshManualShortCallPatternsDaily = onSchedule(
  {
    schedule: "every day 03:30",
    timeZone: "America/Los_Angeles",
    memory: "1GiB",
  },
  /** Handles the scheduled short-call pattern refresh job. */
  async () => {
    const generatedAt = new Date();
    const callsSnapshot = await db.collection("calls")
      .where("analysisPipeline", "==", MANUAL_SHORT_CALL_ANALYSIS_PIPELINE)
      .where("status", "==", "complete")
      .get();
    const userIds = new Set<string>();
    callsSnapshot.docs.forEach((doc) => {
      const uploadedBy = doc.data().uploadedBy;
      if (typeof uploadedBy === "string" && uploadedBy.trim()) userIds.add(uploadedBy.trim());
    });
    for (const uploadedBy of userIds) {
      await refreshManualShortCallPatternsForUser(uploadedBy, generatedAt);
    }
  }
);
