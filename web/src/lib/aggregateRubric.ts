import { fetchFeedback } from '@/services/firestore';
import type { Call } from '@/types/call';
import type {
  EvidenceItem,
  Feedback,
  RubricScorecardV2,
  RubricV2Criterion,
  RubricV2Group,
  RubricV2Section,
  RubricV2Status,
} from '@/types/feedback';

export type AggregateRubricTrend = 'improving' | 'declining' | 'stable' | 'insufficient';
export type AggregateRubricPriorityBucket = 'priority' | 'watch' | 'stable' | 'coverage';

export type AggregateRubricRange = {
  start: string;
  end: string;
};

export type AggregateRubricFeedbackRow = {
  call: Call;
  feedback: Feedback;
  rubric: RubricScorecardV2;
};

export type AggregateRubricEvidence = {
  callId: string;
  callName: string;
  uploadedAt: Date;
  quote: string;
  speakerLabel?: string | null;
  speakerDisplay?: string | null;
  critiqueTitle: string;
  critiqueDetail: string;
  kind: 'strength' | 'weakness';
};

export type AggregateRubricCritique = {
  title: string;
  detail: string;
  count: number;
  evidence: AggregateRubricEvidence[];
  tip?: string | null;
};

export type AggregateRubricScorePoint = {
  callId: string;
  callName: string;
  uploadedAt: Date;
  processedAt: Date;
  earned: number;
  max: number;
  percent: number;
  status?: RubricV2Status;
};

export type AggregateRubricMetric = {
  id: string;
  title: string;
  maxPoints: number;
  averageEarnedPoints: number;
  averagePercent: number;
  minPercent: number;
  maxPercent: number;
  coveredCallCount: number;
  trend: AggregateRubricTrend;
  trendDeltaPercent: number | null;
  points: AggregateRubricScorePoint[];
};

export type AggregateRubricPriority = {
  priorityBucket: AggregateRubricPriorityBucket;
  priorityScore: number;
  lostPoints: number;
  failureRate: number;
  scorableAveragePercent: number;
  scorableCallCount: number;
  passedCallCount: number;
  failedCallCount: number;
  noAplicaCallCount: number;
  noObservableCallCount: number;
  coverageCallCount: number;
};

export type AggregateRubricCriterion = AggregateRubricMetric & {
  sectionId: string;
  sectionTitle: string;
  groupId: string;
  groupTitle: string;
  priority: AggregateRubricPriority;
  statusCounts: Partial<Record<RubricV2Status, number>>;
  strengths: AggregateRubricCritique[];
  weaknesses: AggregateRubricCritique[];
  coachingTips: string[];
};

export type AggregateRubricGroup = AggregateRubricMetric & {
  criteria: AggregateRubricCriterion[];
};

export type AggregateRubricSection = AggregateRubricMetric & {
  groups: AggregateRubricGroup[];
};

export type AggregateRubricSummary = {
  sections: AggregateRubricSection[];
  total: AggregateRubricMetric;
  eligibleCallCount: number;
  skippedCallCount: number;
  sourceCallCount: number;
};

export type AggregateRubricPriorityGroups = {
  priorities: AggregateRubricCriterion[];
  watch: AggregateRubricCriterion[];
  stable: AggregateRubricCriterion[];
  coverage: AggregateRubricCriterion[];
};

type RuntimeRecord = Record<string, unknown>;

type SafeAggregateCritique = {
  title: string;
  detail: string;
  evidence: EvidenceItem[];
  tip: string | null;
};

const ELLIPSIS = '...';

/** Normalizes an unknown generated value into display-safe single-line text. */
function aggregateText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Returns a safe display string for rubric nodes that may be partially malformed. */
function aggregateTextOrFallback(value: unknown, fallback: string): string {
  return aggregateText(value) || fallback;
}

/** Returns a finite number from generated rubric data. */
function aggregateNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Returns a typed array only when the generated value is an actual array. */
function aggregateArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}


/** Reads rubric sections without assuming Firestore data exactly matches TypeScript. */
function rubricSections(rubric: RubricScorecardV2): RubricV2Section[] {
  return aggregateArray(rubric.sections);
}

