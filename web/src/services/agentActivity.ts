import {
  collection,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  type DocumentData,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db } from './firebaseFirestore';
import { functions } from './firebaseFunctions';
import type {
  AgentCallSnapshot,
  LoanCase,
  AgentReminder,
  ManualReminderInput,
  ProgressRollup,
  SalesRollup,
} from '@/types';
import { registerKespDemoActivityTerms } from '@/lib/kespDemoRedaction';

const AGENT_ACTIVITY_COLLECTION = 'agent_activity';
/** Calls an external SDK or API dependency. */
const updateAgentReminderFn = httpsCallable<
  {
    agentKey: string;
    reminderId: string;
    state?: 'open' | 'done' | 'closed' | 'superseded';
    dueDate?: string | null;
    dueTime?: string | null;
    timeRange?: string | null;
    conditionText?: string | null;
    notes?: string | null;
    closedReason?: string | null;
  },
  { success: boolean }
>(functions, 'updateAgentReminder');
/** Calls an external SDK or API dependency. */
const setLoanCaseStageFn = httpsCallable<
  {
    agentKey: string;
    caseId: string;
    stage: 'sold_pending_follow_through' | 'fully_completed' | 'lost_cancelled';
    note?: string | null;
  },
  { success: boolean }
>(functions, 'setLoanCaseStage');

/** Documents the timestampToDate behavior. */
function timestampToDate(timestamp: Timestamp | undefined): Date | undefined {
  return timestamp?.toDate();
}

/** Documents the docToSnapshot behavior. */
function docToSnapshot(id: string, data: DocumentData): AgentCallSnapshot {
  const snapshot: AgentCallSnapshot = {
    id,
    sourceCallId: data.sourceCallId ?? id,
    uploadedBy: data.uploadedBy ?? '',
    salesAgentId: data.salesAgentId ?? '',
    salesAgentName: data.salesAgentName ?? '',
    agentKey: data.agentKey ?? '',
    latestFeedbackId: data.latestFeedbackId ?? '',
    feedbackSchemaVersion: data.feedbackSchemaVersion ?? 'unknown',
    analyzerModel: data.analyzerModel ?? '',
    environmentTarget: data.environmentTarget === 'test' || data.environmentTarget === 'prod' ? data.environmentTarget : undefined,
    callName: data.callName ?? null,
    callOccurredAtMs: typeof data.callOccurredAtMs === 'number' ? data.callOccurredAtMs : 0,
    callOccurredAtIso: data.callOccurredAtIso ?? '',
    callOccurredAt: data.callOccurredAtIso ? new Date(data.callOccurredAtIso) : undefined,
    callOccurredAtSource: data.callOccurredAtSource ?? '',
    bucketDay: data.bucketDay ?? '',
    bucketWeek: data.bucketWeek ?? '',
    bucketMonth: data.bucketMonth ?? '',
    agentName: data.agentName ?? null,
    customerName: data.customerName ?? null,
    clientKey: data.clientKey ?? '',
    clientKeyConfidence: data.clientKeyConfidence === 'high' ? 'high' : 'low',
    caseId: data.caseId ?? null,
    callOutcome: data.callOutcome ?? 'unclear',
    loanCompleted: data.loanCompleted ?? 'unclear',
    saleReachedOnCall: data.saleReachedOnCall === true,
    inferredLifecycleStage: data.inferredLifecycleStage ?? 'unknown',
    effectiveLifecycleStage: data.effectiveLifecycleStage ?? data.inferredLifecycleStage ?? 'unknown',
    lifecycleStageSource: data.lifecycleStageSource ?? 'ai_inferred',
    loanAmount: typeof data.loanAmount === 'number' ? data.loanAmount : null,
    currency: data.currency ?? null,
    saleDate: data.saleDate ?? null,
    followUpNeeded: data.followUpNeeded === true,
    reminderTaskType: data.reminderTaskType ?? null,
    reminderChannel: data.reminderChannel ?? null,
    nextAction: data.nextAction ?? null,
    followUpDate: data.followUpDate ?? null,
    followUpTime: data.followUpTime ?? null,
    followUpTimeRange: data.followUpTimeRange ?? null,
    followUpReason: data.followUpReason ?? null,
    followUpNotes: data.followUpNotes ?? null,
    clientCallbackCondition: data.clientCallbackCondition ?? null,
    confidenceScore: typeof data.confidenceScore === 'number' ? data.confidenceScore : null,
    lastCallSummary: data.lastCallSummary ?? null,
    nextBestAction: data.nextBestAction ?? null,
    whatAgentShouldSayNext: data.whatAgentShouldSayNext ?? null,
    reminderOrigin: data.reminderOrigin ?? null,
    reminderPrecision: data.reminderPrecision ?? null,
    reminderSortKey: data.reminderSortKey ?? null,
    suggestedFollowupMessage: data.suggestedFollowupMessage ?? null,
    overallScore: typeof data.overallScore === 'number' ? data.overallScore : null,
    lowConfidence: data.lowConfidence === true,
    performanceTier: data.performanceTier ?? null,
    callCategory: data.callCategory ?? null,
    strengthTitles: Array.isArray(data.strengthTitles) ? data.strengthTitles : [],
    weaknessTitles: Array.isArray(data.weaknessTitles) ? data.weaknessTitles : [],
    weaknessSeverities: Array.isArray(data.weaknessSeverities) ? data.weaknessSeverities : [],
    manualReminderInput: (data.manualReminderInput ?? null) as ManualReminderInput | null,
    activityExtraction: (data.activityExtraction ?? null) as Record<string, unknown> | null,
    snapshotFingerprint: data.snapshotFingerprint ?? '',
    createdAt: timestampToDate(data.createdAt),
    updatedAt: timestampToDate(data.updatedAt),
  };
  registerKespDemoActivityTerms(snapshot);
  return snapshot;
}

