export type CallOutcome =
  | 'success'
  | 'follow_up_needed'
  | 'failure'
  | 'in_progress'
  | 'no_contact'
  | 'unclear';

export type ReminderState = 'open' | 'done' | 'closed' | 'superseded';
export type ReminderPrecision =
  | 'exact_datetime'
  | 'date_only'
  | 'time_range'
  | 'condition_based'
  | 'unscheduled';
export type LoanLifecycleStage =
  | 'not_sold'
  | 'future_follow_up'
  | 'sold_pending_follow_through'
  | 'fully_completed'
  | 'lost_cancelled'
  | 'unknown';
export type ReminderTaskType =
  | 'call_back'
  | 'send_whatsapp'
  | 'send_info'
  | 'collect_documents'
  | 'confirm_payment'
  | 'wait_for_customer'
  | 'other';
export type ReminderChannel = 'call' | 'whatsapp' | 'sms' | 'email' | 'unknown';
export type LifecycleStageSource =
  | 'ai_inferred'
  | 'manual_confirmed'
  | 'manual_cancelled'
  | 'manual_pending'
  | 'system_resolved';

export interface ManualReminderInput {
  needsFollowUp: boolean;
  nextAction?: string | null;
  followUpDate?: string | null;
  followUpTime?: string | null;
  note?: string | null;
}