/** Reads rubric groups without assuming Firestore data exactly matches TypeScript. */
function rubricGroups(section: RubricV2Section): RubricV2Group[] {
  return aggregateArray(section.groups);
}

/** Reads rubric criteria without assuming Firestore data exactly matches TypeScript. */
function rubricCriteria(group: RubricV2Group): RubricV2Criterion[] {
  return aggregateArray(group.criteria);
}

/** Normalizes generated rubric prose into a compact, readable snippet. */
export function compactAggregateText(value: unknown, maxLength = 180): string {
  const normalized = aggregateText(value);
  if (!normalized || normalized.length <= maxLength) return normalized;

  const sentenceParts = normalized.split(/(?<=[.!?])\s+/);
  let output = '';
  for (const part of sentenceParts) {
    const next = output ? `${output} ${part}` : part;
    if (next.length > maxLength - ELLIPSIS.length) break;
    output = next;
  }
  if (output.length >= 40) return `${output}${ELLIPSIS}`;

  const hardLimit = Math.max(40, maxLength - ELLIPSIS.length);
  const candidate = normalized.slice(0, hardLimit);
  const lastSpace = candidate.lastIndexOf(' ');
  return `${candidate.slice(0, lastSpace > 40 ? lastSpace : hardLimit).trim()}${ELLIPSIS}`;
}

/** Removes boilerplate from generated tips so the UI can show only practical actions. */
function normalizeAggregateTip(value: string): string {
  return aggregateText(value)
    .replace(/\s+/g, ' ')
    .replace(/^\s*(qu[eé]\s+debi[oó]\s+haber\s+dicho|what\s+should\s+have\s+been\s+said)\s*:\s*/i, '')
    .replace(/\bmentor\s+tips?\s*:\s*/gi, '')
    .replace(/\bconsejos?\s+del\s+mentor\s*:\s*/gi, '')
    .trim();
}

/** Pulls clean phrase examples from generated "what should have been said" coaching text. */
export function aggregateCoachingSayExamples(tips: string[], limit = 3): string[] {
  const examples: string[] = [];
  const seen = new Set<string>();

  for (const tip of tips) {
    const normalized = aggregateText(tip);
    if (!normalized) continue;

    const shouldSayMatch = normalized.match(
      /(?:qu[eé]\s+debi[oó]\s+haber\s+dicho|what\s+should\s+have\s+been\s+said)\s*:\s*(.*?)(?:\bmentor\s+tips?\b|\bconsejos?\s+del\s+mentor\b|$)/i
    );
    const source = shouldSayMatch?.[1] ?? normalized;
    const quotedPhrases = Array.from(source.matchAll(/["“]([^"”]{8,220})["”]/g), (match) => match[1]);

    for (const phrase of quotedPhrases) {
      const compacted = compactAggregateText(phrase, 185);
      const key = compacted.toLowerCase();
      if (!compacted || seen.has(key)) continue;
      seen.add(key);
      examples.push(compacted);
      if (examples.length >= limit) return examples;
    }
  }

  return examples;
}

/** Splits long generated tips into a few practical coaching actions. */
export function aggregateCoachingActionItems(tips: string[], limit = 4): string[] {
  const actions: string[] = [];
  const seen = new Set<string>();

  for (const tip of tips) {
    const normalized = normalizeAggregateTip(tip);
    if (!normalized) continue;

    const numberedParts = normalized
      .split(/\s+(?:\d+[.)]|[•-])\s+/)
      .flatMap((part) => part.split(/;\s+/))
      .map((part) => part.replace(/^["“][^"”]+["”]\.?\s*(?:o\s+["“][^"”]+["”]\.?\s*)?/i, '').trim())
      .filter(Boolean);

    for (const part of numberedParts.length > 1 ? numberedParts : [normalized]) {
      const compacted = compactAggregateText(part, 220);
      const clean = compacted ? `${compacted.charAt(0).toUpperCase()}${compacted.slice(1)}` : '';
      const key = clean.toLowerCase();
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      actions.push(clean);
      if (actions.length >= limit) return actions;
    }
  }

  return actions;
}

/** Documents the padDatePart behavior. */
function padDatePart(value: number): string {
  return value.toString().padStart(2, '0');
}

