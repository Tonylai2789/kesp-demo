import { privatePolicyUnavailable } from "./privatePolicy";

export const SHORT_CALL_QUALITY_RUBRIC_VERSION = "short_call_quality_v1";

export type ShortCallQualityBand =
  | "excellent"
  | "strong"
  | "developing"
  | "risk"
  | "not_scorable";

export type ShortCallDurationBucket = "micro_0_30" | "short_31_90" | "compact_91_150";

export type ShortCallEvaluableDepth = "low" | "medium" | "high";

export type ShortCallQualityState = "Cumple" | "No cumple" | "No aplica" | "No observable";

export type ShortCallQualityStatus = "met" | "partial" | "missed" | "not_applicable";

export type ShortCallScoringMode = "binary" | "component" | "opportunity";

export interface ShortCallQualityEvidenceItem {
  quote: string;
  speaker_label?: string | null;
  speaker_display?: string | null;
  start_seconds?: number | null;
  end_seconds?: number | null;
}

export interface ShortCallQualityCriterion {
  id: string;
  label: string;
  maxPoints: number;
  credit: number | null;
  earnedPoints: number;
  status: ShortCallQualityStatus;
  state: ShortCallQualityState;
  scoringMode: ShortCallScoringMode;
  breakdown: Record<string, unknown>;
  rationale: string;
  evidence: ShortCallQualityEvidenceItem[];
  repairAudit?: Array<Record<string, unknown>>;
  applicabilityAudit?: Record<string, unknown>;
}

export interface ShortCallQualityScorecard {
  rubricVersion: typeof SHORT_CALL_QUALITY_RUBRIC_VERSION;
  totalPoints: 100;
  earnedPoints: number | null;
  scorableWeightPercent: number;
  lowConfidence: boolean;
  criteria: ShortCallQualityCriterion[];
  scoreCalibrationAudit?: Record<string, unknown>;
}

export interface ShortCallQualityResult {
  qualityScore: number | null;
  qualityBand: ShortCallQualityBand;
  durationBucket: ShortCallDurationBucket;
  evaluableDepth: ShortCallEvaluableDepth;
  qualityScorecard: ShortCallQualityScorecard;
}

export function durationBucketForSeconds(durationSeconds: number | null): ShortCallDurationBucket {
  void durationSeconds;
  return privatePolicyUnavailable();
}

export function buildShortCallQualityResult(params: {
  durationSeconds: number | null;
  contactStatus: string;
  agentConcern: string;
  rawCriteria: unknown;
}): ShortCallQualityResult {
  void params;
  return privatePolicyUnavailable();
}
