// --- Legacy monolithic prompt config (replaced by parallel subagent analysis) ---
// export const PROMPT_VERSION = "prompts/promptv5.3.md";
// Available versions: promptv2.md, promptv3.md, promptv4.4.md, promptv5.1.md, promptv5.2.md, promptv5.3.md
// Source files are in: prompt_history/prompts/ (organized by major version)

/**
 * Analysis modes:
 *
 * - legacy_tmk: existing TMK rubric pipeline (rubric_scorecard + strengths + weaknesses)
 * - subagent_2_0: new rubric pipeline defined in `subagent_2.0/rubric.md`
 *
 * Runtime selection is environment-driven. The dispatcher also persists the mode on the
 * analysis run doc so a run stays consistent even if env changes later.
 */
export type AnalysisMode = "legacy_tmk" | "subagent_2_0";

/** Documents the getAnalysisModeFromEnv behavior. */
export function getAnalysisModeFromEnv(): AnalysisMode {
  return process.env.SUBAGENT_ANALYSIS_MODE === "subagent_2_0"
    ? "subagent_2_0"
    : "legacy_tmk";
}

/**
 * Analyzer-model selection applies only to the chat-completions analysis step.
 * It must never be reused for transcription, whose job snapshot selects
 * OpenAI diarization or opt-in ElevenLabs Scribe v2 in `transcriptionProvider.ts`.
 */
export const SUPPORTED_ANALYZER_MODELS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1",
  "gpt-5.1",
  "gpt-5.4",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-6-astra",
] as const;

export type AnalyzerModel = typeof SUPPORTED_ANALYZER_MODELS[number];

export const DEFAULT_ANALYZER_MODEL: AnalyzerModel = "gpt-5.4";

export const CALL_ACTIVITY_EXTRACTOR_PROMPT =
  "prompts/promptsubagent2.0-subagent-call_activity_extractor-v1.2.md";
export const CALL_ACTIVITY_EXTRACTOR_TASK_ID = "call_activity_extractor" as const;
export const CALL_ACTIVITY_PROMPT_TASK_IDS = [CALL_ACTIVITY_EXTRACTOR_TASK_ID] as const;
export type CallActivityPromptTaskId = typeof CALL_ACTIVITY_PROMPT_TASK_IDS[number];

export const POST_CALL_EVENT_DETECTOR_PROMPT =
  "prompts/promptsubagent2.0-subagent-post_call_event_detector-v1.md";
export const POST_CALL_EVENT_DETECTOR_TASK_ID = "post_call_event_detector" as const;


export const MANUAL_SHORT_CALL_REVIEW_TASK_IDS = [
  "short_call_contact_classifier",
  "short_call_reason_protocol_reviewer",
  "short_call_review_consolidator",
] as const;

export const MANUAL_SHORT_CALL_INITIAL_TASK_IDS = [
  "short_call_contact_classifier",
  "short_call_reason_protocol_reviewer",
] as const;

export const MANUAL_SHORT_CALL_CONSOLIDATOR_TASK_ID =
  "short_call_review_consolidator" as const;

export type ManualShortCallReviewTaskId = typeof MANUAL_SHORT_CALL_REVIEW_TASK_IDS[number];

export const MANUAL_SHORT_CALL_REVIEW_PROMPTS: Record<ManualShortCallReviewTaskId, string> = {
  short_call_contact_classifier:
    "prompts/promptsubagent2.0-subagent-short_call_contact_classifier-v2.md",
  short_call_reason_protocol_reviewer:
    "prompts/promptsubagent2.0-subagent-short_call_reason_protocol_reviewer-v2.md",
  short_call_review_consolidator:
    "prompts/promptsubagent2.0-subagent-short_call_review_consolidator-v2.md",
};

export type WeaknessSeverityBin =
  | "minor"
  | "moderate-minor"
  | "moderate"
  | "moderate-severe"
  | "severe";

export const AGENT_ANALYSIS_PATTERN_PROMPT_TASK_IDS = [
  "behavior_pattern_detector",
  "behavior_pattern_consolidator",
] as const;

export type AgentAnalysisPatternPromptTaskId =
  typeof AGENT_ANALYSIS_PATTERN_PROMPT_TASK_IDS[number];

/** Documents the isSupportedAnalyzerModel behavior. */
export function isSupportedAnalyzerModel(value: unknown): value is AnalyzerModel {
  return (
    typeof value === "string" &&
    (SUPPORTED_ANALYZER_MODELS as readonly string[]).includes(value)
  );
}

/** Documents the resolveAnalyzerModel behavior. */
export function resolveAnalyzerModel(value: unknown): AnalyzerModel {
  return isSupportedAnalyzerModel(value) ? value : DEFAULT_ANALYZER_MODEL;
}

/**
 * Legacy (TMK) task ids and prompt mappings.
 *
 * Keys are the taskId values used in analysis_runs/{runId}/tasks/{taskId}.
 * Values are paths relative to __dirname (i.e. lib/) after the functions build
 * copies prompt files into lib/prompts/.
 */
