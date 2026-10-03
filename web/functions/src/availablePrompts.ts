import { onCall, HttpsError, CallableRequest } from "./demoHttps";
import * as fs from "fs";
import * as path from "path";
import { DEMO_MODEL_RATES } from "./demoPaidProviders";
import {
  AGENT_ANALYSIS_PATTERN_PROMPT_TASK_IDS,
  CALL_ACTIVITY_EXTRACTOR_PROMPT,
  CALL_ACTIVITY_PROMPT_TASK_IDS,
  DEFAULT_ANALYZER_MODEL,
  SUPPORTED_ANALYZER_MODELS,
  SUBAGENT_2_0_TASK_IDS,
  getAgentAnalysisPatternDefaults,
  getSubagent2Defaults,
  type AgentAnalysisPatternPromptTaskId,
  type CallActivityPromptTaskId,
  type Subagent2TaskId,
} from "./promptConfig";

interface AvailablePromptsResponse {
  availableVersions: Record<string, string[]>;
  defaults: Record<string, string>;
  agentAnalysisVersions: Record<string, string[]>;
  agentAnalysisDefaults: Record<string, string>;
  activityVersions: Record<string, string[]>;
  activityDefaults: Record<string, string>;
  analyzerModels: {
    available: string[];
    default: string;
  };
}

/** Documents the parsePromptVersionFromPath behavior. */
function parsePromptVersionFromPath(promptPath: string): string {
  const match = promptPath.match(/-v(\d+(?:\.\d+)?)\.md$/);
  return match ? match[1] : "1";
}

/** Sorts prompt versions by numeric segments so v6.10 sorts after v6.9. */
export function comparePromptVersions(a: string, b: string): number {
  const aParts = a
    .split(".")
    .map(/** Handles the callback for this operation. */(part) => Number.parseInt(part, 10));
  const bParts = b
    .split(".")
    .map(/** Handles the callback for this operation. */(part) => Number.parseInt(part, 10));
  const length = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < length; index += 1) {
    const rawAPart = aParts[index] ?? 0;
    const rawBPart = bParts[index] ?? 0;
    const aPart = Number.isFinite(rawAPart) ? rawAPart : 0;
    const bPart = Number.isFinite(rawBPart) ? rawBPart : 0;
    if (aPart !== bPart) return aPart - bPart;
  }

  return 0;
}

/**
 * Scans the bundled `lib/prompts/` directory for Subagent 2.0 prompt files
 * and returns available versions per subagent, plus current defaults.
 */
export const getAvailablePrompts = onCall(
  /** Handles the callback for this operation. */
  async (request: CallableRequest): Promise<AvailablePromptsResponse> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const promptsDir = path.join(__dirname, "prompts");

    let files: string[];
    try {
      files = fs.readdirSync(promptsDir);
    } catch {
      throw new HttpsError(
        "internal",
        "Unable to read prompts directory"
      );
    }

    // Match Subagent 2.0 runtime prompt files with explicit version suffix
    // e.g. promptsubagent2.0-subagent-rubric_analysis_A-v3.md
    const pattern = /^promptsubagent2\.0-subagent-(.+)-v(\d+(?:\.\d+)?)\.md$/;

    const availableVersions: Record<string, string[]> = {};
    const agentAnalysisVersions: Record<string, string[]> = {};
    const activityVersions: Record<string, string[]> = {};

    // Initialise all known task IDs with empty arrays
    for (const taskId of SUBAGENT_2_0_TASK_IDS) {
      availableVersions[taskId] = [];
    }
    for (const taskId of AGENT_ANALYSIS_PATTERN_PROMPT_TASK_IDS) {
      agentAnalysisVersions[taskId] = [];
    }
    for (const taskId of CALL_ACTIVITY_PROMPT_TASK_IDS) {
      activityVersions[taskId] = [];
    }

    for (const file of files) {
      const match = file.match(pattern);
      if (!match) continue;

      const subagentName = match[1];
      const version = match[2];

      // Only include versions for known Subagent 2.0 task IDs
      if (SUBAGENT_2_0_TASK_IDS.includes(subagentName as Subagent2TaskId)) {
        if (!availableVersions[subagentName]) {
          availableVersions[subagentName] = [];
        }
        availableVersions[subagentName].push(version);
        continue;
      }

      if (
        AGENT_ANALYSIS_PATTERN_PROMPT_TASK_IDS.includes(
          subagentName as AgentAnalysisPatternPromptTaskId
        )
      ) {
        agentAnalysisVersions[subagentName].push(version);
        continue;
      }

      if (CALL_ACTIVITY_PROMPT_TASK_IDS.includes(subagentName as CallActivityPromptTaskId)) {
        activityVersions[subagentName].push(version);
      }
    }

    // Sort versions numerically
    for (const taskId of Object.keys(availableVersions)) {
      availableVersions[taskId].sort(comparePromptVersions);
    }
    for (const taskId of Object.keys(agentAnalysisVersions)) {
      agentAnalysisVersions[taskId].sort(comparePromptVersions);
    }
    for (const taskId of Object.keys(activityVersions)) {
      activityVersions[taskId].sort(comparePromptVersions);
    }

    const defaults = getSubagent2Defaults();
    const agentAnalysisDefaults = getAgentAnalysisPatternDefaults();
    const activityDefaults: Record<CallActivityPromptTaskId, string> = {
      call_activity_extractor: parsePromptVersionFromPath(CALL_ACTIVITY_EXTRACTOR_PROMPT),
    };

    return {
      availableVersions,
      defaults,
      agentAnalysisVersions,
      agentAnalysisDefaults,
      activityVersions,
      activityDefaults,
      analyzerModels: {
        available: SUPPORTED_ANALYZER_MODELS.filter(model => Object.hasOwn(DEMO_MODEL_RATES, model)),
        default: DEFAULT_ANALYZER_MODEL,
      },
    };
  }
);
