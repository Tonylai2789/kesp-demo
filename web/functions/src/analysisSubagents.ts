import { privatePolicyUnavailable, redactedPrivatePolicy } from "./privatePolicy";
import { createDemoOpenAI } from './demoPaidProviders';
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import OpenAI from "openai";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_ANALYZER_MODEL,
  getAnalysisModeFromEnv,
  getSubagentConfig,
  isSubagent2SeverityTaskId,
  requireAnalyzerModel,
  validateAnalyzerModelOverrides,
  resolveSubagentModels,
  type AnalyzerModel,
  resolveSubagent2PromptPath,
  SUBAGENT_2_0_SEVERITY_PARENT_TASK_IDS,
  SUBAGENT_2_0_STAGE1_TASK_IDS,
  SUBAGENT_2_0_STAGE2_TASK_IDS,
  SUBAGENT_2_0_TASK_IDS,
  type AnalysisMode,
  type Subagent2TaskId,
  type Subagent2SeverityTaskId,
} from "./promptConfig";
import { syncAgentActivityForCall } from "./agentActivity";
import { routeGeneralAgentCallAfterFeedback } from "./agentRouting";
import { serializeCallError } from "./analysisErrors";
import { buildManagementActionPlanV1 } from "./managementAction";
import { normalizeTranscriptForAnalysis } from "./transcriptNormalization";
import { buildDuplicateFingerprintKeys, reconcileAgentProfileDuplicates } from "./agentDuplicateCalls";
import { isTranscriptionComparisonCall } from "./callExclusions";
import {
  maybeCreateCallAnalysisTerminalInboxMessage,
  maybeCreateCallUnrecognizedInboxMessage,
} from "./kespInboxEvents";
import {
  buildCallErrorUpdate,
  buildClearCallErrorUpdate,
  getProcessingGeneration,
} from "./callState";
import { validateAndRepairRubricCriteriaResults } from "./rubricCreditValidation";
import { isLegacyTestCallCategory } from "./callCategory";
import { sanitizeSubagentOutputForFirestore } from "./firestoreOutputSanitizer";
import { recordRuntimeFailureForDelayedRetry } from "./runtimeRetry";
import { ensureConversationMetrics, persistConversationSpeedAdjustment, conversationMetricsSourceMatches, conversationMetricsDocumentMatches, CONVERSATION_METRICS_COLLECTION } from "./conversationMetricsStore";
import { enqueueConversationMetricsInterpretation } from "./conversationMetricsAnalysis";
import { isOpenAiSegmentTranscript, type ConversationMetricsReport } from "./conversationMetrics";
import { applyConversationSpeedScoring, type ConversationSpeedAdjustment } from "./conversationSpeedScoring";
import { loadTranscriptTimeline } from "./transcriptionProvider";
import { analyzerRequestOptions } from "./analyzerRequestOptions";
import { totalAnalysisUsage } from "./analysisUsage";

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

const SUBAGENT_2_0_FEEDBACK_CACHE_COLLECTION = "analysis_cache";
const SUBAGENT_2_0_FEEDBACK_CACHE_SCHEMA_VERSION = "subagent_2_0_feedback_cache_v1";

export const SECTION_TITLES = redactedPrivatePolicy<readonly string[]>();

export const RUBRIC_V2_MODEL = redactedPrivatePolicy<{
  rubric_version: string;
  total_points: number;
  sections: Array<{
    id: string; title: string; weight_percent: number;
    groups: Array<{
      id: string; title: string; weight_percent: number;
      criteria: Array<{ id: string; title: string; weight_percent: number }>;
    }>;
  }>;
}>();

const TIER_BANDS = redactedPrivatePolicy<Array<{ min: number; tier: string; category: string }>>();

type SeverityLabel =
  | "critical"
  | "severe"
  | "moderate-severe"
  | "moderate"
  | "moderate-minor"
  | "minor";

const VALID_SEVERITY_LABELS = new Set<SeverityLabel>([
  "critical",
  "severe",
  "moderate-severe",
  "moderate",
  "moderate-minor",
  "minor",
]);

const MAX_RUBRIC_MISSING_CRITERION_FALLBACK_ATTEMPTS = 2;
const INVALID_RUBRIC_OUTPUT_SCHEMA_CODE = "invalid_rubric_output_schema";

type RubricOutputValidationResult =
  | {
    valid: true;
    expectedCriterionIds: string[];
    foundCriterionIds: string[];
    resultCount: number;
  }
  | {
    valid: false;
    expectedCriterionIds: string[];
    foundCriterionIds: string[];
    resultCount: number;
    invalidResultCount: number;
    missingCriterionIds: string[];
    unexpectedCriterionIds: string[];
    duplicateCriterionIds: string[];
    message: string;
  };

type InvalidRubricOutputValidation = Extract<
  RubricOutputValidationResult,
  { valid: false }
>;

/** Documents the isTerminalTaskStatus behavior. */
function isTerminalTaskStatus(status: any): boolean {
  return status === "complete" || status === "error" || status === "canceled";
}

/** Documents the getFinalizerCallCategoryGuardrails behavior. */
export function getFinalizerCallCategoryGuardrails(callCategory: unknown): {
  needsAutoCategory: boolean;
  shouldMarkAiAgentUpload: boolean;
  legacyAiTestMarkerFields: { aiAgentUpload?: true };
} {
  const isLegacyTestCategory = isLegacyTestCallCategory(callCategory);
  return {
    needsAutoCategory: callCategory === "unknown" || isLegacyTestCategory,
    shouldMarkAiAgentUpload: isLegacyTestCategory,
    legacyAiTestMarkerFields: isLegacyTestCategory ? { aiAgentUpload: true } : {},
  };
}

/** Documents the isCallCanceled behavior. */
async function isCallCanceled(callRef: FirebaseFirestore.DocumentReference): Promise<boolean> {
  const callDoc = await callRef.get();
  return callDoc.data()?.status === "canceled";
}

/** Documents the isSubagent2RubricAnalysisTaskId behavior. */
function isSubagent2RubricAnalysisTaskId(taskId: string): boolean {
  return /^rubric_analysis_[A-D]$/.test(taskId);
}

/** Documents the getExpectedRubricCriterionIds behavior. */
function getExpectedRubricCriterionIds(taskId: string): string[] | null {
  const match = taskId.match(/^rubric_analysis_([A-D])$/);
  if (!match?.[1]) {
    return null;
  }

  const section = RUBRIC_V2_MODEL.sections.find(
    /** Handles the callback for this operation. */
    (candidate) => candidate.id === match[1]
  );
  if (!section) {
    return null;
  }

  return section.groups.flatMap(
    /** Handles the callback for this operation. */
    (group) => group.criteria.map(
      /** Handles the callback for this operation. */
      (criterion) => criterion.id
    )
  );
}

/** Documents the validateSubagent2RubricOutput behavior. */
export function validateSubagent2RubricOutput(
  taskId: string,
  output: any
): RubricOutputValidationResult | null {
  const expectedCriterionIds = getExpectedRubricCriterionIds(taskId);
  if (!expectedCriterionIds) {
    return null;
  }

  const results = Array.isArray(output?.rubric_criteria_results)
    ? output.rubric_criteria_results
    : [];
  const resultCount = results.length;
  const foundCriterionIds: string[] = results
    .map(
      /** Handles the callback for this operation. */
      (result: any) => result?.criterion_id
    )
    .filter(
      /** Handles the callback for this operation. */
      (criterionId: any): criterionId is string => typeof criterionId === "string"
    );
  const expected = new Set(expectedCriterionIds);
  const seen = new Map<string, number>();
  const unexpected = new Set<string>();

  for (const criterionId of foundCriterionIds) {
    seen.set(criterionId, (seen.get(criterionId) ?? 0) + 1);
    if (!expected.has(criterionId)) {
      unexpected.add(criterionId);
    }
  }

  const missingCriterionIds = expectedCriterionIds.filter(
    /** Handles the callback for this operation. */
    (criterionId) => !seen.has(criterionId)
  );
  const unexpectedCriterionIds = [...unexpected];
  const duplicateCriterionIds = [...seen.entries()]
    .filter(
      /** Handles the callback for this operation. */
      ([, count]) => count > 1
    )
    .map(
      /** Handles the callback for this operation. */
      ([criterionId]) => criterionId
    );
  const invalidResultCount = resultCount - foundCriterionIds.length;

  if (
    resultCount === expectedCriterionIds.length &&
    invalidResultCount === 0 &&
    missingCriterionIds.length === 0 &&
    unexpectedCriterionIds.length === 0 &&
    duplicateCriterionIds.length === 0
  ) {
    return { valid: true, expectedCriterionIds, foundCriterionIds, resultCount };
  }

  const parts = [
    `expected exactly ${expectedCriterionIds.length} criteria [${expectedCriterionIds.join(", ")}]`,
    `found ${foundCriterionIds.length} criterion_id value(s) [${foundCriterionIds.join(", ") || "none"}]`,
    `array length ${resultCount}`,
  ];
  if (invalidResultCount > 0) {
    parts.push(`${invalidResultCount} result object(s) missing a string criterion_id`);
  }
  if (missingCriterionIds.length > 0) {
    parts.push(`missing [${missingCriterionIds.join(", ")}]`);
  }
  if (unexpectedCriterionIds.length > 0) {
    parts.push(`unexpected [${unexpectedCriterionIds.join(", ")}]`);
  }
  if (duplicateCriterionIds.length > 0) {
    parts.push(`duplicate [${duplicateCriterionIds.join(", ")}]`);
  }

  return {
    valid: false,
    expectedCriterionIds,
    foundCriterionIds,
    resultCount,
    invalidResultCount,
    missingCriterionIds,
    unexpectedCriterionIds,
    duplicateCriterionIds,
    message: `Invalid ${taskId} rubric output: ${parts.join("; ")}.`,
  };
}

/** Documents the buildInvalidRubricOutputError behavior. */
function buildInvalidRubricOutputError(
  validation: InvalidRubricOutputValidation
): Error & { code: string } {
  const error = new Error(validation.message) as Error & { code: string };
  error.code = INVALID_RUBRIC_OUTPUT_SCHEMA_CODE;
  return error;
}

/** Documents the canUseMissingCriterionFallback behavior. */
function canUseMissingCriterionFallback(validation: InvalidRubricOutputValidation): boolean {
  return (
    validation.missingCriterionIds.length > 0 &&
    validation.unexpectedCriterionIds.length === 0 &&
    validation.duplicateCriterionIds.length === 0 &&
    validation.invalidResultCount === 0
  );
}

/** Documents the buildMissingCriterionFallbackSystemPrompt behavior. */
function buildMissingCriterionFallbackSystemPrompt(
  baseSystemPrompt: string,
  taskId: string,
  criterionId: string
): string {
  return `${baseSystemPrompt}

## Backend missing-criterion fallback override

The previous ${taskId} response omitted criterion ${criterionId}. In this fallback call, evaluate ONLY criterion ${criterionId}.
This correction mode overrides any earlier instruction that asks for every criterion in the section.

Return raw JSON with exactly these top-level keys:
- call_id
- rubric_criteria_results

The rubric_criteria_results array must contain exactly one object, and that object must have criterion_id "${criterionId}".
Do not return any other criterion_id. Do not omit the criterion.`;
}

/** Documents the buildMissingCriterionFallbackUserPrompt behavior. */
function buildMissingCriterionFallbackUserPrompt(
  baseUserPrompt: string,
  validation: InvalidRubricOutputValidation,
  criterionId: string
): string {
  return `${baseUserPrompt}

## Missing-criterion fallback

The backend validator rejected the previous output:
${validation.message}

Evaluate only the missing criterion "${criterionId}" now. Return a JSON object whose rubric_criteria_results array contains exactly one entry for "${criterionId}".`;
}

/** Documents the getRubricCriteriaResults behavior. */
function getRubricCriteriaResults(output: any): any[] {
  return Array.isArray(output?.rubric_criteria_results)
    ? output.rubric_criteria_results
    : [];
}

/** Documents the mergeRubricCriteriaByExpectedIds behavior. */
function mergeRubricCriteriaByExpectedIds(
  taskId: string,
  baseOutput: any,
  fallbackCriteriaById: Map<string, any>
): any {
  const expectedCriterionIds = getExpectedRubricCriterionIds(taskId);
  if (!expectedCriterionIds) {
    return baseOutput;
  }

  const criteriaById = new Map<string, any>();
  for (const result of getRubricCriteriaResults(baseOutput)) {
    const criterionId = result?.criterion_id;
    if (
      typeof criterionId === "string" &&
      expectedCriterionIds.includes(criterionId) &&
      !criteriaById.has(criterionId)
    ) {
      criteriaById.set(criterionId, result);
    }
  }

  for (const [criterionId, criterionResult] of fallbackCriteriaById) {
    if (expectedCriterionIds.includes(criterionId)) {
      criteriaById.set(criterionId, criterionResult);
    }
  }

  return {
    ...baseOutput,
    rubric_criteria_results: expectedCriterionIds
      .map(
        /** Handles the callback for this operation. */
        (criterionId) => criteriaById.get(criterionId)
      )
      .filter(Boolean),
  };
}

/** Documents the canonicalizeRubricOutput behavior. */
function canonicalizeRubricOutput(taskId: string, output: any): any {
  return mergeRubricCriteriaByExpectedIds(taskId, output, new Map());
}

/** Documents the fillMissingRubricCriteriaWithFallback behavior. */
async function fillMissingRubricCriteriaWithFallback(params: {
  openai: OpenAI;
  analyzerModel: string;
  taskId: string;
  callId: string;
  runId: string;
  systemPrompt: string;
  userPrompt: string;
  output: any;
  validation: InvalidRubricOutputValidation;
  onUsage: (usage: OpenAI.CompletionUsage) => void;
}): Promise<{ output: any; fallbackAttempts: number; fallbackCriterionIds: string[] }> {
  const {
    openai,
    analyzerModel,
    taskId,
    callId,
    runId,
    systemPrompt,
    userPrompt,
    validation,
  } = params;

  const fallbackCriteriaById = new Map<string, any>();
  let fallbackAttempts = 0;

  for (const criterionId of validation.missingCriterionIds) {
    for (
      let attempt = 1;
      attempt <= MAX_RUBRIC_MISSING_CRITERION_FALLBACK_ATTEMPTS;
      attempt += 1
    ) {
      fallbackAttempts += 1;
      /** Calls the OpenAI API for model inference or transcription. */
      const response = await openai.chat.completions.create({
        model: analyzerModel,
        messages: [
          {
            role: "system",
            content: buildMissingCriterionFallbackSystemPrompt(systemPrompt, taskId, criterionId),
          },
          {
            role: "user",
            content: buildMissingCriterionFallbackUserPrompt(userPrompt, validation, criterionId),
          },
        ],
        response_format: { type: "json_object" },
        ...analyzerRequestOptions(analyzerModel),
      });
      if (response.usage) params.onUsage(response.usage);

      const responseText = response.choices[0]?.message?.content;
      if (!responseText) {
        console.warn(
          `Subagent ${taskId} missing-criterion fallback returned no content for ${criterionId} ` +
          `on ${callId}/${runId} (attempt ${attempt}/${MAX_RUBRIC_MISSING_CRITERION_FALLBACK_ATTEMPTS})`
        );
        continue;
      }

      let fallbackOutput: any;
      try {
        fallbackOutput = JSON.parse(responseText);
      } catch (error) {
        console.warn(
          `Subagent ${taskId} missing-criterion fallback returned invalid JSON for ${criterionId} ` +
          `on ${callId}/${runId} (attempt ${attempt}/${MAX_RUBRIC_MISSING_CRITERION_FALLBACK_ATTEMPTS})`,
          error
        );
        continue;
      }
      const matchingCriterion = getRubricCriteriaResults(fallbackOutput).find(
        /** Handles the callback for this operation. */
        (result) => result?.criterion_id === criterionId
      );

      if (matchingCriterion) {
        fallbackCriteriaById.set(criterionId, matchingCriterion);
        break;
      }

      console.warn(
        `Subagent ${taskId} missing-criterion fallback did not return ${criterionId} ` +
        `for ${callId}/${runId} (attempt ${attempt}/${MAX_RUBRIC_MISSING_CRITERION_FALLBACK_ATTEMPTS})`
      );
    }
  }

  return {
    output: mergeRubricCriteriaByExpectedIds(taskId, params.output, fallbackCriteriaById),
    fallbackAttempts,
    fallbackCriterionIds: [...fallbackCriteriaById.keys()],
  };
}

