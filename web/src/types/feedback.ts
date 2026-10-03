import type { CallCategory } from './call';

export type LegacySeverity = "critical" | "moderate" | "minor";
export type Subagent2Severity =
  | "severe"
  | "moderate-severe"
  | "moderate"
  | "moderate-minor"
  | "minor";
export type Severity = LegacySeverity | Subagent2Severity;
export type FeedbackCategory = "rubric" | "conversational";
export type PerformanceTier = "excellent" | "good" | "needs_improvement" | "poor";
export type LoanStatus = "yes" | "no" | "in_progress" | "unclear";

// ── V5 structured evidence & breakdown types ────────────────────────────────

/** Machine-readable evidence item from v5 prompt output */
export interface EvidenceItem {
  quote: string;
  speaker_label?: string;
  speaker_display?: string;
}

/** Check within a binary or component breakdown */
export interface BreakdownCheck {
  id: string;
  label: string;
  weight: number;
  passed: boolean;
  evidence?: EvidenceItem[];
}

/** Event within an opportunity breakdown */
export interface BreakdownEvent {
  event_id: string;
  label: string;
  score: number;
  evidence?: EvidenceItem[];
}

/** Deterministic scoring breakdown (v5) */
export type Breakdown =
  | { mode: "binary"; checks: BreakdownCheck[] }
  | { mode: "component"; checks: BreakdownCheck[] }
  | { mode: "opportunity"; aggregation: string; events: BreakdownEvent[] };

// ── Subagent 2.0 rubric types ──────────────────────────────────────────────

/** Status values produced by v2 rubric-analysis subagents */
export type RubricV2Status = "Cumple" | "No cumple" | "No aplica" | "No observable";

/** Leaf level of the v2 rubric: an individual evaluation criterion (e.g. A1.1) */
export interface RubricV2Criterion {
  id: string;
  title: string;
  weight_percent: number;
  max_points: number;
  earned_points: number;
  status: RubricV2Status;
  score_level?: 0 | 1 | 2 | null;
  justification: string;
  good_critiques: GoodCritique[];
  bad_critiques: BadCritique[];
  criterion_improvement_tip: string | null;
  // ── v5 fields (optional for backward compat with v4 docs) ──
  state?: RubricV2Status;
  credit?: number | null;
  scoring_mode?: string;
  breakdown?: Breakdown;
  evidence?: EvidenceItem[];
}

/** Middle level of the v2 rubric: a group of criteria (e.g. A1 "Apertura y encuadre") */
export interface RubricV2Group {
  id: string;
  title: string;
  weight_percent: number;
  max_points: number;
  earned_points: number;
  criteria: RubricV2Criterion[];
}

/** Top level of the v2 rubric: a section (e.g. A "Apertura & Profesionalismo") */
export interface RubricV2Section {
  id: string;
  title: string;
  weight_percent: number;
  max_points: number;
  earned_points: number;
  groups: RubricV2Group[];
}

/** Complete v2 rubric scorecard */
export interface RubricScorecardV2 {
  rubric_version: string;
  total_points: number;
  earned_points: number;
  sections: RubricV2Section[];
  // ── v5 fields ──
  scorable_weight_percent?: number;
  low_confidence?: boolean;
}

// ── Legacy TMK rubric types ────────────────────────────────────────────────

// Rubric reference for linking feedback to specific rubric clauses
export interface RubricRef {
  section_path: string;      // e.g., "Estándar TMK Interno > Habilidades Blandas > Habilidades verbales"
  subsection_text: string;   // Exact clause text from rubric (for highlighting in PDF)
}

// Per-subsection critique types (v5.8+ strengths, v5.9+ weaknesses)
export interface GoodCritique {
  title: string;
  detail: string;
  category: FeedbackCategory;
  evidence?: EvidenceItem[];
}

export interface BadCritique {
  title: string;
  detail: string;
  severity: Severity;
  category: FeedbackCategory;
  weakness_improvement_tip: string;
  evidence?: EvidenceItem[];
}

// Rubric scorecard structures for weighted score breakdown
export interface RubricScorecardSubsection {
  title: string;
  weight_percent: number;
  max_points: number;
  earned_points: number;
  rubric_ref: RubricRef;
  justification: string;     // Spanish, 1-2 sentences explaining the score
  // Per-subsection critiques (optional for backward compat with older feedback docs)
  good_critiques?: GoodCritique[];
  bad_critiques?: BadCritique[];
  subsection_improvement_tip?: string;
}

export interface RubricScorecardSection {
  title: string;             // "Habilidades Blandas" | "Gestión de Procesos" | "Estrategia Comercial" | "Nivel de Servicio"
  weight_percent: number;
  max_points: number;
  earned_points: number;
  rubric_ref: RubricRef;
  subsections: RubricScorecardSubsection[];
}

export interface RubricScorecard {
  total_points: number;      // Always 100
  earned_points: number;     // Must equal overall_score
  sections: RubricScorecardSection[];
}

export interface FeedbackItem {
  title: string;
  detail: string;
  category?: FeedbackCategory;
  rubric_ref?: RubricRef;    // Reference to rubric clause (optional for backward compatibility)
  evidence?: EvidenceItem[];
}

export interface LocalizedString {
  es: string;
  en: string;
}

export interface MentorshipTipPlan {
  skill: LocalizedString;
  whenToUseIt?: LocalizedString | null;
  examplePhrase?: LocalizedString | null;
  whyItWorks?: LocalizedString | null;
}

export interface WeaknessActionPlan {
  weaknessTitle: string;
  weaknessDetail?: string | null;
  whatWentWrong: LocalizedString;
  whenItHappened?: LocalizedString | null;
  whyItHurts?: LocalizedString | null;
  whatToChangeNextCall: LocalizedString;
  whatToSayNext: LocalizedString[];
  whatToTrain: LocalizedString[];
  mentorshipTips: MentorshipTipPlan[];
}

export interface CallSynopsisPlan {
  primaryWeaknessTitle: string;
  whatWentWrong: LocalizedString;
  whatToDoDifferently: LocalizedString;
  whatToSay: LocalizedString;
  whatToTrain: LocalizedString;
}

export interface ManagementActionPlanV1 {
  summary?: LocalizedString | null;
  nextActionSummary?: LocalizedString | null;
  phraseBankPreview: LocalizedString[];
  trainingFocus: LocalizedString[];
  weaknessPlans: WeaknessActionPlan[];
  callSynopsis?: CallSynopsisPlan | null;
}

export interface WeaknessItem extends FeedbackItem {
  severity: Severity;
  weakness_improvement_tip?: string; // Optional for backward compatibility with older feedback docs
}

export interface Feedback {
  call_id: string;
  call_category: CallCategory;
  agent_speaker: string;
  customer_speaker: string;
  agent_name?: string | null;
  customer_name?: string | null;
  loan_completed: LoanStatus;
  overall_score: number;
  performance_tier: PerformanceTier;
  rubric_scorecard?: RubricScorecard;       // Legacy TMK — null for v2 docs
  rubric_scorecard_v2?: RubricScorecardV2;  // Subagent 2.0 — absent for legacy docs
  agent_strengths: FeedbackItem[];
  agent_weaknesses: WeaknessItem[];
  management_action_v1?: ManagementActionPlanV1 | null;
  suggested_followup_message: string | null;
  mentorship_tip?: string | null;
  low_confidence?: boolean;
}
