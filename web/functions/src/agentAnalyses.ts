import { createDemoOpenAI } from './demoPaidProviders';
import { isDemoReportCall } from './demoConfig';
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import * as admin from "firebase-admin";
import { isAgentProfileCallExcluded } from "./callExclusions";
import { FieldValue } from "firebase-admin/firestore";
import { analyzerRequestOptions } from "./analyzerRequestOptions";
import {
  AGENT_ANALYSIS_PATTERN_PROMPTS,
  AGENT_ANALYSIS_PATTERN_PROMPT_TASK_IDS,
  DEFAULT_ANALYZER_MODEL,
  isAgentAnalysisPatternPromptTaskId,
  isSupportedAnalyzerModel,
  resolveAgentAnalysisPatternPromptPath,
  resolveAnalyzerModel,
  type AgentAnalysisPatternPromptTaskId,
  type WeaknessSeverityBin,
} from "./promptConfig";
import { CONSUBANCO_ORGANIZATION_ID } from "./callIdentity";
import { createKespInboxMessageWithId } from "./kespInbox";
import { sanitizeSubagentOutputForFirestore } from "./firestoreOutputSanitizer";
import { enqueueAgentAnalysisTask } from "./processingTaskQueue";

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

const AGENT_ANALYSES_COLLECTION = "agent_analyses";
const AGENT_ANALYSIS_PROMPT_FAMILY = "behavior_pattern_v3";
const BEHAVIOR_PATTERN_REPORT_SCHEMA_VERSION = "2";
const MAX_SIGNALS_PER_DETECTOR_TASK = 60;
const CCC_AGENT_ANALYSIS_TEST_PROJECT_IDS = new Set(["sales-feedback-agent", "test", "demo-sales-feedback-agent"]);

export type AgentAnalysisEnvironmentTarget = "test" | "prod";

const SEVERITY_WEIGHT: Record<WeaknessSeverityBin, number> = {
  minor: 1,
  "moderate-minor": 2,
  moderate: 3,
  "moderate-severe": 4,
  severe: 5,
};

/** Documents the maybeCreateAgentReportTerminalInboxMessage behavior. */
async function maybeCreateAgentReportTerminalInboxMessage(params: {
  agentAnalysisId: string;
  runId: string;
  uploadedBy: string;
  salesAgentId: string | null;
  salesAgentName: string | null;
  status: "complete" | "error";
  errorCode?: string | null;
}): Promise<void> {
  try {
    if (!params.uploadedBy) {
      console.warn(
        `Skipping agent report inbox message for ownerless agent analysis ${params.agentAnalysisId}/${params.runId}`
      );
      return;
    }

    if (params.status === "complete") {
      /** Calls Firebase Firestore to create a deterministic inbox message for completed agent reports. */
      await createKespInboxMessageWithId({
        messageId: `agent_report_completed:${params.agentAnalysisId}:${params.runId}`,
        userId: params.uploadedBy,
        type: "agent_report_completed",
        agentAnalysisId: params.agentAnalysisId,
        runId: params.runId,
        salesAgentId: params.salesAgentId ?? undefined,
        salesAgentName: params.salesAgentName ?? undefined,
        source: "agentAnalyses:finalizeAgentAnalysisRun",
      });
      return;
    }

    /** Calls Firebase Firestore to create a deterministic inbox message for terminal agent report errors. */
    await createKespInboxMessageWithId({
      messageId: `agent_report_error:${params.agentAnalysisId}:${params.runId}`,
      userId: params.uploadedBy,
      type: "agent_report_error",
      agentAnalysisId: params.agentAnalysisId,
      runId: params.runId,
      salesAgentId: params.salesAgentId ?? undefined,
      salesAgentName: params.salesAgentName ?? undefined,
      errorCode: params.errorCode ?? null,
      source: "agentAnalyses:finalizeAgentAnalysisRun",
    });
  } catch (error) {
    console.error(
      `Failed to create agent report inbox message for ${params.agentAnalysisId}/${params.runId}:`,
      error
    );
  }
}

type RubricDomain = "A" | "B" | "C" | "D";
type PerformanceTier = "excellent" | "good" | "needs_improvement" | "poor";
type AgentAnalysisTaskType = "behavior_pattern_detector" | "behavior_pattern_consolidator";

export interface BehaviorSignalEvidenceItem {
  quote: string;
  speakerLabel?: string | null;
  speakerDisplay?: string | null;
}

export interface BehaviorSignal {
  signalId: string;
  callId: string;
  feedbackId: string;
  criterionId: string;
  criterionTitle: string;
  rubricDomain: RubricDomain;
  critiqueTitle: string;
  critiqueDetail: string;
  severity: WeaknessSeverityBin;
  criterionCredit: number | null;
  evidence: BehaviorSignalEvidenceItem[];
  criterionImprovementTip: string | null;
  weaknessImprovementTip: string | null;
  overallScore: number | null;
  performanceTier: PerformanceTier | null;
}

interface BehaviorPattern {
  patternId: string;
  patternName: string;
  seenInCallCount: number;
  totalCallCount: number;
  priorityScore: number;
  behaviorSummary: string;
  whenItHappens: string;
  businessImpact: string;
  rootCause: string;
  coachingFocus: string;
  mentorshipTips: Array<{
    tip: string;
    priority: "primary" | "secondary";
  }>;
  executionGuide?: {
    whenToUse?: string;
    sayThis?: string;
    whyItWorks?: string;
    avoidThis?: string;
    nextStep?: string;
  };
  supportingEvidence: Array<{
    callId: string;
    quote: string;
    speakerLabel: string | null;
    speakerDisplay: string | null;
  }>;
  examples: Array<{
    exampleId: string;
    callId: string;
    observedFragment: string;
    context: string;
    whyItIsWrong: string;
    whatShouldHaveDone: string;
    whyItHelps: string;
    avoid: string;
    nextStep: string;
  }>;
  relatedSignalIds: string[];
  relatedCriterionIds: string[];
  severityDistribution: Partial<Record<WeaknessSeverityBin, number>>;
  sourceCallIds?: string[];
}

interface PatternDetectorOutput {
  candidatePatterns: BehaviorPattern[];
}

interface PatternConsolidatorOutput {
  patterns: BehaviorPattern[];
  patternOrder: string[];
}

interface AgentAnalysisFingerprintCallState {
  callId: string;
  callUpdatedAt: string | null;
  latestFeedbackId: string | null;
  feedbackVersion: string | null;
  feedbackUpdatedAt: string | null;
  skipReason: string | null;
}

export interface AgentAnalysisProcessingConfig {
  analyzerModel?: string;
  promptVersions?: Record<string, string>;
}

interface PatternTaskPlanItem {
  taskId: string;
  taskType: AgentAnalysisTaskType;
  promptTaskId: AgentAnalysisPatternPromptTaskId;
  promptPath: string;
  inputPayload: Record<string, unknown>;
}

export interface AgentAnalysisInputState {
  sourceCallIds: string[];
  eligibleCallIds: string[];
  skipReasons: Record<string, number>;
  behaviorSignals: BehaviorSignal[];
  inputFingerprint: string;
  environmentTarget?: AgentAnalysisEnvironmentTarget;
}

export interface AgentAnalysisInputQueryOptions {
  agentAnalysisId?: string;
  environmentTarget?: AgentAnalysisEnvironmentTarget;
}

/** Documents the normalizeString behavior. */
function normalizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Documents the currentAgentAnalysisProjectId behavior. */
function currentAgentAnalysisProjectId(env: NodeJS.ProcessEnv = process.env): string {
  return env.GCLOUD_PROJECT || env.GCP_PROJECT || env.GOOGLE_CLOUD_PROJECT || "";
}

/** Documents the isCccAgentAnalysisTestingProject behavior. */
function isCccAgentAnalysisTestingProject(projectId: string): boolean {
  return CCC_AGENT_ANALYSIS_TEST_PROJECT_IDS.has(projectId) || projectId.endsWith("-test");
}

/** Documents the resolveAgentAnalysisEnvironmentTarget behavior. */
export function resolveAgentAnalysisEnvironmentTarget(
  agentAnalysisData: FirebaseFirestore.DocumentData | undefined,
  env: NodeJS.ProcessEnv = process.env
): AgentAnalysisEnvironmentTarget | undefined {
  if (agentAnalysisData?.isCccCanonicalProfile !== true) {
    return undefined;
  }

  const projectId = currentAgentAnalysisProjectId(env).trim();
  if (!projectId) {
    return undefined;
  }

  return isCccAgentAnalysisTestingProject(projectId) ? "test" : "prod";
}


/** Documents the normalizeStringArray behavior. */
function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(value.filter(/** Handles the callback for this operation. */(item): item is string => typeof item === "string" && item.length > 0))
  );
}