/** Documents the buildRubricOutputMetadata behavior. */
function buildRubricOutputMetadata(params: {
  taskId: string;
  primaryValidationAttempts: number;
  primaryValidation: RubricOutputValidationResult | null;
  finalValidation: RubricOutputValidationResult | null;
  fallbackAttempts: number;
  fallbackRecoveredCriterionIds: string[];
}): Record<string, any> {
  if (!isSubagent2RubricAnalysisTaskId(params.taskId)) {
    return {};
  }

  const primaryValidation = params.primaryValidation;
  const finalValidation = params.finalValidation ?? params.primaryValidation;

  return {
    outputPrimaryValidationAttempts: params.primaryValidationAttempts,
    outputPrimaryMissingCriterionIds:
      primaryValidation && !primaryValidation.valid ? primaryValidation.missingCriterionIds : [],
    outputPrimaryUnexpectedCriterionIds:
      primaryValidation && !primaryValidation.valid ? primaryValidation.unexpectedCriterionIds : [],
    outputPrimaryDuplicateCriterionIds:
      primaryValidation && !primaryValidation.valid ? primaryValidation.duplicateCriterionIds : [],
    outputFallbackAttempts: params.fallbackAttempts,
    outputFallbackRecoveredCriterionIds: params.fallbackRecoveredCriterionIds,
    outputFinalCriterionIds: finalValidation?.foundCriterionIds ?? [],
  };
}

/** Documents the buildWeaknessId behavior. */
function buildWeaknessId(criterionId: string, critiqueIndex: number): string {
  return `${criterionId}:${critiqueIndex}`;
}

/** Documents the normalizeSeverity behavior. */
function normalizeSeverity(value: any): SeverityLabel | null {
  if (typeof value === "string" && VALID_SEVERITY_LABELS.has(value as SeverityLabel)) {
    return value as SeverityLabel;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (VALID_SEVERITY_LABELS.has(normalized as SeverityLabel)) {
      return normalized as SeverityLabel;
    }
  }
  return null;
}

/** Documents the cloneCriteriaResultsWithWeaknessIds behavior. */
function cloneCriteriaResultsWithWeaknessIds(criteriaResults: any[]): any[] {
  return criteriaResults.map(/** Handles the callback for this operation. */(result) => {
    const criterionId =
      typeof result?.criterion_id === "string" ? result.criterion_id : "unknown";
    const badCritiques = Array.isArray(result?.bad_critiques) ? result.bad_critiques : [];
    return {
      ...result,
      bad_critiques: badCritiques.map(/** Handles the callback for this operation. */(critique: any, critiqueIndex: number) => ({
        ...critique,
        weakness_id: buildWeaknessId(criterionId, critiqueIndex),
      })),
    };
  });
}

/** Documents the stripWeaknessIdsFromCriteriaResults behavior. */
function stripWeaknessIdsFromCriteriaResults(criteriaResults: any[]): any[] {
  return criteriaResults.map(/** Handles the callback for this operation. */(result) => ({
    ...result,
    bad_critiques: (Array.isArray(result?.bad_critiques) ? result.bad_critiques : []).map(/** Handles the callback for this operation. */(critique: any) => {
      const nextCritique = { ...critique };
      delete nextCritique.weakness_id;
      return nextCritique;
    }),
  }));
}

/** Documents the buildSeverityAnalysisInputPayload behavior. */
export function buildSeverityAnalysisInputPayload(
  callId: string,
  transcriptData: any,
  rubricOutput: any
): any {
  const rubricCriteriaResults = Array.isArray(rubricOutput?.rubric_criteria_results)
    ? cloneCriteriaResultsWithWeaknessIds(rubricOutput.rubric_criteria_results)
    : [];

  return {
    call_id: callId,
    transcript: transcriptData,
    rubric_criteria_results: rubricCriteriaResults,
  };
}

/** Documents the applySeverityResultsToCriteriaResults behavior. */
export function applySeverityResultsToCriteriaResults(
  criteriaResults: any[],
  severityOutput: any
): any[] {
  const criteriaWithWeaknessIds = cloneCriteriaResultsWithWeaknessIds(criteriaResults);
  const critiquesByWeaknessId = new Map<string, any>();

  for (const criterion of criteriaWithWeaknessIds) {
    for (const critique of criterion?.bad_critiques ?? []) {
      const weaknessId = typeof critique?.weakness_id === "string" ? critique.weakness_id : "";
      if (!weaknessId) continue;
      if (critiquesByWeaknessId.has(weaknessId)) {
        console.warn(`Duplicate weakness_id in rubric criteria: ${weaknessId}`);
        continue;
      }
      critiquesByWeaknessId.set(weaknessId, critique);
    }
  }

  const seenSeverityIds = new Set<string>();
  const severityResults = Array.isArray(severityOutput?.severity_results)
    ? severityOutput.severity_results
    : [];

  for (const severityResult of severityResults) {
    const weaknessId =
      typeof severityResult?.weakness_id === "string"
        ? severityResult.weakness_id
        : "";
    if (!weaknessId) {
      console.warn("Severity result missing weakness_id; skipping.");
      continue;
    }
    if (seenSeverityIds.has(weaknessId)) {
      console.warn(`Duplicate severity result for weakness_id ${weaknessId}; keeping first.`);
      continue;
    }
    seenSeverityIds.add(weaknessId);

    const critique = critiquesByWeaknessId.get(weaknessId);
    if (!critique) {
      console.warn(`Unknown weakness_id in severity results: ${weaknessId}`);
      continue;
    }

    const normalizedSeverity = normalizeSeverity(severityResult?.severity);
    if (!normalizedSeverity) {
      console.warn(`Invalid severity value for weakness_id ${weaknessId}; skipping.`);
      continue;
    }

    critique.severity = normalizedSeverity;
  }

  return stripWeaknessIdsFromCriteriaResults(criteriaWithWeaknessIds);
}

/** Documents the buildSubagent2SeverityUserPrompt behavior. */
function buildSubagent2SeverityUserPrompt(inputPayload: any): string {
  return `## Input JSON

\`\`\`json
${JSON.stringify(inputPayload)}
\`\`\`

Clasifica la severidad segun las instrucciones de tu system prompt y devuelve solo el objeto JSON final.`;
}

/** Documents the dispatchSubagent2Stage2Tasks behavior. */
async function dispatchSubagent2Stage2Tasks(callId: string, runId: string): Promise<boolean> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection("calls").doc(callId);
  /** Calls an external SDK or API dependency. */
  const runRef = callRef.collection("analysis_runs").doc(runId);

  /** Calls Firebase Firestore to read or write persisted application data. */
  return db.runTransaction(/** Handles the callback for this operation. */ async (txn) => {
    const runDoc = await txn.get(runRef);
    const runData = runDoc.data() ?? {};
    if (runData.stage2DispatchedAt) {
      return false;
    }

    /** Calls an external SDK or API dependency. */
    txn.update(runRef, {
      stage2DispatchedAt: FieldValue.serverTimestamp(),
      totalTasks: (runData.totalTasks || 0) + SUBAGENT_2_0_STAGE2_TASK_IDS.length,
      updatedAt: FieldValue.serverTimestamp(),
    });

    for (const taskId of SUBAGENT_2_0_STAGE2_TASK_IDS) {
      /** Calls an external SDK or API dependency. */
      const taskRef = runRef.collection("tasks").doc(taskId);
      /** Calls an external SDK or API dependency. */
      txn.set(taskRef, {
        status: "pending",
        attempts: 0,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    return true;
  });
}

/** Documents the maybeAdvanceSubagent2Run behavior. */
async function maybeAdvanceSubagent2Run(callId: string, runId: string): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection("calls").doc(callId);
  /** Calls an external SDK or API dependency. */
  const runRef = callRef.collection("analysis_runs").doc(runId);
  const runDoc = await runRef.get();
  const runData = runDoc.data();
  if (runData?.finalizedAt) {
    return;
  }

  if (await finalizeRunAsSupersededIfStale(callRef, runRef, runId, runData)) {
    return;
  }

  const tasksSnapshot = await runRef.collection("tasks").get();
  const tasks: Record<string, any> = {};
  for (const doc of tasksSnapshot.docs) {
    tasks[doc.id] = doc.data();
  }

  const stage1Done = SUBAGENT_2_0_STAGE1_TASK_IDS.every(/** Handles the callback for this operation. */(taskId) =>
    isTerminalTaskStatus(tasks[taskId]?.status)
  );
  if (!stage1Done) {
    return;
  }

  const stage1HasErrors = SUBAGENT_2_0_STAGE1_TASK_IDS.some(
    /** Handles the callback for this operation. */
    (taskId) => tasks[taskId]?.status === "error"
  );
  if (stage1HasErrors) {
    await finalizeAnalysis(callId, runId);
    return;
  }

  if (!runData?.stage2DispatchedAt) {
    const dispatched = await dispatchSubagent2Stage2Tasks(callId, runId);
    if (dispatched) {
      console.log(`Dispatched stage 2 severity tasks for ${callId}/${runId}`);
    }
    return;
  }

  const stage2Done = SUBAGENT_2_0_STAGE2_TASK_IDS.every(/** Handles the callback for this operation. */(taskId) =>
    isTerminalTaskStatus(tasks[taskId]?.status)
  );
  if (!stage2Done) {
    return;
  }

  await finalizeAnalysis(callId, runId);
}

/** Documents the finalizeRunAsSupersededIfStale behavior. */
async function finalizeRunAsSupersededIfStale(
  callRef: FirebaseFirestore.DocumentReference,
  runRef: FirebaseFirestore.DocumentReference,
  runId: string,
  runData: Record<string, any> | undefined
): Promise<boolean> {
  const callDoc = await callRef.get();
  const callData = callDoc.data() ?? {};
  const runGeneration = getProcessingGeneration(runData);
  const callGeneration = getProcessingGeneration(callData);
  const activeRunId =
    typeof callData.activeAnalysisRunId === "string" ? callData.activeAnalysisRunId : undefined;
  const isSuperseded =
    callGeneration !== runGeneration || (activeRunId !== undefined && activeRunId !== runId);

  if (!isSuperseded) {
    return false;
  }

  if (!runData?.finalizedAt) {
    const staleRunError = serializeCallError(
      {
        message: `Analysis run ${runId} was superseded by a newer processing attempt`,
        code: "stale_generation",
      },
      "analysis_finalizer"
    );

    /** Calls an external SDK or API dependency. */
    await runRef.update({
      status: "superseded",
      finalizedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...buildCallErrorUpdate(staleRunError),
    });
  }

  return true;
}

/** Documents the buildFinalizerError behavior. */
function buildFinalizerError(
  message: string,
  sourceTaskData?: Record<string, any>
): ReturnType<typeof serializeCallError> {
  return serializeCallError(
    {
      message,
      code: sourceTaskData?.errorCode,
      type: sourceTaskData?.errorType,
      requestID: sourceTaskData?.errorRequestId,
    },
    "analysis_finalizer"
  );
}

type Subagent2FeedbackCachePromptStateEntry = {
  taskId: Subagent2TaskId;
  promptPath: string;
  promptHash: string;
};

type Subagent2FeedbackCacheState = {
  cacheKey: string;
  schemaVersion: typeof SUBAGENT_2_0_FEEDBACK_CACHE_SCHEMA_VERSION;
  analysisMode: "subagent_2_0";
  analyzerModel: string;
  transcriptHash: string;
  transcriptNormalizationStrategy: string | null;
  promptState: Subagent2FeedbackCachePromptStateEntry[];
  promptHashes: Record<string, string>;
};

type Subagent2FeedbackCacheRunState = {
  schemaVersion: typeof SUBAGENT_2_0_FEEDBACK_CACHE_SCHEMA_VERSION;
  analysisMode: "subagent_2_0";
  cacheKey: string;
  analyzerModel: string;
  transcriptHash: string;
  transcriptNormalizationStrategy: string | null;
  promptHashes: Record<string, string>;
};

/** Documents the normalizeForStableJson behavior. */
function normalizeForStableJson(value: unknown): unknown {
  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map(/** Handles the callback for this operation. */(entry) =>
      entry === undefined ? null : normalizeForStableJson(entry)
    );
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const next = record[key];
      if (next === undefined) {
        continue;
      }
      normalized[key] = normalizeForStableJson(next);
    }
    return normalized;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  return null;
}

/** Documents the stableStringify behavior. */
function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

