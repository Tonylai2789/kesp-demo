/** Backend-owned comparison jobs must never contribute to agent portfolios or shared cached analysis. */
export function isTranscriptionComparisonCall(call: Record<string, unknown> | null | undefined): boolean {
  return call?.transcriptionComparison === true;
}

/** Preserve existing profile exclusions while independently protecting the trusted comparison flag. */
export function isAgentProfileCallExcluded(call: Record<string, unknown> | null | undefined): boolean {
  return call?.agentProfileExcluded === true || isTranscriptionComparisonCall(call);
}
