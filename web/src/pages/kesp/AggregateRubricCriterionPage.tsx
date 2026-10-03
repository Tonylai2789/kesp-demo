import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAuth } from '@/contexts/useAuth';
import { subscribeToAgentAnalysis } from '@/services/agentAnalyses';
import { subscribeToAgentLinkedCalls } from '@/services/firestore';
import type { AgentAnalysis } from '@/types/agentAnalysis';
import type { Call } from '@/types/call';
import { Pill, type PillKind } from '@/components/kesp/primitives';
import { Icon } from '@/components/kesp/icons';
import { formatKespDate } from '@/lib/kespI18n';
import {
  aggregateCoachingActionItems,
  aggregateCoachingSayExamples,
  aggregateRubricRangeSessionKey,
  buildDefaultAggregateRubricRange,
  buildAggregateRubricSummary,
  callsForAggregateRange,
  compactAggregateText,
  colorFromPercent,
  findAggregateCriterion,
  loadAggregateRubricRows,
  parseAggregateDateKey,
  rangeFromSearchParamsOrNull,
  readSessionAggregateRubricRange,
  type AggregateRubricCriterion,
  type AggregateRubricEvidence,
  type AggregateRubricMetric,
  type AggregateRubricPriorityBucket,
  sortAggregateRubricScorePoints,
  type AggregateRubricRange,
  type AggregateRubricScorePoint,
  type AggregateRubricTrend,
} from '@/lib/aggregateRubric';
import { maskKespDemoEvidenceText, redactKespDemoText } from '@/lib/kespDemoRedaction';
import { useKespDemoRedactionEnabled } from '@/hooks/useKespDemoRedactionEnabled';

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

/** Documents the formatRangeLabel behavior. */
function formatRangeLabel(range: AggregateRubricRange, language: string | undefined): string {
  const start = parseAggregateDateKey(range.start);
  const end = parseAggregateDateKey(range.end);
  if (!start || !end) return `${range.start} - ${range.end}`;
  return `${formatKespDate(start, language)} - ${formatKespDate(end, language)}`;
}

function affectedCallsText(criterion: AggregateRubricCriterion, t: TFunction): string {
  const total = criterion.priority.scorableCallCount;
  const failed = criterion.priority.failedCallCount;
  if (total <= 0) return t('kesp.agent.aggregateRubric.detail.summaryNoCoverage');
  const percent = Math.round((failed / total) * 100);
  return t('kesp.agent.aggregateRubric.detail.summaryAffectedBody', { failed, total, percent });
}

function primaryFindingText(criterion: AggregateRubricCriterion, isActionable: boolean, t: TFunction): string {
  if (isActionable) {
    const topWeakness = criterion.weaknesses[0];
    if (topWeakness) return compactAggregateText(`${topWeakness.title}: ${topWeakness.detail}`, 520);
    return t('kesp.agent.aggregateRubric.detail.summaryWeaknessFallback');
  }

  const topStrength = criterion.strengths[0];
  if (topStrength) return compactAggregateText(`${topStrength.title}: ${topStrength.detail}`, 520);
  return t(`kesp.agent.aggregateRubric.priority.detail.${criterion.priority.priorityBucket}`);
}

function coachingActionsForCriterion(criterion: AggregateRubricCriterion, isActionable: boolean, t: TFunction): string[] {
  const actions = aggregateCoachingActionItems(criterion.coachingTips, 5);
  if (actions.length > 0) return actions;

  if (isActionable) {
    const weaknessTip = criterion.weaknesses.find((weakness) => weakness.tip)?.tip;
    const fallbackActions = aggregateCoachingActionItems(weaknessTip ? [weaknessTip] : [], 5);
    if (fallbackActions.length > 0) return fallbackActions;
  }

  return [
    t(`kesp.agent.aggregateRubric.detail.fallbackAction.${criterion.priority.priorityBucket}`),
    t('kesp.agent.aggregateRubric.detail.fallbackAction.keepSimple'),
    t('kesp.agent.aggregateRubric.detail.fallbackAction.practice'),
  ];
}