/** Documents the sha256Hex behavior. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Documents the computeSubagent2FeedbackCacheState behavior. */
async function computeSubagent2FeedbackCacheState(params: {
  callId: string;
  callRef: FirebaseFirestore.DocumentReference;
  analyzerModel: string;
  promptPaths: Record<string, string>;
  effectiveAnalyzerModels: Record<Subagent2TaskId, AnalyzerModel>;
}): Promise<Subagent2FeedbackCacheState | null> {
  const { callId, callRef, analyzerModel, promptPaths } = params;

  /** Calls an external SDK or API dependency. */
  const transcriptDoc = await callRef.collection("transcript").doc("data").get();
  if (!transcriptDoc.exists) {
    console.warn(`Cache: transcript not found for ${callId}; skipping cache lookup`);
    return null;
  }

  const transcriptData = transcriptDoc.data();
  // Scribe v1 must finalize against its own word timeline, never a cross-call cached score.
  if (transcriptData?.provider === "elevenlabs" || transcriptData?.model === "scribe_v2") return null;
  const normalizedTranscriptData = normalizeTranscriptForAnalysis(transcriptData);
  const transcriptNormalizationStrategy =
    typeof normalizedTranscriptData?.normalization?.strategy === "string"
      ? normalizedTranscriptData.normalization.strategy
      : null;
  const transcriptHash = sha256Hex(stableStringify(normalizedTranscriptData));

  const promptState: Subagent2FeedbackCachePromptStateEntry[] = [];
  const promptHashes: Record<string, string> = {};
  const subagent2TaskIds = new Set<string>(SUBAGENT_2_0_TASK_IDS as readonly string[]);

  for (const taskId of Object.keys(promptPaths).sort()) {
    if (!subagent2TaskIds.has(taskId)) {
      continue;
    }
    const promptPath = promptPaths[taskId];
    const absolutePath = path.join(__dirname, promptPath);
    let promptSource = promptPath;
    /** Checks the local filesystem for the resolved prompt artifact. */
    if (fs.existsSync(absolutePath)) {
      /** Reads a resolved prompt artifact from the local filesystem. */
      promptSource = fs.readFileSync(absolutePath, "utf-8");
    }
    const promptHash = sha256Hex(promptSource);

    promptState.push({
      taskId: taskId as Subagent2TaskId,
      promptPath,
      promptHash,
    });
    promptHashes[taskId] = promptHash;
  }

  const cacheKeyPayload = {
    schemaVersion: SUBAGENT_2_0_FEEDBACK_CACHE_SCHEMA_VERSION,
    analysisMode: "subagent_2_0" as const,
    analyzerModel,
    transcriptHash,
    transcriptNormalizationStrategy,
    prompts: promptState,
    effectiveAnalyzerModels: params.effectiveAnalyzerModels,
  };

  const cacheKey = sha256Hex(stableStringify(cacheKeyPayload));

  return {
    cacheKey,
    schemaVersion: SUBAGENT_2_0_FEEDBACK_CACHE_SCHEMA_VERSION,
    analysisMode: "subagent_2_0",
    analyzerModel,
    transcriptHash,
    transcriptNormalizationStrategy,
    promptState,
    promptHashes,
  };
}

/**
 * Reuses immutable model outputs while recalculating only current-call deterministic
 * metrics and scoring. Missing legacy source outputs preserve the cached score.
 */
export async function prepareCachedOpenAiFeedback(params: {
  callId: string; runId: string; callData: Record<string, unknown>;
  callRef: FirebaseFirestore.DocumentReference; runRef: FirebaseFirestore.DocumentReference;
  feedbackCacheKey: string; cachedFeedback: Record<string, unknown>;
  cacheSource?: { callId: string; runId: string };
}, firestore: FirebaseFirestore.Firestore = db): Promise<{
  feedback: Record<string, unknown>; metrics: ConversationMetricsReport | null;
  adjustment: ConversationSpeedAdjustment | null; aborted: boolean;
}> {
  const { callId, runId, callData, callRef, runRef, feedbackCacheKey, cacheSource } = params;
  const unchanged = { feedback: { ...params.cachedFeedback, call_id: callId }, metrics: null, adjustment: null, aborted: false };
  if (callData.organizationId !== "consubanco") return unchanged;
  // Firestore reads this call's canonical timeline without modifying historical records.
  const timeline = await loadTranscriptTimeline(callRef);
  if (!isOpenAiSegmentTranscript(timeline)) return unchanged;
  let outputs: Parameters<typeof mergeSubagent2Outputs>[1] | null = null;
  if (cacheSource && cacheSource.callId && cacheSource.runId && !cacheSource.callId.includes("/") && !cacheSource.runId.includes("/")) {
    try {
      const sourceCall = firestore.collection("calls").doc(cacheSource.callId);
      const sourceRun = sourceCall.collection("analysis_runs").doc(cacheSource.runId);
      // Firestore reads original completed output snapshots, never a previously adjusted criterion.
      const [sourceCallDoc, sourceRunDoc, sourceTasks] = await Promise.all([sourceCall.get(), sourceRun.get(), sourceRun.collection("tasks").get()]);
      const raw: Record<string, unknown> = {};
      for (const task of sourceTasks.docs) {
        const data = task.data();
        if (data.status === "complete" && data.output && typeof data.output === "object") raw[task.id] = data.output;
      }
      const required = ["core_fields", "coaching", "rubric_analysis_A", "rubric_analysis_B", "rubric_analysis_C", "rubric_analysis_D",
        ...Object.keys(sourceRunDoc.data()?.promptPaths ?? {}).filter(/** Retains configured severity outputs too. */ (id) => id.startsWith("severity_analysis_"))];
      if (sourceCallDoc.data()?.organizationId === "consubanco" && sourceRunDoc.data()?.status === "complete" &&
        sourceRunDoc.data()?.feedbackCache?.cacheKey === feedbackCacheKey && required.every(/** Requires a complete raw source baseline. */ (id) => raw[id])) {
        const candidate = raw as Parameters<typeof mergeSubagent2Outputs>[1];
        try {
          // Validate the reusable raw baseline before permitting a new deduction.
          mergeSubagent2Outputs(callId, candidate, normalizeTranscriptForAnalysis(timeline), null);
          outputs = candidate;
        } catch {
          console.warn("Cached raw rubric outputs unavailable for deterministic metrics; preserving cached feedback.");
        }
      }
    } catch {
      console.warn("Cached source snapshots unavailable; retaining cached feedback without new speed deduction.");
    }
  }

  const coreFields = outputs?.core_fields ?? {};
  const coreRef = runRef.collection("tasks").doc("core_fields");
  // Firestore snapshots source roles into this run only while its generation still owns the call.
  const current = await firestore.runTransaction(/** Refuses canceled or superseded cache materialization. */ async (transaction) => {
    const call = await transaction.get(callRef);
    const existing = await transaction.get(coreRef);
    if (call.data()?.status === "canceled" || call.data()?.activeAnalysisRunId !== runId ||
      getProcessingGeneration(call.data()) !== getProcessingGeneration(callData)) return false;
    if (existing.exists) return existing.data()?.status === "complete" &&
      stableStringify(existing.data()?.output) === stableStringify(coreFields);
    transaction.set(coreRef, { status: "complete", output: coreFields, attempts: 0,
      cacheSource: cacheSource ?? null, createdAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp() });
    return true;
  });
  if (!current) return { ...unchanged, aborted: true };
  const limitation = outputs ? undefined :
    "Cached source lacks authoritative speaker-role and unadjusted score evidence; cached feedback is preserved and no new speed deduction is applied.";
  const metrics = await ensureConversationMetrics(callId, callData, timeline, firestore, { runId, coreFields, limitation });
  if (!metrics) return { ...unchanged, aborted: true };
  let adjustment: ConversationSpeedAdjustment | null = null;
  const feedback = outputs ? mergeSubagent2Outputs(callId, outputs, normalizeTranscriptForAnalysis(timeline), metrics,
    /** Captures a fresh audit derived from raw base credit, never cached adjusted credit. */ (value) => { adjustment = value; })
    : unchanged.feedback;
  return { feedback, metrics, adjustment, aborted: false };
}

/** Documents the materializeCachedSubagent2Feedback behavior. */
async function materializeCachedSubagent2Feedback(params: {
  callId: string;
  runId: string;
  callRef: FirebaseFirestore.DocumentReference;
  runRef: FirebaseFirestore.DocumentReference;
  processingGeneration: number;
  feedbackCacheKey: string;
  cachedFeedback: Record<string, unknown>;
  cacheSource?: { callId: string; runId: string };
}): Promise<void> {
  const { callId, runId, callRef, runRef, processingGeneration, feedbackCacheKey, cachedFeedback } = params;

  /** Calls an external SDK or API dependency. */
  const callDoc = await callRef.get();
  const callData = callDoc.data() ?? {};
  const currentGeneration = getProcessingGeneration(callData);
  const activeRunId =
    typeof callData.activeAnalysisRunId === "string" ? callData.activeAnalysisRunId : undefined;

  if (currentGeneration !== processingGeneration || activeRunId !== runId) {
    /** Calls Firebase Firestore to read or write persisted application data. */
    const runDoc = await runRef.get();
    await finalizeRunAsSupersededIfStale(callRef, runRef, runId, runDoc.data());
    console.log(`Cache: run ${runId} became superseded before cache materialization`);
    return;
  }

  let prepared: Awaited<ReturnType<typeof prepareCachedOpenAiFeedback>> = {
    feedback: { ...cachedFeedback, call_id: callId }, metrics: null, adjustment: null, aborted: false,
  };
  try {
    prepared = await prepareCachedOpenAiFeedback({ ...params, callData, cachedFeedback });
  } catch {
    // Optional deterministic evidence must not turn an otherwise valid cache hit into failed feedback.
    console.warn("Cached-call metrics could not be prepared; retaining cached feedback without a new speed deduction.");
  }
  if (prepared.aborted) return;
  const feedback = prepared.feedback;

  const { legacyAiTestMarkerFields, needsAutoCategory } = getFinalizerCallCategoryGuardrails(
    callData.category
  );
  let routingResult = {
    callUpdate: {} as Record<string, unknown>,
    materializedCallFields: {} as Record<string, unknown>,
  };
  try {
    if (!isTranscriptionComparisonCall(callData)) routingResult = await routeGeneralAgentCallAfterFeedback({
      callId,
      callData,
      feedback,
    });
  } catch (error) {
    console.error(`Agent routing failed for cache hit ${callId}/${runId}:`, error);
  }

  /** Calls an external SDK or API dependency. */
  const feedbackRef = callRef.collection("feedback").doc(runId);
  // Firestore publishes feedback and restricted audit only while the same call/run/timeline still owns them.
  const published = await db.runTransaction(/** Prevents a concurrent cancellation from being overwritten. */ async (transaction) => {
    const latestCall = await transaction.get(callRef);
    const latest = latestCall.data();
    if (latest?.status === "canceled" || latest?.activeAnalysisRunId !== runId ||
        getProcessingGeneration(latest) !== processingGeneration) return false;
    const identity = prepared.metrics?.identity;
    if (prepared.metrics) {
      const metricsRef = db.collection(CONVERSATION_METRICS_COLLECTION).doc(callId);
      const timeline = await transaction.get(callRef.collection("transcript").doc("data"));
      const stored = await transaction.get(metricsRef);
      if (!identity || !conversationMetricsDocumentMatches(stored.data(), identity) ||
          !await conversationMetricsSourceMatches(transaction, callRef, latest, timeline.data(), identity)) return false;
      transaction.update(metricsRef, { speedAdjustment: prepared.adjustment, updatedAt: FieldValue.serverTimestamp() });
    }
    /** Calls an external SDK or API dependency. */
    transaction.set(feedbackRef, {
      ...feedback,
      analyzedAt: FieldValue.serverTimestamp(),
    });
    /** Calls an external SDK or API dependency. */
    transaction.update(callRef, {
      status: "complete",
      latestFeedbackId: runId,
      latestFeedbackCacheKey: feedbackCacheKey,
      activeAnalysisRunId: FieldValue.delete(),
      lastTerminalRunId: runId,
      lastRunStatus: "complete",
      analysisCompletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(needsAutoCategory ? { category: (feedback as any).call_category } : {}),
      ...legacyAiTestMarkerFields,
      ...routingResult.callUpdate,
      ...buildClearCallErrorUpdate(),
    });
    /** Calls an external SDK or API dependency. */
    transaction.update(runRef, {
      status: "complete",
      finalizedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      feedbackCacheHit: true,
      ...buildClearCallErrorUpdate(),
    });
    return true;
  });
  if (!published) return;

  await maybeCreateCallUnrecognizedInboxMessage({
    callId,
    runId,
    callData,
    routingResult,
  });
  await maybeCreateCallAnalysisTerminalInboxMessage({
    callId,
    runId,
    callData,
    status: "complete",
  });

  console.log(`Cache: feedback materialized to ${callId}/feedback/${runId}`);

  try {
    const linkedCallData = {
      ...callData,
      latestFeedbackId: runId,
      latestFeedbackCacheKey: feedbackCacheKey,
      status: "complete",
      ...(needsAutoCategory ? { category: (feedback as any).call_category } : {}),
      ...legacyAiTestMarkerFields,
      ...routingResult.materializedCallFields,
    } as Record<string, any>;
    const uploadedBy = typeof linkedCallData.uploadedBy === "string" ? linkedCallData.uploadedBy : "";
    const salesAgentId = typeof linkedCallData.salesAgentId === "string" ? linkedCallData.salesAgentId : "";
    const audioContentHash =
      typeof linkedCallData.audioContentHash === "string" ? linkedCallData.audioContentHash : "";
    const audioStorageMd5Hash =
      typeof linkedCallData.audioStorageMd5Hash === "string" ? linkedCallData.audioStorageMd5Hash : "";
    const duplicateFingerprintKeys = buildDuplicateFingerprintKeys({
      audioContentHash,
      audioStorageMd5Hash,
    });
    if (!isTranscriptionComparisonCall(linkedCallData) && uploadedBy && salesAgentId && duplicateFingerprintKeys.length > 0) {
      /** Calls Firebase Firestore to reconcile duplicate calls as they link into an agent profile. */
      const reconciliation = await reconcileAgentProfileDuplicates({
        uploadedBy,
        salesAgentId,
        detectedBy: "on_link",
        actorUserId: uploadedBy,
        agentAnalysisId:
          typeof linkedCallData.matchedAgentAnalysisId === "string"
            ? linkedCallData.matchedAgentAnalysisId
            : undefined,
        salesAgentName:
          typeof linkedCallData.salesAgentName === "string"
            ? linkedCallData.salesAgentName
            : undefined,
        onlyAudioContentHash: audioContentHash,
        onlyAudioStorageMd5Hash: audioStorageMd5Hash,
      });
      const canonicalCallId = duplicateFingerprintKeys
        .map(
          /** Handles the callback for this operation. */
          (fingerprintKey) => reconciliation.canonicalByDuplicateFingerprint[fingerprintKey]
        )
        .find(/** Handles the callback for this operation. */ (candidate) => Boolean(candidate));
      if (canonicalCallId && canonicalCallId !== callId) {
        return;
      }
    }

    await syncAgentActivityForCall({
      callId,
      callData: linkedCallData,
      feedback,
    });
  } catch (error) {
    console.error(`Agent activity sync failed for cache hit ${callId}/${runId}:`, error);
  }
}