/** Documents the localDateInputValue behavior. */
export function localDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

/** Documents the aggregateDateKey behavior. */
export function aggregateDateKey(value: string | null | undefined): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

/** Documents the parseAggregateDateKey behavior. */
export function parseAggregateDateKey(value: string): Date | null {
  if (!aggregateDateKey(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/** Documents the shiftAggregateDateKey behavior. */
export function shiftAggregateDateKey(value: string, days: number): string {
  const date = parseAggregateDateKey(value);
  if (!date) return value;
  date.setDate(date.getDate() + days);
  return localDateInputValue(date);
}

/** Documents the buildDefaultAggregateRubricRange behavior. */
export function buildDefaultAggregateRubricRange(): AggregateRubricRange {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  return {
    start: localDateInputValue(start),
    end: localDateInputValue(end),
  };
}

/** Documents the normalizeAggregateRubricRange behavior. */
export function normalizeAggregateRubricRange(range: AggregateRubricRange): AggregateRubricRange | null {
  const start = aggregateDateKey(range.start);
  const end = aggregateDateKey(range.end);
  if (!start || !end) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** Documents the rangeFromSearchParamsOrNull behavior. */
export function rangeFromSearchParamsOrNull(search: string): AggregateRubricRange | null {
  const params = new URLSearchParams(search);
  return normalizeAggregateRubricRange({
    start: params.get('start') ?? '',
    end: params.get('end') ?? '',
  });
}

/** Documents the rangeFromSearchParams behavior. */
export function rangeFromSearchParams(search: string): AggregateRubricRange {
  return rangeFromSearchParamsOrNull(search) ?? buildDefaultAggregateRubricRange();
}

/** Documents the aggregateRubricRangeSessionKey behavior. */
export function aggregateRubricRangeSessionKey(agentId: string): string {
  return `kesp:aggregate-rubric-range:${agentId}`;
}

/** Documents the readSessionAggregateRubricRange behavior. */
export function readSessionAggregateRubricRange(key: string): AggregateRubricRange | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AggregateRubricRange>;
    return normalizeAggregateRubricRange({
      start: parsed.start ?? '',
      end: parsed.end ?? '',
    });
  } catch {
    return null;
  }
}

/** Documents the writeSessionAggregateRubricRange behavior. */
export function writeSessionAggregateRubricRange(key: string, range: AggregateRubricRange): void {
  if (typeof window === 'undefined') return;
  const normalized = normalizeAggregateRubricRange(range);
  if (!normalized) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(normalized));
  } catch {
    // Session storage is only a same-tab convenience; ignore storage failures.
  }
}

/** Documents the uploadedDateKey behavior. */
export function uploadedDateKey(call: Call): string {
  return localDateInputValue(call.createdAt);
}

/** Documents the isCallInAggregateRange behavior. */
export function isCallInAggregateRange(call: Call, range: AggregateRubricRange): boolean {
  const uploadedKey = uploadedDateKey(call);
  return uploadedKey >= range.start && uploadedKey <= range.end;
}

/** Documents the callsForAggregateRange behavior. */
export function callsForAggregateRange(calls: Call[], range: AggregateRubricRange): Call[] {
  return calls.filter(
    /** Handles the callback for this operation. */
    (call) => call.status === 'complete' && isCallInAggregateRange(call, range)
  );
}

/** Documents the averageNumbers behavior. */
function averageNumbers(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Documents the scorePercent behavior. */
export function scorePercent(earned: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (earned / max) * 100));
}

/** Documents the colorFromPercent behavior. */
export function colorFromPercent(percent: number): string {
  if (percent >= 80) return 'green';
  if (percent >= 60) return 'amber';
  return 'red';
}

/** Documents the aggregateProcessingOrderDate behavior. */
function aggregateProcessingOrderDate(call: Call): Date {
  return call.analysisCompletedAt ?? call.analysisStartedAt ?? call.updatedAt ?? call.createdAt;
}

