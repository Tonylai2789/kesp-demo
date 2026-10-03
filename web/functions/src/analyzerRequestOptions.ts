/** Uses low reasoning for the new analyzers; null preserves an omitted legacy temperature. */
export function analyzerRequestOptions(
  model: string,
  legacyTemperature: number | null = 0
): { temperature?: number; reasoning_effort?: "low" } {
  if (model === "gpt-5.6-terra" || model === "gpt-5.6-sol" || model === "gpt-6-astra") {
    return { reasoning_effort: "low" };
  }
  return legacyTemperature === null ? {} : { temperature: legacyTemperature };
}
