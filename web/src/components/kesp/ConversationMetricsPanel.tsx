import { useEffect, useRef, useState } from 'react';
import { Play, RefreshCw, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getKespLocale } from '@/lib/kespI18n';
import { maskKespDemoTranscriptText } from '@/lib/kespDemoRedaction';
import { useKespDemoRedactionEnabled } from '@/hooks/useKespDemoRedactionEnabled';
import {
  getConversationMetrics,
  getGeminiAudioReview,
  requestGeminiAudioReview,
  type ConversationMetricEvent,
  type ConversationMetricSegment,
  type ConversationMetricsResponse,
  type GeminiAudioReviewEvidence,
  type GeminiAudioReviewResponse,
  type GeminiAudioReviewStatus,
} from '@/services/functions';
import './ConversationMetricsPanel.css';
import { ConversationMetricsHelp } from './ConversationMetricsHelp';

// Match this backend compatibility marker explicitly; never render arbitrary diagnostic strings.
const CACHED_SOURCE_LIMITATION = 'Cached source lacks authoritative speaker-role and unadjusted score evidence; cached feedback is preserved and no new speed deduction is applied.';

interface ConversationMetricsPanelProps {
  callId: string;
  audioAvailable: boolean;
  geminiReviewAvailable: boolean;
  canRequestGeminiReview: boolean;
  onPlayEvidence: (evidence: ConversationMetricEvent) => void;
}

const GEMINI_PENDING_STATUSES: GeminiAudioReviewStatus[] = ['queued', 'running'];
const GEMINI_TERMINAL_STATUSES: GeminiAudioReviewStatus[] = ['complete', 'failed', 'unavailable'];
const GEMINI_MAX_POLL_READS = 18;
const GEMINI_POLL_DELAY_MS = 30000;

interface GeminiRequestIntent {
  regenerate: boolean;
  requestId: string;
  statusAtConfirmation: GeminiAudioReviewStatus | null;
}

/** Formats an original recording timestamp without changing evidence precision. */
function evidenceTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Keeps backend error strings bounded before showing them as safe operational context. */
function safeGeminiError(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/\s+/g, ' ').trim().slice(0, 160) || null;
}

/** Adapts Gemini evidence to the existing transcript selection contract without adding playback behavior. */
function geminiEvidenceToMetricEvent(evidence: GeminiAudioReviewEvidence): ConversationMetricEvent {
  return {
    id: evidence.id,
    start: evidence.start,
    end: evidence.end,
    text: evidence.text,
    role: evidence.role,
  };
}

/** Creates the backend-deduplication key after the admin accepts the paid request prompt. */
function createGeminiRequestId(): string {
  return crypto.randomUUID();
}