/** Documents the sortAggregateRubricScorePoints behavior. */
export function sortAggregateRubricScorePoints(points: AggregateRubricScorePoint[]): AggregateRubricScorePoint[] {
  return [...points].sort(
    /** Handles the callback for this operation. */
    (left, right) =>
      left.uploadedAt.getTime() - right.uploadedAt.getTime()
      || left.processedAt.getTime() - right.processedAt.getTime()
      || left.callId.localeCompare(right.callId)
  );
}

/** Documents the trendFromPoints behavior. */
function trendFromPoints(points: AggregateRubricScorePoint[]): { trend: AggregateRubricTrend; delta: number | null } {
  if (points.length < 3) return { trend: 'insufficient', delta: null };
  const sorted = sortAggregateRubricScorePoints(points);
  const midpoint = Math.ceil(sorted.length / 2);
  const firstAverage = averageNumbers(sorted.slice(0, midpoint).map(
    /** Handles the callback for this operation. */
    (point) => point.percent
  ));
  const secondAverage = averageNumbers(sorted.slice(midpoint).map(
    /** Handles the callback for this operation. */
    (point) => point.percent
  ));
  const delta = secondAverage - firstAverage;
  if (Math.abs(delta) < 3) return { trend: 'stable', delta };
  return { trend: delta > 0 ? 'improving' : 'declining', delta };
}

/** Documents the buildAggregateMetric behavior. */
function buildAggregateMetric(id: string, title: string, points: AggregateRubricScorePoint[]): AggregateRubricMetric {
  const trend = trendFromPoints(points);
  const percentages = points.map(
    /** Handles the callback for this operation. */
    (point) => point.percent
  );
  const maxPoints = averageNumbers(points.map(
    /** Handles the callback for this operation. */
    (point) => point.max
  ));
  return {
    id,
    title,
    maxPoints,
    averageEarnedPoints: averageNumbers(points.map(
      /** Handles the callback for this operation. */
      (point) => point.earned
    )),
    averagePercent: averageNumbers(percentages),
    minPercent: percentages.length > 0 ? Math.min(...percentages) : 0,
    maxPercent: percentages.length > 0 ? Math.max(...percentages) : 0,
    coveredCallCount: points.length,
    trend: trend.trend,
    trendDeltaPercent: trend.delta,
    points,
  };
}

/** Documents the statusCount behavior. */
function statusCount(
  statusCounts: Partial<Record<RubricV2Status, number>>,
  status: RubricV2Status
): number {
  return statusCounts[status] ?? 0;
}

/** Documents the isScorableStatus behavior. */
function isScorableStatus(status: RubricV2Status | undefined): boolean {
  return status === undefined || status === 'Cumple' || status === 'No cumple';
}

/** Documents the averagePointPercent behavior. */
function averagePointPercent(points: AggregateRubricScorePoint[]): number {
  if (points.length === 0) return 0;
  return averageNumbers(points.map(
    /** Handles the callback for this operation. */
    (point) => point.percent
  ));
}

/** Documents the buildCriterionPriority behavior. */
function buildCriterionPriority(
  metric: AggregateRubricMetric,
  statusCounts: Partial<Record<RubricV2Status, number>>
): AggregateRubricPriority {
  const passedCallCount = statusCount(statusCounts, 'Cumple');
  const failedCallCount = statusCount(statusCounts, 'No cumple');
  const noAplicaCallCount = statusCount(statusCounts, 'No aplica');
  const noObservableCallCount = statusCount(statusCounts, 'No observable');
  const coverageCallCount = noAplicaCallCount + noObservableCallCount;
  const scorablePoints = metric.points.filter(
    /** Handles the callback for this operation. */
    (point) => isScorableStatus(point.status)
  );
  const scorableCallCount = scorablePoints.length;
  const scorableAveragePercent = scorableCallCount > 0
    ? averagePointPercent(scorablePoints)
    : 0;
  const failureRate = scorableCallCount > 0 ? failedCallCount / scorableCallCount : 0;
  const lostPoints = scorableCallCount > 0
    ? metric.maxPoints * Math.max(0, 1 - scorableAveragePercent / 100)
    : 0;
  const trendPenalty = metric.trend === 'declining'
    ? Math.min(15, Math.abs(metric.trendDeltaPercent ?? 0) / 2)
    : metric.trend === 'improving'
      ? -5
      : 0;
  const priorityScore = failedCallCount > 0
    ? Math.max(1, Math.round(lostPoints * 18 + failureRate * 40 + failedCallCount * 4 + trendPenalty))
    : noObservableCallCount > 0
      ? Math.round(noObservableCallCount * 3)
      : 0;
  const priorityBucket: AggregateRubricPriorityBucket =
    failedCallCount > 0 && (failureRate >= 0.25 || lostPoints >= 1 || metric.trend === 'declining')
      ? 'priority'
      : failedCallCount > 0 || (metric.trend === 'declining' && scorableCallCount > 0)
        ? 'watch'
        : scorableCallCount === 0 || noObservableCallCount > 0
          ? 'coverage'
          : 'stable';

  return {
    priorityBucket,
    priorityScore,
    lostPoints,
    failureRate,
    scorableAveragePercent,
    scorableCallCount,
    passedCallCount,
    failedCallCount,
    noAplicaCallCount,
    noObservableCallCount,
    coverageCallCount,
  };
}

