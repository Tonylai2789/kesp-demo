import type { EvidenceItem, PerformanceTier } from './feedback';

export type WeaknessSeverityBin =
  | 'minor'
  | 'moderate-minor'
  | 'moderate'
  | 'moderate-severe'
  | 'severe';

export type WeaknessSummaryDepth =
  | 'very-concise'
  | 'concise'
  | 'balanced'
  | 'detailed'
  | 'comprehensive';

export type AgentAnalysisStatus = 'ready' | 'analyzing' | 'complete' | 'error';
export type AgentAnalysisRunStatus = 'pending' | 'running' | 'complete' | 'error';

export interface WeaknessOccurrence {
  occurrenceId: string;
  callId: string;
  feedbackId: string;
  criterionId: string;
  criterionTitle: string;
  critiqueTitle: string;
  critiqueDetail: string;
  severity: WeaknessSeverityBin;
  evidence: EvidenceItem[];
  criterionImprovementTip: string | null;
  weaknessImprovementTip: string | null;
}

export interface WeaknessGroup {
  groupId: string;
  criterionId: string;
  criterionTitle: string;
  affectedCallCount: number;
  occurrenceCount: number;
  critiqueCandidates: Array<{ title: string; detail: string; callId: string }>;
  evidencePool: Array<{
    callId: string;
    quote: string;
    speakerLabel?: string;
    speakerDisplay?: string;
  }>;
  mentorshipTipCandidates: string[];
}

export interface SummarizedWeakness {
  summaryId: string;
  sourceGroupIds: string[];
  critique: {
    headline: string;
    summary: string;
    affectedCallCount: number;
    occurrenceCount: number;
  };
  evidence: Array<{
    callId: string;
    quote: string;
    speakerLabel?: string | null;
    speakerDisplay?: string | null;
  }>;
  mentorshipTips: Array<{
    tip: string;
    priority?: 'primary' | 'secondary';
  }>;
}

export interface SeverityBinOverflowSummary {
  critique: string;
  evidence: Array<{ callId: string; quote: string }>;
  mentorshipTips: Array<{ tip: string }>;
}

export interface SeverityBinReport {
  summaryDepth: WeaknessSummaryDepth;
  summarizedWeaknesses: SummarizedWeakness[];
  overflowSummary: SeverityBinOverflowSummary | null;
}

export interface AgentAnalysisCoverage {
  sourceCallCount: number;
  eligibleCallCount: number;
  skippedCallCount: number;
}

export interface AgentAnalysisProcessingConfig {
  analyzerModel?: string;
  promptVersions?: Record<string, string>;
}

export interface AgentAnalysisRunTask {
  taskId: string;
  taskType?: string;
  promptTaskId?: string;
  status: AgentAnalysisRunStatus;
  promptPath?: string;
  model?: string | null;
  inputPayload?: unknown;
  output?: unknown;
  error?: string | null;
  attempts?: number;
  createdAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface AgentAnalysisRun {
  runId: string;
  status: AgentAnalysisRunStatus;
  sourceCallCount: number;
  eligibleCallCount: number;
  skippedCallCount: number;
  taskCount: number;
  completedTaskCount: number;
  skipReasons?: Record<string, number>;
  usedPromptFamily?: string;
  createdAt?: Date;
  completedAt?: Date;
}

export interface LegacyAgentAnalysisReport {
  reportId: string;
  schemaVersion: '1';
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  sourceCallIds: string[];
  coverage: AgentAnalysisCoverage;
  severityBins: Partial<Record<WeaknessSeverityBin, SeverityBinReport>>;
  primaryWeaknessOrder: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface BehaviorSignal {
  signalId: string;
  callId: string;
  feedbackId: string;
  criterionId: string;
  criterionTitle: string;
  rubricDomain: 'A' | 'B' | 'C' | 'D';
  critiqueTitle: string;
  critiqueDetail: string;
  severity: WeaknessSeverityBin;
  criterionCredit: number | null;
  evidence: EvidenceItem[];
  criterionImprovementTip: string | null;
  weaknessImprovementTip: string | null;
  overallScore: number | null;
  performanceTier: PerformanceTier | null;
}

export interface BehaviorPatternEvidence {
  callId: string;
  quote: string;
  speakerLabel?: string | null;
  speakerDisplay?: string | null;
}

export interface BehaviorPatternExample {
  exampleId: string;
  callId: string;
  observedFragment: string;
  context: string;
  whyItIsWrong: string;
  whatShouldHaveDone: string;
  whyItHelps?: string;
  avoid: string;
  nextStep: string;
}

export interface BehaviorPatternExecutionGuide {
  whenToUse?: string;
  sayThis?: string;
  whyItWorks?: string;
  avoidThis?: string;
  nextStep?: string;
}

export interface BehaviorPattern {
  patternId: string;
  patternName: string;
  seenInCallCount: number;
  totalCallCount: number;
  priorityScore: number;
  behaviorSummary: string;
  whenItHappens: string;
  businessImpact: string;
  rootCause: string;
  coachingFocus: string;
  mentorshipTips: Array<{
    tip: string;
    priority?: 'primary' | 'secondary';
  }>;
  executionGuide?: BehaviorPatternExecutionGuide;
  supportingEvidence: BehaviorPatternEvidence[];
  examples: BehaviorPatternExample[];
  relatedSignalIds: string[];
  relatedCriterionIds: string[];
  severityDistribution: Partial<Record<WeaknessSeverityBin, number>>;
  sourceCallIds?: string[];
}

export interface AgentAnalysisReportV2 {
  reportId: string;
  schemaVersion: '2';
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  sourceCallIds: string[];
  coverage: AgentAnalysisCoverage;
  patterns: BehaviorPattern[];
  patternOrder: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export type AgentAnalysisReport = LegacyAgentAnalysisReport | AgentAnalysisReportV2;

export interface AgentAnalysis {
  id: string;
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  organizationId?: string;
  organizationName?: string;
  visibilityScope?: 'organization' | 'user';
  profileSource?: string;
  isCccCanonicalProfile?: boolean;
  cccAgentMappingId?: string;
  accountNumber?: string;
  cccUserId?: string;
  cccUsername?: string | null;
  supervisorName?: string | null;
  isActiveAgentProfile?: boolean;
  activeAgentProfileKey?: string;
  activeAgentSource?: string;
  activeAgentDisplayName?: string;
  seededAt?: Date;
  callProcessingConfig?: AgentAnalysisProcessingConfig;
  reportProcessingConfig?: AgentAnalysisProcessingConfig;
  status: AgentAnalysisStatus;
  activeRunId?: string;
  latestRunId?: string;
  latestReportId?: string;
  analysisStartedAt?: Date;
  analysisCompletedAt?: Date;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