/** Documents the docToReminder behavior. */
function docToReminder(id: string, data: DocumentData): AgentReminder {
  const reminder: AgentReminder = {
    id,
    reminderId: data.reminderId ?? id,
    uploadedBy: data.uploadedBy ?? '',
    salesAgentId: data.salesAgentId ?? '',
    salesAgentName: data.salesAgentName ?? '',
    agentKey: data.agentKey ?? '',
    clientKey: data.clientKey ?? '',
    clientKeyConfidence: data.clientKeyConfidence === 'high' ? 'high' : 'low',
    customerName: data.customerName ?? null,
    sourceCallId: data.sourceCallId ?? '',
    caseId: data.caseId ?? null,
    callOutcome: data.callOutcome ?? 'unclear',
    loanCompleted: data.loanCompleted ?? 'unclear',
    lifecycleStage: data.lifecycleStage ?? 'unknown',
    lifecycleStageSource: data.lifecycleStageSource ?? 'ai_inferred',
    origin: data.origin ?? 'ai_transcript',
    state: data.state ?? 'open',
    precision: data.precision ?? data.effectivePrecision ?? 'unscheduled',
    dueDate: data.dueDate ?? data.effectiveDueDate ?? null,
    dueTime: data.dueTime ?? data.effectiveDueTime ?? null,
    timeRange: data.timeRange ?? data.effectiveTimeRange ?? null,
    conditionText: data.conditionText ?? data.effectiveConditionText ?? null,
    nextAction: data.nextAction ?? null,
    reason: data.reason ?? null,
    notes: data.notes ?? null,
    taskType: data.taskType ?? null,
    channel: data.channel ?? null,
    temporalConfidence: typeof data.temporalConfidence === 'number' ? data.temporalConfidence : null,
    dateInterpretation: data.dateInterpretation ?? null,
    aiDueDate: data.aiDueDate ?? null,
    aiDueTime: data.aiDueTime ?? null,
    aiTimeRange: data.aiTimeRange ?? null,
    aiConditionText: data.aiConditionText ?? null,
    manualDueDate: data.manualDueDate ?? null,
    manualDueTime: data.manualDueTime ?? null,
    manualTimeRange: data.manualTimeRange ?? null,
    manualConditionText: data.manualConditionText ?? null,
    manualNotes: data.manualNotes ?? null,
    effectiveDueDate: data.effectiveDueDate ?? null,
    effectiveDueTime: data.effectiveDueTime ?? null,
    effectiveTimeRange: data.effectiveTimeRange ?? null,
    effectiveConditionText: data.effectiveConditionText ?? null,
    effectivePrecision: data.effectivePrecision ?? null,
    effectiveSortKey: data.effectiveSortKey ?? null,
    confidenceScore: typeof data.confidenceScore === 'number' ? data.confidenceScore : null,
    lastCallSummary: data.lastCallSummary ?? null,
    nextBestAction: data.nextBestAction ?? null,
    whatAgentShouldSayNext: data.whatAgentShouldSayNext ?? null,
    suggestedFollowupMessage: data.suggestedFollowupMessage ?? null,
    evidenceQuotes: Array.isArray(data.evidenceQuotes) ? data.evidenceQuotes : [],
    sortKey: data.sortKey ?? null,
    supersededBy: data.supersededBy ?? null,
    closedReason: data.closedReason ?? null,
    closedByCallId: data.closedByCallId ?? null,
    doneAt: timestampToDate(data.doneAt),
    closedAt: timestampToDate(data.closedAt),
    reopenedAt: timestampToDate(data.reopenedAt),
    createdAt: timestampToDate(data.createdAt),
    updatedAt: timestampToDate(data.updatedAt),
  };
  registerKespDemoActivityTerms(reminder);
  return reminder;
}