export interface AgentCallSnapshot {
  id: string;
  sourceCallId: string;
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  agentKey: string;
  latestFeedbackId: string;
  feedbackSchemaVersion: string;
  analyzerModel: string;
  environmentTarget?: 'test' | 'prod';
  callName?: string | null;
  callOccurredAtMs: number;
  callOccurredAtIso: string;
  callOccurredAt?: Date;
  callOccurredAtSource: string;
  bucketDay: string;
  bucketWeek: string;
  bucketMonth: string;
  agentName?: string | null;
  customerName?: string | null;
  clientKey: string;
  clientKeyConfidence: 'high' | 'low';
  caseId?: string | null;
  callOutcome: CallOutcome;
  loanCompleted: 'yes' | 'no' | 'in_progress' | 'unclear';
  saleReachedOnCall?: boolean;
  inferredLifecycleStage?: LoanLifecycleStage;
  effectiveLifecycleStage?: LoanLifecycleStage;
  lifecycleStageSource?: LifecycleStageSource;
  loanAmount?: number | null;
  currency?: string | null;
  saleDate?: string | null;
  followUpNeeded: boolean;
  reminderTaskType?: ReminderTaskType | null;
  reminderChannel?: ReminderChannel | null;
  nextAction?: string | null;
  followUpDate?: string | null;
  followUpTime?: string | null;
  followUpTimeRange?: string | null;
  followUpReason?: string | null;
  followUpNotes?: string | null;
  clientCallbackCondition?: string | null;
  confidenceScore?: number | null;
  lastCallSummary?: string | null;
  nextBestAction?: string | null;
  whatAgentShouldSayNext?: string | null;
  reminderOrigin?: 'ai_transcript' | 'manual_first_call' | 'manual_and_ai' | null;
  reminderPrecision?: ReminderPrecision | null;
  reminderSortKey?: string | null;
  suggestedFollowupMessage?: string | null;
  overallScore?: number | null;
  lowConfidence?: boolean;
  performanceTier?: string | null;
  callCategory?: string | null;
  strengthTitles: string[];
  weaknessTitles: string[];
  weaknessSeverities: string[];
  manualReminderInput?: ManualReminderInput | null;
  activityExtraction?: Record<string, unknown> | null;
  snapshotFingerprint: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AgentReminder {
  id: string;
  reminderId: string;
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  agentKey: string;
  clientKey: string;
  clientKeyConfidence: 'high' | 'low';
  customerName?: string | null;
  sourceCallId: string;
  caseId?: string | null;
  callOutcome: CallOutcome;
  loanCompleted: 'yes' | 'no' | 'in_progress' | 'unclear';
  lifecycleStage?: LoanLifecycleStage;
  lifecycleStageSource?: LifecycleStageSource;
  origin: 'ai_transcript' | 'manual_first_call' | 'manual_and_ai';
  state: ReminderState;
  precision: ReminderPrecision;
  dueDate?: string | null;
  dueTime?: string | null;
  timeRange?: string | null;
  conditionText?: string | null;
  nextAction?: string | null;
  reason?: string | null;
  notes?: string | null;
  taskType?: ReminderTaskType | null;
  channel?: ReminderChannel | null;
  temporalConfidence?: number | null;
  dateInterpretation?: string | null;
  aiDueDate?: string | null;
  aiDueTime?: string | null;
  aiTimeRange?: string | null;
  aiConditionText?: string | null;
  manualDueDate?: string | null;
  manualDueTime?: string | null;
  manualTimeRange?: string | null;
  manualConditionText?: string | null;
  manualNotes?: string | null;
  effectiveDueDate?: string | null;
  effectiveDueTime?: string | null;
  effectiveTimeRange?: string | null;
  effectiveConditionText?: string | null;
  effectivePrecision?: ReminderPrecision | null;
  effectiveSortKey?: string | null;
  confidenceScore?: number | null;
  lastCallSummary?: string | null;
  nextBestAction?: string | null;
  whatAgentShouldSayNext?: string | null;
  suggestedFollowupMessage?: string | null;
  evidenceQuotes?: Array<{
    quote: string;
    speaker_label?: string | null;
    speaker_display?: string | null;
  }>;
  sortKey?: string | null;
  supersededBy?: string | null;
  closedReason?: string | null;
  closedByCallId?: string | null;
  doneAt?: Date;
  closedAt?: Date;
  reopenedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface LoanCase {
  id: string;
  caseId: string;
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  agentKey: string;
  clientKey: string;
  clientKeyConfidence: 'high' | 'low';
  customerName?: string | null;
  linkedCallIds: string[];
  callCount: number;
  latestCallId?: string | null;
  latestCallOccurredAtMs?: number | null;
  latestCallOccurredAtIso?: string | null;
  latestBucketDay?: string | null;
  latestBucketWeek?: string | null;
  latestBucketMonth?: string | null;
  saleReachedOnCall: boolean;
  saleReachedCallId?: string | null;
  saleReachedAtIso?: string | null;
  loanAmount?: number | null;
  currency?: string | null;
  aiInferredStage: LoanLifecycleStage;
  manualStageOverride?: LoanLifecycleStage | null;
  effectiveStage: LoanLifecycleStage;
  stageSource: LifecycleStageSource;
  followThroughRequired: boolean;
  latestNextAction?: string | null;
  latestWhatAgentShouldSayNext?: string | null;
  latestSummary?: string | null;
  activeReminderIds: string[];
  overrideNote?: string | null;
  overrideUpdatedBy?: string | null;
  overrideUpdatedAtIso?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SalesRollup {
  id: string;
  periodType: 'day' | 'week' | 'month';
  bucketKey: string;
  sourceCallIds: string[];
  totalCalls: number;
  soldLoanCount: number;
  soldOnCallCount?: number;
  soldPendingFollowThroughCount?: number;
  confirmedCompletedCount?: number;
  lostCancelledCount?: number;
  activeCaseCount?: number;
  totalAmountSold: number;
  knownLoanAmountCount: number;
  averageLoanAmount?: number | null;
  pendingLoanAmountTotal?: number;
  completedLoanAmountTotal?: number;
  outcomeCounts: Record<string, number>;
  followUpNeededCount: number;
  updatedAt?: Date;
}

export interface CountListItem {
  label: string;
  count: number;
}

export interface ProgressRollup {
  id: string;
  periodType: 'day' | 'week' | 'month';
  bucketKey: string;
  sourceCallIds: string[];
  totalReviewedCalls: number;
  lowConfidenceCallCount: number;
  eligibleScoreCount: number;
  averageScore?: number | null;
  outcomeCounts: Record<string, number>;
  performanceTierCounts: Record<string, number>;
  strengthCounts: Record<string, number>;
  weaknessCounts: Record<string, number>;
  topStrengths: CountListItem[];
  topWeaknesses: CountListItem[];
  coachingPriorities: CountListItem[];
  updatedAt?: Date;
}
