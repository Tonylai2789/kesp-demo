export type ManualShortCallContactStatus =
  | 'customer_reached'
  | 'voicemail'
  | 'ivr'
  | 'silence'
  | 'wrong_number'
  | 'unknown';

export type ManualShortCallQuickEndReason =
  | 'no_answer'
  | 'voicemail'
  | 'ivr_or_automated_system'
  | 'customer_hung_up'
  | 'customer_declined'
  | 'wrong_number'
  | 'agent_ended_early'
  | 'audio_or_line_issue'
  | 'callback_or_transfer'
  | 'already_resolved'
  | 'do_not_call'
  | 'unknown';

export type ManualShortCallAgentConcern =
  | 'none'
  | 'possible_premature_end'
  | 'protocol_gap'
  | 'compliance_risk'
  | 'audio_quality_issue'
  | 'not_enough_information';

export type ManualShortCallRubricStatus = 'met' | 'missed' | 'not_observable';

export type ShortCallQualityBand = 'excellent' | 'strong' | 'developing' | 'risk' | 'not_scorable';

export type ShortCallDurationBucket = 'micro_0_30' | 'short_31_90' | 'compact_91_150';

export type ShortCallEvaluableDepth = 'low' | 'medium' | 'high';

export type ShortCallQualityState = 'Cumple' | 'No cumple' | 'No aplica' | 'No observable';
export type ShortCallQualityStatus = 'met' | 'partial' | 'missed' | 'not_applicable';
export type ShortCallScoringMode = 'binary' | 'component' | 'opportunity';

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
}

export interface ShortCallQualityScorecard {
  rubricVersion: 'short_call_quality_v1';
  totalPoints: 100;
  earnedPoints: number | null;
  scorableWeightPercent: number;
  lowConfidence: boolean;
  criteria: ShortCallQualityCriterion[];
  scoreCalibrationAudit?: Record<string, unknown>;
}

export function hasShortCallQualityScorecard(review: Pick<ManualShortCallReview, 'schemaVersion' | 'qualityScorecard'> | null | undefined): boolean {
  return review?.schemaVersion === 'manual_short_call_review_v2' &&
    review.qualityScorecard?.rubricVersion === 'short_call_quality_v1';
}

export interface ManualShortCallEvidenceItem {
  quote: string;
  speaker_label?: string | null;
  speaker_display?: string | null;
  start_seconds?: number | null;
  end_seconds?: number | null;
}

export interface ManualShortCallRubricCheck {
  id: string;
  label: string;
  status: ManualShortCallRubricStatus;
  rationale: string;
}

export interface ManualShortCallReview {
  schemaVersion: string;
  callId: string;
  analysisPipeline: 'manual_short_call_review';
  thresholdSeconds: number;
  durationSeconds: number | null;
  contactStatus: ManualShortCallContactStatus;
  quickEndReason: ManualShortCallQuickEndReason;
  startCallRubricChecks: ManualShortCallRubricCheck[];
  agentConcern: ManualShortCallAgentConcern;
  agentConcernSummary: string;
  agentConcernEvidence: ManualShortCallEvidenceItem[];
  confidenceScore: number;
  qualityScore?: number | null;
  qualityBand?: ShortCallQualityBand;
  durationBucket?: ShortCallDurationBucket;
  evaluableDepth?: ShortCallEvaluableDepth;
  qualityScorecard?: ShortCallQualityScorecard;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ManualShortCallPatternAgentStats {
  salesAgentId: string;
  salesAgentName: string;
  totalShortCalls: number;
  contactStatusCounts: Record<string, number>;
  quickEndReasonCounts: Record<string, number>;
  agentConcernCounts: Record<string, number>;
  qualityBandCounts?: Record<string, number>;
  durationBucketCounts?: Record<string, number>;
  evaluableDepthCounts?: Record<string, number>;
  scoredShortCalls?: number;
  averageQualityScore?: number | null;
  concernRate: number;
}

export interface ManualShortCallPatternSummary {
  uploadedBy: string;
  schemaVersion: string;
  totalShortCalls: number;
  agentCount: number;
  generatedAtIso: string;
  contactStatusCounts: Record<string, number>;
  quickEndReasonCounts: Record<string, number>;
  agentConcernCounts: Record<string, number>;
  qualityBandCounts?: Record<string, number>;
  durationBucketCounts?: Record<string, number>;
  evaluableDepthCounts?: Record<string, number>;
  scoredShortCalls?: number;
  averageQualityScore?: number | null;
  agentStats: ManualShortCallPatternAgentStats[];
  lastGeneratedAt?: Date;
}
