import { privatePolicyUnavailable } from "./privatePolicy";

export type CreditValidationIssueCode =
  | "EMPTY_EVENTS_NOT_APPLICABLE"
  | "CREDIT_BREAKDOWN_MISMATCH"
  | "THRESHOLD_STATE_MISMATCH"
  | "MALFORMED_BREAKDOWN_REPAIRED"
  | "MISSING_EVIDENCE"
  | "EVIDENCE_PROMOTED_FROM_BREAKDOWN"
  | "EVIDENCE_EMPTY_QUOTE_DROPPED"
  | "EVIDENCE_ELLIPSIS_QUOTE_DROPPED"
  | "EVIDENCE_QUOTE_NOT_FOUND_DROPPED"
  | "EVIDENCE_QUOTE_REPLACED_WITH_EXACT_TURN"
  | "EVIDENCE_OVERLONG_QUOTE_REPLACED_WITH_COMPACT_SPAN"
  | "EVIDENCE_SPEAKER_LABEL_REPAIRED"
  | "EVIDENCE_LOW_SIGNAL_QUOTE_DROPPED"
  | "EVIDENCE_LOW_SIGNAL_QUOTE"
  | "EVIDENCE_OVERLONG_QUOTE"
  | "CRITERION_EVIDENCE_PATTERN_GAP"
  | "CRITERION_STATE_CREDIT_INTEGRITY_REPAIRED"
  | "TRANSCRIPT_LEDGER_SCORED_CRITERION"
  | "TRANSCRIPT_REPAIRED_C5_1"
  | "TRANSCRIPT_REPAIRED_A1_1_ALIAS"
  | "TRANSCRIPT_REPAIRED_A1_1_DELAYED_NAME"
  | "TRANSCRIPT_REPAIRED_B3_1_FALSE_POSITIVE"
  | "TRANSCRIPT_REPAIRED_C2_1_GENERIC_FALSE_POSITIVE"
  | "TRANSCRIPT_REPAIRED_C3_1_WEAK_OBJECTION_HANDLING"
  | "TRANSCRIPT_REPAIRED_D2_1_FALSE_POSITIVE"
  | "TRANSCRIPT_REPAIRED_D2_1_ABSOLUTE_CLAIM"
  | "TRANSCRIPT_REPAIRED_C1_1_DISCOVERY_UNDERCREDIT"
  | "TRANSCRIPT_REPAIRED_C2_1_ADAPTATION_UNDERCREDIT"
  | "TRANSCRIPT_REPAIRED_B2_2_SOFT_NEXT_STEP_PARTIAL"
  | "TRANSCRIPT_REPAIRED_C4_1_DETERMINISTIC_ADVANCE"
  | "TRANSCRIPT_REPAIRED_C5_1_SOFT_NEXT_STEP_PARTIAL"
  | "TRANSCRIPT_REPAIRED_C5_1_FALSE_POSITIVE"
  | "TRANSCRIPT_REPAIRED_D3_1_FALSE_POSITIVE";

export interface CreditValidationIssue {
  code: CreditValidationIssueCode;
  criterionId: string;
  message: string;
}

/** Contract only: private criterion evaluation and repair policy is not distributed. */
export function validateAndRepairCriterionResult(_params: {
  callId: string;
  transcript?: any;
  transcriptLedger?: unknown;
  criterionResult: any;
  agentSpeaker?: string;
  customerSpeaker?: string;
}): { criterionResult: any; issues: CreditValidationIssue[] } {
  void _params;
  return privatePolicyUnavailable();
}

/** Contract only: never silently accept or fabricate rubric results. */
export function validateAndRepairRubricCriteriaResults(_params: {
  callId: string;
  transcript?: any;
  criteriaResults: any[];
  agentSpeaker?: string;
  customerSpeaker?: string;
}): { criteriaResults: any[]; issues: CreditValidationIssue[] } {
  void _params;
  return privatePolicyUnavailable();
}
