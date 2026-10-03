import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { fetchShortCallReview } from '@/services/firestore';
import { Pill } from '@/components/kesp/primitives';
import { fmtDur } from '@/components/kesp/format';
import { appendReturnTo } from '@/lib/returnTo';
import { formatKespDate } from '@/lib/kespI18n';
import { callBusinessDate } from '@/lib/callDates';
import type { Call, ManualShortCallReview } from '@/types';
import { hasShortCallQualityScorecard } from '@/types';

interface ShortCallReviewPanelProps {
  calls: Call[];
  loading: boolean;
  currentPath: string;
  eyebrow?: string;
  title?: string;
  description?: string;
  action?: ReactNode;
  emptyText?: string;
}

type ReviewMap = Record<string, ManualShortCallReview | null>;

function countTotal(counts: Record<string, number> | undefined): number {
  return Object.values(counts ?? {}).reduce((sum, value) => sum + value, 0);
}

function increment(counts: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  counts[key] = (counts[key] ?? 0) + 1;
}

function topEntries(counts: Record<string, number> | undefined): Array<[string, number]> {
  return Object.entries(counts ?? {}).sort((left, right) => right[1] - left[1]).slice(0, 4);
}


function formatQualityScore(score: number | null | undefined, fallback: string): string {
  return typeof score === 'number' && Number.isFinite(score) ? String(Math.round(score)) : fallback;
}

function qualityPillKind(score: number | null | undefined): 'good' | 'warn' | 'bad' | 'default' {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'default';
  if (score >= 80) return 'good';
  if (score >= 60) return 'warn';
  return 'bad';
}

function sourceLabel(call: Call, t: TFunction): string {
  if (call.shortCallReviewSource === 'automatic_ccc_gcs' || call.callSource === 'ccc_gcs') {
    return t('kesp.shortCalls.sources.automatic');
  }
  return t('kesp.shortCalls.sources.manual');
}

