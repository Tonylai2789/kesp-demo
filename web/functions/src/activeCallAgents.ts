import { createHash } from "crypto";

export interface ActiveCallAgentDefinition {
  displayName: string;
  aliases: string[];
  profileKey: string;
  salesAgentId: string;
  normalizedName: string;
  normalizedAliases: string[];
  tokens: string[];
  aliasTokens: string[][];
}

export interface AgentNameMatchCandidate {
  profileKey: string;
  displayName: string;
  salesAgentId: string;
  score: number;
  matchedTokenCount: number;
  distinctiveTokenCount: number;
}

export type AgentNameMatchReason =
  | "matched"
  | "no_agent_name_extracted"
  | "no_matching_active_agent"
  | "ambiguous_active_agent_match"
  | "low_confidence_agent_name_match";

export interface AgentNameMatchResult {
  status: "matched" | "unrecognized";
  reason: AgentNameMatchReason;
  extractedName: string | null;
  normalizedName: string | null;
  matchedAgent?: ActiveCallAgentDefinition;
  confidence: number;
  method: "normalized_exact" | "deterministic_fuzzy" | "none";
  candidates: AgentNameMatchCandidate[];
}

// The isolated demo never ships or seeds a bank roster.
export const ACTIVE_CALL_AGENT_SOURCE = "demo_existing_profiles";
export const ACTIVE_CALL_AGENT_NAMES: string[] = [];
export const ACTIVE_CALL_AGENTS: ActiveCallAgentDefinition[] = [];

export function normalizeAgentNameForMatching(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function tokenizeNormalizedAgentName(value: string): string[] {
  return value.split(" ").filter((token) => token.length > 0);
}

export function buildActiveAgentProfileKey(displayName: string): string {
  return normalizeAgentNameForMatching(displayName).replace(/\s+/g, "-");
}

export function buildSeededSalesAgentId(profileKey: string): string {
  return `active_agent_${profileKey}`;
}

export function buildSeededAgentAnalysisId(uploadedBy: string, profileKey: string): string {
  const ownerHash = createHash("sha256").update(uploadedBy).digest("hex").slice(0, 12);
  return `active_agent_${ownerHash}_${profileKey}`;
}

/** Matches only one exact normalized name from server-loaded demo profiles. */
export function matchActiveAgentName(
  extractedName: unknown,
  agents: readonly ActiveCallAgentDefinition[] = ACTIVE_CALL_AGENTS
): AgentNameMatchResult {
  const rawName = typeof extractedName === "string" ? extractedName.trim() : "";
  const normalizedName = normalizeAgentNameForMatching(rawName);
  const matches = normalizedName
    ? agents.filter((agent) => agent.normalizedName === normalizedName)
    : [];
  const matchedAgent = matches.length === 1 ? matches[0] : undefined;
  return {
    status: matchedAgent ? "matched" : "unrecognized",
    reason: matchedAgent ? "matched" : !normalizedName
      ? "no_agent_name_extracted" : matches.length > 1
        ? "ambiguous_active_agent_match" : "no_matching_active_agent",
    extractedName: rawName || null,
    normalizedName: normalizedName || null,
    ...(matchedAgent ? { matchedAgent } : {}),
    confidence: matchedAgent ? 1 : 0,
    method: matchedAgent ? "normalized_exact" : "none",
    candidates: matches.slice(0, 5).map((agent) => ({
      profileKey: agent.profileKey,
      displayName: agent.displayName,
      salesAgentId: agent.salesAgentId,
      score: 1,
      matchedTokenCount: agent.tokens.length,
      distinctiveTokenCount: 0,
    })),
  };
}