/** Documents the writeSubagent2FeedbackCacheIfAbsent behavior. */
export async function writeSubagent2FeedbackCacheIfAbsent(params: {
  cacheState: Subagent2FeedbackCacheRunState;
  promptPaths: Record<string, string>;
  callId: string;
  runId: string;
  feedback: Record<string, unknown>;
}): Promise<void> {
  const { cacheState, promptPaths, callId, runId, feedback } = params;

  /** Calls Firebase Firestore to read or write persisted application data. */
  const cacheRef = db.collection(SUBAGENT_2_0_FEEDBACK_CACHE_COLLECTION).doc(cacheState.cacheKey);

  /** Calls Firebase Firestore to read or write persisted application data. */
  await db.runTransaction(/** Handles the callback for this operation. */ async (txn) => {
    // Recheck the trusted flag before touching shared cache, including old runs with cache metadata.
    const call = await txn.get(db.collection("calls").doc(callId));
    if (isTranscriptionComparisonCall(call.data())) return;
    const existing = await txn.get(cacheRef);
    if (existing.exists) {
      /** Calls an external SDK or API dependency. */
      txn.update(cacheRef, {
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    /** Calls an external SDK or API dependency. */
    txn.set(cacheRef, {
      schemaVersion: cacheState.schemaVersion,
      analysisMode: cacheState.analysisMode,
      analyzerModel: cacheState.analyzerModel,
      transcriptHash: cacheState.transcriptHash,
      transcriptNormalizationStrategy: cacheState.transcriptNormalizationStrategy,
      promptPaths,
      promptHashes: cacheState.promptHashes,
      feedback,
      sourceCallId: callId,
      sourceRunId: runId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      hitCount: 0,
      lastHitAt: null,
    });
  });
}

// ── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Creates an analysis run and dispatches subagent task docs.
 * Called from onStartAnalyzing when status changes to 'analyzing'.
 */
export async function dispatchSubagentTasks(callId: string): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection("calls").doc(callId);
  const runId = `analysis_${Date.now()}`;
  const analysisMode = getAnalysisModeFromEnv();
  const { taskIds, prompts: defaultPrompts } = getSubagentConfig(analysisMode);
  const initialTaskIds =
    analysisMode === "subagent_2_0" ? SUBAGENT_2_0_STAGE1_TASK_IDS : taskIds;

  // Guard: if there's already an active run, don't re-dispatch
  const callDoc = await callRef.get();
  if (!callDoc.exists) {
    throw new Error(`Call ${callId} not found`);
  }
  const callData = callDoc.data();
  const existingRunId = callData?.activeAnalysisRunId;
  const processingGeneration = getProcessingGeneration(callData);
  if (existingRunId) {
    /** Calls an external SDK or API dependency. */
    const existingRunRef = callRef.collection("analysis_runs").doc(existingRunId);
    const existingRun = await existingRunRef.get();
    const existingRunData = existingRun.data() ?? {};
    const existingRunStatus = existingRunData.status;

    if (
      existingRun.exists &&
      existingRunStatus === "running" &&
      !existingRunData.finalizedAt
    ) {
      console.log(
        `Skipping dispatch: active run ${existingRunId} already exists for ${callId}`
      );
      return;
    }

    /** Calls an external SDK or API dependency. */
    await callRef.update({
      activeAnalysisRunId: FieldValue.delete(),
      ...(existingRun.exists
        ? {
          lastTerminalRunId: existingRunId,
          lastRunStatus: existingRunStatus ?? "error",
        }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  // Resolve prompt paths: apply per-subagent overrides from the call doc if present
  const promptOverrides: Record<string, string> | undefined = callData?.promptOverrides;
  const analyzerModel = callData?.analyzerModel === undefined
    ? DEFAULT_ANALYZER_MODEL : requireAnalyzerModel(callData.analyzerModel);
  const analyzerModelOverrides = validateAnalyzerModelOverrides(callData?.analyzerModelOverrides);
  const effectiveAnalyzerModels = resolveSubagentModels(analyzerModel, analyzerModelOverrides);
  const resolvedPrompts: Record<string, string> = { ...defaultPrompts };

  if (analysisMode === "subagent_2_0" && promptOverrides) {
    for (const [taskId, version] of Object.entries(promptOverrides)) {
      if ((SUBAGENT_2_0_TASK_IDS as readonly string[]).includes(taskId)) {
        resolvedPrompts[taskId] = resolveSubagent2PromptPath(taskId as Subagent2TaskId, version);
      }
    }
    console.log(`Prompt overrides applied for call ${callId}:`, promptOverrides);
  }

  let feedbackCacheState: Subagent2FeedbackCacheState | null = null;
  let cachedFeedback: Record<string, unknown> | null = null;
  let cacheSource: { callId: string; runId: string } | undefined;

  if (analysisMode === "subagent_2_0" && !isTranscriptionComparisonCall(callData)) {
    feedbackCacheState = await computeSubagent2FeedbackCacheState({
      callId,
      callRef,
      analyzerModel,
      promptPaths: resolvedPrompts,
      effectiveAnalyzerModels,
    });

    if (feedbackCacheState) {
      /** Calls Firebase Firestore to read or write persisted application data. */
      const cacheRef = db
        .collection(SUBAGENT_2_0_FEEDBACK_CACHE_COLLECTION)
        .doc(feedbackCacheState.cacheKey);
      /** Calls an external SDK or API dependency. */
      const cacheDoc = await cacheRef.get();
      const cacheData = cacheDoc.data();
      const cachedPayload = cacheData?.feedback;
      if (cacheDoc.exists && cachedPayload && typeof cachedPayload === "object") {
        cachedFeedback = cachedPayload as Record<string, unknown>;
        if (typeof cacheData?.sourceCallId === "string" && typeof cacheData?.sourceRunId === "string") {
          cacheSource = { callId: cacheData.sourceCallId, runId: cacheData.sourceRunId };
        }
        console.log(
          `Cache hit for call ${callId}: key=${feedbackCacheState.cacheKey} model=${analyzerModel} transcriptHash=${feedbackCacheState.transcriptHash}`
        );
      } else {
        console.log(
          `Cache miss for call ${callId}: key=${feedbackCacheState.cacheKey} model=${analyzerModel} transcriptHash=${feedbackCacheState.transcriptHash}`
        );
      }
    }
  }

  // Write the run doc
  const runRef = callRef.collection("analysis_runs").doc(runId);
  /** Calls an external SDK or API dependency. */
  await runRef.set({
    status: "running",
    analysisMode,
    analyzerModel,
    analyzerModelOverrides,
    effectiveAnalyzerModels,
    processingGeneration,
    promptPaths: resolvedPrompts,
    ...(isTranscriptionComparisonCall(callData) ? { feedbackCacheHit: false, transcriptionComparison: true } : {}),
    ...(analysisMode === "subagent_2_0" && feedbackCacheState
      ? {
        feedbackCache: {
          schemaVersion: feedbackCacheState.schemaVersion,
          analysisMode: feedbackCacheState.analysisMode,
          cacheKey: feedbackCacheState.cacheKey,
          analyzerModel: feedbackCacheState.analyzerModel,
          transcriptHash: feedbackCacheState.transcriptHash,
          transcriptNormalizationStrategy: feedbackCacheState.transcriptNormalizationStrategy,
          promptHashes: feedbackCacheState.promptHashes,
        },
        feedbackCacheHit: Boolean(cachedFeedback),
      }
      : {}),
    totalTasks: initialTaskIds.length,
    completedTasks: 0,
    ...(analysisMode === "subagent_2_0" ? { stage2DispatchedAt: null } : {}),
    createdAt: FieldValue.serverTimestamp(),
  });

  // Store activeAnalysisRunId on the call doc
  await callRef.update({
    activeAnalysisRunId: runId,
    analysisStartedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...buildClearCallErrorUpdate(),
  });

  if (analysisMode === "subagent_2_0" && feedbackCacheState && cachedFeedback) {
    await materializeCachedSubagent2Feedback({
      callId,
      runId,
      callRef,
      runRef,
      processingGeneration,
      feedbackCacheKey: feedbackCacheState.cacheKey,
      cachedFeedback,
      cacheSource,
    });
    return;
  }

  // Create all task docs (this triggers onSubagentTaskCreated for each)
  const batch = db.batch();
  for (const taskId of initialTaskIds) {
    /** Calls an external SDK or API dependency. */
    const taskRef = runRef.collection("tasks").doc(taskId);
    /** Calls an external SDK or API dependency. */
    batch.set(taskRef, {
      status: "pending",
      attempts: 0,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();

  console.log(
    `Dispatched ${initialTaskIds.length} initial subagent tasks for call ${callId}, run ${runId} (mode=${analysisMode})`
  );
}

// ── Task Runner ────────────────────────────────────────────────────────────

/**
 * Runs a single subagent task: loads prompt, calls OpenAI, parses output,
 * writes result to task doc, and increments the run's completion counter.
 * If all tasks are done, triggers the finalizer.
 */
export async function runSubagentTask(
  callId: string,
  runId: string,
  taskId: string
): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection("calls").doc(callId);
  /** Calls an external SDK or API dependency. */
  const runRef = callRef.collection("analysis_runs").doc(runId);
  /** Calls an external SDK or API dependency. */
  const taskRef = runRef.collection("tasks").doc(taskId);
  const runDoc = await runRef.get();
  const runData = runDoc.data();
  if (!runDoc.exists || !runData) {
    console.log(`Run doc not found: ${callId}/${runId}`);
    return;
  }
  if (runData.finalizedAt) {
    console.log(`Run ${runId} already finalized, skipping task ${taskId}`);
    return;
  }
  const analysisMode: AnalysisMode =
    runData?.analysisMode === "subagent_2_0" ? "subagent_2_0" : "legacy_tmk";
  const runModel = runData?.analyzerModel === undefined
    ? DEFAULT_ANALYZER_MODEL : requireAnalyzerModel(runData.analyzerModel);
  const analyzerModel = runData.effectiveAnalyzerModels?.[taskId] !== undefined
    ? requireAnalyzerModel(runData.effectiveAnalyzerModels[taskId])
    : validateAnalyzerModelOverrides(runData.analyzerModelOverrides)[taskId as Subagent2TaskId] ?? runModel;
  const { prompts: configPrompts } = getSubagentConfig(analysisMode);
  const processingGeneration = getProcessingGeneration(runData);

  // Use run-level prompt paths if available (supports per-call overrides), else fall back to config
  const promptPaths: Record<string, string> | undefined = runData?.promptPaths;

  // Idempotency: only process pending tasks
  const taskDoc = await taskRef.get();
  const taskData = taskDoc.data();
  if (!taskDoc.exists || !taskData) {
    console.log(`Task doc not found: ${callId}/${runId}/${taskId}`);
    return;
  }
  if (taskData.status !== "pending") {
    console.log(
      `Skipping task ${taskId} — status is '${taskData.status}', not 'pending'`
    );
    return;
  }

  if (await finalizeRunAsSupersededIfStale(callRef, runRef, runId, runData)) {
    const staleTaskError = serializeCallError(
      {
        message: `Task ${taskId} skipped because analysis run ${runId} was superseded`,
        code: "stale_generation",
      },
      "analysis_task"
    );

    /** Calls an external SDK or API dependency. */
    await taskRef.update({
      status: "error",
      model: analyzerModel,
      completedAt: FieldValue.serverTimestamp(),
      ...buildCallErrorUpdate(staleTaskError),
    });
    return;
  }

  // Mark as running
  await taskRef.update({
    status: "running",
    attempts: (taskData.attempts || 0) + 1,
    model: analyzerModel,
    startedAt: FieldValue.serverTimestamp(),
  });

  let outputPrimaryValidationAttempts = 0;
  const usageResponses: OpenAI.CompletionUsage[] = [];
  let outputPrimaryValidation: RubricOutputValidationResult | null = null;
  let outputFinalValidation: RubricOutputValidationResult | null = null;
  let outputFallbackAttempts = 0;
  let outputFallbackRecoveredCriterionIds: string[] = [];

  try {
    // Resolve prompt path: prefer run-level overrides, fall back to config
    const promptPath = promptPaths?.[taskId] ?? configPrompts[taskId];
    if (!promptPath) {
      throw new Error(`Unknown subagent taskId: ${taskId} (mode=${analysisMode})`);
    }

    // Load transcript
    const transcriptDoc = await callRef
      .collection("transcript")
      .doc("data")
      .get();
    if (!transcriptDoc.exists) {
      throw new Error("Transcript not found");
    }
    const transcriptData = transcriptDoc.data()!;
    const normalizedTranscriptData = normalizeTranscriptForAnalysis(transcriptData);

    // Load subagent system prompt
    const systemPrompt = fs.readFileSync(
      path.join(__dirname, promptPath),
      "utf-8"
    );

    let userPrompt: string;
    if (analysisMode === "subagent_2_0" && isSubagent2SeverityTaskId(taskId)) {
      const parentTaskId = SUBAGENT_2_0_SEVERITY_PARENT_TASK_IDS[taskId as Subagent2SeverityTaskId];
      /** Calls an external SDK or API dependency. */
      const parentTaskDoc = await runRef.collection("tasks").doc(parentTaskId).get();
      const parentOutput = parentTaskDoc.data()?.output;
      if (!parentOutput?.rubric_criteria_results) {
        throw new Error(`Missing rubric output for parent task ${parentTaskId}`);
      }

      const severityInputPayload = buildSeverityAnalysisInputPayload(
        callId,
        normalizedTranscriptData,
        parentOutput
      );
      userPrompt = buildSubagent2SeverityUserPrompt(severityInputPayload);
    } else {
      // Build user prompt
      userPrompt = `## Input Data

**call_id:** "${callId}"

**Transcript JSON:**
\`\`\`json
${JSON.stringify(normalizedTranscriptData)}
\`\`\`

Analyze this transcript according to the instructions and output schema provided in your system prompt.`;
    }

    // Call OpenAI
    const openai = createDemoOpenAI({ purpose: 'call_analysis', callId, processingGeneration });
    /** Calls the OpenAI API for model inference or transcription. */
    const response = await openai.chat.completions.create({
      model: analyzerModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      // Keep analyzer runs as deterministic as possible so repeated evaluations
      // of the same transcript stay in the same score/category band.
      ...analyzerRequestOptions(analyzerModel),
    });
    if (response.usage) usageResponses.push(response.usage);

    const responseText = response.choices[0]?.message?.content;
    if (!responseText) {
      throw new Error("No response from OpenAI");
    }

    const currentCallDoc = await callRef.get();
    const currentCallData = currentCallDoc.data() ?? {};
    const currentGeneration = getProcessingGeneration(currentCallData);
    const activeRunId =
      typeof currentCallData.activeAnalysisRunId === "string"
        ? currentCallData.activeAnalysisRunId
        : undefined;

    if (currentGeneration !== processingGeneration || activeRunId !== runId) {
      throw {
        message: `Task ${taskId} completed after analysis run ${runId} was superseded`,
        code: "stale_generation",
      };
    }

    outputPrimaryValidationAttempts = isSubagent2RubricAnalysisTaskId(taskId) ? 1 : 0;
    let output: any = JSON.parse(responseText);
    const primaryValidation = validateSubagent2RubricOutput(taskId, output);
    outputPrimaryValidation = primaryValidation;
    outputFinalValidation = primaryValidation;

    if (primaryValidation?.valid) {
      output = canonicalizeRubricOutput(taskId, output);
      outputFinalValidation = validateSubagent2RubricOutput(taskId, output);
    } else if (primaryValidation) {
      console.warn(
        `Subagent ${taskId} returned invalid rubric output for ${callId}/${runId}: ` +
        primaryValidation.message
      );

      if (!canUseMissingCriterionFallback(primaryValidation)) {
        throw buildInvalidRubricOutputError(primaryValidation);
      }

      const fallbackResult = await fillMissingRubricCriteriaWithFallback({
        openai,
        analyzerModel,
        taskId,
        callId,
        runId,
        systemPrompt,
        userPrompt,
        output,
        validation: primaryValidation,
        onUsage: (usage) => { usageResponses.push(usage); },
      });

      output = fallbackResult.output;
      outputFallbackAttempts = fallbackResult.fallbackAttempts;
      outputFallbackRecoveredCriterionIds = fallbackResult.fallbackCriterionIds;

      const validation = validateSubagent2RubricOutput(taskId, output);
      outputFinalValidation = validation;
      if (validation && !validation.valid) {
        throw buildInvalidRubricOutputError(validation);
      }

      output = canonicalizeRubricOutput(taskId, output);
      outputFinalValidation = validateSubagent2RubricOutput(taskId, output);
    }

    const latestCallDoc = await callRef.get();
    const latestCallData = latestCallDoc.data() ?? {};
    const latestGeneration = getProcessingGeneration(latestCallData);
    const latestActiveRunId =
      typeof latestCallData.activeAnalysisRunId === "string"
        ? latestCallData.activeAnalysisRunId
        : undefined;

    if (latestGeneration !== processingGeneration || latestActiveRunId !== runId) {
      throw {
        message: `Task ${taskId} completed after analysis run ${runId} was superseded`,
        code: "stale_generation",
      };
    }

    const sanitizedOutput = sanitizeSubagentOutputForFirestore(output);

    // Write success
    await taskRef.update({
      status: "complete",
      output: sanitizedOutput.output,
      ...(usageResponses.length ? { usage: totalAnalysisUsage(usageResponses) } : {}),
      model: analyzerModel,
      prompt: promptPath,
      ...buildRubricOutputMetadata({
        taskId,
        primaryValidationAttempts: outputPrimaryValidationAttempts,
        primaryValidation: outputPrimaryValidation,
        finalValidation: outputFinalValidation,
        fallbackAttempts: outputFallbackAttempts,
        fallbackRecoveredCriterionIds: outputFallbackRecoveredCriterionIds,
      }),
      ...(sanitizedOutput.sanitized ? {
        outputSanitized: true,
        outputSanitizationIssues: sanitizedOutput.issues,
      } : {}),
      completedAt: FieldValue.serverTimestamp(),
    });

    console.log(`Subagent ${taskId} completed for ${callId}/${runId}`);

    // Increment counter and check if all done (transaction for atomicity)
    const allDone = await db.runTransaction(/** Handles the callback for this operation. */ async (txn) => {
      const runDoc = await txn.get(runRef);
      const runData = runDoc.data()!;
      const newCompleted = (runData.completedTasks || 0) + 1;
      /** Calls an external SDK or API dependency. */
      txn.update(runRef, {
        completedTasks: newCompleted,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return newCompleted === runData.totalTasks;
    });

    if (analysisMode === "subagent_2_0") {
      await maybeAdvanceSubagent2Run(callId, runId);
    } else if (allDone) {
      console.log(`All tasks done for ${callId}/${runId} — running finalizer`);
      await finalizeAnalysis(callId, runId);
    }
  } catch (error: any) {
    console.error(`Subagent ${taskId} failed for ${callId}/${runId}:`, error);
    const serializedError = serializeCallError(error, "analysis_task");

    if (serializedError.errorCode === "stale_generation" && await isCallCanceled(callRef)) {
      /** Calls an external SDK or API dependency. */
      await taskRef.update({
        status: "canceled",
        model: analyzerModel,
        canceledAt: FieldValue.serverTimestamp(),
        completedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    /** Calls an external SDK or API dependency. */
    await taskRef.update({
      status: "error",
      model: analyzerModel,
      ...(usageResponses.length ? { usage: totalAnalysisUsage(usageResponses) } : {}),
      ...buildRubricOutputMetadata({
        taskId,
        primaryValidationAttempts: outputPrimaryValidationAttempts,
        primaryValidation: outputPrimaryValidation,
        finalValidation: outputFinalValidation,
        fallbackAttempts: outputFallbackAttempts,
        fallbackRecoveredCriterionIds: outputFallbackRecoveredCriterionIds,
      }),
      completedAt: FieldValue.serverTimestamp(),
      ...buildCallErrorUpdate(serializedError),
    });

    // Increment counter even on error so finalizer can detect completion
    const allDone = await db.runTransaction(/** Handles the callback for this operation. */ async (txn) => {
      const runDoc = await txn.get(runRef);
      const runData = runDoc.data()!;
      const newCompleted = (runData.completedTasks || 0) + 1;
      /** Calls an external SDK or API dependency. */
      txn.update(runRef, {
        completedTasks: newCompleted,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return newCompleted === runData.totalTasks;
    });

    if (analysisMode === "subagent_2_0") {
      await maybeAdvanceSubagent2Run(callId, runId);
    } else if (allDone) {
      console.log(
        `All tasks done (with errors) for ${callId}/${runId} — running finalizer`
      );
      await finalizeAnalysis(callId, runId);
    }
  }
}

// ── Finalizer ──────────────────────────────────────────────────────────────

/**
 * Merges all subagent outputs into the final v5.3 feedback JSON,
 * validates invariants, and writes the feedback doc.
 */
async function finalizeAnalysis(
  callId: string,
  runId: string
): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection("calls").doc(callId);
  /** Calls an external SDK or API dependency. */
  const runRef = callRef.collection("analysis_runs").doc(runId);

  // Guard: only finalize once
  const runDoc = await runRef.get();
  const runData = runDoc.data();
  if (runData?.finalizedAt) {
    console.log(`Run ${runId} already finalized, skipping`);
    return;
  }
  const analysisMode: AnalysisMode =
    runData?.analysisMode === "subagent_2_0" ? "subagent_2_0" : "legacy_tmk";
  const { taskIds: activeTaskIds } = getSubagentConfig(analysisMode);
  const processingGeneration = getProcessingGeneration(runData);

  if (await finalizeRunAsSupersededIfStale(callRef, runRef, runId, runData)) {
    console.log(`Run ${runId} was superseded before finalization`);
    return;
  }

  // Read all task docs
  const tasksSnapshot = await runRef.collection("tasks").get();
  const tasks: Record<string, any> = {};
  let hasErrors = false;
  const errorMessages: string[] = [];

  for (const doc of tasksSnapshot.docs) {
    const data = doc.data();
    tasks[doc.id] = data;
    if (data.status === "error") {
      hasErrors = true;
      errorMessages.push(`${doc.id}: ${data.error || "unknown error"}`);
    }
  }

  // If any subagent failed, mark the call as error
  if (hasErrors) {
    console.error(
      `Finalizer: ${errorMessages.length} subagent(s) failed for ${callId}/${runId}: ${errorMessages.join("; ")}`
    );

    const failingTask =
      Object.values(tasks).find(/** Handles the callback for this operation. */(task: any) => task?.errorCode === "insufficient_quota") ||
      Object.values(tasks).find(/** Handles the callback for this operation. */(task: any) => task?.status === "error");
    const finalizerError = buildFinalizerError(
      `Subagent analysis failed: ${errorMessages.join("; ")}`,
      failingTask as Record<string, any> | undefined
    );

    /** Calls Firebase Firestore to read or write persisted application data. */
    const batch = db.batch();
    /** Calls an external SDK or API dependency. */
    batch.update(runRef, {
      status: "error",
      finalizedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...buildCallErrorUpdate(finalizerError),
    });
    /** Calls an external SDK or API dependency. */
    batch.update(callRef, {
      status: "error",
      activeAnalysisRunId: FieldValue.delete(),
      lastTerminalRunId: runId,
      lastRunStatus: "error",
      analysisCompletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...buildCallErrorUpdate(finalizerError),
    });
    await batch.commit();

    /** Calls Firebase Firestore to load call ownership metadata for terminal error inbox messages. */
    const terminalCallDoc = await callRef.get();
    const retry = await recordRuntimeFailureForDelayedRetry({
      callRef,
      stage: "analysis",
      error: finalizerError,
      failedRunId: runId,
    });
    if (!retry.retried) {
      await maybeCreateCallAnalysisTerminalInboxMessage({
        callId,
        runId,
        callData: terminalCallDoc.data() ?? {},
        status: "error",
        errorCode: finalizerError.errorCode ?? null,
      });
    }
    return;
  }

  // Extract outputs
  const coreOutput = tasks.core_fields?.output;
  const scorecardOutput = tasks.rubric_scorecard?.output;
  const strengthsOutput = tasks.strengths?.output;
  const weaknessesOutput = tasks.weaknesses?.output;
  const coachingOutput = tasks.coaching?.output;

  // Verify all outputs exist
  if (activeTaskIds.some(/** Handles the callback for this operation. */(id) => !tasks[id]?.output)) {
    const missing = activeTaskIds.filter(/** Handles the callback for this operation. */(id) => !tasks[id]?.output);
    const errorMsg = `Missing outputs from: ${missing.join(", ")}`;
    console.error(`Finalizer: ${errorMsg}`);

    const finalizerError = buildFinalizerError(errorMsg);
    /** Calls Firebase Firestore to read or write persisted application data. */
    const batch = db.batch();
    /** Calls an external SDK or API dependency. */
    batch.update(runRef, {
      status: "error",
      finalizedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...buildCallErrorUpdate(finalizerError),
    });
    /** Calls an external SDK or API dependency. */
    batch.update(callRef, {
      status: "error",
      activeAnalysisRunId: FieldValue.delete(),
      lastTerminalRunId: runId,
      lastRunStatus: "error",
      analysisCompletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...buildCallErrorUpdate(finalizerError),
    });
    await batch.commit();

    /** Calls Firebase Firestore to load call ownership metadata for terminal error inbox messages. */
    const terminalCallDoc = await callRef.get();
    const retry = await recordRuntimeFailureForDelayedRetry({
      callRef,
      stage: "analysis",
      error: finalizerError,
      failedRunId: runId,
    });
    if (!retry.retried) {
      await maybeCreateCallAnalysisTerminalInboxMessage({
        callId,
        runId,
        callData: terminalCallDoc.data() ?? {},
        status: "error",
        errorCode: finalizerError.errorCode ?? null,
      });
    }
    return;
  }

  // Merge outputs (mode-specific)
  let feedback: any;
  let conversationMetrics: ConversationMetricsReport | null = null;
  let speedAdjustment: ConversationSpeedAdjustment | null = null;
  if (analysisMode === "subagent_2_0") {
    /** Calls an external SDK or API dependency. */
    const transcriptDoc = await callRef.collection("transcript").doc("data").get();
    /** Reads current call identity before deriving restricted timestamp metrics. */
    const metricsCallDoc = await callRef.get();
    if (!metricsCallDoc.exists || getProcessingGeneration(metricsCallDoc.data()) !== processingGeneration) return;
    try {
      const timeline = await loadTranscriptTimeline(callRef);
      conversationMetrics = await ensureConversationMetrics(callId, metricsCallDoc.data() ?? {}, timeline, db, { runId, coreFields: coreOutput });
    } catch {
      // Supplemental evidence must not invent a penalty or prevent the core rubric from completing.
      console.warn(`Conversation metrics unavailable for ${callId}/${runId}`);
    }
    const transcriptData = transcriptDoc.exists ? normalizeTranscriptForAnalysis(transcriptDoc.data()) : null;
    feedback = mergeSubagent2Outputs(callId, {
      core_fields: tasks.core_fields.output,
      coaching: tasks.coaching.output,
      rubric_analysis_A: tasks.rubric_analysis_A.output,
      rubric_analysis_B: tasks.rubric_analysis_B.output,
      rubric_analysis_C: tasks.rubric_analysis_C.output,
      rubric_analysis_D: tasks.rubric_analysis_D.output,
      severity_analysis_A: tasks.severity_analysis_A?.output,
      severity_analysis_B: tasks.severity_analysis_B?.output,
      severity_analysis_C: tasks.severity_analysis_C?.output,
      severity_analysis_D: tasks.severity_analysis_D?.output,
    }, transcriptData, conversationMetrics, /** Captures audit without adding it to agent-readable feedback. */ (adjustment) => {
      speedAdjustment = adjustment;
    });
  } else {
    // Legacy TMK merge
    feedback = mergeSubagentOutputs(callId, {
      core_fields: coreOutput,
      rubric_scorecard: scorecardOutput,
      strengths: strengthsOutput,
      weaknesses: weaknessesOutput,
      coaching: coachingOutput,
    });
    // Validate and repair TMK scorecard
    feedback = validateAndSanitizeScorecard(feedback);
  }

  const callDoc = await callRef.get();
  const callData = callDoc.data() ?? {};
  const currentGeneration = getProcessingGeneration(callData);
  const activeRunId =
    typeof callData.activeAnalysisRunId === "string" ? callData.activeAnalysisRunId : undefined;
  if (currentGeneration !== processingGeneration || activeRunId !== runId) {
    await finalizeRunAsSupersededIfStale(callRef, runRef, runId, runData);
    console.log(`Run ${runId} became superseded during finalization`);
    return;
  }
  const { legacyAiTestMarkerFields, needsAutoCategory } = getFinalizerCallCategoryGuardrails(
    callData.category
  );
  let routingResult = {
    callUpdate: {} as Record<string, unknown>,
    materializedCallFields: {} as Record<string, unknown>,
  };
  try {
    if (!isTranscriptionComparisonCall(callData)) routingResult = await routeGeneralAgentCallAfterFeedback({
      callId,
      callData,
      feedback,
    });
  } catch (error) {
    console.error(`Agent routing failed for ${callId}/${runId}:`, error);
  }

  const latestCallDoc = await callRef.get();
  const latestCallData = latestCallDoc.data() ?? {};
  const comparisonCall = isTranscriptionComparisonCall(latestCallData) || runData?.transcriptionComparison === true;
  const latestGeneration = getProcessingGeneration(latestCallData);
  const latestActiveRunId =
    typeof latestCallData.activeAnalysisRunId === "string" ? latestCallData.activeAnalysisRunId : undefined;
  if (latestGeneration !== processingGeneration || latestActiveRunId !== runId) {
    await finalizeRunAsSupersededIfStale(callRef, runRef, runId, runData);
    console.log(`Run ${runId} became superseded before feedback write`);
    return;
  }

  /** Calls an external SDK or API dependency. */
  const feedbackRef = callRef.collection("feedback").doc(runId);
  /** Calls Firebase Firestore to read or write persisted application data. */
  const batch = db.batch();
  /** Calls an external SDK or API dependency. */
  batch.set(feedbackRef, {
    ...feedback,
    analyzedAt: FieldValue.serverTimestamp(),
  });
  /** Calls an external SDK or API dependency. */
  batch.update(callRef, {
    status: "complete",
    latestFeedbackId: runId,
    ...(!comparisonCall && analysisMode === "subagent_2_0" &&
    typeof (runData?.feedbackCache as Subagent2FeedbackCacheRunState | undefined)?.cacheKey === "string"
      ? {
        latestFeedbackCacheKey: (runData?.feedbackCache as Subagent2FeedbackCacheRunState).cacheKey,
      }
      : {}),
    ...(comparisonCall ? { latestFeedbackCacheKey: FieldValue.delete() } : {}),
    activeAnalysisRunId: FieldValue.delete(),
    lastTerminalRunId: runId,
    lastRunStatus: "complete",
    analysisCompletedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...(needsAutoCategory ? { category: feedback.call_category } : {}),
    ...legacyAiTestMarkerFields,
    ...routingResult.callUpdate,
    ...buildClearCallErrorUpdate(),
  });
  /** Calls an external SDK or API dependency. */
  batch.update(runRef, {
    status: "complete",
    finalizedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...buildClearCallErrorUpdate(),
  });
  await batch.commit();

  if (conversationMetrics) {
    try {
      await persistConversationSpeedAdjustment(callId, processingGeneration, conversationMetrics, speedAdjustment);
      await enqueueConversationMetricsInterpretation(callId);
    } catch (error) {
      console.error(`Conversation metrics follow-up failed for ${callId}/${runId}:`, error);
    }
  }

  await maybeCreateCallUnrecognizedInboxMessage({
    callId,
    runId,
    callData,
    routingResult,
  });
  await maybeCreateCallAnalysisTerminalInboxMessage({
    callId,
    runId,
    callData,
    status: "complete",
  });

  console.log(`Finalizer: feedback written to ${callId}/feedback/${runId}`);

  const feedbackCacheKey =
    !comparisonCall && analysisMode === "subagent_2_0" &&
    typeof (runData?.feedbackCache as Subagent2FeedbackCacheRunState | undefined)?.cacheKey === "string"
      ? (runData?.feedbackCache as Subagent2FeedbackCacheRunState).cacheKey
      : null;

  if (analysisMode === "subagent_2_0") {
    const cacheState = runData?.feedbackCache as Subagent2FeedbackCacheRunState | undefined;
    const promptPaths = (runData?.promptPaths ?? {}) as Record<string, string>;
    if (!comparisonCall && cacheState?.cacheKey) {
      try {
        await writeSubagent2FeedbackCacheIfAbsent({
          cacheState,
          promptPaths,
          callId,
          runId,
          feedback: (feedback ?? {}) as Record<string, unknown>,
        });
      } catch (error) {
        console.error(`Cache write failed for ${callId}/${runId}:`, error);
      }
    }
  }

  try {
    const linkedCallData = {
      ...callData,
      latestFeedbackId: runId,
      ...(feedbackCacheKey ? { latestFeedbackCacheKey: feedbackCacheKey } : {}),
      status: "complete",
      ...(needsAutoCategory ? { category: feedback.call_category } : {}),
      ...legacyAiTestMarkerFields,
      ...routingResult.materializedCallFields,
    } as Record<string, any>;
    const uploadedBy = typeof linkedCallData.uploadedBy === "string" ? linkedCallData.uploadedBy : "";
    const salesAgentId = typeof linkedCallData.salesAgentId === "string" ? linkedCallData.salesAgentId : "";
    const audioContentHash =
      typeof linkedCallData.audioContentHash === "string" ? linkedCallData.audioContentHash : "";
    const audioStorageMd5Hash =
      typeof linkedCallData.audioStorageMd5Hash === "string" ? linkedCallData.audioStorageMd5Hash : "";
    const duplicateFingerprintKeys = buildDuplicateFingerprintKeys({
      audioContentHash,
      audioStorageMd5Hash,
    });
    if (!isTranscriptionComparisonCall(linkedCallData) && uploadedBy && salesAgentId && duplicateFingerprintKeys.length > 0) {
      /** Calls Firebase Firestore to reconcile duplicate calls as they link into an agent profile. */
      const reconciliation = await reconcileAgentProfileDuplicates({
        uploadedBy,
        salesAgentId,
        detectedBy: "on_link",
        actorUserId: uploadedBy,
        agentAnalysisId:
          typeof linkedCallData.matchedAgentAnalysisId === "string"
            ? linkedCallData.matchedAgentAnalysisId
            : undefined,
        salesAgentName:
          typeof linkedCallData.salesAgentName === "string"
            ? linkedCallData.salesAgentName
            : undefined,
        onlyAudioContentHash: audioContentHash,
        onlyAudioStorageMd5Hash: audioStorageMd5Hash,
      });
      const canonicalCallId = duplicateFingerprintKeys
        .map(
          /** Handles the callback for this operation. */
          (fingerprintKey) => reconciliation.canonicalByDuplicateFingerprint[fingerprintKey]
        )
        .find(/** Handles the callback for this operation. */ (candidate) => Boolean(candidate));
      if (canonicalCallId && canonicalCallId !== callId) {
        return;
      }
    }

    await syncAgentActivityForCall({
      callId,
      callData: linkedCallData,
      feedback,
    });
  } catch (error) {
    console.error(`Agent activity sync failed for ${callId}/${runId}:`, error);
  }
}

// ── Merge Logic ────────────────────────────────────────────────────────────

/**
 * Attaches per-subsection critiques from strengths/weaknesses subagents
 * to matching rubric scorecard subsections by exact section_title + subsection_title.
 */
export function attachCritiquesToScorecard(
  scorecard: any,
  subsectionStrengths: any[],
  subsectionWeaknesses: any[]
): void {
  // Build lookup maps keyed by "section_title|subsection_title"
  const strengthsMap = new Map<string, any>();
  for (const entry of subsectionStrengths) {
    if (entry.section_title && entry.subsection_title) {
      strengthsMap.set(`${entry.section_title}|${entry.subsection_title}`, entry);
    }
  }

  const weaknessesMap = new Map<string, any>();
  for (const entry of subsectionWeaknesses) {
    if (entry.section_title && entry.subsection_title) {
      weaknessesMap.set(`${entry.section_title}|${entry.subsection_title}`, entry);
    }
  }

  // Walk scorecard and attach matching critiques
  if (!scorecard?.sections || !Array.isArray(scorecard.sections)) return;

  for (const section of scorecard.sections) {
    if (!section.subsections || !Array.isArray(section.subsections)) continue;
    for (const subsection of section.subsections) {
      const key = `${section.title}|${subsection.title}`;

      const strengthEntry = strengthsMap.get(key);
      if (strengthEntry?.good_critiques && Array.isArray(strengthEntry.good_critiques)) {
        subsection.good_critiques = strengthEntry.good_critiques;
      }

      const weaknessEntry = weaknessesMap.get(key);
      if (weaknessEntry) {
        if (weaknessEntry.bad_critiques && Array.isArray(weaknessEntry.bad_critiques)) {
          subsection.bad_critiques = weaknessEntry.bad_critiques;
        }
        if (weaknessEntry.subsection_improvement_tip) {
          subsection.subsection_improvement_tip = weaknessEntry.subsection_improvement_tip;
        }
      }
    }
  }
}

/**
 * Flattens per-subsection good_critiques into a flat FeedbackItem[] array.
 */
export function flattenGoodCritiques(subsectionStrengths: any[]): any[] {
  const flat: any[] = [];
  for (const entry of subsectionStrengths) {
    if (!entry.good_critiques || !Array.isArray(entry.good_critiques)) continue;
    for (const critique of entry.good_critiques) {
      flat.push({
        title: critique.title ?? "",
        detail: critique.detail ?? "",
        category: critique.category ?? "rubric",
      });
    }
  }
  return flat;
}

/**
 * Flattens per-subsection bad_critiques into a flat WeaknessItem[] array.
 */
export function flattenBadCritiques(subsectionWeaknesses: any[]): any[] {
  const flat: any[] = [];
  for (const entry of subsectionWeaknesses) {
    if (!entry.bad_critiques || !Array.isArray(entry.bad_critiques)) continue;
    for (const critique of entry.bad_critiques) {
      flat.push({
        title: critique.title ?? "",
        detail: critique.detail ?? "",
        severity: critique.severity ?? "minor",
        category: critique.category ?? "rubric",
        weakness_improvement_tip: critique.weakness_improvement_tip ?? "",
      });
    }
  }
  return flat;
}

/**
 * Merges the 5 subagent outputs into a single feedback object.
 * Computes derived fields deterministically.
 *
 * Supports both new per-subsection format (v5.8+ strengths, v5.9+ weaknesses)
 * and old flat-array format for rollback safety.
 */
export function mergeSubagentOutputs(
  callId: string,
  outputs: {
    core_fields: any;
    rubric_scorecard: any;
    strengths: any;
    weaknesses: any;
    coaching: any;
  }
): any {
  const { core_fields, rubric_scorecard, strengths, weaknesses, coaching } =
    outputs;

  // Extract earned_points from scorecard
  const earnedPoints =
    rubric_scorecard?.rubric_scorecard?.earned_points ?? 0;

  // Compute performance tier and call category
  const { tier, category } = computeTierAndCategory(earnedPoints);

  // Deep-clone scorecard to avoid mutating task doc data
  const scorecardObj = rubric_scorecard?.rubric_scorecard
    ? JSON.parse(JSON.stringify(rubric_scorecard.rubric_scorecard))
    : null;

  // Detect format: per-subsection (new) vs flat array (old)
  const isNewStrengthsFormat = Array.isArray(strengths?.rubric_subsection_strengths);
  const isNewWeaknessesFormat = Array.isArray(weaknesses?.rubric_subsection_weaknesses);

  let flatStrengths: any[];
  let flatWeaknesses: any[];

  if (isNewStrengthsFormat || isNewWeaknessesFormat) {
    const subsectionStrengths = strengths?.rubric_subsection_strengths ?? [];
    const subsectionWeaknesses = weaknesses?.rubric_subsection_weaknesses ?? [];

    // Attach critiques to scorecard subsections
    if (scorecardObj) {
      attachCritiquesToScorecard(scorecardObj, subsectionStrengths, subsectionWeaknesses);
    }

    // Flatten into backward-compatible arrays
    flatStrengths = isNewStrengthsFormat
      ? flattenGoodCritiques(subsectionStrengths)
      : strengths?.agent_strengths ?? [];
    flatWeaknesses = isNewWeaknessesFormat
      ? flattenBadCritiques(subsectionWeaknesses)
      : weaknesses?.agent_weaknesses ?? [];
  } else {
    // Old flat-array format (rollback / older prompt versions)
    flatStrengths = strengths?.agent_strengths ?? [];
    flatWeaknesses = weaknesses?.agent_weaknesses ?? [];
  }

  // Apply nullification rule: if loan_completed is "yes" or "no",
  // suggested_followup_message must be null
  const loanCompleted = core_fields?.loan_completed;
  let followupMessage = coaching?.suggested_followup_message ?? null;
  if (loanCompleted === "yes" || loanCompleted === "no") {
    followupMessage = null;
  }

  const managementAction = buildManagementActionPlanV1({
    weaknesses: flatWeaknesses,
    suggestedFollowupMessage: followupMessage,
  });

  return {
    call_id: callId,
    agent_speaker: core_fields?.agent_speaker ?? "unknown",
    customer_speaker: core_fields?.customer_speaker ?? "unknown",
    agent_name: core_fields?.agent_name ?? null,
    customer_name: core_fields?.customer_name ?? null,
    loan_completed: loanCompleted ?? "unclear",
    overall_score: earnedPoints,
    performance_tier: tier,
    call_category: category,
    rubric_scorecard: scorecardObj,
    agent_strengths: flatStrengths,
    agent_weaknesses: flatWeaknesses,
    management_action_v1: managementAction,
    mentorship_tip: coaching?.mentorship_tip ?? null,
    suggested_followup_message: followupMessage,
  };
}

/**
 * Maps an overall score to a performance tier and call category.
 */
export function computeTierAndCategory(score: number): {
  tier: string;
  category: string;
} {
  for (const band of TIER_BANDS) {
    if (score >= band.min) {
      return { tier: band.tier, category: band.category };
    }
  }
  return { tier: "poor", category: "bad" };
}

// ── Scorecard Validation ───────────────────────────────────────────────────

/**
 * Validates and sanitizes the rubric_scorecard to fix common LLM output issues:
 * 1. Section titles that are concatenated or duplicated
 * 2. Arithmetic inconsistencies (points don't sum correctly)
 *
 * This is a safety net - the subagent prompts should produce correct output,
 * but this ensures production data is always consistent.
 *
 * Extracted from analyze.ts for reuse by both monolithic and subagent paths.
 */
export function validateAndSanitizeScorecard(feedback: any): any {
  if (!feedback || !feedback.rubric_scorecard) {
    return feedback;
  }

  const scorecard = feedback.rubric_scorecard;
  let wasRepaired = false;

  // 1. Fix section titles if they contain | or are duplicated
  if (scorecard.sections && Array.isArray(scorecard.sections)) {
    const seenTitles = new Set<string>();

    scorecard.sections.forEach(/** Handles the callback for this operation. */(section: any, index: number) => {
      const originalTitle = section.title;

      // Check if title contains pipe (concatenated) or is duplicated
      if (
        originalTitle?.includes("|") ||
        seenTitles.has(originalTitle) ||
        !SECTION_TITLES.includes(originalTitle)
      ) {
        // Map to correct title based on index
        if (index < SECTION_TITLES.length) {
          section.title = SECTION_TITLES[index];
          wasRepaired = true;
          console.log(
            `Scorecard repair: Fixed section title from "${originalTitle}" to "${section.title}"`
          );
        }
      }
      seenTitles.add(section.title);
    });

    // 2. Validate and repair arithmetic (round to 1 decimal, recompute sums)
    let totalEarnedFromSections = 0;

    scorecard.sections.forEach(/** Handles the callback for this operation. */(section: any) => {
      if (section.subsections && Array.isArray(section.subsections)) {
        let sectionEarnedFromSubsections = 0;

        // Process subsections
        section.subsections.forEach(/** Handles the callback for this operation. */(subsection: any) => {
          // Round to 1 decimal
          if (typeof subsection.earned_points === "number") {
            const original = subsection.earned_points;
            subsection.earned_points =
              Math.round(subsection.earned_points * 10) / 10;

            // Clamp to 0..max_points
            if (subsection.max_points !== undefined) {
              subsection.earned_points = Math.max(
                0,
                Math.min(subsection.earned_points, subsection.max_points)
              );
            }

            if (original !== subsection.earned_points) {
              wasRepaired = true;
            }
          }
          sectionEarnedFromSubsections += subsection.earned_points || 0;
        });

        // Round section sum to 1 decimal
        sectionEarnedFromSubsections =
          Math.round(sectionEarnedFromSubsections * 10) / 10;

        // Check if section earned_points matches subsection sum
        if (section.earned_points !== sectionEarnedFromSubsections) {
          console.log(
            `Scorecard repair: Section "${section.title}" earned_points ${section.earned_points} -> ${sectionEarnedFromSubsections} (recomputed from subsections)`
          );
          section.earned_points = sectionEarnedFromSubsections;
          wasRepaired = true;
        }
      }

      totalEarnedFromSections += section.earned_points || 0;
    });

    // Round total to 1 decimal
    totalEarnedFromSections = Math.round(totalEarnedFromSections * 10) / 10;

    // 3. Check if rubric_scorecard.earned_points matches section sum
    if (scorecard.earned_points !== totalEarnedFromSections) {
      console.log(
        `Scorecard repair: Total earned_points ${scorecard.earned_points} -> ${totalEarnedFromSections} (recomputed from sections)`
      );
      scorecard.earned_points = totalEarnedFromSections;
      wasRepaired = true;
    }

    // 4. Ensure overall_score matches rubric_scorecard.earned_points
    if (feedback.overall_score !== scorecard.earned_points) {
      console.log(
        `Scorecard repair: overall_score ${feedback.overall_score} -> ${scorecard.earned_points} (to match rubric_scorecard)`
      );
      feedback.overall_score = scorecard.earned_points;
      wasRepaired = true;
    }
  }

  if (wasRepaired) {
    console.log(
      "Scorecard validation: Repairs were applied to ensure consistency"
    );
  }

  return feedback;
}

// ── Subagent 2.0 Rubric (v2) Merge + Scoring ───────────────────────────────

type RubricV2Status = "Cumple" | "No cumple" | "No aplica" | "No observable";
type RubricV2ScoreLevel = 0 | 1 | 2 | null;

const RUBRIC_V2_GRADIENT_CRITERIA = redactedPrivatePolicy<Set<string>>();

const CREDIT_CONTRACT_THRESHOLD_BY_CRITERION = redactedPrivatePolicy<Record<string, number>>();

/** Documents the normalizeRubricV2Status behavior. */
function normalizeRubricV2Status(value: any): RubricV2Status {
  const s = typeof value === "string" ? value.trim() : "";
  if (s === "Cumple" || s === "No cumple" || s === "No aplica" || s === "No observable") {
    return s;
  }
  const lower = s.toLowerCase();
  if (lower === "cumple") return "Cumple";
  if (lower === "no cumple") return "No cumple";
  if (lower === "no aplica") return "No aplica";
  if (lower === "no observable") return "No observable";
  return "No observable";
}

/** Returns a rubric state only when the raw value explicitly emits a valid state. */
function parseExplicitRubricV2Status(value: any): RubricV2Status | null {
  const s = typeof value === "string" ? value.trim() : "";
  if (s === "Cumple" || s === "No cumple" || s === "No aplica" || s === "No observable") {
    return s;
  }
  const lower = s.toLowerCase();
  if (lower === "cumple") return "Cumple";
  if (lower === "no cumple") return "No cumple";
  if (lower === "no aplica") return "No aplica";
  if (lower === "no observable") return "No observable";
  return null;
}

/** Documents the normalizeRubricV2ScoreLevel behavior. */
function normalizeRubricV2ScoreLevel(value: any): RubricV2ScoreLevel | undefined {
  if (value === null) return null;
  if (value === 0 || value === 1 || value === 2) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "0" || trimmed === "1" || trimmed === "2") {
      return Number(trimmed) as 0 | 1 | 2;
    }
    if (trimmed.toLowerCase() === "null") return null;
  }
  return undefined;
}

/**
 * Normalizes the credit-contract `state` field from a criterion result,
 * falling back to the v4 `status` field for backward compatibility.
 */
function normalizeCreditContractState(result: any): RubricV2Status {
  // Prefer credit-contract `state`, fall back to legacy `status`
  const raw = result?.state ?? result?.status;
  return normalizeRubricV2Status(raw);
}

/**
 * Returns true when a criterion result is at least attempting the Subagent 2.0 credit contract.
 */
function isCreditContractCriterionResult(result: any): boolean {
  return result != null && ("state" in result || "credit" in result);
}

/** Normalizes a raw credit without considering denominator-excluded states. */
function normalizeRawCredit(value: any): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return null;
}

/** Derives the scorecard state from credit with criterion-specific thresholds. */
function deriveScorecardStateFromCredit(criterionId: string, credit: number): RubricV2Status {
  const threshold = CREDIT_CONTRACT_THRESHOLD_BY_CRITERION[criterionId] ?? 1;
  return credit >= threshold ? "Cumple" : "No cumple";
}

/** Builds a repair audit entry for the scorecard integrity backstop. */
function buildScorecardIntegrityRepairAuditEntry(params: {
  criterionId: string;
  rawResult: any;
  finalState: RubricV2Status;
  finalCredit: number | null;
  reason: string;
}): any {
  return {
    criterion_id: params.criterionId,
    raw_state: normalizeRubricV2Status(params.rawResult?.state ?? params.rawResult?.status),
    raw_credit: normalizeRawCredit(params.rawResult?.credit),
    final_state: params.finalState,
    final_credit: params.finalCredit,
    rule_name: "scorecard_criterion_integrity_gate",
    deterministic_reason: params.reason,
    evidence: [],
  };
}

/** Appends scorecard integrity audit metadata while preserving existing repair audit entries. */
function appendScorecardIntegrityRepairAudit(params: {
  result: any;
  criterionId: string;
  finalState: RubricV2Status;
  finalCredit: number | null;
  reason: string;
}): any {
  return {
    ...(params.result && typeof params.result === "object" && !Array.isArray(params.result) ? params.result : {}),
    repair_audit: [
      ...normalizeRubricRepairAuditEntries(params.result?.repair_audit),
      buildScorecardIntegrityRepairAuditEntry({
        criterionId: params.criterionId,
        rawResult: params.result,
        finalState: params.finalState,
        finalCredit: params.finalCredit,
        reason: params.reason,
      }),
    ],
  };
}

/** Repairs a missing or partial credit-contract criterion before scorecard assembly. */
function normalizeScorecardCreditContractResult(criterionId: string, rawResult: any): any {
  const result = rawResult && typeof rawResult === "object" && !Array.isArray(rawResult) ? rawResult : {};
  const explicitState = parseExplicitRubricV2Status(result.state ?? result.status);
  const rawCredit = normalizeRawCredit(result.credit);

  if (explicitState === "No aplica" || explicitState === "No observable") {
    if (result.credit === null && result.state === explicitState) return result;
    return appendScorecardIntegrityRepairAudit({
      result: {
        ...result,
        state: explicitState,
        credit: null,
      },
      criterionId,
      finalState: explicitState,
      finalCredit: null,
      reason: "Scorecard integrity gate normalized an excluded criterion to null credit.",
    });
  }

  if (rawCredit !== null) {
    const finalState = deriveScorecardStateFromCredit(criterionId, rawCredit);
    if (explicitState === finalState && result.credit === rawCredit) return result;
    return appendScorecardIntegrityRepairAudit({
      result: {
        ...result,
        state: finalState,
        credit: rawCredit,
      },
      criterionId,
      finalState,
      finalCredit: rawCredit,
      reason: "Scorecard integrity gate derived a valid state from the emitted credit.",
    });
  }

  return appendScorecardIntegrityRepairAudit({
    result: {
      ...result,
      state: "No cumple",
      credit: 0,
    },
    criterionId,
    finalState: "No cumple",
    finalCredit: 0,
    reason: "Scorecard integrity gate safely marked a missing or undefined credit-contract criterion as low-confidence No cumple.",
  });
}

/** Recursively removes undefined values before returning storage-facing feedback objects. */
function stripUndefinedValues(value: any): any {
  if (Array.isArray(value)) {
    return value
      .map(
        /** Recursively strips undefined values from array entries. */
        (entry) => stripUndefinedValues(entry)
      )
      .filter(
        /** Removes array entries that normalize to undefined. */
        (entry) => entry !== undefined
      );
  }
  if (value && typeof value === "object") {
    const cleaned: any = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      const cleanedEntry = stripUndefinedValues(entry);
      if (cleanedEntry !== undefined) {
        cleaned[key] = cleanedEntry;
      }
    }
    return cleaned;
  }
  return value;
}

/**
 * Normalizes a credit value. Returns a number in [0,1] or null.
 * Enforces null for excluded states (No aplica, No observable).
 */
function normalizeCredit(value: any, state: RubricV2Status): number | null {
  if (state === "No aplica" || state === "No observable") return null;
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return null;
}

type NoAplicaScorePolicy = "full_credit" | "exclude_denominator";

const PRIVATE_CREDIT_CONTRACT_SCORE_POLICY = redactedPrivatePolicy<{ noAplica: NoAplicaScorePolicy }>();

function isRubricV2DenominatorExcludedState(_state: RubricV2Status): boolean {
  void _state;
  return privatePolicyUnavailable();
}

/** Documents the normalizeRubricRepairAuditEntries behavior. */
function normalizeRubricRepairAuditEntries(value: any): any[] {
  if (Array.isArray(value)) {
    return value.filter(
      /** Handles the callback for this operation. */
      (entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    );
  }
  return value && typeof value === "object" && !Array.isArray(value) ? [value] : [];
}

/** Documents the enrichCriterionDenominatorImpact behavior. */
function enrichCriterionDenominatorImpact(params: {
  denominatorImpact: any;
  criterionMaxPoints: number;
  rawState: RubricV2Status;
  finalState: RubricV2Status;
}): any {
  const { denominatorImpact, criterionMaxPoints, rawState, finalState } = params;
  const rawExcluded = isRubricV2DenominatorExcludedState(rawState);
  const finalExcluded = isRubricV2DenominatorExcludedState(finalState);
  return {
    ...(denominatorImpact && typeof denominatorImpact === "object" && !Array.isArray(denominatorImpact)
      ? denominatorImpact
      : {}),
    raw_excluded: rawExcluded,
    final_excluded: finalExcluded,
    changed: rawExcluded !== finalExcluded,
    raw_denominator: rawExcluded ? "excluded" : "included",
    final_denominator: finalExcluded ? "excluded" : "included",
    criterion_max_points: criterionMaxPoints,
    excluded_points_delta: (finalExcluded ? criterionMaxPoints : 0) - (rawExcluded ? criterionMaxPoints : 0),
  };
}

// v4 scoring function (backward compatible, kept as fallback)
function computeRubricV2EarnedTenths(params: {
  criterionId: string;
  criterionMaxTenths: number;
  status: RubricV2Status;
  rawScoreLevel: RubricV2ScoreLevel | undefined;
}): { earnedTenths: number; normalizedScoreLevel: RubricV2ScoreLevel | undefined } {
  const { criterionId, criterionMaxTenths, status, rawScoreLevel } = params;
  const isGradient = RUBRIC_V2_GRADIENT_CRITERIA.has(criterionId);

  // Status-first rules (backward compatible).
  if (status === "No aplica") {
    return { earnedTenths: criterionMaxTenths, normalizedScoreLevel: rawScoreLevel === undefined ? undefined : null };
  }
  if (status === "No observable") {
    return { earnedTenths: 0, normalizedScoreLevel: rawScoreLevel === undefined ? undefined : null };
  }
  if (status === "No cumple") {
    // Enforce consistency even if the model emitted an inconsistent score_level.
    return { earnedTenths: 0, normalizedScoreLevel: rawScoreLevel === undefined ? undefined : 0 };
  }

  // status === "Cumple"
  if (rawScoreLevel === undefined) {
    // Legacy prompts (v1–v3) do not emit score_level. Fall back to full credit.
    return { earnedTenths: criterionMaxTenths, normalizedScoreLevel: undefined };
  }

  // Normalize/guard against invalid combinations.
  if (rawScoreLevel === null) {
    console.warn(`Invalid score_level=null for status "Cumple" on ${criterionId}; falling back to full credit.`);
    return { earnedTenths: criterionMaxTenths, normalizedScoreLevel: isGradient ? 2 : 2 };
  }

  // Enforce scoring-mode rules:
  // - Gradient criteria allow 1/2
  // - Binary/threshold criteria must be 0/2 only (so treat 1 as invalid and fall back to full credit for Cumple)
  if (rawScoreLevel === 1 && !isGradient) {
    console.warn(
      `Invalid score_level=1 for binary/threshold criterion ${criterionId}; treating as full credit for status "Cumple".`
    );
    return { earnedTenths: criterionMaxTenths, normalizedScoreLevel: 2 };
  }

  if (rawScoreLevel === 0) {
    console.warn(`Invalid score_level=0 for status "Cumple" on ${criterionId}; falling back to full credit.`);
    return { earnedTenths: criterionMaxTenths, normalizedScoreLevel: 2 };
  }

  // rawScoreLevel is 1 or 2 and allowed for this criterion.
  const earnedTenths = Math.round((rawScoreLevel / 2) * criterionMaxTenths);
  return { earnedTenths, normalizedScoreLevel: rawScoreLevel };
}

/**
 * Credit-based scoring requires the separately supplied private applicability policy.
 */
function computeCreditContractEarnedTenths(params: {
  criterionId: string;
  criterionMaxTenths: number;
  state: RubricV2Status;
  credit: number | null;
  noAplicaScorePolicy?: NoAplicaScorePolicy;
}): { earnedTenths: number; excluded: boolean } {
  const {
    criterionMaxTenths,
    state,
    credit,
    noAplicaScorePolicy = PRIVATE_CREDIT_CONTRACT_SCORE_POLICY.noAplica,
  } = params;

  if (state === "No aplica") {
    return noAplicaScorePolicy === "full_credit"
      ? { earnedTenths: criterionMaxTenths, excluded: false }
      : { earnedTenths: 0, excluded: true };
  }

  if (state === "No observable") {
    return { earnedTenths: 0, excluded: true };
  }

  if (credit !== null && Number.isFinite(credit)) {
    const clamped = Math.max(0, Math.min(1, credit));
    return { earnedTenths: Math.round(clamped * criterionMaxTenths), excluded: false };
  }

  // credit is null but state is Cumple or No cumple — shouldn't happen in the credit contract but handle gracefully
  if (state === "Cumple") {
    return { earnedTenths: criterionMaxTenths, excluded: false };
  }
  // No cumple with null credit
  return { earnedTenths: 0, excluded: false };
}

/**
 * Allocates integer tenths (0.1 point units) across a list of weights.
 * Ensures the returned array sums exactly to totalTenths.
 */
export function allocateTenthsByWeights(
  totalTenths: number,
  weights: number[]
): number[] {
  if (!Number.isFinite(totalTenths) || totalTenths <= 0 || weights.length === 0) {
    return weights.map(/** Handles the callback for this operation. */() => 0);
  }
  const totalWeight = weights.reduce(/** Handles the callback for this operation. */(sum, w) => sum + (Number.isFinite(w) ? w : 0), 0);
  if (totalWeight <= 0) return weights.map(/** Handles the callback for this operation. */() => 0);

  const raw = weights.map(/** Handles the callback for this operation. */(w) => (totalTenths * (Number.isFinite(w) ? w : 0)) / totalWeight);
  const base = raw.map(/** Handles the callback for this operation. */(r) => Math.floor(r));
  let remaining = totalTenths - base.reduce(/** Handles the callback for this operation. */(sum, v) => sum + v, 0);

  const order = raw
    .map(/** Handles the callback for this operation. */(r, idx) => ({ idx, frac: r - base[idx] }))
    .sort(/** Handles the callback for this operation. */(a, b) => b.frac - a.frac || a.idx - b.idx);

  for (let i = 0; i < order.length && remaining > 0; i += 1) {
    base[order[i].idx] += 1;
    remaining -= 1;
  }

  return base;
}

/** Documents the buildRubricScorecardV2 behavior. */
export function buildRubricScorecardV2(
  criteriaById: Map<string, any>,
  options: { noAplicaScorePolicy?: NoAplicaScorePolicy } = {}
): any {
  const totalPoints = RUBRIC_V2_MODEL.total_points;
  const noAplicaScorePolicy =
    options.noAplicaScorePolicy ?? PRIVATE_CREDIT_CONTRACT_SCORE_POLICY.noAplica;
  let totalEarnedTenths = 0;
  let totalExcludedTenths = 0;
  let totalNoObservableTenths = 0;
  const scorecardRepairAudit: any[] = [];

  // Detect the credit-based contract: if any criterion result uses `state` + `credit`
  let hasCreditContractCriteria = false;
  for (const result of criteriaById.values()) {
    if (isCreditContractCriterionResult(result)) {
      hasCreditContractCriteria = true;
      break;
    }
  }

  const sections = RUBRIC_V2_MODEL.sections.map(/** Handles the callback for this operation. */(sectionModel) => {
    const sectionMaxTenths = Math.round(sectionModel.weight_percent * 10);
    const groupMaxTenthsList = allocateTenthsByWeights(
      sectionMaxTenths,
      sectionModel.groups.map(/** Handles the callback for this operation. */(g) => g.weight_percent)
    );

    let sectionEarnedTenths = 0;
    let sectionExcludedTenths = 0;
    const groups = sectionModel.groups.map(/** Handles the callback for this operation. */(groupModel, groupIdx) => {
      const groupMaxTenths = groupMaxTenthsList[groupIdx] ?? 0;
      const criteriaMaxTenthsList = allocateTenthsByWeights(
        groupMaxTenths,
        groupModel.criteria.map(/** Handles the callback for this operation. */(c) => c.weight_percent)
      );

      let groupEarnedTenths = 0;
      let groupExcludedTenths = 0;
      const criteria = groupModel.criteria.map(/** Handles the callback for this operation. */(criterionModel, criterionIdx) => {
        const criterionMaxTenths = criteriaMaxTenthsList[criterionIdx] ?? 0;
        const rawResult = criteriaById.get(criterionModel.id) ?? {};
        const result = hasCreditContractCriteria
          ? normalizeScorecardCreditContractResult(criterionModel.id, rawResult)
          : rawResult;
        const usesCreditContract = hasCreditContractCriteria && isCreditContractCriterionResult(result);

        const goodCritiques = Array.isArray(result.good_critiques) ? result.good_critiques : [];
        const badCritiques = Array.isArray(result.bad_critiques) ? result.bad_critiques : [];
        const tip =
          result.criterion_improvement_tip === undefined ? null : result.criterion_improvement_tip;

        let earnedTenths: number;
        let excluded = false;
        const criterion: any = {
          id: criterionModel.id,
          title: criterionModel.title,
          weight_percent: criterionModel.weight_percent,
          max_points: criterionMaxTenths / 10,
          justification: typeof result.justification === "string" ? result.justification : "",
          good_critiques: goodCritiques,
          bad_critiques: badCritiques,
          criterion_improvement_tip: tip,
        };

        if (usesCreditContract) {
          // ── active Subagent 2.0 credit-based scoring path ──
          const state = normalizeCreditContractState(result);
          const credit = normalizeCredit(result.credit, state);
          const creditResult = computeCreditContractEarnedTenths({
            criterionId: criterionModel.id,
            criterionMaxTenths,
            state,
            credit,
            noAplicaScorePolicy,
          });
          earnedTenths = creditResult.earnedTenths;
          excluded = creditResult.excluded;

          criterion.state = state;
          criterion.status = state; // backward-compat alias
          criterion.credit = credit;
          criterion.earned_points = excluded ? 0 : earnedTenths / 10;
          criterion.scoring_mode = result.scoring_mode ?? "binary";
          if (result.breakdown != null) criterion.breakdown = result.breakdown;
          if (Array.isArray(result.evidence)) criterion.evidence = result.evidence;
        } else {
          // ── v4 status+score_level scoring path (backward compat) ──
          const status = normalizeRubricV2Status(result.status);
          const rawScoreLevel = normalizeRubricV2ScoreLevel(result.score_level);
          const v4Result = computeRubricV2EarnedTenths({
            criterionId: criterionModel.id,
            criterionMaxTenths,
            status,
            rawScoreLevel,
          });
          earnedTenths = v4Result.earnedTenths;
          criterion.status = status;
          criterion.earned_points = earnedTenths / 10;
          if (v4Result.normalizedScoreLevel !== undefined) {
            criterion.score_level = v4Result.normalizedScoreLevel;
          }
        }

        const finalState = normalizeRubricV2Status(criterion.state ?? criterion.status);
        const criterionMaxPoints = criterionMaxTenths / 10;
        const repairAuditEntries = normalizeRubricRepairAuditEntries(result.repair_audit).map(
          /** Handles the callback for this operation. */
          (entry) => {
            const rawState = normalizeRubricV2Status(entry.raw_state);
            const entryFinalState = normalizeRubricV2Status(entry.final_state ?? finalState);
            return {
              ...entry,
              criterion_id: criterionModel.id,
              final_state: entryFinalState,
              denominator_impact: enrichCriterionDenominatorImpact({
                denominatorImpact: entry.denominator_impact,
                criterionMaxPoints,
                rawState,
                finalState: entryFinalState,
              }),
            };
          }
        );
        if (repairAuditEntries.length > 0) {
          criterion.repair_audit = repairAuditEntries;
          scorecardRepairAudit.push(...repairAuditEntries);
        }

        if (result.applicability_audit && typeof result.applicability_audit === "object") {
          criterion.applicability_audit = {
            ...result.applicability_audit,
            criterion_id: criterionModel.id,
            denominator_impact: enrichCriterionDenominatorImpact({
              denominatorImpact: result.applicability_audit.denominator_impact,
              criterionMaxPoints,
              rawState: normalizeRubricV2Status(result.applicability_audit.raw_state),
              finalState,
            }),
          };
        }

        if (excluded) {
          groupExcludedTenths += criterionMaxTenths;
          const state = criterion.state ?? criterion.status;
          if (state === "No observable") {
            totalNoObservableTenths += criterionMaxTenths;
          }
        } else {
          groupEarnedTenths += earnedTenths;
        }

        return criterion;
      });

      sectionEarnedTenths += groupEarnedTenths;
      sectionExcludedTenths += groupExcludedTenths;
      return {
        id: groupModel.id,
        title: groupModel.title,
        weight_percent: groupModel.weight_percent,
        max_points: groupMaxTenths / 10,
        earned_points: groupEarnedTenths / 10,
        criteria,
      };
    });

    totalEarnedTenths += sectionEarnedTenths;
    totalExcludedTenths += sectionExcludedTenths;
    return {
      id: sectionModel.id,
      title: sectionModel.title,
      weight_percent: sectionModel.weight_percent,
      max_points: sectionMaxTenths / 10,
      earned_points: sectionEarnedTenths / 10,
      groups,
    };
  });

  // Denominator exclusion: rescale earned points to 100-point scale
  const totalMaxTenths = totalPoints * 10; // 1000
  const scorableMaxTenths = totalMaxTenths - totalExcludedTenths;
  let earnedPointsFinal: number;
  if (hasCreditContractCriteria && scorableMaxTenths > 0 && totalExcludedTenths > 0) {
    // Rescale: earned/scorable * 100
    earnedPointsFinal = Math.round((totalEarnedTenths / scorableMaxTenths) * 1000) / 10;
  } else {
    earnedPointsFinal = totalEarnedTenths / 10;
  }

  const scorableWeightPercent = hasCreditContractCriteria
    ? Math.round((scorableMaxTenths / totalMaxTenths) * 100)
    : 100;

  // Low confidence: >25% of total rubric weight is No observable
  const noObservablePercent = (totalNoObservableTenths / totalMaxTenths) * 100;
  const lowConfidence = hasCreditContractCriteria && noObservablePercent > 25;

  const scorecard: any = {
    rubric_version: hasCreditContractCriteria ? "subagent_2.0_v6_3" : RUBRIC_V2_MODEL.rubric_version,
    total_points: totalPoints,
    earned_points: earnedPointsFinal,
    sections,
  };

  if (hasCreditContractCriteria) {
    scorecard.scorable_weight_percent = scorableWeightPercent;
    scorecard.low_confidence = lowConfidence;
  }

  if (scorecardRepairAudit.length > 0) {
    scorecard.repair_audit = scorecardRepairAudit;
  }

  applyCoreSalesScoreBandCalibration(scorecard);

  return stripUndefinedValues(scorecard);
}

function applyCoreSalesScoreBandCalibration(_scorecard: any): any {
  void _scorecard;
  return privatePolicyUnavailable();
}

/** Documents the flattenRubricV2GoodCritiques behavior. */
function flattenRubricV2GoodCritiques(rubricScorecardV2: any): any[] {
  const flat: any[] = [];
  for (const section of rubricScorecardV2?.sections ?? []) {
    for (const group of section?.groups ?? []) {
      for (const criterion of group?.criteria ?? []) {
        for (const critique of criterion?.good_critiques ?? []) {
          const item: any = {
            title: critique.title ?? "",
            detail: critique.detail ?? "",
            category: critique.category ?? "rubric",
          };
          if (Array.isArray(critique.evidence) && critique.evidence.length > 0) {
            item.evidence = critique.evidence;
          }
          flat.push(item);
        }
      }
    }
  }
  return flat;
}

/** Documents the flattenRubricV2BadCritiques behavior. */
function flattenRubricV2BadCritiques(rubricScorecardV2: any): any[] {
  const flat: any[] = [];
  for (const section of rubricScorecardV2?.sections ?? []) {
    for (const group of section?.groups ?? []) {
      for (const criterion of group?.criteria ?? []) {
        for (const critique of criterion?.bad_critiques ?? []) {
          const item: any = {
            title: critique.title ?? "",
            detail: critique.detail ?? "",
            severity: critique.severity ?? "minor",
            category: critique.category ?? "rubric",
            weakness_improvement_tip: critique.weakness_improvement_tip ?? "",
          };
          if (Array.isArray(critique.evidence) && critique.evidence.length > 0) {
            item.evidence = critique.evidence;
          }
          flat.push(item);
        }
      }
    }
  }
  return flat;
}

/** Documents the mergeSubagent2Outputs behavior. */
export function mergeSubagent2Outputs(
  callId: string,
  outputs: {
    core_fields: any;
    coaching: any;
    rubric_analysis_A: any;
    rubric_analysis_B: any;
    rubric_analysis_C: any;
    rubric_analysis_D: any;
    severity_analysis_A?: any;
    severity_analysis_B?: any;
    severity_analysis_C?: any;
    severity_analysis_D?: any;
  },
  transcript?: any,
  conversationMetrics?: ConversationMetricsReport | null,
  onSpeedAdjustment?: (adjustment: ConversationSpeedAdjustment | null) => void
): any {
  const { core_fields, coaching } = outputs;
  const agentSpeaker =
    typeof core_fields?.agent_speaker === "string" ? core_fields.agent_speaker : "A";
  const customerSpeaker =
    typeof core_fields?.customer_speaker === "string" ? core_fields.customer_speaker : "B";

  for (const [taskId, output] of [
    ["rubric_analysis_A", outputs.rubric_analysis_A],
    ["rubric_analysis_B", outputs.rubric_analysis_B],
    ["rubric_analysis_C", outputs.rubric_analysis_C],
    ["rubric_analysis_D", outputs.rubric_analysis_D],
  ] as const) {
    const validation = validateSubagent2RubricOutput(taskId, output);
    if (validation && !validation.valid) {
      throw buildInvalidRubricOutputError(validation);
    }
  }

  const criteriaA = applySeverityResultsToCriteriaResults(
    outputs.rubric_analysis_A?.rubric_criteria_results ?? [],
    outputs.severity_analysis_A
  );
  const criteriaB = applySeverityResultsToCriteriaResults(
    outputs.rubric_analysis_B?.rubric_criteria_results ?? [],
    outputs.severity_analysis_B
  );
  const criteriaC = applySeverityResultsToCriteriaResults(
    outputs.rubric_analysis_C?.rubric_criteria_results ?? [],
    outputs.severity_analysis_C
  );
  const criteriaD = applySeverityResultsToCriteriaResults(
    outputs.rubric_analysis_D?.rubric_criteria_results ?? [],
    outputs.severity_analysis_D
  );

  const validatedA = validateAndRepairRubricCriteriaResults({
    callId,
    transcript,
    criteriaResults: criteriaA,
    agentSpeaker,
    customerSpeaker,
  });
  const validatedB = validateAndRepairRubricCriteriaResults({
    callId,
    transcript,
    criteriaResults: criteriaB,
    agentSpeaker,
    customerSpeaker,
  });
  const validatedC = validateAndRepairRubricCriteriaResults({
    callId,
    transcript,
    criteriaResults: criteriaC,
    agentSpeaker,
    customerSpeaker,
  });
  const validatedD = validateAndRepairRubricCriteriaResults({
    callId,
    transcript,
    criteriaResults: criteriaD,
    agentSpeaker,
    customerSpeaker,
  });

  for (const issue of [
    ...validatedA.issues,
    ...validatedB.issues,
    ...validatedC.issues,
    ...validatedD.issues,
  ]) {
    console.warn(
      `Rubric validation issue for ${callId}/${issue.criterionId}: ${issue.code} — ${issue.message}`
    );
  }

  const combinedCriteria: any[] = [
    ...validatedA.criteriaResults,
    ...validatedB.criteriaResults,
    ...validatedC.criteriaResults,
    ...validatedD.criteriaResults,
  ];

  const speedResult = applyConversationSpeedScoring(combinedCriteria, conversationMetrics);
  onSpeedAdjustment?.(speedResult.adjustment);
  const criteriaById = new Map<string, any>();
  for (const entry of speedResult.criteria) {
    const id = entry?.criterion_id;
    if (typeof id !== "string") continue;
    criteriaById.set(id, entry);
  }

  const rubricScorecardV2 = buildRubricScorecardV2(criteriaById);
  const earnedPoints = rubricScorecardV2?.earned_points ?? 0;
  const { tier, category } = computeTierAndCategory(earnedPoints);

  const loanCompleted = core_fields?.loan_completed;
  let followupMessage = coaching?.suggested_followup_message ?? null;
  if (loanCompleted === "yes" || loanCompleted === "no") {
    followupMessage = null;
  }

  const flatStrengths = flattenRubricV2GoodCritiques(rubricScorecardV2);
  const flatWeaknesses = flattenRubricV2BadCritiques(rubricScorecardV2);
  const managementAction = buildManagementActionPlanV1({
    weaknesses: flatWeaknesses,
    suggestedFollowupMessage: followupMessage,
  });

  const merged: any = {
    call_id: callId,
    agent_speaker: core_fields?.agent_speaker ?? "unknown",
    customer_speaker: core_fields?.customer_speaker ?? "unknown",
    agent_name: core_fields?.agent_name ?? null,
    customer_name: core_fields?.customer_name ?? null,
    loan_completed: loanCompleted ?? "unclear",
    overall_score: earnedPoints,
    performance_tier: tier,
    call_category: category,
    rubric_scorecard: null,
    rubric_scorecard_v2: rubricScorecardV2,
    agent_strengths: flatStrengths,
    agent_weaknesses: flatWeaknesses,
    management_action_v1: managementAction,
    mentorship_tip: coaching?.mentorship_tip ?? null,
    suggested_followup_message: followupMessage,
  };

  // Propagate Subagent 2.0 credit-contract low_confidence flag to top-level feedback
  if (rubricScorecardV2?.low_confidence != null) {
    merged.low_confidence = rubricScorecardV2.low_confidence;
  }
  if (Array.isArray(rubricScorecardV2?.repair_audit) && rubricScorecardV2.repair_audit.length > 0) {
    merged.repair_audit = rubricScorecardV2.repair_audit;
  }
  if (rubricScorecardV2?.score_calibration_audit != null) {
    merged.score_calibration_audit = rubricScorecardV2.score_calibration_audit;
  }

  return stripUndefinedValues(merged);
}