/** Documents the normalizeCritiqueKey behavior. */
function normalizeCritiqueKey(title: string, detail: string): string {
  return `${aggregateText(title).toLowerCase()}::${aggregateText(detail).toLowerCase()}`;
}

/** Documents the cleanRuntimeText behavior. */
function cleanRuntimeText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Documents the runtimeRecord behavior. */
function runtimeRecord(value: unknown): RuntimeRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RuntimeRecord : null;
}

/** Recovers malformed Firestore objects produced by spreading a string into character keys. */
function numericCharacterText(value: unknown): string {
  const record = runtimeRecord(value);
  if (!record) return '';

  const parts = Object.entries(record)
    .filter(
      /** Handles the callback for this operation. */
      ([key, char]) => /^\d+$/.test(key) && typeof char === 'string'
    )
    .sort(
      /** Handles the callback for this operation. */
      ([left], [right]) => Number(left) - Number(right)
    )
    .map(
      /** Handles the callback for this operation. */
      ([, char]) => char as string
    );

  return cleanRuntimeText(parts.join(''));
}

/** Documents the coerceEvidenceItems behavior. */
function coerceEvidenceItems(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap(
    /** Handles the callback for this operation. */
    (item): EvidenceItem[] => {
      const record = runtimeRecord(item);
      if (!record) return [];

      const quote = cleanRuntimeText(record.quote);
      if (!quote) return [];

      const speakerLabel = cleanRuntimeText(record.speaker_label);
      const speakerDisplay = cleanRuntimeText(record.speaker_display);
      return [{
        quote,
        ...(speakerLabel ? { speaker_label: speakerLabel } : {}),
        ...(speakerDisplay ? { speaker_display: speakerDisplay } : {}),
      }];
    }
  );
}

/** Documents the coerceAggregateCritique behavior. */
function coerceAggregateCritique(
  value: unknown,
  kind: 'strength' | 'weakness',
  fallbackTitle: string
): SafeAggregateCritique | null {
  const record = runtimeRecord(value);
  const numericText = numericCharacterText(value);
  const rawTitle = record ? cleanRuntimeText(record.title) : '';
  const rawDetail = record ? cleanRuntimeText(record.detail) : cleanRuntimeText(value);
  const detail = rawDetail || numericText;
  const title = rawTitle || (detail ? fallbackTitle : '');

  if (!title && !detail) return null;

  return {
    title: title || (kind === 'strength' ? 'Fortaleza registrada' : 'Oportunidad registrada'),
    detail: detail || title,
    evidence: coerceEvidenceItems(record?.evidence),
    tip: record ? cleanRuntimeText(record.weakness_improvement_tip) || null : null,
  };
}

/** Documents the critiqueEvidence behavior. */
function critiqueEvidence(
  critique: SafeAggregateCritique,
  row: AggregateRubricFeedbackRow,
  kind: 'strength' | 'weakness'
): AggregateRubricEvidence[] {
  return critique.evidence.map(
    /** Handles the callback for this operation. */
    (evidence) => ({
      callId: row.call.id,
      callName: row.call.name ?? row.feedback.customer_name ?? row.call.id,
      uploadedAt: row.call.createdAt,
      quote: evidence.quote,
      speakerLabel: evidence.speaker_label ?? null,
      speakerDisplay: evidence.speaker_display ?? null,
      critiqueTitle: critique.title,
      critiqueDetail: critique.detail,
      kind,
    })
  );
}