/** Documents the timestampToIsoString behavior. */
function timestampToIsoString(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

/** Documents the incrementSkipReason behavior. */
function incrementSkipReason(skipReasons: Record<string, number>, reason: string): void {
  skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
}

/** Documents the normalizeEvidence behavior. */
function normalizeEvidence(value: unknown): BehaviorSignalEvidenceItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(/** Handles the callback for this operation. */(item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map(/** Handles the callback for this operation. */(item) => ({
      quote: normalizeString(item.quote),
      speakerLabel:
        typeof item.speakerLabel === "string"
          ? item.speakerLabel
          : typeof item.speaker_label === "string"
            ? item.speaker_label
            : null,
      speakerDisplay:
        typeof item.speakerDisplay === "string"
          ? item.speakerDisplay
          : typeof item.speaker_display === "string"
            ? item.speaker_display
            : null,
    }))
    .filter(/** Handles the callback for this operation. */(item) => item.quote.length > 0);
}

/** Documents the normalizePatternEvidence behavior. */
function normalizePatternEvidence(
  value: unknown
): Array<{
  callId: string;
  quote: string;
  speakerLabel: string | null;
  speakerDisplay: string | null;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(/** Handles the callback for this operation. */(item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map(/** Handles the callback for this operation. */(item) => ({
      callId: normalizeString(item.callId),
      quote: normalizeString(item.quote),
      speakerLabel:
        typeof item.speakerLabel === "string"
          ? item.speakerLabel
          : typeof item.speaker_label === "string"
            ? item.speaker_label
            : null,
      speakerDisplay:
        typeof item.speakerDisplay === "string"
          ? item.speakerDisplay
          : typeof item.speaker_display === "string"
            ? item.speaker_display
            : null,
    }))
    .filter(/** Handles the callback for this operation. */(item) => item.quote.length > 0);
}

/** Documents the countWords behavior. */
function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

/** Documents the normalizeExampleTextForHeuristics behavior. */
function normalizeExampleTextForHeuristics(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Documents the looksActionOnlyExampleResponse behavior. */
function looksActionOnlyExampleResponse(value: string): boolean {
  const normalized = normalizeExampleTextForHeuristics(value);
  if (!normalized) {
    return true;
  }

  const actionAdvicePrefixes = [
    "debio ",
    "debiste ",
    "debe ",
    "deberia ",
    "habia que ",
    "hay que ",
    "se debe ",
    "se debio ",
    "tenia que ",
    "tiene que ",
    "validar ",
    "reconocer ",
    "explicar ",
    "explorar ",
    "preguntar ",
    "pedir ",
    "confirmar ",
    "acordar ",
    "proponer ",
    "cerrar ",
    "evitar ",
    "mantener ",
    "dar seguimiento ",
  ];

  if (actionAdvicePrefixes.some(/** Handles the callback for this operation. */(prefix) => normalized.startsWith(prefix))) {
    return true;
  }

  return /\b(el|la) agente (debe|debio|deberia|tenia que|tiene que)\b/.test(normalized);
}

/** Documents the hasEllipsisLikeText behavior. */
function hasEllipsisLikeText(value: string): boolean {
  return /…|\.{2,}/.test(value);
}

/** Documents the looksBrokenExampleText behavior. */
function looksBrokenExampleText(value: string): boolean {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.length < 12 || countWords(trimmed) < 3) {
    return true;
  }
  if (/^(bueno|mande|aj[aá]|mhm|mm|ok|sale|si|sí|no|hola|oiga)[,.;:!?]?$/i.test(trimmed)) {
    return true;
  }
  if (/^[¿¡]?[a-záéíóúñ]+$/i.test(trimmed) && trimmed.length < 10) {
    return true;
  }
  if (/[,;:]$/.test(trimmed) && trimmed.length < 32) {
    return true;
  }
  return false;
}

/** Documents the normalizePatternExamples behavior. */
function normalizePatternExamples(
  value: unknown,
  patternId: string
): BehaviorPattern["examples"] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenExampleKeys = new Set<string>();

  return value
    .filter(/** Handles the callback for this operation. */(item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map(/** Handles the callback for this operation. */(item, index) => ({
      exampleId: normalizeString(item.exampleId, `${patternId}:example:${index + 1}`),
      callId: normalizeString(item.callId),
      observedFragment: normalizeString(item.observedFragment ?? item.observed_fragment),
      context: normalizeString(item.context),
      whyItIsWrong: normalizeString(item.whyItIsWrong ?? item.why_it_is_wrong),
      whatShouldHaveDone: normalizeString(
        item.whatShouldHaveDone ?? item.what_should_have_done
      ),
      whyItHelps: normalizeString(item.whyItHelps ?? item.why_it_helps),
      avoid: normalizeString(item.avoid),
      nextStep: normalizeString(item.nextStep ?? item.next_step),
    }))
    .filter(/** Handles the callback for this operation. */(item) => {
      if (!item.callId) {
        return false;
      }
      if (
        looksBrokenExampleText(item.observedFragment) ||
        looksBrokenExampleText(item.context) ||
        looksBrokenExampleText(item.whyItIsWrong) ||
        looksBrokenExampleText(item.whatShouldHaveDone) ||
        looksBrokenExampleText(item.whyItHelps) ||
        looksBrokenExampleText(item.avoid) ||
        looksBrokenExampleText(item.nextStep)
      ) {
        return false;
      }
      if (looksActionOnlyExampleResponse(item.whatShouldHaveDone)) {
        return false;
      }
      if (
        hasEllipsisLikeText(item.observedFragment) ||
        hasEllipsisLikeText(item.whatShouldHaveDone)
      ) {
        return false;
      }
      const dedupeKey = `${item.callId}::${item.observedFragment
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()}`;
      if (seenExampleKeys.has(dedupeKey)) {
        return false;
      }
      seenExampleKeys.add(dedupeKey);
      return true;
    })
    .slice(0, 3);
}

/** Documents the normalizeSeverityDistribution behavior. */
function normalizeSeverityDistribution(
  value: unknown
): Partial<Record<WeaknessSeverityBin, number>> {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const normalized: Partial<Record<WeaknessSeverityBin, number>> = {};

  for (const severity of Object.keys(SEVERITY_WEIGHT) as WeaknessSeverityBin[]) {
    const count = source[severity];
    if (typeof count === "number" && count > 0) {
      normalized[severity] = count;
    }
  }

  return normalized;
}

/** Documents the buildPatternPriorityScore behavior. */
function buildPatternPriorityScore(
  pattern: Partial<BehaviorPattern>,
  totalCallCount: number
): number {
  if (typeof pattern.priorityScore === "number") {
    return pattern.priorityScore;
  }

  const severityDistribution = normalizeSeverityDistribution(pattern.severityDistribution);
  const severityScore = Object.entries(severityDistribution).reduce(/** Handles the callback for this operation. */(sum, [severity, count]) => {
    return sum + (SEVERITY_WEIGHT[severity as WeaknessSeverityBin] ?? 0) * (count ?? 0);
  }, 0);
  const seenInCallCount =
    typeof pattern.seenInCallCount === "number" ? pattern.seenInCallCount : 0;

  return severityScore + seenInCallCount * 10 + totalCallCount;
}

/** Documents the buildDefaultPatternOrder behavior. */
function buildDefaultPatternOrder(patterns: BehaviorPattern[]): string[] {
  return [...patterns]
    .sort(/** Handles the callback for this operation. */(left, right) => {
      if (right.priorityScore !== left.priorityScore) {
        return right.priorityScore - left.priorityScore;
      }
      if (right.seenInCallCount !== left.seenInCallCount) {
        return right.seenInCallCount - left.seenInCallCount;
      }
      return left.patternId.localeCompare(right.patternId);
    })
    .map(/** Handles the callback for this operation. */(pattern) => pattern.patternId);
}

/** Documents the normalizeMentorshipTips behavior. */
function normalizeMentorshipTips(
  value: unknown
): Array<{ tip: string; priority: "primary" | "secondary" }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce<Array<{ tip: string; priority: "primary" | "secondary" }>>(
    /** Handles the callback for this operation. */
    (tips, item) => {
      if (!item || typeof item !== "object") {
        return tips;
      }
      const tip = normalizeString((item as Record<string, unknown>).tip);
      if (!tip) {
        return tips;
      }
      tips.push({
        tip,
        priority:
          (item as Record<string, unknown>).priority === "secondary" ? "secondary" : "primary",
      });
      return tips;
    },
    []
  );
}

/** Documents the normalizeExecutionGuide behavior. */
function normalizeExecutionGuide(
  value: unknown
): BehaviorPattern["executionGuide"] | undefined {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!raw) {
    return undefined;
  }

  const whenToUse = normalizeNonEmptyString(raw.whenToUse);
  const sayThis = normalizeNonEmptyString(raw.sayThis);
  const whyItWorks = normalizeNonEmptyString(raw.whyItWorks ?? raw.why_it_works);
  const avoidThis = normalizeNonEmptyString(raw.avoidThis);
  const nextStep = normalizeNonEmptyString(raw.nextStep);

  if (!whenToUse && !sayThis && !whyItWorks && !avoidThis && !nextStep) {
    return undefined;
  }

  return {
    ...(whenToUse ? { whenToUse } : {}),
    ...(sayThis ? { sayThis } : {}),
    ...(whyItWorks ? { whyItWorks } : {}),
    ...(avoidThis ? { avoidThis } : {}),
    ...(nextStep ? { nextStep } : {}),
  };
}

/** Documents the normalizeBehaviorPattern behavior. */
function normalizeBehaviorPattern(
  value: unknown,
  index: number,
  totalCallCount: number
): BehaviorPattern {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const supportingEvidence = Array.isArray(raw.supportingEvidence)
    ? raw.supportingEvidence
    : Array.isArray(raw.evidence)
      ? raw.evidence
      : [];

  const relatedSignalIds = Array.isArray(raw.relatedSignalIds)
    ? raw.relatedSignalIds
    : Array.isArray(raw.sourceSignalIds)
      ? raw.sourceSignalIds
      : [];

  const relatedCriterionIds = Array.isArray(raw.relatedCriterionIds)
    ? raw.relatedCriterionIds
    : Array.isArray(raw.sourceCriterionIds)
      ? raw.sourceCriterionIds
      : [];

  const normalized: BehaviorPattern = {
    patternId: normalizeString(raw.patternId, `pattern_${index + 1}`),
    patternName: normalizeString(raw.patternName, `Patrón ${index + 1}`),
    seenInCallCount:
      typeof raw.seenInCallCount === "number" ? raw.seenInCallCount : 0,
    totalCallCount:
      typeof raw.totalCallCount === "number" ? raw.totalCallCount : totalCallCount,
    priorityScore: 0,
    behaviorSummary: normalizeString(raw.behaviorSummary),
    whenItHappens: normalizeString(raw.whenItHappens),
    businessImpact: normalizeString(raw.businessImpact),
    rootCause: normalizeString(raw.rootCause),
    coachingFocus: normalizeString(raw.coachingFocus),
    mentorshipTips: normalizeMentorshipTips(raw.mentorshipTips),
    executionGuide: normalizeExecutionGuide(raw.executionGuide),
    supportingEvidence: normalizePatternEvidence(supportingEvidence),
    examples: [],
    relatedSignalIds: normalizeStringArray(relatedSignalIds),
    relatedCriterionIds: normalizeStringArray(relatedCriterionIds),
    severityDistribution: normalizeSeverityDistribution(raw.severityDistribution),
    sourceCallIds: normalizeStringArray(raw.sourceCallIds),
  };

  normalized.examples = normalizePatternExamples(raw.examples, normalized.patternId);

  normalized.priorityScore = buildPatternPriorityScore(normalized, totalCallCount);
  return normalized;
}

type IndexedBehaviorSignal = {
  signalId: string;
  callId: string;
  hasEvidenceQuote: boolean;
};

/** Documents the normalizeNonEmptyString behavior. */
function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Documents the hasNonEmptyEvidenceQuote behavior. */
function hasNonEmptyEvidenceQuote(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.some(/** Handles the callback for this operation. */(item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const quote = normalizeNonEmptyString((item as Record<string, unknown>).quote);
    return quote !== null;
  });
}

/** Documents the getIndexedBehaviorSignalsFromTaskInput behavior. */
function getIndexedBehaviorSignalsFromTaskInput(inputPayload: unknown): IndexedBehaviorSignal[] {
  const payload =
    inputPayload && typeof inputPayload === "object"
      ? (inputPayload as Record<string, unknown>)
      : undefined;
  const behaviorSignals = payload?.behaviorSignals;
  if (!Array.isArray(behaviorSignals)) {
    return [];
  }

  return behaviorSignals.reduce<IndexedBehaviorSignal[]>(/** Handles the callback for this operation. */(signals, signal) => {
    if (!signal || typeof signal !== "object") {
      return signals;
    }
    const record = signal as Record<string, unknown>;
    const signalId = normalizeNonEmptyString(record.signalId);
    const callId = normalizeNonEmptyString(record.callId);
    if (!signalId || !callId) {
      return signals;
    }
    signals.push({
      signalId,
      callId,
      hasEvidenceQuote: hasNonEmptyEvidenceQuote(record.evidence),
    });
    return signals;
  }, []);
}

/** Documents the buildBehaviorSignalsById behavior. */
function buildBehaviorSignalsById(
  tasks: Array<{ id: string; data: FirebaseFirestore.DocumentData }>
): Map<string, IndexedBehaviorSignal> {
  return tasks
    .filter(/** Handles the callback for this operation. */(task) => isBehaviorPatternDetectorTaskId(task.id))
    .flatMap(/** Handles the callback for this operation. */(task) => getIndexedBehaviorSignalsFromTaskInput(task.data.inputPayload))
    .reduce<Map<string, IndexedBehaviorSignal>>(/** Handles the callback for this operation. */(mapping, signal) => {
      if (!mapping.has(signal.signalId)) {
        mapping.set(signal.signalId, signal);
      }
      return mapping;
    }, new Map<string, IndexedBehaviorSignal>());
}

/** Documents the buildVerifiedPatternCallIds behavior. */
function buildVerifiedPatternCallIds(
  pattern: BehaviorPattern,
  signalsById: Map<string, IndexedBehaviorSignal>,
  runDenominatorCallIds: Set<string>
): string[] {
  const orderedCallIds: string[] = [];
  const seen = new Set<string>();
  const hasDenominator = runDenominatorCallIds.size > 0;

  const maybeAddCallId = /** Documents the maybeAddCallId behavior. */ (callId: unknown, requireDenominatorMembership: boolean) => {
    const normalizedCallId = normalizeNonEmptyString(callId);
    if (!normalizedCallId) {
      return;
    }
    if (requireDenominatorMembership && !runDenominatorCallIds.has(normalizedCallId)) {
      return;
    }
    if (seen.has(normalizedCallId)) {
      return;
    }
    seen.add(normalizedCallId);
    orderedCallIds.push(normalizedCallId);
  };

  for (const example of pattern.examples) {
    maybeAddCallId(example.callId, hasDenominator);
  }

  for (const evidenceItem of pattern.supportingEvidence) {
    maybeAddCallId(evidenceItem.callId, hasDenominator);
  }

  for (const signalId of pattern.relatedSignalIds) {
    const normalizedSignalId = normalizeNonEmptyString(signalId);
    if (!normalizedSignalId) {
      continue;
    }
    const signal = signalsById.get(normalizedSignalId);
    if (!signal) {
      continue;
    }
    if (!signal.hasEvidenceQuote) {
      continue;
    }
    if (!runDenominatorCallIds.has(signal.callId)) {
      continue;
    }
    maybeAddCallId(signal.callId, false);
  }

  return orderedCallIds;
}

/** Documents the sanitizePatternOrder behavior. */
function sanitizePatternOrder(
  patternOrder: string[],
  finalizedPatterns: BehaviorPattern[]
): string[] {
  if (finalizedPatterns.length === 0) {
    return [];
  }

  const finalPatternIds = new Set(finalizedPatterns.map(/** Handles the callback for this operation. */(pattern) => pattern.patternId));
  const sanitizedOrder: string[] = [];
  const seen = new Set<string>();

  for (const patternId of patternOrder) {
    const normalizedId = normalizeNonEmptyString(patternId);
    if (!normalizedId) {
      continue;
    }
    if (!finalPatternIds.has(normalizedId) || seen.has(normalizedId)) {
      continue;
    }
    seen.add(normalizedId);
    sanitizedOrder.push(normalizedId);
  }

  const defaultOrder = buildDefaultPatternOrder(finalizedPatterns);
  for (const patternId of defaultOrder) {
    if (!seen.has(patternId)) {
      seen.add(patternId);
      sanitizedOrder.push(patternId);
    }
  }

  return sanitizedOrder;
}

/** Documents the normalizePatternDetectorOutput behavior. */
function normalizePatternDetectorOutput(
  value: unknown,
  totalCallCount: number
): PatternDetectorOutput {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const candidates = Array.isArray(raw.candidatePatterns)
    ? raw.candidatePatterns
    : Array.isArray(raw.patterns)
      ? raw.patterns
      : [];

  return {
    candidatePatterns: candidates.map(/** Handles the callback for this operation. */(pattern, index) =>
      normalizeBehaviorPattern(pattern, index, totalCallCount)
    ),
  };
}

/** Documents the normalizePatternConsolidatorOutput behavior. */
function normalizePatternConsolidatorOutput(
  value: unknown,
  totalCallCount: number
): PatternConsolidatorOutput {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const patterns = Array.isArray(raw.patterns)
    ? raw.patterns.map(/** Handles the callback for this operation. */(pattern, index) =>
      normalizeBehaviorPattern(pattern, index, totalCallCount)
    )
    : [];

  const patternOrder = normalizeStringArray(raw.patternOrder);

  return {
    patterns,
    patternOrder:
      patternOrder.length > 0 ? patternOrder : buildDefaultPatternOrder(patterns),
  };
}

/** Documents the isWeaknessSeverityBin behavior. */
function isWeaknessSeverityBin(value: unknown): value is WeaknessSeverityBin {
  return (
    value === "minor" ||
    value === "moderate-minor" ||
    value === "moderate" ||
    value === "moderate-severe" ||
    value === "severe"
  );
}

/** Documents the deriveRubricDomain behavior. */
function deriveRubricDomain(criterionId: string): RubricDomain {
  const domain = criterionId.slice(0, 1).toUpperCase();
  if (domain === "A" || domain === "B" || domain === "C" || domain === "D") {
    return domain;
  }
  return "C";
}

/** Documents the isSubagent2CreditFeedback behavior. */
function isSubagent2CreditFeedback(feedback: any): boolean {
  const version = feedback?.rubric_scorecard_v2?.rubric_version;
  return (
    version === "subagent_2.0_v5" ||
    version === "subagent_2.0_v6" ||
    version === "subagent_2.0_v6_1" ||
    version === "subagent_2.0_v6_2" ||
    version === "subagent_2.0_v6_3"
  );
}

/** Documents the normalizePromptVersionMap behavior. */
function normalizePromptVersionMap(
  value: unknown,
  allowedTaskIds: readonly string[]
): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const normalized = Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
    /** Handles the callback for this operation. */
    (accumulator, [taskId, version]) => {
      if (
        allowedTaskIds.includes(taskId) &&
        typeof version === "string" &&
        version.trim().length > 0
      ) {
        accumulator[taskId] = version.trim();
      }
      return accumulator;
    },
    {}
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Documents the normalizeAgentAnalysisProcessingConfig behavior. */
export function normalizeAgentAnalysisProcessingConfig(
  value: unknown
): AgentAnalysisProcessingConfig {
  const config = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const promptVersions = normalizePromptVersionMap(
    config.promptVersions,
    AGENT_ANALYSIS_PATTERN_PROMPT_TASK_IDS as readonly string[]
  );

  return {
    analyzerModel: isSupportedAnalyzerModel(config.analyzerModel)
      ? config.analyzerModel
      : undefined,
    promptVersions,
  };
}

/** Documents the buildAgentAnalysisPromptPaths behavior. */
function buildAgentAnalysisPromptPaths(
  processingConfig?: AgentAnalysisProcessingConfig
): Record<AgentAnalysisPatternPromptTaskId, string> {
  const promptPaths = { ...AGENT_ANALYSIS_PATTERN_PROMPTS };
  const promptVersions = processingConfig?.promptVersions;

  if (!promptVersions) {
    return promptPaths;
  }

  for (const taskId of AGENT_ANALYSIS_PATTERN_PROMPT_TASK_IDS) {
    const version = promptVersions[taskId];
    if (version) {
      const resolvedPath = resolveAgentAnalysisPatternPromptPath(taskId, version);
      const resolvedAbsolutePath = path.join(__dirname, resolvedPath);
      if (fs.existsSync(resolvedAbsolutePath)) {
        promptPaths[taskId] = resolvedPath;
      }
    }
  }

  return promptPaths;
}

/** Documents the hashPromptConfigState behavior. */
function hashPromptConfigState(processingConfig?: AgentAnalysisProcessingConfig): string {
  const resolvedAnalyzerModel = resolveAnalyzerModel(processingConfig?.analyzerModel);
  const promptPaths = buildAgentAnalysisPromptPaths(processingConfig);
  const promptState = AGENT_ANALYSIS_PATTERN_PROMPT_TASK_IDS.map(/** Handles the callback for this operation. */(taskId) => {
    const promptPath = promptPaths[taskId];
    const absolutePath = path.join(__dirname, promptPath);
    const promptSource = fs.existsSync(absolutePath)
      ? fs.readFileSync(absolutePath, "utf-8")
      : promptPath;

    return {
      taskId,
      promptPath,
      promptHash: createHash("sha256").update(promptSource).digest("hex"),
    };
  });

  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: BEHAVIOR_PATTERN_REPORT_SCHEMA_VERSION,
        promptFamily: AGENT_ANALYSIS_PROMPT_FAMILY,
        analyzerModel: resolvedAnalyzerModel,
        detectorChunkSize: MAX_SIGNALS_PER_DETECTOR_TASK,
        prompts: promptState,
      })
    )
    .digest("hex");
}

