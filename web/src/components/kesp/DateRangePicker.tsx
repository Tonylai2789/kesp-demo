import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/kesp/icons';
import { formatKespDate } from '@/lib/kespI18n';
import {
  aggregateDateKey,
  normalizeAggregateRubricRange,
  parseAggregateDateKey,
  type AggregateRubricRange,
} from '@/lib/aggregateRubric';

function monthLabel(date: Date, language: string | undefined): string {
  return formatKespDate(date, language, { month: 'long', year: 'numeric' });
}

function sameMonth(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();
}

function monthGridDates(monthDate: Date): Date[] {
  const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1, 12, 0, 0, 0);
  const offset = start.getDay();
  start.setDate(start.getDate() - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const next = new Date(start);
    next.setDate(start.getDate() + index);
    return next;
  });
}

function calendarDayState(dayKey: string, range: AggregateRubricRange): 'start' | 'end' | 'inside' | 'outside' {
  const normalized = normalizeAggregateRubricRange(range);
  if (!normalized) return 'outside';
  if (dayKey === normalized.start) return 'start';
  if (dayKey === normalized.end) return 'end';
  return dayKey > normalized.start && dayKey < normalized.end ? 'inside' : 'outside';
}

function KespDateRangeCalendarMonth({
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
        {weekdayKeys.map((key) => <span key={key}>{t(`kesp.agent.aggregateRubric.calendar.${key}`)}</span>)}
      </div>
      <div className="aggregate-calendar-days">
        {days.map((day) => {
          const key = aggregateDateKey(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`);
          const state = calendarDayState(key, range);
          return (
            <button
              key={key}
              type="button"
              className="aggregate-calendar-day"
              data-muted={!sameMonth(day, monthDate)}
              data-state={state}
              onClick={() => onDayClick(key)}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function KespDateRangePicker({
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

  const shiftVisibleMonth = (months: number) => {
    const next = new Date(visibleMonth);
    next.setMonth(visibleMonth.getMonth() + months);
    setVisibleMonthKey(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  };

  const handleDayClick = (dayKey: string) => {
    setDraftRange((range) => {
      if (selectionPhase === 'start') return { start: dayKey, end: dayKey };
      return normalizeAggregateRubricRange({ start: range.start, end: dayKey }) ?? { start: dayKey, end: dayKey };
    });
    setSelectionPhase((phase) => (phase === 'start' ? 'end' : 'start'));
  };

  return (
    <div className="aggregate-calendar-popover">
      <div className="aggregate-calendar-inputs">
        <label>
          <span>{t('kesp.agent.aggregateRubric.from')}</span>
          <input
            type="date"
            value={draftRange.start}
            onChange={(event) => setDraftRange(
              (range) => normalizeAggregateRubricRange({ ...range, start: aggregateDateKey(event.target.value) }) ?? range
            )}
          />
        </label>
        <label>
          <span>{t('kesp.agent.aggregateRubric.to')}</span>
          <input
            type="date"
            value={draftRange.end}
            onChange={(event) => setDraftRange(
              (range) => normalizeAggregateRubricRange({ ...range, end: aggregateDateKey(event.target.value) }) ?? range
            )}
          />
        </label>
      </div>
      <div className="aggregate-calendar-nav">
        <button type="button" onClick={() => shiftVisibleMonth(-1)}>
          <Icon name="chevron" size={12} /> {t('kesp.agent.aggregateRubric.calendar.previous')}
        </button>
        <span>{selectionPhase === 'start' ? t('kesp.agent.aggregateRubric.calendar.pickStart') : t('kesp.agent.aggregateRubric.calendar.pickEnd')}</span>
        <button type="button" onClick={() => shiftVisibleMonth(1)}>
          {t('kesp.agent.aggregateRubric.calendar.next')} <Icon name="arrow" size={12} />
        </button>
      </div>
      <div className="aggregate-calendar-months">
        <KespDateRangeCalendarMonth monthDate={visibleMonth} range={draftRange} onDayClick={handleDayClick} />
        <KespDateRangeCalendarMonth monthDate={nextMonth} range={draftRange} onDayClick={handleDayClick} />
      </div>
    </div>
  );
}