/** Documents the addCritiqueToMap behavior. */
function addCritiqueToMap(
  map: Map<string, AggregateRubricCritique>,
  critiqueValue: unknown,
  row: AggregateRubricFeedbackRow,
  kind: 'strength' | 'weakness',
  fallbackTitle: string
): void {
  const critique = coerceAggregateCritique(critiqueValue, kind, fallbackTitle);
  if (!critique) return;

  const key = normalizeCritiqueKey(critique.title, critique.detail);
  const previous = map.get(key);
  if (!previous) {
    map.set(key, {
      title: critique.title,
      detail: critique.detail,
      count: 1,
      evidence: critiqueEvidence(critique, row, kind),
      tip: critique.tip,
    });
    return;
  }
  previous.count += 1;
  previous.evidence.push(...critiqueEvidence(critique, row, kind));
  if (!previous.tip && critique.tip) previous.tip = critique.tip;
}

/** Documents the sortedCritiques behavior. */
function sortedCritiques(map: Map<string, AggregateRubricCritique>): AggregateRubricCritique[] {
  return Array.from(map.values())
    .sort(
      /** Handles the callback for this operation. */
      (left, right) => right.count - left.count || left.title.localeCompare(right.title)
    )
    .map(
      /** Handles the callback for this operation. */
      (critique) => ({
        ...critique,
        evidence: critique.evidence.slice(0, 6),
      })
    );
}

/** Documents the addUniqueTip behavior. */
function addUniqueTip(tips: string[], tip: string | null | undefined): void {
  const normalizedTip = aggregateText(tip);
  if (!normalizedTip || tips.includes(normalizedTip)) return;
  tips.push(normalizedTip);
}

/** Documents the buildCriterionAggregate behavior. */
function buildCriterionAggregate(
  template: RubricV2Criterion,
  section: RubricV2Section,
  group: RubricV2Group,
  rows: AggregateRubricFeedbackRow[]
): AggregateRubricCriterion {
  const points: AggregateRubricScorePoint[] = [];
  const statusCounts: Partial<Record<RubricV2Status, number>> = {};
  const strengths = new Map<string, AggregateRubricCritique>();
  const weaknesses = new Map<string, AggregateRubricCritique>();
  const coachingTips: string[] = [];

  for (const row of rows) {
    const matchingSection = rubricSections(row.rubric).find(
      /** Handles the callback for this operation. */
      (candidate) => candidate.id === section.id
    );
    const matchingGroup = matchingSection ? rubricGroups(matchingSection).find(
      /** Handles the callback for this operation. */
      (candidate) => candidate.id === group.id
    ) : undefined;
    const criterion = matchingGroup ? rubricCriteria(matchingGroup).find(
      /** Handles the callback for this operation. */
      (candidate) => candidate.id === template.id
    ) : undefined;
    if (!criterion) continue;
    const earnedPoints = aggregateNumber(criterion.earned_points);
    const maxPoints = aggregateNumber(criterion.max_points);
    points.push({
      callId: row.call.id,
      callName: row.call.name ?? row.feedback.customer_name ?? row.call.id,
      uploadedAt: row.call.createdAt,
      processedAt: aggregateProcessingOrderDate(row.call),
      earned: earnedPoints,
      max: maxPoints,
      percent: scorePercent(earnedPoints, maxPoints),
      status: criterion.status,
    });
    statusCounts[criterion.status] = (statusCounts[criterion.status] ?? 0) + 1;
    addUniqueTip(coachingTips, criterion.criterion_improvement_tip);
    for (const critique of criterion.good_critiques ?? []) {
      addCritiqueToMap(strengths, critique, row, 'strength', criterion.title);
    }
    for (const critique of criterion.bad_critiques ?? []) {
      addCritiqueToMap(weaknesses, critique, row, 'weakness', criterion.title);
      const critiqueRecord = runtimeRecord(critique);
      addUniqueTip(coachingTips, cleanRuntimeText(critiqueRecord?.weakness_improvement_tip));
    }
  }

  const templateId = aggregateTextOrFallback(template.id, 'criterion');
  const sectionId = aggregateTextOrFallback(section.id, 'section');
  const groupId = aggregateTextOrFallback(group.id, 'group');
  const metric = buildAggregateMetric(
    templateId,
    aggregateTextOrFallback(template.title, templateId),
    points
  );

  return {
    ...metric,
    sectionId,
    sectionTitle: aggregateTextOrFallback(section.title, sectionId),
    groupId,
    groupTitle: aggregateTextOrFallback(group.title, groupId),
    priority: buildCriterionPriority(metric, statusCounts),
    statusCounts,
    strengths: sortedCritiques(strengths),
    weaknesses: sortedCritiques(weaknesses),
    coachingTips: coachingTips.slice(0, 6),
  };
}