/** Documents the docToLoanCase behavior. */
function docToLoanCase(id: string, data: DocumentData): LoanCase {
  const loanCase: LoanCase = {
    id,
    caseId: data.caseId ?? id,
    uploadedBy: data.uploadedBy ?? '',
    salesAgentId: data.salesAgentId ?? '',
    salesAgentName: data.salesAgentName ?? '',
    agentKey: data.agentKey ?? '',
    clientKey: data.clientKey ?? '',
    clientKeyConfidence: data.clientKeyConfidence === 'high' ? 'high' : 'low',
    customerName: data.customerName ?? null,
    linkedCallIds: Array.isArray(data.linkedCallIds) ? data.linkedCallIds : [],
    callCount: typeof data.callCount === 'number' ? data.callCount : 0,
    latestCallId: data.latestCallId ?? null,
    latestCallOccurredAtMs:
      typeof data.latestCallOccurredAtMs === 'number' ? data.latestCallOccurredAtMs : null,
    latestCallOccurredAtIso: data.latestCallOccurredAtIso ?? null,
    latestBucketDay: data.latestBucketDay ?? null,
    latestBucketWeek: data.latestBucketWeek ?? null,
    latestBucketMonth: data.latestBucketMonth ?? null,
    saleReachedOnCall: data.saleReachedOnCall === true,
    saleReachedCallId: data.saleReachedCallId ?? null,
    saleReachedAtIso: data.saleReachedAtIso ?? null,
    loanAmount: typeof data.loanAmount === 'number' ? data.loanAmount : null,
    currency: data.currency ?? null,
    aiInferredStage: data.aiInferredStage ?? 'unknown',
    manualStageOverride: data.manualStageOverride ?? null,
    effectiveStage: data.effectiveStage ?? data.aiInferredStage ?? 'unknown',
    stageSource: data.stageSource ?? 'ai_inferred',
    followThroughRequired: data.followThroughRequired === true,
    latestNextAction: data.latestNextAction ?? null,
    latestWhatAgentShouldSayNext: data.latestWhatAgentShouldSayNext ?? null,
    latestSummary: data.latestSummary ?? null,
    activeReminderIds: Array.isArray(data.activeReminderIds) ? data.activeReminderIds : [],
    overrideNote: data.overrideNote ?? null,
    overrideUpdatedBy: data.overrideUpdatedBy ?? null,
    overrideUpdatedAtIso: data.overrideUpdatedAtIso ?? null,
    createdAt: timestampToDate(data.createdAt),
    updatedAt: timestampToDate(data.updatedAt),
  };
  registerKespDemoActivityTerms(loanCase);
  return loanCase;
}

