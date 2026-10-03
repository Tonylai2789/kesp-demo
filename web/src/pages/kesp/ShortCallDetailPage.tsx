import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchCall, fetchShortCallReview, fetchTranscript } from '@/services/firestore';
import { Button, Pill } from '@/components/kesp/primitives';
import { Icon } from '@/components/kesp/icons';
import { fmtDur } from '@/components/kesp/format';
import { AudioPlayerDialog } from '@/components/audio';
import { getReturnToFromSearch } from '@/lib/returnTo';
import { formatKespDate } from '@/lib/kespI18n';
import { callBusinessDate } from '@/lib/callDates';
import {
  maskKespDemoAgentDisplayName,
  maskKespDemoCallDisplayName,
  maskKespDemoEvidenceText,
  maskKespDemoTranscriptText,
} from '@/lib/kespDemoRedaction';
import { useKespDemoRedactionEnabled } from '@/hooks/useKespDemoRedactionEnabled';
import type { Call, ManualShortCallEvidenceItem, ManualShortCallReview, Transcript } from '@/types';
import { hasShortCallQualityScorecard } from '@/types';

/** Documents the evidenceTimeLabel behavior. */
function evidenceTimeLabel(item: ManualShortCallEvidenceItem): string | null {
  if (typeof item.start_seconds !== 'number') return null;
  const start = fmtDur(Math.round(item.start_seconds));
  const end = typeof item.end_seconds === 'number' ? fmtDur(Math.round(item.end_seconds)) : null;
  return end ? `${start}-${end}` : start;
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

function qualityStatusPillKind(status: string): 'good' | 'warn' | 'bad' | 'default' {
  if (status === 'met') return 'good';
  if (status === 'partial') return 'warn';
  if (status === 'missed') return 'bad';
  return 'default';
}

/** Renders the ShortCallDetailPage component. */
export function ShortCallDetailPage() {
  const { t, i18n } = useTranslation();
  const demoMode = useKespDemoRedactionEnabled();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ id: string }>();
  const callId = params.id ? decodeURIComponent(params.id) : '';
  const [call, setCall] = useState<Call | null>(null);
  const [review, setReview] = useState<ManualShortCallReview | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(true);
  const [audioOpen, setAudioOpen] = useState(false);
  const returnTo = getReturnToFromSearch(location.search);
  const backPath = returnTo ?? '/kesp/short-calls';

  useEffect(/** Handles the callback for this operation. */() => {
    if (!callId) return;
    let cancelled = false;
    Promise.all([fetchCall(callId), fetchShortCallReview(callId), fetchTranscript(callId)])
      .then(/** Handles the callback for this operation. */([nextCall, nextReview, nextTranscript]) => {
        if (cancelled) return;
        setCall(nextCall);
        setReview(nextReview);
        setTranscript(nextTranscript);
      })
      .finally(/** Handles the callback for this operation. */() => {
        if (!cancelled) setLoading(false);
      });
    return /** Handles the callback for this operation. */() => {
      cancelled = true;
    };
  }, [callId]);

  if (loading) {
    return <main className="main main-wide"><div className="card muted" style={{ padding: 32 }}>{t('kesp.shortCalls.loading')}</div></main>;
  }

  if (!call) {
    return <main className="main main-wide"><div className="card muted" style={{ padding: 32 }}>{t('kesp.callDetail.callNotFound', { id: callId })}</div></main>;
  }

  const segments = transcript?.segments ?? [];
  const callDisplayName = demoMode
    ? maskKespDemoCallDisplayName(call.displayName ?? call.name ?? call.originalFilename ?? call.id)
    : call.displayName ?? call.name ?? call.originalFilename ?? call.id;
  const agentDisplayName = demoMode
    ? maskKespDemoAgentDisplayName(call.salesAgentName, call.canonicalSalesAgentId ?? call.salesAgentId)
    : call.salesAgentName;
  const hasQualityScorecard = hasShortCallQualityScorecard(review);

  return (
    <main className="main main-wide">
      <div className="row row-between row-wrap" style={{ marginBottom: 16, gap: 10 }}>
        <button className="linkish row" style={{ gap: 6 }} onClick={/** Handles the onClick interaction. */() => navigate(backPath)}>
          <Icon name="arrowLeft" size={13} /> {t('kesp.shortCalls.back')}
        </button>
        <Button kind="ghost" size="sm" icon={<Icon name="speaker" size={13} />} disabled={!call.audioPath} onClick={/** Handles the onClick interaction. */() => setAudioOpen(true)}>
          {t('kesp.callDetail.listenCall')}
        </Button>
      </div>

      <AudioPlayerDialog open={audioOpen} onOpenChange={setAudioOpen} audioPath={call.audioPath} audioUrl={call.audioUrl} callId={call.id} />

      <div className="score-hero" style={{ marginBottom: 18 }}>
        <div>
          <div className="label-row">
            <Pill kind="info">{t('kesp.shortCalls.queue.threshold')}</Pill>
            <Pill kind={review ? 'good' : 'warn'}>{call.shortCallReviewStatus ?? call.status}</Pill>
            {typeof call.duration === 'number' && <span><b>{fmtDur(Math.round(call.duration))}</b> {t('kesp.callDetail.duration')}</span>}
            <span><b>{formatKespDate(callBusinessDate(call), i18n.resolvedLanguage)}</b></span>
          </div>
          <div className="name">{callDisplayName}</div>
          <div className="muted small">{agentDisplayName ?? t('kesp.common.agentFallback')}</div>
        </div>
      </div>

      {!review ? (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3 className="card-h">{t('kesp.shortCalls.detail.pendingTitle')}</h3>
          <p className="muted small">{t('kesp.shortCalls.detail.pendingBody')}</p>
        </div>
      ) : (
        <>
          <div className="grid-3" style={{ marginBottom: 18 }}>
            <div className="card"><div className="muted tiny">{t('kesp.shortCalls.detail.contact')}</div><h3>{t(`kesp.shortCalls.contactStatus.${review.contactStatus}`)}</h3></div>
            <div className="card"><div className="muted tiny">{t('kesp.shortCalls.detail.reason')}</div><h3>{t(`kesp.shortCalls.quickEndReason.${review.quickEndReason}`)}</h3></div>
            <div className="card"><div className="muted tiny">{t('kesp.shortCalls.detail.confidence')}</div><h3>{Math.round(review.confidenceScore * 100)}%</h3></div>
          </div>



          {hasQualityScorecard && review.qualityScorecard && (
            <>
              <div className="grid-3" style={{ marginBottom: 18 }}>
                <div className="card">
                  <div className="muted tiny">{t('kesp.shortCalls.quality.score')}</div>
                  <h3>{formatQualityScore(review.qualityScore, t('kesp.shortCalls.quality.noScore'))}</h3>
                  <Pill kind={qualityPillKind(review.qualityScore)}>{t(`kesp.shortCalls.qualityBand.${review.qualityBand}`)}</Pill>
                </div>
                <div className="card">
                  <div className="muted tiny">{t('kesp.shortCalls.quality.durationBucket')}</div>
                  <h3>{t(`kesp.shortCalls.durationBucket.${review.durationBucket}`)}</h3>
                  <div className="muted small">{t(`kesp.shortCalls.evaluableDepth.${review.evaluableDepth}`)}</div>
                </div>
                <div className="card">
                  <div className="muted tiny">{t('kesp.shortCalls.quality.scorableWeight')}</div>
                  <h3>{Math.round(review.qualityScorecard.scorableWeightPercent)}%</h3>
                  {review.qualityScorecard.lowConfidence && <Pill kind="warn">{t('kesp.shortCalls.quality.lowConfidence')}</Pill>}
                </div>
              </div>

              <div className="card" style={{ marginBottom: 18 }}>
                <h3 className="card-h">{t('kesp.shortCalls.quality.scorecard')}</h3>
                <div className="kesp-table-list">
                  {review.qualityScorecard.criteria.map((criterion) => (
                    <div key={criterion.id} className="kesp-table-row" style={{ cursor: 'default' }}>
                      <span>
                        <b>{criterion.id} · {criterion.label}</b>
                        <span className="muted small" style={{ display: 'block' }}>{criterion.rationale}</span>
                      </span>
                      <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <span className="muted small">{Math.round(criterion.earnedPoints * 10) / 10}/{criterion.maxPoints}</span>
                        <Pill kind={qualityStatusPillKind(criterion.status)}>{t(`kesp.shortCalls.qualityStatus.${criterion.status}`)}</Pill>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="card" style={{ marginBottom: 18 }}>
            <h3 className="card-h">{t('kesp.shortCalls.detail.agentConcern')}</h3>
            <Pill kind={review.agentConcern === 'none' ? 'good' : 'warn'}>{t(`kesp.shortCalls.agentConcern.${review.agentConcern}`)}</Pill>
            <p>{review.agentConcernSummary}</p>
            {review.agentConcernEvidence.length === 0 ? (
              <p className="muted small">{t('kesp.shortCalls.detail.noEvidence')}</p>
            ) : review.agentConcernEvidence.map((item, index) => (
              <blockquote key={`${item.quote}-${index}`} className="followup-msg" style={{ marginTop: 12 }}>
                <div className="label">{item.speaker_display ?? item.speaker_label ?? t('kesp.callDetail.transcript.unknownSpeaker')} {evidenceTimeLabel(item) ? `- ${evidenceTimeLabel(item)}` : ''}</div>
                {demoMode ? maskKespDemoEvidenceText() : item.quote}
              </blockquote>
            ))}
          </div>

          <div className="card" style={{ marginBottom: 18 }}>
            <h3 className="card-h">{t('kesp.shortCalls.detail.startRubric')}</h3>
            <div className="kesp-table-list">
              {review.startCallRubricChecks.map((check) => (
                <div key={check.id} className="kesp-table-row" style={{ cursor: 'default' }}>
                  <span><b>{check.label}</b><span className="muted small" style={{ display: 'block' }}>{check.rationale}</span></span>
                  <Pill kind={check.status === 'met' ? 'good' : check.status === 'missed' ? 'bad' : 'default'}>{t(`kesp.shortCalls.rubricStatus.${check.status}`)}</Pill>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="card">
        <h3 className="card-h">{t('kesp.callDetail.transcript.title')}</h3>
        {segments.length === 0 ? (
          <p className="muted small">{transcript?.text ? (demoMode ? maskKespDemoTranscriptText() : transcript.text) : t('kesp.callDetail.noTranscript')}</p>
        ) : segments.map((segment) => (
          <div key={segment.id ?? `${segment.start}-${segment.end}`} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
            <div className="muted tiny">{t('kesp.callDetail.transcript.speaker', { speaker: segment.speaker })} · {fmtDur(Math.round(segment.start))}</div>
            <div>{demoMode ? maskKespDemoTranscriptText() : segment.text}</div>
          </div>
        ))}
      </div>
    </main>
  );
}