/** Documents the compareCriteriaByPriority behavior. */
function compareCriteriaByPriority(
  left: AggregateRubricCriterion,
  right: AggregateRubricCriterion
): number {
  if (right.priority.priorityScore !== left.priority.priorityScore) {
    return right.priority.priorityScore - left.priority.priorityScore;
  }
  if (right.priority.lostPoints !== left.priority.lostPoints) {
    return right.priority.lostPoints - left.priority.lostPoints;
  }
  if (right.priority.failedCallCount !== left.priority.failedCallCount) {
    return right.priority.failedCallCount - left.priority.failedCallCount;
  }
  return left.id.localeCompare(right.id);
}

/** Documents the sortCriteriaByPriority behavior. */
export function sortCriteriaByPriority(criteria: AggregateRubricCriterion[]): AggregateRubricCriterion[] {
  return [...criteria].sort(compareCriteriaByPriority);
}

/** Documents the buildNodePoints behavior. */
function buildNodePoints(
  rows: AggregateRubricFeedbackRow[],
  resolve: (rubric: RubricScorecardV2) => { earned_points: number; max_points: number } | null
): AggregateRubricScorePoint[] {
  return rows.reduce<AggregateRubricScorePoint[]>(
    /** Handles the callback for this operation. */
    (points, row) => {
      const node = resolve(row.rubric);
      if (!node) return points;
      const earnedPoints = aggregateNumber(node.earned_points);
      const maxPoints = aggregateNumber(node.max_points);
      points.push({
        callId: row.call.id,
        callName: row.call.name ?? row.feedback.customer_name ?? row.call.id,
        uploadedAt: row.call.createdAt,
        processedAt: aggregateProcessingOrderDate(row.call),
        earned: earnedPoints,
        max: maxPoints,
        percent: scorePercent(earnedPoints, maxPoints),
      });
      return points;
    },
    []
  );
}

/** Documents the buildAggregateRubricSummary behavior. */
export function buildAggregateRubricSummary(
  rows: AggregateRubricFeedbackRow[],
  sourceCallCount: number
): AggregateRubricSummary | null {
  const template = rows[0]?.rubric;
  if (!template) return null;

  const sections = rubricSections(template).map(
    /** Handles the callback for this operation. */
    (section) => {
      const sectionId = aggregateTextOrFallback(section.id, 'section');
      const sectionTitle = aggregateTextOrFallback(section.title, sectionId);
      const groups = rubricGroups(section).map(
        /** Handles the callback for this operation. */
        (group) => {
          const groupId = aggregateTextOrFallback(group.id, 'group');
          const groupTitle = aggregateTextOrFallback(group.title, groupId);
          return {
            ...buildAggregateMetric(
              groupId,
              groupTitle,
              buildNodePoints(rows, (rubric) => {
                const matchingSection = rubricSections(rubric).find(
                  /** Handles the callback for this operation. */
                  (candidateSection) => candidateSection.id === section.id
                );
                return matchingSection
                  ? rubricGroups(matchingSection).find(
                    /** Handles the callback for this operation. */
                    (candidateGroup) => candidateGroup.id === group.id
                  ) ?? null
                  : null;
              })
            ),
            criteria: rubricCriteria(group).map(
              /** Handles the callback for this operation. */
              (criterion) => buildCriterionAggregate(criterion, section, group, rows)
            ),
          };
        }
      );
      return {
        ...buildAggregateMetric(
          sectionId,
          sectionTitle,
          buildNodePoints(rows, (rubric) =>
            rubricSections(rubric).find(
              /** Handles the callback for this operation. */
              (candidateSection) => candidateSection.id === section.id
            ) ?? null
          )
        ),
        groups,
      };
    }
  );

  return {
    sections,
    total: buildAggregateMetric(
      'total',
      'Total',
      rows.map(
        /** Handles the callback for this operation. */
        (row) => {
          const earnedPoints = aggregateNumber(row.rubric.earned_points);
          const totalPoints = aggregateNumber(row.rubric.total_points);
          return {
            callId: row.call.id,
            callName: row.call.name ?? row.feedback.customer_name ?? row.call.id,
            uploadedAt: row.call.createdAt,
            processedAt: aggregateProcessingOrderDate(row.call),
            earned: earnedPoints,
            max: totalPoints,
            percent: scorePercent(earnedPoints, totalPoints),
          };
        }
      )
    ),
    eligibleCallCount: rows.length,
    skippedCallCount: Math.max(0, sourceCallCount - rows.length),
    sourceCallCount,
  };
}