/** Documents the docToSalesRollup behavior. */
function docToSalesRollup(id: string, data: DocumentData): SalesRollup {
  const salesRollup: SalesRollup = {
    id,
    periodType: data.periodType ?? 'week',
    bucketKey: data.bucketKey ?? '',
    sourceCallIds: Array.isArray(data.sourceCallIds) ? data.sourceCallIds : [],
    totalCalls: typeof data.totalCalls === 'number' ? data.totalCalls : 0,
    soldLoanCount: typeof data.soldLoanCount === 'number' ? data.soldLoanCount : 0,
    soldOnCallCount: typeof data.soldOnCallCount === 'number' ? data.soldOnCallCount : 0,
    soldPendingFollowThroughCount:
      typeof data.soldPendingFollowThroughCount === 'number'
        ? data.soldPendingFollowThroughCount
        : 0,
    confirmedCompletedCount:
      typeof data.confirmedCompletedCount === 'number' ? data.confirmedCompletedCount : 0,
    lostCancelledCount:
      typeof data.lostCancelledCount === 'number' ? data.lostCancelledCount : 0,
    activeCaseCount: typeof data.activeCaseCount === 'number' ? data.activeCaseCount : 0,
    totalAmountSold: typeof data.totalAmountSold === 'number' ? data.totalAmountSold : 0,
    knownLoanAmountCount:
      typeof data.knownLoanAmountCount === 'number' ? data.knownLoanAmountCount : 0,
    averageLoanAmount:
      typeof data.averageLoanAmount === 'number' ? data.averageLoanAmount : null,
    pendingLoanAmountTotal:
      typeof data.pendingLoanAmountTotal === 'number' ? data.pendingLoanAmountTotal : 0,
    completedLoanAmountTotal:
      typeof data.completedLoanAmountTotal === 'number' ? data.completedLoanAmountTotal : 0,
    outcomeCounts: data.outcomeCounts ?? {},
    followUpNeededCount:
      typeof data.followUpNeededCount === 'number' ? data.followUpNeededCount : 0,
    updatedAt: timestampToDate(data.updatedAt),
  };
  registerKespDemoActivityTerms(salesRollup);
  return salesRollup;
}

/** Documents the docToProgressRollup behavior. */
function docToProgressRollup(id: string, data: DocumentData): ProgressRollup {
  const progressRollup: ProgressRollup = {
    id,
    periodType: data.periodType ?? 'week',
    bucketKey: data.bucketKey ?? '',
    sourceCallIds: Array.isArray(data.sourceCallIds) ? data.sourceCallIds : [],
    totalReviewedCalls:
      typeof data.totalReviewedCalls === 'number' ? data.totalReviewedCalls : 0,
    lowConfidenceCallCount:
      typeof data.lowConfidenceCallCount === 'number' ? data.lowConfidenceCallCount : 0,
    eligibleScoreCount:
      typeof data.eligibleScoreCount === 'number' ? data.eligibleScoreCount : 0,
    averageScore: typeof data.averageScore === 'number' ? data.averageScore : null,
    outcomeCounts: data.outcomeCounts ?? {},
    performanceTierCounts: data.performanceTierCounts ?? {},
    strengthCounts: data.strengthCounts ?? {},
    weaknessCounts: data.weaknessCounts ?? {},
    topStrengths: Array.isArray(data.topStrengths) ? data.topStrengths : [],
    topWeaknesses: Array.isArray(data.topWeaknesses) ? data.topWeaknesses : [],
    coachingPriorities: Array.isArray(data.coachingPriorities) ? data.coachingPriorities : [],
    updatedAt: timestampToDate(data.updatedAt),
  };
  registerKespDemoActivityTerms(progressRollup);
  return progressRollup;
}

