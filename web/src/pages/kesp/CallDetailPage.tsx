import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Loader2, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/useAuth';
import { transcriptionModelLabel } from '@/lib/transcriptionUpload';
import { subscribeToCall, fetchFeedback, fetchTranscript } from '@/services/firestore';
import { subscribeToAgentAnalyses } from '@/services/agentAnalyses';
import { assignUnrecognizedCallToAgent } from '@/services/functions';
import { DeleteCallDialog } from '@/components/calls/DeleteCallDialog';
import {
  getFeedbackManagementActionPlan,
  localizeText,
} from '@/lib/managementAction';
import { appendReturnTo, getReturnToFromSearch } from '@/lib/returnTo';
import type { Call, CallCategory, CallStatus } from '@/types/call';
import type { AgentAnalysis } from '@/types/agentAnalysis';
import type {
  Feedback,
  RubricScorecardV2,
  RubricV2Section,
  RubricV2Group,
  RubricV2Criterion,
  WeaknessItem,
} from '@/types/feedback';
import type { Transcript, TranscriptSegment } from '@/types/transcript';
import { Icon } from '@/components/kesp/icons';
import { Button, Pill, ScoreRing } from '@/components/kesp/primitives';
import { fmtDur } from '@/components/kesp/format';
import { useCallAudioPlayback } from '@/components/audio/useCallAudioPlayback';
import { segmentPlaybackInterval, transcriptEvidenceIndices } from '@/components/audio/transcriptPlayback';
import { invalidateAudioPlaybackCache } from '@/services/audioPlayback';
import '@/components/audio/TranscriptPlayback.css';
import { StopCallProcessingDialog } from '@/components/calls/StopCallProcessingDialog';
import { formatKespDate } from '@/lib/kespI18n';
import { isTestingFirebaseProject } from '@/services/firebaseApp';
import {
  maskKespDemoAgentDisplayName,
  maskKespDemoCallString,
  maskKespDemoTranscriptText,
  redactKespDemoText,
} from '@/lib/kespDemoRedaction';
import { useKespDemoRedactionEnabled } from '@/hooks/useKespDemoRedactionEnabled';
import { ConversationMetricsPanel } from '@/components/kesp/ConversationMetricsPanel';
import type { ConversationMetricEvent } from '@/services/functions';
import {
  isConsubancoAdminMember,
  isConsubancoSupervisorOrAdminMember,
  subscribeToConsubancoMembership,
  type OrganizationMember,
} from '@/services/organizations';

type ResolvedCriterion = RubricV2Criterion & {
  parentSectionId: string;
  parentGroupId: string;
};

type TranscriptRole = 'agent' | 'customer' | 'speaker';

const CATEGORY_KIND: Record<CallCategory, 'good' | 'warn' | 'bad' | 'default'> = {
  good: 'good',
  medium: 'warn',
  bad: 'bad',
  unknown: 'default',
};

/** Documents the categoryLabel behavior. */
function categoryLabel(category: CallCategory, t: TFunction): string {
  return t(`kesp.category.${category}`);
}

/** Documents the statusLabel behavior. */
function statusLabel(status: CallStatus, t: TFunction): string {
  return t(`kesp.status.${status}`);
}

/** Documents the loanLabel behavior. */
function loanLabel(value: string, t: TFunction): string {
  return t(`kesp.loan.${value}`, { defaultValue: t('kesp.common.notAvailable') });
}

/** Documents the performanceTierLabel behavior. */
function performanceTierLabel(value: string | undefined, t: TFunction): string {
  if (!value) return t('kesp.common.notAvailable');
  return t(`kesp.callDetail.performanceTier.${value}`, { defaultValue: value });
}