/** Documents the buildAgentAnalysisInputFingerprint behavior. */
export function buildAgentAnalysisInputFingerprint(input: {
  uploadedBy: string;
  salesAgentId: string;
  sourceCalls: AgentAnalysisFingerprintCallState[];
  processingConfig?: AgentAnalysisProcessingConfig;
  scope?: Record<string, unknown>;
}): string {
  const normalizedSourceCalls = [...input.sourceCalls].sort(/** Handles the callback for this operation. */(left, right) =>
    left.callId.localeCompare(right.callId)
  );

  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: "agent_analysis_input_v2",
        uploadedBy: input.uploadedBy,
        salesAgentId: input.salesAgentId,
        scope: input.scope ?? null,
        promptConfigHash: hashPromptConfigState(input.processingConfig),
        sourceCalls: normalizedSourceCalls,
      })
    )
    .digest("hex");
}

/** Documents the buildBehaviorSignalId behavior. */
export function buildBehaviorSignalId(
  callId: string,
  criterionId: string,
  critiqueIndex: number
): string {
  return `${callId}:${criterionId}:${critiqueIndex}`;
}

/** Documents the buildBehaviorSignals behavior. */
export function buildBehaviorSignals(
  callId: string,
  feedbackId: string,
  feedback: any
): BehaviorSignal[] {
  const signals: BehaviorSignal[] = [];
  const sections = Array.isArray(feedback?.rubric_scorecard_v2?.sections)
    ? feedback.rubric_scorecard_v2.sections
    : [];
  const overallScore = typeof feedback?.overall_score === "number" ? feedback.overall_score : null;
  const performanceTier =
    typeof feedback?.performance_tier === "string"
      ? (feedback.performance_tier as PerformanceTier)
      : null;

  for (const section of sections) {
    const groups = Array.isArray(section?.groups) ? section.groups : [];
    for (const group of groups) {
      const criteria = Array.isArray(group?.criteria) ? group.criteria : [];
      for (const criterion of criteria) {
        const criterionId =
          typeof criterion?.id === "string" ? criterion.id : "unknown_criterion";
        const criterionTitle =
          typeof criterion?.title === "string" ? criterion.title : criterionId;
        const badCritiques = Array.isArray(criterion?.bad_critiques)
          ? criterion.bad_critiques
          : [];
        const criterionCredit =
          typeof criterion?.credit === "number" ? criterion.credit : null;
        const criterionImprovementTip = normalizeNonEmptyString(
          criterion?.criterion_improvement_tip
        );

        badCritiques.forEach(/** Handles the callback for this operation. */(critique: any, critiqueIndex: number) => {
          if (!isWeaknessSeverityBin(critique?.severity)) {
            return;
          }

          signals.push({
            signalId: buildBehaviorSignalId(callId, criterionId, critiqueIndex),
            callId,
            feedbackId,
            criterionId,
            criterionTitle,
            rubricDomain: deriveRubricDomain(criterionId),
            critiqueTitle:
              typeof critique?.title === "string" ? critique.title : criterionTitle,
            critiqueDetail: normalizeString(critique?.detail),
            severity: critique.severity,
            criterionCredit,
            evidence: normalizeEvidence(critique?.evidence),
            criterionImprovementTip,
            weaknessImprovementTip: normalizeNonEmptyString(
              critique?.weakness_improvement_tip
            ),
            overallScore,
            performanceTier,
          });
        });
      }
    }
  }

  return signals;
}

