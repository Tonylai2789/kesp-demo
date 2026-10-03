import { isSharedDemoAgentProfile } from '@/services/agentAnalyses';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/useAuth';
import { useDemoProcessingStatus } from '@/hooks/useDemoProcessingStatus';
import { DemoProcessingStatus } from '@/components/kesp/DemoProcessingStatus';
import { useTranscriptionUploadSelection } from '@/hooks/useTranscriptionUploadSelection';
import { TranscriptionUploadSelector } from '@/components/kesp/TranscriptionUploadSelector';
import { transcriptionModelLabel, type TranscriptionUploadSelection } from '@/lib/transcriptionUpload';
import { DeleteCallDialog } from '@/components/calls/DeleteCallDialog';
import { DeleteAgentProfileDialog } from '@/components/kesp/DeleteAgentProfileDialog';
import {
  AgentProfileAssistantFloating,
  AgentProfileAssistantInline,
  AgentProfileAssistantProvider,
} from '@/components/kesp/AgentProfileAssistant';
import { ShortCallReviewPanel } from '@/components/kesp/ShortCallReviewPanel';
import { UploadAnalyzerSettingsButton } from '@/components/kesp/AnalyzerSettingsButton';
import { isRegularAgentProfileCall, isShortCallReviewCall } from '@/lib/shortCallReview';
import {
  fetchAgentAnalysisRunTasks,
  subscribeToAgentAnalyses,
  subscribeToAgentAnalysis,
  subscribeToAgentAnalysisReport,
  triggerAgentAnalysisRun,
} from '@/services/agentAnalyses';
import type { AgentAnalysis, AgentAnalysisRunTask } from '@/types/agentAnalysis';
import {
  subscribeToAgentCallSnapshots,
  subscribeToAgentReminders,
  subscribeToProgressRollups,
  subscribeToSalesRollups,
  updateLoanCaseStage,
  updateReminder,
} from '@/services/agentActivity';
import { fetchFeedback, subscribeToAgentLinkedCalls } from '@/services/firestore';
import {
  uploadAudioFile,
  validateAudioFile,
  type UploadProgress,
} from '@/services/storage';
import {
  getAvailablePrompts,
  refreshAgentActivity,
  type AvailablePromptsResponse,
} from '@/services/functions';
import { agentProfileCheckIn } from '@/services/agentCheckIns';
import {
  isConsubancoAgentMember,
  isConsubancoMember,
  isConsubancoSupervisorOrAdminMember,
  subscribeToConsubancoMembership,
  type OrganizationMember,
} from '@/services/organizations';
import { buildAgentKey } from '@/lib/agentActivity';
import { callBusinessDate } from '@/lib/callDates';
import { appendReturnTo } from '@/lib/returnTo';
import { maskKespDemoAgentDisplayName, maskKespDemoCallString, maskKespDemoEvidenceText, redactKespDemoText } from '@/lib/kespDemoRedaction';
import { useKespDemoRedactionEnabled } from '@/hooks/useKespDemoRedactionEnabled';
import { isProductionFirebaseProject, isTestingFirebaseProject } from '@/services/firebaseApp';
import {
  loadKespUploadPromptSettings,
  validateKespUploadPromptSettings,
} from '@/lib/kespUploadPromptSettings';
import type { Call, CallCategory } from '@/types/call';
import type {
  AgentAnalysisReport,
  AgentAnalysisReportV2,
  BehaviorPattern,
} from '@/types/agentAnalysis';
import type {
  AgentCallSnapshot,
  AgentReminder,
  ProgressRollup,
  SalesRollup,
} from '@/types/agentActivity';
import { Icon, type IconName } from '@/components/kesp/icons';
import { Button, Pill, type PillKind } from '@/components/kesp/primitives';
import { fmtDur } from '@/components/kesp/format';
import { formatKespDate, formatKespMoneyMx, getKespLocale } from '@/lib/kespI18n';
import { downloadElementsAsPdf, sanitizePdfFileName } from '@/lib/pdfExport';
import {
  aggregateCoachingActionItems,
  aggregateCoachingSayExamples,
  aggregateCriteria,
  aggregateDateKey,
  aggregateRubricRangeSessionKey,
  buildDefaultAggregateRubricRange,
  buildAggregateRubricSummary,
  callsForAggregateRange,
  compactAggregateText,
  colorFromPercent,
  groupAggregateCriteriaByPriority,
  loadAggregateRubricRows,
  normalizeAggregateRubricRange,
  parseAggregateDateKey,
  rangeFromSearchParamsOrNull,
  readSessionAggregateRubricRange,
  type AggregateRubricCriterion,
  type AggregateRubricMetric,
  type AggregateRubricPriorityBucket,
  type AggregateRubricRange,
  type AggregateRubricSection,
  type AggregateRubricSummary,
  type AggregateRubricTrend,
  writeSessionAggregateRubricRange,
} from '@/lib/aggregateRubric';

type TabId = 'carga' | 'reporte' | 'rubrica' | 'recordatorio' | 'progresion' | 'arvo' | 'shortCalls';
type Period = 'day' | 'week' | 'month';
type ProgressFilterPeriod = Period | 'custom';
type NavigateFn = ReturnType<typeof useNavigate>;

/** Documents the tabFromSearch behavior. */
function tabFromSearch(search: string): TabId {
  const tab = new URLSearchParams(search).get('tab');
  return tab === 'carga' || tab === 'reporte' || tab === 'rubrica' || tab === 'recordatorio' || tab === 'progresion' || tab === 'arvo' || tab === 'shortCalls'
    ? tab
    : 'reporte';
}
type AssociatedCallsTab = 'today' | 'week' | 'month' | 'all';
type AssociatedCallTone = 'ok' | 'warn' | 'failed';
type AssociatedStatusSummary = {
  total: number;
  ok: number;
  warn: number;
  failed: number;
};
type AssociatedScoreSummary = {
  average: number | null;
};
type AssociatedScoreMap = Map<string, number | null>;
type AssociatedDaySectionData = {
  key: string;
  date: Date;
  calls: Call[];
  summary: AssociatedStatusSummary;
  scoreSummary: AssociatedScoreSummary;
  isToday: boolean;
};

/** Documents the padDatePart behavior. */
function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

/** Documents the startOfLocalDay behavior. */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Documents the localDateKeyFromDate behavior. */
function localDateKeyFromDate(date: Date): string {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('-');
}

/** Documents the localMonthKeyFromDate behavior. */
function localMonthKeyFromDate(date: Date): string {
  return [date.getFullYear(), padDatePart(date.getMonth() + 1)].join('-');
}

/** Documents the parseLocalMonthKey behavior. */
function parseLocalMonthKey(value: string): Date | null {
  if (!/^\d{4}-\d{2}$/.test(value)) return null;
  const [year, month] = value.split('-').map(Number);
  return new Date(year, month - 1, 1);
}

/** Documents the addLocalDays behavior. */
function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Documents the addLocalMonths behavior. */
function addLocalMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return new Date(next.getFullYear(), next.getMonth(), 1);
}

/** Documents the startOfLocalWeekMonday behavior. */
function startOfLocalWeekMonday(date: Date): Date {
  const start = startOfLocalDay(date);
  const mondayOffset = (start.getDay() + 6) % 7;
  return addLocalDays(start, -mondayOffset);
}

/** Documents the buildCurrentWeekDates behavior. */
function buildCurrentWeekDates(today: Date): Date[] {
  const start = startOfLocalWeekMonday(today);
  const todayStart = startOfLocalDay(today);
  const days: Date[] = [];
  for (let index = 0; index < 7; index += 1) {
    const next = addLocalDays(start, index);
    if (next.getTime() > todayStart.getTime()) break;
    days.push(next);
  }
  return days;
}

/** Documents the buildMonthDates behavior. */
function buildMonthDates(monthDate: Date, today: Date): Date[] {
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
  const todayStart = startOfLocalDay(today);
  const end =
    localMonthKeyFromDate(monthDate) === localMonthKeyFromDate(today) && monthEnd.getTime() > todayStart.getTime()
      ? todayStart
      : monthEnd;
  const days: Date[] = [];
  for (let next = monthStart; next.getTime() <= end.getTime(); next = addLocalDays(next, 1)) {
    days.push(next);
  }
  return days.reverse();
}

/** Documents the capitalizeLabel behavior. */
function capitalizeLabel(value: string): string {
  return value.length > 0 ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value;
}

/** Documents the normalizeDateLabel behavior. */
function normalizeDateLabel(value: string): string {
  return value.replace(',', '').replace(/\s+de\s+(\d{4})$/i, ' $1');
}

/** Documents the formatAssociatedFullDate behavior. */
function formatAssociatedFullDate(date: Date, language: string | undefined): string {
  return normalizeDateLabel(
    formatKespDate(date, language, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    })
  );
}

/** Documents the formatAssociatedDayTitle behavior. */
function formatAssociatedDayTitle(date: Date, language: string | undefined): string {
  return normalizeDateLabel(
    formatKespDate(date, language, {
      weekday: 'long',
      day: 'numeric',
    })
  );
}

/** Documents the formatAssociatedWeekdayShort behavior. */
function formatAssociatedWeekdayShort(date: Date, language: string | undefined): string {
  return formatKespDate(date, language, { weekday: 'short' }).replace('.', '');
}

/** Documents the formatAssociatedCallTime behavior. */
function formatAssociatedCallTime(date: Date | undefined, language: string | undefined): string {
  return formatKespDate(date, language, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Documents the formatAssociatedMonthTitle behavior. */
function formatAssociatedMonthTitle(date: Date, today: Date, language: string | undefined): string {
  const monthName = capitalizeLabel(formatKespDate(date, language, { month: 'long' }));
  return date.getFullYear() === today.getFullYear() ? monthName : `${monthName} ${date.getFullYear()}`;
}

/** Documents the getAssociatedCallTone behavior. */
function getAssociatedCallTone(call: Call): AssociatedCallTone {
  if (call.status === 'error' || call.lastRunStatus === 'error') return 'failed';
  if (call.status !== 'complete' || call.category === 'medium' || call.category === 'bad') return 'warn';
  return 'ok';
}

/** Documents the associatedToneToQualityKey behavior. */
function associatedToneToQualityKey(tone: AssociatedCallTone): 'good' | 'warn' | 'bad' {
  if (tone === 'failed') return 'bad';
  if (tone === 'warn') return 'warn';
  return 'good';
}

/** Documents the associatedToneToPillKind behavior. */
function associatedToneToPillKind(tone: AssociatedCallTone): PillKind {
  if (tone === 'failed') return 'bad';
  if (tone === 'warn') return 'warn';
  return 'good';
}

/** Documents the associatedToneToIconName behavior. */
function associatedToneToIconName(tone: AssociatedCallTone): IconName {
  if (tone === 'failed') return 'x';
  if (tone === 'warn') return 'info';
  return 'check';
}

/** Documents the associatedToneLabel behavior. */
function associatedToneLabel(tone: AssociatedCallTone, t: TFunction): string {
  return t(`kesp.agent.upload.associated.status.${tone}`);
}

/** Documents the summarizeAssociatedCalls behavior. */
function summarizeAssociatedCalls(calls: Call[]): AssociatedStatusSummary {
  const summary: AssociatedStatusSummary = { total: calls.length, ok: 0, warn: 0, failed: 0 };
  for (const call of calls) {
    summary[getAssociatedCallTone(call)] += 1;
  }
  return summary;
}

/** Documents the isAssociatedScore behavior. */
function isAssociatedScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Documents the buildAssociatedScoreByCallId behavior. */
function buildAssociatedScoreByCallId(snapshots: AgentCallSnapshot[]): AssociatedScoreMap {
  const scoreByCallId: AssociatedScoreMap = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot.sourceCallId || !isAssociatedScore(snapshot.overallScore)) continue;
    scoreByCallId.set(snapshot.sourceCallId, snapshot.overallScore);
  }
  return scoreByCallId;
}

/** Documents the mergeAssociatedScoreMaps behavior. */
function mergeAssociatedScoreMaps(primaryScores: AssociatedScoreMap, fallbackScores: AssociatedScoreMap): AssociatedScoreMap {
  const scoreByCallId = new Map(fallbackScores);
  primaryScores.forEach(/** Handles the callback for this operation. */(score, callId) => {
    if (isAssociatedScore(score)) scoreByCallId.set(callId, score);
  });
  return scoreByCallId;
}

/** Documents the associatedCallScore behavior. */
function associatedCallScore(call: Call, scoreByCallId: AssociatedScoreMap): number | null {
  const candidateCallIds = [
    call.id,
    call.callDocumentId,
    call.canonicalCallId,
  ];
  for (const callId of candidateCallIds) {
    if (!callId) continue;
    const score = scoreByCallId.get(callId);
    if (isAssociatedScore(score)) return score;
  }
  return null;
}

/** Documents the summarizeAssociatedScores behavior. */
function summarizeAssociatedScores(calls: Call[], scoreByCallId: AssociatedScoreMap): AssociatedScoreSummary {
  let scoreTotal = 0;
  let scoredCalls = 0;
  for (const call of calls) {
    const score = associatedCallScore(call, scoreByCallId);
    if (!isAssociatedScore(score)) continue;
    scoreTotal += score;
    scoredCalls += 1;
  }
  return { average: scoredCalls > 0 ? scoreTotal / scoredCalls : null };
}

/** Documents the formatAssociatedAverageScore behavior. */
function formatAssociatedAverageScore(score: number | null): string {
  return isAssociatedScore(score) ? String(Math.round(score)) : '—';
}

/** Documents the sortAssociatedCalls behavior. */
function sortAssociatedCalls(calls: Call[]): Call[] {
  return [...calls].sort(/** Handles the callback for this operation. */(left, right) => {
    const leftTime = callBusinessDate(left).getTime();
    const rightTime = callBusinessDate(right).getTime();
    return rightTime - leftTime;
  });
}

/** Documents the associatedCallPhoneLabel behavior. */
function associatedCallPhoneLabel(call: Call): string {
  return (
    call.cccDestination?.trim() ||
    call.displayName?.trim() ||
    call.name?.trim() ||
    call.originalFilename?.trim() ||
    call.id
  );
}

/** Documents the associatedCallVersionLabel behavior. */
function associatedCallVersionLabel(call: Call): string {
  const versions = [
    ...Object.values(call.promptOverrides ?? {}),
    ...Object.values(call.activityPromptOverrides ?? {}),
  ];
  const majorVersions = versions
    .map(/** Handles the callback for this operation. */(version) => {
      const match = version.match(/^v?(\d+)/i);
      return match ? Number(match[1]) : null;
    })
    .filter(/** Handles the callback for this operation. */(version): version is number => typeof version === 'number' && Number.isFinite(version));
  return majorVersions.length > 0 ? `v${Math.max(...majorVersions)}` : 'v5';
}

/** Documents the associatedCallMatchesSearch behavior. */
function associatedCallMatchesSearch(call: Call, queryText: string): boolean {
  const needle = queryText.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    associatedCallPhoneLabel(call),
    call.id,
    call.callDocumentId,
    call.canonicalCallId,
    call.cccCallId,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle);
}

/** Documents the buildAssociatedDaySection behavior. */
function buildAssociatedDaySection(
  date: Date,
  calls: Call[],
  today: Date,
  scoreByCallId: AssociatedScoreMap
): AssociatedDaySectionData {
  const key = localDateKeyFromDate(date);
  const dayCalls = sortAssociatedCalls(
    calls.filter(/** Handles the callback for this operation. */(call) => localDateKeyFromDate(callBusinessDate(call)) === key)
  );
  return {
    key,
    date,
    calls: dayCalls,
    summary: summarizeAssociatedCalls(dayCalls),
    scoreSummary: summarizeAssociatedScores(dayCalls, scoreByCallId),
    isToday: key === localDateKeyFromDate(today),
  };
}

/** Documents the priorityLabel behavior. */
function priorityLabel(priority: number, t: TFunction): string {
  return t(`kesp.agent.priority.${priority}`, { defaultValue: String(priority) });
}

/** Documents the periodLabel behavior. */
function periodLabel(period: ProgressFilterPeriod, t: TFunction): string {
  return t(`kesp.agent.period.${period}`);
}

type CountItem = { label: string; count: number };
type ProgressViewRollup = Omit<ProgressRollup, 'periodType'> & { periodType: ProgressFilterPeriod };
type SalesViewRollup = Omit<SalesRollup, 'periodType'> & { periodType: ProgressFilterPeriod };

function dateKey(value: string | null | undefined): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function monthKey(value: string | null | undefined): string {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) ? value : '';
}