export function ShortCallReviewPanel({
  calls,
  loading,
  currentPath,
  eyebrow,
  title,
  description,
  action,
  emptyText,
}: ShortCallReviewPanelProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [reviewsByCallId, setReviewsByCallId] = useState<ReviewMap>({});

  useEffect(() => {
    if (calls.length === 0) return;

    let cancelled = false;
    Promise.all(
      calls.map(async (call) => {
        try {
          return [call.id, await fetchShortCallReview(call.id)] as const;
        } catch (error) {
          console.error('Failed to load short-call review:', call.id, error);
          return [call.id, null] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setReviewsByCallId(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [calls]);

  const summary = useMemo(() => {
    const quickEndReasonCounts: Record<string, number> = {};
    const agentConcernCounts: Record<string, number> = {};
    const qualityBandCounts: Record<string, number> = {};
    let qualityScoreTotal = 0;
    let scoredShortCalls = 0;
    const byAgent = new Map<string, { salesAgentName: string; totalShortCalls: number }>();

    calls.forEach((call) => {
      const salesAgentId = call.salesAgentId ?? call.matchedAgentAnalysisId ?? call.id;
      const agent = byAgent.get(salesAgentId) ?? {
        salesAgentName: call.salesAgentName ?? call.matchedAgentName ?? t('kesp.common.agentFallback'),
        totalShortCalls: 0,
      };
      agent.totalShortCalls += 1;
      byAgent.set(salesAgentId, agent);

      const review = reviewsByCallId[call.id];
      if (!review) return;
      increment(quickEndReasonCounts, review.quickEndReason);
      increment(agentConcernCounts, review.agentConcern);
      if (hasShortCallQualityScorecard(review)) {
        increment(qualityBandCounts, review.qualityBand);
        if (typeof review.qualityScore === 'number' && Number.isFinite(review.qualityScore)) {
          scoredShortCalls += 1;
          qualityScoreTotal += review.qualityScore;
        }
      }
    });

    return {
      completedCount: calls.filter((call) => call.shortCallReviewStatus === 'complete').length,
      reviewedCount: calls.filter((call) => reviewsByCallId[call.id] != null).length,
      quickEndReasonCounts,
      agentConcernCounts,
      qualityBandCounts,
      scoredShortCalls,
      averageQualityScore: scoredShortCalls > 0 ? qualityScoreTotal / scoredShortCalls : null,
      agentStats: Array.from(byAgent.values())
        .sort((left, right) => right.totalShortCalls - left.totalShortCalls)
        .slice(0, 5),
    };
  }, [calls, reviewsByCallId, t]);

  return (
    <>
      {(title || eyebrow || description || action) && (
        <div className="row row-between row-wrap" style={{ gap: 12, marginBottom: 18 }}>
          <div>
            {eyebrow && (
              <div className="muted tiny" style={{ textTransform: 'uppercase', letterSpacing: '.08em' }}>
                {eyebrow}
              </div>
            )}
            {title && <h1 style={{ margin: '4px 0 4px' }}>{title}</h1>}
            {description && <p className="muted" style={{ margin: 0 }}>{description}</p>}
          </div>
          {action}
        </div>
      )}

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi-card">
          <div className="kpi-label">{t('kesp.shortCalls.kpis.total')}</div>
          <div className="kpi-value">{calls.length}</div>
          <div className="kpi-sub">{t('kesp.shortCalls.kpis.completed', { count: summary.completedCount })}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">{t('kesp.shortCalls.kpis.agents')}</div>
          <div className="kpi-value">{summary.agentStats.length}</div>
          <div className="kpi-sub">{t('kesp.shortCalls.kpis.reviewed', { count: summary.reviewedCount })}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">{t('kesp.shortCalls.kpis.concerns')}</div>
          <div className="kpi-value">{countTotal(summary.agentConcernCounts)}</div>
          <div className="kpi-sub">{t('kesp.shortCalls.kpis.concernsSub')}</div>
        </div>
        {summary.scoredShortCalls > 0 && (
          <div className="kpi-card">
            <div className="kpi-label">{t('kesp.shortCalls.kpis.qualityScore')}</div>
            <div className="kpi-value">{formatQualityScore(summary.averageQualityScore, t('kesp.common.notAvailable'))}</div>
            <div className="kpi-sub">{t('kesp.shortCalls.kpis.scored', { count: summary.scoredShortCalls })}</div>
          </div>
        )}
      </div>

      <div className="grid-2" style={{ marginBottom: 18 }}>
        <div className="card">
          <h3 className="card-h">{t('kesp.shortCalls.patterns.reasonMix')}</h3>
          {topEntries(summary.quickEndReasonCounts).length === 0 ? (
            <p className="muted small">{t('kesp.shortCalls.emptyPattern')}</p>
          ) : topEntries(summary.quickEndReasonCounts).map(([key, value]) => (
            <div key={key} className="row row-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <span>{t(`kesp.shortCalls.quickEndReason.${key}`)}</span>
              <b>{value}</b>
            </div>
          ))}
        </div>
        <div className="card">
          <h3 className="card-h">{t('kesp.shortCalls.patterns.agentConcentration')}</h3>
          {summary.agentStats.length === 0 ? (
            <p className="muted small">{t('kesp.shortCalls.emptyPattern')}</p>
          ) : summary.agentStats.map((agent) => (
            <div key={agent.salesAgentName} className="row row-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <span>{agent.salesAgentName}</span>
              <b>{agent.totalShortCalls}</b>
            </div>
          ))}
        </div>
      </div>

      {topEntries(summary.qualityBandCounts).length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3 className="card-h">{t('kesp.shortCalls.patterns.qualityBands')}</h3>
          {topEntries(summary.qualityBandCounts).map(([key, value]) => (
            <div key={key} className="row row-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <span>{t(`kesp.shortCalls.qualityBand.${key}`)}</span>
              <b>{value}</b>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="short-call-queue-header">
          <h3 className="card-h" style={{ margin: 0 }}>{t('kesp.shortCalls.queue.title')}</h3>
          <Pill kind="info">{t('kesp.shortCalls.queue.threshold')}</Pill>
        </div>
        {loading ? (
          <div className="short-call-queue-state muted">{t('kesp.shortCalls.loading')}</div>
        ) : calls.length === 0 ? (
          <div className="short-call-queue-state muted">{emptyText ?? t('kesp.shortCalls.empty')}</div>
        ) : (
          <div className="short-call-queue">
            {calls.map((call) => (
              <button
                key={call.id}
                type="button"
                className="short-call-row"
                onClick={() => navigate(appendReturnTo(`/kesp/short-calls/${encodeURIComponent(call.id)}`, currentPath))}
              >
                <span className="short-call-row-main">
                  <b>{call.displayName ?? call.name ?? call.originalFilename ?? call.id}</b>
                  <span className="short-call-row-subtitle">
                    {call.salesAgentName ?? t('kesp.common.agentFallback')} · {sourceLabel(call, t)}
                  </span>
                </span>
                <span className="short-call-row-meta">
                  <span>{t('kesp.callDetail.duration')}</span>
                  <b>{typeof call.duration === 'number' ? fmtDur(Math.round(call.duration)) : t('kesp.common.notAvailable')}</b>
                </span>
                <span className="short-call-row-actions">
                  {hasShortCallQualityScorecard(reviewsByCallId[call.id]) && (
                    <Pill kind={qualityPillKind(reviewsByCallId[call.id]?.qualityScore)}>
                      {formatQualityScore(reviewsByCallId[call.id]?.qualityScore, t('kesp.shortCalls.quality.noScore'))}
                    </Pill>
                  )}
                  <Pill kind={call.shortCallReviewStatus === 'complete' ? 'good' : call.shortCallReviewStatus === 'error' ? 'bad' : 'warn'}>
                    {call.shortCallReviewStatus ?? call.status}
                  </Pill>
                </span>
                <span className="short-call-row-meta short-call-row-date">
                  <span>{t('kesp.shortCalls.queue.created')}</span>
                  <b>{formatKespDate(callBusinessDate(call), i18n.resolvedLanguage, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</b>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
