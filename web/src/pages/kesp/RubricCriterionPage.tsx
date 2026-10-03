import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { subscribeToCall, fetchFeedback, fetchTranscript } from '@/services/firestore';
import { buildFallbackWeaknessActionPlan, localizeText } from '@/lib/managementAction';
import { appendReturnTo, getReturnToFromSearch } from '@/lib/returnTo';
import type { Call } from '@/types/call';
import type {
  BadCritique,
  EvidenceItem,
  Feedback,
  GoodCritique,
  RubricV2Criterion,
  WeaknessItem,
} from '@/types/feedback';
import type { Transcript, TranscriptSegment } from '@/types/transcript';
import { Icon } from '@/components/kesp/icons';
import { Button, Pill } from '@/components/kesp/primitives';
import { maskKespDemoEvidenceText, redactKespDemoText } from '@/lib/kespDemoRedaction';
import { useKespDemoRedactionEnabled } from '@/hooks/useKespDemoRedactionEnabled';

type ResolvedCriterion = {
  sectionId: string;
  sectionTitle: string;
  groupId: string;
  groupTitle: string;
  criterion: RubricV2Criterion;
};

type EvidenceContext = {
  matchedTurn: TranscriptSegment;
  customerContext: string;
  matchedSpeakerKind: 'agent' | 'customer' | 'speaker';
};

/** Documents the statusKindFromV2 behavior. */
function statusKindFromV2(status: RubricV2Criterion['status']): 'good' | 'bad' | 'default' {
  if (status === 'Cumple') return 'good';
  if (status === 'No cumple') return 'bad';
  return 'default';
}

