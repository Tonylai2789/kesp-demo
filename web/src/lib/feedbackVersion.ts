import type { Feedback } from '@/types';

export type FeedbackVersion = "v2" | "legacy_tmk" | "none";

/**
 * Detects whether a feedback document uses the Subagent 2.0 rubric structure,
 * the legacy TMK rubric, or has no scorecard data at all.
 */
export function detectFeedbackVersion(feedback: Feedback | null | undefined): FeedbackVersion {
  if (!feedback) return "none";
  const rv = feedback.rubric_scorecard_v2?.rubric_version;
  if (
    rv === "subagent_2.0" ||
    rv === "subagent_2.0_v5" ||
    rv === "subagent_2.0_v6" ||
    rv === "subagent_2.0_v6_1" ||
    rv === "subagent_2.0_v6_2" ||
    rv === "subagent_2.0_v6_3"
  ) {
    return "v2";
  }
  if (feedback.rubric_scorecard) return "legacy_tmk";
  return "none";
}

/**
 * Returns true when the feedback uses the structured Subagent 2.0 credit-based contract.
 */
export function isSubagent2CreditFeedback(feedback: Feedback | null | undefined): boolean {
  const version = feedback?.rubric_scorecard_v2?.rubric_version;
  return (
    version === "subagent_2.0_v5" ||
    version === "subagent_2.0_v6" ||
    version === "subagent_2.0_v6_1" ||
    version === "subagent_2.0_v6_2" ||
    version === "subagent_2.0_v6_3"
  );
}