function sayExamplesForCriterion(criterion: AggregateRubricCriterion, isActionable: boolean, t: TFunction): string[] {
  const examples = aggregateCoachingSayExamples(criterion.coachingTips, 3);
  if (examples.length > 0) return examples;

  const weaknessTip = criterion.weaknesses.find((weakness) => weakness.tip)?.tip;
  const weaknessExamples = aggregateCoachingSayExamples(weaknessTip ? [weaknessTip] : [], 3);
  if (weaknessExamples.length > 0) return weaknessExamples;

  if (!isActionable) {
    return [
      t('kesp.agent.aggregateRubric.detail.defaultSay.stableOne'),
      t('kesp.agent.aggregateRubric.detail.defaultSay.stableTwo'),
    ];
  }

  return [
    t('kesp.agent.aggregateRubric.detail.defaultSay.one'),
    t('kesp.agent.aggregateRubric.detail.defaultSay.two'),
    t('kesp.agent.aggregateRubric.detail.defaultSay.three'),
  ];
}

function shortEvidenceForCriterion(
  criterion: AggregateRubricCriterion,
  isActionable: boolean
): AggregateRubricEvidence[] {
  const critiques = isActionable ? criterion.weaknesses : criterion.strengths;
  const examples: AggregateRubricEvidence[] = [];
  const seen = new Set<string>();

  for (const critique of critiques) {
    for (const evidence of critique.evidence) {
      const key = `${evidence.callId}:${evidence.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      examples.push(evidence);
      if (examples.length >= 2) return examples;
    }
  }

  return examples;
}

/** Renders a compact summary instead of a long audit report. */
function AggregateCoachingBrief({
  criterion,
  isActionable,
}: {
  criterion: AggregateRubricCriterion;
  isActionable: boolean;
}) {
  const { t } = useTranslation();
  const summaryItems = [
    {
      label: t('kesp.agent.aggregateRubric.detail.summaryAffected'),
      body: affectedCallsText(criterion, t),
    },
    {
      label: isActionable
        ? t('kesp.agent.aggregateRubric.priority.mainWeakness')
        : t('kesp.agent.aggregateRubric.priority.mainStrength'),
      body: primaryFindingText(criterion, isActionable, t),
    },
    {
      label: t('kesp.agent.aggregateRubric.detail.summaryMentorFocus'),
      body: isActionable
        ? t('kesp.agent.aggregateRubric.detail.summaryMentorFocusBody')
        : t('kesp.agent.aggregateRubric.detail.summaryMentorStableBody'),
    },
  ];

  return (
    <section className="card aggregate-detail-section aggregate-coaching-brief">
      <div className="aggregate-section-heading">
        <div>
          <h3>{t('kesp.agent.aggregateRubric.detail.quickSummary')}</h3>
          <p>{t('kesp.agent.aggregateRubric.detail.quickSummaryHelp')}</p>
        </div>
        <AggregateTrendPill metric={criterion} />
      </div>
      <div className="aggregate-brief-grid">
        {summaryItems.map((item) => (
          <div key={item.label} className="aggregate-brief-item">
            <span>{item.label}</span>
            <p>{item.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Renders the concrete coaching plan for one aggregate criterion. */
function AggregateSayExamples({
  criterion,
  isActionable,
}: {
  criterion: AggregateRubricCriterion;
  isActionable: boolean;
}) {
  const { t } = useTranslation();
  const demoMode = useKespDemoRedactionEnabled();
  const examples = sayExamplesForCriterion(criterion, isActionable, t);

  return (
    <section className="card aggregate-detail-section aggregate-say-examples">
      <div className="aggregate-section-heading">
        <div>
          <h3>{t('kesp.agent.aggregateRubric.detail.whatToSay')}</h3>
          <p>{t('kesp.agent.aggregateRubric.detail.whatToSayHelp')}</p>
        </div>
      </div>
      <div className="aggregate-say-list">
        {examples.map((example, index) => (
          <blockquote key={`${example}-${index}`} className="aggregate-say-item">
            "{demoMode ? redactKespDemoText(example) : example}"
          </blockquote>
        ))}
      </div>
    </section>
  );
}

/** Renders the concrete training plan for one aggregate criterion. */
function AggregateTrainingPlan({
  criterion,
  isActionable,
}: {
  criterion: AggregateRubricCriterion;
  isActionable: boolean;
}) {
  const { t } = useTranslation();
  const actions = coachingActionsForCriterion(criterion, isActionable, t);

  return (
    <section className="card aggregate-detail-section aggregate-training-plan">
      <div className="aggregate-section-heading">
        <div>
          <h3>{t('kesp.agent.aggregateRubric.detail.whatToTrain')}</h3>
          <p>
            {isActionable
              ? t('kesp.agent.aggregateRubric.detail.whatToTrainHelp')
              : t('kesp.agent.aggregateRubric.detail.whatToTrainStableHelp')}
          </p>
        </div>
      </div>
      <div className="aggregate-action-list">
        {actions.map((action, index) => (
          <div key={`${action}-${index}`} className="aggregate-action-item">
            <span>{index + 1}</span>
            <p>{action}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Renders only a few short examples for context. */
function AggregateQuickExamples({
  criterion,
  isActionable,
}: {
  criterion: AggregateRubricCriterion;
  isActionable: boolean;
}) {
  const { t, i18n } = useTranslation();
  const demoMode = useKespDemoRedactionEnabled();
  const examples = shortEvidenceForCriterion(criterion, isActionable);

  return (
    <section className="card aggregate-detail-section aggregate-quick-examples">
      <div className="aggregate-section-heading">
        <div>
          <h3>{t('kesp.agent.aggregateRubric.detail.examplesTitle')}</h3>
          <p>{t('kesp.agent.aggregateRubric.detail.examplesHelp')}</p>
        </div>
      </div>
      {examples.length === 0 ? (
        <div className="muted small">{t('kesp.agent.aggregateRubric.noEvidence')}</div>
      ) : (
        <div className="aggregate-example-list">
          {examples.map((item, index) => (
            <article key={`${item.callId}-${index}`} className="aggregate-example-item" data-kind={item.kind}>
              <blockquote>"{demoMode ? maskKespDemoEvidenceText() : compactAggregateText(item.quote, 150)}"</blockquote>
              <div className="aggregate-evidence-meta">
                <span>{item.callName}</span>
                <span>{formatKespDate(item.uploadedAt, i18n.resolvedLanguage)}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}


/** Renders the AggregateCriterionScoreChart component. */
function AggregateCriterionScoreChart({ points }: { points: AggregateRubricScorePoint[] }) {
  const { t, i18n } = useTranslation();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const sortedPoints = useMemo(
    /** Handles the callback for this operation. */
    () => sortAggregateRubricScorePoints(points),
    [points]
  );
  const w = 1000;
  const h = 260;
  const pad = { l: 54, r: 24, t: 24, b: 46 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const xForIndex = /** Documents the xForIndex behavior. */ (index: number) =>
    sortedPoints.length <= 1
      ? pad.l + plotW / 2
      : pad.l + (index * plotW) / Math.max(1, sortedPoints.length - 1);
  const yForPercent = /** Documents the yForPercent behavior. */ (percent: number) =>
    pad.t + (1 - Math.max(0, Math.min(100, percent)) / 100) * plotH;
  const chartPoints = sortedPoints.map(
    /** Handles the callback for this operation. */
    (point, index) => ({
      point,
      index,
      x: xForIndex(index),
      y: yForPercent(point.percent),
    })
  );
  const linePoints = chartPoints.map(
    /** Handles the callback for this operation. */
    (chartPoint) => chartPoint.x + ',' + chartPoint.y
  ).join(' ');
  const activeChartPoint = hoverIndex == null ? null : chartPoints[hoverIndex] ?? null;
  const activePoint = activeChartPoint?.point ?? null;
  const activeX = activeChartPoint?.x ?? null;
  const activeY = activeChartPoint?.y ?? null;

  const handlePointerMove = /** Handles the handlePointerMove interaction. */ (event: ReactPointerEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    if (!svg || chartPoints.length === 0) return;
    const transform = svg.getScreenCTM();
    if (!transform) return;

    const cursorPoint = svg.createSVGPoint();
    cursorPoint.x = event.clientX;
    cursorPoint.y = event.clientY;
    const svgPoint = cursorPoint.matrixTransform(transform.inverse());
    if (svgPoint.x < pad.l || svgPoint.x > w - pad.r || svgPoint.y < pad.t || svgPoint.y > h - pad.b) {
      setHoverIndex(null);
      return;
    }

    const rect = svg.getBoundingClientRect();
    const hitRadiusPx = 18;
    let nearestIndex: number | null = null;
    let nearestDistancePx = Number.POSITIVE_INFINITY;
    chartPoints.forEach(
      /** Handles the callback for this operation. */
      (chartPoint) => {
        const dxPx = ((chartPoint.x - svgPoint.x) * rect.width) / w;
        const dyPx = ((chartPoint.y - svgPoint.y) * rect.height) / h;
        const distancePx = Math.hypot(dxPx, dyPx);
        if (distancePx < nearestDistancePx) {
          nearestIndex = chartPoint.index;
          nearestDistancePx = distancePx;
        }
      }
    );

    const nextIndex = nearestIndex != null && nearestDistancePx <= hitRadiusPx ? nearestIndex : null;
    setHoverIndex(
      /** Handles the callback for this operation. */
      (previous) => (previous === nextIndex ? previous : nextIndex)
    );
  };

  return (
    <section className="card aggregate-detail-section aggregate-score-chart-card">
      <div className="row row-between row-wrap aggregate-score-chart-head">
        <h3>{t('kesp.agent.aggregateRubric.scoreChart.title')}</h3>
        <span>{t('kesp.agent.aggregateRubric.scoreChart.scorePercent')}</span>
      </div>
      {sortedPoints.length === 0 ? (
        <div className="muted small">{t('kesp.agent.aggregateRubric.scoreChart.empty')}</div>
      ) : (
        <>
          <svg
            ref={svgRef}
            className="aggregate-score-chart"
            viewBox={'0 0 ' + w + ' ' + h}
            role="img"
            aria-label={t('kesp.agent.aggregateRubric.scoreChart.title')}
          >
            {[0, 25, 50, 75, 100].map(
              /** Handles the callback for this operation. */
              (tick) => {
                const y = yForPercent(tick);
                return (
                  <g key={tick}>
                    <line
                      x1={pad.l}
                      x2={w - pad.r}
                      y1={y}
                      y2={y}
                      stroke="var(--line)"
                      strokeDasharray={tick === 0 ? '0' : '2,4'}
                    />
                    <text x={pad.l - 10} y={y + 4} textAnchor="end" fontSize="11" fill="var(--ink-3)">
                      {tick}
                    </text>
                  </g>
                );
              }
            )}
            <text x={pad.l} y={h - 10} fontSize="11" fill="var(--ink-3)">
              {t('kesp.agent.aggregateRubric.scoreChart.dateSubmitted')}
            </text>
            {sortedPoints.length > 1 && (
              <polyline
                points={linePoints}
                fill="none"
                stroke="var(--info)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {chartPoints.map(
              /** Handles the callback for this operation. */
              (chartPoint) => (
                <circle
                  key={chartPoint.point.callId + '-' + chartPoint.index}
                  cx={chartPoint.x}
                  cy={chartPoint.y}
                  r={chartPoint.index === hoverIndex ? 6 : 4}
                  fill="var(--bg-elev)"
                  stroke="var(--info)"
                  strokeWidth={chartPoint.index === hoverIndex ? 2.5 : 2}
                >
                  <title>{chartPoint.point.callName + ': ' + chartPoint.point.percent.toFixed(0) + '% (' + chartPoint.point.earned + '/' + chartPoint.point.max + ')'}</title>
                </circle>
              )
            )}
            <rect
              x={pad.l}
              y={pad.t}
              width={plotW}
              height={plotH}
              fill="transparent"
              onPointerMove={handlePointerMove}
              onPointerLeave={/** Handles the onPointerLeave interaction. */() => setHoverIndex(null)}
            />
            {activePoint && activeX != null && activeY != null && (
              <g pointerEvents="none">
                <line x1={activeX} x2={activeX} y1={pad.t} y2={h - pad.b} stroke="var(--line)" strokeDasharray="2,4" />
                <circle cx={activeX} cy={activeY} r="7" fill="var(--bg-elev)" stroke="var(--info)" strokeWidth="2.5" />
              </g>
            )}
          </svg>
          <div className="aggregate-score-chart-active">
            {activePoint ? (
              <>
                <b>{activePoint.callName}</b>
                <span>{t('kesp.agent.aggregateRubric.scoreChart.uploaded')}: {formatKespDate(activePoint.uploadedAt, i18n.resolvedLanguage)}</span>
                <span>{t('kesp.agent.aggregateRubric.scoreChart.processed')}: {formatKespDate(activePoint.processedAt, i18n.resolvedLanguage)}</span>
                <span>{t('kesp.agent.aggregateRubric.scoreChart.scorePercent')}: {activePoint.percent.toFixed(0)}%</span>
                <span>{t('kesp.agent.aggregateRubric.scoreChart.points')}: {activePoint.earned}/{activePoint.max}</span>
              </>
            ) : (
              <span>{t('kesp.agent.aggregateRubric.scoreChart.hoverHint')}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Renders the AggregateCriterionDetailBody component. */
function AggregateCriterionDetailBody({ criterion }: { criterion: AggregateRubricCriterion }) {
  const { t } = useTranslation();
  const usefulPercent = aggregateCriterionUsefulPercent(criterion);
  const isActionable = criterion.priority.priorityBucket === 'priority' || criterion.priority.priorityBucket === 'watch';

  return (
    <>
      <div className="prog-kpi-grid aggregate-rubric-kpis">
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.aggregateRubric.priority.label')}</div>
          <div className="val aggregate-priority-kpi"><AggregatePriorityPill criterion={criterion} /></div>
        </div>
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.aggregateRubric.usefulScore')}</div>
          <div className="val">{usefulPercent.toFixed(0)}<small>%</small></div>
        </div>
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.aggregateRubric.failed')}</div>
          <div className="val">{criterion.priority.failedCallCount}<small>/{criterion.priority.scorableCallCount}</small></div>
        </div>
        <div className="prog-kpi">
          <div className="lbl">{t('kesp.agent.aggregateRubric.detail.trend')}</div>
          <div className="val aggregate-trend-val"><AggregateTrendPill metric={criterion} /></div>
        </div>
      </div>

      {criterion.priority.coverageCallCount > 0 && (
        <div className="card aggregate-detail-section aggregate-coverage-note">
          {t('kesp.agent.aggregateRubric.priority.coverageNote', {
            count: criterion.priority.coverageCallCount,
          })}
        </div>
      )}

      <AggregateCriterionScoreChart points={criterion.points} />

      <AggregateCoachingBrief criterion={criterion} isActionable={isActionable} />
      <AggregateSayExamples criterion={criterion} isActionable={isActionable} />
      <AggregateTrainingPlan criterion={criterion} isActionable={isActionable} />
      <AggregateQuickExamples criterion={criterion} isActionable={isActionable} />
    </>
  );
}

/** Renders the AggregateRubricCriterionPage component. */
export function AggregateRubricCriterionPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ id: string; sectionId: string; groupId: string; criterionId: string }>();
  const { user } = useAuth();
  const agentId = params.id ? decodeURIComponent(params.id) : '';
  const sectionId = params.sectionId ? decodeURIComponent(params.sectionId) : '';
  const groupId = params.groupId ? decodeURIComponent(params.groupId) : '';
  const criterionId = params.criterionId ? decodeURIComponent(params.criterionId) : '';
  const range = useMemo(
    /** Handles the callback for this operation. */
    () => {
      const rangeSessionKey = aggregateRubricRangeSessionKey(agentId);
      return rangeFromSearchParamsOrNull(location.search) ??
        readSessionAggregateRubricRange(rangeSessionKey) ??
        buildDefaultAggregateRubricRange();
    },
    [agentId, location.search]
  );
  const [agent, setAgent] = useState<AgentAnalysis | null>(null);
  const [agentLoading, setAgentLoading] = useState(true);
  const [calls, setCalls] = useState<Call[]>([]);
  const [rows, setRows] = useState([] as Awaited<ReturnType<typeof loadAggregateRubricRows>>);
  const [loadingRows, setLoadingRows] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(
    /** Handles the callback for this operation. */
    () => {
      if (!agentId) {
        Promise.resolve().then(
          /** Handles the callback for this operation. */
          () => {
            setAgent(null);
            setAgentLoading(false);
          }
        );
        return;
      }
      Promise.resolve().then(
        /** Handles the callback for this operation. */
        () => setAgentLoading(true)
      );
      return subscribeToAgentAnalysis(agentId,
        /** Handles the callback for this operation. */
        (nextAgent) => {
          setAgent(nextAgent);
          setAgentLoading(false);
        }
      );
    },
    [agentId]
  );

  useEffect(
    /** Handles the callback for this operation. */
    () => {
      if (!user?.uid || !agent?.salesAgentId) {
        Promise.resolve().then(
          /** Handles the callback for this operation. */
          () => setCalls([])
        );
        return;
      }
      return subscribeToAgentLinkedCalls(
        {
          userId: user.uid,
          agentAnalysisId: agent.id,
          salesAgentId: agent.salesAgentId,
        },
        setCalls
      );
    },
    [agent, user?.uid]
  );

  const sourceCalls = useMemo(
    /** Handles the callback for this operation. */
    () => callsForAggregateRange(calls, range),
    [calls, range]
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
            setLoadingRows(true);
            setLoadError(false);
            const nextRows = await loadAggregateRubricRows(sourceCalls);
            if (!cancelled) setRows(nextRows);
          }
        )
        .catch(
          /** Handles the callback for this operation. */
          (error) => {
            console.error('Failed to load aggregate rubric criterion:', error);
            if (!cancelled) {
              setRows([]);
              setLoadError(true);
            }
          }
        )
        .finally(
          /** Handles the callback for this operation. */
          () => {
            if (!cancelled) setLoadingRows(false);
          }
        );
      return /** Handles the callback for this operation. */ () => {
        cancelled = true;
      };
    },
    [sourceCalls]
  );

  const summary = useMemo(
    /** Handles the callback for this operation. */
    () => buildAggregateRubricSummary(rows, sourceCalls.length),
    [rows, sourceCalls.length]
  );

  const criterion = useMemo(
    /** Handles the callback for this operation. */
    () => findAggregateCriterion(summary, sectionId, groupId, criterionId),
    [criterionId, groupId, sectionId, summary]
  );
  const heroPercent = criterion ? aggregateCriterionUsefulPercent(criterion) : 0;
  const heroScoreColor = criterion ? colorFromPercent(heroPercent) : 'green';

  const backParams = new URLSearchParams({ tab: 'rubrica', start: range.start, end: range.end });
  const backPath = `/kesp/agent/${encodeURIComponent(agentId)}?${backParams.toString()}`;

  if (!user?.uid) {
    return (
      <main className="main main-wide">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.agent.shell.signIn')}</div>
        </div>
      </main>
    );
  }

  if (agentLoading) {
    return (
      <main className="main main-wide">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.agent.shell.loadingAgent')}</div>
        </div>
      </main>
    );
  }

  return (
    <main className="main main-wide aggregate-detail-page">
      <div className="row row-wrap" style={{ marginBottom: 16, gap: 8 }}>
        <button className="linkish row" style={{ gap: 6 }} onClick={/** Handles the onClick interaction. */() => navigate(backPath)}>
          <Icon name="arrowLeft" size={13} /> {t('kesp.agent.aggregateRubric.detail.back')}
        </button>
        <span className="muted">/</span>
        <span className="muted" style={{ fontSize: 12 }}>{formatRangeLabel(range, i18n.resolvedLanguage)}</span>
      </div>

      <div className="criterion-hero card aggregate-detail-hero">
        <div>
          <div className="muted tiny" style={{ textTransform: 'uppercase', letterSpacing: '.10em', marginBottom: 8 }}>
            {agent?.salesAgentName ?? t('kesp.common.notAvailable')} · {sectionId} · {groupId}
          </div>
          <h1>{criterion ? `${criterion.id}. ${criterion.title}` : t('kesp.agent.aggregateRubric.detail.notFoundTitle')}</h1>
          <div className="row row-wrap" style={{ gap: 8 }}>
            <Pill kind="default">{formatRangeLabel(range, i18n.resolvedLanguage)}</Pill>
            <Pill kind="default">{t('kesp.agent.aggregateRubric.callsAnalyzed', { count: criterion?.coveredCallCount ?? 0 })}</Pill>
            {criterion && <AggregatePriorityPill criterion={criterion} />}
          </div>
        </div>
        {criterion && (
          <div className={`criterion-score ${heroScoreColor}`}>
            {heroPercent.toFixed(0)}
            <span>%</span>
          </div>
        )}
      </div>

      {loadError && <div className="card muted small">{t('kesp.agent.aggregateRubric.loadError')}</div>}
      {loadingRows && <div className="card muted small">{t('kesp.agent.aggregateRubric.loading')}</div>}
      {!loadingRows && !criterion && (
        <div className="card aggregate-empty">
          <h3>{t('kesp.agent.aggregateRubric.detail.notFoundTitle')}</h3>
          <p>{t('kesp.agent.aggregateRubric.detail.notFoundBody')}</p>
        </div>
      )}
      {!loadingRows && criterion && <AggregateCriterionDetailBody criterion={criterion} />}
    </main>
  );
}