/** Documents the aggregateCriteria behavior. */
export function aggregateCriteria(summary: AggregateRubricSummary | null): AggregateRubricCriterion[] {
  return summary?.sections.flatMap(
    /** Handles the callback for this operation. */
    (section) => section.groups.flatMap(
      /** Handles the callback for this operation. */
      (group) => group.criteria
    )
  ) ?? [];
}

/** Documents the groupAggregateCriteriaByPriority behavior. */
export function groupAggregateCriteriaByPriority(
  summary: AggregateRubricSummary | null
): AggregateRubricPriorityGroups {
  const criteria = aggregateCriteria(summary);
  return {
    priorities: sortCriteriaByPriority(criteria.filter(
      /** Handles the callback for this operation. */
      (criterion) => criterion.priority.priorityBucket === 'priority'
    )),
    watch: sortCriteriaByPriority(criteria.filter(
      /** Handles the callback for this operation. */
      (criterion) => criterion.priority.priorityBucket === 'watch'
    )),
    stable: criteria.filter(
      /** Handles the callback for this operation. */
      (criterion) => criterion.priority.priorityBucket === 'stable'
    ).sort(
      /** Handles the callback for this operation. */
      (left, right) => right.priority.scorableAveragePercent - left.priority.scorableAveragePercent || left.id.localeCompare(right.id)
    ),
    coverage: sortCriteriaByPriority(criteria.filter(
      /** Handles the callback for this operation. */
      (criterion) => criterion.priority.priorityBucket === 'coverage'
    )),
  };
}

/** Documents the findAggregateCriterion behavior. */
export function findAggregateCriterion(
  summary: AggregateRubricSummary | null,
  sectionId: string,
  groupId: string,
  criterionId: string
): AggregateRubricCriterion | null {
  const section = summary?.sections.find(
    /** Handles the callback for this operation. */
    (candidateSection) => candidateSection.id === sectionId
  );
  const group = section?.groups.find(
    /** Handles the callback for this operation. */
    (candidateGroup) => candidateGroup.id === groupId
  );
  return group?.criteria.find(
    /** Handles the callback for this operation. */
    (candidateCriterion) => candidateCriterion.id === criterionId
  ) ?? null;
}

/** Documents the loadAggregateRubricRows behavior. */
export async function loadAggregateRubricRows(calls: Call[]): Promise<AggregateRubricFeedbackRow[]> {
  /** Calls Firestore feedback documents for each complete call in the selected uploaded-date range. */
  const rows = await Promise.all(
    calls.map(
      /** Handles the callback for this operation. */
      async (call) => {
        const feedback = await fetchFeedback(call.id);
        const rubric = feedback?.rubric_scorecard_v2;
        return feedback && rubric ? { call, feedback, rubric } : null;
      }
    )
  );
  return rows.filter(
    /** Handles the callback for this operation. */
    (row): row is AggregateRubricFeedbackRow => row !== null
  );
}