/** Documents the normalizeEvidenceText behavior. */
function normalizeEvidenceText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[“”"'.,;:!?¿¡()[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Documents the stripQuote behavior. */
function stripQuote(value: string): string {
  return value.replace(/^"|"$/g, '');
}

/** Documents the formatTranscriptTime behavior. */
function formatTranscriptTime(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/** Documents the speakerKindForSegment behavior. */
function speakerKindForSegment(
  segment: TranscriptSegment,
  feedback: Feedback | null
): 'agent' | 'customer' | 'speaker' {
  const speaker = normalizeEvidenceText(segment.speaker);
  if (speaker && speaker === normalizeEvidenceText(feedback?.agent_speaker)) {
    return 'agent';
  }
  if (speaker && speaker === normalizeEvidenceText(feedback?.customer_speaker)) {
    return 'customer';
  }
  return 'speaker';
}

/** Documents the speakerKindForEvidence behavior. */
function speakerKindForEvidence(
  evidence: EvidenceItem,
  feedback: Feedback | null
): 'agent' | 'customer' | 'speaker' {
  const speakerLabel = normalizeEvidenceText(evidence.speaker_label);
  const speakerDisplay = normalizeEvidenceText(evidence.speaker_display);
  if (
    (speakerLabel && speakerLabel === normalizeEvidenceText(feedback?.agent_speaker)) ||
    speakerDisplay.includes('agente') ||
    speakerDisplay.includes('agent')
  ) {
    return 'agent';
  }
  if (
    (speakerLabel && speakerLabel === normalizeEvidenceText(feedback?.customer_speaker)) ||
    speakerDisplay.includes('cliente') ||
    speakerDisplay.includes('customer')
  ) {
    return 'customer';
  }
  return 'speaker';
}

/** Documents the informativeTurnText behavior. */
function informativeTurnText(segment: TranscriptSegment): string {
  return segment.text.trim();
}

/** Documents the wordCount behavior. */
function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

/** Documents the trimTerminalPeriod behavior. */
function trimTerminalPeriod(value: string): string {
  return value.trim().replace(/[.。]+$/u, '');
}

/** Documents the extractQuotedSuggestion behavior. */
function extractQuotedSuggestion(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const match = text.match(/["'“‘]([^"'“”‘’]+)["'”’]/u);
  return match?.[1]?.trim() || null;
}

/** Documents the extractDirectSuggestion behavior. */
function extractDirectSuggestion(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const whatMatch = text.match(/qu[eé]\s+debi[oó]\s+haber\s+dicho\s*:\s*(.*?)(?:\s+mentor tips?\s*:|$)/iu);
  const candidate = whatMatch?.[1]?.trim();
  return extractQuotedSuggestion(candidate) ?? candidate ?? extractQuotedSuggestion(text);
}

/** Documents the looksLikeInstruction behavior. */
function looksLikeInstruction(value: string | null | undefined): boolean {
  const normalized = normalizeEvidenceText(value);
  return /^(antes de|validar|valida|debe|debio|deberia|usar|usa|preguntar|pregunta|reconocer|reconoce|explicar|explica|mentor tips|que debio)/.test(
    normalized
  );
}

/** Documents the needsCommercialClose behavior. */
function needsCommercialClose(value: string): boolean {
  const normalized = normalizeEvidenceText(value);
  if (!normalized) return false;
  if (value.trim().endsWith('?') && wordCount(value) >= 8) return false;
  const hasNextStepOrBenefit =
    /\b(whatsapp|mensaje|informacion|opcion|conviene|conveniencia|decidir|seguimiento|mas adelante|cuando se|listo|lista|revisar|revisarlo|avanzar|beneficio|monto|plazo|pago|resolver|aclarar|seguir|sentido)\b/.test(
      normalized
    );
  return wordCount(value) < 14 || !hasNextStepOrBenefit;
}

/** Documents the completeSuggestedPhrase behavior. */
function completeSuggestedPhrase(value: string, weakness: BadCritique): string {
  const cleaned = value.trim();
  if (!needsCommercialClose(cleaned)) return cleaned;

  const normalizedContext = normalizeEvidenceText(`${cleaned} ${weakness.title} ${weakness.detail}`);
  const base = trimTerminalPeriod(cleaned);
  if (/\b(deuda|adeudo|pago|liquidar|liberar|libere|capacidad)\b/.test(normalizedContext)) {
    return `${base}, y cuando se libere esa parte o quiera revisarlo con calma, le puedo mandar la información por WhatsApp y quedo pendiente para ver si esta opción le conviene.`;
  }
  if (/\b(objecion|resistencia|rechazo|pensarlo|interesa|ahorita no|duda)\b/.test(normalizedContext)) {
    return `${base}, y si más adelante le hace sentido, le mando la información por WhatsApp y quedo pendiente para revisar una opción que sí le convenga.`;
  }
  return `${base}, para que pueda decidir con calma le mando la información por WhatsApp y quedo pendiente del siguiente paso que más le convenga.`;
}

/** Documents the weaknessItemFromCritique behavior. */
function weaknessItemFromCritique(weakness: BadCritique): WeaknessItem {
  return {
    title: weakness.title,
    detail: weakness.detail,
    severity: weakness.severity,
    category: weakness.category,
    weakness_improvement_tip: weakness.weakness_improvement_tip,
    evidence: weakness.evidence,
  };
}

/** Documents the formatImprovementPhrase behavior. */
function formatImprovementPhrase(
  weakness: BadCritique,
  feedback: Feedback | null
): string {
  const directSuggestion = extractDirectSuggestion(weakness.weakness_improvement_tip);
  if (directSuggestion && !looksLikeInstruction(directSuggestion)) {
    return completeSuggestedPhrase(directSuggestion, weakness);
  }

  const rawTip = weakness.weakness_improvement_tip?.trim() ?? '';
  if (rawTip && !looksLikeInstruction(rawTip)) {
    return completeSuggestedPhrase(rawTip, weakness);
  }

  const fallbackPlan = buildFallbackWeaknessActionPlan(weaknessItemFromCritique(weakness), feedback);
  const fallbackPhrase = localizeText(fallbackPlan.whatToSayNext[0], 'es');
  return fallbackPhrase ? completeSuggestedPhrase(fallbackPhrase, weakness) : rawTip;
}

/** Documents the joinTurnTexts behavior. */
function joinTurnTexts(segments: TranscriptSegment[]): string {
  return segments
    .map(/** Handles the callback for this operation. */(segment) => informativeTurnText(segment))
    .filter(/** Handles the callback for this operation. */(text) => text.length > 0)
    .join(' ');
}

/** Documents the findEvidenceContext behavior. */
function findEvidenceContext(
  evidence: EvidenceItem,
  transcript: Transcript | null,
  feedback: Feedback | null
): EvidenceContext | null {
  const quote = normalizeEvidenceText(stripQuote(evidence.quote));
  const segments = transcript?.segments ?? [];
  if (!quote || segments.length === 0) return null;

  const matchIndex = segments.findIndex(/** Handles the callback for this operation. */(segment) => {
    const segmentText = normalizeEvidenceText(segment.text);
    return segmentText.includes(quote);
  });
  if (matchIndex < 0) return null;

  const start = Math.max(0, matchIndex - 6);
  const priorTurns = segments.slice(start, matchIndex);
  const customerTurns = priorTurns
    .filter(/** Handles the callback for this operation. */(segment) => speakerKindForSegment(segment, feedback) === 'customer')
    .filter(/** Handles the callback for this operation. */(segment) => wordCount(informativeTurnText(segment)) > 1)
    .slice(-4);
  const fallbackContextTurns = priorTurns
    .filter(/** Handles the callback for this operation. */(segment) => wordCount(informativeTurnText(segment)) > 2)
    .slice(-2);

  return {
    matchedTurn: segments[matchIndex],
    customerContext: joinTurnTexts(customerTurns.length > 0 ? customerTurns : fallbackContextTurns),
    matchedSpeakerKind: speakerKindForSegment(segments[matchIndex], feedback),
  };
}

/** Renders the EvidenceContextView component. */
function EvidenceContextView({
  evidence,
  transcript,
  feedback,
  whyText,
  improvementText,
}: {
  evidence: EvidenceItem;
  transcript: Transcript | null;
  feedback: Feedback | null;
  whyText: string;
  improvementText?: string;
}) {
  const { t } = useTranslation();
  const demoMode = useKespDemoRedactionEnabled();
  const context = findEvidenceContext(evidence, transcript, feedback);
  const matchedSpeakerKind = context?.matchedSpeakerKind ?? speakerKindForEvidence(evidence, feedback);
  const time = context ? formatTranscriptTime(context.matchedTurn.start) : null;
  const matchedSpeakerLabel =
    matchedSpeakerKind === 'agent'
      ? t('kesp.criterion.contextAgent')
      : matchedSpeakerKind === 'customer'
        ? t('kesp.criterion.contextCustomerPrompt')
        : t('kesp.criterion.contextObserved');
  const shouldShowCustomerContext = Boolean(context?.customerContext && matchedSpeakerKind !== 'customer');

  return (
    <div className="evidence-context">
      <div className="evidence-context-title">
        {t('kesp.criterion.context')}
        {time ? <span>{time}</span> : null}
      </div>
      {shouldShowCustomerContext ? (
        <div className="evidence-context-row">
          <div className="evidence-context-meta">{t('kesp.criterion.contextCustomerPrompt')}</div>
          <div>"{demoMode ? maskKespDemoEvidenceText() : context?.customerContext}"</div>
        </div>
      ) : null}
      <div className="evidence-context-row hit">
        <div className="evidence-context-meta">{matchedSpeakerLabel}</div>
        <div>"{demoMode ? maskKespDemoEvidenceText() : stripQuote(evidence.quote)}"</div>
      </div>
      {improvementText?.trim() ? (
        <div className="evidence-context-row should">
          <div className="evidence-context-meta">{t('kesp.criterion.contextShouldHaveSaid')}</div>
          <div>{demoMode ? redactKespDemoText(improvementText) : improvementText}</div>
        </div>
      ) : null}
      {whyText.trim() ? (
        <div className="evidence-context-row">
          <div className="evidence-context-meta">{t('kesp.criterion.contextWhy')}</div>
          <div>{demoMode ? redactKespDemoText(whyText) : whyText}</div>
        </div>
      ) : null}
    </div>
  );
}

/** Documents the resolveCriterion behavior. */
function resolveCriterion(
  feedback: Feedback | null,
  sectionId: string,
  groupId: string,
  criterionId: string
): ResolvedCriterion | null {
  const sections = feedback?.rubric_scorecard_v2?.sections ?? [];
  const section = sections.find(/** Handles the callback for this operation. */(s) => s.id === sectionId);
  const group = section?.groups.find(/** Handles the callback for this operation. */(g) => g.id === groupId);
  const criterion = group?.criteria.find(/** Handles the callback for this operation. */(c) => c.id === criterionId);
  if (!section || !group || !criterion) return null;
  return {
    sectionId: section.id,
    sectionTitle: section.title,
    groupId: group.id,
    groupTitle: group.title,
    criterion,
  };
}

/** Renders the EvidenceList component. */
function EvidenceList({
  weakness,
  transcript,
  feedback,
  criterion,
}: {
  weakness: BadCritique;
  transcript: Transcript | null;
  feedback: Feedback | null;
  criterion: RubricV2Criterion;
}) {
  const { t } = useTranslation();
  const evidenceItems = weakness.evidence ?? [];
  const improvementText = formatImprovementPhrase(weakness, feedback);
  if (evidenceItems.length === 0) {
    return <div className="muted small">{t('kesp.criterion.noEvidence')}</div>;
  }

  return (
    <div className="evidence-list">
      {evidenceItems.map(/** Handles the callback for this operation. */(ev, index) => (
        <div key={index} className="evidence-item context-only">
          <EvidenceContextView
            evidence={ev}
            transcript={transcript}
            feedback={feedback}
            whyText={weakness.detail || criterion.justification}
            improvementText={improvementText}
          />
        </div>
      ))}
    </div>
  );
}

/** Renders the BadCritiqueSection component. */
function BadCritiqueSection({
  criterion,
  weakness,
  index,
  transcript,
  feedback,
}: {
  criterion: RubricV2Criterion;
  weakness: BadCritique;
  index: number;
  transcript: Transcript | null;
  feedback: Feedback | null;
}) {
  const { t } = useTranslation();
  const hasEvidence = (weakness.evidence ?? []).length > 0;
  return (
    <div className="criterion-critique">
      <div>
        <div className="pc-label">{t('kesp.criterion.areaImprovement', { number: index + 1 })}</div>
        <h3>{weakness.title}</h3>
        <p className="muted">{weakness.detail}</p>
        {weakness.weakness_improvement_tip && !hasEvidence && (
          <div className="action-yellow criterion-tip">
            <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <Icon name="bulb" size={14} />
              <b>{t('kesp.criterion.applicableTip')}</b>
            </div>
            <div className="box">{weakness.weakness_improvement_tip}</div>
          </div>
        )}
        {criterion.criterion_improvement_tip && (
          <div className="criterion-note">
            <div className="label">{t('kesp.criterion.criterionMentoring')}</div>
            {criterion.criterion_improvement_tip}
          </div>
        )}
      </div>
      <div>
        <div className="pc-label">{t('kesp.criterion.textualEvidence')}</div>
        <EvidenceList
          weakness={weakness}
          transcript={transcript}
          feedback={feedback}
          criterion={criterion}
        />
      </div>
    </div>
  );
}

/** Renders the GoodCritiqueSection component. */
function GoodCritiqueSection({
  critique,
  transcript,
  feedback,
}: {
  critique: GoodCritique;
  transcript: Transcript | null;
  feedback: Feedback | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="criterion-good">
      <Pill kind="good">{t('kesp.criterion.strength')}</Pill>
      <h3>{critique.title}</h3>
      <p className="muted">{critique.detail}</p>
      {(critique.evidence ?? []).length > 0 && (
        <div className="evidence-list" style={{ marginTop: 12 }}>
          {(critique.evidence ?? []).map(/** Handles the callback for this operation. */(ev, index) => (
            <div key={index} className="evidence-item context-only">
              <EvidenceContextView
                evidence={ev}
                transcript={transcript}
                feedback={feedback}
                whyText={critique.detail}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Renders the RubricCriterionPage component. */
export function RubricCriterionPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams<{
    id: string;
    sectionId: string;
    groupId: string;
    criterionId: string;
  }>();
  const callId = params.id ? decodeURIComponent(params.id) : '';
  const sectionId = params.sectionId ? decodeURIComponent(params.sectionId) : '';
  const groupId = params.groupId ? decodeURIComponent(params.groupId) : '';
  const criterionId = params.criterionId ? decodeURIComponent(params.criterionId) : '';
  const returnTo = getReturnToFromSearch(location.search);
  const callDetailPath = appendReturnTo(`/kesp/call/${encodeURIComponent(callId)}`, returnTo);

  const [call, setCall] = useState<Call | null>(null);
  const [callLoading, setCallLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState(true);
  const [transcript, setTranscript] = useState<Transcript | null>(null);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!callId) return;
    return subscribeToCall(callId, /** Handles the callback for this operation. */(next) => {
      setCall(next);
      setCallLoading(false);
    });
  }, [callId]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!callId) return;
    let cancelled = false;
    fetchFeedback(callId)
      .then(/** Handles the callback for this operation. */(next) => {
        if (!cancelled) setFeedback(next);
      })
      .catch(/** Handles the callback for this operation. */(err) => {
        console.error('Failed to fetch criterion feedback:', err);
        if (!cancelled) setFeedback(null);
      })
      .finally(/** Handles the callback for this operation. */() => {
        if (!cancelled) setFeedbackLoading(false);
      });
    return /** Handles the callback for this operation. */ () => {
      cancelled = true;
    };
  }, [callId]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!callId) return;
    let cancelled = false;
    fetchTranscript(callId)
      .then(/** Handles the callback for this operation. */(next) => {
        if (!cancelled) setTranscript(next);
      })
      .catch(/** Handles the callback for this operation. */(err) => {
        console.error('Failed to fetch criterion transcript:', err);
        if (!cancelled) setTranscript(null);
      });
    return /** Handles the callback for this operation. */ () => {
      cancelled = true;
    };
  }, [callId]);

  const resolved = useMemo(
    /** Handles the callback for this operation. */
    () => resolveCriterion(feedback, sectionId, groupId, criterionId),
    [feedback, sectionId, groupId, criterionId]
  );

  if (callLoading || feedbackLoading) {
    return (
      <main className="main main-wide">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.criterion.loading')}</div>
        </div>
      </main>
    );
  }

  if (!resolved) {
    return (
      <main className="main main-wide">
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.criterion.notFound')}</div>
          <Button kind="ghost" size="sm" onClick={/** Handles the onClick interaction. */ () => navigate(callDetailPath)} style={{ marginTop: 12 }}>
            {t('kesp.criterion.backToCall')}
          </Button>
        </div>
      </main>
    );
  }

  const { criterion } = resolved;
  const statusKind = statusKindFromV2(criterion.status);
  const client = feedback?.customer_name ?? call?.displayName ?? call?.name ?? t('kesp.common.customerFallback');

  return (
    <main className="main main-wide">
      <div className="row row-wrap" style={{ marginBottom: 16, gap: 8 }}>
        <button
          className="linkish row"
          style={{ gap: 6 }}
          onClick={/** Handles the onClick interaction. */ () => navigate(callDetailPath)}
        >
          <Icon name="arrowLeft" size={13} /> {t('kesp.criterion.backCall')}
        </button>
        <span className="muted">/</span>
        <span className="muted" style={{ fontSize: 12 }}>
          {criterion.id}
        </span>
      </div>

      <div className="criterion-hero card">
        <div>
          <div className="muted tiny" style={{ textTransform: 'uppercase', letterSpacing: '.10em', marginBottom: 8 }}>
            {resolved.sectionId}. {resolved.sectionTitle} · {resolved.groupId}. {resolved.groupTitle}
          </div>
          <h1>{criterion.title}</h1>
          <div className="row row-wrap" style={{ gap: 8 }}>
            <Pill kind={statusKind}>{criterion.status}</Pill>
            <Pill kind="default">{client}</Pill>
          </div>
        </div>
        <div className={'criterion-score ' + (statusKind === 'good' ? 'good' : statusKind === 'bad' ? 'bad' : '')}>
          {criterion.earned_points.toFixed(1)}
          <span>/{criterion.max_points.toFixed(1)}</span>
        </div>
      </div>

      <div className="criterion-layout">
        <section className="card criterion-main">
          <div className="pc-label">{t('kesp.criterion.justification')}</div>
          <p>{criterion.justification}</p>
          {criterion.criterion_improvement_tip && (
            <div className="criterion-note">
              <div className="label">{t('kesp.criterion.criterionMentoring')}</div>
              {criterion.criterion_improvement_tip}
            </div>
          )}
        </section>

        {(criterion.bad_critiques ?? []).map(/** Handles the callback for this operation. */(weakness, index) => (
          <section key={`${weakness.title}-${index}`} className="card criterion-main">
            <BadCritiqueSection
              criterion={criterion}
              weakness={weakness}
              index={index}
              transcript={transcript}
              feedback={feedback}
            />
          </section>
        ))}

        {(criterion.good_critiques ?? []).map(/** Handles the callback for this operation. */(critique, index) => (
          <section key={`${critique.title}-${index}`} className="card criterion-main">
            <GoodCritiqueSection critique={critique} transcript={transcript} feedback={feedback} />
          </section>
        ))}

        {(criterion.bad_critiques ?? []).length === 0 &&
          (criterion.good_critiques ?? []).length === 0 && (
            <section className="card criterion-main">
              <div className="muted">{t('kesp.criterion.noTips')}</div>
            </section>
          )}
      </div>
    </main>
  );
}