/** Documents the chunkBehaviorSignals behavior. */
function chunkBehaviorSignals(signals: BehaviorSignal[]): BehaviorSignal[][] {
  if (signals.length === 0) {
    return [[]];
  }

  const chunks: BehaviorSignal[][] = [];
  for (let index = 0; index < signals.length; index += MAX_SIGNALS_PER_DETECTOR_TASK) {
    chunks.push(signals.slice(index, index + MAX_SIGNALS_PER_DETECTOR_TASK));
  }
  return chunks;
}

/** Documents the buildPatternDetectorTaskId behavior. */
function buildPatternDetectorTaskId(index: number): string {
  return `behavior_pattern_detector_${String(index + 1).padStart(3, "0")}`;
}

/** Documents the isBehaviorPatternDetectorTaskId behavior. */
function isBehaviorPatternDetectorTaskId(taskId: string): boolean {
  return taskId.startsWith("behavior_pattern_detector_");
}

/** Documents the isBehaviorPatternConsolidatorTaskId behavior. */
function isBehaviorPatternConsolidatorTaskId(taskId: string): boolean {
  return taskId === "behavior_pattern_consolidator";
}

/** Documents the getTaskTypeFromTaskId behavior. */
function getTaskTypeFromTaskId(taskId: string): AgentAnalysisTaskType {
  if (isBehaviorPatternConsolidatorTaskId(taskId)) {
    return "behavior_pattern_consolidator";
  }
  return "behavior_pattern_detector";
}