function parseDateKey(value: string): Date | null {
  if (!dateKey(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDaysToKey(value: string, days: number): string {
  const parsed = parseDateKey(value);
  if (!parsed) return value;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function normalizeWeekBucket(value: string): string {
  const parsed = parseDateKey(value);
  if (!parsed) return '';
  const weekday = parsed.getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  parsed.setUTCDate(parsed.getUTCDate() - mondayOffset);
  return parsed.toISOString().slice(0, 10);
}

function buildTopCountItems(counts: Record<string, number>): CountItem[] {
  return Object.entries(counts)
    .map(([label, count]) => ({
      label,
      count,
    }))
    .filter((item) => item.label.trim().length > 0 && item.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 10);
}

function uniqueLabels(labels: string[]): string[] {
  return Array.from(new Set(labels.map((label) => label.trim()).filter(Boolean)));
}

function snapshotBucket(snapshot: AgentCallSnapshot, period: Period): string {
  if (period === 'day') return snapshot.bucketDay;
  if (period === 'week') return snapshot.bucketWeek;
  return snapshot.bucketMonth;
}

function snapshotsForPeriod(
  snapshots: AgentCallSnapshot[],
  period: ProgressFilterPeriod,
  bucketKey: string,
  customStart: string,
  customEnd: string
): AgentCallSnapshot[] {
  if (period === 'custom') {
    const start = dateKey(customStart);
    const end = dateKey(customEnd);
    if (!start || !end || start > end) return [];
    return snapshots.filter((snapshot) => snapshot.bucketDay >= start && snapshot.bucketDay <= end);
  }
  if (!bucketKey) return [];
  return snapshots.filter((snapshot) => snapshotBucket(snapshot, period) === bucketKey);
}

function buildProgressSummary(
  periodType: ProgressFilterPeriod,
  bucketKey: string,
  periodSnapshots: AgentCallSnapshot[]
): ProgressViewRollup {
  const outcomeCounts: Record<string, number> = {};
  const performanceTierCounts: Record<string, number> = {};
  const strengthCounts: Record<string, number> = {};
  const weaknessCounts: Record<string, number> = {};
  let lowConfidenceCallCount = 0;
  let eligibleScoreCount = 0;
  let scoreSum = 0;

  periodSnapshots.forEach((snapshot) => {
    outcomeCounts[snapshot.callOutcome] = (outcomeCounts[snapshot.callOutcome] ?? 0) + 1;
    if (snapshot.performanceTier) {
      performanceTierCounts[snapshot.performanceTier] = (performanceTierCounts[snapshot.performanceTier] ?? 0) + 1;
    }
    if (snapshot.lowConfidence === true) {
      lowConfidenceCallCount += 1;
    } else if (typeof snapshot.overallScore === 'number') {
      eligibleScoreCount += 1;
      scoreSum += snapshot.overallScore;
    }
    uniqueLabels(snapshot.strengthTitles).forEach((label) => {
      strengthCounts[label] = (strengthCounts[label] ?? 0) + 1;
    });
    uniqueLabels(snapshot.weaknessTitles).forEach((label) => {
      weaknessCounts[label] = (weaknessCounts[label] ?? 0) + 1;
    });
  });

  return {
    id: `${periodType}_${bucketKey}`,
    periodType,
    bucketKey,
    sourceCallIds: periodSnapshots.map((snapshot) => snapshot.sourceCallId),
    totalReviewedCalls: periodSnapshots.length,
    lowConfidenceCallCount,
    eligibleScoreCount,
    averageScore: eligibleScoreCount > 0 ? scoreSum / eligibleScoreCount : null,
    outcomeCounts,
    performanceTierCounts,
    strengthCounts,
    weaknessCounts,
    topStrengths: buildTopCountItems(strengthCounts),
    topWeaknesses: buildTopCountItems(weaknessCounts),
    coachingPriorities: buildTopCountItems(weaknessCounts),
  };
}

function buildSalesSummary(
  periodType: ProgressFilterPeriod,
  bucketKey: string,
  periodSnapshots: AgentCallSnapshot[]
): SalesViewRollup {
  const outcomeCounts: Record<string, number> = {};
  const latestByCase = new Map<string, AgentCallSnapshot>();
  let followUpNeededCount = 0;

  periodSnapshots.forEach((snapshot) => {
    outcomeCounts[snapshot.callOutcome] = (outcomeCounts[snapshot.callOutcome] ?? 0) + 1;
    if (snapshot.followUpNeeded) followUpNeededCount += 1;
    const caseKey = snapshot.caseId ?? snapshot.clientKey ?? snapshot.sourceCallId;
    const previous = latestByCase.get(caseKey);
    if (!previous || snapshot.callOccurredAtMs > previous.callOccurredAtMs) {
      latestByCase.set(caseKey, snapshot);
    }
  });

  let soldLoanCount = 0;
  let soldOnCallCount = 0;
  let soldPendingFollowThroughCount = 0;
  let confirmedCompletedCount = 0;
  let lostCancelledCount = 0;
  let totalAmountSold = 0;
  let knownLoanAmountCount = 0;
  let pendingLoanAmountTotal = 0;
  let completedLoanAmountTotal = 0;

  latestByCase.forEach((snapshot) => {
    const stage = snapshot.effectiveLifecycleStage ?? snapshot.inferredLifecycleStage ?? 'unknown';
    const countsAsSold = stage === 'sold_pending_follow_through' || stage === 'fully_completed';
    if (snapshot.saleReachedOnCall === true && countsAsSold) soldOnCallCount += 1;
    if (countsAsSold) {
      soldLoanCount += 1;
      if (typeof snapshot.loanAmount === 'number') {
        totalAmountSold += snapshot.loanAmount;
        knownLoanAmountCount += 1;
      }
    }
    if (stage === 'sold_pending_follow_through') {
      soldPendingFollowThroughCount += 1;
      if (typeof snapshot.loanAmount === 'number') pendingLoanAmountTotal += snapshot.loanAmount;
    }
    if (stage === 'fully_completed' && snapshot.lifecycleStageSource !== 'ai_inferred') {
      confirmedCompletedCount += 1;
      if (typeof snapshot.loanAmount === 'number') completedLoanAmountTotal += snapshot.loanAmount;
    }
    if (stage === 'lost_cancelled') lostCancelledCount += 1;
  });

  return {
    id: `${periodType}_${bucketKey}`,
    periodType,
    bucketKey,
    sourceCallIds: periodSnapshots.map((snapshot) => snapshot.sourceCallId),
    totalCalls: periodSnapshots.length,
    soldLoanCount,
    soldOnCallCount,
    soldPendingFollowThroughCount,
    confirmedCompletedCount,
    lostCancelledCount,
    activeCaseCount: latestByCase.size,
    totalAmountSold,
    knownLoanAmountCount,
    averageLoanAmount: knownLoanAmountCount > 0 ? totalAmountSold / knownLoanAmountCount : null,
    pendingLoanAmountTotal,
    completedLoanAmountTotal,
    outcomeCounts,
    followUpNeededCount,
  };
}

/** Documents the statusLabel behavior. */
function statusLabel(status: string, t: TFunction): string {
  return t(`kesp.status.${status}`, { defaultValue: status });
}

/** Documents the categoryLabel behavior. */
function categoryLabel(category: string, t: TFunction): string {
  return t(`kesp.category.${category}`, { defaultValue: category });
}

/** Documents the priorityBucket behavior. */
function priorityBucket(score: number): 1 | 2 | 3 | 4 {
  if (score <= 1) return 1;
  if (score <= 2) return 2;
  if (score <= 3) return 3;
  return 4;
}

/** Documents the isReportV2 behavior. */
function isReportV2(report: AgentAnalysisReport | null): report is AgentAnalysisReportV2 {
  return !!report && (report as AgentAnalysisReportV2).schemaVersion === '2';
}

/** Documents the fmtMoneyMx behavior. */
function fmtMoneyMx(n: number | null | undefined, language: string | undefined): string {
  return formatKespMoneyMx(n, language);
}

// ─── Carga tab ───────────────────────────────────────────────────────────────
/** Renders compact status counts for associated call lists. */
function AssociatedStatusSummaryPills({ summary }: { summary: AssociatedStatusSummary }) {
  const { t } = useTranslation();
  const items: { tone: AssociatedCallTone; count: number }[] = [
    { tone: 'ok', count: summary.ok },
    { tone: 'warn', count: summary.warn },
    { tone: 'failed', count: summary.failed },
  ];

  return (
    <div className="associated-status-summary" aria-label={t('kesp.agent.upload.associated.summaryLabel')}>
      {items.map(/** Handles the callback for this operation. */(item) => (
        <span key={item.tone} data-tone={item.tone}>
          <Icon name={associatedToneToIconName(item.tone)} size={12} />
          {t(`kesp.agent.upload.associated.summary.${item.tone}`, { count: item.count })}
        </span>
      ))}
    </div>
  );
}

/** Renders a compact average-score metric for associated call periods. */
function AssociatedAverageScore({ summary, label }: { summary: AssociatedScoreSummary; label: string }) {
  return (
    <span className="associated-score-summary" aria-label={label}>
      <b>{formatAssociatedAverageScore(summary.average)}</b>
      <span>{label}</span>
    </span>
  );
}

/** Renders one associated call row with phone, time, duration, version, id, and status. */
function AssociatedCallRow({
  call,
  navigate,
  returnTo,
  canManageAgent,
  onRequestDelete,
}: {
  call: Call;
  navigate: NavigateFn;
  returnTo: string;
  canManageAgent: boolean;
  onRequestDelete: (call: Call) => void;
}) {
  const { t, i18n } = useTranslation();
  const tone = getAssociatedCallTone(call);
  const demoMode = useKespDemoRedactionEnabled();
  const qualityKey = associatedToneToQualityKey(tone);
  const phoneLabel = associatedCallPhoneLabel(call);
  const versionLabel = associatedCallVersionLabel(call);
  const durationLabel =
    typeof call.duration === 'number' && call.duration > 0 ? fmtDur(call.duration) : t('kesp.common.notAvailable');

  return (
    <div
      className="call-row associated-call-row"
      data-q={qualityKey}
      onClick={/** Handles the onClick interaction. */() =>
        navigate(appendReturnTo(`/kesp/call/${encodeURIComponent(call.id)}`, returnTo))}
    >
      <div className="call-icon" data-q={qualityKey}>
        <Icon name="phone" size={14} />
      </div>
      <div className="associated-call-copy">
        <div className="associated-call-mainline">
          <span className="associated-call-phone">{demoMode ? maskKespDemoCallString(phoneLabel) : phoneLabel}</span>
          <span className="associated-call-time">{formatAssociatedCallTime(callBusinessDate(call), i18n.resolvedLanguage)}</span>
        </div>
        <div className="associated-call-subline">
          <span>{durationLabel}</span>
          <span className="muted-sep">·</span>
          <span className="associated-call-version">{versionLabel}</span>
          <span className="muted-sep">·</span>
          <span className="associated-call-id">{demoMode ? maskKespDemoCallString(call.id) : call.id}</span>
        </div>
      </div>
      <div className="associated-call-actions">
        <Pill
          kind={associatedToneToPillKind(tone)}
          icon={<Icon name={associatedToneToIconName(tone)} size={11} />}
        >
          {associatedToneLabel(tone, t)}
        </Pill>
        {canManageAgent && (
          <button
            type="button"
            className="nav-icon-btn"
            title={t('kesp.common.deleteCall')}
            aria-label={t('kesp.common.deleteCall')}
            onClick={/** Handles the onClick interaction. */(event) => {
              event.stopPropagation();
              onRequestDelete(call);
            }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Renders a collapsible day section for the week and month associated-call views. */
function AssociatedCallsDaySection({
  section,
  collapsed,
  onToggle,
  navigate,
  returnTo,
  canManageAgent,
  onRequestDelete,
}: {
  section: AssociatedDaySectionData;
  collapsed: boolean;
  onToggle: (key: string) => void;
  navigate: NavigateFn;
  returnTo: string;
  canManageAgent: boolean;
  onRequestDelete: (call: Call) => void;
}) {
  const { t, i18n } = useTranslation();

  return (
    <section className="associated-day-section" data-today={section.isToday ? 'true' : undefined}>
      <button
        type="button"
        className="associated-day-head"
        aria-expanded={!collapsed}
        onClick={/** Handles the onClick interaction. */() => onToggle(section.key)}
      >
        <span className="associated-day-date-block">
          <b>{section.date.getDate()}</b>
          <span>{formatAssociatedWeekdayShort(section.date, i18n.resolvedLanguage)}</span>
        </span>
        <span className="associated-day-title">
          <span>
            {formatAssociatedDayTitle(section.date, i18n.resolvedLanguage)}
            {section.isToday && <Pill kind="info">{t('kesp.agent.upload.associated.todayLabel')}</Pill>}
          </span>
          <small>{t('kesp.agent.upload.associated.dayCount', { count: section.summary.total })}</small>
        </span>
        <div className="associated-head-metrics">
          <AssociatedStatusSummaryPills summary={section.summary} />
          {section.summary.total > 0 && (
            <AssociatedAverageScore
              summary={section.scoreSummary}
              label={t('kesp.agent.upload.associated.averageDay')}
            />
          )}
        </div>
        <Icon name={collapsed ? 'chevronDown' : 'chevronUp'} size={14} />
      </button>
      {!collapsed && (
        <div className="associated-day-body">
          {section.calls.length === 0 ? (
            <div className="associated-empty-inline">{t('kesp.agent.upload.associated.emptyDay')}</div>
          ) : (
            section.calls.map(/** Handles the callback for this operation. */(call) => (
              <AssociatedCallRow
                key={call.id}
                call={call}
                navigate={navigate}
                returnTo={returnTo}
                canManageAgent={canManageAgent}
                onRequestDelete={onRequestDelete}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

/** Renders the reorganized associated-calls panel for the Carga tab. */
function AssociatedCallsPanel({
  agent,
  calls,
  callsLoaded,
  snapshots,
  onRequestDelete,
  navigate,
  returnTo,
  canManageAgent,
}: {
  agent: AgentAnalysis;
  calls: Call[];
  callsLoaded: boolean;
  snapshots: AgentCallSnapshot[];
  onRequestDelete: (call: Call) => void;
  navigate: NavigateFn;
  returnTo: string;
  canManageAgent: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [selectedCallsTab, setActiveCallsTab] = useState<AssociatedCallsTab | null>(null);
  const activeCallsTab = selectedCallsTab ?? 'today';
  const demoMode = useKespDemoRedactionEnabled();
  const [today, setToday] = useState(/** Handles the callback for this operation. */() => new Date());
  const [visibleMonthKey, setVisibleMonthKey] = useState(
    /** Handles the callback for this operation. */() => localMonthKeyFromDate(new Date())
  );
  const [queryText, setQueryText] = useState('');
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [feedbackScoreByCallId, setFeedbackScoreByCallId] = useState<AssociatedScoreMap>(
    /** Handles the callback for this operation. */() => new Map()
  );
  const [collapsedDayKeys, setCollapsedDayKeys] = useState<Set<string>>(
    /** Handles the callback for this operation. */() => new Set()
  );

  useEffect(/** Handles the callback for this operation. */() => {
    const timer = window.setInterval(
      /** Handles the callback for this operation. */
      () => setToday(new Date()),
      60_000
    );
    return () => window.clearInterval(timer);
  }, []);

  const todayKey = localDateKeyFromDate(today);
  const currentMonthKey = localMonthKeyFromDate(today);
  const cappedVisibleMonthKey = visibleMonthKey > currentMonthKey ? currentMonthKey : visibleMonthKey;
  const visibleMonth = useMemo(
    /** Handles the callback for this operation. */
    () => parseLocalMonthKey(cappedVisibleMonthKey) ?? new Date(today.getFullYear(), today.getMonth(), 1),
    [cappedVisibleMonthKey, today]
  );
  const weekStartKey = localDateKeyFromDate(startOfLocalWeekMonday(today));
  const isCurrentMonth = cappedVisibleMonthKey === currentMonthKey;

  const orderedCalls = useMemo(
    /** Handles the callback for this operation. */
    () => sortAssociatedCalls(calls),
    [calls]
  );
  const snapshotScoreByCallId = useMemo(
    /** Handles the callback for this operation. */
    () => buildAssociatedScoreByCallId(snapshots),
    [snapshots]
  );
  const scoreByCallId = useMemo(
    /** Handles the callback for this operation. */
    () => mergeAssociatedScoreMaps(snapshotScoreByCallId, feedbackScoreByCallId),
    [feedbackScoreByCallId, snapshotScoreByCallId]
  );

  const filteredCalls = useMemo(
    /** Handles the callback for this operation. */
    () =>
      orderedCalls.filter(/** Handles the callback for this operation. */(call) => {
        if (onlyFailed && getAssociatedCallTone(call) !== 'failed') return false;
        return associatedCallMatchesSearch(call, queryText);
      }),
    [onlyFailed, orderedCalls, queryText]
  );

  const todayBaseCalls = useMemo(
    /** Handles the callback for this operation. */
    () => orderedCalls.filter(/** Handles the callback for this operation. */(call) => localDateKeyFromDate(callBusinessDate(call)) === todayKey),
    [orderedCalls, todayKey]
  );
  // Choose once, only after all authorized call queries have finished.
  if (callsLoaded && selectedCallsTab === null) {
    setActiveCallsTab(todayBaseCalls.length === 0 ? 'all' : 'today');
  }
  const weekBaseCalls = useMemo(
    /** Handles the callback for this operation. */
    () =>
      orderedCalls.filter(/** Handles the callback for this operation. */(call) => {
        const callKey = localDateKeyFromDate(callBusinessDate(call));
        return callKey >= weekStartKey && callKey <= todayKey;
      }),
    [orderedCalls, todayKey, weekStartKey]
  );
  const monthBaseCalls = useMemo(
    /** Handles the callback for this operation. */
    () =>
      orderedCalls.filter(/** Handles the callback for this operation. */(call) => {
        const callDateKey = localDateKeyFromDate(callBusinessDate(call));
        return localMonthKeyFromDate(callBusinessDate(call)) === cappedVisibleMonthKey && (!isCurrentMonth || callDateKey <= todayKey);
      }),
    [cappedVisibleMonthKey, isCurrentMonth, orderedCalls, todayKey]
  );

  const todayCalls = useMemo(
    /** Handles the callback for this operation. */
    () => filteredCalls.filter(/** Handles the callback for this operation. */(call) => localDateKeyFromDate(callBusinessDate(call)) === todayKey),
    [filteredCalls, todayKey]
  );
  const weekCalls = useMemo(
    /** Handles the callback for this operation. */
    () =>
      filteredCalls.filter(/** Handles the callback for this operation. */(call) => {
        const callKey = localDateKeyFromDate(callBusinessDate(call));
        return callKey >= weekStartKey && callKey <= todayKey;
      }),
    [filteredCalls, todayKey, weekStartKey]
  );
  const monthCalls = useMemo(
    /** Handles the callback for this operation. */
    () =>
      filteredCalls.filter(/** Handles the callback for this operation. */(call) => {
        const callDateKey = localDateKeyFromDate(callBusinessDate(call));
        return localMonthKeyFromDate(callBusinessDate(call)) === cappedVisibleMonthKey && (!isCurrentMonth || callDateKey <= todayKey);
      }),
    [cappedVisibleMonthKey, filteredCalls, isCurrentMonth, todayKey]
  );
  const activeScoreCalls = useMemo(
    /** Handles the callback for this operation. */
    () => {
      if (activeCallsTab === 'today') return todayCalls;
      if (activeCallsTab === 'week') return weekCalls;
      if (activeCallsTab === 'all') return filteredCalls;
      return monthCalls;
    },
    [activeCallsTab, filteredCalls, monthCalls, todayCalls, weekCalls]
  );

  useEffect(/** Handles the callback for this operation. */() => {
    const missingScoreCalls = activeScoreCalls
      .filter(/** Handles the callback for this operation. */(call) => {
        if (call.status !== 'complete') return false;
        if (associatedCallScore(call, snapshotScoreByCallId) != null) return false;
        return !feedbackScoreByCallId.has(call.id);
      });
    if (missingScoreCalls.length === 0) return;

    let cancelled = false;
    Promise.all(
      missingScoreCalls.map(/** Handles the callback for this operation. */async (call): Promise<[string, number | null]> => {
        try {
          /** Calls an external SDK or API dependency. */
          const feedback = await fetchFeedback(call.id);
          const score = feedback?.overall_score;
          return [call.id, isAssociatedScore(score) ? score : null];
        } catch (error) {
          console.error('Failed to fetch associated call score:', error);
          return [call.id, null];
        }
      })
    ).then(/** Handles the callback for this operation. */(results) => {
      if (cancelled) return;
      setFeedbackScoreByCallId(/** Handles the callback for this operation. */(current) => {
        const next = new Map(current);
        for (const [callId, score] of results) {
          next.set(callId, score);
        }
        return next;
      });
    });

    return /** Handles the callback for this operation. */() => {
      cancelled = true;
    };
  }, [activeScoreCalls, feedbackScoreByCallId, snapshotScoreByCallId]);

  const weekSections = useMemo(
    /** Handles the callback for this operation. */
    () =>
      buildCurrentWeekDates(today).map(/** Handles the callback for this operation. */(date) =>
        buildAssociatedDaySection(date, weekCalls, today, scoreByCallId)
      ),
    [scoreByCallId, today, weekCalls]
  );
  const monthSections = useMemo(
    /** Handles the callback for this operation. */
    () =>
      buildMonthDates(visibleMonth, today).map(/** Handles the callback for this operation. */(date) =>
        buildAssociatedDaySection(date, monthCalls, today, scoreByCallId)
      ),
    [monthCalls, scoreByCallId, today, visibleMonth]
  );

  const tabs: { id: AssociatedCallsTab; label: string; count: number }[] = [
    { id: 'today', label: t('kesp.agent.upload.associated.tabs.today'), count: todayBaseCalls.length },
    { id: 'week', label: t('kesp.agent.upload.associated.tabs.week'), count: weekBaseCalls.length },
    { id: 'month', label: t('kesp.agent.upload.associated.tabs.month'), count: monthBaseCalls.length },
    { id: 'all', label: t('kesp.agent.upload.associated.tabs.all'), count: orderedCalls.length },
  ];

  const toggleCollapsedDay = /** Handles the toggleCollapsedDay interaction. */ (key: string) => {
    setCollapsedDayKeys(/** Handles the callback for this operation. */(current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const shiftVisibleMonth = /** Handles the shiftVisibleMonth interaction. */ (monthDelta: number) => {
    const next = addLocalMonths(visibleMonth, monthDelta);
    const nextKey = localMonthKeyFromDate(next);
    if (nextKey > currentMonthKey) return;
    setVisibleMonthKey(nextKey);
  };

  const renderEmptyState = /** Documents the renderEmptyState behavior. */ (message: string) => (
    <div className="associated-empty-card">{message}</div>
  );

  const renderTodayView = /** Documents the renderTodayView behavior. */ () => {
    const summary = summarizeAssociatedCalls(todayCalls);
    const scoreSummary = summarizeAssociatedScores(todayCalls, scoreByCallId);
    return (
      <div className="associated-view">
        <div className="associated-view-head">
          <div>
            <h4>{formatAssociatedFullDate(today, i18n.resolvedLanguage)}</h4>
            <div className="associated-view-sub">{t('kesp.agent.upload.associated.dayCount', { count: summary.total })}</div>
          </div>
          <div className="associated-head-metrics">
            <AssociatedStatusSummaryPills summary={summary} />
            <AssociatedAverageScore
              summary={scoreSummary}
              label={t('kesp.agent.upload.associated.averageToday')}
            />
          </div>
        </div>
        {todayBaseCalls.length === 0
          ? renderEmptyState(t('kesp.agent.upload.associated.emptyToday'))
          : todayCalls.length === 0
            ? renderEmptyState(t('kesp.agent.upload.associated.emptyFiltered'))
            : todayCalls.map(/** Handles the callback for this operation. */(call) => (
              <AssociatedCallRow
                key={call.id}
                call={call}
                navigate={navigate}
                returnTo={returnTo}
                canManageAgent={canManageAgent}
                onRequestDelete={onRequestDelete}
              />
            ))}
      </div>
    );
  };

  const renderWeekView = /** Documents the renderWeekView behavior. */ () => (
    <div className="associated-view">
      <div className="associated-view-head">
        <div>
          <h4>{t('kesp.agent.upload.associated.tabs.week')}</h4>
          <div className="associated-view-sub">{t('kesp.agent.upload.associated.dayCount', { count: weekCalls.length })}</div>
        </div>
        <AssociatedStatusSummaryPills summary={summarizeAssociatedCalls(weekCalls)} />
      </div>
      {weekSections.map(/** Handles the callback for this operation. */(section) => (
        <AssociatedCallsDaySection
          key={section.key}
          section={section}
          collapsed={collapsedDayKeys.has(section.key)}
          onToggle={toggleCollapsedDay}
          navigate={navigate}
          returnTo={returnTo}
          canManageAgent={canManageAgent}
          onRequestDelete={onRequestDelete}
        />
      ))}
    </div>
  );

  const renderMonthView = /** Documents the renderMonthView behavior. */ () => {
    const summary = summarizeAssociatedCalls(monthCalls);
    const scoreSummary = summarizeAssociatedScores(monthCalls, scoreByCallId);
    return (
      <div className="associated-view">
        <div className="associated-month-head">
          <button
            type="button"
            className="nav-icon-btn associated-month-nav"
            aria-label={t('kesp.agent.upload.associated.previousMonth')}
            title={t('kesp.agent.upload.associated.previousMonth')}
            onClick={/** Handles the onClick interaction. */() => shiftVisibleMonth(-1)}
          >
            <Icon name="arrowLeft" size={14} />
          </button>
          <div className="associated-month-title">
            <div>
              <h4>{formatAssociatedMonthTitle(visibleMonth, today, i18n.resolvedLanguage)}</h4>
              {isCurrentMonth && <Pill kind="info">{t('kesp.agent.upload.associated.currentMonth')}</Pill>}
            </div>
            <small>{t('kesp.agent.upload.associated.monthTotal', { count: summary.total })}</small>
          </div>
          <div className="associated-head-metrics">
            <AssociatedStatusSummaryPills summary={summary} />
            <AssociatedAverageScore
              summary={scoreSummary}
              label={t('kesp.agent.upload.associated.averageMonth')}
            />
          </div>
          <button
            type="button"
            className="nav-icon-btn associated-month-nav"
            aria-label={t('kesp.agent.upload.associated.nextMonth')}
            title={t('kesp.agent.upload.associated.nextMonth')}
            disabled={isCurrentMonth}
            onClick={/** Handles the onClick interaction. */() => shiftVisibleMonth(1)}
          >
            <Icon name="arrow" size={14} />
          </button>
        </div>
        {monthBaseCalls.length === 0
          ? renderEmptyState(t('kesp.agent.upload.associated.emptyMonth'))
          : monthSections.map(/** Handles the callback for this operation. */(section) => (
            <AssociatedCallsDaySection
              key={section.key}
              section={section}
              collapsed={collapsedDayKeys.has(section.key)}
              onToggle={toggleCollapsedDay}
              navigate={navigate}
              returnTo={returnTo}
              canManageAgent={canManageAgent}
              onRequestDelete={onRequestDelete}
            />
          ))}
      </div>
    );
  };

  const renderAllView = /** Documents the renderAllView behavior. */ () => {
    const summary = summarizeAssociatedCalls(filteredCalls);
    const scoreSummary = summarizeAssociatedScores(filteredCalls, scoreByCallId);
    return (
      <div className="associated-view">
        <div className="associated-view-head">
          <div>
            <h4>{t('kesp.agent.upload.associated.allTitle')}</h4>
            <div className="associated-view-sub">{t('kesp.agent.upload.associated.allTotal', { count: summary.total })}</div>
          </div>
          <div className="associated-head-metrics">
            <AssociatedStatusSummaryPills summary={summary} />
            <AssociatedAverageScore
              summary={scoreSummary}
              label={t('kesp.agent.upload.associated.averageAll')}
            />
          </div>
        </div>
        {orderedCalls.length === 0
          ? renderEmptyState(t('kesp.agent.upload.empty'))
          : filteredCalls.length === 0
            ? renderEmptyState(t('kesp.agent.upload.associated.emptyFiltered'))
            : filteredCalls.map(/** Handles the callback for this operation. */(call) => (
              <AssociatedCallRow
                key={call.id}
                call={call}
                navigate={navigate}
                returnTo={returnTo}
                canManageAgent={canManageAgent}
                onRequestDelete={onRequestDelete}
              />
            ))}
      </div>
    );
  };

  return (
    <div className="card associated-calls-card" style={{ marginTop: 18 }}>
      <div className="row row-between associated-calls-titlebar">
        <div>
          <h3 className="card-h">{t('kesp.agent.upload.associatedTitle')}</h3>
          <div className="card-sub" style={{ marginBottom: 0 }}>
            {t('kesp.agent.upload.associatedDescription', {
              name: demoMode ? maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId) : agent.salesAgentName.split(' ')[0],
            })}
          </div>
        </div>
        <Button kind="ghost" size="sm" onClick={/** Handles the onClick interaction. */() => navigate('/kesp/llamadas')}>
          {t('kesp.agent.upload.viewAll')} <Icon name="arrow" size={12} />
        </Button>
      </div>

      <div className="associated-calls-tabs" role="tablist" aria-label={t('kesp.agent.upload.associated.tabsLabel')}>
        {tabs.map(/** Handles the callback for this operation. */(tabItem) => (
          <button
            key={tabItem.id}
            type="button"
            role="tab"
            className="associated-calls-tab"
            aria-selected={activeCallsTab === tabItem.id}
            onClick={/** Handles the onClick interaction. */() => setActiveCallsTab(tabItem.id)}
          >
            <span>{tabItem.label}</span>
            <b>{tabItem.count.toLocaleString(getKespLocale(i18n.resolvedLanguage))}</b>
          </button>
        ))}
      </div>

      <div className="associated-call-filters">
        <div className="search-input associated-call-search">
          <Icon name="search" size={14} />
          <input
            type="text"
            placeholder={t('kesp.agent.upload.associated.searchPlaceholder')}
            value={queryText}
            onChange={/** Handles the onChange interaction. */(event) => setQueryText(event.currentTarget.value)}
          />
        </div>
        <label className="associated-failed-toggle">
          <input
            type="checkbox"
            checked={onlyFailed}
            onChange={/** Handles the onChange interaction. */(event) => setOnlyFailed(event.currentTarget.checked)}
          />
          <span>{t('kesp.agent.upload.associated.onlyFailed')}</span>
        </label>
      </div>

      {activeCallsTab === 'today' && renderTodayView()}
      {activeCallsTab === 'week' && renderWeekView()}
      {activeCallsTab === 'month' && renderMonthView()}
      {activeCallsTab === 'all' && renderAllView()}
    </div>
  );
}

function CargaTab({
  agent,
  calls,
  callsLoaded,
  processing,
  snapshots,
  onTriggerReport,
  triggering,
  reportInProgress,
  onRequestDelete,
  navigate,
  returnTo,
  canManageAgent,
}: {
  agent: AgentAnalysis;
  calls: Call[];
  callsLoaded: boolean;
  processing: ReturnType<typeof useDemoProcessingStatus>;
  snapshots: AgentCallSnapshot[];
  onTriggerReport: () => void;
  triggering: boolean;
  reportInProgress: boolean;
  onRequestDelete: (call: Call) => void;
  navigate: NavigateFn;
  returnTo: string;
  canManageAgent: boolean;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const demoMode = useKespDemoRedactionEnabled();
  const [drag, setDrag] = useState(false);
  const [files, setFiles] = useState<
    (TranscriptionUploadSelection & { id: string; file: File; status: 'queued' | 'uploading' | 'uploaded' | 'error'; progress: number })[]
  >([]);
  const transcription = useTranscriptionUploadSelection();
  const [availablePrompts, setAvailablePrompts] = useState<AvailablePromptsResponse | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(/** Handles the callback for this operation. */() => {
    let cancelled = false;
    getAvailablePrompts()
      .then(/** Handles the callback for this operation. */(data) => {
        if (!cancelled) setAvailablePrompts(data);
      })
      .catch(/** Handles the callback for this operation. */() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const onPick = /** Handles the onPick interaction. */ async (list: FileList | null) => {
    if (!list || !user?.uid || transcription.loading || !processing.canStart) return;
    const next: typeof files = [];
    for (const file of Array.from(list)) {
      const validation = validateAudioFile(file);
      if (!validation.valid) {
        toast.error(t('kesp.upload.toasts.uploadError', { file: demoMode ? maskKespDemoCallString(file.name) : file.name, error: validation.error }));
        continue;
      }
      next.push({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        ...transcription.snapshot(),
        status: 'queued',
        progress: 0,
      });
    }
    if (next.length === 0) return;
    setFiles(/** Handles the callback for this operation. */(prev) => [...prev, ...next]);
    const validatedPromptSettings = availablePrompts
      ? validateKespUploadPromptSettings(loadKespUploadPromptSettings(), availablePrompts)
      : {};

    for (const item of next) {
      if (!(await processing.checkCanStart())) {
        setFiles((prev) => prev.map((file) => file.status === 'queued' ? { ...file, status: 'error' } : file));
        break;
      }
      setFiles(/** Handles the callback for this operation. */(prev) =>
        prev.map(/** Handles the callback for this operation. */(f) => (f.id === item.id ? { ...f, status: 'uploading', progress: 0 } : f))
      );
      try {
        await uploadAudioFile({
          file: item.file,
          transcriptionModel: item.transcriptionModel,
          transcriptionComparison: item.transcriptionComparison,
          category: 'unknown',
          userId: user.uid,
          salesAgentId: agent.salesAgentId,
          salesAgentName: agent.salesAgentName,
          ...(item.transcriptionModel ? { agentAnalysisId: agent.id, agentRoutingMode: 'specific' as const } : {}),
          analyzerModel:
            validatedPromptSettings.analyzerModel ??
            agent.callProcessingConfig?.analyzerModel ??
            availablePrompts?.analyzerModels?.default,
          analyzerModelOverrides: validatedPromptSettings.analyzerModelOverrides,
          promptVersions:
            agent.callProcessingConfig?.promptVersions ??
            availablePrompts?.defaults,
          activityPromptVersions: validatedPromptSettings.activityPromptVersions,
          onProgress: /** Handles the onProgress interaction. */ (p: UploadProgress) => {
            setFiles(/** Handles the callback for this operation. */(prev) =>
              prev.map(/** Handles the callback for this operation. */(f) => (f.id === item.id ? { ...f, progress: p.progress } : f))
            );
          },
        });
        setFiles(/** Handles the callback for this operation. */(prev) =>
          prev.map(/** Handles the callback for this operation. */(f) =>
            f.id === item.id ? { ...f, status: 'uploaded', progress: 100 } : f
          )
        );
      } catch (err) {
        console.error(`Failed to upload ${item.file.name}:`, err);
        setFiles(/** Handles the callback for this operation. */(prev) =>
          prev.map(/** Handles the callback for this operation. */(f) => (f.id === item.id ? { ...f, status: 'error' } : f))
        );
        toast.error(t('kesp.agent.upload.uploadError', { file: demoMode ? maskKespDemoCallString(item.file.name) : item.file.name }));
      }
    }
  };

  return (
    <div className="rise">
      {(canManageAgent || transcription.canSelect) && (
      <div className="kpi-grid kpi-grid-2" style={{ marginBottom: 16 }}>
        <div>
          <div className="hero-card" style={{ padding: '30px 32px' }}>
            <div className="hero-eyebrow">{t('kesp.agent.upload.step1')}</div>
            <UploadAnalyzerSettingsButton catalog={availablePrompts} disabled={files.some(/** Locks settings during an active upload batch. */ (file) => file.status === 'uploading' || file.status === 'queued')} />
            <h2 className="hero-title" style={{ marginBottom: 18 }}>
              {t('kesp.agent.upload.uploadCalls')}{' '}
              <span style={{ fontStyle: 'normal', fontSize: 28 }}>
                {t('kesp.agent.upload.ofAgent', { name: demoMode ? maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId) : agent.salesAgentName.split(' ')[0] })}
              </span>
            </h2>
            {transcription.canSelect && <TranscriptionUploadSelector
              model={transcription.model} comparison={transcription.comparison} canCompare={transcription.canCompare}
              onChange={transcription.onChange} />}
            <div
              className={'upload-zone' + (drag ? ' drag' : '')}
              aria-busy={transcription.loading}
              aria-disabled={!processing.canStart}
              onDragOver={/** Handles the onDragOver interaction. */ (e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={/** Handles the onDragLeave interaction. */ () => setDrag(false)}
              onDrop={/** Handles the onDrop interaction. */ (e) => {
                e.preventDefault();
                setDrag(false);
                onPick(e.dataTransfer.files);
              }}
              onClick={/** Wait for TEST privileges before selecting audio. */ () => {
                if (!transcription.loading && processing.canStart) fileRef.current?.click();
              }}
              style={{ padding: '36px 20px', marginTop: 16, background: 'transparent' }}
            >
              <Icon name="upload" size={28} />
              <div className="help" style={{ marginTop: 10 }}>
                {t('kesp.agent.upload.drop')}
              </div>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="audio/*"
                hidden
                disabled={transcription.loading || !processing.canStart}
                onChange={(e) => {
                  const picked = e.currentTarget.files;
                  onPick(picked);
                  e.currentTarget.value = '';
                }}
              />
            </div>
            {files.length > 0 && (
              <div style={{ marginTop: 18 }}>
                {files.map(/** Handles the callback for this operation. */(f) => (
                  <div key={f.id} className="row" style={{ padding: '6px 0', gap: 12 }}>
                    <Icon name="file" size={14} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12.5,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {demoMode ? maskKespDemoCallString(f.file.name) : f.file.name}
                      </div>
                      {f.transcriptionModel && <div className="muted tiny" style={{ overflowWrap: 'anywhere' }}>
                        {transcriptionModelLabel(f.transcriptionModel)}
                        {f.transcriptionComparison ? ` / ${t('kesp.transcriptionUpload.comparison')}` : ''}
                      </div>}
                      <div className="progress-track" style={{ marginTop: 4 }}>
                        <div className="progress-fill" style={{ width: f.progress + '%' }} />
                      </div>
                    </div>
                    {f.status === 'uploaded' ? (
                      <Pill kind="good" icon={<Icon name="check" size={11} />}>
                        {t('kesp.common.uploaded')}
                      </Pill>
                    ) : f.status === 'uploading' ? (
                      <Pill kind="info">{Math.round(f.progress)}%</Pill>
                    ) : f.status === 'error' ? (
                      <Pill kind="bad" icon={<Icon name="x" size={11} />}>
                        {t('kesp.common.error')}
                      </Pill>
                    ) : (
                      <Pill kind="default">{t('kesp.common.queued')}</Pill>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="card" style={{ padding: 26 }}>
            <div className="hero-eyebrow" style={{ color: 'var(--ink-3)' }}>
              {t('kesp.agent.upload.step2')}
            </div>
            <h3 className="card-h" style={{ fontSize: 20, marginTop: 4 }}>
              {t('kesp.agent.upload.generateTitle')}
            </h3>
            <p className="muted small" style={{ margin: '6px 0 16px' }}>
              {t('kesp.agent.upload.generateDescription')}
            </p>
            <div className="row" style={{ gap: 8, marginBottom: 14 }}>
              <div className="chip">
                <Icon name="file" size={12} /> {t('kesp.agent.upload.callCount', { count: calls.length })}
              </div>
              <div className="chip">
                <Icon name="clock" size={12} /> ~{Math.max(2, Math.ceil(calls.length / 10) * 2)} min
              </div>
            </div>
            <Button
              kind="primary"
              className="btn-block btn-lg"
              icon={<Icon name="bulb" size={14} />}
              onClick={onTriggerReport}
              disabled={triggering || reportInProgress || calls.length === 0 || !processing.canStart}
            >
              {reportInProgress
                ? t('kesp.agent.upload.analyzing')
                : triggering
                  ? t('kesp.agent.upload.starting')
                  : t('kesp.agent.upload.generate')}
            </Button>
            {reportInProgress && (
              <div className="muted tiny" style={{ marginTop: 12, textAlign: 'center' }}>
                {t('kesp.agent.upload.updating')}
              </div>
            )}
            {calls.length === 0 && (
              <div className="muted tiny" style={{ marginTop: 12, textAlign: 'center' }}>
                {t('kesp.agent.upload.needCalls')}
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      <AssociatedCallsPanel
        key={agent.id}
        agent={agent}
        calls={calls}
        callsLoaded={callsLoaded}
        snapshots={snapshots}
        onRequestDelete={onRequestDelete}
        navigate={navigate}
        returnTo={returnTo}
        canManageAgent={canManageAgent}
      />
    </div>
  );
}

// ─── PatternCard for Reporte tab ─────────────────────────────────────────────
type AffectedPatternCall = {
  callId: string;
  displayName: string;
  category?: CallCategory | string | null;
  score?: number | null;
  occurredAt?: Date | null;
  context?: string | null;
  observedFragment?: string | null;
  whatShouldHaveDone?: string | null;
  whyItHelps?: string | null;
  quote?: string | null;
  speaker?: string | null;
};

type CoachingBlock = {
  key: 'when' | 'say' | 'why' | 'avoid' | 'next';
  label: string;
  body: string;
  icon: IconName;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  quote?: boolean;
};

/** Documents the normalizeExampleHeuristicText behavior. */
function normalizeExampleHeuristicText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Documents the looksActionOnlyPatternResponse behavior. */
function looksActionOnlyPatternResponse(value: string): boolean {
  const normalized = normalizeExampleHeuristicText(value);
  if (!normalized) return true;

  const actionAdvicePrefixes = [
    'debio ',
    'debiste ',
    'debe ',
    'deberia ',
    'habia que ',
    'hay que ',
    'se debe ',
    'se debio ',
    'tenia que ',
    'tiene que ',
    'validar ',
    'reconocer ',
    'explicar ',
    'explorar ',
    'preguntar ',
    'pedir ',
    'confirmar ',
    'acordar ',
    'proponer ',
    'cerrar ',
    'evitar ',
    'mantener ',
    'dar seguimiento ',
  ];

  return (
    actionAdvicePrefixes.some(/** Handles the callback for this operation. */(prefix) => normalized.startsWith(prefix)) ||
    /\b(el|la) agente (debe|debio|deberia|tenia que|tiene que)\b/.test(normalized)
  );
}

/** Documents the hasEllipsisLikePatternText behavior. */
function hasEllipsisLikePatternText(value: string): boolean {
  return /…|\.{2,}/.test(value);
}

/** Documents the isUsablePatternExampleText behavior. */
function isUsablePatternExampleText(value: string | null | undefined): value is string {
  const trimmed = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return (
    trimmed.length >= 12 &&
    trimmed.split(/\s+/).filter(Boolean).length >= 3 &&
    !hasEllipsisLikePatternText(trimmed)
  );
}

/** Documents the isUsablePatternResponsePhrase behavior. */
function isUsablePatternResponsePhrase(value: string | null | undefined): value is string {
  const trimmed = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return (
    isUsablePatternExampleText(trimmed) &&
    !looksActionOnlyPatternResponse(trimmed) &&
    !hasEllipsisLikePatternText(trimmed)
  );
}

/** Documents the isCompletePatternExampleCall behavior. */
function isCompletePatternExampleCall(value: AffectedPatternCall): boolean {
  return (
    Boolean(value.callId) &&
    isUsablePatternExampleText(value.observedFragment) &&
    isUsablePatternResponsePhrase(value.whatShouldHaveDone) &&
    isUsablePatternExampleText(value.whyItHelps)
  );
}

type PatternRunTasksState = {
  runId: string;
  tasks: AgentAnalysisRunTask[];
  error: boolean;
};

/** Documents the readObject behavior. */
function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Documents the deriveCallIdFromBehaviorSignalId behavior. */
function deriveCallIdFromBehaviorSignalId(signalId: string): string | null {
  const match = signalId.match(/^(.+):[^:]+:\d+$/);
  return match?.[1] ?? null;
}

/** Documents the buildSignalCallIdMap behavior. */
function buildSignalCallIdMap(tasks: AgentAnalysisRunTask[]): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const task of tasks) {
    const payload = readObject(task.inputPayload);
    const signals = Array.isArray(payload?.behaviorSignals) ? payload.behaviorSignals : [];
    for (const signal of signals) {
      const rawSignal = readObject(signal);
      const signalId = typeof rawSignal?.signalId === 'string' ? rawSignal.signalId : '';
      const callId = typeof rawSignal?.callId === 'string' ? rawSignal.callId : '';
      if (signalId && callId && !mapping.has(signalId)) {
        mapping.set(signalId, callId);
      }
    }
  }
  return mapping;
}

/** Documents the buildPatternTaskCallIds behavior. */
function buildPatternTaskCallIds(
  pattern: BehaviorPattern,
  signalCallIdMap: Map<string, string>
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = /** Documents the add behavior. */ (callId: string | null | undefined) => {
    if (!callId || seen.has(callId)) return;
    seen.add(callId);
    ids.push(callId);
  };

  for (const signalId of pattern.relatedSignalIds ?? []) {
    add(signalCallIdMap.get(signalId) ?? deriveCallIdFromBehaviorSignalId(signalId));
  }
  for (const example of pattern.examples ?? []) add(example.callId);
  for (const evidence of pattern.supportingEvidence ?? []) add(evidence.callId);
  for (const callId of pattern.sourceCallIds ?? []) add(callId);

  return ids;
}

/** Documents the buildMentorshipPlanSteps behavior. */
function buildMentorshipPlanSteps(pattern: BehaviorPattern): string[] {
  const steps: string[] = [];
  const seen = new Set<string>();
  const add = /** Documents the add behavior. */ (value: string | null | undefined) => {
    const text = value?.trim();
    if (!text) return;
    const key = text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    steps.push(text);
  };

  for (const tip of pattern.mentorshipTips ?? []) add(tip.tip);
  if (steps.length === 0) add(pattern.coachingFocus);

  return steps.slice(0, 5);
}

/** Documents the firstUsablePatternWhy behavior. */
function firstUsablePatternWhy(pattern: BehaviorPattern): string {
  const directWhy = pattern.executionGuide?.whyItWorks?.trim();
  if (directWhy) return directWhy;
  const example = (pattern.examples ?? []).find(
    /** Handles the callback for this operation. */
    (item) => isUsablePatternExampleText(item.whyItHelps)
  );
  return example?.whyItHelps?.trim() ?? '';
}

/** Documents the formatPatternCallDate behavior. */
function formatPatternCallDate(date: Date | null | undefined, language: string | undefined): string | null {
  if (!date) return null;
  return formatKespDate(date, language, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Renders the PatternCard component. */
function PatternCard({
  pattern,
  rank,
  calls,
  snapshots,
  fallbackCallIds,
  fallbackLoading,
  fallbackError,
  navigate,
  returnTo,
  cardRef,
  onDownload,
  downloadDisabled,
  downloading,
}: {
  pattern: BehaviorPattern;
  rank: number;
  calls: Call[];
  snapshots: AgentCallSnapshot[];
  fallbackCallIds?: string[];
  fallbackLoading?: boolean;
  fallbackError?: boolean;
  navigate: NavigateFn;
  returnTo: string;
  cardRef?: (node: HTMLDivElement | null) => void;
  onDownload: () => void;
  downloadDisabled?: boolean;
  downloading?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const demoMode = useKespDemoRedactionEnabled();
  const [showExamples, setShowExamples] = useState(false);
  const [showRest, setShowRest] = useState(false);
  const [showAllPracticeExamples, setShowAllPracticeExamples] = useState(false);

  const total = pattern.totalCallCount || 0;
  const prio = priorityBucket(pattern.priorityScore);
  const executionSayThis = pattern.executionGuide?.sayThis ?? '';
  const fallbackWhatShouldHaveSaid = isUsablePatternResponsePhrase(executionSayThis)
    ? executionSayThis.replace(/\s+/g, ' ').trim()
    : '';
  const fallbackWhyItHelps = fallbackWhatShouldHaveSaid
    ? t('kesp.agent.report.fallbackWhyHelps')
    : '';
  const callById = useMemo(/** Handles the callback for this operation. */() => new Map(calls.map(/** Handles the callback for this operation. */(call) => [call.id, call])), [calls]);
  const snapshotByCallId = useMemo(
    /** Handles the callback for this operation. */
    () => new Map(snapshots.map(/** Handles the callback for this operation. */(snapshot) => [snapshot.sourceCallId, snapshot])),
    [snapshots]
  );
  const affectedCalls = useMemo(/** Handles the callback for this operation. */() => {
    const examples = pattern.examples ?? [];
    const evidence = pattern.supportingEvidence ?? [];
    const byCall = new Map<string, AffectedPatternCall>();
    const buildCall = /** Documents the buildCall behavior. */ (
      callId: string,
      previous?: Partial<AffectedPatternCall>
    ): AffectedPatternCall => {
      const snapshot = snapshotByCallId.get(callId);
      const call = callById.get(callId);
      const displayName =
        snapshot?.customerName ??
        snapshot?.callName ??
        call?.displayName ??
        call?.name ??
        `${t('kesp.criterion.backCall')} ${callId.slice(0, 12)}...`;
      return {
        callId,
        displayName,
        category: snapshot?.callCategory ?? call?.category ?? null,
        score: snapshot?.overallScore ?? null,
        occurredAt: snapshot?.callOccurredAt ?? (call ? callBusinessDate(call) : null),
        context: previous?.context ?? snapshot?.lastCallSummary ?? null,
        observedFragment: previous?.observedFragment ?? null,
        whatShouldHaveDone: previous?.whatShouldHaveDone ?? null,
        whyItHelps: previous?.whyItHelps ?? null,
        quote: previous?.quote ?? null,
        speaker: previous?.speaker ?? null,
      };
    };

    for (const ex of examples) {
      if (!ex.callId) continue;
      byCall.set(ex.callId, buildCall(ex.callId, {
        context: ex.context,
        observedFragment: ex.observedFragment,
        whatShouldHaveDone: ex.whatShouldHaveDone,
        whyItHelps: ex.whyItHelps ?? null,
      }));
    }
    for (const ev of evidence) {
      if (!ev.callId) continue;
      const previous = byCall.get(ev.callId);
      byCall.set(ev.callId, buildCall(ev.callId, {
        context: previous?.context,
        observedFragment: previous?.observedFragment ?? ev.quote,
        whatShouldHaveDone: previous?.whatShouldHaveDone ?? fallbackWhatShouldHaveSaid,
        whyItHelps: previous?.whyItHelps ?? fallbackWhyItHelps,
        quote: null,
        speaker: previous?.speaker ?? ev.speakerDisplay ?? ev.speakerLabel ?? t('kesp.common.agentFallback'),
      }));
    }
    for (const callId of pattern.sourceCallIds ?? []) {
      if (!byCall.has(callId)) byCall.set(callId, buildCall(callId));
    }
    for (const callId of fallbackCallIds ?? []) {
      if (!byCall.has(callId)) byCall.set(callId, buildCall(callId));
    }
    return Array.from(byCall.values()).filter(isCompletePatternExampleCall);
  }, [
    callById,
    fallbackWhatShouldHaveSaid,
    fallbackWhyItHelps,
    fallbackCallIds,
    pattern.examples,
    pattern.sourceCallIds,
    pattern.supportingEvidence,
    snapshotByCallId,
    t,
  ]);
  const displaySeen = affectedCalls.length;
  const pct = total > 0 ? Math.round((displaySeen / total) * 100) : 0;
  const visibleAffectedCalls = showRest ? affectedCalls : affectedCalls.slice(0, 6);
  const hiddenCount = Math.max(0, affectedCalls.length - 6);

  const fixSay = pattern.executionGuide?.sayThis ?? '';
  const fixAvoid = pattern.executionGuide?.avoidThis ?? '';
  const fixWhen = pattern.executionGuide?.whenToUse ?? '';
  const fixWhy = firstUsablePatternWhy(pattern);
  const fixNext = pattern.executionGuide?.nextStep ?? '';
  const planSteps = buildMentorshipPlanSteps(pattern);
  const downloadLabel = downloading
    ? t('kesp.agent.report.downloadPatternPreparing')
    : t('kesp.agent.report.downloadPattern');
  const rawCoachingBlocks: CoachingBlock[] = [
    {
      key: 'when',
      label: t('kesp.agent.report.whenUse'),
      body: fixWhen,
      icon: 'clock',
      tone: 'neutral',
    },
    {
      key: 'say',
      label: t('kesp.agent.report.sayThis'),
      body: fixSay,
      icon: 'msg',
      tone: 'good',
      quote: true,
    },
    {
      key: 'why',
      label: t('kesp.agent.report.whyWorks'),
      body: fixWhy,
      icon: 'bulb',
      tone: 'neutral',
    },
    {
      key: 'avoid',
      label: t('kesp.agent.report.avoidThis'),
      body: fixAvoid,
      icon: 'x',
      tone: 'bad',
    },
    {
      key: 'next',
      label: t('kesp.agent.report.nextStep'),
      body: fixNext,
      icon: 'flag',
      tone: 'warn',
    },
  ];
  const coachingBlocks = rawCoachingBlocks.filter(
    /** Handles the callback for this operation. */
    (block) => block.body.trim().length > 0
  );
  const basePracticeExampleCount = 2;
  const practiceHiddenCount = Math.max(0, affectedCalls.length - basePracticeExampleCount);
  const practiceExamples = showAllPracticeExamples
    ? affectedCalls
    : affectedCalls.slice(0, basePracticeExampleCount);
  const practiceToggleLabel = showAllPracticeExamples
    ? t('kesp.agent.report.practiceLess', { count: practiceHiddenCount })
    : t('kesp.agent.report.practiceMore', { count: practiceHiddenCount });

  /** Opens or closes the affected-call panel and reveals all practice examples when opening. */
  const handleAffectedCallsToggle = useCallback(
    /** Handles the affected-call count button interaction. */
    () => {
      const shouldShowExamples = !showExamples;
      setShowExamples(shouldShowExamples);
      if (shouldShowExamples) {
        setShowAllPracticeExamples(true);
      }
    },
    [showExamples]
  );

  /** Shows or hides the additional practice examples inside the coaching section. */
  const handlePracticeExamplesToggle = useCallback(
    /** Handles the practice examples toggle interaction. */
    () => {
      setShowAllPracticeExamples(!showAllPracticeExamples);
    },
    [showAllPracticeExamples]
  );

  const renderAffectedCallsPanel = /** Documents the renderAffectedCallsPanel behavior. */ () => (
    <div className="pc-examples pc-examples-inline">
      <div className="pc-ex-open-head">
        <div>
          <div className="pc-ex-open-title">{t('kesp.agent.report.callsWhere')}</div>
          <div className="pc-ex-open-sub">
            {affectedCalls.length > 0
              ? t('kesp.agent.report.found', { count: affectedCalls.length })
              : fallbackLoading
                ? t('kesp.agent.report.searching')
                : t('kesp.agent.report.noCalls')}
          </div>
        </div>
        <button
          type="button"
          className="pc-ex-close"
          onClick={() => setShowExamples(false)}
          aria-label={t('kesp.agent.report.hideCalls')}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      {fallbackLoading && affectedCalls.length === 0 ? (
        <div className="pc-ex-empty">{t('kesp.agent.report.loadingLinked')}</div>
      ) : affectedCalls.length === 0 ? (
        <div className="pc-ex-empty">
          {fallbackError
            ? t('kesp.agent.report.loadDetailsError')
            : t('kesp.agent.report.noSavedBreakdown')}
        </div>
      ) : (
        <div className="pc-ex-list">
          {visibleAffectedCalls.map(/** Handles the callback for this operation. */(ex: AffectedPatternCall, i) => (
            <button
              key={`${ex.callId}-${i}`}
              type="button"
              className="pc-ex-card"
              onClick={() =>
                navigate(appendReturnTo(`/kesp/call/${encodeURIComponent(ex.callId)}`, returnTo))}
            >
              <div className="pc-ex-head">
                <div className="pc-ex-avatar">{ex.displayName.charAt(0).toUpperCase()}</div>
                <div className="pc-ex-meta-block">
                  <div className="pc-ex-client">{ex.displayName}</div>
                  <div className="muted small">
                    {formatPatternCallDate(ex.occurredAt, i18n.resolvedLanguage)}
                    {typeof ex.score === 'number' ? ` · ${t('kesp.common.generatedContent.score')} ${Math.round(ex.score)}` : ''}
                    {ex.category ? ` · ${categoryLabel(String(ex.category), t)}` : ''}
                  </div>
                </div>
                <span className="pc-ex-link">
                  {t('kesp.agent.report.openCall')} <Icon name="arrow" size={11} />
                </span>
              </div>
              <div className="pc-ex-quotes">
                {ex.observedFragment && (
                  <div className="pc-ex-quote-row pc-ex-quote-bad">
                    <div className="pc-ex-quote-tag">{t('kesp.agent.report.said')}</div>
                    <div className="pc-ex-quote-text">
                      "{demoMode ? maskKespDemoEvidenceText() : ex.observedFragment}" {ex.speaker && !demoMode && <span className="muted small">— {ex.speaker}</span>}
                    </div>
                  </div>
                )}
                {ex.whatShouldHaveDone && (
                  <div className="pc-ex-quote-row pc-ex-quote-good">
                    <div className="pc-ex-quote-tag">{t('kesp.agent.report.shouldHaveSaid')}</div>
                    <div className="pc-ex-quote-text">"{demoMode ? redactKespDemoText(ex.whatShouldHaveDone) : ex.whatShouldHaveDone}"</div>
                  </div>
                )}
                {ex.whyItHelps && (
                  <div className="pc-ex-quote-row">
                    <div className="pc-ex-quote-tag">{t('kesp.agent.report.whyHelps')}</div>
                    <div className="pc-ex-quote-text">{demoMode ? redactKespDemoText(ex.whyItHelps) : ex.whyItHelps}</div>
                  </div>
                )}
              </div>
            </button>
          ))}

          {hiddenCount > 0 && (
            <div className="pc-rest">
              <button
                type="button"
                className="pc-rest-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowRest(/** Handles the callback for this operation. */(v) => !v);
                }}
              >
                <Icon name={showRest ? 'chevronUp' : 'chevronDown'} size={12} />
                <span>
                  {showRest ? t('kesp.agent.report.hide') : t('kesp.agent.report.show')}{' '}
                  {t('kesp.agent.report.remainingCalls', { count: hiddenCount })}
                </span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div ref={cardRef} className="pattern-card" data-prio={prio} data-pdf-export-root="true">
      <Button
        kind="ghost"
        className="btn-icon pdf-download-btn pattern-download-btn"
        data-pdf-exclude="true"
        aria-label={downloadLabel}
        title={downloadLabel}
        onClick={/** Handles the onClick interaction. */(event) => {
          event.stopPropagation();
          onDownload();
        }}
        disabled={downloadDisabled}
      >
        <Icon name="download" size={14} />
      </Button>
      <div className="pc-strip">
        <div className="pc-strip-num">{String(rank).padStart(2, '0')}</div>
        <div className="pc-strip-label">{priorityLabel(prio, t)}</div>
      </div>

      <div className="pc-body">
        <div className="pc-hero">
          <div className="pc-hero-meta">
            <span className="pc-pct">
              <b>{pct}%</b>
              <span>{t('kesp.agent.report.percentText')}</span>
            </span>
            <span className="pc-dot" />
            <button
              type="button"
              className="pc-count-link"
              onClick={handleAffectedCallsToggle}
              aria-expanded={showExamples}
              title={t('kesp.agent.report.countTitle')}
            >
              {t('kesp.agent.report.countButton', { seen: displaySeen, total })}
            </button>
          </div>
          <h3 className="pc-title">{pattern.patternName}</h3>
          {pattern.behaviorSummary && <p className="pc-tldr">{pattern.behaviorSummary}</p>}
        </div>

        {showExamples && renderAffectedCallsPanel()}

        {(pattern.whenItHappens || pattern.businessImpact) && (
          <div className="pc-grid">
            {pattern.whenItHappens && (
              <div className="pc-col">
                <div className="pc-col-icon" data-kind="what">
                  <Icon name="search" size={14} />
                </div>
                <div className="pc-col-label">{t('kesp.agent.report.whatHappening')}</div>
                <p className="pc-col-body">{pattern.whenItHappens}</p>
              </div>
            )}
            {pattern.businessImpact && (
              <div className="pc-col">
                <div className="pc-col-icon" data-kind="why">
                  <Icon name="trend" size={14} />
                </div>
                <div className="pc-col-label">{t('kesp.agent.report.whyCostSales')}</div>
                <p className="pc-col-body">{pattern.businessImpact}</p>
              </div>
            )}
          </div>
        )}

        {(planSteps.length > 0 || coachingBlocks.length > 0 || practiceExamples.length > 0) && (
          <div className="pc-coaching-block">
            <div className="pc-block-head">
              <div className="pc-block-eyebrow">{t('kesp.agent.report.coachingEyebrow')}</div>
              <h4>{t('kesp.agent.report.fixTitle')}</h4>
            </div>

            {coachingBlocks.length > 0 && (
              <div className="pc-coaching-grid">
                {coachingBlocks.map(
                  /** Handles the callback for this operation. */
                  (block) => (
                    <div key={block.key} className="pc-coaching-card" data-tone={block.tone}>
                      <div className="pc-coaching-label">
                        <Icon name={block.icon} size={12} /> {block.label}
                      </div>
                      <div className="pc-coaching-text">
                        {block.quote ? `"${block.body}"` : block.body}
                      </div>
                    </div>
                  )
                )}
              </div>
            )}

            {planSteps.length > 0 && (
              <div className="pc-steps-panel">
                <div className="pc-mini-title">{t('kesp.agent.report.plan')}</div>
                <ol className="pc-steps">
                  {planSteps.map(/** Handles the callback for this operation. */(s, i) => (
                    <li key={i}>
                      <div className="pc-step-n">{i + 1}</div>
                      <div className="pc-step-text">{s}</div>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {practiceExamples.length > 0 && (
              <div className="pc-practice-panel">
                <div className="pc-mini-title">{t('kesp.agent.report.practiceTitle')}</div>
                <div className="pc-practice-list">
                  {practiceExamples.map(
                    /** Handles the callback for this operation. */
                    (ex, i) => (
                      <button
                        key={`${ex.callId}-practice-${i}`}
                        type="button"
                        className="pc-practice-card"
                        onClick={() =>
                          navigate(appendReturnTo(`/kesp/call/${encodeURIComponent(ex.callId)}`, returnTo))}
                      >
                        <div className="pc-practice-head">
                          <span>{ex.displayName}</span>
                          <Icon name="arrow" size={11} />
                        </div>
                        {ex.observedFragment && (
                          <div className="pc-practice-row" data-kind="bad">
                            <span>{t('kesp.agent.report.said')}</span>
                            <p>"{demoMode ? maskKespDemoEvidenceText() : ex.observedFragment}"</p>
                          </div>
                        )}
                        {ex.whatShouldHaveDone && (
                          <div className="pc-practice-row" data-kind="good">
                            <span>{t('kesp.agent.report.shouldHaveSaid')}</span>
                            <p>"{demoMode ? redactKespDemoText(ex.whatShouldHaveDone) : ex.whatShouldHaveDone}"</p>
                          </div>
                        )}
                        {ex.whyItHelps && (
                          <div className="pc-practice-row">
                            <span>{t('kesp.agent.report.whyHelps')}</span>
                            <p>{ex.whyItHelps}</p>
                          </div>
                        )}
                      </button>
                    )
                  )}
                </div>
              </div>
            )}

            {practiceHiddenCount > 0 && (
              <button
                type="button"
                className="pc-practice-more"
                onClick={handlePracticeExamplesToggle}
                aria-expanded={showAllPracticeExamples}
              >
                {practiceToggleLabel}
                <Icon name={showAllPracticeExamples ? 'chevronUp' : 'chevronDown'} size={12} />
              </button>
            )}
          </div>
        )}

        {(fixSay || fixAvoid) && coachingBlocks.length === 0 && (
          <div className="pc-compare">
            <div className="pc-compare-side pc-compare-bad">
              <div className="pc-compare-tag">
                <Icon name="x" size={11} /> {t('kesp.agent.report.saysNow')}
              </div>
              <div className="pc-compare-quote">{fixAvoid ? `"${demoMode ? maskKespDemoEvidenceText() : fixAvoid}"` : '—'}</div>
            </div>
            <div className="pc-compare-arrow">
              <Icon name="arrow" size={14} />
            </div>
            <div className="pc-compare-side pc-compare-good">
              <div className="pc-compare-tag">
                <Icon name="check" size={11} /> {t('kesp.agent.report.shouldSay')}
              </div>
              <div className="pc-compare-quote">{fixSay ? `"${demoMode ? redactKespDemoText(fixSay) : fixSay}"` : '—'}</div>
            </div>
          </div>
        )}
        {fixWhen && coachingBlocks.length === 0 && (
          <div className="pc-when">
            <Icon name="clock" size={12} /> <b>{t('kesp.agent.report.when')}</b> {fixWhen}
          </div>
        )}
      </div>
    </div>
  );
}


/** Documents the aggregateTrendLabel behavior. */
function aggregateTrendLabel(trend: AggregateRubricTrend, delta: number | null, t: TFunction): string {
  if (trend === 'insufficient') return t('kesp.agent.aggregateRubric.trend.insufficient');
  if (trend === 'stable') return t('kesp.agent.aggregateRubric.trend.stable');
  const formattedDelta = delta == null ? '' : Math.abs(delta).toFixed(0);
  return trend === 'improving'
    ? t('kesp.agent.aggregateRubric.trend.improving', { delta: formattedDelta })
    : t('kesp.agent.aggregateRubric.trend.declining', { delta: formattedDelta });
}

/** Renders the AggregateTrendPill component. */
function AggregateTrendPill({ metric }: { metric: AggregateRubricMetric }) {
  const { t } = useTranslation();
  const kind: PillKind =
    metric.trend === 'improving'
      ? 'good'
      : metric.trend === 'declining'
        ? 'bad'
        : metric.trend === 'stable'
          ? 'default'
          : 'warn';
  return <Pill kind={kind}>{aggregateTrendLabel(metric.trend, metric.trendDeltaPercent, t)}</Pill>;
}

/** Documents the aggregatePriorityPillKind behavior. */
function aggregatePriorityPillKind(bucket: AggregateRubricPriorityBucket): PillKind {
  if (bucket === 'priority') return 'bad';
  if (bucket === 'watch') return 'warn';
  if (bucket === 'coverage') return 'info';
  return 'good';
}

/** Documents the aggregatePriorityLabel behavior. */
function aggregatePriorityLabel(bucket: AggregateRubricPriorityBucket, t: TFunction): string {
  return t(`kesp.agent.aggregateRubric.priority.${bucket}`);
}

/** Documents the aggregateCriterionUsefulPercent behavior. */
function aggregateCriterionUsefulPercent(criterion: AggregateRubricCriterion): number {
  return criterion.priority.scorableCallCount > 0
    ? criterion.priority.scorableAveragePercent
    : criterion.averagePercent;
}

/** Renders the AggregatePriorityPill component. */
function AggregatePriorityPill({ criterion }: { criterion: AggregateRubricCriterion }) {
  const { t } = useTranslation();
  return (
    <Pill kind={aggregatePriorityPillKind(criterion.priority.priorityBucket)}>
      {aggregatePriorityLabel(criterion.priority.priorityBucket, t)}
    </Pill>
  );
}

/** Renders the AggregateCriterionReadout component. */
function AggregateCriterionReadout({ criterion }: { criterion: AggregateRubricCriterion }) {
  const { t } = useTranslation();
  return (
    <div className="aggregate-rubric-readout">
      <span>
        {t('kesp.agent.aggregateRubric.usefulScoreShort')}{' '}
        <b>{aggregateCriterionUsefulPercent(criterion).toFixed(0)}%</b>
      </span>
      <span>
        {t('kesp.agent.aggregateRubric.failedShort')}{' '}
        <b>{criterion.priority.failedCallCount}/{criterion.priority.scorableCallCount}</b>
      </span>
      {criterion.priority.lostPoints > 0 && (
        <span>
          {t('kesp.agent.aggregateRubric.lostShort')}{' '}
          <b>{criterion.priority.lostPoints.toFixed(1)}</b>
        </span>
      )}
    </div>
  );
}

/** Renders the AggregatePriorityRow component. */
function AggregatePriorityRow({
  criterion,
  onOpen,
}: {
  criterion: AggregateRubricCriterion;
  onOpen: (criterion: AggregateRubricCriterion) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="aggregate-priority-row"
      onClick={/** Handles the onClick interaction. */() => onOpen(criterion)}
    >
      <span className="code">{criterion.id}</span>
      <span className="aggregate-priority-main">
        <b>{criterion.title}</b>
        <span>
          {t('kesp.agent.aggregateRubric.failedCalls', {
            failed: criterion.priority.failedCallCount,
            total: criterion.priority.scorableCallCount,
          })}
        </span>
      </span>
      <span className="aggregate-priority-score">
        {aggregateCriterionUsefulPercent(criterion).toFixed(0)}%
      </span>
    </button>
  );
}

/** Renders the AggregatePriorityOverview component. */
function AggregatePriorityOverview({
  priorities,
  watch,
  stableCount,
  coverageCount,
  onOpen,
}: {
  priorities: AggregateRubricCriterion[];
  watch: AggregateRubricCriterion[];
  stableCount: number;
  coverageCount: number;
  onOpen: (criterion: AggregateRubricCriterion) => void;
}) {
  const { t } = useTranslation();
  const visiblePriorities = priorities.slice(0, 5);
  const visibleWatch = watch.slice(0, 3);

  return (
    <div className="card aggregate-priority-overview">
      <div className="aggregate-priority-header">
        <div>
          <div className="eyebrow">{t('kesp.agent.aggregateRubric.priority.eyebrow')}</div>
          <h3>{t('kesp.agent.aggregateRubric.priority.title')}</h3>
          <p>{t('kesp.agent.aggregateRubric.priority.subtitle')}</p>
        </div>
        <div className="aggregate-priority-count">
          <b>{priorities.length}</b>
          <span>{t('kesp.agent.aggregateRubric.priority.countLabel')}</span>
        </div>
      </div>
      {visiblePriorities.length > 0 ? (
        <div className="aggregate-priority-list">
          {visiblePriorities.map(
            /** Handles the callback for this operation. */
            (criterion) => <AggregatePriorityRow key={criterion.id} criterion={criterion} onOpen={onOpen} />
          )}
        </div>
      ) : (
        <div className="aggregate-priority-empty">
          <Pill kind="good">{t('kesp.agent.aggregateRubric.priority.nonePill')}</Pill>
          <span>{t('kesp.agent.aggregateRubric.priority.noneBody')}</span>
        </div>
      )}
      <div className="aggregate-priority-footer">
        <span>{t('kesp.agent.aggregateRubric.priority.watchCount', { count: watch.length })}</span>
        <span>{t('kesp.agent.aggregateRubric.priority.stableCount', { count: stableCount })}</span>
        {coverageCount > 0 && (
          <span>{t('kesp.agent.aggregateRubric.priority.coverageCount', { count: coverageCount })}</span>
        )}
      </div>
      {visibleWatch.length > 0 && (
        <div className="aggregate-watch-list">
          <div className="muted tiny">{t('kesp.agent.aggregateRubric.priority.watchTitle')}</div>
          {visibleWatch.map(
            /** Handles the callback for this operation. */
            (criterion) => <AggregatePriorityRow key={criterion.id} criterion={criterion} onOpen={onOpen} />
          )}
        </div>
      )}
    </div>
  );
}

/** Renders the AggregateCriterionStatsPanel component. */
function AggregateCriterionStatsPanel({ criterion }: { criterion: AggregateRubricCriterion | null }) {
  const { t } = useTranslation();

  if (!criterion) {
    return (
      <div className="rubric-ref aggregate-rubric-detail aggregate-rubric-stats-panel">
        <div className="crumb">{t('kesp.agent.aggregateRubric.sideCrumb')}</div>
        <h3>{t('kesp.agent.aggregateRubric.openCriterion')}</h3>
        <div className="muted small">{t('kesp.agent.aggregateRubric.sideHelpStats')}</div>
      </div>
    );
  }

  const statusRows = Object.entries(criterion.statusCounts).filter(
    /** Handles the callback for this operation. */
    ([, count]) => (count ?? 0) > 0
  );
  const topWeakness = criterion.weaknesses[0];
  const topStrength = criterion.strengths[0];
  const usefulPercent = aggregateCriterionUsefulPercent(criterion);
  const isActionable = criterion.priority.priorityBucket === 'priority' || criterion.priority.priorityBucket === 'watch';
  const sayExamples = aggregateCoachingSayExamples(criterion.coachingTips, 1);
  const nextActions = aggregateCoachingActionItems(criterion.coachingTips, 1);

  return (
    <div className="rubric-ref aggregate-rubric-detail aggregate-rubric-stats-panel">
      <div className="crumb">{t('kesp.agent.aggregateRubric.sideCrumb')}</div>
      <h3>{criterion.id}. {criterion.title}</h3>
      <div className="aggregate-panel-priority">
        <AggregatePriorityPill criterion={criterion} />
        <span>{t(`kesp.agent.aggregateRubric.priority.panel.${criterion.priority.priorityBucket}`)}</span>
      </div>
      <div className="aggregate-detail-score">
        <div>
          <span>{t('kesp.agent.aggregateRubric.usefulScore')}</span>
          <b>{usefulPercent.toFixed(0)}%</b>
        </div>
        <div>
          <span>{t('kesp.agent.aggregateRubric.failed')}</span>
          <b>{criterion.priority.failedCallCount}/{criterion.priority.scorableCallCount}</b>
        </div>
      </div>
      <div className="row row-wrap" style={{ gap: 8, marginBottom: 14 }}>
        <AggregateTrendPill metric={criterion} />
        {criterion.priority.coverageCallCount > 0 && (
          <Pill kind="info">
            {t('kesp.agent.aggregateRubric.coverageShort', { count: criterion.priority.coverageCallCount })}
          </Pill>
        )}
      </div>
      {isActionable && topWeakness && (
        <div className="aggregate-panel-focus">
          <div className="muted tiny">{t('kesp.agent.aggregateRubric.priority.mainWeakness')}</div>
          <b>{topWeakness.title}</b>
          <p>{topWeakness.detail}</p>
        </div>
      )}
      {!isActionable && topStrength && (
        <div className="aggregate-panel-focus" data-kind="strength">
          <div className="muted tiny">{t('kesp.agent.aggregateRubric.priority.mainStrength')}</div>
          <b>{topStrength.title}</b>
          <p>{topStrength.detail}</p>
        </div>
      )}
      {isActionable && sayExamples[0] && (
        <div className="aggregate-panel-focus" data-kind="say">
          <div className="muted tiny">{t('kesp.agent.aggregateRubric.detail.whatToSay')}</div>
          <p>"{compactAggregateText(sayExamples[0], 190)}"</p>
        </div>
      )}
      {isActionable && nextActions[0] && (
        <div className="aggregate-panel-focus" data-kind="action">
          <div className="muted tiny">{t('kesp.agent.aggregateRubric.detail.whatToTrain')}</div>
          <p>{nextActions[0]}</p>
        </div>
      )}
      {statusRows.length > 0 && (
        <div className="aggregate-status-grid">
          {statusRows.map(
            /** Handles the callback for this operation. */
            ([status, count]) => (
              <div key={status}>
                <span>{status}</span>
                <b>{count}</b>
              </div>
            )
          )}
        </div>
      )}
      <div className="muted small aggregate-stats-hint">{t('kesp.agent.aggregateRubric.openDetailHint')}</div>
    </div>
  );
}

/** Documents the monthLabel behavior. */
function monthLabel(date: Date, language: string | undefined): string {
  return formatKespDate(date, language, { month: 'long', year: 'numeric' });
}

/** Documents the sameMonth behavior. */
function sameMonth(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();
}

/** Documents the monthGridDates behavior. */
function monthGridDates(monthDate: Date): Date[] {
  const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1, 12, 0, 0, 0);
  const offset = start.getDay();
  start.setDate(start.getDate() - offset);
  return Array.from({ length: 42 },
    /** Handles the callback for this operation. */
    (_, index) => {
      const next = new Date(start);
      next.setDate(start.getDate() + index);
      return next;
    }
  );
}

/** Documents the calendarDayState behavior. */
function calendarDayState(dayKey: string, range: AggregateRubricRange): 'start' | 'end' | 'inside' | 'outside' {
  const normalized = normalizeAggregateRubricRange(range);
  if (!normalized) return 'outside';
  if (dayKey === normalized.start) return 'start';
  if (dayKey === normalized.end) return 'end';
  return dayKey > normalized.start && dayKey < normalized.end ? 'inside' : 'outside';
}

/** Renders the AggregateCalendarMonth component. */
function AggregateCalendarMonth({
  monthDate,
  range,
  onDayClick,
}: {
  monthDate: Date;
  range: AggregateRubricRange;
  onDayClick: (dayKey: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const days = monthGridDates(monthDate);
  const weekdayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  return (
    <div className="aggregate-calendar-month">
      <div className="aggregate-calendar-month-title">{monthLabel(monthDate, i18n.resolvedLanguage)}</div>
      <div className="aggregate-calendar-weekdays">
        {weekdayKeys.map(
          /** Handles the callback for this operation. */
          (key) => <span key={key}>{t(`kesp.agent.aggregateRubric.calendar.${key}`)}</span>
        )}
      </div>
      <div className="aggregate-calendar-days">
        {days.map(
          /** Handles the callback for this operation. */
          (day) => {
            const key = aggregateDateKey(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`);
            const state = calendarDayState(key, range);
            return (
              <button
                key={key}
                type="button"
                className="aggregate-calendar-day"
                data-muted={!sameMonth(day, monthDate)}
                data-state={state}
                onClick={/** Handles the onClick interaction. */() => onDayClick(key)}
              >
                {day.getDate()}
              </button>
            );
          }
        )}
      </div>
    </div>
  );
}

/** Renders the AggregateRangePicker component. */
function AggregateRangePicker({
  draftRange,
  setDraftRange,
}: {
  draftRange: AggregateRubricRange;
  setDraftRange: (updater: (range: AggregateRubricRange) => AggregateRubricRange) => void;
}) {
  const { t } = useTranslation();
  const [selectionPhase, setSelectionPhase] = useState<'start' | 'end'>('start');
  const [visibleMonthKey, setVisibleMonthKey] = useState(() => draftRange.start.slice(0, 7));
  const visibleMonth = parseAggregateDateKey(`${visibleMonthKey}-01`) ?? new Date();
  const nextMonth = new Date(visibleMonth);
  nextMonth.setMonth(visibleMonth.getMonth() + 1);

  const shiftVisibleMonth = /** Handles the shiftVisibleMonth interaction. */ (months: number) => {
    const next = new Date(visibleMonth);
    next.setMonth(visibleMonth.getMonth() + months);
    setVisibleMonthKey(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  };

  const handleDayClick = /** Handles the handleDayClick interaction. */ (dayKey: string) => {
    setDraftRange(
      /** Handles the callback for this operation. */
      (range) => {
        if (selectionPhase === 'start') {
          return { start: dayKey, end: dayKey };
        }
        return normalizeAggregateRubricRange({ start: range.start, end: dayKey }) ?? { start: dayKey, end: dayKey };
      }
    );
    setSelectionPhase(
      /** Handles the callback for this operation. */
      (phase) => (phase === 'start' ? 'end' : 'start')
    );
  };

  return (
    <div className="aggregate-calendar-popover">
      <div className="aggregate-calendar-inputs">
        <label>
          <span>{t('kesp.agent.aggregateRubric.from')}</span>
          <input
            type="date"
            value={draftRange.start}
            onChange={/** Handles the onChange interaction. */(event) => setDraftRange(
              /** Handles the callback for this operation. */
              (range) => normalizeAggregateRubricRange({ ...range, start: aggregateDateKey(event.target.value) }) ?? range
            )}
          />
        </label>
        <label>
          <span>{t('kesp.agent.aggregateRubric.to')}</span>
          <input
            type="date"
            value={draftRange.end}
            onChange={/** Handles the onChange interaction. */(event) => setDraftRange(
              /** Handles the callback for this operation. */
              (range) => normalizeAggregateRubricRange({ ...range, end: aggregateDateKey(event.target.value) }) ?? range
            )}
          />
        </label>
      </div>
      <div className="aggregate-calendar-nav">
        <button type="button" onClick={/** Handles the onClick interaction. */() => shiftVisibleMonth(-1)}>
          <Icon name="chevron" size={12} /> {t('kesp.agent.aggregateRubric.calendar.previous')}
        </button>
        <span>{selectionPhase === 'start' ? t('kesp.agent.aggregateRubric.calendar.pickStart') : t('kesp.agent.aggregateRubric.calendar.pickEnd')}</span>
        <button type="button" onClick={/** Handles the onClick interaction. */() => shiftVisibleMonth(1)}>
          {t('kesp.agent.aggregateRubric.calendar.next')} <Icon name="arrow" size={12} />
        </button>
      </div>
      <div className="aggregate-calendar-months">
        <AggregateCalendarMonth monthDate={visibleMonth} range={draftRange} onDayClick={handleDayClick} />
        <AggregateCalendarMonth monthDate={nextMonth} range={draftRange} onDayClick={handleDayClick} />
      </div>
    </div>
  );
}

/** Splits aggregate rubric sections into deliberate PDF pages: A/B first, C/D second. */
function aggregateRubricPdfPages(sections: AggregateRubricSection[]): AggregateRubricSection[][] {
  const pagePairs = [
    ['A', 'B'],
    ['C', 'D'],
  ];
  const pages: AggregateRubricSection[][] = [];
  const placedIds = new Set<string>();

  for (const pair of pagePairs) {
    const pageSections = pair
      .map(
        /** Handles the callback for this operation. */
        (prefix) => sections.find(
          /** Handles the callback for this operation. */
          (section) => compactAggregateText(section.id, 24).charAt(0).toUpperCase() === prefix
        )
      )
      .filter(
        /** Handles the callback for this operation. */
        (section): section is AggregateRubricSection => Boolean(section)
      );
    if (pageSections.length === 0) continue;
    for (const section of pageSections) placedIds.add(section.id);
    pages.push(pageSections);
  }

  const remaining = sections.filter(
    /** Handles the callback for this operation. */
    (section) => !placedIds.has(section.id)
  );
  for (let index = 0; index < remaining.length; index += 2) {
    pages.push(remaining.slice(index, index + 2));
  }

  return pages;
}

/** Builds a localized display label for the aggregate rubric PDF date range. */
function aggregateRubricPdfRangeLabel(range: AggregateRubricRange, language: string | undefined): string {
  const start = parseAggregateDateKey(range.start);
  const end = parseAggregateDateKey(range.end);
  return `${formatKespDate(start, language)} - ${formatKespDate(end, language)}`;
}

/** Formats a compact aggregate rubric metric for the PDF header. */
function aggregateRubricPdfMetric(label: string, value: number | string): string {
  return `${label}: ${value}`;
}

/** Builds a slash-separated section label for the current aggregate PDF page. */
function aggregateRubricPdfPageSectionLabel(sections: AggregateRubricSection[]): string {
  return sections.map(
    /** Handles the callback for this operation. */
    (section) => section.id
  ).join(' / ');
}

/** Returns the compact failure text for a PDF criterion row. */
function aggregateRubricPdfFailureLabel(criterion: AggregateRubricCriterion, t: TFunction): string {
  if (criterion.priority.scorableCallCount <= 0) {
    return t('kesp.agent.aggregateRubric.coverageShort', {
      count: criterion.priority.coverageCallCount,
    });
  }
  return `${t('kesp.agent.aggregateRubric.failedShort')} ${criterion.priority.failedCallCount}/${criterion.priority.scorableCallCount}`;
}

/** Returns the tone attribute used by PDF rubric score badges. */
function aggregateRubricPdfTone(percent: number): string {
  if (percent >= 80) return 'good';
  if (percent >= 60) return 'warn';
  return 'bad';
}

/** Renders one group row in a compact aggregate rubric PDF section. */
function AggregateRubricPdfGroup({
  group,
  t,
}: {
  group: AggregateRubricSection['groups'][number];
  t: TFunction;
}) {
  return (
    <div className="aggregate-rubric-pdf-group">
      <div className="aggregate-rubric-pdf-group-head">
        <span>{group.id}</span>
        <b>{group.title}</b>
        <em>{group.averagePercent.toFixed(0)}%</em>
      </div>
      <div className="aggregate-rubric-pdf-criteria">
        {group.criteria.map(
          /** Handles the callback for this operation. */
          (criterion) => {
            const percent = aggregateCriterionUsefulPercent(criterion);
            return (
              <div key={criterion.id} className="aggregate-rubric-pdf-criterion">
                <span className="aggregate-rubric-pdf-code">{criterion.id}</span>
                <span className="aggregate-rubric-pdf-criterion-title">{criterion.title}</span>
                <span className="aggregate-rubric-pdf-failures">
                  {aggregateRubricPdfFailureLabel(criterion, t)}
                </span>
                <span className="aggregate-rubric-pdf-priority">
                  {aggregatePriorityLabel(criterion.priority.priorityBucket, t)}
                </span>
                <b className="aggregate-rubric-pdf-score" data-tone={aggregateRubricPdfTone(percent)}>
                  {percent.toFixed(0)}%
                </b>
              </div>
            );
          }
        )}
      </div>
    </div>
  );
}

/** Renders one compact rubric section for the aggregate PDF layout. */
function AggregateRubricPdfSection({
  section,
  t,
}: {
  section: AggregateRubricSection;
  t: TFunction;
}) {
  return (
    <section className="aggregate-rubric-pdf-section">
      <div className="aggregate-rubric-pdf-section-head">
        <div>
          <h3>
            {section.id}. {section.title}
          </h3>
          <span>
            {section.coveredCallCount} {t('kesp.agent.aggregateRubric.callsUnit')}
          </span>
        </div>
        <b>{section.averagePercent.toFixed(0)}%</b>
      </div>

      {section.groups.map(
        /** Handles the callback for this operation. */
        (group) => <AggregateRubricPdfGroup key={group.id} group={group} t={t} />
      )}
    </section>
  );
}

/** Renders the compact metric strip for one aggregate rubric PDF page. */
function AggregateRubricPdfMetaStrip({
  summary,
  t,
}: {
  summary: AggregateRubricSummary;
  t: TFunction;
}) {
  const metrics = [
    aggregateRubricPdfMetric(t('kesp.agent.aggregateRubric.callsInRange'), summary.sourceCallCount),
    aggregateRubricPdfMetric(t('kesp.agent.aggregateRubric.rubricEligible'), summary.eligibleCallCount),
    aggregateRubricPdfMetric(t('kesp.agent.aggregateRubric.excluded'), summary.skippedCallCount),
  ];

  return (
    <div className="aggregate-rubric-pdf-meta-strip">
      {metrics.map(
        /** Handles the callback for this operation. */
        (metric) => <span key={metric}>{metric}</span>
      )}
    </div>
  );
}

/** Renders one fixed-size aggregate rubric PDF page. */
function AggregateRubricPdfPage({
  agent,
  summary,
  range,
  sections,
  pageNumber,
  language,
  t,
}: {
  agent: AgentAnalysis;
  summary: AggregateRubricSummary;
  range: AggregateRubricRange;
  sections: AggregateRubricSection[];
  pageNumber: number;
  language: string | undefined;
  t: TFunction;
}) {
  const rangeLabel = aggregateRubricPdfRangeLabel(range, language);
  const sectionLabel = aggregateRubricPdfPageSectionLabel(sections);

  return (
    <article className="aggregate-rubric-pdf-page" data-aggregate-pdf-page="true" data-pdf-export-root="true">
      <header className="aggregate-rubric-pdf-header">
        <div>
          <div className="eyebrow">{t('kesp.agent.aggregateRubric.eyebrow')}</div>
          <h2>{t('kesp.agent.aggregateRubric.breakdownTitle')}</h2>
          <p>
            {t('kesp.common.agent')}: {maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId)} · ID {agent.salesAgentId}
          </p>
          <p>
            {t('kesp.agent.aggregateRubric.from')} / {t('kesp.agent.aggregateRubric.to')}: {rangeLabel}
          </p>
        </div>
        <div className="aggregate-rubric-pdf-total">
          <span>{sectionLabel}</span>
          <b>{summary.total.averagePercent.toFixed(0)}%</b>
          <em>{pageNumber}</em>
        </div>
      </header>

      <AggregateRubricPdfMetaStrip summary={summary} t={t} />

      <div className="aggregate-rubric-pdf-page-grid">
        {sections.map(
          /** Handles the callback for this operation. */
          (section) => <AggregateRubricPdfSection key={section.id} section={section} t={t} />
        )}
      </div>
    </article>
  );
}

/** Renders the hidden aggregate rubric PDF pages for client-side export. */
function AggregateRubricPdfExport({
  agent,
  summary,
  range,
  language,
  t,
}: {
  agent: AgentAnalysis;
  summary: AggregateRubricSummary;
  range: AggregateRubricRange;
  language: string | undefined;
  t: TFunction;
}) {
  const pages = aggregateRubricPdfPages(summary.sections);

  return (
    <div className="aggregate-rubric-pdf-export">
      {pages.map(
        /** Handles the callback for this operation. */
        (sections, index) => (
          <AggregateRubricPdfPage
            key={aggregateRubricPdfPageSectionLabel(sections)}
            agent={agent}
            summary={summary}
            range={range}
            sections={sections}
            pageNumber={index + 1}
            language={language}
            t={t}
          />
        )
      )}
    </div>
  );
}

/** Renders the AggregateRubricTab component. */
function AggregateRubricTab({
  agent,
  calls,
  navigate,
  initialRange,
  rangeSessionKey,
}: {
  agent: AgentAnalysis;
  calls: Call[];
  navigate: NavigateFn;
  initialRange: AggregateRubricRange;
  rangeSessionKey: string;
}) {
  const { t, i18n } = useTranslation();
  const [draftRange, setDraftRange] = useState<AggregateRubricRange>(initialRange);
  const [activeRange, setActiveRange] = useState<AggregateRubricRange>(initialRange);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [rows, setRows] = useState([] as Awaited<ReturnType<typeof loadAggregateRubricRows>>);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [downloadingRubric, setDownloadingRubric] = useState(false);
  const [selectedCriterionId, setSelectedCriterionId] = useState<string | null>(null);
  const aggregatePdfRef = useRef<HTMLDivElement | null>(null);
  const aggregateCalendarRef = useRef<HTMLDivElement | null>(null);

  const sourceCalls = useMemo(
    /** Handles the callback for this operation. */
    () => callsForAggregateRange(calls, activeRange),
    [activeRange, calls]
  );

  useEffect(
    /** Handles the callback for this operation. */
    () => {
      let cancelled = false;
      Promise.resolve()
        .then(
          /** Handles the callback for this operation. */
          async () => {
            if (cancelled) return;
            setLoading(true);
            setLoadError(false);
            const nextRows = await loadAggregateRubricRows(sourceCalls);
            if (!cancelled) setRows(nextRows);
          }
        )
        .catch(
          /** Handles the callback for this operation. */
          (error) => {
            console.error('Failed to build aggregate rubric:', error);
            if (!cancelled) {
              setRows([]);
              setLoadError(true);
            }
          }
        )
        .finally(
          /** Handles the callback for this operation. */
          () => {
            if (!cancelled) setLoading(false);
          }
        );
      return /** Handles the callback for this operation. */ () => {
        cancelled = true;
      };
    },
    [refreshKey, sourceCalls]
  );

  const summary = useMemo(
    /** Handles the callback for this operation. */
    () => buildAggregateRubricSummary(rows, sourceCalls.length),
    [rows, sourceCalls.length]
  );

  const allCriteria = useMemo(
    /** Handles the callback for this operation. */
    () => aggregateCriteria(summary),
    [summary]
  );
  const priorityGroups = useMemo(
    /** Handles the callback for this operation. */
    () => groupAggregateCriteriaByPriority(summary),
    [summary]
  );
  const orderedCriteria = useMemo(
    /** Handles the callback for this operation. */
    () => [
      ...priorityGroups.priorities,
      ...priorityGroups.watch,
      ...priorityGroups.coverage,
      ...priorityGroups.stable,
    ],
    [priorityGroups]
  );

  const effectiveSelectedCriterionId =
    selectedCriterionId && allCriteria.some(
      /** Handles the callback for this operation. */
      (criterion) => criterion.id === selectedCriterionId
    )
      ? selectedCriterionId
      : orderedCriteria[0]?.id ?? null;

  const selectedCriterion = allCriteria.find(
    /** Handles the callback for this operation. */
    (criterion) => criterion.id === effectiveSelectedCriterionId
  ) ?? null;

  const validDraftRange = Boolean(normalizeAggregateRubricRange(draftRange));

  useEffect(
    /** Handles the callback for this operation. */
    () => {
      if (!calendarOpen) return /** Handles the callback for this operation. */ () => undefined;

      /** Handles the handleCalendarDocumentPointerDown interaction. */
      const handleCalendarDocumentPointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (!aggregateCalendarRef.current?.contains(target)) {
          setCalendarOpen(false);
        }
      };

      document.addEventListener('pointerdown', handleCalendarDocumentPointerDown, true);
      return /** Handles the callback for this operation. */ () => {
        document.removeEventListener('pointerdown', handleCalendarDocumentPointerDown, true);
      };
    },
    [calendarOpen]
  );

  const handleRunAggregate = /** Handles the handleRunAggregate interaction. */ () => {
    const normalized = normalizeAggregateRubricRange(draftRange);
    if (!normalized) {
      toast.error(t('kesp.agent.aggregateRubric.invalidRange'));
      return;
    }
    setActiveRange(normalized);
    setDraftRange(normalized);
    writeSessionAggregateRubricRange(rangeSessionKey, normalized);
    setCalendarOpen(false);
    setRefreshKey(
      /** Handles the callback for this operation. */
      (value) => value + 1
    );
  };

  const openCriterionDetail = /** Handles the openCriterionDetail interaction. */ (criterion: AggregateRubricCriterion) => {
    const params = new URLSearchParams({ start: activeRange.start, end: activeRange.end });
    navigate(`/kesp/agent/${encodeURIComponent(agent.id)}/rubric/${encodeURIComponent(criterion.sectionId)}/${encodeURIComponent(criterion.groupId)}/${encodeURIComponent(criterion.id)}?${params.toString()}`);
  };

  /** Downloads the loaded aggregate rubric summary as a two-column PDF. */
  const handleDownloadAggregateRubric = useCallback(
    /** Handles the handleDownloadAggregateRubric interaction. */
    async () => {
      if (loading) {
        toast.info(t('kesp.agent.aggregateRubric.loading'));
        return;
      }
      if (loadError) {
        toast.error(t('kesp.agent.aggregateRubric.loadError'));
        return;
      }
      if (!summary || !aggregatePdfRef.current) {
        toast.info(t('kesp.agent.aggregateRubric.downloadEmpty'));
        return;
      }

      setDownloadingRubric(true);
      try {
        const pageElements = Array.from(
          aggregatePdfRef.current.querySelectorAll<HTMLElement>('[data-aggregate-pdf-page="true"]')
        ).map(
          /** Handles the callback for this operation. */
          (element) => ({ element })
        );
        if (pageElements.length === 0) {
          toast.info(t('kesp.agent.aggregateRubric.downloadEmpty'));
          return;
        }
        const filename = sanitizePdfFileName(
          [
            'kesp',
            agent.salesAgentName,
            'rubrica-agregada',
            activeRange.start,
            activeRange.end,
          ].join('-')
        );
        /** Calls the client PDF helper to render each aggregate rubric export page into the downloadable PDF. */
        await downloadElementsAsPdf({
          filename,
          elements: pageElements,
          orientation: 'landscape',
          marginMm: 8,
        });
        toast.success(t('kesp.agent.aggregateRubric.downloadSuccess'));
      } catch (error) {
        console.error('Failed to download aggregate rubric PDF:', error);
        toast.error(t('kesp.agent.report.downloadError'));
      } finally {
        setDownloadingRubric(false);
      }
    },
    [activeRange.end, activeRange.start, agent.salesAgentName, loadError, loading, summary, t]
  );

  const aggregateDownloadLabel = downloadingRubric
    ? t('kesp.agent.aggregateRubric.downloadPreparing')
    : t('kesp.agent.aggregateRubric.download');
  const aggregateDownloadDisabled = loading || loadError || !summary || downloadingRubric;

  return (
    <div className="rise aggregate-rubric-tab">
      <div className="aggregate-rubric-toolbar aggregate-rubric-toolbar-with-export">
        <Button
          kind="ghost"
          className="btn-icon pdf-download-btn aggregate-rubric-download-btn"
          data-pdf-exclude="true"
          aria-label={aggregateDownloadLabel}
          title={aggregateDownloadLabel}
          onClick={/** Handles the onClick interaction. */() => {
            void handleDownloadAggregateRubric();
          }}
          disabled={aggregateDownloadDisabled}
        >
          <Icon name="download" size={14} />
        </Button>
        <div>
          <div className="eyebrow">{t('kesp.agent.aggregateRubric.eyebrow')}</div>
          <h2>{t('kesp.agent.aggregateRubric.title')}</h2>
          <p>{t('kesp.agent.aggregateRubric.subtitle')}</p>
        </div>
        <div className="aggregate-rubric-actions">
          <div ref={aggregateCalendarRef} className="aggregate-calendar-wrap">
            <Button
              kind="ghost"
              size="sm"
              icon={<Icon name="clock" size={13} />}
              onClick={/** Handles the onClick interaction. */() => setCalendarOpen(
                /** Handles the callback for this operation. */
                (open) => !open
              )}
            >
              {formatKespDate(parseAggregateDateKey(activeRange.start) ?? new Date(), i18n.resolvedLanguage)} - {formatKespDate(parseAggregateDateKey(activeRange.end) ?? new Date(), i18n.resolvedLanguage)}
            </Button>
            {calendarOpen && <AggregateRangePicker draftRange={draftRange} setDraftRange={setDraftRange} />}
          </div>
          <Button kind="primary" size="sm" icon={<Icon name="refresh" size={13} />} onClick={handleRunAggregate} disabled={!validDraftRange || loading}>
            {loading ? t('kesp.agent.aggregateRubric.generating') : t('kesp.agent.aggregateRubric.regenerate')}
          </Button>
        </div>
      </div>

      {summary && (
        <div className="pdf-export-stage" aria-hidden="true">
          <div ref={aggregatePdfRef}>
            <AggregateRubricPdfExport
              agent={agent}
              summary={summary}
              range={activeRange}
              language={i18n.resolvedLanguage}
              t={t}
            />
          </div>
        </div>
      )}

      <div className="prog-kpi-grid aggregate-rubric-kpis">
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.aggregateRubric.callsInRange')}</div>
          <div className="val">{sourceCalls.length}</div>
        </div>
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.aggregateRubric.rubricEligible')}</div>
          <div className="val">{summary?.eligibleCallCount ?? rows.length}</div>
        </div>
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.aggregateRubric.averageScore')}</div>
          <div className="val">
            {summary ? summary.total.averagePercent.toFixed(0) : '—'}
            {summary && <small>%</small>}
          </div>
        </div>
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.aggregateRubric.priority.kpi')}</div>
          <div className="val">{summary ? priorityGroups.priorities.length : 0}</div>
        </div>
      </div>

      {loadError && <div className="card muted small">{t('kesp.agent.aggregateRubric.loadError')}</div>}
      {loading && <div className="card muted small">{t('kesp.agent.aggregateRubric.loading')}</div>}
      {!loading && !summary && (
        <div className="card aggregate-empty">
          <h3>{t('kesp.agent.aggregateRubric.emptyTitle')}</h3>
          <p>{t('kesp.agent.aggregateRubric.emptyBody')}</p>
        </div>
      )}

      {summary && (
        <AggregatePriorityOverview
          priorities={priorityGroups.priorities}
          watch={priorityGroups.watch}
          stableCount={priorityGroups.stable.length}
          coverageCount={priorityGroups.coverage.length}
          onOpen={openCriterionDetail}
        />
      )}

      {summary && (
        <div className="card rise">
          <div className="rubric-grid aggregate-rubric-grid">
            <div>
              <div className="row row-between row-wrap" style={{ marginBottom: 8, gap: 10 }}>
                <h3 className="card-h">{t('kesp.agent.aggregateRubric.breakdownTitle')}</h3>
                <span className="muted small">{t('kesp.agent.aggregateRubric.breakdownHelp')}</span>
              </div>
              {summary.sections.map(
                /** Handles the callback for this operation. */
                (section) => {
                  const sectionColor = colorFromPercent(section.averagePercent);
                  return (
                    <div key={section.id} className="rubric-section">
                      <div className="rubric-section-h aggregate-rubric-section-h">
                        <Icon name="chevronDown" size={12} />
                        <h4>
                          {section.id}. {section.title}
                          <span className="muted tiny" style={{ fontWeight: 400, marginLeft: 8 }}>
                            {section.coveredCallCount} {t('kesp.agent.aggregateRubric.callsUnit')}
                          </span>
                        </h4>
                        <div className="rubric-bar"><i className={sectionColor} style={{ width: `${section.averagePercent}%` }} /></div>
                        <div className={`rubric-score ${sectionColor}`}>{section.averagePercent.toFixed(0)}%</div>
                      </div>
                      <div className="rubric-children">
                        {section.groups.map(
                          /** Handles the callback for this operation. */
                          (group) => {
                            const groupColor = colorFromPercent(group.averagePercent);
                            return (
                              <div key={group.id}>
                                <div className="rubric-child aggregate-rubric-group-row">
                                  <span className="code">{group.id}</span>
                                  <span style={{ fontWeight: 500 }}>{group.title}</span>
                                  <div className="rubric-bar"><i className={groupColor} style={{ width: `${group.averagePercent}%` }} /></div>
                                  <div className={`rubric-score ${groupColor}`}>{group.averagePercent.toFixed(0)}%</div>
                                </div>
                                {group.criteria.map(
                                  /** Handles the callback for this operation. */
                                  (criterion) => {
                                    const criterionPercent = aggregateCriterionUsefulPercent(criterion);
                                    const criterionColor = colorFromPercent(criterionPercent);
                                    const selected = effectiveSelectedCriterionId === criterion.id;
                                    return (
                                      <button
                                        key={criterion.id}
                                        type="button"
                                        className="rubric-child aggregate-rubric-criterion-row"
                                        aria-pressed={selected}
                                        onFocus={/** Handles the onFocus interaction. */() => setSelectedCriterionId(criterion.id)}
                                        onMouseEnter={/** Handles the onMouseEnter interaction. */() => setSelectedCriterionId(criterion.id)}
                                        onClick={/** Handles the onClick interaction. */() => openCriterionDetail(criterion)}
                                      >
                                        <span className="code">{criterion.id}</span>
                                        <span className="aggregate-rubric-criterion-title">
                                          <span>{criterion.title}</span>
                                          <AggregateCriterionReadout criterion={criterion} />
                                        </span>
                                        <div className="aggregate-rubric-trend"><AggregatePriorityPill criterion={criterion} /></div>
                                        <div className="rubric-bar"><i className={criterionColor} style={{ width: `${criterionPercent}%` }} /></div>
                                        <div className={`rubric-score ${criterionColor}`}>{criterionPercent.toFixed(0)}%</div>
                                      </button>
                                    );
                                  }
                                )}
                              </div>
                            );
                          }
                        )}
                      </div>
                    </div>
                  );
                }
              )}
            </div>
            <AggregateCriterionStatsPanel criterion={selectedCriterion} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Reporte tab ─────────────────────────────────────────────────────────────
function ReporteTab({
  agent,
  report,
  reportInProgress,
  onTriggerReport,
  triggering,
  canTriggerReport,
  callCount,
  calls,
  snapshots,
  navigate,
  returnTo,
}: {
  agent: AgentAnalysis;
  report: AgentAnalysisReport | null;
  reportInProgress: boolean;
  onTriggerReport: () => void;
  triggering: boolean;
  canTriggerReport: boolean;
  callCount: number;
  calls: Call[];
  snapshots: AgentCallSnapshot[];
  navigate: NavigateFn;
  returnTo: string;
}) {
  const { t } = useTranslation();
  const v2 = isReportV2(report);
  const patterns = useMemo(
    /** Handles the callback for this operation. */
    () => (v2 ? (report as AgentAnalysisReportV2).patterns : []),
    [report, v2]
  );
  const sortedPatterns = useMemo(
    /** Handles the callback for this operation. */
    () => [...patterns].sort(/** Handles the callback for this operation. */(a, b) => a.priorityScore - b.priorityScore),
    [patterns]
  );
  const reportRunId = v2 ? report.reportId : null;
  const needsTaskFallback =
    v2 &&
    patterns.some(
      /** Handles the callback for this operation. */
      (pattern) =>
        (pattern.sourceCallIds?.length ?? 0) === 0 &&
        pattern.examples.length === 0 &&
        pattern.supportingEvidence.length === 0 &&
        pattern.relatedSignalIds.length > 0
    );
  const [runTasksState, setRunTasksState] = useState<PatternRunTasksState | null>(null);
  const [downloadingPatternId, setDownloadingPatternId] = useState<string | null>(null);
  const [downloadingAllPatterns, setDownloadingAllPatterns] = useState(false);
  const patternCardRefs = useRef(new Map<string, HTMLDivElement>());
  const runTasksForReport =
    reportRunId && runTasksState?.runId === reportRunId ? runTasksState.tasks : null;
  const runTasksError = Boolean(
    needsTaskFallback && reportRunId && runTasksState?.runId === reportRunId && runTasksState.error
  );
  const runTasksLoading = Boolean(
    needsTaskFallback && reportRunId && runTasksState?.runId !== reportRunId
  );
  const downloadControlsDisabled = Boolean(downloadingPatternId || downloadingAllPatterns);

  /** Registers the rendered DOM node for each visible pattern card. */
  const registerPatternCardRef = useCallback(
    /** Handles the registerPatternCardRef callback. */
    (patternId: string) =>
      /** Handles the returned ref callback. */
      (node: HTMLDivElement | null) => {
        if (node) {
          patternCardRefs.current.set(patternId, node);
          return;
        }
        patternCardRefs.current.delete(patternId);
      },
    []
  );

  /** Downloads one currently visible pattern card as a PDF. */
  const handleDownloadPattern = useCallback(
    /** Handles the handleDownloadPattern interaction. */
    async (pattern: BehaviorPattern, rank: number) => {
      const element = patternCardRefs.current.get(pattern.patternId);
      if (!element) {
        toast.error(t('kesp.agent.report.downloadUnavailable'));
        return;
      }

      setDownloadingPatternId(pattern.patternId);
      try {
        const filename = sanitizePdfFileName(
          [
            'kesp',
            agent.salesAgentName,
            'patron',
            String(rank).padStart(2, '0'),
            pattern.patternName,
            reportRunId ?? 'reporte',
          ].join('-')
        );
        /** Calls the client PDF helper to render the visible pattern card into a downloadable PDF. */
        await downloadElementsAsPdf({
          filename,
          elements: [{ element }],
          orientation: 'portrait',
          marginMm: 10,
        });
        toast.success(t('kesp.agent.report.downloadPatternSuccess'));
      } catch (error) {
        console.error('Failed to download pattern PDF:', error);
        toast.error(t('kesp.agent.report.downloadError'));
      } finally {
        setDownloadingPatternId(null);
      }
    },
    [agent.salesAgentName, reportRunId, t]
  );

  /** Downloads all currently rendered pattern cards as one PDF. */
  const handleDownloadAllPatterns = useCallback(
    /** Handles the handleDownloadAllPatterns interaction. */
    async () => {
      const elements = sortedPatterns
        .map(
          /** Handles the callback for this operation. */
          (pattern) => patternCardRefs.current.get(pattern.patternId)
        )
        .filter(
          /** Handles the callback for this operation. */
          (element): element is HTMLDivElement => Boolean(element)
        )
        .map(
          /** Handles the callback for this operation. */
          (element) => ({ element })
        );

      if (elements.length === 0) {
        toast.error(t('kesp.agent.report.downloadUnavailable'));
        return;
      }

      setDownloadingAllPatterns(true);
      try {
        const filename = sanitizePdfFileName(
          ['kesp', agent.salesAgentName, 'reporte-patrones', reportRunId ?? 'reporte'].join('-')
        );
        /** Calls the client PDF helper to render all currently mounted pattern cards into one downloadable PDF. */
        await downloadElementsAsPdf({
          filename,
          elements,
          orientation: 'portrait',
          marginMm: 10,
        });
        toast.success(t('kesp.agent.report.downloadAllSuccess'));
      } catch (error) {
        console.error('Failed to download pattern report PDF:', error);
        toast.error(t('kesp.agent.report.downloadError'));
      } finally {
        setDownloadingAllPatterns(false);
      }
    },
    [agent.salesAgentName, reportRunId, sortedPatterns, t]
  );

  useEffect(/** Handles the callback for this operation. */() => {
    if (!reportRunId || !needsTaskFallback || runTasksState?.runId === reportRunId) return;

    let cancelled = false;
    fetchAgentAnalysisRunTasks(agent.id, reportRunId)
      .then(/** Handles the callback for this operation. */(tasks) => {
        if (!cancelled) setRunTasksState({ runId: reportRunId, tasks, error: false });
      })
      .catch(/** Handles the callback for this operation. */(err) => {
        console.error('Failed to load agent analysis run tasks:', err);
        if (!cancelled) setRunTasksState({ runId: reportRunId, tasks: [], error: true });
      });

    return () => {
      cancelled = true;
    };
  }, [agent.id, needsTaskFallback, reportRunId, runTasksState?.runId]);

  const taskFallbackCallIdsByPatternId = new Map<string, string[]>();
  if (runTasksForReport) {
    const signalCallIdMap = buildSignalCallIdMap(runTasksForReport);
    for (const pattern of patterns) {
      taskFallbackCallIdsByPatternId.set(
        pattern.patternId,
        buildPatternTaskCallIds(pattern, signalCallIdMap)
      );
    }
  }

  if (!agent.latestReportId && !reportInProgress) {
    return (
      <div className="rise">
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <h2
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              margin: '0 0 8px',
            }}
          >
            {t('kesp.agent.report.noReportTitle')}
          </h2>
          <p className="muted" style={{ margin: '0 0 18px', maxWidth: 480, marginInline: 'auto' }}>
            {t('kesp.agent.report.noReportDescription')}
          </p>
          <Button
            kind="primary"
            icon={<Icon name="bulb" size={14} />}
            onClick={onTriggerReport}
            disabled={!canTriggerReport || triggering || callCount === 0}
          >
            {triggering ? t('kesp.agent.upload.starting') : t('kesp.agent.upload.generate')}
          </Button>
        </div>
      </div>
    );
  }

  if (reportInProgress) {
    return (
      <div className="rise">
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <Icon name="clock" size={20} />
          <h2
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              margin: '8px 0',
            }}
          >
            {t('kesp.agent.report.generatingTitle')}
          </h2>
          <p className="muted" style={{ margin: 0 }}>
            {t('kesp.agent.report.generatingDescription')}
          </p>
        </div>
      </div>
    );
  }

  if (!v2 || patterns.length === 0) {
    return (
      <div className="rise">
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <div className="muted">
            {t('kesp.agent.report.noPatterns')}
          </div>
        </div>
      </div>
    );
  }

  const coverage = (report as AgentAnalysisReportV2).coverage;
  const allPatternsDownloadLabel = downloadingAllPatterns
    ? t('kesp.agent.report.downloadAllPreparing')
    : t('kesp.agent.report.downloadAll');

  return (
    <div className="rise">
      <div className="reporte-intro reporte-intro-with-export">
        <Button
          kind="ghost"
          className="btn-icon pdf-download-btn reporte-download-btn"
          data-pdf-exclude="true"
          aria-label={allPatternsDownloadLabel}
          title={allPatternsDownloadLabel}
          onClick={/** Handles the onClick interaction. */() => {
            void handleDownloadAllPatterns();
          }}
          disabled={downloadControlsDisabled}
        >
          <Icon name="download" size={14} />
        </Button>
        <div
          className="muted small"
          style={{
            textTransform: 'uppercase',
            letterSpacing: '.10em',
            fontWeight: 600,
            marginBottom: 6,
          }}
        >
          {t('kesp.agent.report.intro', { count: coverage?.eligibleCallCount ?? 0 })}
        </div>
        <h2
          style={{
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: '0 0 6px',
          }}
        >
          {t('kesp.agent.report.title')}
        </h2>
        <p className="muted" style={{ margin: 0, fontSize: 15, maxWidth: 640 }}>
          {t('kesp.agent.report.summary', { count: sortedPatterns.length })}
        </p>
      </div>

      {sortedPatterns.map(/** Handles the callback for this operation. */(p, i) => (
        <PatternCard
          key={p.patternId}
          pattern={p}
          rank={i + 1}
          calls={calls}
          snapshots={snapshots}
          fallbackCallIds={taskFallbackCallIdsByPatternId.get(p.patternId)}
          fallbackLoading={runTasksLoading}
          fallbackError={runTasksError}
          navigate={navigate}
          returnTo={returnTo}
          cardRef={registerPatternCardRef(p.patternId)}
          onDownload={/** Handles the onDownload interaction. */() => {
            void handleDownloadPattern(p, i + 1);
          }}
          downloadDisabled={downloadControlsDisabled}
          downloading={downloadingPatternId === p.patternId}
        />
      ))}
    </div>
  );
}

// ─── Recordatorio tab ────────────────────────────────────────────────────────
const STAGE_KINDS: Record<string, PillKind> = {
  fully_completed: 'good',
  sold_pending_follow_through: 'info',
  future_follow_up: 'good',
  not_sold: 'warn',
  lost_cancelled: 'bad',
  unknown: 'default',
};

const TASK_KINDS: Record<string, PillKind> = {
  call_back: 'task-call',
  send_whatsapp: 'task-whatsapp',
  send_info: 'task-info',
  collect_documents: 'task-docs',
  confirm_payment: 'task-payment',
  wait_for_customer: 'task-wait',
  other: 'default',
};

/** Documents the getStageMeta behavior. */
function getStageMeta(stage: string | null | undefined, t: TFunction) {
  const id = stage ?? 'unknown';
  return {
    label: t(`kesp.agent.reminders.stage.${id}`, {
      defaultValue: t('kesp.agent.reminders.stage.unknown'),
    }),
    kind: STAGE_KINDS[id] ?? STAGE_KINDS.unknown,
  };
}

/** Documents the getTaskMeta behavior. */
function getTaskMeta(task: string | null | undefined, t: TFunction) {
  const id = task ?? 'other';
  return {
    label: t(`kesp.agent.reminders.task.${id}`, {
      defaultValue: t('kesp.agent.reminders.task.other'),
    }),
    kind: TASK_KINDS[id] ?? TASK_KINDS.other,
  };
}

type ReminderViewFilter =
  | 'active'
  | 'all'
  | 'calls'
  | 'messages'
  | 'sold_pending'
  | 'future_follow_up'
  | 'completed'
  | 'cancelled'
  | 'done';

type ReminderPeriodFilter = 'all' | 'today' | 'future' | 'overdue' | 'unscheduled';
type ReminderStateFilter = 'all' | 'open' | 'done' | 'closed' | 'without_reminder';

/** Documents the todayKey behavior. */
function todayKey(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Documents the getReminderDue behavior. */
function getReminderDue(reminder: AgentReminder | undefined, snapshot: AgentCallSnapshot) {
  return {
    date: reminder?.effectiveDueDate ?? reminder?.dueDate ?? snapshot.followUpDate ?? null,
    time: reminder?.effectiveDueTime ?? reminder?.dueTime ?? snapshot.followUpTime ?? null,
    timeRange:
      reminder?.effectiveTimeRange ??
      reminder?.timeRange ??
      snapshot.followUpTimeRange ??
      null,
    condition:
      reminder?.effectiveConditionText ??
      reminder?.conditionText ??
      snapshot.clientCallbackCondition ??
      null,
  };
}

/** Documents the formatReminderLine behavior. */
function formatReminderLine(
  snapshot: AgentCallSnapshot,
  reminder: AgentReminder | undefined,
  t: TFunction
): string | null {
  const stage = snapshot.effectiveLifecycleStage ?? 'unknown';
  const needsReminder =
    snapshot.followUpNeeded ||
    stage === 'sold_pending_follow_through' ||
    Boolean(reminder && reminder.state === 'open');
  if (!needsReminder) return null;

  const task = snapshot.reminderTaskType
    ? getTaskMeta(snapshot.reminderTaskType, t).label
    : t('kesp.agent.reminders.task.followUp');
  const person = snapshot.customerName ?? snapshot.callName ?? t('kesp.common.customerFallback').toLowerCase();
  const due = getReminderDue(reminder, snapshot);

  if (due.date && due.time) return t('kesp.agent.reminders.line.dateTime', { task, person, date: due.date, time: due.time });
  if (due.date && due.timeRange) return t('kesp.agent.reminders.line.dateRange', { task, person, date: due.date, timeRange: due.timeRange });
  if (due.date) return t('kesp.agent.reminders.line.date', { task, person, date: due.date });
  if (due.condition) return t('kesp.agent.reminders.line.condition', { task, person, condition: due.condition });
  return t('kesp.agent.reminders.line.plain', { task, person });
}

/** Documents the isMessageTask behavior. */
function isMessageTask(taskType?: string | null): boolean {
  return taskType === 'send_whatsapp' || taskType === 'send_info';
}

/** Renders the RecordatorioTab component. */
function RecordatorioTab({
  agentKey,
  snapshots,
  reminders,
  agent,
  onRefresh,
  refreshing,
}: {
  agentKey: string;
  snapshots: AgentCallSnapshot[];
  reminders: AgentReminder[];
  agent: AgentAnalysis;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [viewFilter, setViewFilter] = useState<ReminderViewFilter>('active');
  const [periodFilter, setPeriodFilter] = useState<ReminderPeriodFilter>('all');
  const [stateFilter, setStateFilter] = useState<ReminderStateFilter>('all');
  const [outcomeNotes, setOutcomeNotes] = useState<Record<string, string>>({});

  const findAnyReminderForSnapshot = useCallback(/** Handles the callback for this operation. */(snapshot: AgentCallSnapshot): AgentReminder | undefined => {
    return reminders.find(
      /** Handles the callback for this operation. */
      (r) => r.sourceCallId === snapshot.sourceCallId || r.clientKey === snapshot.clientKey
    );
  }, [reminders]);

  const findOpenReminderForSnapshot = useCallback(/** Handles the callback for this operation. */(snapshot: AgentCallSnapshot): AgentReminder | undefined => {
    return reminders.find(
      /** Handles the callback for this operation. */
      (r) =>
        r.state === 'open' &&
        (r.sourceCallId === snapshot.sourceCallId || r.clientKey === snapshot.clientKey)
    );
  }, [reminders]);

  const today = useMemo(/** Handles the callback for this operation. */() => todayKey(), []);

  const filteredSnapshots = useMemo(/** Handles the callback for this operation. */() => {
    return snapshots.filter(/** Handles the callback for this operation. */(snapshot) => {
      const stage = snapshot.effectiveLifecycleStage ?? 'unknown';
      const reminder = findAnyReminderForSnapshot(snapshot);
      const due = getReminderDue(reminder, snapshot);
      const isActiveFollowup =
        snapshot.followUpNeeded || stage === 'sold_pending_follow_through' || reminder?.state === 'open';

      if (viewFilter === 'active' && !isActiveFollowup) return false;
      if (
        viewFilter === 'calls' &&
        !(snapshot.followUpNeeded && (snapshot.reminderTaskType === 'call_back' || !snapshot.reminderTaskType))
      ) {
        return false;
      }
      if (viewFilter === 'messages' && !(snapshot.followUpNeeded && isMessageTask(snapshot.reminderTaskType))) {
        return false;
      }
      if (viewFilter === 'sold_pending' && stage !== 'sold_pending_follow_through') return false;
      if (viewFilter === 'future_follow_up' && stage !== 'future_follow_up') return false;
      if (viewFilter === 'completed' && stage !== 'fully_completed' && snapshot.loanCompleted !== 'yes') return false;
      if (viewFilter === 'cancelled' && stage !== 'lost_cancelled') return false;
      if (viewFilter === 'done' && reminder?.state !== 'done') return false;

      if (stateFilter === 'open' && reminder?.state !== 'open') return false;
      if (stateFilter === 'done' && reminder?.state !== 'done') return false;
      if (stateFilter === 'closed' && reminder?.state !== 'closed') return false;
      if (stateFilter === 'without_reminder' && reminder) return false;

      if (periodFilter === 'today' && due.date !== today) return false;
      if (periodFilter === 'future' && (!due.date || due.date <= today)) return false;
      if (periodFilter === 'overdue' && (!due.date || due.date >= today || reminder?.state !== 'open')) {
        return false;
      }
      if (periodFilter === 'unscheduled' && (due.date || due.timeRange || due.condition)) return false;

      return true;
    });
  }, [snapshots, findAnyReminderForSnapshot, viewFilter, stateFilter, periodFilter, today]);

  const groupedByDay = useMemo(/** Handles the callback for this operation. */() => {
    const map = new Map<string, AgentCallSnapshot[]>();
    for (const s of filteredSnapshots) {
      const reminder = findAnyReminderForSnapshot(s);
      const due = getReminderDue(reminder, s);
      const key = due.date || s.bucketDay || s.callOccurredAtIso?.slice(0, 10) || 'sin-fecha';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.entries()).sort(/** Handles the callback for this operation. */(a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filteredSnapshots, findAnyReminderForSnapshot]);

  const counts = useMemo(/** Handles the callback for this operation. */() => {
    const total = snapshots.length;
    const conSiguiente = snapshots.filter(/** Handles the callback for this operation. */(s) => s.followUpNeeded).length;
    const llamadasPorHacer = snapshots.filter(
      /** Handles the callback for this operation. */
      (s) => s.followUpNeeded && (s.reminderTaskType === 'call_back' || !s.reminderTaskType)
    ).length;
    const mensajesPorEnviar = snapshots.filter(
      /** Handles the callback for this operation. */
      (s) =>
        s.followUpNeeded &&
        (s.reminderTaskType === 'send_whatsapp' || s.reminderTaskType === 'send_info')
    ).length;
    return { total, conSiguiente, llamadasPorHacer, mensajesPorEnviar };
  }, [snapshots]);

  const markDone = /** Documents the markDone behavior. */ async (snapshot: AgentCallSnapshot) => {
    const reminder = findOpenReminderForSnapshot(snapshot);
    if (!reminder) {
      toast.error(t('kesp.agent.reminders.toasts.noOpenReminder'));
      return;
    }
    setSavingId(snapshot.id);
    try {
      await updateReminder(agentKey, reminder.reminderId, {
        state: 'done',
        closedReason: 'manual',
      });
      toast.success(t('kesp.agent.reminders.toasts.markDoneSuccess'));
    } catch (err) {
      console.error('Failed to mark reminder done:', err);
      toast.error(t('kesp.agent.reminders.toasts.markDoneError'));
    } finally {
      setSavingId(null);
    }
  };

  const reopen = /** Documents the reopen behavior. */ async (snapshot: AgentCallSnapshot) => {
    const reminder = findAnyReminderForSnapshot(snapshot);
    if (!reminder) {
      toast.error(t('kesp.agent.reminders.toasts.noActiveReminder'));
      return;
    }
    setSavingId(snapshot.id);
    try {
      await updateReminder(agentKey, reminder.reminderId, { state: 'open' });
      toast.success(t('kesp.agent.reminders.toasts.reopenSuccess'));
    } catch (err) {
      console.error('Failed to reopen reminder:', err);
      toast.error(t('kesp.agent.reminders.toasts.reopenError'));
    } finally {
      setSavingId(null);
    }
  };

  const handleLoanOutcome = /** Handles the handleLoanOutcome interaction. */ async (
    snapshot: AgentCallSnapshot,
    outcome: 'sold' | 'pending' | 'cancelled'
  ) => {
    const reminder = findAnyReminderForSnapshot(snapshot);
    const isSoldPending =
      snapshot.effectiveLifecycleStage === 'sold_pending_follow_through' ||
      snapshot.saleReachedOnCall === true;

    if (!snapshot.caseId && outcome !== 'pending') {
      toast.error(t('kesp.agent.reminders.toasts.noCase'));
      return;
    }

    setSavingId(snapshot.id);
    try {
      const note = outcomeNotes[snapshot.id]?.trim() || null;
      if (outcome === 'sold') {
        await updateLoanCaseStage(agentKey, snapshot.caseId!, 'fully_completed', note);
        toast.success(t('kesp.agent.reminders.toasts.soldSuccess'));
      } else if (outcome === 'cancelled') {
        await updateLoanCaseStage(agentKey, snapshot.caseId!, 'lost_cancelled', note);
        toast.success(t('kesp.agent.reminders.toasts.cancelledSuccess'));
      } else {
        if (isSoldPending && snapshot.caseId) {
          await updateLoanCaseStage(agentKey, snapshot.caseId, 'sold_pending_follow_through', note);
        } else if (reminder) {
          await updateReminder(agentKey, reminder.reminderId, { state: 'open', notes: note });
        }
        toast.success(t('kesp.agent.reminders.toasts.pendingSuccess'));
      }
    } catch (err) {
      console.error('Failed to update loan outcome:', err);
      toast.error(t('kesp.agent.reminders.toasts.saveOutcomeError'));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="rise">
      <div className="row row-between" style={{ marginBottom: 18, gap: 12 }}>
        <div className="kpi-grid kpi-grid-4" style={{ flex: 1 }}>
          <div className="kpi">
            <div className="kpi-label">{t('kesp.agent.reminders.counts.analyzed')}</div>
            <div className="kpi-value">{counts.total}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">{t('kesp.agent.reminders.counts.nextStep')}</div>
            <div className="kpi-value" style={{ color: 'var(--good)' }}>
              {counts.conSiguiente}
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-label">{t('kesp.agent.reminders.counts.callsToMake')}</div>
            <div className="kpi-value" style={{ color: 'var(--accent)' }}>
              {counts.llamadasPorHacer}
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-label">{t('kesp.agent.reminders.counts.messagesToSend')}</div>
            <div className="kpi-value" style={{ color: 'var(--info)' }}>
              {counts.mensajesPorEnviar}
            </div>
          </div>
        </div>
      </div>

      <div className="filter-card">
        <div className="filter-field">
          <label>{t('kesp.agent.reminders.filters.view')}</label>
          <select value={viewFilter} onChange={(e) => setViewFilter(e.target.value as ReminderViewFilter)}>
            <option value="active">{t('kesp.agent.reminders.filters.active')}</option>
            <option value="all">{t('kesp.agent.reminders.filters.allCalls')}</option>
            <option value="calls">{t('kesp.agent.reminders.filters.calls')}</option>
            <option value="messages">{t('kesp.agent.reminders.filters.messages')}</option>
            <option value="sold_pending">{t('kesp.agent.reminders.filters.soldPending')}</option>
            <option value="future_follow_up">{t('kesp.agent.reminders.filters.futureFollowUp')}</option>
            <option value="completed">{t('kesp.agent.reminders.filters.completed')}</option>
            <option value="cancelled">{t('kesp.agent.reminders.filters.cancelled')}</option>
            <option value="done">{t('kesp.agent.reminders.filters.done')}</option>
          </select>
        </div>
        <div className="filter-field">
          <label>{t('kesp.agent.reminders.filters.period')}</label>
          <select value={periodFilter} onChange={(e) => setPeriodFilter(e.target.value as ReminderPeriodFilter)}>
            <option value="all">{t('kesp.agent.reminders.filters.all')}</option>
            <option value="today">{t('kesp.agent.reminders.filters.today')}</option>
            <option value="future">{t('kesp.agent.reminders.filters.future')}</option>
            <option value="overdue">{t('kesp.agent.reminders.filters.overdue')}</option>
            <option value="unscheduled">{t('kesp.agent.reminders.filters.unscheduled')}</option>
          </select>
        </div>
        <div className="filter-field">
          <label>{t('kesp.agent.reminders.filters.state')}</label>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as ReminderStateFilter)}>
            <option value="all">{t('kesp.agent.reminders.filters.all')}</option>
            <option value="open">{t('kesp.agent.reminders.filters.open')}</option>
            <option value="done">{t('kesp.agent.reminders.filters.done')}</option>
            <option value="closed">{t('kesp.agent.reminders.filters.closed')}</option>
            <option value="without_reminder">{t('kesp.agent.reminders.filters.withoutReminder')}</option>
          </select>
        </div>
      </div>

      <div className="row row-between" style={{ marginBottom: 12 }}>
        <div className="muted small">
          {t('kesp.agent.reminders.showing', {
            shown: filteredSnapshots.length,
            total: snapshots.length,
          })}
        </div>
        <Button
          kind="ghost"
          size="sm"
          icon={<Icon name="refresh" size={13} />}
          onClick={onRefresh}
          disabled={refreshing || !agent}
        >
          {refreshing ? t('kesp.agent.reminders.refreshing') : t('kesp.agent.reminders.refresh')}
        </Button>
      </div>

      {snapshots.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">
            {t('kesp.agent.reminders.noActivity')}
          </div>
        </div>
      ) : filteredSnapshots.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.agent.reminders.noMatches')}</div>
        </div>
      ) : (
        groupedByDay.map(/** Handles the callback for this operation. */([day, items]) => (
          <div key={day} className="tracker-day">
            <div className="tracker-day-head">
              <div className="tracker-date">{day}</div>
              <div className="tracker-meta">
                {t('kesp.agent.reminders.dayMeta', {
                  count: items.length,
                  followups: items.filter(/** Handles the callback for this operation. */(i) => i.followUpNeeded).length,
                })}
              </div>
            </div>
            {items.map(/** Handles the callback for this operation. */(it) => {
              const stage = getStageMeta(it.effectiveLifecycleStage, t);
              const task = it.reminderTaskType
                ? getTaskMeta(it.reminderTaskType, t)
                : null;
              const isOpen = open === it.id;
              const reminder = findAnyReminderForSnapshot(it);
              const openReminder = findOpenReminderForSnapshot(it);
              const reminderLine = formatReminderLine(it, reminder, t);
              const canUseOutcomeControls =
                Boolean(it.caseId) &&
                (it.followUpNeeded ||
                  it.effectiveLifecycleStage === 'sold_pending_follow_through' ||
                  it.effectiveLifecycleStage === 'future_follow_up');
              return (
                <div
                  key={it.id}
                  className={
                    'tracker-row' +
                    (reminder?.state === 'done' ||
                      it.effectiveLifecycleStage === 'fully_completed' ||
                      it.effectiveLifecycleStage === 'lost_cancelled'
                      ? ' done'
                      : '')
                  }
                >
                  <div className="head">
                    <div className="name">{it.customerName ?? it.callName ?? t('kesp.common.customerFallback')}</div>
                    <Pill kind={stage.kind === 'default' ? 'default' : stage.kind}>
                      {stage.label}
                    </Pill>
                    {task && (
                      <Pill
                        kind={task.kind === 'default' ? 'default' : task.kind}
                        icon={<span className="dot" />}
                      >
                        {task.label}
                      </Pill>
                    )}
                    {it.loanAmount && <Pill kind="default">{fmtMoneyMx(it.loanAmount, i18n.resolvedLanguage)}</Pill>}
                    <span className="spacer" />
                    {typeof it.confidenceScore === 'number' && (
                      <span className="muted tiny">
                        {t('kesp.agent.reminders.confidence', {
                          percent: Math.round(it.confidenceScore * 100),
                        })}
                      </span>
                    )}
                  </div>
                  {reminderLine && (
                    <div className="tracker-reminder" data-task={it.reminderTaskType ?? 'other'}>
                      <Icon name="clock" size={13} />
                      <b>{t('kesp.agent.reminders.reminder')}</b>
                      <span>{reminderLine}</span>
                    </div>
                  )}
                  {it.lastCallSummary && <div className="status">{it.lastCallSummary}</div>}
                  {it.nextBestAction && (
                    <div className="next">
                      <span className="arrow">→</span> {it.nextBestAction}
                    </div>
                  )}
                  <div className="tracker-actions">
                    {reminder?.state === 'done' ? (
                      <Button
                        size="sm"
                        kind="ghost"
                        icon={<Icon name="refresh" size={12} />}
                        disabled={savingId === it.id}
                        onClick={() => reopen(it)}
                      >
                        {t('kesp.agent.reminders.reopen')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        kind="primary"
                        icon={<Icon name="check" size={12} />}
                        disabled={!openReminder || savingId === it.id}
                        onClick={() => markDone(it)}
                      >
                        {t('kesp.agent.reminders.markDone')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      kind="ghost"
                      onClick={() => setOpen(isOpen ? null : it.id)}
                    >
                      {isOpen ? t('kesp.agent.reminders.hideDetail') : t('kesp.agent.reminders.viewDetail')}
                    </Button>
                  </div>
                  {isOpen && (
                    <div className="tracker-detail">
                      {it.lastCallSummary && (
                        <>
                          <div className="pc-label">{t('kesp.agent.reminders.aiSummary')}</div>
                          <p
                            className="muted"
                            style={{ margin: '4px 0 12px', lineHeight: 1.55 }}
                          >
                            {it.lastCallSummary}
                          </p>
                        </>
                      )}
                      {it.whatAgentShouldSayNext && (
                        <>
                          <div className="pc-label">{t('kesp.agent.reminders.whatToSayNext')}</div>
                          <p className="muted" style={{ margin: '4px 0 12px' }}>
                            {it.whatAgentShouldSayNext}
                          </p>
                        </>
                      )}
                      {it.suggestedFollowupMessage && (
                        <>
                          <div className="pc-label">{t('kesp.agent.reminders.suggestedMessage')}</div>
                          <p className="muted" style={{ margin: '4px 0 12px' }}>
                            {it.suggestedFollowupMessage}
                          </p>
                        </>
                      )}
                      {(it.followUpDate || it.followUpTime) && (
                        <div className="muted small" style={{ marginTop: 8 }}>
                          {t('kesp.agent.reminders.date')}{' '}
                          <b style={{ color: 'var(--ink-2)' }}>
                            {it.followUpDate ?? t('kesp.common.notAvailable')} {it.followUpTime ?? ''}
                          </b>
                        </div>
                      )}
                      {canUseOutcomeControls && (
                        <div className="loan-outcome">
                          <input
                            type="text"
                            placeholder={t('kesp.agent.reminders.notePlaceholder')}
                            aria-label={t('kesp.agent.reminders.noteAria')}
                            value={outcomeNotes[it.id] ?? ''}
                            onChange={(e) =>
                              setOutcomeNotes(/** Handles the callback for this operation. */(prev) => ({
                                ...prev,
                                [it.id]: e.target.value,
                              }))
                            }
                            disabled={savingId === it.id}
                          />
                          <div className="loan-outcome-actions">
                            <Button
                              size="sm"
                              kind="ghost"
                              disabled={savingId === it.id}
                              onClick={() => handleLoanOutcome(it, 'pending')}
                            >
                              {t('kesp.agent.reminders.keepPending')}
                            </Button>
                            <Button
                              size="sm"
                              kind="ghost"
                              disabled={savingId === it.id}
                              onClick={() => handleLoanOutcome(it, 'sold')}
                            >
                              {t('kesp.agent.reminders.sold')}
                            </Button>
                            <Button
                              size="sm"
                              kind="ghost"
                              className="btn-danger-outline"
                              disabled={savingId === it.id}
                              onClick={() => handleLoanOutcome(it, 'cancelled')}
                            >
                              {t('kesp.agent.reminders.cancelledOutcome')}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}

// ─── Progresión tab ──────────────────────────────────────────────────────────
function ProgresionTab({
  progressRollups,
  salesRollups,
  snapshots,
  onRequestDeleteSnapshot,
  navigate,
  returnTo,
}: {
  progressRollups: ProgressRollup[];
  salesRollups: SalesRollup[];
  snapshots: AgentCallSnapshot[];
  onRequestDeleteSnapshot: (snapshot: AgentCallSnapshot) => void;
  navigate: NavigateFn;
  returnTo: string;
}) {
  const { t, i18n } = useTranslation();
  const [period, setPeriod] = useState<ProgressFilterPeriod>('week');
  const [selectedDay, setSelectedDay] = useState('');
  const [selectedWeek, setSelectedWeek] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const periodProgressRollups = useMemo(
    /** Handles the callback for this operation. */
    () =>
      period === 'custom'
        ? []
        : progressRollups.filter(/** Handles the callback for this operation. */(rollup) => rollup.periodType === period),
    [period, progressRollups]
  );
  const periodSalesRollups = useMemo(
    /** Handles the callback for this operation. */
    () =>
      period === 'custom'
        ? []
        : salesRollups.filter(/** Handles the callback for this operation. */(rollup) => rollup.periodType === period),
    [period, salesRollups]
  );

  const latestDay = useMemo(
    /** Handles the callback for this operation. */
    () =>
      progressRollups.find(/** Handles the callback for this operation. */(rollup) => rollup.periodType === 'day')?.bucketKey ??
      snapshots[0]?.bucketDay ??
      '',
    [progressRollups, snapshots]
  );
  const latestWeek = useMemo(
    /** Handles the callback for this operation. */
    () =>
      progressRollups.find(/** Handles the callback for this operation. */(rollup) => rollup.periodType === 'week')?.bucketKey ??
      snapshots[0]?.bucketWeek ??
      '',
    [progressRollups, snapshots]
  );
  const latestMonth = useMemo(
    /** Handles the callback for this operation. */
    () =>
      progressRollups.find(/** Handles the callback for this operation. */(rollup) => rollup.periodType === 'month')?.bucketKey ??
      snapshots[0]?.bucketMonth ??
      '',
    [progressRollups, snapshots]
  );

  // Default empty filter controls to the latest available buckets without a state-synchronizing effect.
  const activeSelectedDay = selectedDay || latestDay;
  const activeSelectedWeek = selectedWeek || latestWeek;
  const activeSelectedMonth = selectedMonth || latestMonth;
  const activeCustomStart = customStart || (latestMonth ? `${latestMonth}-01` : '');
  const activeCustomEnd = customEnd || latestDay;

  const activeBucketKey =
    period === 'day'
      ? activeSelectedDay
      : period === 'week'
        ? activeSelectedWeek
        : period === 'month'
          ? activeSelectedMonth
          : activeCustomStart && activeCustomEnd
            ? `${activeCustomStart} - ${activeCustomEnd}`
            : '';

  const periodSnapshots = useMemo(
    /** Handles the callback for this operation. */
    () => snapshotsForPeriod(snapshots, period, activeBucketKey, activeCustomStart, activeCustomEnd),
    [activeBucketKey, activeCustomEnd, activeCustomStart, period, snapshots]
  );

  const currentProgress = useMemo<ProgressViewRollup | null>(
    /** Handles the callback for this operation. */
    () => {
      if (period === 'custom') {
        if (!dateKey(activeCustomStart) || !dateKey(activeCustomEnd) || activeCustomStart > activeCustomEnd) return null;
        return buildProgressSummary(period, activeBucketKey, periodSnapshots);
      }
      if (!activeBucketKey) return null;
      return (
        periodProgressRollups.find(/** Handles the callback for this operation. */(rollup) => rollup.bucketKey === activeBucketKey) ??
        buildProgressSummary(period, activeBucketKey, periodSnapshots)
      );
    },
    [activeBucketKey, activeCustomEnd, activeCustomStart, period, periodProgressRollups, periodSnapshots]
  );

  const previousProgress = useMemo<ProgressRollup | null>(
    /** Handles the callback for this operation. */
    () => {
      if (period === 'custom' || !activeBucketKey) return null;
      const currentIndex = periodProgressRollups.findIndex(
        /** Handles the callback for this operation. */
        (rollup) => rollup.bucketKey === activeBucketKey
      );
      return currentIndex >= 0 ? periodProgressRollups[currentIndex + 1] ?? null : null;
    },
    [activeBucketKey, period, periodProgressRollups]
  );

  const currentSales = useMemo<SalesViewRollup | null>(
    /** Handles the callback for this operation. */
    () => {
      if (period === 'custom') {
        if (!dateKey(activeCustomStart) || !dateKey(activeCustomEnd) || activeCustomStart > activeCustomEnd) return null;
        return buildSalesSummary(period, activeBucketKey, periodSnapshots);
      }
      if (!activeBucketKey) return null;
      return (
        periodSalesRollups.find(/** Handles the callback for this operation. */(rollup) => rollup.bucketKey === activeBucketKey) ??
        buildSalesSummary(period, activeBucketKey, periodSnapshots)
      );
    },
    [activeBucketKey, activeCustomEnd, activeCustomStart, period, periodSalesRollups, periodSnapshots]
  );

  const previousSales = useMemo<SalesRollup | null>(
    /** Handles the callback for this operation. */
    () => {
      if (period === 'custom' || !activeBucketKey) return null;
      const currentIndex = periodSalesRollups.findIndex(
        /** Handles the callback for this operation. */
        (rollup) => rollup.bucketKey === activeBucketKey
      );
      return currentIndex >= 0 ? periodSalesRollups[currentIndex + 1] ?? null : null;
    },
    [activeBucketKey, period, periodSalesRollups]
  );

  const trend = useMemo(/** Handles the callback for this operation. */() => {
    const sorted = [...periodSnapshots].sort(
      /** Handles the callback for this operation. */
      (a, b) => a.callOccurredAtMs - b.callOccurredAtMs
    );
    const scored = sorted.filter(
      /** Handles the callback for this operation. */
      (s): s is AgentCallSnapshot & { overallScore: number } => typeof s.overallScore === 'number'
    );
    return scored.slice(-10).map(/** Handles the callback for this operation. */(s) => s.overallScore);
  }, [periodSnapshots]);

  const scoreDelta =
    typeof currentProgress?.averageScore === 'number' &&
      typeof previousProgress?.averageScore === 'number'
      ? currentProgress.averageScore - previousProgress.averageScore
      : null;

  return (
    <div className="rise">
      <div className="progress-filter-bar">
        <div className="progress-filter-main">
          <div className="period-toggle" role="tablist">
            {(['day', 'week', 'month', 'custom'] as ProgressFilterPeriod[]).map(/** Handles the callback for this operation. */(id) => (
              <button
                key={id}
                className="period-btn"
                aria-selected={period === id}
                onClick={() => setPeriod(id)}
              >
                {periodLabel(id, t)}
              </button>
            ))}
          </div>
          <div className="progress-filter-fields">
            {period === 'day' && (
              <label className="progress-filter-field">
                <span>{t('kesp.agent.progression.exactDate')}</span>
                <input
                  type="date"
                  value={activeSelectedDay}
                  onChange={/** Handles the onChange interaction. */(event) => setSelectedDay(dateKey(event.target.value))}
                />
              </label>
            )}
            {period === 'week' && (
              <label className="progress-filter-field">
                <span>{t('kesp.agent.progression.weekStart')}</span>
                <input
                  type="date"
                  value={activeSelectedWeek}
                  onChange={/** Handles the onChange interaction. */(event) => setSelectedWeek(normalizeWeekBucket(event.target.value))}
                />
                {dateKey(activeSelectedWeek) && <em>{addDaysToKey(activeSelectedWeek, 6)}</em>}
              </label>
            )}
            {period === 'month' && (
              <label className="progress-filter-field">
                <span>{t('kesp.agent.progression.specificMonth')}</span>
                <input
                  type="month"
                  value={activeSelectedMonth}
                  onChange={/** Handles the onChange interaction. */(event) => setSelectedMonth(monthKey(event.target.value))}
                />
              </label>
            )}
            {period === 'custom' && (
              <>
                <label className="progress-filter-field">
                  <span>{t('kesp.agent.progression.rangeFrom')}</span>
                  <input
                    type="date"
                    value={activeCustomStart}
                    onChange={/** Handles the onChange interaction. */(event) => setCustomStart(dateKey(event.target.value))}
                  />
                </label>
                <label className="progress-filter-field">
                  <span>{t('kesp.agent.progression.rangeTo')}</span>
                  <input
                    type="date"
                    value={activeCustomEnd}
                    onChange={/** Handles the onChange interaction. */(event) => setCustomEnd(dateKey(event.target.value))}
                  />
                </label>
              </>
            )}
          </div>
        </div>
        <div className="muted tiny">
          {t('kesp.agent.progression.currentPeriod', {
            period: currentProgress?.bucketKey || activeBucketKey || t('kesp.common.notAvailable'),
          })}
        </div>
      </div>

      <div className="prog-kpi-grid">
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.progression.reviewedCalls')}</div>
          <div className="val">{currentProgress?.totalReviewedCalls ?? 0}</div>
        </div>
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.progression.averageScore')}</div>
          <div className="val">
            {typeof currentProgress?.averageScore === 'number'
              ? currentProgress.averageScore.toFixed(1)
              : '—'}
            {typeof currentProgress?.averageScore === 'number' && <small>/100</small>}
            {scoreDelta != null && (
              <span
                className={'kpi-delta ' + (scoreDelta >= 0 ? 'up' : 'down')}
                style={{ marginLeft: 8 }}
              >
                <Icon name={scoreDelta >= 0 ? 'chevronUp' : 'chevronDown'} size={11} />
                {Math.abs(scoreDelta).toFixed(1)}
              </span>
            )}
          </div>
        </div>
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.progression.scoreChange')}</div>
          <div
            className="val"
            style={{
              color:
                scoreDelta == null
                  ? 'var(--ink-3)'
                  : scoreDelta >= 0
                    ? 'var(--good)'
                    : 'var(--bad)',
            }}
          >
            {scoreDelta == null
              ? '—'
              : `${scoreDelta >= 0 ? '+' : ''}${scoreDelta.toFixed(1)}`}
          </div>
        </div>
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.progression.lowConfidence')}</div>
          <div className="val" style={{ color: 'var(--warn)' }}>
            {String(currentProgress?.lowConfidenceCallCount ?? 0).padStart(2, '0')}
          </div>
        </div>
      </div>

      <div className="ventas-card">
        <div className="head">
          <div className="lbl">
            <Icon name="chart" size={12} /> {t('kesp.agent.progression.salesTitle', {
              period: periodLabel(period, t).toLowerCase(),
            })}
          </div>
          <div className="muted tiny">{t('kesp.agent.progression.salesSubtitle')}</div>
        </div>
        <div className="ventas-grid">
          <div className="ventas-cell">
            <div className="lbl">{t('kesp.agent.progression.soldCredits')}</div>
            <div className="val">
              {currentSales?.soldLoanCount ?? 0}
              {previousSales && (
                <span
                  className={
                    'kpi-delta ' +
                    ((currentSales?.soldLoanCount ?? 0) >= (previousSales?.soldLoanCount ?? 0)
                      ? 'up'
                      : 'down')
                  }
                  style={{ marginLeft: 6 }}
                >
                  <Icon
                    name={
                      (currentSales?.soldLoanCount ?? 0) >= (previousSales?.soldLoanCount ?? 0)
                        ? 'chevronUp'
                        : 'chevronDown'
                    }
                    size={11}
                  />
                  {Math.abs(
                    (currentSales?.soldLoanCount ?? 0) - (previousSales?.soldLoanCount ?? 0)
                  )}
                </span>
              )}
            </div>
          </div>
          <div className="ventas-cell">
            <div className="lbl">{t('kesp.agent.progression.amountSold')}</div>
            <div className="val" style={{ color: 'var(--good)' }}>
              {fmtMoneyMx(currentSales?.totalAmountSold, i18n.resolvedLanguage)}
            </div>
          </div>
          <div className="ventas-cell">
            <div className="lbl">{t('kesp.agent.progression.averageTicket')}</div>
            <div className="val">{fmtMoneyMx(currentSales?.averageLoanAmount, i18n.resolvedLanguage)}</div>
          </div>
        </div>
      </div>

      <div className="kpi-grid kpi-grid-2" style={{ marginBottom: 18 }}>
        <div className="fw-list-card good">
          <h3 className="row" style={{ gap: 8, color: 'var(--good)' }}>
            <span className="dot" style={{ background: 'var(--good)' }} />
            {t('kesp.agent.progression.repeatedStrengths')}
          </h3>
          {(currentProgress?.topStrengths ?? []).length === 0 ? (
            <div className="muted small">{t('kesp.agent.progression.noDataPeriod')}</div>
          ) : (
            (currentProgress?.topStrengths ?? []).slice(0, 5).map(/** Handles the callback for this operation. */(f, i) => (
              <div key={i} className="fw-list-row">
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <div className="t">{f.label}</div>
                  <div className="s">
                    {t('kesp.agent.progression.callsCount', {
                      count: f.count,
                      total: currentProgress?.totalReviewedCalls ?? 0,
                    })}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="fw-list-card bad">
          <h3 className="row" style={{ gap: 8, color: 'var(--warn)' }}>
            <span className="dot" style={{ background: 'var(--warn)' }} />
            {t('kesp.agent.progression.repeatedWeaknesses')}
          </h3>
          {(currentProgress?.topWeaknesses ?? []).length === 0 ? (
            <div className="muted small">{t('kesp.agent.progression.noDataPeriod')}</div>
          ) : (
            (currentProgress?.topWeaknesses ?? []).slice(0, 5).map(/** Handles the callback for this operation. */(d, i) => (
              <div key={i} className="fw-list-row">
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <div className="t">{d.label}</div>
                  <div className="s">
                    {t('kesp.agent.progression.callsCount', {
                      count: d.count,
                      total: currentProgress?.totalReviewedCalls ?? 0,
                    })}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {(currentProgress?.coachingPriorities ?? []).length > 0 && (
        <div className="qe-section">
          <div className="qe-head">
            <span className="dot" style={{ background: 'var(--info)' }} />
            {t('kesp.agent.progression.whatToTrain')}
          </div>
          <div className="qe-grid">
            {(currentProgress?.coachingPriorities ?? []).slice(0, 3).map(/** Handles the callback for this operation. */(q, i) => (
              <div key={i} className="qe-box">
                <div className="qe-box-head">
                  <span className="num">{String(i + 1).padStart(2, '0')}</span>
                  <span className="cnt">
                    {q.count}/{currentProgress?.totalReviewedCalls ?? 0}
                  </span>
                </div>
                <div className="qe-box-title">{q.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {trend.length > 1 && (
        <TrendChart data={trend} label={t('kesp.agent.progression.trendLabel', { count: trend.length })} />
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <div className="row row-between" style={{ marginBottom: 14 }}>
          <div>
            <h3 className="card-h">{t('kesp.agent.progression.historyTitle')}</h3>
            <div className="card-sub" style={{ marginBottom: 0 }}>
              {t('kesp.agent.progression.periodCalls', { count: periodSnapshots.length })}
            </div>
          </div>
        </div>
        {periodSnapshots.length === 0 ? (
          <div className="muted small" style={{ padding: '12px 0' }}>
            {t('kesp.agent.progression.emptyPeriod')}
          </div>
        ) : (
          <div style={{ overflow: 'auto', marginInline: -8 }}>
            <table className="htable">
              <thead>
                <tr>
                  <th>{t('kesp.agent.progression.table.callId')}</th>
                  <th>{t('kesp.agent.progression.table.client')}</th>
                  <th>{t('kesp.agent.progression.table.result')}</th>
                  <th>{t('kesp.agent.progression.table.stage')}</th>
                  <th>{t('kesp.agent.progression.table.loan')}</th>
                  <th>{t('kesp.agent.progression.table.amount')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {periodSnapshots.map(/** Handles the callback for this operation. */(s) => {
                  const stage =
                    getStageMeta(s.effectiveLifecycleStage, t);
                  return (
                    <tr
                      key={s.id}
                      onClick={() =>
                        navigate(appendReturnTo(`/kesp/call/${encodeURIComponent(s.sourceCallId)}`, returnTo))
                      }
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="id">{s.sourceCallId.slice(0, 36)}…</td>
                      <td>
                        <b style={{ fontWeight: 500 }}>
                          {s.customerName ?? t('kesp.common.notAvailable')}
                        </b>
                      </td>
                      <td>
                        <Pill kind={s.followUpNeeded ? 'warn' : 'bad'}>
                          {s.followUpNeeded
                            ? t('kesp.agent.progression.requiresFollowUp')
                            : t('kesp.agent.progression.closed')}
                        </Pill>
                      </td>
                      <td>
                        <Pill kind={stage.kind === 'default' ? 'default' : stage.kind}>
                          {stage.label}
                        </Pill>
                      </td>
                      <td>
                        {s.loanCompleted
                          ? t(`kesp.loan.${s.loanCompleted}`, { defaultValue: s.loanCompleted })
                          : t('kesp.common.notAvailable')}
                      </td>
                      <td style={{ fontWeight: 500, fontFeatureSettings: '"tnum"' }}>
                        {fmtMoneyMx(s.loanAmount, i18n.resolvedLanguage)}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            className="nav-icon-btn"
                            title={t('kesp.common.deleteCall')}
                            aria-label={t('kesp.common.deleteCall')}
                            onClick={(e) => {
                              e.stopPropagation();
                              onRequestDeleteSnapshot(s);
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                          <Icon name="arrow" size={14} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Renders the TrendChart component. */
function TrendChart({ data, label }: { data: number[]; label: string }) {
  const { t } = useTranslation();
  const w = 1000;
  const h = 220;
  const pad = { l: 24, r: 24, t: 24, b: 24 };
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const avg = data.reduce(/** Handles the callback for this operation. */(s, v) => s + v, 0) / data.length;
  const ix = /** Documents the ix behavior. */ (i: number) =>
    pad.l + (i * (w - pad.l - pad.r)) / Math.max(1, data.length - 1);
  const iy = /** Documents the iy behavior. */ (v: number) =>
    pad.t + (1 - (v - min) / Math.max(1, max - min)) * (h - pad.t - pad.b);
  const linePts = data.map(/** Handles the callback for this operation. */(v, i) => `${ix(i)},${iy(v)}`).join(' ');
  const areaPath = `M${pad.l},${h - pad.b} L${linePts} L${w - pad.r},${h - pad.b} Z`;

  const activePoint =
    hoverIndex == null
      ? null
      : {
        i: hoverIndex,
        v: data[hoverIndex] ?? null,
        x: ix(hoverIndex),
        y: iy(data[hoverIndex] ?? 0),
      };

  const handlePointerMove = /** Handles the handlePointerMove interaction. */ (e: ReactPointerEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    if (data.length === 0) return;

    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * w;
    const plotW = w - pad.l - pad.r;
    const step = plotW / Math.max(1, data.length - 1);
    const i = Math.min(
      data.length - 1,
      Math.max(0, Math.round((x - pad.l) / Math.max(1e-6, step)))
    );
    setHoverIndex(/** Handles the callback for this operation. */(prev) => (prev === i ? prev : i));
  };

  return (
    <div className="trend-card">
      <div className="row row-between row-wrap" style={{ marginBottom: 12, gap: 10 }}>
        <div className="lbl">
          <Icon name="chart" size={12} /> {t('kesp.agent.progression.trendTitle', {
            label: label.toUpperCase(),
          })}
        </div>
        <div className="row" style={{ gap: 16, fontSize: 11.5, color: 'var(--ink-3)' }}>
          <span>
            {t('kesp.agent.progression.min')} <b style={{ color: 'var(--ink)' }}>{min.toFixed(0)}</b>
          </span>
          <span>
            {t('kesp.agent.progression.max')} <b style={{ color: 'var(--ink)' }}>{max.toFixed(0)}</b>
          </span>
          <span>
            {t('kesp.agent.progression.average')} <b style={{ color: 'var(--ink)' }}>{avg.toFixed(0)}</b>
          </span>
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${h}`}
        style={{ width: '100%', height: 220, display: 'block' }}
      >
        <defs>
          <linearGradient id="trendgrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--info)" stopOpacity="0.20" />
            <stop offset="100%" stopColor="var(--info)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map(/** Handles the callback for this operation. */(p, i) => (
          <line
            key={i}
            x1={pad.l}
            x2={w - pad.r}
            y1={pad.t + p * (h - pad.t - pad.b)}
            y2={pad.t + p * (h - pad.t - pad.b)}
            stroke="var(--line)"
            strokeDasharray="2,4"
          />
        ))}
        <path d={areaPath} fill="url(#trendgrad)" />
        <polyline
          points={linePts}
          fill="none"
          stroke="var(--info)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {data.map(/** Handles the callback for this operation. */(v, i) => (
          <g key={i}>
            <title>
              {t('kesp.common.score')}: {v.toFixed(0)}
            </title>
            <circle
              cx={ix(i)}
              cy={iy(v)}
              r={i === data.length - 1 ? 5 : 3.5}
              fill="var(--bg-elev)"
              stroke="var(--info)"
              strokeWidth={2}
            />
          </g>
        ))}

        <rect
          x={pad.l}
          y={pad.t}
          width={w - pad.l - pad.r}
          height={h - pad.t - pad.b}
          fill="transparent"
          onPointerMove={handlePointerMove}
          onPointerLeave={/** Handles the onPointerLeave interaction. */ () => setHoverIndex(null)}
        />

        {activePoint?.v != null && (
          <>
            <line
              x1={activePoint.x}
              x2={activePoint.x}
              y1={pad.t}
              y2={h - pad.b}
              stroke="var(--line)"
              strokeDasharray="2,4"
              pointerEvents="none"
            />
            <circle
              cx={activePoint.x}
              cy={activePoint.y}
              r={6}
              fill="var(--bg-elev)"
              stroke="var(--info)"
              strokeWidth={2.5}
              pointerEvents="none"
            />
            {(() => {
              const scoreLabel = `${t('kesp.common.score')}: ${activePoint.v.toFixed(0)}`;
              const boxW = Math.max(66, scoreLabel.length * 6.2 + 16);
              const boxH = 22;
              const boxX = Math.min(w - pad.r - boxW, Math.max(pad.l, activePoint.x - boxW / 2));
              const boxY = Math.max(pad.t, activePoint.y - 34);
              return (
                <g pointerEvents="none">
                  <rect
                    x={boxX}
                    y={boxY}
                    width={boxW}
                    height={boxH}
                    rx={6}
                    fill="var(--bg-elev)"
                    stroke="var(--line)"
                  />
                  <text
                    x={boxX + boxW / 2}
                    y={boxY + 15}
                    textAnchor="middle"
                    fontSize={12}
                    fill="var(--ink)"
                    style={{ fontFeatureSettings: '"tnum"' }}
                  >
                    {scoreLabel}
                  </text>
                </g>
              );
            })()}
          </>
        )}
      </svg>
    </div>
  );
}

// ─── Page shell ──────────────────────────────────────────────────────────────
export function AgentPage() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const { user } = useAuth();
  const processing = useDemoProcessingStatus();
  const [agentAnalyses, setAgentAnalyses] = useState<AgentAnalysis[]>([]);
  const [agent, setAgent] = useState<AgentAnalysis | null>(null);
  const [report, setReport] = useState<AgentAnalysisReport | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [loadedCallsAgentId, setLoadedCallsAgentId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<AgentCallSnapshot[]>([]);
  const [reminders, setReminders] = useState<AgentReminder[]>([]);
  const [progressRollups, setProgressRollups] = useState<ProgressRollup[]>([]);
  const [salesRollups, setSalesRollups] = useState<SalesRollup[]>([]);
  const [tab, setTab] = useState<TabId>(() => tabFromSearch(location.search));
  const [pendingDelete, setPendingDelete] = useState<{
    callId: string;
    audioPath?: string;
    label: string;
  } | null>(null);
  const [profileDeleteOpen, setProfileDeleteOpen] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [consubancoMember, setConsubancoMember] = useState<OrganizationMember | null>(null);

  // Fall back to first agent if no id provided
  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return;
    if (consubancoMember?.role === 'agent') {
      setAgentAnalyses([]);
      return;
    }
    return subscribeToAgentAnalyses(user.uid, setAgentAnalyses);
  }, [consubancoMember?.role, user?.uid]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) {
      setConsubancoMember(null);
      return /** Handles the callback for this operation. */ () => undefined;
    }

    return subscribeToConsubancoMembership(
      user.uid,
      setConsubancoMember,
      /** Handles the callback for this operation. */() => setConsubancoMember(null)
    );
  }, [user?.uid]);

  const isSignedInConsubancoAgent = isConsubancoAgentMember(consubancoMember);
  const signedInAgentProfileId = consubancoMember?.salesAgentId ?? null;
  const targetId = isSignedInConsubancoAgent
    ? signedInAgentProfileId ?? params.id
    : params.id ?? agentAnalyses[0]?.id;

  useEffect(/** Handles the callback for this operation. */() => {
    if (!targetId) {
      setAgent(null);
      return;
    }
    return subscribeToAgentAnalysis(targetId, setAgent);
  }, [targetId]);

  const agentKey = useMemo(/** Handles the callback for this operation. */() => {
    if (!agent?.uploadedBy || !agent?.salesAgentId) return null;
    return buildAgentKey(agent.uploadedBy, agent.salesAgentId);
  }, [agent?.uploadedBy, agent?.salesAgentId]);

  const cccProfileEnvironmentTarget = useMemo(/** Handles the callback for this operation. */() => {
    if (agent?.isCccCanonicalProfile !== true) return undefined;
    if (isProductionFirebaseProject) return 'prod' as const;
    if (isTestingFirebaseProject) return 'test' as const;
    return undefined;
  }, [agent?.isCccCanonicalProfile]);

  // Calls
  useEffect(/** Handles the callback for this operation. */() => {
    setLoadedCallsAgentId(null);
    setCalls([]);
    if (!user?.uid || !agent?.salesAgentId) {
      setCalls([]);
      return;
    }
    return subscribeToAgentLinkedCalls(
      {
        userId: user.uid,
        agentAnalysisId: agent.id,
        salesAgentId: agent.salesAgentId,
        environmentTarget: cccProfileEnvironmentTarget,
      },
      (nextCalls) => {
        setCalls(nextCalls);
        setLoadedCallsAgentId(agent.id);
      }
    );
  }, [user?.uid, agent?.id, agent?.salesAgentId, cccProfileEnvironmentTarget]);

  // Report
  useEffect(/** Handles the callback for this operation. */() => {
    if (!agent?.id) {
      setReport(null);
      return;
    }
    return subscribeToAgentAnalysisReport(agent.id, agent.latestReportId, setReport);
  }, [agent?.id, agent?.latestReportId]);

  // Activity layer
  useEffect(/** Handles the callback for this operation. */() => {
    if (!agentKey) {
      setSnapshots([]);
      setReminders([]);
      setProgressRollups([]);
      setSalesRollups([]);
      return;
    }
    const unsubA = subscribeToAgentCallSnapshots(agentKey, (nextSnapshots) => {
      setSnapshots(cccProfileEnvironmentTarget
        ? nextSnapshots.filter((snapshot) => snapshot.environmentTarget === cccProfileEnvironmentTarget)
        : nextSnapshots);
    });
    const unsubB = subscribeToAgentReminders(agentKey, setReminders);
    const unsubC = subscribeToProgressRollups(agentKey, setProgressRollups);
    const unsubD = subscribeToSalesRollups(agentKey, setSalesRollups);
    return () => {
      unsubA();
      unsubB();
      unsubC();
      unsubD();
    };
  }, [agentKey, cccProfileEnvironmentTarget]);

  const reportInProgress =
    agent?.status === 'analyzing' || (agent?.activeRunId != null && agent?.activeRunId !== '');
  const returnTo = `${location.pathname}${location.search}`;
  const regularCalls = useMemo(() => calls.filter(isRegularAgentProfileCall), [calls]);
  const shortCallCalls = useMemo(() => calls.filter(isShortCallReviewCall), [calls]);
  const shortCallReturnTo = useMemo(() => {
    const params = new URLSearchParams(location.search);
    params.set('tab', 'shortCalls');
    const search = params.toString();
    return `${location.pathname}${search ? `?${search}` : ''}`;
  }, [location.pathname, location.search]);

  const onTriggerReport = /** Handles the onTriggerReport interaction. */ async () => {
    if (!agent || triggering || reportInProgress || !processing.canStart) return;
    const canTriggerCurrentReport = agent.uploadedBy === user?.uid || agent.isCccCanonicalProfile === true || (isSharedDemoAgentProfile(agent) && isConsubancoSupervisorOrAdminMember(consubancoMember));
    if (!canTriggerCurrentReport) {
      toast.error(t('kesp.agent.shell.toasts.triggerError'));
      return;
    }

    setTriggering(true);
    try {
      if (!(await processing.checkCanStart())) return;
      let runInput:
        | Parameters<typeof triggerAgentAnalysisRun>[1]
        | undefined;
      try {
        const promptCatalog = await getAvailablePrompts();
        const validatedSettings = validateKespUploadPromptSettings(
          loadKespUploadPromptSettings(),
          promptCatalog
        );
        runInput = {
          reportProcessingConfig: {
            promptVersions: validatedSettings.reportPromptVersions ?? {},
          },
        };
      } catch (settingsError) {
        console.warn('Failed to load report prompt settings:', settingsError);
      }

      const result = await triggerAgentAnalysisRun(agent.id, runInput);
      if (result.started) {
        toast.success(t('kesp.agent.shell.toasts.analysisStarted'));
      } else if (result.result === 'no_changes') {
        toast.info(t('kesp.agent.shell.toasts.noChanges'));
      } else if (result.result === 'no_complete_calls' || result.result === 'no_eligible_calls') {
        toast.error(t('kesp.agent.shell.toasts.noEligibleCalls'));
      } else if (result.result === 'already_running') {
        toast.info(t('kesp.agent.shell.toasts.alreadyRunning'));
      }
    } catch (err) {
      console.error('Failed to trigger report:', err);
      toast.error(t('kesp.agent.shell.toasts.triggerError'));
    } finally {
      setTriggering(false);
    }
  };

  const onRefreshActivity = /** Handles the onRefreshActivity interaction. */ async () => {
    if (!agent) return;
    setRefreshing(true);
    try {
      await refreshAgentActivity(agent.id);
      toast.success(t('kesp.agent.shell.toasts.activitySuccess'));
    } catch (err) {
      console.error('Failed to refresh activity:', err);
      toast.error(t('kesp.agent.shell.toasts.activityError'));
    } finally {
      setRefreshing(false);
    }
  };

  const onAgentCheckIn = /** Handles the onAgentCheckIn interaction. */ async () => {
    if (!agent?.salesAgentId || checkingIn) return;
    setCheckingIn(true);
    try {
      const result = await agentProfileCheckIn(agent.salesAgentId);
      if (result.status === 'already_checked_in') {
        toast.info(t('kesp.agent.checkIn.alreadyCheckedIn', { defaultValue: 'Check-in already recorded for today.' }));
      } else {
        toast.success(t('kesp.agent.checkIn.success', { defaultValue: 'Check-in sent to supervisors.' }));
      }
    } catch (err) {
      console.error('Failed to submit agent check-in:', err);
      toast.error(t('kesp.agent.checkIn.error', { defaultValue: 'Unable to send check-in.' }));
    } finally {
      setCheckingIn(false);
    }
  };

  const requestDeleteCall = /** Documents the requestDeleteCall behavior. */ (call: Call) => {
    setPendingDelete({
      callId: call.id,
      audioPath: call.audioPath,
      label: call.displayName ?? call.name ?? call.id,
    });
  };

  const requestDeleteSnapshot = /** Documents the requestDeleteSnapshot behavior. */ (snapshot: AgentCallSnapshot) => {
    setPendingDelete({
      callId: snapshot.sourceCallId,
      label: snapshot.customerName ?? snapshot.callName ?? snapshot.sourceCallId,
    });
  };

  const onCallDeleted = /** Handles the onCallDeleted interaction. */ () => {
    const label = pendingDelete?.label ?? t('kesp.criterion.backCall');
    setPendingDelete(null);
    if (!agent) {
      toast.success(t('kesp.agent.shell.toasts.deleted', { label }));
      return;
    }
    toast.success(t('kesp.agent.shell.toasts.deleted', { label }), {
      action: {
        label: t('kesp.agent.shell.toasts.regenerateReport'),
        onClick: () => {
          void onTriggerReport();
        },
      },
      duration: 8000,
    });
  };

  if (!user?.uid) {
    return (
      <main className="main">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.agent.shell.signIn')}</div>
        </div>
      </main>
    );
  }

  if (!agent) {
    return (
      <main className="main">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.agent.shell.loadingAgent')}</div>
        </div>
      </main>
    );
  }

  const canManageAgent = agent.uploadedBy === user.uid;
  const isCanonicalCccProfile = agent.isCccCanonicalProfile === true;
  const isConsubancoOrgMember = isConsubancoMember(consubancoMember);
  const isOwnMappedAgentProfile = isSignedInConsubancoAgent && signedInAgentProfileId === agent.salesAgentId;
  const canTriggerReport = !isSignedInConsubancoAgent && (canManageAgent || isCanonicalCccProfile || (isSharedDemoAgentProfile(agent) && isConsubancoSupervisorOrAdminMember(consubancoMember)));
  const canUseAgentAssistant = !isSignedInConsubancoAgent && (canManageAgent || !isCanonicalCccProfile || isConsubancoOrgMember);
  const canAgentCheckIn = isOwnMappedAgentProfile && isCanonicalCccProfile;

  if (isSignedInConsubancoAgent && signedInAgentProfileId && agent.salesAgentId !== signedInAgentProfileId) {
    return (
      <main className="main">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.agent.shell.accessDenied', { defaultValue: 'You only have access to your assigned agent profile.' })}</div>
        </div>
      </main>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'carga', label: t('kesp.agent.shell.tabs.upload') },
    { id: 'reporte', label: t('kesp.agent.shell.tabs.report') },
    { id: 'rubrica', label: t('kesp.agent.shell.tabs.rubric') },
    { id: 'recordatorio', label: t('kesp.agent.shell.tabs.reminders') },
    { id: 'progresion', label: t('kesp.agent.shell.tabs.progression') },
    { id: 'arvo', label: t('kesp.agent.shell.tabs.arvo') },
    { id: 'shortCalls', label: t('kesp.agent.shell.tabs.shortCalls') },
  ];

  const patternsCount = isReportV2(report) ? report.patterns.length : 0;
  const priorityPatterns = isReportV2(report)
    ? report.patterns.filter(/** Handles the callback for this operation. */(p) => p.priorityScore <= 2).length
    : 0;
  const tareasActivas = reminders.filter(/** Handles the callback for this operation. */(r) => r.state === 'open').length;
  const aggregateRangeSessionKey = aggregateRubricRangeSessionKey(agent.id);
  const aggregateInitialRange =
    rangeFromSearchParamsOrNull(location.search) ??
    readSessionAggregateRubricRange(aggregateRangeSessionKey) ??
    buildDefaultAggregateRubricRange();

  return (
    <AgentProfileAssistantProvider
      agentAnalysisId={agent.id}
      salesAgentName={maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId)}
      enabled={canUseAgentAssistant}
    >
    <main className="main">
      <div className="row row-wrap" style={{ marginBottom: 20, gap: 8 }}>
        {!isSignedInConsubancoAgent && (
          <>
            <button
              className="linkish row"
              style={{ gap: 6 }}
              onClick={() => navigate('/kesp/analizador')}
            >
              <Icon name="arrowLeft" size={13} /> {t('kesp.agent.shell.backAnalyzer')}
            </button>
            <span className="muted">/</span>
          </>
        )}
        <span className="muted">{maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId)}</span>
      </div>

      <div
        className="page-head"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 24,
          flexWrap: 'wrap',
          marginBottom: 24,
        }}
      >
        <div>
          <div className="eyebrow">{t('kesp.agent.shell.eyebrow')}</div>
          <h1 className="page-title">{maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId)}</h1>
          <div className="row row-wrap" style={{ gap: 10, marginTop: 10, marginBottom: 6 }}>
            {isCanonicalCccProfile && <Pill kind="info">CCC</Pill>}
            <Pill kind="default">{t('kesp.agent.shell.linkedCalls', { count: regularCalls.length })}</Pill>
            {shortCallCalls.length > 0 && (
              <Pill kind="info">{t('kesp.agent.shell.tabs.shortCalls')}: {shortCallCalls.length}</Pill>
            )}
            <Pill
              kind={
                agent.status === 'complete'
                  ? 'good'
                  : agent.status === 'analyzing'
                    ? 'warn'
                    : agent.status === 'error'
                      ? 'bad'
                      : 'default'
              }
            >
              {statusLabel(agent.status, t)}
            </Pill>
          </div>
          <p className="page-sub" style={{ margin: 0, fontSize: 13 }}>
            ID <span style={{ fontSize: 12 }}>{agent.salesAgentId}</span>
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {canAgentCheckIn && (
            <Button
              kind="soft"
              size="sm"
              icon={<Icon name="check" size={13} />}
              onClick={onAgentCheckIn}
              disabled={checkingIn}
            >
              {checkingIn
                ? t('kesp.agent.checkIn.sending', { defaultValue: 'Checking in...' })
                : t('kesp.agent.checkIn.button', { defaultValue: 'Check in' })}
            </Button>
          )}
          {canManageAgent && !agent.isActiveAgentProfile && (
            <Button
              kind="ghost"
              size="sm"
              icon={<Trash2 size={13} />}
              onClick={() => setProfileDeleteOpen(true)}
            >
              {t('kesp.agent.shell.deleteProfile')}
            </Button>
          )}
          {canTriggerReport && (
            <Button
              kind="primary"
              size="sm"
              icon={<Icon name="refresh" size={13} />}
              onClick={onTriggerReport}
              disabled={triggering || reportInProgress || !processing.canStart}
            >
              {triggering
                ? t('kesp.agent.shell.starting')
                : reportInProgress
                  ? t('kesp.agent.shell.inProgress')
                  : t('kesp.agent.shell.reanalyze')}
            </Button>
          )}
        </div>
      </div>

      <DemoProcessingStatus />

      <div className="kpi-grid kpi-grid-4" style={{ marginBottom: 8 }}>
        <div className="kpi">
          <div className="kpi-label">{t('kesp.agent.shell.lastUpdated')}</div>
          <div className="kpi-value" style={{ fontSize: 22 }}>
            {agent.updatedAt
              ? formatKespDate(agent.updatedAt, i18n.resolvedLanguage)
              : t('kesp.common.notAvailable')}
          </div>
          <div className="kpi-foot">{statusLabel(agent.status, t)}</div>
        </div>
        <button className="kpi kpi-clickable" onClick={() => setTab('carga')}>
          <div className="kpi-label">{t('kesp.agent.shell.linkedCallsLabel')}</div>
          <div className="kpi-value">{regularCalls.length}</div>
          <div className="kpi-foot">{t('kesp.agent.shell.fromCreation')}</div>
        </button>
        <button className="kpi kpi-clickable" onClick={() => setTab('reporte')}>
          <div className="kpi-label">{t('kesp.agent.shell.patternsDetected')}</div>
          <div className="kpi-value">{patternsCount}</div>
          <div className="kpi-foot">
            {patternsCount > 0
              ? t('kesp.agent.shell.priorityPatterns', { count: priorityPatterns })
              : t('kesp.agent.shell.noReport')}
          </div>
        </button>
        <button className="kpi kpi-clickable" onClick={() => setTab('recordatorio')}>
          <div className="kpi-label">{t('kesp.agent.shell.activeReminders')}</div>
          <div className="kpi-value">{tareasActivas}</div>
          <div className="kpi-foot">{t('kesp.agent.shell.open')}</div>
        </button>
      </div>

      <div className="tabbar">
        {tabs.map(/** Handles the callback for this operation. */(t) => (
          <button
            key={t.id}
            className="tabbar-tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'carga' && (
        <CargaTab
          key={agent.id}
          agent={agent}
          calls={regularCalls}
          callsLoaded={loadedCallsAgentId === agent.id}
          processing={processing}
          snapshots={snapshots}
          onTriggerReport={onTriggerReport}
          triggering={triggering}
          reportInProgress={reportInProgress}
          onRequestDelete={requestDeleteCall}
          navigate={navigate}
          returnTo={returnTo}
          canManageAgent={canManageAgent}
        />
      )}
      {tab === 'reporte' && (
        <ReporteTab
          agent={agent}
          report={report}
          reportInProgress={reportInProgress}
          onTriggerReport={onTriggerReport}
          triggering={triggering}
          canTriggerReport={canTriggerReport && processing.canStart}
          callCount={regularCalls.length}
          calls={regularCalls}
          snapshots={snapshots}
          navigate={navigate}
          returnTo={returnTo}
        />
      )}
      {tab === 'rubrica' && (
        <AggregateRubricTab
          key={agent.id}
          agent={agent}
          calls={regularCalls}
          navigate={navigate}
          initialRange={aggregateInitialRange}
          rangeSessionKey={aggregateRangeSessionKey}
        />
      )}
      {tab === 'recordatorio' && agentKey && (
        <RecordatorioTab
          agentKey={agentKey}
          snapshots={snapshots}
          reminders={reminders}
          agent={agent}
          onRefresh={onRefreshActivity}
          refreshing={refreshing}
        />
      )}
      {tab === 'progresion' && (
        <ProgresionTab
          progressRollups={progressRollups}
          salesRollups={salesRollups}
          snapshots={snapshots}
          onRequestDeleteSnapshot={requestDeleteSnapshot}
          navigate={navigate}
          returnTo={returnTo}
        />
      )}
      {tab === 'arvo' && (
        <div className="rise kesp-assistant-tab">
          <AgentProfileAssistantInline />
        </div>
      )}
      {tab === 'shortCalls' && (
        <div className="rise">
          <ShortCallReviewPanel
            calls={shortCallCalls}
            loading={false}
            currentPath={shortCallReturnTo}
            emptyText={t('kesp.agent.shortCalls.empty')}
          />
        </div>
      )}

      <DeleteCallDialog
        open={pendingDelete !== null}
        onOpenChange={/** Handles the onOpenChange interaction. */ (open) => {
          if (!open) setPendingDelete(null);
        }}
        callId={pendingDelete?.callId ?? ''}
        audioPath={pendingDelete?.audioPath}
        onDeleted={onCallDeleted}
      />

      <DeleteAgentProfileDialog
        open={profileDeleteOpen}
        onOpenChange={setProfileDeleteOpen}
        agent={agent}
        onDeleted={() => navigate('/kesp/analizador')}
      />

      {tab !== 'arvo' && <AgentProfileAssistantFloating />}
    </main>
    </AgentProfileAssistantProvider>
  );
}