/** Documents the subscribeToAgentCallSnapshots behavior. */
export function subscribeToAgentCallSnapshots(
  agentKey: string,
  callback: (snapshots: AgentCallSnapshot[]) => void
): () => void {
  /** Calls an external SDK or API dependency. */
  const q = query(
    collection(db, AGENT_ACTIVITY_COLLECTION, agentKey, 'call_snapshots'),
    orderBy('callOccurredAtMs', 'desc')
  );

  return onSnapshot(q, /** Handles the callback for this operation. */(snapshot) => {
    callback(snapshot.docs.map(/** Handles the callback for this operation. */(doc) => docToSnapshot(doc.id, doc.data())));
  });
}

/** Documents the subscribeToAgentReminders behavior. */
export function subscribeToAgentReminders(
  agentKey: string,
  callback: (reminders: AgentReminder[]) => void
): () => void {
  /** Calls an external SDK or API dependency. */
  const q = query(
    collection(db, AGENT_ACTIVITY_COLLECTION, agentKey, 'reminders'),
    orderBy('updatedAt', 'desc')
  );

  return onSnapshot(q, /** Handles the callback for this operation. */(snapshot) => {
    callback(snapshot.docs.map(/** Handles the callback for this operation. */(doc) => docToReminder(doc.id, doc.data())));
  });
}

/** Documents the subscribeToLoanCases behavior. */
export function subscribeToLoanCases(
  agentKey: string,
  callback: (loanCases: LoanCase[]) => void
): () => void {
  /** Calls an external SDK or API dependency. */
  const q = query(
    collection(db, AGENT_ACTIVITY_COLLECTION, agentKey, 'loan_cases'),
    orderBy('latestCallOccurredAtMs', 'desc')
  );

  return onSnapshot(q, /** Handles the callback for this operation. */(snapshot) => {
    callback(snapshot.docs.map(/** Handles the callback for this operation. */(doc) => docToLoanCase(doc.id, doc.data())));
  });
}

/** Documents the subscribeToSalesRollups behavior. */
export function subscribeToSalesRollups(
  agentKey: string,
  callback: (rollups: SalesRollup[]) => void
): () => void {
  /** Calls an external SDK or API dependency. */
  const q = query(
    collection(db, AGENT_ACTIVITY_COLLECTION, agentKey, 'sales_rollups'),
    orderBy('bucketKey', 'desc')
  );

  return onSnapshot(q, /** Handles the callback for this operation. */(snapshot) => {
    callback(snapshot.docs.map(/** Handles the callback for this operation. */(doc) => docToSalesRollup(doc.id, doc.data())));
  });
}

/** Documents the subscribeToProgressRollups behavior. */
export function subscribeToProgressRollups(
  agentKey: string,
  callback: (rollups: ProgressRollup[]) => void
): () => void {
  /** Calls an external SDK or API dependency. */
  const q = query(
    collection(db, AGENT_ACTIVITY_COLLECTION, agentKey, 'progress_rollups'),
    orderBy('bucketKey', 'desc')
  );

  return onSnapshot(q, /** Handles the callback for this operation. */(snapshot) => {
    callback(snapshot.docs.map(/** Handles the callback for this operation. */(doc) => docToProgressRollup(doc.id, doc.data())));
  });
}

/** Documents the updateReminder behavior. */
export async function updateReminder(
  agentKey: string,
  reminderId: string,
  updates: Partial<
    Pick<
      AgentReminder,
      | 'state'
      | 'dueDate'
      | 'dueTime'
      | 'timeRange'
      | 'conditionText'
      | 'notes'
      | 'closedReason'
      | 'precision'
      | 'timeRange'
      | 'conditionText'
    >
  >
): Promise<void> {
  await updateAgentReminderFn({
    agentKey,
    reminderId,
    state: updates.state,
    dueDate: updates.dueDate,
    dueTime: updates.dueTime,
    timeRange: updates.timeRange,
    conditionText: updates.conditionText,
    notes: updates.notes,
    closedReason: updates.closedReason,
  });
}

/** Documents the updateLoanCaseStage behavior. */
export async function updateLoanCaseStage(
  agentKey: string,
  caseId: string,
  stage: 'sold_pending_follow_through' | 'fully_completed' | 'lost_cancelled',
  note?: string | null
): Promise<void> {
  await setLoanCaseStageFn({
    agentKey,
    caseId,
    stage,
    note: note ?? null,
  });
}