/** Documents the buildPatternDetectorTaskPlan behavior. */
export function buildPatternDetectorTaskPlan(
  behaviorSignals: BehaviorSignal[],
  denominatorCallCount: number,
  promptPaths?: Record<AgentAnalysisPatternPromptTaskId, string>
): PatternTaskPlanItem[] {
  const resolvedPromptPaths =
    promptPaths ?? AGENT_ANALYSIS_PATTERN_PROMPTS;
  const chunks = chunkBehaviorSignals(behaviorSignals);
  const detectorTaskIds = chunks.map(/** Handles the callback for this operation. */(_, index) => buildPatternDetectorTaskId(index));

  const tasks: PatternTaskPlanItem[] = chunks.map(/** Handles the callback for this operation. */(chunk, index) => ({
    taskId: detectorTaskIds[index],
    taskType: "behavior_pattern_detector",
    promptTaskId: "behavior_pattern_detector",
    promptPath: resolvedPromptPaths.behavior_pattern_detector,
    inputPayload: {
      chunkIndex: index + 1,
      chunkCount: chunks.length,
      totalCallCount: denominatorCallCount,
      behaviorSignals: chunk,
    },
  }));

  if (chunks.length > 1) {
    tasks.push({
      taskId: "behavior_pattern_consolidator",
      taskType: "behavior_pattern_consolidator",
      promptTaskId: "behavior_pattern_consolidator",
      promptPath: resolvedPromptPaths.behavior_pattern_consolidator,
      inputPayload: {
        detectorTaskIds,
        totalCallCount: denominatorCallCount,
      },
    });
  }

  return tasks;
}

/** Documents the buildCccAgentAnalysisCallsQuery behavior. */
function buildCccAgentAnalysisCallsQuery(
  environmentTarget: AgentAnalysisEnvironmentTarget
): FirebaseFirestore.Query {
  return db
    .collection("calls")
    .where("organizationId", "==", CONSUBANCO_ORGANIZATION_ID)
    .where("visibilityScope", "==", "organization")
    .where("callSource", "==", "ccc_gcs")
    .where("environmentTarget", "==", environmentTarget)
    .where("status", "==", "complete");
}

/** Documents the sortedAgentAnalysisCallDocs behavior. */
function sortedAgentAnalysisCallDocs(
  docs: FirebaseFirestore.QueryDocumentSnapshot[]
): FirebaseFirestore.QueryDocumentSnapshot[] {
  return [...docs].sort(/** Handles the callback for this operation. */(left, right) => {
    const leftCreatedAt = timestampToIsoString(left.data().createdAt) ?? "";
    const rightCreatedAt = timestampToIsoString(right.data().createdAt) ?? "";
    return rightCreatedAt.localeCompare(leftCreatedAt);
  });
}

/** Documents the collectCccScopedAgentAnalysisCallDocs behavior. */
async function collectCccScopedAgentAnalysisCallDocs(
  salesAgentId: string,
  queryOptions: AgentAnalysisInputQueryOptions
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  if (!queryOptions.environmentTarget) {
    return [];
  }

  const callDocsById = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  const baseQuery = buildCccAgentAnalysisCallsQuery(queryOptions.environmentTarget);

  /** Calls Firebase Firestore to read CCC calls linked by canonical sales agent id. */
  const salesAgentSnapshot = await baseQuery
    .where("salesAgentId", "==", salesAgentId)
    .orderBy("createdAt", "desc")
    .get();
  for (const callDoc of salesAgentSnapshot.docs) {
    callDocsById.set(callDoc.id, callDoc);
  }

  if (queryOptions.agentAnalysisId) {
    /** Calls Firebase Firestore to read CCC calls linked directly to this canonical profile. */
    const matchedProfileSnapshot = await baseQuery
      .where("matchedAgentAnalysisId", "==", queryOptions.agentAnalysisId)
      .orderBy("createdAt", "desc")
      .get();
    for (const callDoc of matchedProfileSnapshot.docs) {
      callDocsById.set(callDoc.id, callDoc);
    }
  }

  return sortedAgentAnalysisCallDocs(Array.from(callDocsById.values()));
}

/** Documents the collectAgentAnalysisCallDocs behavior. */
async function collectAgentAnalysisCallDocs(
  salesAgentId: string,
  queryOptions?: AgentAnalysisInputQueryOptions
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  if (queryOptions?.environmentTarget) {
    return collectCccScopedAgentAnalysisCallDocs(salesAgentId, queryOptions);
  }

  /** Shared manual agents include eligible calls from both approved uploaders. */
  const callsSnapshot = await db
    .collection("calls")
    .where("organizationId", "==", CONSUBANCO_ORGANIZATION_ID)
    .where("visibilityScope", "==", "organization")
    .where("callSource", "==", "manual_upload")
    .where("salesAgentId", "==", salesAgentId)
    .where("status", "==", "complete")
    .orderBy("createdAt", "desc")
    .get();
  return callsSnapshot.docs.filter((doc) => isDemoReportCall(doc.data()));
}

/** Documents the agentAnalysisDenominatorCallCount behavior. */
function agentAnalysisDenominatorCallCount(runData: FirebaseFirestore.DocumentData): number {
  return typeof runData.eligibleCallCount === "number"
    ? runData.eligibleCallCount
    : runData.sourceCallCount ?? 0;
}

/** Documents the collectAgentAnalysisInputState behavior. */
export async function collectAgentAnalysisInputState(
  uploadedBy: string,
  salesAgentId: string,
  processingConfig?: AgentAnalysisProcessingConfig,
  queryOptions?: AgentAnalysisInputQueryOptions
): Promise<AgentAnalysisInputState> {
  const callDocs = await collectAgentAnalysisCallDocs(salesAgentId, queryOptions);

  const skipReasons: Record<string, number> = {};
  const sourceCallIds: string[] = [];
  const eligibleCallIds: string[] = [];
  const behaviorSignals: BehaviorSignal[] = [];
  const sourceCallsForFingerprint: AgentAnalysisFingerprintCallState[] = [];

  for (const callDoc of callDocs) {
    const callData = callDoc.data();
    if (isAgentProfileCallExcluded(callData)) {
      incrementSkipReason(skipReasons, "excluded_agent_profile_call");
      continue;
    }

    sourceCallIds.push(callDoc.id);
    const latestFeedbackId =
      typeof callData.latestFeedbackId === "string" ? callData.latestFeedbackId : undefined;
    const callUpdatedAt =
      timestampToIsoString(callData.updatedAt) ?? timestampToIsoString(callDoc.updateTime);

    if (!latestFeedbackId) {
      incrementSkipReason(skipReasons, "missing_latest_feedback_id");
      sourceCallsForFingerprint.push({
        callId: callDoc.id,
        callUpdatedAt,
        latestFeedbackId: null,
        feedbackVersion: null,
        feedbackUpdatedAt: null,
        skipReason: "missing_latest_feedback_id",
      });
      continue;
    }

    /** Calls an external SDK or API dependency. */
    const feedbackDoc = await callDoc.ref.collection("feedback").doc(latestFeedbackId).get();
    if (!feedbackDoc.exists) {
      incrementSkipReason(skipReasons, "missing_feedback_doc");
      sourceCallsForFingerprint.push({
        callId: callDoc.id,
        callUpdatedAt,
        latestFeedbackId,
        feedbackVersion: null,
        feedbackUpdatedAt: null,
        skipReason: "missing_feedback_doc",
      });
      continue;
    }

    const feedback = feedbackDoc.data();
    const feedbackVersion = normalizeNonEmptyString(
      feedback?.rubric_scorecard_v2?.rubric_version
    );
    const feedbackUpdatedAt =
      timestampToIsoString(feedback?.updatedAt) ?? timestampToIsoString(feedbackDoc.updateTime);

    if (!isSubagent2CreditFeedback(feedback)) {
      incrementSkipReason(skipReasons, "unsupported_feedback_version");
      sourceCallsForFingerprint.push({
        callId: callDoc.id,
        callUpdatedAt,
        latestFeedbackId,
        feedbackVersion,
        feedbackUpdatedAt,
        skipReason: "unsupported_feedback_version",
      });
      continue;
    }

    eligibleCallIds.push(callDoc.id);
    behaviorSignals.push(...buildBehaviorSignals(callDoc.id, latestFeedbackId, feedback));
    sourceCallsForFingerprint.push({
      callId: callDoc.id,
      callUpdatedAt,
      latestFeedbackId,
      feedbackVersion,
      feedbackUpdatedAt,
      skipReason: null,
    });
  }

  return {
    sourceCallIds,
    eligibleCallIds,
    skipReasons,
    behaviorSignals,
    inputFingerprint: buildAgentAnalysisInputFingerprint({
      uploadedBy,
      salesAgentId,
      processingConfig,
      scope: queryOptions?.environmentTarget
        ? {
          organizationId: CONSUBANCO_ORGANIZATION_ID,
          callSource: "ccc_gcs",
          environmentTarget: queryOptions.environmentTarget,
        }
        : undefined,
      sourceCalls: sourceCallsForFingerprint,
    }),
    environmentTarget: queryOptions?.environmentTarget,
  };
}