export const LEGACY_SUBAGENT_TASK_IDS = [
  "core_fields",
  "rubric_scorecard",
  "strengths",
  "weaknesses",
  "coaching",
] as const;

export type LegacySubagentTaskId = typeof LEGACY_SUBAGENT_TASK_IDS[number];

export const LEGACY_SUBAGENT_PROMPTS: Record<LegacySubagentTaskId, string> = {
  core_fields: "prompts/promptv5.6-subagent-core_fields.md",
  rubric_scorecard: "prompts/promptv5.8-subagent-rubric_scorecard.md",
  strengths: "prompts/promptv5.8-subagent-strengths.md",
  weaknesses: "prompts/promptv5.9-subagent-weaknesses.md",
  coaching: "prompts/promptv5.6-subagent-coaching.md",
};

/**
 * Subagent 2.0 task ids and prompt mappings.
 *
 * Runtime prompt files live under `subagent_2.0/<subagent_name>/promptsubagent2.0-subagent-*.md`
 * and are copied into the functions bundle under `lib/prompts/`.
 */
export const SUBAGENT_2_0_STAGE1_TASK_IDS = [
  "core_fields",
  "coaching",
  "rubric_analysis_A",
  "rubric_analysis_B",
  "rubric_analysis_C",
  "rubric_analysis_D",
] as const;

export const SUBAGENT_2_0_STAGE2_TASK_IDS = [
  "severity_analysis_A",
  "severity_analysis_B",
  "severity_analysis_C",
  "severity_analysis_D",
] as const;

export const SUBAGENT_2_0_TASK_IDS = [
  ...SUBAGENT_2_0_STAGE1_TASK_IDS,
  ...SUBAGENT_2_0_STAGE2_TASK_IDS,
] as const;

export type Subagent2TaskId = typeof SUBAGENT_2_0_TASK_IDS[number];
export type AnalyzerModelOverrides = Partial<Record<Subagent2TaskId, AnalyzerModel>>;

/** Rejects invalid new model selections instead of silently substituting a model. */
export function requireAnalyzerModel(value: unknown): AnalyzerModel {
  if (!isSupportedAnalyzerModel(value)) throw new Error("Unsupported analyzer model: " + String(value));
  return value;
}

/** Validates the complete replacement map; omitted legacy maps mean no overrides. */
export function validateAnalyzerModelOverrides(value: unknown): AnalyzerModelOverrides {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("analyzerModelOverrides must be an object");
  }
  const overrides: AnalyzerModelOverrides = {};
  for (const [taskId, model] of Object.entries(value)) {
    if (!(SUBAGENT_2_0_TASK_IDS as readonly string[]).includes(taskId)) {
      throw new Error("Unsupported analyzer task: " + taskId);
    }
    overrides[taskId as Subagent2TaskId] = requireAnalyzerModel(model);
  }
  return overrides;
}

/** Freezes every effective task model when a run starts. */
export function resolveSubagentModels(defaultModel: AnalyzerModel, value?: unknown): Record<Subagent2TaskId, AnalyzerModel> {
  const overrides = validateAnalyzerModelOverrides(value);
  return Object.fromEntries(SUBAGENT_2_0_TASK_IDS.map((taskId) => [taskId, overrides[taskId] ?? defaultModel])) as Record<Subagent2TaskId, AnalyzerModel>;
}
export type Subagent2Stage1TaskId = typeof SUBAGENT_2_0_STAGE1_TASK_IDS[number];
export type Subagent2SeverityTaskId = typeof SUBAGENT_2_0_STAGE2_TASK_IDS[number];

export const SUBAGENT_2_0_PROMPTS: Record<Subagent2TaskId, string> = {
  core_fields: "prompts/promptsubagent2.0-subagent-core_fields-v1.md",
  coaching: "prompts/promptsubagent2.0-subagent-coaching-v6.3.md",
  rubric_analysis_A: "prompts/promptsubagent2.0-subagent-rubric_analysis_A-v6.6.md",
  rubric_analysis_B: "prompts/promptsubagent2.0-subagent-rubric_analysis_B-v6.6.md",
  rubric_analysis_C: "prompts/promptsubagent2.0-subagent-rubric_analysis_C-v6.6.md",
  rubric_analysis_D: "prompts/promptsubagent2.0-subagent-rubric_analysis_D-v6.6.md",
  severity_analysis_A: "prompts/promptsubagent2.0-subagent-severity_analysis_A-v2.md",
  severity_analysis_B: "prompts/promptsubagent2.0-subagent-severity_analysis_B-v2.md",
  severity_analysis_C: "prompts/promptsubagent2.0-subagent-severity_analysis_C-v2.md",
  severity_analysis_D: "prompts/promptsubagent2.0-subagent-severity_analysis_D-v2.md",
};

export const SUBAGENT_2_0_SEVERITY_PARENT_TASK_IDS: Record<
  Subagent2SeverityTaskId,
  Extract<Subagent2Stage1TaskId, `rubric_analysis_${string}`>
