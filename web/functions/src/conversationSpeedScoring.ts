import { privatePolicyUnavailable } from "./privatePolicy";

export interface ConversationSpeedEvidence {
  availability: { speed: { available: boolean } };
  summary: { fastSegmentCount: number | null };
}

export interface ConversationSpeedCriterion {
  criterion_id?: string;
  state?: string;
  status?: string;
  credit?: number | null;
}

export interface ConversationSpeedAdjustment {
  criterionId: "A2.2";
  ruleVersion: "a2_2_speed_v1";
  evidenceMethod: "timestamp_wpm_v1";
  thresholdWpm: number;
  baseCredit: number | null;
  deduction: number;
  finalCredit: number | null;
  reason: "adjusted" | "unavailable" | "no_fast_segments" | "excluded" | "invalid_credit";
}

/** Contract only: private speed-to-score policy is not distributed. */
export function applyConversationSpeedScoring<T extends ConversationSpeedCriterion>(
  _baseCriteria: readonly T[],
  _evidence?: ConversationSpeedEvidence | null
): { criteria: T[]; adjustment: ConversationSpeedAdjustment | null } {
  void _baseCriteria;
  void _evidence;
  return privatePolicyUnavailable();
}
