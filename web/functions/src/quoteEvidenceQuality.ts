import { privatePolicyUnavailable } from "./privatePolicy";

export const QUOTE_EVIDENCE_QUALITY_TARGET_PASS_RATE: number | undefined = undefined;

export type QuoteEvidenceIssueSeverity = "hard" | "soft";

export type QuoteEvidenceIssueCode =
  | "EVIDENCE_EMPTY_QUOTE_DROPPED"
  | "EVIDENCE_ELLIPSIS_QUOTE_DROPPED"
  | "EVIDENCE_QUOTE_NOT_FOUND_DROPPED"
  | "EVIDENCE_QUOTE_REPLACED_WITH_EXACT_TURN"
  | "EVIDENCE_OVERLONG_QUOTE_REPLACED_WITH_COMPACT_SPAN"
  | "EVIDENCE_SPEAKER_LABEL_REPAIRED"
  | "EVIDENCE_LOW_SIGNAL_QUOTE_DROPPED"
  | "EVIDENCE_LOW_SIGNAL_QUOTE"
  | "EVIDENCE_OVERLONG_QUOTE"
  | "CRITERION_EVIDENCE_PATTERN_GAP";

export type EvidenceQualityIssue = {
  code: QuoteEvidenceIssueCode;
  criterionId: string;
  context: string;
  severity: QuoteEvidenceIssueSeverity;
  quote?: string;
  message: string;
};

export type EvidenceQualityMetrics = {
  total: number;
  accepted: number;
  hardDropped: number;
  repaired: number;
  softIssues: number;
  passRate: number;
};

type EvidenceItem = {
  quote?: unknown;
  speaker_label?: unknown;
  speaker_display?: unknown;
  [key: string]: unknown;
};

export function normalizeQuoteEvidenceText(value: unknown): string {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

export function summarizeEvidenceQuality(metrics: EvidenceQualityMetrics[]): EvidenceQualityMetrics {
  const total = metrics.reduce((sum, metric) => sum + metric.total, 0);
  const accepted = metrics.reduce((sum, metric) => sum + metric.accepted, 0);
  return {
    total,
    accepted,
    hardDropped: metrics.reduce((sum, metric) => sum + metric.hardDropped, 0),
    repaired: metrics.reduce((sum, metric) => sum + metric.repaired, 0),
    softIssues: metrics.reduce((sum, metric) => sum + metric.softIssues, 0),
    passRate: total > 0 ? accepted / total : 1,
  };
}

export function hasExplicitPressureMarker(_value: unknown): boolean {
  void _value;
  return privatePolicyUnavailable();
}

export function sanitizeEvidenceForTranscript(_params: {
  evidence: unknown;
  transcript?: unknown;
  criterionId: string;
  context: string;
}): { evidence: EvidenceItem[]; issues: EvidenceQualityIssue[]; metrics: EvidenceQualityMetrics } {
  void _params;
  return privatePolicyUnavailable();
}

export function evaluateCriterionEvidencePattern(_params: {
  criterionId: string;
  state: string;
  evidence: unknown;
  agentSpeaker: string;
  customerSpeaker: string;
}): EvidenceQualityIssue[] {
  void _params;
  return privatePolicyUnavailable();
}
