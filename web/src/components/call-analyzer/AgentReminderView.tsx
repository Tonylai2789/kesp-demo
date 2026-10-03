import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getCurrentBucketKey, getReminderUrgency } from '@/lib/agentActivity';
import { maskKespDemoEvidenceText } from '@/lib/kespDemoRedaction';
import { useKespDemoRedactionEnabled } from '@/hooks/useKespDemoRedactionEnabled';
import {
  subscribeToAgentCallSnapshots,
  subscribeToAgentReminders,
  subscribeToLoanCases,
  updateLoanCaseStage,
  updateReminder,
} from '@/services/agentActivity';
import type {
  AgentCallSnapshot,
  AgentReminder,
  LoanCase,
  LoanLifecycleStage,
} from '@/types';

interface AgentReminderViewProps {
  agentKey: string;
  manualReminderContent?: ReactNode;
}

/** Documents the formatDateTime behavior. */
function formatDateTime(value: string | null | undefined, language: string): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(language === 'es' ? 'es-MX' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** Documents the formatMoney behavior. */
function formatMoney(amount: number | null | undefined, currency = 'MXN', language = 'es'): string {
  if (typeof amount !== 'number' || Number.isNaN(amount)) {
    return '--';
  }
  return new Intl.NumberFormat(language === 'es' ? 'es-MX' : 'en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Documents the getLifecycleLabel behavior. */
function getLifecycleLabel(stage: LoanLifecycleStage, t: (key: string, options?: Record<string, unknown>) => string): string {
  const key = `callAnalyzer.reminders.lifecycle.${stage}`;
  const fallbackMap: Record<LoanLifecycleStage, string> = {
    not_sold: 'Not sold yet',
    future_follow_up: 'Future follow-up',
    sold_pending_follow_through: 'Sold – Pending follow-through',
    fully_completed: 'Fully completed',
    lost_cancelled: 'Lost / Cancelled',
    unknown: 'Unknown',
  };
  return t(key, { defaultValue: fallbackMap[stage] });
}

/** Documents the getLifecycleBadgeClass behavior. */
function getLifecycleBadgeClass(stage: LoanLifecycleStage): string {
  switch (stage) {
    case 'fully_completed':
      return 'bg-green-100 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-200 dark:border-green-800';
    case 'future_follow_up':
      return 'bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:border-violet-800';
    case 'sold_pending_follow_through':
      return 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:border-blue-800';
    case 'lost_cancelled':
      return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-800';
    case 'not_sold':
      return 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

/** Documents the getActionBadgeInfo behavior. */
function getActionBadgeInfo(
  action: string | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): { label: string; className: string } | null {
  switch (action) {
    case 'call_back':
      return {
        label: t('callAnalyzer.reminders.compact.callBack', { defaultValue: 'Llamar' }),
        className:
          'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:border-sky-800',
      };
    case 'send_whatsapp':
      return {
        label: t('callAnalyzer.reminders.compact.whatsapp', { defaultValue: 'Mandar WhatsApp' }),
        className:
          'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800',
      };
    case 'send_info':
      return {
        label: t('callAnalyzer.reminders.compact.sendInfo', { defaultValue: 'Mandar información' }),
        className:
          'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-950 dark:text-teal-200 dark:border-teal-800',
      };
    case 're_text':
      return {
        label: t('callAnalyzer.reminders.tasks.re_text', { defaultValue: 'Reenviar mensaje' }),
        className:
          'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800',
      };
    case 'wait_for_customer':
      return {
        label: t('callAnalyzer.reminders.compact.waitForCustomer', {
          defaultValue: 'Esperando al cliente',
        }),
        className:
          'bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:border-slate-700',
      };
    default:
      return null;
  }
}

/** Documents the getOutcomeLabel behavior. */
function getOutcomeLabel(
  outcome: AgentCallSnapshot['callOutcome'],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  return t(`callAnalyzer.reminders.outcomes.${outcome}`, {
    defaultValue: outcome.replace(/_/g, ' '),
  });
}

/** Documents the getTaskTypeLabel behavior. */
function getTaskTypeLabel(
  reminder: AgentReminder,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const taskType = reminder.taskType ?? 'other';
  return t(`callAnalyzer.reminders.tasks.${taskType}`, {
    defaultValue: taskType.replace(/_/g, ' '),
  });
}

/** Documents the getStageSourceLabel behavior. */
function getStageSourceLabel(
  source: LoanCase['stageSource'],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  return t(`callAnalyzer.reminders.stageSource.${source}`, {
    defaultValue: source.replace(/_/g, ' '),
  });
}

/** Documents the urgencyWeight behavior. */
function urgencyWeight(reminder: AgentReminder): number {
  const urgency = getReminderUrgency(reminder);
  if (urgency === 'overdue') return 0;
  if (urgency === 'today') return 1;
  if (urgency === 'this_week') return 2;
  if (urgency === 'scheduled') return 3;
  if (urgency === 'condition') return 4;
  return 5;
}

/** Documents the getReminderDueSummary behavior. */
function getReminderDueSummary(
  reminder: AgentReminder,
  language: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (reminder.effectiveDueDate && reminder.effectiveDueTime) {
    return formatDateTime(`${reminder.effectiveDueDate}T${reminder.effectiveDueTime}`, language);
  }
  if (reminder.effectiveDueDate) {
    return formatDateTime(`${reminder.effectiveDueDate}T12:00:00`, language);
  }
  if (reminder.effectiveTimeRange) {
    return reminder.effectiveTimeRange;
  }
  if (reminder.effectiveConditionText) {
    return reminder.effectiveConditionText;
  }
  return t('callAnalyzer.reminders.unscheduled', { defaultValue: 'Sin fecha' });
}

/** Documents the getLoanStatusSummary behavior. */
function getLoanStatusSummary(
  stage: LoanLifecycleStage,
  loanCompleted: AgentCallSnapshot['loanCompleted'],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (stage === 'sold_pending_follow_through') {
    return t('callAnalyzer.reminders.loanPending', { defaultValue: 'En proceso' });
  }
  if (stage === 'fully_completed') {
    return t('callAnalyzer.reminders.loanCompletedShort', { defaultValue: 'Completado' });
  }
  if (stage === 'lost_cancelled') {
    return t('callAnalyzer.reminders.loanCancelledShort', { defaultValue: 'Cancelado' });
  }
  if (loanCompleted === 'yes') {
    return t('callAnalyzer.reminders.loanCompletedShort', { defaultValue: 'Completado' });
  }
  if (loanCompleted === 'in_progress') {
    return t('callAnalyzer.reminders.loanPending', { defaultValue: 'En proceso' });
  }
  if (loanCompleted === 'no') {
    return t('callAnalyzer.reminders.loanNo', { defaultValue: 'No' });
  }
  return '--';
}

/** Documents the formatDayLabel behavior. */
function formatDayLabel(bucketKey: string, language: string): string {
  if (!bucketKey) return '--';
  const date = new Date(`${bucketKey}T12:00:00`);
  if (Number.isNaN(date.getTime())) {
    return bucketKey;
  }
  return new Intl.DateTimeFormat(language === 'es' ? 'es-MX' : 'en-US', {
    dateStyle: 'medium',
  }).format(date);
}

/** Documents the normalizeComparisonText behavior. */
function normalizeComparisonText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Documents the getCompactCaseSummary behavior. */
function getCompactCaseSummary(
  loanCase: LoanCase,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const summarySource = normalizeComparisonText(
    [
      loanCase.latestSummary ?? '',
      loanCase.overrideNote ?? '',
      loanCase.customerName ?? '',
    ].join(' ')
  );

  switch (loanCase.effectiveStage) {
    case 'future_follow_up':
      if (summarySource.includes('pens')) {
        return t('callAnalyzer.reminders.compact.interestedThinking', {
          defaultValue: 'Interesado, pidió pensar',
        });
      }
      if (summarySource.includes('consult')) {
        return t('callAnalyzer.reminders.compact.interestedConsulting', {
          defaultValue: 'Interesado, lo consultará',
        });
      }
      return t('callAnalyzer.reminders.compact.followUpPending', {
        defaultValue: 'Interesado, seguimiento pendiente',
      });
    case 'sold_pending_follow_through':
      return t('callAnalyzer.reminders.compact.soldPending', {
        defaultValue: 'Vendido, falta completar',
      });
    case 'fully_completed':
      return t('callAnalyzer.reminders.compact.completed', {
        defaultValue: 'Completado',
      });
    case 'lost_cancelled':
      return t('callAnalyzer.reminders.compact.lostCancelled', {
        defaultValue: 'Perdido / cancelado',
      });
    case 'not_sold':
      return t('callAnalyzer.reminders.compact.notSold', {
        defaultValue: 'No vendido',
      });
    default:
      return getLifecycleLabel(loanCase.effectiveStage, t);
  }
}

/** Documents the formatRelativeReminderWhen behavior. */
function formatRelativeReminderWhen(
  reminder: AgentReminder | null,
  language: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (!reminder) {
    return t('callAnalyzer.reminders.unscheduled', { defaultValue: 'Sin fecha' });
  }

  if (reminder.effectiveConditionText) {
    return reminder.effectiveConditionText;
  }

  if (!reminder.effectiveDueDate) {
    return reminder.effectiveTimeRange || t('callAnalyzer.reminders.unscheduled', { defaultValue: 'Sin fecha' });
  }

  const dueDate = new Date(`${reminder.effectiveDueDate}T12:00:00`);
  if (Number.isNaN(dueDate.getTime())) {
    return reminder.effectiveDueDate;
  }

  const today = new Date();
  const todayMidday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0);
  const tomorrowMidday = new Date(todayMidday);
  tomorrowMidday.setDate(todayMidday.getDate() + 1);
  const timeSuffix = reminder.effectiveDueTime
    ? ` ${reminder.effectiveDueTime.slice(0, 5)}`
    : '';

  if (dueDate.getTime() === todayMidday.getTime()) {
    return `${t('callAnalyzer.reminders.today', { defaultValue: 'Hoy' })}${timeSuffix}`;
  }
  if (dueDate.getTime() === tomorrowMidday.getTime()) {
    return `${t('callAnalyzer.reminders.tomorrow', { defaultValue: 'Mañana' })}${timeSuffix}`;
  }

  const diffDays = Math.round((dueDate.getTime() - todayMidday.getTime()) / 86400000);
  if (diffDays > 0 && diffDays < 7) {
    const weekday = new Intl.DateTimeFormat(language === 'es' ? 'es-MX' : 'en-US', {
      weekday: 'short',
    }).format(dueDate);
    return `${weekday}${timeSuffix}`;
  }

  return `${formatDayLabel(reminder.effectiveDueDate, language)}${timeSuffix}`;
}

/** Documents the getCompactNextActionLabel behavior. */
function getCompactNextActionLabel(
  loanCase: LoanCase,
  reminder: AgentReminder | null,
  language: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const whenLabel = formatRelativeReminderWhen(reminder, language, t);
  const action = reminder?.nextAction ?? loanCase.latestNextAction;

  if (action === 'call_back') {
    return `👉 ${t('callAnalyzer.reminders.compact.callBack', {
      defaultValue: 'Llamar',
    })} – ${whenLabel}`;
  }
  if (action === 'send_whatsapp') {
    return `👉 ${t('callAnalyzer.reminders.compact.whatsapp', {
      defaultValue: 'WhatsApp',
    })} – ${whenLabel}`;
  }
  if (action === 'send_info') {
    return `👉 ${t('callAnalyzer.reminders.compact.sendInfo', {
      defaultValue: 'Mandar información',
    })} – ${whenLabel}`;
  }
  if (action === 'wait_for_customer') {
    return `👉 ${t('callAnalyzer.reminders.compact.waitForCustomer', {
      defaultValue: 'Esperando al cliente',
    })}`;
  }
  if (reminder?.state === 'open') {
    return `👉 ${t('callAnalyzer.reminders.compact.pendingTask', {
      defaultValue: 'Seguimiento pendiente',
    })} – ${whenLabel}`;
  }
  return `👉 ${t('callAnalyzer.reminders.compact.noTask', {
    defaultValue: 'Sin tarea pendiente',
  })}`;
}

/** Documents the getCasePriorityRank behavior. */
function getCasePriorityRank(loanCase: LoanCase): number {
  if (loanCase.activeReminderIds.length > 0) return 0;
  if (loanCase.latestNextAction === 'call_back') return 1;
  if (loanCase.latestNextAction === 'send_whatsapp' || loanCase.latestNextAction === 'send_info') {
    return 2;
  }
  if (
    loanCase.effectiveStage === 'sold_pending_follow_through' ||
    loanCase.effectiveStage === 'future_follow_up'
  ) {
    return 3;
  }
  if (loanCase.effectiveStage === 'not_sold') return 4;
  if (loanCase.effectiveStage === 'lost_cancelled' || loanCase.effectiveStage === 'fully_completed') {
    return 5;
  }
  return 6;
}

/** Documents the getSnapshotPriorityRank behavior. */
function getSnapshotPriorityRank(snapshot: AgentCallSnapshot): number {
  if (snapshot.nextAction === 'call_back') return 0;
  if (snapshot.nextAction === 'send_whatsapp' || snapshot.nextAction === 'send_info') return 1;
  if (snapshot.callOutcome === 'follow_up_needed') return 2;
  if (snapshot.callOutcome === 'in_progress') return 3;
  if (snapshot.callOutcome === 'failure' || snapshot.callOutcome === 'no_contact') return 5;
  return 4;
}

/** Renders the AgentReminderView component. */
export function AgentReminderView({ agentKey, manualReminderContent }: AgentReminderViewProps) {
  const { t, i18n } = useTranslation();
  const demoMode = useKespDemoRedactionEnabled();
  const [snapshots, setSnapshots] = useState<AgentCallSnapshot[]>([]);
  const [reminders, setReminders] = useState<AgentReminder[]>([]);
  const [loanCases, setLoanCases] = useState<LoanCase[]>([]);
  const [periodType, setPeriodType] = useState<'day' | 'week' | 'month'>('week');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'done' | 'closed' | 'superseded'>('open');
  const [stageFilter, setStageFilter] = useState<'all' | LoanLifecycleStage>('all');
  const [drafts, setDrafts] = useState<Record<string, { dueDate: string; dueTime: string; notes: string }>>({});
  const [caseNotes, setCaseNotes] = useState<Record<string, string>>({});
  const [expandedCaseTaskLists, setExpandedCaseTaskLists] = useState<Record<string, boolean>>({});
  const [expandedCaseDetails, setExpandedCaseDetails] = useState<Record<string, boolean>>({});
  const [quickRescheduleOpen, setQuickRescheduleOpen] = useState<Record<string, boolean>>({});

  useEffect(/** Handles the callback for this operation. */() => {
    const unsubscribeSnapshots = subscribeToAgentCallSnapshots(agentKey, setSnapshots);
    const unsubscribeReminders = subscribeToAgentReminders(agentKey, setReminders);
    const unsubscribeLoanCases = subscribeToLoanCases(agentKey, setLoanCases);
    return /** Handles the callback for this operation. */ () => {
      unsubscribeSnapshots();
      unsubscribeReminders();
      unsubscribeLoanCases();
    };
  }, [agentKey]);

  const currentBucketKey = getCurrentBucketKey(periodType);
  const caseMap = useMemo(
    /** Handles the callback for this operation. */
    () => new Map(loanCases.map(/** Handles the callback for this operation. */(loanCase) => [loanCase.caseId, loanCase])),
    [loanCases]
  );

  const filteredCases = useMemo(/** Handles the callback for this operation. */() => {
    return loanCases.filter(/** Handles the callback for this operation. */(loanCase) => {
      const bucketValue =
        periodType === 'day'
          ? loanCase.latestBucketDay
          : periodType === 'week'
            ? loanCase.latestBucketWeek
            : loanCase.latestBucketMonth;
      const matchesBucket = !bucketValue || bucketValue === currentBucketKey;
      const matchesStage = stageFilter === 'all' || loanCase.effectiveStage === stageFilter;
      return matchesBucket && matchesStage;
    });
  }, [currentBucketKey, loanCases, periodType, stageFilter]);

  const trackerCases = useMemo(
    /** Handles the callback for this operation. */
    () => filteredCases.filter(/** Handles the callback for this operation. */(loanCase) => loanCase.effectiveStage !== 'lost_cancelled'),
    [filteredCases]
  );

  const filteredSnapshots = useMemo(/** Handles the callback for this operation. */() => {
    return snapshots
      .filter(/** Handles the callback for this operation. */(snapshot) => {
        const bucketValue =
          periodType === 'day'
            ? snapshot.bucketDay
            : periodType === 'week'
              ? snapshot.bucketWeek
              : snapshot.bucketMonth;
        const matchesBucket = bucketValue === currentBucketKey;
        const relatedCase = snapshot.caseId ? caseMap.get(snapshot.caseId) : null;
        const matchesStage =
          stageFilter === 'all' ||
          (relatedCase?.effectiveStage ?? snapshot.effectiveLifecycleStage ?? 'unknown') === stageFilter;
        return matchesBucket && matchesStage;
      })
      .slice(0, 20);
  }, [caseMap, currentBucketKey, periodType, snapshots, stageFilter]);

  const filteredReminders = useMemo(/** Handles the callback for this operation. */() => {
    return reminders
      .filter(/** Handles the callback for this operation. */(reminder) => {
        const relatedCase = reminder.caseId ? caseMap.get(reminder.caseId) : null;
        const bucketValue =
          periodType === 'day'
            ? relatedCase?.latestBucketDay
            : periodType === 'week'
              ? relatedCase?.latestBucketWeek
              : relatedCase?.latestBucketMonth;
        const matchesBucket = !bucketValue || bucketValue === currentBucketKey;
        const matchesStatus = statusFilter === 'all' || reminder.state === statusFilter;
        const matchesStage =
          stageFilter === 'all' || (relatedCase?.effectiveStage ?? reminder.lifecycleStage ?? 'unknown') === stageFilter;
        return matchesBucket && matchesStatus && matchesStage;
      })
      .sort(/** Handles the callback for this operation. */(a, b) => {
        const urgencyDelta = urgencyWeight(a) - urgencyWeight(b);
        if (urgencyDelta !== 0) {
          return urgencyDelta;
        }
        return (a.effectiveSortKey ?? a.sortKey ?? '').localeCompare(b.effectiveSortKey ?? b.sortKey ?? '');
      });
  }, [caseMap, currentBucketKey, periodType, reminders, stageFilter, statusFilter]);

  const remindersByCaseId = useMemo(/** Handles the callback for this operation. */() => {
    const grouped = new Map<string, AgentReminder[]>();
    for (const reminder of filteredReminders) {
      if (!reminder.caseId) continue;
      const existing = grouped.get(reminder.caseId) ?? [];
      existing.push(reminder);
      grouped.set(reminder.caseId, existing);
    }

    for (const [caseId, caseReminders] of grouped.entries()) {
      grouped.set(
        caseId,
        [...caseReminders].sort(/** Handles the callback for this operation. */(a, b) => {
          const urgencyDelta = urgencyWeight(a) - urgencyWeight(b);
          if (urgencyDelta !== 0) return urgencyDelta;
          return (a.effectiveSortKey ?? a.sortKey ?? '').localeCompare(
            b.effectiveSortKey ?? b.sortKey ?? ''
          );
        })
      );
    }

    return grouped;
  }, [filteredReminders]);

  const reminderSummary = useMemo(/** Handles the callback for this operation. */() => {
    let active = 0;
    let overdue = 0;
    let dueToday = 0;
    let dueThisWeek = 0;

    for (const reminder of reminders) {
      if (reminder.state !== 'open') continue;
      active += 1;
      const urgency = getReminderUrgency(reminder);
      if (urgency === 'overdue') overdue += 1;
      if (urgency === 'today') dueToday += 1;
      if (urgency === 'this_week') dueThisWeek += 1;
    }

    let soldOnCall = 0;
    let pending = 0;
    let completed = 0;
    let cancelled = 0;
    let soldAmountTotal = 0;
    let soldAmountCount = 0;
    for (const loanCase of trackerCases) {
      const countsAsSold =
        loanCase.effectiveStage === 'sold_pending_follow_through' ||
        loanCase.effectiveStage === 'fully_completed';
      if (loanCase.saleReachedOnCall && countsAsSold) soldOnCall += 1;
      if (loanCase.effectiveStage === 'sold_pending_follow_through') pending += 1;
      if (loanCase.effectiveStage === 'fully_completed') completed += 1;
      if (loanCase.effectiveStage === 'lost_cancelled') cancelled += 1;
      if (countsAsSold && typeof loanCase.loanAmount === 'number') {
        soldAmountTotal += loanCase.loanAmount;
        soldAmountCount += 1;
      }
    }

    return {
      active,
      overdue,
      dueToday,
      dueThisWeek,
      soldOnCall,
      pending,
      completed,
      cancelled,
      soldAmountTotal,
      soldAmountAverage: soldAmountCount > 0 ? soldAmountTotal / soldAmountCount : null,
    };
  }, [reminders, trackerCases]);

  const trackerDayGroups = useMemo(/** Handles the callback for this operation. */() => {
    const groups = new Map<
      string,
      {
        bucketKey: string;
        items: LoanCase[];
        pendingCalls: number;
        pendingTexts: number;
        pendingActions: number;
      }
    >();

    for (const loanCase of trackerCases) {
      const bucketKey = loanCase.latestBucketDay ?? currentBucketKey;
      const group = groups.get(bucketKey) ?? {
        bucketKey,
        items: [],
        pendingCalls: 0,
        pendingTexts: 0,
        pendingActions: 0,
      };
      group.items.push(loanCase);
      if (loanCase.latestNextAction === 'call_back') {
        group.pendingCalls += 1;
      }
      if (loanCase.latestNextAction === 'send_whatsapp' || loanCase.latestNextAction === 'send_info') {
        group.pendingTexts += 1;
      }
      if (
        loanCase.activeReminderIds.length > 0 ||
        loanCase.latestNextAction === 'call_back' ||
        loanCase.latestNextAction === 'send_whatsapp' ||
        loanCase.latestNextAction === 'send_info'
      ) {
        group.pendingActions += 1;
      }
      groups.set(bucketKey, group);
    }

    return Array.from(groups.values())
      .map(/** Handles the callback for this operation. */(group) => ({
        ...group,
        items: [...group.items].sort(/** Handles the callback for this operation. */(a, b) => {
          const rankDelta = getCasePriorityRank(a) - getCasePriorityRank(b);
          if (rankDelta !== 0) return rankDelta;
          return (b.latestCallOccurredAtMs ?? 0) - (a.latestCallOccurredAtMs ?? 0);
        }),
      }))
      .sort(/** Handles the callback for this operation. */(a, b) => b.bucketKey.localeCompare(a.bucketKey));
  }, [currentBucketKey, trackerCases]);

  const historyDayGroups = useMemo(/** Handles the callback for this operation. */() => {
    const groups = new Map<
      string,
      {
        bucketKey: string;
        items: AgentCallSnapshot[];
        nextActionCount: number;
        pendingCalls: number;
        pendingTexts: number;
      }
    >();

    for (const snapshot of filteredSnapshots) {
      const bucketKey =
        periodType === 'day'
          ? snapshot.bucketDay
          : snapshot.bucketDay || currentBucketKey;
      const group = groups.get(bucketKey) ?? {
        bucketKey,
        items: [],
        nextActionCount: 0,
        pendingCalls: 0,
        pendingTexts: 0,
      };
      group.items.push(snapshot);
      if (snapshot.nextAction) {
        group.nextActionCount += 1;
      }
      if (snapshot.nextAction === 'call_back') {
        group.pendingCalls += 1;
      }
      if (snapshot.nextAction === 'send_whatsapp' || snapshot.nextAction === 'send_info') {
        group.pendingTexts += 1;
      }
      groups.set(bucketKey, group);
    }

    return Array.from(groups.values())
      .map(/** Handles the callback for this operation. */(group) => ({
        ...group,
        items: [...group.items].sort(/** Handles the callback for this operation. */(a, b) => {
          const rankDelta = getSnapshotPriorityRank(a) - getSnapshotPriorityRank(b);
          if (rankDelta !== 0) return rankDelta;
          return (b.callOccurredAtMs ?? 0) - (a.callOccurredAtMs ?? 0);
        }),
      }))
      .sort(/** Handles the callback for this operation. */(a, b) => b.bucketKey.localeCompare(a.bucketKey));
  }, [currentBucketKey, filteredSnapshots, periodType]);

  const [expandedTrackerDays, setExpandedTrackerDays] = useState<Record<string, boolean>>({});
  const [expandedHistoryDays, setExpandedHistoryDays] = useState<Record<string, boolean>>({});

  const getReminderDraft = /** Documents the getReminderDraft behavior. */ (reminder: AgentReminder) =>
    drafts[reminder.id] ?? {
      dueDate: reminder.effectiveDueDate ?? reminder.dueDate ?? '',
      dueTime: reminder.effectiveDueTime ?? reminder.dueTime ?? '',
      notes: reminder.manualNotes ?? reminder.notes ?? '',
    };

  const handleDraftChange = /** Handles the handleDraftChange interaction. */ (
    reminder: AgentReminder,
    field: 'dueDate' | 'dueTime' | 'notes',
    value: string
  ) => {
    setDrafts(/** Handles the callback for this operation. */(current) => ({
      ...current,
      [reminder.id]: {
        ...getReminderDraft(reminder),
        ...current[reminder.id],
        [field]: value,
      },
    }));
  };

  const handleSaveReminder = /** Handles the handleSaveReminder interaction. */ async (reminder: AgentReminder) => {
    const draft = getReminderDraft(reminder);
    try {
      await updateReminder(agentKey, reminder.id, {
        state: 'open',
        dueDate: draft.dueDate || null,
        dueTime: draft.dueTime || null,
        notes: draft.notes || null,
      });
      toast.success(
        t('callAnalyzer.reminders.scheduleSaved', {
          defaultValue: i18n.language === 'es' ? 'Recordatorio actualizado.' : 'Reminder updated.',
        })
      );
    } catch (error) {
      console.error('Failed to update reminder:', error);
      toast.error(
        t('callAnalyzer.reminders.scheduleError', {
          defaultValue: i18n.language === 'es' ? 'No se pudo actualizar el recordatorio.' : 'Failed to update reminder.',
        })
      );
    }
  };

  const handleStateChange = /** Handles the handleStateChange interaction. */ async (reminder: AgentReminder, state: 'done' | 'closed') => {
    try {
      await updateReminder(agentKey, reminder.id, {
        state,
        closedReason: state === 'closed' ? 'closed_by_operator' : null,
      });
      toast.success(
        t('callAnalyzer.reminders.stateUpdated', {
          defaultValue: i18n.language === 'es' ? 'Recordatorio actualizado.' : 'Reminder updated.',
        })
      );
    } catch (error) {
      console.error('Failed to change reminder state:', error);
      toast.error(
        t('callAnalyzer.reminders.stateError', {
          defaultValue: i18n.language === 'es' ? 'No se pudo actualizar el estado.' : 'Failed to update reminder state.',
        })
      );
    }
  };

  const handleCaseStageUpdate = /** Handles the handleCaseStageUpdate interaction. */ async (
    loanCase: LoanCase,
    stage: 'sold_pending_follow_through' | 'fully_completed' | 'lost_cancelled'
  ) => {
    try {
      await updateLoanCaseStage(agentKey, loanCase.caseId, stage, caseNotes[loanCase.caseId] ?? null);
      toast.success(
        t('callAnalyzer.reminders.caseUpdated', {
          defaultValue: i18n.language === 'es' ? 'Estado del caso actualizado.' : 'Case stage updated.',
        })
      );
    } catch (error) {
      console.error('Failed to update loan case stage:', error);
      toast.error(
        t('callAnalyzer.reminders.caseError', {
          defaultValue: i18n.language === 'es' ? 'No se pudo actualizar el caso.' : 'Failed to update case stage.',
        })
      );
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <Card className="md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">
              {t('callAnalyzer.reminders.activeReminders', { defaultValue: 'Recordatorios activos' })}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-4xl font-bold">{reminderSummary.active}</div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="rounded-full bg-muted px-3 py-1">
                {t('callAnalyzer.reminders.dueToday', { defaultValue: 'Para hoy' })}: {reminderSummary.dueToday}
              </span>
              <span className="rounded-full bg-muted px-3 py-1">
                {t('callAnalyzer.reminders.overdue', { defaultValue: 'Vencidos' })}: {reminderSummary.overdue}
              </span>
              <span className="rounded-full bg-muted px-3 py-1">
                {t('callAnalyzer.reminders.dueThisWeek', { defaultValue: 'Para esta semana' })}: {reminderSummary.dueThisWeek}
              </span>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {t('callAnalyzer.reminders.pendingFollowThrough', { defaultValue: 'Pendientes por completar' })}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{reminderSummary.pending}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {t('callAnalyzer.reminders.confirmedCompleted', { defaultValue: 'Completados confirmados' })}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{reminderSummary.completed}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {t('callAnalyzer.reminders.lostCancelled', { defaultValue: 'Perdidos / Cancelados' })}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{reminderSummary.cancelled}</CardContent>
          </Card>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {t('callAnalyzer.reminders.soldOnCall', { defaultValue: 'Vendidos en llamada' })}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{reminderSummary.soldOnCall}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {t('callAnalyzer.reminders.soldAmountTotal', { defaultValue: 'Monto vendido' })}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">
              {formatMoney(reminderSummary.soldAmountTotal, 'MXN', i18n.language)}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {t('callAnalyzer.reminders.soldAmountAverage', { defaultValue: 'Promedio vendido' })}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">
              {formatMoney(reminderSummary.soldAmountAverage, 'MXN', i18n.language)}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('callAnalyzer.reminders.filters', { defaultValue: 'Filtros' })}</CardTitle>
          <CardDescription>
            {t('callAnalyzer.reminders.filtersDescription', {
              defaultValue: 'Filtra los casos por periodo, estado de tarea y etapa del préstamo.',
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('callAnalyzer.reminders.period', { defaultValue: 'Periodo' })}</p>
            <Select value={periodType} onValueChange={/** Handles the onValueChange interaction. */ (value) => setPeriodType(value as 'day' | 'week' | 'month')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">{t('callAnalyzer.reminders.day', { defaultValue: 'Día' })}</SelectItem>
                <SelectItem value="week">{t('callAnalyzer.reminders.week', { defaultValue: 'Semana' })}</SelectItem>
                <SelectItem value="month">{t('callAnalyzer.reminders.month', { defaultValue: 'Mes' })}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('callAnalyzer.reminders.status', { defaultValue: 'Estado de tarea' })}</p>
            <Select
              value={statusFilter}
              onValueChange={/** Handles the onValueChange interaction. */ (value) => setStatusFilter(value as 'all' | 'open' | 'done' | 'closed' | 'superseded')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('callAnalyzer.reminders.all', { defaultValue: 'Todos' })}</SelectItem>
                <SelectItem value="open">{t('callAnalyzer.reminders.open', { defaultValue: 'Abierto' })}</SelectItem>
                <SelectItem value="done">{t('callAnalyzer.reminders.done', { defaultValue: 'Hecho' })}</SelectItem>
                <SelectItem value="closed">{t('callAnalyzer.reminders.closed', { defaultValue: 'Cerrado' })}</SelectItem>
                <SelectItem value="superseded">{t('callAnalyzer.reminders.superseded', { defaultValue: 'Reemplazado' })}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('callAnalyzer.reminders.loanStage', { defaultValue: 'Etapa del préstamo' })}</p>
            <Select value={stageFilter} onValueChange={/** Handles the onValueChange interaction. */ (value) => setStageFilter(value as 'all' | LoanLifecycleStage)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('callAnalyzer.reminders.all', { defaultValue: 'Todos' })}</SelectItem>
                <SelectItem value="sold_pending_follow_through">
                  {getLifecycleLabel('sold_pending_follow_through', t)}
                </SelectItem>
                <SelectItem value="future_follow_up">{getLifecycleLabel('future_follow_up', t)}</SelectItem>
                <SelectItem value="fully_completed">{getLifecycleLabel('fully_completed', t)}</SelectItem>
                <SelectItem value="lost_cancelled">{getLifecycleLabel('lost_cancelled', t)}</SelectItem>
                <SelectItem value="not_sold">{getLifecycleLabel('not_sold', t)}</SelectItem>
                <SelectItem value="unknown">{getLifecycleLabel('unknown', t)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {manualReminderContent}

      <Card>
        <CardHeader>
          <CardTitle>{t('callAnalyzer.reminders.caseTracker', { defaultValue: 'Casos' })}</CardTitle>
          <CardDescription>
            {t('callAnalyzer.reminders.caseTrackerDescription', {
              defaultValue: 'Trabaja cada caso desde un solo lugar: etapa, siguiente tarea y acciones de seguimiento.',
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {trackerDayGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('callAnalyzer.reminders.noCases', {
                defaultValue: 'No hay casos que coincidan con los filtros actuales.',
              })}
            </p>
          ) : (
            trackerDayGroups.map(/** Handles the callback for this operation. */(group, index) => {
              const isExpanded = expandedTrackerDays[group.bucketKey] ?? index === 0;
              return (
                <div key={group.bucketKey} className="rounded-lg border">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="space-y-1">
                      <p className="font-semibold">{formatDayLabel(group.bucketKey, i18n.language)}</p>
                      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                        <span>{group.items.length} {t('callAnalyzer.reminders.dayCases', { defaultValue: 'casos' })}</span>
                        <span>{group.pendingActions} {t('callAnalyzer.reminders.dayPending', { defaultValue: 'pendientes' })}</span>
                        <span>{group.pendingCalls} {t('callAnalyzer.reminders.dayPendingCalls', { defaultValue: 'llamadas por hacer' })}</span>
                        <span>{group.pendingTexts} {t('callAnalyzer.reminders.dayPendingTexts', { defaultValue: 'mensajes por enviar' })}</span>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={/** Handles the onClick interaction. */ () =>
                        setExpandedTrackerDays(/** Handles the callback for this operation. */(current) => ({
                          ...current,
                          [group.bucketKey]: !isExpanded,
                        }))
                      }
                    >
                      {isExpanded
                        ? t('callAnalyzer.reminders.hideDay', { defaultValue: 'Ocultar día' })
                        : t('callAnalyzer.reminders.showDay', { defaultValue: 'Ver día' })}
                    </Button>
                  </div>

                  {isExpanded ? (
                    <div className="space-y-4 border-t px-4 py-4">
                      {group.items.map(/** Handles the callback for this operation. */(loanCase) => {
                        const caseReminders = remindersByCaseId.get(loanCase.caseId) ?? [];
                        const primaryReminder = caseReminders[0] ?? null;
                        const showAllTasks = expandedCaseTaskLists[loanCase.caseId] ?? false;
                        const showDetails = expandedCaseDetails[loanCase.caseId] ?? false;
                        const showQuickReschedule = quickRescheduleOpen[loanCase.caseId] ?? false;
                        const visibleCaseReminders = showAllTasks ? caseReminders : caseReminders.slice(0, 1);
                        const actionBadge = getActionBadgeInfo(
                          primaryReminder?.nextAction ?? loanCase.latestNextAction,
                          t
                        );

                        return (
                          <div key={loanCase.caseId} className="rounded-lg border p-4 space-y-4">
                            <div className="space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="text-base font-semibold">
                                  {loanCase.customerName || loanCase.caseId}
                                </h3>
                                <Badge
                                  variant="outline"
                                  className={getLifecycleBadgeClass(loanCase.effectiveStage)}
                                >
                                  {getLifecycleLabel(loanCase.effectiveStage, t)}
                                </Badge>
                                {actionBadge ? (
                                  <Badge variant="outline" className={actionBadge.className}>
                                    {actionBadge.label}
                                  </Badge>
                                ) : null}
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {getCompactCaseSummary(loanCase, t)}
                              </p>
                              <p className="text-sm font-medium">
                                {getCompactNextActionLabel(loanCase, primaryReminder, i18n.language, t)}
                              </p>
                            </div>

                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                onClick={/** Handles the onClick interaction. */ () => primaryReminder && handleStateChange(primaryReminder, 'done')}
                                disabled={!primaryReminder || primaryReminder.state !== 'open'}
                              >
                                {t('callAnalyzer.reminders.done', { defaultValue: 'Hecho' })}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={/** Handles the onClick interaction. */ () =>
                                  setQuickRescheduleOpen(/** Handles the callback for this operation. */(current) => ({
                                    ...current,
                                    [loanCase.caseId]: !showQuickReschedule,
                                  }))
                                }
                                disabled={!primaryReminder}
                              >
                                {t('callAnalyzer.reminders.rescheduleShort', {
                                  defaultValue: 'Reprogramar',
                                })}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={/** Handles the onClick interaction. */ () =>
                                  setExpandedCaseDetails(/** Handles the callback for this operation. */(current) => ({
                                    ...current,
                                    [loanCase.caseId]: !showDetails,
                                  }))
                                }
                              >
                                {showDetails
                                  ? t('callAnalyzer.reminders.hideDetails', { defaultValue: 'Ocultar detalle' })
                                  : t('callAnalyzer.reminders.showDetails', { defaultValue: 'Ver detalle' })}
                              </Button>
                            </div>

                            {showQuickReschedule && primaryReminder ? (
                              <div className="rounded-lg border bg-muted/20 p-3">
                                <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                                  <Input
                                    type="date"
                                    value={getReminderDraft(primaryReminder).dueDate}
                                    onChange={/** Handles the onChange interaction. */ (event) =>
                                      handleDraftChange(primaryReminder, 'dueDate', event.target.value)
                                    }
                                    disabled={primaryReminder.state !== 'open'}
                                  />
                                  <Input
                                    type="time"
                                    value={getReminderDraft(primaryReminder).dueTime}
                                    onChange={/** Handles the onChange interaction. */ (event) =>
                                      handleDraftChange(primaryReminder, 'dueTime', event.target.value)
                                    }
                                    disabled={primaryReminder.state !== 'open'}
                                  />
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={/** Handles the onClick interaction. */ () => handleSaveReminder(primaryReminder)}
                                    disabled={primaryReminder.state !== 'open'}
                                  >
                                    {t('callAnalyzer.reminders.reschedule', {
                                      defaultValue: 'Guardar agenda',
                                    })}
                                  </Button>
                                </div>
                              </div>
                            ) : null}

                            {showDetails ? (
                              <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="space-y-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="text-base font-semibold text-foreground">
                                        {loanCase.customerName || loanCase.caseId}
                                      </span>
                                      <Badge variant="outline" className={getLifecycleBadgeClass(loanCase.effectiveStage)}>
                                        {getLifecycleLabel(loanCase.effectiveStage, t)}
                                      </Badge>
                                      {actionBadge ? (
                                        <Badge variant="outline" className={actionBadge.className}>
                                          {actionBadge.label}
                                        </Badge>
                                      ) : null}
                                    </div>
                                    <p className="text-sm text-muted-foreground">
                                      {loanCase.latestSummary ||
                                        t('callAnalyzer.reminders.noSummary', { defaultValue: 'Todavía no hay resumen disponible.' })}
                                    </p>
                                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                      <span>
                                        {t('callAnalyzer.reminders.amount', { defaultValue: 'Monto' })}:{' '}
                                        {formatMoney(loanCase.loanAmount, loanCase.currency ?? 'MXN', i18n.language)}
                                      </span>
                                      <span>
                                        {t('callAnalyzer.reminders.latestCall', { defaultValue: 'Última llamada' })}:{' '}
                                        {loanCase.latestCallId ? (
                                          <Link to={`/calls/${loanCase.latestCallId}`} className="underline hover:no-underline">
                                            {loanCase.latestCallId}
                                          </Link>
                                        ) : '--'}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="text-xs text-muted-foreground text-right">
                                    <div>{t('callAnalyzer.reminders.activeTasks', { defaultValue: 'Tareas activas' })}: {caseReminders.length}</div>
                                    <div>
                                      {t('callAnalyzer.reminders.latestAction', { defaultValue: 'Siguiente acción' })}:{' '}
                                      {loanCase.latestNextAction || '--'}
                                    </div>
                                  </div>
                                </div>

                                {primaryReminder ? (
                                  <div className="space-y-2">
                                    <div className="flex flex-wrap items-center gap-2 text-sm">
                                      <Badge
                                        variant={
                                          getReminderUrgency(primaryReminder) === 'overdue'
                                            ? 'destructive'
                                            : primaryReminder.state === 'open'
                                              ? 'secondary'
                                              : 'outline'
                                        }
                                      >
                                        {t(`callAnalyzer.reminders.urgency.${getReminderUrgency(primaryReminder)}`, {
                                          defaultValue: getReminderUrgency(primaryReminder).replace(/_/g, ' '),
                                        })}
                                      </Badge>
                                      <Badge variant="outline" className={actionBadge?.className}>
                                        {actionBadge?.label ?? getTaskTypeLabel(primaryReminder, t)}
                                      </Badge>
                                      <Badge variant="outline">
                                        {getStageSourceLabel(loanCase.stageSource, t)}
                                      </Badge>
                                    </div>
                                    <div className="grid gap-2 text-sm md:grid-cols-2">
                                      <p>
                                        <span className="font-medium">
                                          {t('callAnalyzer.reminders.nextTask', { defaultValue: 'Próxima tarea' })}:
                                        </span>{' '}
                                        {getTaskTypeLabel(primaryReminder, t)}
                                      </p>
                                      <p>
                                        <span className="font-medium">
                                          {t('callAnalyzer.reminders.dueLabel', { defaultValue: 'Vence' })}:
                                        </span>{' '}
                                        {getReminderDueSummary(primaryReminder, i18n.language, t)}
                                      </p>
                                      <p>
                                        <span className="font-medium">
                                          {t('callAnalyzer.reminders.nextBestAction', { defaultValue: 'Mejor siguiente acción' })}:
                                        </span>{' '}
                                        {primaryReminder.nextBestAction || primaryReminder.nextAction || '--'}
                                      </p>
                                      <p>
                                        <span className="font-medium">
                                          {t('callAnalyzer.reminders.activeTasks', { defaultValue: 'Tareas activas' })}:
                                        </span>{' '}
                                        {caseReminders.length}
                                      </p>
                                    </div>
                                  </div>
                                ) : (
                                  <p className="text-sm text-muted-foreground">
                                    {t('callAnalyzer.reminders.noActiveTask', {
                                      defaultValue: 'No hay recordatorio activo.',
                                    })}
                                  </p>
                                )}

                                {caseReminders.length > 1 ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={/** Handles the onClick interaction. */ () =>
                                      setExpandedCaseTaskLists(/** Handles the callback for this operation. */(current) => ({
                                        ...current,
                                        [loanCase.caseId]: !showAllTasks,
                                      }))
                                    }
                                  >
                                    {showAllTasks
                                      ? t('callAnalyzer.reminders.hideTasks', { defaultValue: 'Ocultar tareas' })
                                      : t('callAnalyzer.reminders.showTasks', {
                                        defaultValue: 'Ver tareas ({{count}})',
                                        count: caseReminders.length,
                                      })}
                                  </Button>
                                ) : null}

                                {visibleCaseReminders.map(/** Handles the callback for this operation. */(reminder) => {
                                  const draft = getReminderDraft(reminder);
                                  return (
                                    <div key={reminder.id} className="rounded-md border bg-background/80 p-3 space-y-3">
                                      <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="space-y-1">
                                          <p className="text-sm font-medium">
                                            {reminder.reason ||
                                              reminder.lastCallSummary ||
                                              t('callAnalyzer.reminders.noSummary', { defaultValue: 'Todavía no hay resumen disponible.' })}
                                          </p>
                                          <p className="text-xs text-muted-foreground">
                                            {t('callAnalyzer.reminders.origin', { defaultValue: 'Origen' })}: {reminder.origin}
                                            {' · '}
                                            {t('callAnalyzer.reminders.confidence', { defaultValue: 'Confianza' })}:{' '}
                                            {typeof reminder.confidenceScore === 'number'
                                              ? `${Math.round(reminder.confidenceScore * 100)}%`
                                              : '--'}
                                          </p>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={/** Handles the onClick interaction. */ () => handleSaveReminder(reminder)}
                                            disabled={reminder.state !== 'open'}
                                          >
                                            {t('callAnalyzer.reminders.reschedule', { defaultValue: 'Guardar agenda' })}
                                          </Button>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={/** Handles the onClick interaction. */ () => handleStateChange(reminder, 'done')}
                                            disabled={reminder.state !== 'open'}
                                          >
                                            {t('callAnalyzer.reminders.markDone', { defaultValue: 'Marcar como hecho' })}
                                          </Button>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={/** Handles the onClick interaction. */ () => handleStateChange(reminder, 'closed')}
                                            disabled={reminder.state !== 'open'}
                                          >
                                            {t('callAnalyzer.reminders.close', { defaultValue: 'Cerrar' })}
                                          </Button>
                                        </div>
                                      </div>

                                      {reminder.evidenceQuotes && reminder.evidenceQuotes.length > 0 ? (
                                        <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground space-y-1">
                                          {reminder.evidenceQuotes.slice(0, 2).map(/** Handles the callback for this operation. */(item, index) => (
                                            <p key={`${reminder.id}-evidence-${index}`}>"{demoMode ? maskKespDemoEvidenceText() : item.quote}"</p>
                                          ))}
                                        </div>
                                      ) : null}

                                      <div className="grid gap-3 md:grid-cols-4">
                                        <div>
                                          <p className="text-xs font-medium text-muted-foreground">
                                            {t('callAnalyzer.reminders.dueDate', { defaultValue: 'Fecha' })}
                                          </p>
                                          <Input
                                            type="date"
                                            value={draft.dueDate}
                                            onChange={/** Handles the onChange interaction. */ (event) => handleDraftChange(reminder, 'dueDate', event.target.value)}
                                            disabled={reminder.state !== 'open'}
                                          />
                                        </div>
                                        <div>
                                          <p className="text-xs font-medium text-muted-foreground">
                                            {t('callAnalyzer.reminders.dueTime', { defaultValue: 'Hora' })}
                                          </p>
                                          <Input
                                            type="time"
                                            value={draft.dueTime}
                                            onChange={/** Handles the onChange interaction. */ (event) => handleDraftChange(reminder, 'dueTime', event.target.value)}
                                            disabled={reminder.state !== 'open'}
                                          />
                                        </div>
                                        <div className="md:col-span-2">
                                          <p className="text-xs font-medium text-muted-foreground">
                                            {t('callAnalyzer.reminders.notes', { defaultValue: 'Notas' })}
                                          </p>
                                          <Input
                                            value={draft.notes}
                                            onChange={/** Handles the onChange interaction. */ (event) => handleDraftChange(reminder, 'notes', event.target.value)}
                                            disabled={reminder.state !== 'open'}
                                          />
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}

                                <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                                  <Input
                                    value={caseNotes[loanCase.caseId] ?? loanCase.overrideNote ?? ''}
                                    onChange={/** Handles the onChange interaction. */ (event) =>
                                      setCaseNotes(/** Handles the callback for this operation. */(current) => ({
                                        ...current,
                                        [loanCase.caseId]: event.target.value,
                                      }))
                                    }
                                    placeholder={t('callAnalyzer.reminders.caseNotePlaceholder', {
                                      defaultValue: 'Nota opcional sobre el seguimiento real',
                                    })}
                                  />
                                  <div className="flex flex-wrap gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={/** Handles the onClick interaction. */ () => handleCaseStageUpdate(loanCase, 'sold_pending_follow_through')}
                                    >
                                      {t('callAnalyzer.reminders.keepPending', { defaultValue: 'Sigue pendiente' })}
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={/** Handles the onClick interaction. */ () => handleCaseStageUpdate(loanCase, 'fully_completed')}
                                    >
                                      {t('callAnalyzer.reminders.markCompleted', { defaultValue: 'Completado' })}
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={/** Handles the onClick interaction. */ () => handleCaseStageUpdate(loanCase, 'lost_cancelled')}
                                    >
                                      {t('callAnalyzer.reminders.markCancelled', { defaultValue: 'Cancelado' })}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('callAnalyzer.reminders.salesHistory', { defaultValue: 'Historial de llamadas' })}</CardTitle>
          <CardDescription>
            {t('callAnalyzer.reminders.salesHistoryDescription', {
              defaultValue: 'Llamadas recientes del periodo seleccionado con contexto operativo de etapa.',
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {historyDayGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('callAnalyzer.reminders.noSalesHistory', {
                defaultValue: 'No se encontraron llamadas para los filtros actuales.',
              })}
            </p>
          ) : (
            <div className="space-y-4">
              {historyDayGroups.map(/** Handles the callback for this operation. */(group, index) => {
                const isExpanded = expandedHistoryDays[group.bucketKey] ?? index === 0;
                return (
                  <div key={group.bucketKey} className="rounded-lg border">
                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="space-y-1">
                        <p className="font-semibold">{formatDayLabel(group.bucketKey, i18n.language)}</p>
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                          <span>{group.items.length} {t('callAnalyzer.reminders.dayCalls', { defaultValue: 'llamadas' })}</span>
                          <span>{group.nextActionCount} {t('callAnalyzer.reminders.dayWithNextAction', { defaultValue: 'con siguiente acción' })}</span>
                          <span>{group.pendingCalls} {t('callAnalyzer.reminders.dayPendingCalls', { defaultValue: 'llamadas por hacer' })}</span>
                          <span>{group.pendingTexts} {t('callAnalyzer.reminders.dayPendingTexts', { defaultValue: 'mensajes por enviar' })}</span>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={/** Handles the onClick interaction. */ () =>
                          setExpandedHistoryDays(/** Handles the callback for this operation. */(current) => ({
                            ...current,
                            [group.bucketKey]: !isExpanded,
                          }))
                        }
                      >
                        {isExpanded
                          ? t('callAnalyzer.reminders.hideDay', { defaultValue: 'Ocultar día' })
                          : t('callAnalyzer.reminders.showDay', { defaultValue: 'Ver día' })}
                      </Button>
                    </div>

                    {isExpanded ? (
                      <div className="overflow-x-auto border-t px-4 py-4">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b text-left text-muted-foreground">
                              <th className="py-2 pr-4">{t('callAnalyzer.reminders.columns.call', { defaultValue: 'Llamada' })}</th>
                              <th className="py-2 pr-4">{t('callAnalyzer.reminders.columns.client', { defaultValue: 'Cliente' })}</th>
                              <th className="py-2 pr-4">{t('callAnalyzer.reminders.columns.outcome', { defaultValue: 'Resultado' })}</th>
                              <th className="py-2 pr-4">{t('callAnalyzer.reminders.columns.stage', { defaultValue: 'Etapa' })}</th>
                              <th className="py-2 pr-4">{t('callAnalyzer.reminders.columns.loan', { defaultValue: 'Préstamo' })}</th>
                              <th className="py-2 pr-4">{t('callAnalyzer.reminders.columns.amount', { defaultValue: 'Monto' })}</th>
                              <th className="py-2 pr-4">{t('callAnalyzer.reminders.columns.nextAction', { defaultValue: 'Siguiente acción' })}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.items.map(/** Handles the callback for this operation. */(snapshot) => {
                              const relatedCase = snapshot.caseId ? caseMap.get(snapshot.caseId) : null;
                              const stage = relatedCase?.effectiveStage ?? snapshot.effectiveLifecycleStage ?? 'unknown';
                              return (
                                <tr key={snapshot.id} className="border-b align-top">
                                  <td className="py-3 pr-4">
                                    <Link to={`/calls/${snapshot.sourceCallId}`} className="font-medium hover:underline">
                                      {snapshot.callName || snapshot.sourceCallId}
                                    </Link>
                                    <div className="text-xs text-muted-foreground">
                                      {formatDateTime(snapshot.callOccurredAtIso, i18n.language)}
                                    </div>
                                  </td>
                                  <td className="py-3 pr-4">{snapshot.customerName || '--'}</td>
                                  <td className="py-3 pr-4">{getOutcomeLabel(snapshot.callOutcome, t)}</td>
                                  <td className="py-3 pr-4">
                                    <Badge variant="outline" className={getLifecycleBadgeClass(stage)}>
                                      {getLifecycleLabel(stage, t)}
                                    </Badge>
                                  </td>
                                  <td className="py-3 pr-4">
                                    {getLoanStatusSummary(stage, snapshot.loanCompleted, t)}
                                  </td>
                                  <td className="py-3 pr-4">
                                    {formatMoney(
                                      relatedCase?.loanAmount ?? snapshot.loanAmount ?? null,
                                      relatedCase?.currency ?? snapshot.currency ?? 'MXN',
                                      i18n.language
                                    )}
                                  </td>
                                  <td className="py-3 pr-4">{snapshot.nextAction || '--'}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