> = {
  severity_analysis_A: "rubric_analysis_A",
  severity_analysis_B: "rubric_analysis_B",
  severity_analysis_C: "rubric_analysis_C",
  severity_analysis_D: "rubric_analysis_D",
};

/** Documents the isSubagent2SeverityTaskId behavior. */
export function isSubagent2SeverityTaskId(taskId: string): taskId is Subagent2SeverityTaskId {
  return (SUBAGENT_2_0_STAGE2_TASK_IDS as readonly string[]).includes(taskId);
}

export type SubagentTaskId = LegacySubagentTaskId | Subagent2TaskId;

/** Documents the getSubagentConfig behavior. */
export function getSubagentConfig(mode: AnalysisMode): {
  taskIds: readonly SubagentTaskId[];
  prompts: Record<string, string>;
} {
  if (mode === "subagent_2_0") {
    return { taskIds: SUBAGENT_2_0_TASK_IDS, prompts: SUBAGENT_2_0_PROMPTS };
  }
  return { taskIds: LEGACY_SUBAGENT_TASK_IDS, prompts: LEGACY_SUBAGENT_PROMPTS };
}

/**
 * Build the prompt file path for a Subagent 2.0 task at a specific version.
 */
export function resolveSubagent2PromptPath(taskId: Subagent2TaskId, version: string): string {
  return `prompts/promptsubagent2.0-subagent-${taskId}-v${version}.md`;
}

/**
 * Build the prompt file path for the downstream post-call event detector.
 */
export function resolvePostCallEventDetectorPromptPath(version: string): string {
  return `prompts/promptsubagent2.0-subagent-${POST_CALL_EVENT_DETECTOR_TASK_ID}-v${version}.md`;
}

/**
 * Extract the current default version for each Subagent 2.0 task
 * by parsing the version suffix from `SUBAGENT_2_0_PROMPTS` paths.
 */
export function getSubagent2Defaults(): Record<Subagent2TaskId, string> {
  const defaults: Record<string, string> = {};
  for (const [taskId, promptPath] of Object.entries(SUBAGENT_2_0_PROMPTS)) {
    const match = promptPath.match(/-v(\d+(?:\.\d+)?)\.md$/);
    defaults[taskId] = match ? match[1] : "1";
  }
  return defaults as Record<Subagent2TaskId, string>;
}

/**
 * Aggregate pattern-detection prompt mappings.
 *
 * These prompt task ids configure the agent-level Call Analyzer v2 report path.
 * They are not per-call analysis task ids.
 */
export const AGENT_ANALYSIS_PATTERN_PROMPTS: Record<
  AgentAnalysisPatternPromptTaskId,
  string
> = {
  behavior_pattern_detector:
    "prompts/promptsubagent2.0-subagent-behavior_pattern_detector-v3.md",
  behavior_pattern_consolidator:
    "prompts/promptsubagent2.0-subagent-behavior_pattern_consolidator-v3.md",
};

/** Documents the isAgentAnalysisPatternPromptTaskId behavior. */
export function isAgentAnalysisPatternPromptTaskId(
  taskId: string
): taskId is AgentAnalysisPatternPromptTaskId {
  return (AGENT_ANALYSIS_PATTERN_PROMPT_TASK_IDS as readonly string[]).includes(taskId);
}

/** Documents the resolveAgentAnalysisPatternPromptPath behavior. */
export function resolveAgentAnalysisPatternPromptPath(
  taskId: AgentAnalysisPatternPromptTaskId,
  version: string
): string {
  return `prompts/promptsubagent2.0-subagent-${taskId}-v${version}.md`;
}

/** Documents the resolveCallActivityExtractorPromptPath behavior. */
export function resolveCallActivityExtractorPromptPath(version: string): string {
  return `prompts/promptsubagent2.0-subagent-${CALL_ACTIVITY_EXTRACTOR_TASK_ID}-v${version}.md`;
}

/** Documents the getAgentAnalysisPatternDefaults behavior. */
export function getAgentAnalysisPatternDefaults(): Record<
  AgentAnalysisPatternPromptTaskId,
  string
> {
  const defaults: Record<string, string> = {};
  for (const [taskId, promptPath] of Object.entries(AGENT_ANALYSIS_PATTERN_PROMPTS)) {
    const match = promptPath.match(/-v(\d+(?:\.\d+)?)\.md$/);
    defaults[taskId] = match ? match[1] : "1";
  }
  return defaults as Record<AgentAnalysisPatternPromptTaskId, string>;
}
/** Optional interpretation prompt; deliberately outside mandatory rubric completion tasks. */
export const CONVERSATION_METRICS_PROMPT = "prompts/promptsubagent2.0-subagent-conversation_metrics-v1.md";
/** Optional TEST audio review, deliberately outside mandatory scoring tasks. */
export const GEMINI_AUDIO_REVIEW_PROMPT = "prompts/promptsubagent2.0-subagent-gemini_audio_review-v1.md";