/** Checks timestamp overlap without comparing evidence IDs from different namespaces. */
function evidenceOverlaps(left: Pick<ConversationMetricEvent, 'start' | 'end'>, right: Pick<GeminiAudioReviewEvidence, 'start' | 'end'>): boolean {
  return Number.isFinite(left.start) && Number.isFinite(left.end) && Number.isFinite(right.start) && Number.isFinite(right.end) &&
    Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

/** Suppresses only old interruption interpretations when a Gemini turn-taking review covers the same time span. */
function shouldHideLegacyInterruptionObservation(
  observation: { category?: string; evidenceIds: string[] },
  interruptionEvidence: ConversationMetricEvent[],
  geminiResponse: GeminiAudioReviewResponse | null
): boolean {
  if (observation.category !== 'interruption_candidate') return false;
  const review = geminiResponse?.review;
  if (review?.status !== 'complete') return false;
  const turnTakingEvidence = review.observations
    .filter(/** Uses only Gemini turn-taking observations for legacy interruption suppression. */ (item) => item.category === 'turn_taking')
    .flatMap(/** Resolves Gemini evidence rows referenced by the observation. */ (item) => item.evidenceIds)
    .map(/** Finds returned Gemini evidence by id without crossing namespaces. */ (id) => review.evidence.find((evidence) => evidence.id === id))
    .filter(/** Keeps only valid evidence rows. */ (item): item is GeminiAudioReviewEvidence => Boolean(item));
  if (turnTakingEvidence.length === 0) return false;
  return observation.evidenceIds.some(/** Resolves old metric evidence and suppresses only overlapping interruption candidates. */ (id) => {
    const metricEvidence = interruptionEvidence.find((item) => item.id === id || item.evidenceIds?.includes(id));
    if (!metricEvidence) return false;
    return turnTakingEvidence.some((geminiEvidence) => evidenceOverlaps(metricEvidence, geminiEvidence));
  });
}

/** Renders restricted, read-only metrics in the existing call detail page. */
export function ConversationMetricsPanel({ callId, audioAvailable, geminiReviewAvailable, canRequestGeminiReview, onPlayEvidence }: ConversationMetricsPanelProps) {
  const { t, i18n } = useTranslation();
  const demoMode = useKespDemoRedactionEnabled();
  const [response, setResponse] = useState<ConversationMetricsResponse | null>(null);
  const [geminiResponse, setGeminiResponse] = useState<GeminiAudioReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [geminiLoading, setGeminiLoading] = useState(true);
  const [error, setError] = useState(false);
  const [geminiError, setGeminiError] = useState<string | null>(null);
  const [geminiRequesting, setGeminiRequesting] = useState(false);
  const [reload, setReload] = useState(0);
  const [geminiReload, setGeminiReload] = useState(0);
  const [geminiPollReads, setGeminiPollReads] = useState(0);
  const geminiRequestIntentRef = useRef<GeminiRequestIntent | null>(null);

  useEffect(/** Loads only through the authorized callable and ignores obsolete responses. */ () => {
    let canceled = false;
    /** Calls the restricted Firebase callable, not a shared feedback document. */
    getConversationMetrics({ callId })
      .then(/** Publishes the response only for the mounted call. */ (result) => {
        if (!canceled) setResponse(result);
      })
      .catch(/** Clears restricted data if access is revoked or the request fails. */ () => {
        if (!canceled) {
          setResponse(null);
          setError(true);
        }
      })
      .finally(/** Ends the request indicator without updating an unmounted panel. */ () => {
        if (!canceled) setLoading(false);
      });
    return /** Prevents stale call data from being displayed after navigation. */ () => { canceled = true; };
  }, [callId, reload]);

  useEffect(/** Loads Gemini review state through a side-effect-free callable. */ () => {
    if (!geminiReviewAvailable) {
      setGeminiResponse(null);
      setGeminiLoading(false);
      setGeminiError(null);
      return;
    }
    let canceled = false;
    setGeminiLoading(true);
    setGeminiError(null);
    /** Calls the restricted read callable; this must not generate or regenerate a review. */
    getGeminiAudioReview({ callId })
      .then(/** Stores the returned gate/review state for this call only. */ (result) => {
        if (!canceled) setGeminiResponse(result);
      })
      .catch(/** Keeps callable failure generic and retryable from the UI. */ () => {
        if (!canceled) {
          setGeminiResponse(null);
          setGeminiError(t('kesp.conversationMetrics.gemini.readError'));
        }
      })
      .finally(/** Ends the read indicator without mutating unmounted state. */ () => {
        if (!canceled) setGeminiLoading(false);
      });
    return /** Prevents stale review data from being displayed after navigation. */ () => { canceled = true; };
  }, [callId, geminiReload, geminiReviewAvailable, t]);

  useEffect(/** Polls only while the backend says a review is pending, then stops at terminal or bounded reads. */ () => {
    const status = geminiResponse?.review?.status;
    if (!status || !GEMINI_PENDING_STATUSES.includes(status) || geminiPollReads >= GEMINI_MAX_POLL_READS) return;
    const timer = window.setTimeout(
      /** Schedules one read-only refresh of pending review state. */
      () => {
        setGeminiPollReads(geminiPollReads + 1);
        setGeminiReload((value) => value + 1);
      },
      GEMINI_POLL_DELAY_MS
    );
    return /** Cancels the pending read refresh when status changes or the panel unmounts. */ () => window.clearTimeout(timer);
  }, [geminiPollReads, geminiResponse?.review?.status]);

  useEffect(/** Clears the explicit request id only after the backend reaches a terminal state for the confirmed intent. */ () => {
    const status = geminiResponse?.review?.status;
    const intent = geminiRequestIntentRef.current;
    if (!intent || !status || !GEMINI_TERMINAL_STATUSES.includes(status) || status === intent.statusAtConfirmation) return;
    geminiRequestIntentRef.current = null;
  }, [geminiResponse?.review?.status]);

  const locale = getKespLocale(i18n.resolvedLanguage);
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const credits = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
  /** Displays unavailable measurements as unavailable, never as zero. */
  function number(value: number | null | undefined, precise = false): string {
    return typeof value === 'number' && Number.isFinite(value)
      ? (precise ? credits : numbers).format(value) : t('kesp.common.notAvailable');
  }
  /** Applies the existing demo redaction policy without translating stored evidence. */
  function evidenceText(text: string): string {
    return demoMode ? maskKespDemoTranscriptText() : text;
  }
  /** Reuses the page's audio dialog and transcript selection for original timestamps. */
  function playButton(event: ConversationMetricEvent) {
    const valid = Number.isFinite(event.start) && Number.isFinite(event.end) && event.start >= 0 && event.end >= event.start;
    const label = t(providerSegmentTiming && event.kind ? 'kesp.conversationMetrics.playSegmentEvidence' : 'kesp.conversationMetrics.playEvidence', { time: valid ? evidenceTime(event.start) : t('kesp.common.notAvailable') });
    return (
      <button type="button" className="cm-play" title={label} aria-label={label}
        disabled={!audioAvailable || !valid}
        onClick={/** Opens the existing player at this evidence timestamp. */ () => onPlayEvidence(event)}>
        <Play size={15} aria-hidden="true" />
      </button>
    );
  }
  /** Renders a bounded-height, expandable evidence list without reviewer controls. */
  function eventList(kind: 'interruptions' | 'gaps' | 'fillers', events: ConversationMetricEvent[]) {
    const available = report?.availability[kind].available;
    const emptyMessage = retainedTimingReport && (report?.evidenceTotals?.[kind] ?? 0) > 0
      ? 'noEventsShown' : hasTimingExclusions ? 'noRetainedCandidates' : 'noCandidates';
    return (
      <details className="cm-details">
        <summary>{t(`kesp.conversationMetrics.${kind}`)} <span className="muted">({available || events.length > 0
          ? t('kesp.conversationMetrics.shownCount', { shown: number(events.length), total: number(report?.evidenceTotals?.[kind] ?? events.length) })
          : t('kesp.common.notAvailable')})</span></summary>
        {kind === 'interruptions' && <p className="muted small">{t(providerSegmentTiming ? 'kesp.conversationMetrics.segmentInterruptionsUnavailable' : 'kesp.conversationMetrics.interruptionCaution')}</p>}
        {kind === 'gaps' && <p className="muted small">{t('kesp.conversationMetrics.gapCaution')}</p>}
        {kind === 'fillers' && <p className="muted small">{t('kesp.conversationMetrics.fillerCaution')}</p>}
        {kind === 'fillers' && providerSegmentTiming && <p className="muted small">{t('kesp.conversationMetrics.segmentLexicalEvidence')}</p>}
        {!available && <p className="muted small">{t('kesp.conversationMetrics.featureUnavailable')}</p>}
        {(available || retainedTimingReport) && (events.length === 0 ? available && (
          <p className="muted small">{t(`kesp.conversationMetrics.${emptyMessage}`)}</p>
        ) : (
          <ul className="cm-evidence-list">
            {events.map(/** Renders stored event evidence and its original timestamp. */ (event) => (
              <li key={event.id}>
                {playButton(event)}
                <div>
                  <div className="cm-segment-head">
                    <span className="cm-time">{evidenceTime(event.start)} - {evidenceTime(event.end)}</span>
                    {(event.category || event.kind) && <span>{t(`kesp.conversationMetrics.eventKind.${event.category || event.kind}`)}</span>}
                    {event.role && <span>{t(`kesp.conversationMetrics.speaker.${event.role}`)}</span>}
                    {typeof event.seconds === 'number' && <span>{number(event.seconds)} {t('kesp.conversationMetrics.units.seconds')}</span>}
                    {typeof event.duration === 'number' && <span>{number(event.duration)} {t('kesp.conversationMetrics.units.seconds')}</span>}
                  </div>
                  <p>{evidenceText(event.text)}{event.textTruncated && <span className="muted"> ({t('kesp.conversationMetrics.excerpt')})</span>}</p>
                </div>
              </li>
            ))}
          </ul>
        ))}
      </details>
    );
  }
  /** Requests Gemini generation only after an explicit admin action and any regeneration cost confirmation. */
  async function handleGeminiRequest(regenerate: boolean) {
    if (!canRequestGeminiReview || !geminiResponse?.enabled || !geminiResponse.privacyApproved) return;
    const confirmed = window.confirm(t(regenerate
      ? 'kesp.conversationMetrics.gemini.regenerateConfirm'
      : 'kesp.conversationMetrics.gemini.generateConfirm'));
    if (!confirmed) return;
    const currentStatus = geminiResponse.review?.status ?? null;
    const currentIntent = geminiRequestIntentRef.current;
    const requestId = currentIntent && currentIntent.regenerate === regenerate && currentIntent.statusAtConfirmation === currentStatus
      ? currentIntent.requestId
      : createGeminiRequestId();
    geminiRequestIntentRef.current = { regenerate, requestId, statusAtConfirmation: currentStatus };
    setGeminiRequesting(true);
    setGeminiError(null);
    try {
      /** Calls Firebase Functions to request paid Gemini work after server-side authorization and gates. */
      await requestGeminiAudioReview({ callId, requestId, regenerate, authCostConfirmed: true });
      geminiRequestIntentRef.current = null;
      setGeminiPollReads(0);
      setGeminiReload((value) => value + 1);
    } catch {
      setGeminiError(t('kesp.conversationMetrics.gemini.requestError'));
    } finally {
      setGeminiRequesting(false);
    }
  }

  /** Renders the qualitative Gemini review while preserving deterministic metrics separately. */
  function geminiReviewPanel() {
    if (!geminiReviewAvailable) return null;
    const review = geminiResponse?.review ?? null;
    const status = review?.status ?? null;
    const pendingReview = status ? GEMINI_PENDING_STATUSES.includes(status) : false;
    const terminalReview = status ? GEMINI_TERMINAL_STATUSES.includes(status) : false;
    const canRequest = canRequestGeminiReview && geminiResponse?.enabled === true && geminiResponse.privacyApproved === true && !geminiRequesting;
    const showGenerate = canRequest && !review;
    const showRetry = canRequest && (status === 'failed' || status === 'unavailable');
    const showRegenerate = canRequest && status === 'complete';
    const safeError = safeGeminiError(review?.reason ?? review?.error ?? geminiResponse?.error ?? undefined);
    const evidenceById = new Map((review?.evidence ?? []).map(/** Indexes server-bounded evidence by id only. */ (item) => [item.id, item]));
    return (
      <div className="cm-gemini" data-status={status ?? 'none'}>
        <div className="cm-gemini-head">
          <div>
            <h4>{t('kesp.conversationMetrics.gemini.title')}</h4>
          </div>
          <div className="cm-header-actions">
            <button type="button" className="cm-play" disabled={geminiLoading || geminiRequesting}
              title={t('kesp.conversationMetrics.gemini.refresh')} aria-label={t('kesp.conversationMetrics.gemini.refresh')}
              onClick={/** Refreshes saved Gemini state without running inference. */ () => {
                setGeminiPollReads(0);
                setGeminiReload((value) => value + 1);
              }}>
              <RefreshCw size={16} aria-hidden="true" />
            </button>
            {showGenerate && <button type="button" className="cm-action" disabled={geminiRequesting}
              onClick={/** Requests first-time Gemini review only from an explicit admin click. */ () => void handleGeminiRequest(false)}>
              <Wand2 size={15} aria-hidden="true" /> {geminiRequesting ? t('kesp.conversationMetrics.gemini.requesting') : t('kesp.conversationMetrics.gemini.analyze')}
            </button>}
            {showRetry && <button type="button" className="cm-action" disabled={geminiRequesting}
              onClick={/** Retries terminal paid review states through the regeneration path. */ () => void handleGeminiRequest(true)}>
              <Wand2 size={15} aria-hidden="true" /> {geminiRequesting ? t('kesp.conversationMetrics.gemini.requesting') : t('kesp.conversationMetrics.gemini.retry')}
            </button>}
            {showRegenerate && <button type="button" className="cm-action" disabled={geminiRequesting}
              onClick={/** Requires confirmation before requesting another paid Gemini run. */ () => void handleGeminiRequest(true)}>
              <Wand2 size={15} aria-hidden="true" /> {geminiRequesting ? t('kesp.conversationMetrics.gemini.requesting') : t('kesp.conversationMetrics.gemini.regenerate')}
            </button>}
          </div>
        </div>
        {geminiLoading && <p role="status" className="muted small">{t('kesp.conversationMetrics.gemini.loading')}</p>}
        {geminiError && <p role="alert" className="muted small">{geminiError}</p>}
        {!geminiLoading && geminiResponse?.enabled === false && <p className="muted small">{t('kesp.conversationMetrics.gemini.disabled')}</p>}
        {!geminiLoading && geminiResponse?.enabled === true && geminiResponse.privacyApproved === false && <p className="muted small">{t('kesp.conversationMetrics.gemini.privacy')}</p>}
        {!geminiLoading && geminiResponse?.enabled === true && geminiResponse.privacyApproved === true && !canRequestGeminiReview && !review && (
          <p className="muted small">{t('kesp.conversationMetrics.gemini.adminOnly')}</p>
        )}
        {review && <p className="cm-availability" role={pendingReview ? 'status' : undefined}>
          {t(`kesp.conversationMetrics.gemini.status.${status}`)}
          {review.model ? ` · ${review.model}` : ''}
          {typeof review.attempts === 'number' ? ` · ${t('kesp.conversationMetrics.gemini.attempts', { count: review.attempts })}` : ''}
        </p>}
        {safeError && terminalReview && <p className="muted small">{safeError}</p>}
        {pendingReview && geminiPollReads >= GEMINI_MAX_POLL_READS && <p className="muted small">{t('kesp.conversationMetrics.gemini.pollEnded')}</p>}
        {review?.observations?.length ? <ul className="cm-gemini-observations">
          {review.observations.map(/** Preserves stored Spanish review text and links only returned evidence ids. */ (observation, index) => (
            <li key={`${observation.category}:${index}`}>
              <div className="cm-segment-head">
                <span>{t(`kesp.conversationMetrics.gemini.category.${observation.category}`)}</span>
                {observation.uncertain && <span className="muted">{t('kesp.conversationMetrics.gemini.uncertain')}</span>}
              </div>
              <p lang="es">{evidenceText(observation.text)}</p>
              {observation.coaching && <p lang="es" className="muted small">{evidenceText(observation.coaching)}</p>}
              <div className="cm-observation-evidence">{observation.evidenceIds.map(/** Navigates to transcript evidence without autoplay or popups. */ (id) => {
                const evidence = evidenceById.get(id);
                return evidence ? (
                  <span key={id}>
                    <button type="button" className="cm-play"
                      title={t('kesp.conversationMetrics.playEvidence', { time: evidenceTime(evidence.start) })}
                      aria-label={t('kesp.conversationMetrics.playEvidence', { time: evidenceTime(evidence.start) })}
                      onClick={/** Selects transcript evidence only; the transcript player remains user-controlled. */ () => onPlayEvidence(geminiEvidenceToMetricEvent(evidence))}>
                      <Play size={15} aria-hidden="true" />
                    </button>
                    <span className="cm-time">{evidenceTime(evidence.start)} - {evidenceTime(evidence.end)}</span>
                  </span>
                ) : null;
              })}</div>
            </li>
          ))}
        </ul> : review && status === 'complete' && <p className="muted small">{t('kesp.conversationMetrics.gemini.noObservations')}</p>}
      </div>
    );
  }
  /** Localizes known exclusion reasons without exposing internal reason codes as labels. */
  function segmentStatus(segment: ConversationMetricSegment): string {
    if (segment.timingExcluded) return segment.exclusionReason ? t(`kesp.conversationMetrics.exclusions.${segment.exclusionReason}`, {
      defaultValue: t('kesp.conversationMetrics.timingExcluded'),
    }) : t('kesp.conversationMetrics.timingExcluded');
    if (segment.speedEligible) return t(`kesp.conversationMetrics.${segment.tooFast ? 'tooFast' : 'eligible'}`);
    return t(`kesp.conversationMetrics.exclusions.${segment.exclusionReason ?? 'unknown'}`, {
      defaultValue: t('kesp.conversationMetrics.excluded'),
    });
  }

  const report = response?.metrics;
  const providerSegmentTiming = report?.timingSource === 'segment' || report?.calculationVersion === 'openai_segment_timing_v1';
  const segmentTiming = providerSegmentTiming || report?.calculationVersion === 'segment_timing_v2';
  const cachedSourceUnavailable = report?.limitations?.includes(CACHED_SOURCE_LIMITATION) === true;
  const deterministicOnly = response?.interpretationStatus === 'not_requested';
  const hasTimingExclusions = !!report && ((report.coverage.excludedSegmentCount ?? 0) > 0 ||
    report.segments.some(/** Retained rows can identify exclusions even when optional totals are absent. */ (segment) => segment.timingExcluded === true || segment.exclusionReason === 'zero_duration_word') ||
    (segmentTiming && report.coverage.excludedSegmentCount === undefined && report.coverage.excludedWordCount > 0));
  const hasSegmentCoverage = !!report && (report.coverage.totalSegmentCount !== undefined ||
    report.coverage.excludedSegmentCount !== undefined || report.coverage.analyzedWordCount !== undefined);
  const retainedTimingReport = segmentTiming || hasSegmentCoverage || hasTimingExclusions;
  const pending = ['pending', 'queued', 'running', 'processing', 'retry_pending'].includes(response?.interpretationStatus ?? '');
  const failed = ['failed', 'error'].includes(response?.interpretationStatus ?? '');
  const summaryItems = report ? [
    ['fastSegmentCount', report.summary.fastSegmentCount, '', 'speed'],
    ['fastestWpm', report.summary.fastestWpm, 'wpm', 'speed'],
    ['agentSpeechSeconds', report.summary.agentSpeechSeconds, 'seconds', 'talkBalance'],
    ['customerSpeechSeconds', report.summary.customerSpeechSeconds, 'seconds', 'talkBalance'],
    ['overlapSeconds', report.summary.overlapSeconds, 'seconds', 'interruptions'],
    ['agentTalkPercent', report.summary.agentTalkPercent, 'percent', 'talkBalance'],
    ['longestAgentTurnSeconds', report.summary.longestAgentTurnSeconds, 'seconds', 'turns'],
    ['medianResponseGapSeconds', report.summary.medianResponseGapSeconds, 'seconds', 'gaps'],
    ['interruptionCandidateCount', report.summary.interruptionCandidateCount, '', 'interruptions'],
    ['fillerCandidateCount', report.summary.fillerCandidateCount, '', 'fillers'],
    ['fillerCandidatesPer100Words', report.summary.fillerCandidatesPer100Words, '', 'fillers'],
  ] as const : [];
  const allEvidence = report ? [...report.segments, ...report.interruptions, ...report.gaps, ...report.fillers] : [];
  const adjustment = response?.speedAdjustment;
  const visibleMetricObservations = response?.observations.filter(
    /** Only duplicate legacy interruption interpretations are hidden; deterministic measurements stay visible. */
    (observation) => !shouldHideLegacyInterruptionObservation(observation, report?.interruptions ?? [], geminiResponse)
  ) ?? [];

  return (
    <section className="conversation-metrics" aria-labelledby="conversation-metrics-heading" aria-busy={loading}>
      <header className="cm-header">
        <h3 id="conversation-metrics-heading">{t('kesp.conversationMetrics.title')}</h3>
        <div className="cm-header-actions">
          <ConversationMetricsHelp timingSource={providerSegmentTiming ? 'segment' : 'word'} deterministicOnly={deterministicOnly} />
          <button type="button" className="cm-play" disabled={loading}
            title={t('kesp.conversationMetrics.refresh')} aria-label={t('kesp.conversationMetrics.refresh')}
            onClick={/** Reloads the read-only result without reprocessing the call. */ () => {
              setLoading(true);
              setError(false);
              setReload(reload + 1);
            }}>
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      {loading && <p role="status" className="muted">{t('kesp.conversationMetrics.loading')}</p>}
      {error && <p role="alert">{t('kesp.conversationMetrics.error')}</p>}
      {!loading && !error && !report && <p className="muted">{t(`kesp.conversationMetrics.${pending ? 'pendingMetrics' : failed ? 'failedInterpretation' : 'help.status.unavailable'}`)}</p>}
      {geminiReviewPanel()}
      {!error && report && <>
        <p className="cm-availability" role="status">{t(`kesp.conversationMetrics.help.status.${report.status}`)}</p>
        {cachedSourceUnavailable && <p className="muted small" role="status">{t('kesp.conversationMetrics.cachedSourceUnavailable')}</p>}
        <p className="muted small">{t(`kesp.conversationMetrics.timingSource.${providerSegmentTiming ? 'segment' : 'word'}`)}</p>
        {providerSegmentTiming ? <p className="muted small">{t('kesp.conversationMetrics.providerSegmentCoverage', {
          total: number(report.coverage.totalSegmentCount), excluded: number(report.coverage.excludedSegmentCount),
          analyzed: number(report.coverage.analyzedWordCount),
        })}</p> : <p className="muted small">{t(`kesp.conversationMetrics.${segmentTiming ? 'wordTimingCoverage' : 'coverage'}`, {
          validated: number(report.coverage.validatedWordCount), total: number(report.coverage.inputWordCount),
          excluded: number(report.coverage.excludedWordCount), unknown: number(report.coverage.unknownRoleWordCount),
        })}</p>}
        {!providerSegmentTiming && hasSegmentCoverage && <p className="muted small">{t('kesp.conversationMetrics.segmentCoverage', {
          total: number(report.coverage.totalSegmentCount), excluded: number(report.coverage.excludedSegmentCount),
          analyzed: number(report.coverage.analyzedWordCount),
        })}</p>}
        {hasTimingExclusions && <p className="muted small">{t('kesp.conversationMetrics.retainedSummary')}</p>}
        <dl className="cm-summary">
          {summaryItems.map(/** Keeps missing values distinct from measured zero. */ ([key, value, unit, feature]) => {
            const available = report.availability[feature].available && typeof value === 'number' && Number.isFinite(value);
            return <div key={key}><dt>{t(`kesp.conversationMetrics.${providerSegmentTiming ? 'segmentSummary' : 'summary'}.${key}`, {
              defaultValue: t(`kesp.conversationMetrics.summary.${key}`),
            })}</dt><dd>{number(available ? value : null)}{unit && available ? ` ${t(`kesp.conversationMetrics.units.${unit}`)}` : ''}</dd></div>;
          })}
        </dl>
        <div className="cm-rule">
          {adjustment ? <>
            <p>{t('kesp.conversationMetrics.adjustment', {
              base: number(adjustment.baseCredit, true), deduction: number(adjustment.deduction, true), final: number(adjustment.finalCredit, true),
            })}</p>
            <p className="muted">{t(`kesp.conversationMetrics.adjustmentReason.${adjustment.reason}`)}</p>
          </> : <p className="muted">{t('kesp.conversationMetrics.noAdjustment')}</p>}
        </div>
        <details className="cm-details">
          <summary>{t('kesp.conversationMetrics.segments')} <span className="muted">({t('kesp.conversationMetrics.shownCount', { shown: number(report.segments.length), total: number(report.evidenceTotals?.segments ?? report.segments.length) })})</span></summary>
          {report.segments.length === 0 ? <p className="muted small">{t(`kesp.conversationMetrics.${retainedTimingReport && (report.evidenceTotals?.segments ?? 0) > 0 ? 'noSegmentsShown' : 'noSegments'}`)}</p> : (
            <ul className="cm-evidence-list">
              {report.segments.map(/** Displays measured speed and eligibility separately. */ (segment) => (
                <li key={segment.id}>
                  {playButton(segment)}
                  <div>
                    <div className="cm-segment-head">
                      <span className="cm-time">{evidenceTime(segment.start)} - {evidenceTime(segment.end)}</span>
                      <span>{t(`kesp.conversationMetrics.speaker.${segment.role}`, { defaultValue: t('kesp.conversationMetrics.speaker.unknown') })}</span>
                      <span>{number(segment.timingExcluded ? null : segment.wpm)} {t('kesp.conversationMetrics.units.wpm')}</span>
                      <span>{t('kesp.conversationMetrics.wordCount', { count: segment.wordCount })}</span>
                      <span className={!segment.timingExcluded && segment.tooFast ? 'cm-fast' : 'muted'}>{segmentStatus(segment)}</span>
                    </div>
                    <p>{evidenceText(segment.text)}{segment.textTruncated && <span className="muted"> ({t('kesp.conversationMetrics.excerpt')})</span>}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </details>
        {eventList('interruptions', report.interruptions)}
        {eventList('gaps', report.gaps)}
        {eventList('fillers', report.fillers)}
        {deterministicOnly ? <p className="muted small">{t('kesp.conversationMetrics.deterministicOnly')}</p> : <div className="cm-observations">
          <h4>{t('kesp.conversationMetrics.observations')}</h4>
          {pending && <p role="status" className="muted small">{t('kesp.conversationMetrics.pendingInterpretation')}</p>}
          {failed && <p className="muted small">{t('kesp.conversationMetrics.failedInterpretation')}</p>}
          {visibleMetricObservations.length ? <ul>
            {visibleMetricObservations.map(/** Preserves stored Spanish observations and valid evidence references. */ (observation, index) => (
              <li key={index}>
                <p lang="es">{evidenceText(observation.text)}</p>
                <div className="cm-observation-evidence">{observation.evidenceIds.map(/** Resolves references only to evidence returned by the callable. */ (id) => {
                  const evidence = allEvidence.find(/** Finds a returned event or its retained source word reference. */ (item) => item.id === id || item.evidenceIds?.includes(id));
                  return evidence ? <span key={id}>{playButton(evidence)} <span className="cm-time">{evidenceTime(evidence.start)}</span></span> : null;
                })}</div>
              </li>
            ))}
          </ul> : !pending && !failed && <p className="muted small">{t('kesp.conversationMetrics.noObservations')}</p>}
        </div>}
      </>}
    </section>
  );
}
