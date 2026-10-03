import type { AgentReminder, ProgressRollup } from '@/types';

export const AGENT_ACTIVITY_TIMEZONE = 'America/Mexico_City';

export function buildAgentKey(uploadedBy: string, salesAgentId: string): string {
  return `${uploadedBy}__${salesAgentId}`;
}

function getDatePartsInTimeZone(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.get('year')),
    month: Number(lookup.get('month')),
    day: Number(lookup.get('day')),
  };
}

function formatDateParts(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function shiftUtcDate(date: Date, deltaDays: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + deltaDays);
  return next;
}

export function getCurrentBucketKey(periodType: 'day' | 'week' | 'month', date = new Date()): string {
  const localParts = getDatePartsInTimeZone(date, AGENT_ACTIVITY_TIMEZONE);
  if (periodType === 'day') {
    return formatDateParts(localParts);
  }
  if (periodType === 'month') {
    return `${localParts.year}-${String(localParts.month).padStart(2, '0')}`;
  }

  const localDateUtc = new Date(Date.UTC(localParts.year, localParts.month - 1, localParts.day));
  const weekday = localDateUtc.getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  const monday = shiftUtcDate(localDateUtc, -mondayOffset);
  return formatDateParts({
    year: monday.getUTCFullYear(),
    month: monday.getUTCMonth() + 1,
    day: monday.getUTCDate(),
  });
}

export function compareBucketKeys(a: string, b: string): number {
  return a.localeCompare(b);
}

export function getReminderUrgency(reminder: AgentReminder, date = new Date()): 'overdue' | 'today' | 'this_week' | 'scheduled' | 'condition' | 'unscheduled' {
  if (reminder.state !== 'open') {
    return 'scheduled';
  }

  const todayKey = getCurrentBucketKey('day', date);
  const weekKey = getCurrentBucketKey('week', date);

  if (reminder.precision === 'condition_based') {
    return 'condition';
  }
  if (reminder.precision === 'unscheduled' || !reminder.dueDate) {
    return 'unscheduled';
  }
  if (reminder.dueDate < todayKey) {
    return 'overdue';
  }
  if (reminder.dueDate === todayKey) {
    return 'today';
  }

  const reminderWeek = getCurrentBucketKey('week', new Date(`${reminder.dueDate}T12:00:00Z`));
  if (reminderWeek === weekKey) {
    return 'this_week';
  }

  return 'scheduled';
}

export function buildProgressSynopsis(
  current: ProgressRollup | null,
  previous: ProgressRollup | null,
  language = 'en'
): string[] {
  const isSpanish = language.startsWith('es');
  if (!current) {
    return [
      isSpanish
        ? 'Todavía no hay datos de progreso para este periodo.'
        : 'No progress data is available for this period yet.',
    ];
  }

  const lines: string[] = [];
  lines.push(
    isSpanish
      ? `Se revisaron ${current.totalReviewedCalls} llamada${current.totalReviewedCalls === 1 ? '' : 's'} en este periodo.`
      : `Reviewed ${current.totalReviewedCalls} call${current.totalReviewedCalls === 1 ? '' : 's'} in this period.`
  );

  if (typeof current.averageScore === 'number' && current.eligibleScoreCount > 0) {
    lines.push(
      isSpanish
        ? `Puntuación promedio: ${current.averageScore.toFixed(1)} en ${current.eligibleScoreCount} llamada${current.eligibleScoreCount === 1 ? '' : 's'} con score válido.`
        : `Average score: ${current.averageScore.toFixed(1)} across ${current.eligibleScoreCount} score-eligible call${current.eligibleScoreCount === 1 ? '' : 's'}.`
    );
  } else {
    lines.push(
      isSpanish
        ? 'No hay puntuación promedio porque no se encontraron llamadas con score válido en este periodo.'
        : 'Average score is unavailable because no score-eligible calls were found in this period.'
    );
  }

  if (current.topStrengths.length > 0) {
    lines.push(
      isSpanish
        ? `Fortalezas repetidas: ${current.topStrengths.map((item) => `${item.label} (${item.count})`).join(', ')}.`
        : `Repeated strengths: ${current.topStrengths.map((item) => `${item.label} (${item.count})`).join(', ')}.`
    );
  }

  if (current.topWeaknesses.length > 0) {
    lines.push(
      isSpanish
        ? `Patrones principales para entrenar: ${current.topWeaknesses.map((item) => `${item.label} (${item.count})`).join(', ')}.`
        : `Main coaching patterns: ${current.topWeaknesses.map((item) => `${item.label} (${item.count})`).join(', ')}.`
    );
  }

  if (previous) {
    const scoreDelta =
      typeof current.averageScore === 'number' && typeof previous.averageScore === 'number'
        ? current.averageScore - previous.averageScore
        : null;

    if (scoreDelta != null) {
      if (scoreDelta > 0.05) {
        lines.push(
          isSpanish
            ? `La puntuación mejoró ${scoreDelta.toFixed(1)} puntos contra el periodo anterior de ${current.periodType}.`
            : `Score improved by ${scoreDelta.toFixed(1)} points versus the previous ${current.periodType} period.`
        );
      } else if (scoreDelta < -0.05) {
        lines.push(
          isSpanish
            ? `La puntuación bajó ${Math.abs(scoreDelta).toFixed(1)} puntos contra el periodo anterior de ${current.periodType}.`
            : `Score declined by ${Math.abs(scoreDelta).toFixed(1)} points versus the previous ${current.periodType} period.`
        );
      } else {
        lines.push(
          isSpanish
            ? `La puntuación se mantuvo prácticamente igual contra el periodo anterior de ${current.periodType}.`
            : `Score stayed effectively flat versus the previous ${current.periodType} period.`
        );
      }
    }

    const previousTopWeakness = previous.topWeaknesses[0]?.label;
    const currentTopWeakness = current.topWeaknesses[0]?.label;
    if (currentTopWeakness && currentTopWeakness !== previousTopWeakness) {
      lines.push(
        isSpanish
          ? `La prioridad principal cambió de ${previousTopWeakness ?? 'ninguna'} a ${currentTopWeakness}.`
          : `The main coaching priority shifted from ${previousTopWeakness ?? 'none'} to ${currentTopWeakness}.`
      );
    }
  }

  return lines;
}