/** Documents the formatDate behavior. */
function formatDate(date: Date | undefined, language: string | undefined): string {
  return formatKespDate(date, language, {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Documents the analyzedTimestampForCall behavior. */
function analyzedTimestampForCall(call: Call): Date | undefined {
  return call.analysisCompletedAt ?? call.analysisStartedAt ?? call.createdAt;
}

/** Documents the statusKindFromV2 behavior. */
function statusKindFromV2(status: RubricV2Criterion['status']): 'good' | 'bad' | 'default' {
  if (status === 'Cumple') return 'good';
  if (status === 'No cumple') return 'bad';
  return 'default';
}

/** Documents the colorFromGroup behavior. */
function colorFromGroup(earned: number, total: number): string {
  if (total <= 0) return 'green';
  const pct = earned / total;
  if (pct >= 0.8) return 'green';
  if (pct >= 0.6) return 'amber';
  return 'red';
}

/** Documents the normalizeSpeakerLabel behavior. */
function normalizeSpeakerLabel(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

/** Documents the roleForSegment behavior. */
function roleForSegment(segment: TranscriptSegment, feedback: Feedback | null): TranscriptRole {
  const speaker = normalizeSpeakerLabel(segment.speaker);
  if (!speaker) return 'speaker';

  if (speaker === normalizeSpeakerLabel(feedback?.agent_speaker)) return 'agent';
  if (speaker === normalizeSpeakerLabel(feedback?.customer_speaker)) return 'customer';

  return 'speaker';
}

/** Documents the formatTranscriptTime behavior. */
function formatTranscriptTime(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs
      .toString()
      .padStart(2, '0')}`;
  }

  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/** Documents the formatSegmentRange behavior. */
function formatSegmentRange(segment: TranscriptSegment): string | null {
  const start = formatTranscriptTime(segment.start);
  const end = formatTranscriptTime(segment.end);

  if (start && end) return `${start}-${end}`;
  return start ?? end;
}

/** Renders the TranscriptView component. */
function TranscriptView({
  transcript,
  loading,
  error,
  feedback,
  agentLabel,
  customerLabel,
  selectedEvidence,
  audioPath,
  playback,
}: {
  transcript: Transcript | null;
  loading: boolean;
  error: boolean;
  feedback: Feedback | null;
  agentLabel: string;
  customerLabel: string;
  selectedEvidence: ConversationMetricEvent | null;
  audioPath?: string;
  playback: ReturnType<typeof useCallAudioPlayback>;
}) {
  const { t } = useTranslation();
  const demoMode = useKespDemoRedactionEnabled();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const evidenceIndices = transcriptEvidenceIndices(transcript?.segments ?? [], selectedEvidence);

  useEffect(/** Scrolls only when evidence or the loaded transcript changes, never on audio ticks. */ () => {
    const indices = transcriptEvidenceIndices(transcript?.segments ?? [], selectedEvidence);
    if (!loading && indices.length) {
      transcriptRef.current?.querySelector(`[data-segment-index="${indices[0]}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedEvidence, transcript, loading]);

  /** Shares the same inline control across full-recording and individual segment playback. */
  function renderPlaybackControl(key: string, interval: ReturnType<typeof segmentPlaybackInterval>, disabled = false) {
    const selected = playback.selectedKey === key;
    const active = selected && playback.playing;
    const downloading = selected && playback.loading;
    const action = downloading ? 'cancel' : active ? 'pause' : key === 'full' ? 'playRecording' : 'play';
    return (
      <div className="transcript-playback-control">
        <button type="button" className="transcript-audio-button"
          aria-label={t(`kesp.callDetail.playback.${action}`)}
          title={t(`kesp.callDetail.playback.${disabled ? 'invalidTiming' : action}`)}
          disabled={disabled || !audioPath}
          onClick={/** Plays the stored interval without opening a dialog. */ () => playback.toggle(key, interval)}>
          {downloading ? <Loader2 size={16} className="transcript-audio-loading" aria-hidden="true" />
            : active ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
        <span className="transcript-playback-clock" aria-label={t('kesp.callDetail.playback.elapsed')}>
          {formatTranscriptTime(selected ? playback.elapsed : 0)}
          {selected && playback.duration > 0 ? ` / ${formatTranscriptTime(playback.duration)}` : ''}
        </span>
        {interval?.includesPause && <span className="muted tiny">{t('kesp.callDetail.playback.includesPause')}</span>}
        {selected && renderPlaybackStatus()}
      </div>
    );
  }

  /** Keeps download and retry feedback beside the selected segment, even far down the transcript. */
  function renderPlaybackStatus() {
    return <>
      {playback.loading && (
        <div className="transcript-audio-status" role="status">
          <span>{playback.progress.total
            ? t('kesp.callDetail.playback.downloadPercent', { percent: Math.round(playback.progress.loaded / playback.progress.total * 100) })
            : t('kesp.callDetail.playback.downloading')}</span>
          <progress max={playback.progress.total ?? undefined} value={playback.progress.total ? playback.progress.loaded : undefined}
            aria-label={t('kesp.callDetail.playback.downloading')} />
          <button type="button" className="transcript-audio-button" onClick={playback.cancel}
            title={t('kesp.callDetail.playback.cancel')} aria-label={t('kesp.callDetail.playback.cancel')}><X size={16} /></button>
        </div>
      )}
      {playback.error && (
        <div className="transcript-audio-status" role="alert">
          <span>{t(`kesp.callDetail.playback.errors.${playback.error}`)}</span>
          <button type="button" className="transcript-audio-button" title={t('kesp.callDetail.playback.retry')}
            aria-label={t('kesp.callDetail.playback.retry')}
            onClick={/** Retries only the user's last selected recording interval. */ () => {
              const index = Number(playback.selectedKey);
              const interval = playback.selectedKey === 'full' ? null : segmentPlaybackInterval(transcript?.segments ?? [], index);
              if (playback.selectedKey === 'full' || interval) playback.toggle(playback.selectedKey!, interval);
            }}><RotateCcw size={16} /></button>
        </div>
      )}
    </>;
  }

  const audioControls = (
    <div className="transcript-audio-toolbar">
      {playback.error && playback.selectedKey === null && <div className="transcript-audio-status" role="alert">
        {t(`kesp.callDetail.playback.errors.${playback.error}`)}
      </div>}
      <div className="transcript-full-recording">
        <span>{t('kesp.callDetail.playback.fullRecording')}</span>
        {renderPlaybackControl('full', null)}
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="card rise" style={{ textAlign: 'center', padding: 32 }}>
        {audioControls}
        <div className="muted">{t('kesp.callDetail.loadingTranscript')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card rise" style={{ textAlign: 'center', padding: 32 }}>
        {audioControls}
        <div className="muted">{t('kesp.callDetail.transcriptError')}</div>
      </div>
    );
  }

  const segments = transcript?.segments ?? [];
  const fullText = transcript?.text?.trim() ?? '';

  if (!transcript || (segments.length === 0 && !fullText)) {
    return (
      <div className="card rise" style={{ textAlign: 'center', padding: 32 }}>
        {audioControls}
        <div className="muted">{t('kesp.callDetail.noTranscript')}</div>
      </div>
    );
  }

  const duration = formatTranscriptTime(transcript.duration);

  return (
    <div className="card rise transcript-card" ref={transcriptRef}>
      <div className="transcript-head">
        <div>
          <h3 className="card-h">{t('kesp.callDetail.transcript.title')}</h3>
          <div className="muted small">
            {segments.length > 0
              ? t('kesp.callDetail.transcript.segmentCount', { count: segments.length })
              : t('kesp.callDetail.transcript.fullText')}
            {duration && (
              <>
                {' · '}
                {t('kesp.callDetail.transcript.totalDuration')}: {duration}
              </>
            )}
          </div>
        </div>
      </div>

      {audioControls}
      {segments.length > 0 ? (
        <div className="transcript-list">
          {segments.map(/** Handles the callback for this operation. */(segment, index) => {
            const role = roleForSegment(segment, feedback);
            const timestamp = formatSegmentRange(segment);
            const interval = segmentPlaybackInterval(segments, index);
            const speakerCode = demoMode ? null : segment.speaker?.trim();
            const roleLabel =
              role === 'agent'
                ? t('kesp.callDetail.transcript.agent')
                : role === 'customer'
                  ? t('kesp.callDetail.transcript.customer')
                  : speakerCode
                    ? t('kesp.callDetail.transcript.speaker', { speaker: speakerCode })
                    : t('kesp.callDetail.transcript.unknownSpeaker');
            const speakerName =
              role === 'agent' ? agentLabel : role === 'customer' ? customerLabel : null;

            return (
              <article
                key={segment.id || `${segment.start}-${segment.end}-${index}`}
                className="transcript-segment"
                data-role={role}
                data-segment-index={index}
                data-metrics-evidence={evidenceIndices.includes(index)}
                data-audio-active={playback.selectedKey === String(index)}
              >
                <div className="transcript-segment-head">
                  <div className="transcript-speaker">
                    <span className="transcript-role">{roleLabel}</span>
                    {speakerName && <span className="transcript-name">{speakerName}</span>}
                    {speakerCode && role !== 'speaker' && (
                      <span className="transcript-speaker-code">{speakerCode}</span>
                    )}
                  </div>
                  <div className="transcript-segment-audio">
                    {timestamp && <time className="transcript-timestamp">{timestamp}</time>}
                    {renderPlaybackControl(String(index), interval, !interval)}
                  </div>
                </div>
                <p className="transcript-text">{demoMode ? maskKespDemoTranscriptText() : segment.text}</p>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="transcript-fulltext">{demoMode ? maskKespDemoTranscriptText() : transcript.text}</div>
      )}
    </div>
  );
}

/** Renders the RubricView component. */
function RubricView({ rubric, callId, returnTo }: { rubric: RubricScorecardV2; callId: string; returnTo: string | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState<Record<string, boolean>>(/** Handles the callback for this operation. */() => {
    const init: Record<string, boolean> = {};
    if (rubric.sections[0]) init[rubric.sections[0].id] = true;
    return init;
  });

  return (
    <div className="card rise">
      <div className="rubric-grid">
        <div>
          <div className="row row-between" style={{ marginBottom: 8 }}>
            <h3 className="card-h">{t('kesp.callDetail.rubric.title')}</h3>
            <span className="muted small">{t('kesp.callDetail.rubric.instruction')}</span>
          </div>
          {rubric.sections.map(/** Handles the callback for this operation. */(section: RubricV2Section) => {
            const color = colorFromGroup(section.earned_points, section.max_points);
            return (
              <div key={section.id} className="rubric-section">
                <div
                  className="rubric-section-h"
                  onClick={/** Handles the onClick interaction. */ () =>
                    setOpen(/** Handles the callback for this operation. */(o) => ({ ...o, [section.id]: !o[section.id] }))
                  }
                >
                  <Icon name={open[section.id] ? 'chevronDown' : 'chevron'} size={12} />
                  <h4>
                    {section.id}. {section.title}{' '}
                    <span
                      className="muted tiny"
                      style={{ fontWeight: 400, marginLeft: 8 }}
                    >
                      {section.weight_percent}%
                    </span>
                  </h4>
                  <div className="rubric-bar">
                    <i
                      className={color}
                      style={{
                        width:
                          section.max_points > 0
                            ? (section.earned_points / section.max_points) * 100 + '%'
                            : '0%',
                      }}
                    />
                  </div>
                  <div className={'rubric-score ' + color}>
                    {section.earned_points.toFixed(1)}/{section.max_points}
                  </div>
                </div>
                {open[section.id] && section.groups.length > 0 && (
                  <div className="rubric-children">
                    {section.groups.map(/** Handles the callback for this operation. */(group: RubricV2Group) => {
                      const groupColor = colorFromGroup(
                        group.earned_points,
                        group.max_points
                      );
                      return (
                        <Fragment key={group.id}>
                          <div
                            className="rubric-child"
                            onClick={/** Handles the onClick interaction. */ () =>
                              group.criteria.length &&
                              setOpen(/** Handles the callback for this operation. */(o) => ({ ...o, [group.id]: !o[group.id] }))
                            }
                            style={{
                              cursor: group.criteria.length ? 'pointer' : 'default',
                            }}
                          >
                            <span className="code">{group.id}</span>
                            <span style={{ fontWeight: 500 }}>{group.title}</span>
                            <div className="rubric-bar">
                              <i
                                className={groupColor}
                                style={{
                                  width:
                                    group.max_points > 0
                                      ? (group.earned_points / group.max_points) * 100 +
                                      '%'
                                      : '0%',
                                }}
                              />
                            </div>
                            <div className={'rubric-score ' + groupColor}>
                              {group.earned_points.toFixed(1)}/
                              {group.max_points.toFixed(1)}
                            </div>
                          </div>
                          {open[group.id] &&
                            group.criteria.map(/** Handles the callback for this operation. */(criterion: RubricV2Criterion) => {
                              const resolved: ResolvedCriterion = {
                                ...criterion,
                                parentSectionId: section.id,
                                parentGroupId: group.id,
                              };
                              const kind = statusKindFromV2(criterion.status);
                              return (
                                <div
                                  key={criterion.id}
                                  className="rubric-child"
                                  style={{
                                    paddingLeft: 24,
                                    cursor: 'pointer',
                                    borderRadius: 8,
                                  }}
                                  onClick={/** Handles the onClick interaction. */ () =>
                                    navigate(
                                      appendReturnTo(
                                        `/kesp/call/${encodeURIComponent(callId)}/rubric/${encodeURIComponent(
                                          resolved.parentSectionId
                                        )}/${encodeURIComponent(resolved.parentGroupId)}/${encodeURIComponent(
                                          resolved.id
                                        )}`,
                                        returnTo
                                      )
                                    )
                                  }
                                >
                                  <span className="code">{criterion.id}</span>
                                  <span>
                                    <span
                                      style={{
                                        color: 'var(--ink-3)',
                                        marginRight: 6,
                                      }}
                                    >
                                      {criterion.title}
                                    </span>{' '}
                                    <Pill kind={kind === 'default' ? 'default' : kind}>
                                      {criterion.status}
                                    </Pill>
                                  </span>
                                  <div className="rubric-bar">
                                    <i
                                      className={
                                        kind === 'good'
                                          ? 'green'
                                          : kind === 'bad'
                                            ? 'red'
                                            : 'amber'
                                      }
                                      style={{
                                        width:
                                          criterion.max_points > 0
                                            ? (criterion.earned_points /
                                              criterion.max_points) *
                                            100 +
                                            '%'
                                            : '0%',
                                      }}
                                    />
                                  </div>
                                  <div
                                    className={
                                      'rubric-score ' +
                                      (kind === 'good'
                                        ? 'green'
                                        : kind === 'bad'
                                          ? 'red'
                                          : 'amber')
                                    }
                                  >
                                    {criterion.earned_points.toFixed(1)}/
                                    {criterion.max_points.toFixed(1)}
                                  </div>
                                </div>
                              );
                            })}
                        </Fragment>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="rubric-ref">
          <div className="crumb">{t('kesp.callDetail.rubric.sideCrumb')}</div>
          <h3>{t('kesp.callDetail.rubric.openCriterion')}</h3>
          <div className="muted small">
            {t('kesp.callDetail.rubric.sideHelp')}
          </div>
          <div className="label">{t('kesp.callDetail.rubric.totalSummary')}</div>
          <div className="grp">
            {t('kesp.callDetail.rubric.compositeScore')}:{' '}
            <b style={{ color: 'var(--ink)' }}>
              {rubric.earned_points.toFixed(1)} / {rubric.total_points}
            </b>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Renders the CallDetailPage component. */
export function CallDetailPage() {
  const { t, i18n } = useTranslation();
  const demoMode = useKespDemoRedactionEnabled();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const params = useParams<{ id: string }>();
  const callId = params.id ? decodeURIComponent(params.id) : '';
  const [call, setCall] = useState<Call | null>(null);
  const [agentAnalyses, setAgentAnalyses] = useState<AgentAnalysis[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [assigningAgent, setAssigningAgent] = useState(false);
  const [callLoading, setCallLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState(false);
  const [tab, setTab] = useState<'retro' | 'rubric' | 'transcript'>('retro');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [metricsMember, setMetricsMember] = useState<OrganizationMember | null>(null);
  const [evidenceSelection, setEvidenceSelection] = useState<{ callId: string; evidence: ConversationMetricEvent } | null>(null);
  const canViewConversationMetrics = Boolean(user?.uid && metricsMember?.uid === user.uid
    && isConsubancoSupervisorOrAdminMember(metricsMember));
  const canRequestGeminiReview = Boolean(user?.uid && metricsMember?.uid === user.uid
    && isConsubancoAdminMember(metricsMember));
  const selectedEvidence = canViewConversationMetrics && evidenceSelection?.callId === callId ? evidenceSelection.evidence : null;
  const playback = useCallAudioPlayback(call?.id === callId ? call.audioPath : undefined);
  const { cancel: cancelPlayback } = playback;
  const fullRecordingSelected = playback.selectedKey === 'full';
  const fullRecordingAction = fullRecordingSelected && playback.loading ? 'cancel'
    : fullRecordingSelected && playback.playing ? 'pause' : 'playRecording';

  useEffect(/** Stops playback when leaving the transcript or changing calls. */ () => {
    if (tab !== 'transcript') return;
    return cancelPlayback;
  }, [tab, callId, cancelPlayback]);

  /** Opens the transcript and routes the header control to its shared full-recording player. */
  function handleFullRecordingPlayback() {
    setEvidenceSelection(null);
    setTab('transcript');
    playback.toggle('full', null);
  }

  useEffect(/** Watches the current user's existing Consubanco reviewer role. */ () => {
    if (!user?.uid) return;
    /** Calls Firestore only for the user's membership, never restricted metric documents. */
    return subscribeToConsubancoMembership(user.uid, setMetricsMember);
  }, [user?.uid]);

  /** Selects restricted evidence without creating another audio player. */
  function handlePlayConversationEvidence(evidence: ConversationMetricEvent) {
    if (!canViewConversationMetrics) return;
    setEvidenceSelection({ callId, evidence });
    setTab('transcript');
  }

  useEffect(/** Handles the callback for this operation. */() => {
    if (!callId) return;
    setCallLoading(true);
    return subscribeToCall(callId, /** Handles the callback for this operation. */(next) => {
      if (!next) invalidateAudioPlaybackCache();
      setCall(next);
      setCallLoading(false);
    });
  }, [callId]);

  const isAssignableRoutingStatus = /** Documents the isAssignableRoutingStatus behavior. */ (status: Call['agentRoutingStatus'] | undefined): boolean =>
    status === 'unrecognized' || status === 'no_agent' || status === 'pending_mapping';

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid || !isAssignableRoutingStatus(call?.agentRoutingStatus)) return;
    return subscribeToAgentAnalyses(user.uid, setAgentAnalyses);
  }, [user?.uid, call?.agentRoutingStatus]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!callId || call?.status !== 'complete') {
      setFeedback(null);
      return;
    }
    let cancelled = false;
    setFeedbackLoading(true);
    fetchFeedback(callId)
      .then(/** Handles the callback for this operation. */(fb) => {
        if (!cancelled) setFeedback(fb);
      })
      .catch(/** Handles the callback for this operation. */(err) => {
        console.error('Failed to fetch feedback:', err);
        if (!cancelled) setFeedback(null);
      })
      .finally(/** Handles the callback for this operation. */() => {
        if (!cancelled) setFeedbackLoading(false);
      });
    return /** Handles the callback for this operation. */ () => {
      cancelled = true;
    };
  }, [callId, call?.status, call?.latestFeedbackId]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!callId || call?.status !== 'complete') {
      setTranscript(null);
      setTranscriptLoading(false);
      setTranscriptError(false);
      return;
    }

    let cancelled = false;
    setTranscript(null);
    setTranscriptLoading(true);
    setTranscriptError(false);
    /** Calls an external SDK or API dependency. */
    fetchTranscript(callId)
      .then(/** Handles the callback for this operation. */(nextTranscript) => {
        if (!cancelled) setTranscript(nextTranscript);
      })
      .catch(/** Handles the callback for this operation. */(err) => {
        console.error('Failed to fetch transcript:', err);
        if (!cancelled) {
          setTranscript(null);
          setTranscriptError(true);
        }
      })
      .finally(/** Handles the callback for this operation. */() => {
        if (!cancelled) setTranscriptLoading(false);
      });

    return /** Handles the callback for this operation. */ () => {
      cancelled = true;
    };
  }, [callId, call?.status]);

  const managementPlan = useMemo(
    /** Handles the callback for this operation. */
    () => getFeedbackManagementActionPlan(feedback),
    [feedback]
  );

  const returnTo = getReturnToFromSearch(location.search);
  const afterDeletePath = returnTo ?? '/kesp/llamadas';
  const currentDetailPath = `${location.pathname}${location.search}`;

  const handleCopyFollowup = /** Handles the handleCopyFollowup interaction. */ async () => {
    if (!feedback?.suggested_followup_message) return;
    try {
      await navigator.clipboard.writeText(feedback.suggested_followup_message);
      toast.success(t('kesp.callDetail.toasts.copySuccess'));
    } catch {
      toast.error(t('kesp.callDetail.toasts.copyError'));
    }
  };

  const handleAssignAgent = /** Handles the handleAssignAgent interaction. */ async () => {
    if (!callId || !selectedAgentId) {
      toast.error(t('kesp.callDetail.toasts.selectAgent'));
      return;
    }
    setAssigningAgent(true);
    try {
      await assignUnrecognizedCallToAgent(callId, selectedAgentId);
      toast.success(t('kesp.callDetail.toasts.assignSuccess'));
    } catch (error) {
      console.error('Failed to assign call agent:', error);
      toast.error(t('kesp.callDetail.toasts.assignError'));
    } finally {
      setAssigningAgent(false);
    }
  };


  if (callLoading) {
    return (
      <main className="main main-wide">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.callDetail.loadingCall')}</div>
        </div>
      </main>
    );
  }

  if (!call) {
    return (
      <main className="main main-wide">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.callDetail.callNotFound', { id: maskKespDemoCallString(callId || '') })}</div>
        </div>
      </main>
    );
  }

  const score = feedback?.overall_score ?? 0;
  const canStopProcessing = call.status === 'transcribing' || call.status === 'analyzing';
  const clientLabel = feedback?.customer_name ?? call.displayName ?? call.name ?? t('kesp.common.customerFallback');
  const agentLabel = feedback?.agent_name ?? call.salesAgentName ?? t('kesp.common.agentFallback');
  const loanDisplay = feedback ? loanLabel(feedback.loan_completed, t) : t('kesp.common.notAvailable');
  const categoria = categoryLabel(call.category, t);
  const categoriaKind = CATEGORY_KIND[call.category];
  const isAssignableAgentCall = isAssignableRoutingStatus(call.agentRoutingStatus);
  const selectableAgents = [...agentAnalyses]
    .filter(/** Handles the callback for this operation. */(agent) => agent.salesAgentId && agent.salesAgentName)
    .sort(/** Handles the callback for this operation. */(a, b) => a.salesAgentName.localeCompare(b.salesAgentName, 'es'));

  const didWell = (feedback?.agent_strengths ?? []).slice(0, 5).map(/** Handles the callback for this operation. */(s) => s.title);
  const whatWrong = (feedback?.agent_weaknesses ?? []).slice(0, 5).map(/** Handles the callback for this operation. */(w) => w.title);
  const nextTime = managementPlan?.weaknessPlans?.[0]
    ? [
      localizeText(managementPlan.weaknessPlans[0].whatToChangeNextCall, 'es'),
      ...managementPlan.weaknessPlans[0].whatToSayNext.slice(0, 2).map(/** Handles the callback for this operation. */(p) =>
        localizeText(p, 'es')
      ),
      ...managementPlan.weaknessPlans[0].whatToTrain.slice(0, 1).map(/** Handles the callback for this operation. */(t) =>
        localizeText(t, 'es')
      ),
    ].filter(/** Handles the callback for this operation. */(s): s is string => Boolean(s && s.trim()))
    : [];

  const summary =
    managementPlan?.summary && localizeText(managementPlan.summary, 'es')
      ? localizeText(managementPlan.summary, 'es')
      : feedback?.agent_weaknesses?.[0]?.detail ?? t('kesp.callDetail.noSummary');

  const accionMalo =
    feedback?.agent_weaknesses?.[0]?.detail ??
    (managementPlan?.weaknessPlans?.[0]
      ? localizeText(managementPlan.weaknessPlans[0].whatWentWrong, 'es')
      : t('kesp.callDetail.noObservations'));
  const accionHacer = managementPlan?.weaknessPlans?.[0]
    ? localizeText(managementPlan.weaknessPlans[0].whatToChangeNextCall, 'es')
    : '';
  const accionEntrenar = managementPlan?.weaknessPlans?.[0]?.weaknessTitle ?? '';

  return (
    <main className="main main-wide">
      <div ref={playback.attachAudioHost} />
      <div
        className="row row-between row-wrap"
        style={{ marginBottom: 16, gap: 8 }}
      >
        <div className="row row-wrap" style={{ gap: 8 }}>
          <button
            className="linkish row"
            style={{ gap: 6 }}
            onClick={/** Handles the onClick interaction. */ () => navigate(afterDeletePath)}
          >
            <Icon name="arrowLeft" size={13} /> {t('kesp.callDetail.backCalls')}
          </button>
          <span className="muted">/</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {maskKespDemoCallString(call.id)}
          </span>
        </div>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <button
            type="button"
            className="nav-icon-btn"
            title={t('kesp.callDetail.promptMetadata.open')}
            aria-label={t('kesp.callDetail.promptMetadata.open')}
            onClick={/** Handles the onClick interaction. */ () =>
              navigate(appendReturnTo(`/kesp/call/${encodeURIComponent(callId)}/prompts`, returnTo))}
          >
            <Icon name="info" size={16} />
          </button>
          <Button
            kind="ghost"
            size="sm"
            icon={<Trash2 size={13} />}
            onClick={/** Handles the onClick interaction. */ () => setDeleteOpen(true)}
          >
            {t('kesp.callDetail.deleteCall')}
          </Button>
          {canStopProcessing && (
            <Button
              kind="ghost"
              size="sm"
              icon={<Icon name="x" size={13} />}
              onClick={/** Handles the onClick interaction. */ () => setStopOpen(true)}
            >
              {t('kesp.callDetail.stopAnalysis.button')}
            </Button>
          )}
        </div>
      </div>

      <div className="score-hero">
        <ScoreRing value={score} size={108} stroke={10} />
        <div>
          <div className="label-row">
            {call.transcriptionModel && <span style={{ overflowWrap: 'anywhere' }}>
              {t('kesp.transcriptionUpload.model')}: <b>{transcriptionModelLabel(call.transcriptionModel)}</b>
            </span>}
            {call.category !== 'unknown' && (
              <Pill kind={categoriaKind === 'default' ? 'default' : categoriaKind}>
                {categoria}
              </Pill>
            )}
            <Pill kind="default">{statusLabel(call.status, t)}</Pill>
            {call.aiAgentUpload === true && <Pill kind="default">{t('kesp.calls.aiTest')}</Pill>}
            {typeof call.duration === 'number' && call.duration > 0 && (
              <span>
                <b>{fmtDur(call.duration)}</b> {t('kesp.callDetail.duration')}
              </span>
            )}
            <span>
              <b>{formatDate(analyzedTimestampForCall(call), i18n.resolvedLanguage)}</b>
            </span>
          </div>
          <div className="name">
            {clientLabel}{' '}
            <span className="muted" style={{ fontStyle: 'normal', fontSize: 14 }}>
              · {t('kesp.callDetail.with')}
            </span>{' '}
            {agentLabel}
          </div>
          <div className="muted small">
            {t('kesp.callDetail.loan')}: <b style={{ color: 'var(--ink-2)' }}>{loanDisplay}</b>
          </div>
        </div>
        <div className="score-side">
          <button
            type="button"
            className="audio-box"
            aria-label={t(`kesp.callDetail.playback.${fullRecordingAction}`)}
            title={t(`kesp.callDetail.playback.${fullRecordingAction}`)}
            onClick={handleFullRecordingPlayback}
            disabled={!call.audioPath}
          >
            {fullRecordingAction === 'cancel' ? <Loader2 size={22} className="transcript-audio-loading" aria-hidden="true" />
              : fullRecordingAction === 'pause' ? <Pause size={22} aria-hidden="true" /> : <Play size={22} aria-hidden="true" />}
          </button>
          <div
            className="muted tiny"
            style={{ textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}
          >
            {t('kesp.callDetail.label')}
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 500,
              color:
                feedback?.performance_tier === 'excellent' || feedback?.performance_tier === 'good'
                  ? 'var(--good)'
                  : feedback?.performance_tier === 'needs_improvement'
                    ? 'var(--warn)'
                    : feedback?.performance_tier === 'poor'
                      ? 'var(--bad)'
                      : 'var(--ink-3)',
            }}
          >
            {performanceTierLabel(feedback?.performance_tier, t)}
          </div>
        </div>
      </div>

      {call.status !== 'complete' && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="row row-between row-wrap" style={{ gap: 12, alignItems: 'center' }}>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              <Icon name="clock" size={16} />
              <div>
                <h3 className="card-h" style={{ margin: 0 }}>
                  {statusLabel(call.status, t)}
                </h3>
                <div className="muted small">
                  {call.status === 'canceled'
                    ? t('kesp.callDetail.canceledDescription')
                    : t('kesp.callDetail.feedbackPending')}
                </div>
              </div>
            </div>
            {call.status === 'error' && canViewConversationMetrics && (
              <Button kind="soft" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => navigate('/kesp/runtime-errors')}>
                {t('kesp.nav.runtimeErrors')}
              </Button>
            )}
          </div>
        </div>
      )}

      {isAssignableAgentCall && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="row row-between row-wrap" style={{ gap: 12 }}>
            <div style={{ flex: '1 1 280px' }}>
              <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <Icon name="flag" size={15} />
                <h3 className="card-h" style={{ margin: 0 }}>
                  {call.agentRoutingStatus === 'unrecognized'
                    ? t('kesp.callDetail.unrecognizedAgent')
                    : t('kesp.callDetail.noAgentAssignment')}
                </h3>
              </div>
              <div className="muted small">
                {call.agentRoutingStatus === 'unrecognized'
                  ? t('kesp.callDetail.detectedName', {
                    name: call.extractedAgentName || t('kesp.common.notAvailable'),
                  })
                  : t('kesp.callDetail.noAgentAssignmentDescription')}
              </div>
            </div>
            <select
              value={selectedAgentId}
              onChange={/** Handles the onChange interaction. */ (event) => setSelectedAgentId(event.target.value)}
              disabled={assigningAgent}
              style={{ flex: '1 1 240px', minWidth: 220 }}
            >
              <option value="">{t('kesp.callDetail.selectAgent')}</option>
              {selectableAgents.map(/** Handles the callback for this operation. */(agent) => (
                <option key={agent.id} value={agent.id}>
                  {maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId)}
                </option>
              ))}
            </select>
            <Button
              kind="primary"
              size="sm"
              icon={<Icon name="check" size={13} />}
              onClick={handleAssignAgent}
              disabled={assigningAgent || selectableAgents.length === 0}
            >
              {assigningAgent ? t('kesp.common.assigning') : t('kesp.common.assign')}
            </Button>
          </div>
        </div>
      )}

      {call.analysisPipeline === 'manual_short_call_review' && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="row row-between row-wrap" style={{ gap: 12, alignItems: 'center' }}>
            <div>
              <h3 className="card-h" style={{ margin: 0 }}>
                {t('kesp.callDetail.shortCallReviewCta.title')}
              </h3>
              <div className="muted small">{t('kesp.callDetail.shortCallReviewCta.description')}</div>
            </div>
            <Button
              kind="primary"
              size="sm"
              icon={<Icon name="clock" size={13} />}
              onClick={/** Handles the onClick interaction. */() =>
                navigate(appendReturnTo(`/kesp/short-calls/${encodeURIComponent(call.id)}`, currentDetailPath))}
            >
              {t('kesp.callDetail.shortCallReviewCta.button')}
            </Button>
          </div>
        </div>
      )}

      {call.status === 'complete' && feedback && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
            <Icon name="bulb" size={16} />
            <h3 className="card-h" style={{ margin: 0 }}>
              {t('kesp.callDetail.actionable')}
            </h3>
          </div>
          <div className="pc-grid" style={{ marginBottom: 0 }}>
            <div className="pc-col">
              <div className="pc-col-icon" data-kind="why">
                <Icon name="x" size={16} />
              </div>
              <div className="pc-col-label">{t('kesp.callDetail.whatWentWrong')}</div>
              <p className="pc-col-body">{accionMalo || '—'}</p>
            </div>
            <div className="pc-col">
              <div className="pc-col-icon" data-kind="what">
                <Icon name="check" size={16} />
              </div>
              <div className="pc-col-label">{t('kesp.callDetail.whatToDo')}</div>
              <p className="pc-col-body">
                <b style={{ color: 'var(--ink)' }}>{accionHacer || '—'}</b>
              </p>
              {accionEntrenar && (
                <>
                  <div className="pc-col-label" style={{ marginTop: 16 }}>
                    {t('kesp.callDetail.train')}
                  </div>
                  <p
                    className="pc-col-body"
                    style={{ color: 'var(--accent)', fontWeight: 500 }}
                  >
                    {accionEntrenar}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {canViewConversationMetrics && (
        <ConversationMetricsPanel
          key={`${user?.uid}:${callId}:${call.status}:${call.latestFeedbackId ?? ''}`}
          callId={callId}
          audioAvailable={Boolean(call.audioPath)}
          geminiReviewAvailable={isTestingFirebaseProject}
          canRequestGeminiReview={canRequestGeminiReview}
          onPlayEvidence={handlePlayConversationEvidence}
        />
      )}

      <div className="tabbar">
        <button
          className="tabbar-tab"
          aria-selected={tab === 'retro'}
          onClick={/** Handles the onClick interaction. */ () => setTab('retro')}
        >
          {t('kesp.callDetail.tabs.feedback')}
        </button>
        <button
          className="tabbar-tab"
          aria-selected={tab === 'rubric'}
          onClick={/** Handles the onClick interaction. */ () => setTab('rubric')}
        >
          {t('kesp.callDetail.tabs.rubric')}
        </button>
        <button
          className="tabbar-tab"
          aria-selected={tab === 'transcript'}
          onClick={/** Handles the onClick interaction. */ () => setTab('transcript')}
        >
          {t('kesp.callDetail.tabs.transcript')}
        </button>
      </div>

      {tab === 'retro' && (
        <div className="rise">
          {feedbackLoading ? (
            <div className="card" style={{ textAlign: 'center', padding: 32 }}>
              <div className="muted">{t('kesp.callDetail.loadingFeedback')}</div>
            </div>
          ) : !feedback ? (
            <div className="card" style={{ textAlign: 'center', padding: 32 }}>
              <div className="muted">
                {t('kesp.callDetail.noFeedback')}
              </div>
            </div>
          ) : (
            <>
              <div className="resumen-card">
                <div className="resumen-head">
                  <div className="lbl">{t('kesp.callDetail.callSummary')}</div>
                  <div className="muted tiny">
                    {typeof call.duration === 'number' ? fmtDur(call.duration) : '—'}
                    {' · '}
                    {clientLabel}
                  </div>
                </div>
                <p className="resumen-body">{summary}</p>
              </div>

              <div className="resumen-grid">
                <div className="resumen-block good">
                  <div className="resumen-head">
                    <span className="dot" style={{ background: 'var(--good)' }} />
                    {t('kesp.callDetail.didWell')}
                  </div>
                  <ul className="resumen-list">
                    {didWell.length > 0 ? (
                      didWell.map(/** Handles the callback for this operation. */(x, i) => <li key={i}>{x}</li>)
                    ) : (
                      <li className="muted">{t('kesp.callDetail.noStrengths')}</li>
                    )}
                  </ul>
                </div>
                <div className="resumen-block bad">
                  <div className="resumen-head">
                    <span className="dot" style={{ background: 'var(--warn)' }} />
                    {t('kesp.callDetail.failed')}
                  </div>
                  <ul className="resumen-list">
                    {whatWrong.length > 0 ? (
                      whatWrong.map(/** Handles the callback for this operation. */(x, i) => <li key={i}>{x}</li>)
                    ) : (
                      <li className="muted">{t('kesp.callDetail.noWeaknesses')}</li>
                    )}
                  </ul>
                </div>
              </div>

              {nextTime.length > 0 && (
                <div className="resumen-block info" style={{ marginTop: 12 }}>
                  <div className="resumen-head">
                    <span className="dot" style={{ background: 'var(--info)' }} />
                    {t('kesp.callDetail.nextTime', { client: clientLabel.toUpperCase() })}
                  </div>
                  <ul className="resumen-list numbered">
                    {nextTime.map(/** Handles the callback for this operation. */(x, i) => (
                      <li key={i}>
                        <span className="n">{String(i + 1).padStart(2, '0')}</span>
                        {x}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {feedback.suggested_followup_message && (
                <div className="followup-msg" style={{ marginTop: 18 }}>
                  <div className="label">
                    <Icon name="msg" size={12} /> {t('kesp.callDetail.followupLabel')}
                  </div>
                  <blockquote>{demoMode ? redactKespDemoText(feedback.suggested_followup_message) : feedback.suggested_followup_message}</blockquote>
                  <div className="row" style={{ marginTop: 14, gap: 8 }}>
                    <Button
                      kind="primary"
                      size="sm"
                      icon={<Icon name="msg" size={13} />}
                      onClick={handleCopyFollowup}
                    >
                      {t('kesp.callDetail.copyMessage')}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'rubric' && (
        <>
          {feedbackLoading ? (
            <div className="card" style={{ textAlign: 'center', padding: 32 }}>
              <div className="muted">{t('kesp.callDetail.loadingRubric')}</div>
            </div>
          ) : feedback?.rubric_scorecard_v2 ? (
            <RubricView rubric={feedback.rubric_scorecard_v2} callId={callId} returnTo={returnTo} />
          ) : feedback?.rubric_scorecard ? (
            <div className="card" style={{ padding: 32 }}>
              <div className="muted">
                {t('kesp.callDetail.legacyRubric')}
              </div>
              <Button
                kind="ghost"
                size="sm"
                onClick={/** Handles the onClick interaction. */ () =>
                  navigate(appendReturnTo(`/calls/${callId}/scorecard`, returnTo))}
                style={{ marginTop: 12 }}
              >
                {t('kesp.callDetail.classicBreakdown')} <Icon name="arrow" size={12} />
              </Button>
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', padding: 32 }}>
              <div className="muted">{t('kesp.callDetail.noRubric')}</div>
            </div>
          )}
        </>
      )}

      {tab === 'transcript' && (
        <TranscriptView
          key={call.id}
          audioPath={call.audioPath}
          playback={playback}
          transcript={transcript}
          loading={transcriptLoading}
          error={transcriptError}
          feedback={feedback}
          agentLabel={agentLabel}
          customerLabel={clientLabel}
          selectedEvidence={selectedEvidence}
        />
      )}

      <DeleteCallDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        callId={call.id}
        audioPath={call.audioPath}
        onDeleted={/** Handles the onDeleted interaction. */ () => navigate(afterDeletePath, { replace: true })}
      />
      <StopCallProcessingDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        callId={call.id}
      />
    </main>
  );
}

export type { WeaknessItem };