/** Documents the buildBehaviorPatternDetectorUserPrompt behavior. */
function buildBehaviorPatternDetectorUserPrompt(inputPayload: unknown): string {
  return `## Input JSON

\`\`\`json
${JSON.stringify(inputPayload, null, 2)}
\`\`\`

Agrupa estas señales en patrones conductuales y devuelve solo el objeto JSON final.`;
}

/** Documents the buildBehaviorPatternConsolidatorUserPrompt behavior. */
function buildBehaviorPatternConsolidatorUserPrompt(inputPayload: unknown): string {
  return `## Input JSON

\`\`\`json
${JSON.stringify(inputPayload, null, 2)}
\`\`\`

Consolida estos patrones candidatos y devuelve solo el objeto JSON final.`;
}

/** Documents the getBehaviorSignalsFromTaskInput behavior. */
function getBehaviorSignalsFromTaskInput(inputPayload: unknown): BehaviorSignal[] {
  const payload =
    inputPayload && typeof inputPayload === "object"
      ? (inputPayload as Record<string, unknown>)
      : undefined;
  return Array.isArray(payload?.behaviorSignals)
    ? (payload.behaviorSignals as BehaviorSignal[])
    : [];
}

/** Documents the incrementRunCompletedTaskCount behavior. */
async function incrementRunCompletedTaskCount(
  runRef: FirebaseFirestore.DocumentReference
): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  await db.runTransaction(/** Handles the callback for this operation. */ async (transaction) => {
    const runDoc = await transaction.get(runRef);
    const runData = runDoc.data();
    if (!runDoc.exists || !runData) {
      return;
    }

    /** Calls an external SDK or API dependency. */
    transaction.update(runRef, {
      completedTaskCount: (runData.completedTaskCount || 0) + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

/** Documents the getRunTasks behavior. */
async function getRunTasks(
  runRef: FirebaseFirestore.DocumentReference
): Promise<Array<{ id: string; data: FirebaseFirestore.DocumentData }>> {
  const tasksSnapshot = await runRef.collection("tasks").get();
  return tasksSnapshot.docs.map(/** Handles the callback for this operation. */(doc) => ({ id: doc.id, data: doc.data() }));
}

/** Documents the areAllDetectorTasksTerminal behavior. */
function areAllDetectorTasksTerminal(
  tasks: Array<{ id: string; data: FirebaseFirestore.DocumentData }>
): boolean {
  return tasks
    .filter(/** Handles the callback for this operation. */(task) => getTaskTypeFromTaskId(task.id) === "behavior_pattern_detector")
    .every(/** Handles the callback for this operation. */(task) => task.data.status === "complete" || task.data.status === "error");
}

/** Documents the maybeContinueAgentAnalysisRun behavior. */
async function maybeContinueAgentAnalysisRun(
  agentAnalysisId: string,
  runId: string
): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const agentAnalysisRef = db.collection(AGENT_ANALYSES_COLLECTION).doc(agentAnalysisId);
  /** Calls an external SDK or API dependency. */
  const runRef = agentAnalysisRef.collection("analysis_runs").doc(runId);
  const tasks = await getRunTasks(runRef);
  const consolidatorTask = tasks.find(/** Handles the callback for this operation. */(task) =>
    isBehaviorPatternConsolidatorTaskId(task.id)
  );

  if (!consolidatorTask) {
    if (areAllDetectorTasksTerminal(tasks)) {
      await finalizeAgentAnalysisRun(agentAnalysisId, runId);
    }
    return;
  }

  if (!areAllDetectorTasksTerminal(tasks)) {
    return;
  }

  const detectorFailed = tasks.some(
    /** Handles the callback for this operation. */
    (task) =>
      getTaskTypeFromTaskId(task.id) === "behavior_pattern_detector" &&
      task.data.status === "error"
  );

  if (detectorFailed) {
    await finalizeAgentAnalysisRun(agentAnalysisId, runId);
    return;
  }

  if (consolidatorTask.data.status === "pending") {
    await enqueueAgentAnalysisTask({ agentAnalysisId, runId, taskId: consolidatorTask.id });
    return;
  }

  if (
    consolidatorTask.data.status === "complete" ||
    consolidatorTask.data.status === "error"
  ) {
    await finalizeAgentAnalysisRun(agentAnalysisId, runId);
  }
}

/** Documents the dispatchAgentAnalysisRun behavior. */
export async function dispatchAgentAnalysisRun(agentAnalysisId: string): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const agentAnalysisRef = db.collection(AGENT_ANALYSES_COLLECTION).doc(agentAnalysisId);
  const agentAnalysisDoc = await agentAnalysisRef.get();
  if (!agentAnalysisDoc.exists) {
    throw new Error(`Agent analysis not found: ${agentAnalysisId}`);
  }

  const agentAnalysisData = agentAnalysisDoc.data();
  if (!agentAnalysisData) {
    throw new Error(`Agent analysis has no data: ${agentAnalysisId}`);
  }

  const existingRunId =
    typeof agentAnalysisData.activeRunId === "string"
      ? agentAnalysisData.activeRunId
      : undefined;
  if (existingRunId) {
    /** Calls an external SDK or API dependency. */
    const existingRunDoc = await agentAnalysisRef
      .collection("analysis_runs")
      .doc(existingRunId)
      .get();
    if (existingRunDoc.exists) {
      console.log(
        `Skipping dispatch: active agent-analysis run ${existingRunId} already exists for ${agentAnalysisId}`
      );
      return;
    }
  }

  const uploadedBy =
    typeof agentAnalysisData.uploadedBy === "string" ? agentAnalysisData.uploadedBy : "";
  const salesAgentId =
    typeof agentAnalysisData.salesAgentId === "string"
      ? agentAnalysisData.salesAgentId
      : "";
  const salesAgentName =
    typeof agentAnalysisData.salesAgentName === "string"
      ? agentAnalysisData.salesAgentName
      : "";

  if (!uploadedBy || !salesAgentId || !salesAgentName) {
    throw new Error("Agent analysis is missing uploadedBy, salesAgentId, or salesAgentName");
  }

  const runId = `agent_analysis_${Date.now()}`;
  const processingConfig = normalizeAgentAnalysisProcessingConfig(
    agentAnalysisData.reportProcessingConfig
  );
  const environmentTarget = resolveAgentAnalysisEnvironmentTarget(agentAnalysisData);
  const inputState = await collectAgentAnalysisInputState(
    uploadedBy,
    salesAgentId,
    processingConfig,
    { agentAnalysisId, environmentTarget }
  );
  const latestInputFingerprint =
    typeof agentAnalysisData.latestInputFingerprint === "string"
      ? agentAnalysisData.latestInputFingerprint
      : undefined;
  const latestReportId =
    typeof agentAnalysisData.latestReportId === "string"
      ? agentAnalysisData.latestReportId
      : undefined;

  if (latestReportId && latestInputFingerprint === inputState.inputFingerprint) {
    /** Calls an external SDK or API dependency. */
    await agentAnalysisRef.update({
      status: "complete",
      activeRunId: FieldValue.delete(),
      error: null,
      lastRunSkippedReason: "no_changes",
      lastRunSkippedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(
      `Skipping dispatch: no backend state changes detected for ${agentAnalysisId}; latest report ${latestReportId} is still current`
    );
    return;
  }

  if (inputState.sourceCallIds.length === 0) {
    /** Calls an external SDK or API dependency. */
    await agentAnalysisRef.update({
      status: "ready",
      activeRunId: FieldValue.delete(),
      error: null,
      lastRunSkippedReason: "no_complete_calls",
      lastRunSkippedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  if (inputState.eligibleCallIds.length === 0) {
    /** Calls an external SDK or API dependency. */
    await agentAnalysisRef.update({
      status: "ready",
      activeRunId: FieldValue.delete(),
      error: null,
      lastRunSkippedReason: "no_eligible_calls",
      lastRunSkippedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  const promptPaths = buildAgentAnalysisPromptPaths(processingConfig);
  const analyzerModel = resolveAnalyzerModel(processingConfig.analyzerModel);
  const taskPlan = buildPatternDetectorTaskPlan(
    inputState.behaviorSignals,
    inputState.eligibleCallIds.length,
    promptPaths
  );
  /** Calls an external SDK or API dependency. */
  const runRef = agentAnalysisRef.collection("analysis_runs").doc(runId);

  /** Calls an external SDK or API dependency. */
  await runRef.set({
    status: "running",
    uploadedBy,
    salesAgentId,
    salesAgentName,
    analyzerModel,
    promptPaths,
    usedPromptFamily: AGENT_ANALYSIS_PROMPT_FAMILY,
    inputFingerprint: inputState.inputFingerprint,
    sourceCallIds: inputState.sourceCallIds,
    eligibleCallIds: inputState.eligibleCallIds,
    ...(inputState.environmentTarget ? { environmentTarget: inputState.environmentTarget } : {}),
    sourceCallCount: inputState.sourceCallIds.length,
    eligibleCallCount: inputState.eligibleCallIds.length,
    skippedCallCount:
      inputState.sourceCallIds.length - inputState.eligibleCallIds.length,
    behaviorSignalCount: inputState.behaviorSignals.length,
    skipReasons: inputState.skipReasons,
    taskCount: taskPlan.length,
    completedTaskCount: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  /** Calls an external SDK or API dependency. */
  await agentAnalysisRef.update({
    status: "analyzing",
    activeRunId: runId,
    error: null,
    lastRunSkippedReason: FieldValue.delete(),
    lastRunSkippedAt: FieldValue.delete(),
    analysisStartedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  /** Calls Firebase Firestore to read or write persisted application data. */
  const batch = db.batch();
  for (const task of taskPlan) {
    /** Calls an external SDK or API dependency. */
    const taskRef = runRef.collection("tasks").doc(task.taskId);
    /** Calls an external SDK or API dependency. */
    batch.set(taskRef, {
      taskType: task.taskType,
      promptTaskId: task.promptTaskId,
      status: "pending",
      attempts: 0,
      promptPath: task.promptPath,
      inputPayload: {
        agentAnalysisId,
        runId,
        salesAgentId,
        salesAgentName,
        ...task.inputPayload,
      },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();

  console.log(
    `Dispatched ${taskPlan.length} pattern-analysis tasks for agent analysis ${agentAnalysisId}/${runId}`
  );
}

/** Documents the runAgentAnalysisTask behavior. */
export async function runAgentAnalysisTask(
  agentAnalysisId: string,
  runId: string,
  taskId: string
): Promise<void> {
  const taskType = getTaskTypeFromTaskId(taskId);
  /** Calls Firebase Firestore to read or write persisted application data. */
  const agentAnalysisRef = db.collection(AGENT_ANALYSES_COLLECTION).doc(agentAnalysisId);
  /** Calls an external SDK or API dependency. */
  const runRef = agentAnalysisRef.collection("analysis_runs").doc(runId);
  /** Calls an external SDK or API dependency. */
  const taskRef = runRef.collection("tasks").doc(taskId);

  const [runDoc, taskDoc] = await Promise.all([runRef.get(), taskRef.get()]);
  const runData = runDoc.data();
  const taskData = taskDoc.data();

  if (!runDoc.exists || !runData || !taskDoc.exists || !taskData) {
    console.log(`Agent-analysis task doc not found: ${agentAnalysisId}/${runId}/${taskId}`);
    return;
  }

  if (taskData.status !== "pending") {
    return;
  }

  const analyzerModel = resolveAnalyzerModel(runData.analyzerModel ?? DEFAULT_ANALYZER_MODEL);
  const promptTaskId =
    isAgentAnalysisPatternPromptTaskId(taskData.promptTaskId)
      ? taskData.promptTaskId
      : taskType;
  const promptPath =
    (runData.promptPaths as Record<string, string> | undefined)?.[promptTaskId] ??
    taskData.promptPath ??
    AGENT_ANALYSIS_PATTERN_PROMPTS[promptTaskId];

  if (!promptPath) {
    throw new Error(`Prompt path not found for agent-analysis task ${taskId}`);
  }

  if (taskType === "behavior_pattern_detector") {
    const behaviorSignals = getBehaviorSignalsFromTaskInput(taskData.inputPayload);
    const fallbackTotalCallCount = agentAnalysisDenominatorCallCount(runData);
    const totalCallCount =
      typeof taskData.inputPayload?.totalCallCount === "number"
        ? taskData.inputPayload.totalCallCount
        : fallbackTotalCallCount;

    if (behaviorSignals.length === 0) {
      const sanitizedOutput = sanitizeSubagentOutputForFirestore({ candidatePatterns: [] });
      /** Calls an external SDK or API dependency. */
      await taskRef.update({
        status: "complete",
        output: sanitizedOutput.output,
        model: null,
        promptPath,
        skippedReason: "no_behavior_signals",
        ...(sanitizedOutput.sanitized ? {
          outputSanitized: true,
          outputSanitizationIssues: sanitizedOutput.issues,
        } : {}),
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await incrementRunCompletedTaskCount(runRef);
      await maybeContinueAgentAnalysisRun(agentAnalysisId, runId);
      return;
    }

    /** Calls an external SDK or API dependency. */
    await taskRef.update({
      status: "running",
      attempts: (taskData.attempts || 0) + 1,
      model: analyzerModel,
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    try {
      const systemPrompt = fs.readFileSync(path.join(__dirname, promptPath), "utf-8");
      const userPrompt = buildBehaviorPatternDetectorUserPrompt(taskData.inputPayload ?? {});
      const openai = createDemoOpenAI({ purpose: 'agent_analysis' });
      /** Calls the OpenAI API for model inference or transcription. */
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
      if (!responseText) {
        throw new Error("No response from OpenAI");
      }

      const output = normalizePatternDetectorOutput(
        JSON.parse(responseText),
        totalCallCount
      );
      const sanitizedOutput = sanitizeSubagentOutputForFirestore(output);

      /** Calls an external SDK or API dependency. */
      await taskRef.update({
        status: "complete",
        output: sanitizedOutput.output,
        model: analyzerModel,
        promptPath,
        ...(sanitizedOutput.sanitized ? {
          outputSanitized: true,
          outputSanitizationIssues: sanitizedOutput.issues,
        } : {}),
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (error: any) {
      console.error(`Pattern detector ${taskId} failed for ${agentAnalysisId}/${runId}:`, error);
      /** Calls an external SDK or API dependency. */
      await taskRef.update({
        status: "error",
        error: error.message || "Behavior pattern detector failed",
        model: analyzerModel,
        promptPath,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    await incrementRunCompletedTaskCount(runRef);
    await maybeContinueAgentAnalysisRun(agentAnalysisId, runId);
    return;
  }

  const tasks = await getRunTasks(runRef);
  const fallbackTotalCallCount = agentAnalysisDenominatorCallCount(runData);
  const detectorTasks = tasks.filter(/** Handles the callback for this operation. */(task) =>
    isBehaviorPatternDetectorTaskId(task.id)
  );

  if (
    detectorTasks.some(
      /** Handles the callback for this operation. */
      (task) => task.data.status !== "complete" && task.data.status !== "error"
    )
  ) {
    return;
  }

  if (detectorTasks.some(/** Handles the callback for this operation. */(task) => task.data.status === "error")) {
    /** Calls an external SDK or API dependency. */
    await taskRef.update({
      status: "error",
      error: "One or more detector tasks failed",
      model: analyzerModel,
      promptPath,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await incrementRunCompletedTaskCount(runRef);
    await maybeContinueAgentAnalysisRun(agentAnalysisId, runId);
    return;
  }

  /** Calls an external SDK or API dependency. */
  await taskRef.update({
    status: "running",
    attempts: (taskData.attempts || 0) + 1,
    model: analyzerModel,
    startedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  try {
    const candidatePatterns = detectorTasks.flatMap(/** Handles the callback for this operation. */(task) => {
      const output = normalizePatternDetectorOutput(
        task.data.output,
        fallbackTotalCallCount
      );
      return output.candidatePatterns;
    });

    if (candidatePatterns.length === 0) {
      const sanitizedOutput = sanitizeSubagentOutputForFirestore({
        patterns: [],
        patternOrder: [],
      });
      /** Calls an external SDK or API dependency. */
      await taskRef.update({
        status: "complete",
        output: sanitizedOutput.output,
        model: null,
        promptPath,
        skippedReason: "no_candidate_patterns",
        ...(sanitizedOutput.sanitized ? {
          outputSanitized: true,
          outputSanitizationIssues: sanitizedOutput.issues,
        } : {}),
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await incrementRunCompletedTaskCount(runRef);
      await maybeContinueAgentAnalysisRun(agentAnalysisId, runId);
      return;
    }

    const systemPrompt = fs.readFileSync(path.join(__dirname, promptPath), "utf-8");
    const userPrompt = buildBehaviorPatternConsolidatorUserPrompt({
      ...(taskData.inputPayload ?? {}),
      totalCallCount: fallbackTotalCallCount,
      candidatePatterns,
    });

    const openai = createDemoOpenAI({ purpose: 'agent_analysis' });
    /** Calls the OpenAI API for model inference or transcription. */
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
    if (!responseText) {
      throw new Error("No response from OpenAI");
    }

    const output = normalizePatternConsolidatorOutput(
      JSON.parse(responseText),
      fallbackTotalCallCount
    );
    const sanitizedOutput = sanitizeSubagentOutputForFirestore(output);

    /** Calls an external SDK or API dependency. */
    await taskRef.update({
      status: "complete",
      output: sanitizedOutput.output,
      model: analyzerModel,
      promptPath,
      ...(sanitizedOutput.sanitized ? {
        outputSanitized: true,
        outputSanitizationIssues: sanitizedOutput.issues,
      } : {}),
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error: any) {
    console.error(
      `Pattern consolidator failed for ${agentAnalysisId}/${runId}/${taskId}:`,
      error
    );
    /** Calls an external SDK or API dependency. */
    await taskRef.update({
      status: "error",
      error: error.message || "Behavior pattern consolidator failed",
      model: analyzerModel,
      promptPath,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  await incrementRunCompletedTaskCount(runRef);
  await maybeContinueAgentAnalysisRun(agentAnalysisId, runId);
}

/** Documents the finalizeAgentAnalysisRun behavior. */
export async function finalizeAgentAnalysisRun(
  agentAnalysisId: string,
  runId: string
): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const agentAnalysisRef = db.collection(AGENT_ANALYSES_COLLECTION).doc(agentAnalysisId);
  /** Calls an external SDK or API dependency. */
  const runRef = agentAnalysisRef.collection("analysis_runs").doc(runId);

  const runDoc = await runRef.get();
  const runData = runDoc.data();
  if (!runDoc.exists || !runData) {
    return;
  }

  if (runData.finalizedAt) {
    return;
  }

  const tasks = await getRunTasks(runRef);
  const errorMessages = tasks
    .filter(/** Handles the callback for this operation. */(task) => task.data.status === "error")
    .map(/** Handles the callback for this operation. */(task) => `${task.id}: ${task.data.error || "unknown error"}`);

  if (errorMessages.length > 0) {
    const combinedError = errorMessages.join("; ");
    const errorCode = tasks.find(/** Handles the callback for this operation. */(task) => typeof task.data.errorCode === "string")
      ?.data.errorCode as string | undefined;
    /** Calls an external SDK or API dependency. */
    await runRef.update({
      status: "error",
      error: combinedError,
      completedAt: FieldValue.serverTimestamp(),
      finalizedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    /** Calls an external SDK or API dependency. */
    await agentAnalysisRef.update({
      status: "error",
      activeRunId: FieldValue.delete(),
      error: combinedError,
      updatedAt: FieldValue.serverTimestamp(),
    });

    await maybeCreateAgentReportTerminalInboxMessage({
      agentAnalysisId,
      runId,
      uploadedBy: typeof runData.uploadedBy === "string" ? runData.uploadedBy : "",
      salesAgentId: typeof runData.salesAgentId === "string" ? runData.salesAgentId : null,
      salesAgentName: typeof runData.salesAgentName === "string" ? runData.salesAgentName : null,
      status: "error",
      errorCode: errorCode ?? null,
    });
    return;
  }

  let finalOutput: PatternConsolidatorOutput;
  const fallbackTotalCallCount = agentAnalysisDenominatorCallCount(runData);
  const consolidatorTask = tasks.find(/** Handles the callback for this operation. */(task) =>
    isBehaviorPatternConsolidatorTaskId(task.id)
  );

  if (consolidatorTask) {
    if (!consolidatorTask.data.output) {
      const combinedError = "missing output from: behavior_pattern_consolidator";
      /** Calls an external SDK or API dependency. */
      await runRef.update({
        status: "error",
        error: combinedError,
        completedAt: FieldValue.serverTimestamp(),
        finalizedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      /** Calls an external SDK or API dependency. */
      await agentAnalysisRef.update({
        status: "error",
        activeRunId: FieldValue.delete(),
        error: combinedError,
        updatedAt: FieldValue.serverTimestamp(),
      });

      await maybeCreateAgentReportTerminalInboxMessage({
        agentAnalysisId,
        runId,
        uploadedBy: typeof runData.uploadedBy === "string" ? runData.uploadedBy : "",
        salesAgentId: typeof runData.salesAgentId === "string" ? runData.salesAgentId : null,
        salesAgentName: typeof runData.salesAgentName === "string" ? runData.salesAgentName : null,
        status: "error",
        errorCode: null,
      });
      return;
    }

    finalOutput = normalizePatternConsolidatorOutput(
      consolidatorTask.data.output,
      fallbackTotalCallCount
    );
  } else {
    const detectorPatterns = tasks
      .filter(/** Handles the callback for this operation. */(task) => isBehaviorPatternDetectorTaskId(task.id))
      .flatMap(/** Handles the callback for this operation. */(task) =>
        normalizePatternDetectorOutput(task.data.output, fallbackTotalCallCount)
          .candidatePatterns
      );

    finalOutput = {
      patterns: detectorPatterns,
      patternOrder: buildDefaultPatternOrder(detectorPatterns),
    };
  }

  const reportSourceCallIds = Array.isArray(runData.sourceCallIds)
    ? runData.sourceCallIds
      .map(/** Handles the callback for this operation. */(callId) => normalizeNonEmptyString(callId))
      .filter(/** Handles the callback for this operation. */(callId): callId is string => callId !== null)
    : [];

  const runDenominatorCallIds = new Set<string>(reportSourceCallIds);
  const signalsById = buildBehaviorSignalsById(tasks);

  const reconciledPatterns = finalOutput.patterns.map(/** Handles the callback for this operation. */(pattern) => {
    const verifiedCallIds = buildVerifiedPatternCallIds(
      pattern,
      signalsById,
      runDenominatorCallIds
    );

    return {
      ...pattern,
      sourceCallIds: verifiedCallIds,
      seenInCallCount: verifiedCallIds.length,
    };
  });

  const finalizedPatterns = reconciledPatterns.filter(
    /** Handles the callback for this operation. */
    (pattern) => pattern.sourceCallIds.length > 0
  );

  const sanitizedPatternOrder = sanitizePatternOrder(
    finalOutput.patternOrder,
    finalizedPatterns
  );

  /** Calls an external SDK or API dependency. */
  await agentAnalysisRef.collection("reports").doc(runId).set({
    schemaVersion: BEHAVIOR_PATTERN_REPORT_SCHEMA_VERSION,
    uploadedBy: runData.uploadedBy ?? "",
    salesAgentId: runData.salesAgentId ?? "",
    salesAgentName: runData.salesAgentName ?? "",
    inputFingerprint: runData.inputFingerprint ?? null,
    ...(typeof runData.environmentTarget === "string" ? { environmentTarget: runData.environmentTarget } : {}),
    sourceCallIds: reportSourceCallIds,
    coverage: {
      sourceCallCount: runData.sourceCallCount ?? 0,
      eligibleCallCount: runData.eligibleCallCount ?? 0,
      skippedCallCount: runData.skippedCallCount ?? 0,
    },
    patterns: finalizedPatterns,
    patternOrder: sanitizedPatternOrder,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  /** Calls an external SDK or API dependency. */
  await runRef.update({
    status: "complete",
    completedAt: FieldValue.serverTimestamp(),
    finalizedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  /** Calls an external SDK or API dependency. */
  await agentAnalysisRef.update({
    status: "complete",
    activeRunId: FieldValue.delete(),
    latestRunId: runId,
    latestReportId: runId,
    latestInputFingerprint: runData.inputFingerprint ?? null,
    lastRunSkippedReason: FieldValue.delete(),
    lastRunSkippedAt: FieldValue.delete(),
    analysisCompletedAt: FieldValue.serverTimestamp(),
    error: null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await maybeCreateAgentReportTerminalInboxMessage({
    agentAnalysisId,
    runId,
    uploadedBy: typeof runData.uploadedBy === "string" ? runData.uploadedBy : "",
    salesAgentId: typeof runData.salesAgentId === "string" ? runData.salesAgentId : null,
    salesAgentName: typeof runData.salesAgentName === "string" ? runData.salesAgentName : null,
    status: "complete",
  });
}
