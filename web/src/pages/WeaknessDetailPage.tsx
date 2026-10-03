import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchCall, fetchFeedback, fetchTranscript } from '@/services/firestore';
import type { Call, EvidenceItem, Feedback, Transcript, TranscriptSegment } from '@/types';
import { getSeverityDisplayConfig } from '@/lib/severity';
import { cn } from '@/lib/utils';
import { buildWeaknessEvidenceGroups, formatDetailTimestamps, formatRubricPath, formatTimestamp, parseEvidenceAnchors } from '@/lib/weaknessEvidence';
import { buildCriterionPath } from '@/lib/rubricV2Descriptions';
import { getWeaknessActionPlan, localizeText } from '@/lib/managementAction';
import { appendReturnTo, getReturnToFromSearch } from '@/lib/returnTo';

/** Documents the formatDuration behavior. */
function formatDuration(seconds: number): string {
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface SegmentSpeakerContext {
  agentSpeaker?: string;
  agentName?: string | null;
  customerSpeaker?: string;
  customerName?: string | null;
  t: (key: string, fallback?: string) => string;
}

/** Documents the formatSegmentSpeakerLabel behavior. */
function formatSegmentSpeakerLabel(segment: TranscriptSegment, context: SegmentSpeakerContext): string {
  const speaker = segment.speaker;
  if (context.agentSpeaker && speaker === context.agentSpeaker) {
    const name = context.agentName?.trim() || context.t('callDetail.agent');
    return `${name} (${speaker})`;
  }
  if (context.customerSpeaker && speaker === context.customerSpeaker) {
    const name = context.customerName?.trim() || context.t('callDetail.customer');
    return `${name} (${speaker})`;
  }
  return `speaker ${speaker}`;
}

/** Documents the formatEvidenceSpeakerLabel behavior. */
function formatEvidenceSpeakerLabel(
  evidence: EvidenceItem,
  context: SegmentSpeakerContext
): string | null {
  const normalizedDisplay = (evidence.speaker_display ?? '').trim();
  const normalizedLabel = (evidence.speaker_label ?? '').trim();

  if (context.agentSpeaker && normalizedLabel === context.agentSpeaker) {
    const name = context.agentName?.trim() || context.t('callDetail.agent');
    return `${name} (${normalizedLabel})`;
  }
  if (context.customerSpeaker && normalizedLabel === context.customerSpeaker) {
    const name = context.customerName?.trim() || context.t('callDetail.customer');
    return `${name} (${normalizedLabel})`;
  }
  if (/^agente$/i.test(normalizedDisplay)) {
    const name = context.agentName?.trim() || context.t('callDetail.agent');
    return normalizedLabel ? `${name} (${normalizedLabel})` : name;
  }
  if (/^cliente$/i.test(normalizedDisplay)) {
    const name = context.customerName?.trim() || context.t('callDetail.customer');
    return normalizedLabel ? `${name} (${normalizedLabel})` : name;
  }

  const fallback = normalizedDisplay || normalizedLabel;
  if (!fallback) return null;
  return normalizedDisplay && normalizedLabel && normalizedDisplay !== normalizedLabel
    ? `${normalizedDisplay} (${normalizedLabel})`
    : fallback;
}

/** Renders the WeaknessDetailPage component. */
export function WeaknessDetailPage() {
  const {
    id: callId,
    weaknessIndex: weaknessIndexParam,
    sectionIndex: sectionIndexParam,
    subsectionIndex: subsectionIndexParam,
    critiqueIndex: critiqueIndexParam,
    // V2 route params
    sectionId: sectionIdParam,
    criterionId: criterionIdParam,
  } = useParams<{
    id: string;
    weaknessIndex: string;
    sectionIndex: string;
    subsectionIndex: string;
    critiqueIndex: string;
    sectionId: string;
    criterionId: string;
  }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, i18n } = useTranslation();

  // Determine route mode: v2 criterion route, legacy subsection route, or flat weakness route
  const isV2Route = sectionIdParam !== undefined && criterionIdParam !== undefined && critiqueIndexParam !== undefined;
  const isSubsectionRoute = !isV2Route && sectionIndexParam !== undefined && subsectionIndexParam !== undefined && critiqueIndexParam !== undefined;

  const [call, setCall] = useState<Call | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const parsedWeaknessIndex = Number.parseInt(weaknessIndexParam || '', 10);
  const isValidWeaknessIndexParam = !isSubsectionRoute && !isV2Route && Number.isInteger(parsedWeaknessIndex) && parsedWeaknessIndex >= 0;
  const parsedSectionIndex = Number.parseInt(sectionIndexParam || '', 10);
  const parsedSubsectionIndex = Number.parseInt(subsectionIndexParam || '', 10);
  const parsedCritiqueIndex = Number.parseInt(critiqueIndexParam || '', 10);
  const isValidSubsectionRoute = isSubsectionRoute &&
    Number.isInteger(parsedSectionIndex) && parsedSectionIndex >= 0 &&
    Number.isInteger(parsedSubsectionIndex) && parsedSubsectionIndex >= 0 &&
    Number.isInteger(parsedCritiqueIndex) && parsedCritiqueIndex >= 0;
  const isValidV2Route = isV2Route && typeof sectionIdParam === 'string' && typeof criterionIdParam === 'string' &&
    Number.isInteger(parsedCritiqueIndex) && parsedCritiqueIndex >= 0;
  const returnTo = getReturnToFromSearch(location.search);
  const backPath = useMemo(/** Handles the callback for this operation. */() => {
    if (!callId) {
      return returnTo ?? '/calls';
    }
    if (isValidV2Route) {
      return appendReturnTo(`/calls/${callId}/scorecard/v2/${sectionIdParam}/${criterionIdParam}`, returnTo);
    }
    if (isValidSubsectionRoute) {
      return appendReturnTo(`/calls/${callId}/scorecard/${sectionIndexParam}/${subsectionIndexParam}`, returnTo);
    }
    return appendReturnTo(`/calls/${callId}`, returnTo);
  }, [
    callId,
    criterionIdParam,
    isValidSubsectionRoute,
    isValidV2Route,
    returnTo,
    sectionIdParam,
    sectionIndexParam,
    subsectionIndexParam,
  ]);

  useEffect(/** Handles the callback for this operation. */() => {
    /** Documents the loadData behavior. */
    async function loadData() {
      if (!callId) {
        setError('No call ID provided');
        setLoading(false);
        return;
      }

      try {
        const [callData, feedbackData, transcriptData] = await Promise.all([
          fetchCall(callId),
          fetchFeedback(callId),
          fetchTranscript(callId),
        ]);

        if (!callData) {
          setError('Call not found');
          setLoading(false);
          return;
        }

        setCall(callData);
        setFeedback(feedbackData);
        setTranscript(transcriptData);
      } catch (loadError) {
        console.error('Failed to load weakness detail page data:', loadError);
        setError('Error loading data');
      } finally {
        setLoading(false);
      }
    }

    void loadData();
  }, [callId]);

  const selectedWeakness = useMemo(/** Handles the callback for this operation. */() => {
    if (!feedback) return null;

    // V2 route: look up criterion by ID in rubric_scorecard_v2
    if (isValidV2Route) {
      const section = feedback.rubric_scorecard_v2?.sections?.find(/** Handles the callback for this operation. */ s => s.id === sectionIdParam);
      if (!section) return null;
      let foundCriterion = null;
      for (const group of section.groups) {
        const c = group.criteria.find(/** Handles the callback for this operation. */ cr => cr.id === criterionIdParam);
        if (c) { foundCriterion = c; break; }
      }
      if (!foundCriterion) return null;
      const critique = foundCriterion.bad_critiques?.[parsedCritiqueIndex];
      if (!critique) return null;
      return {
        title: critique.title,
        detail: critique.detail,
        severity: critique.severity,
        category: critique.category,
        weakness_improvement_tip: critique.weakness_improvement_tip,
        ...(critique.evidence ? { evidence: critique.evidence } : {}),
      } as import('@/types').WeaknessItem;
    }

    // Legacy subsection route
    if (isValidSubsectionRoute) {
      const section = feedback.rubric_scorecard?.sections?.[parsedSectionIndex];
      const subsection = section?.subsections?.[parsedSubsectionIndex];
      const critique = subsection?.bad_critiques?.[parsedCritiqueIndex];
      if (!critique) return null;
      return {
        title: critique.title,
        detail: critique.detail,
        severity: critique.severity,
        category: critique.category,
        weakness_improvement_tip: critique.weakness_improvement_tip,
        rubric_ref: subsection?.rubric_ref,
      } as import('@/types').WeaknessItem;
    }

    // Flat weakness route
    if (!isValidWeaknessIndexParam) return null;
    return feedback.agent_weaknesses[parsedWeaknessIndex] ?? null;
  }, [feedback, isValidV2Route, isValidSubsectionRoute, isValidWeaknessIndexParam, parsedWeaknessIndex, parsedSectionIndex, parsedSubsectionIndex, parsedCritiqueIndex, sectionIdParam, criterionIdParam]);

  const selectedWeaknessRubricPath = isValidV2Route && sectionIdParam && criterionIdParam
    ? buildCriterionPath(sectionIdParam, criterionIdParam)
    : selectedWeakness
      ? formatRubricPath(selectedWeakness.rubric_ref)
      : '';

  const parsedAnchors = selectedWeakness
    ? parseEvidenceAnchors(selectedWeakness.detail || '')
    : [];

  const selectedWeaknessEvidence = selectedWeakness
    ? buildWeaknessEvidenceGroups(selectedWeakness, transcript)
    : [];

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-52" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-[520px] w-full" />
      </div>
    );
  }

  if (error || !call) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={/** Handles the onClick interaction. */ () => navigate(backPath)}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('common.back')}
        </Button>
        <Card>
          <CardContent className="py-10 text-center text-red-600">
            {error || 'Call not found'}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!feedback) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={/** Handles the onClick interaction. */ () => navigate(backPath)}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('common.back')}
        </Button>
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {t('callDetail.noFeedback')}
          </CardContent>
        </Card>
      </div>
    );
  }

  if ((!isValidWeaknessIndexParam && !isValidSubsectionRoute && !isValidV2Route) || !selectedWeakness) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={/** Handles the onClick interaction. */ () => navigate(backPath)}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('common.back')}
        </Button>
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {t('callDetail.invalidWeakness', 'Requested weakness was not found.')}
          </CardContent>
        </Card>
      </div>
    );
  }

  const speakerContext: SegmentSpeakerContext = {
    agentSpeaker: feedback.agent_speaker,
    agentName: feedback.agent_name || call.salesAgentName || null,
    customerSpeaker: feedback.customer_speaker,
    customerName: feedback.customer_name,
    t: /** Documents the t behavior. */ (key: string, fallback?: string) => t(key, fallback || ''),
  };

  const actionPlan = getWeaknessActionPlan(feedback, selectedWeakness);
  const severityDisplay = getSeverityDisplayConfig(selectedWeakness.severity);
  const normalizeComparableText = /** Documents the normalizeComparableText behavior. */ (value: string) =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const critiqueText = formatDetailTimestamps(selectedWeakness.detail, transcript);
  const whatHappenedText = localizeText(actionPlan?.whatWentWrong, i18n.language);
  const shouldShowWhatHappened =
    Boolean(whatHappenedText) &&
    normalizeComparableText(whatHappenedText) !== normalizeComparableText(critiqueText);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button variant="ghost" onClick={/** Handles the onClick interaction. */ () => navigate(backPath)} className="-ml-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('common.back')}
          </Button>
          <h1 className="text-2xl font-bold mt-1">{t('callDetail.weaknessDetailTitle', 'Improvement Criteria Detail')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {(call.name || call.id)}
            {call.duration ? ` · ${formatDuration(call.duration)}` : ''}
          </p>
        </div>
      </div>

      <Card className="border-red-200 dark:border-red-800">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="p-4 rounded-lg border border-border bg-card">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                  {t('callDetail.selectedCritique', 'Selected Critique')}
                </p>
                <p className="text-base font-semibold text-red-800 dark:text-red-300">{selectedWeakness.title}</p>
              </div>

              <div className="p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950">
                <p className="text-xs text-blue-700 dark:text-blue-300 uppercase tracking-wide mb-1">
                  {t('callDetail.rubricReference', 'Rubric Reference')}
                </p>
                <p className="text-sm text-blue-900 dark:text-blue-100 leading-relaxed">
                  {selectedWeaknessRubricPath || t('callDetail.rubricMissing', 'No rubric reference found.')}
                </p>
              </div>

              <div className="p-4 rounded-lg border border-border bg-card">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    {t('callDetail.critique', 'Critique')}
                  </p>
                  <Badge
                    variant="outline"
                    className={cn('capitalize', severityDisplay?.className)}
                  >
                    {t(`callDetail.${selectedWeakness.severity}`)}
                  </Badge>
                </div>
                <p className="text-sm text-foreground leading-relaxed">{formatDetailTimestamps(selectedWeakness.detail, transcript)}</p>
              </div>

              <div className="p-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 space-y-4">
                <p className="text-xs text-amber-700 dark:text-amber-300 uppercase tracking-wide">
                  {t('callDetail.managementActionTitle', 'Management Action')}
                </p>

                {shouldShowWhatHappened ? (
                  <div className="rounded-lg border border-amber-300/80 dark:border-amber-700 bg-card/70 dark:bg-amber-950/40 p-3 space-y-1">
                    <p className="text-xs text-amber-700 dark:text-amber-300 uppercase tracking-wide">
                      {t('callDetail.whatHappened', 'Qué pasó')}
                    </p>
                    <p className="text-sm text-amber-950 dark:text-amber-100 leading-relaxed">
                      {whatHappenedText || t('callDetail.weaknessTipMissing', 'No specific recommendation was returned for this weakness.')}
                    </p>
                  </div>
                ) : null}

                {localizeText(actionPlan?.whyItHurts, i18n.language) ? (
                  <div className="rounded-lg border border-amber-300/80 dark:border-amber-700 bg-card/70 dark:bg-amber-950/40 p-3 space-y-1">
                    <p className="text-xs text-amber-700 dark:text-amber-300 uppercase tracking-wide">
                      {t('callDetail.whyItHurts', 'Por qué afecta la venta')}
                    </p>
                    <p className="text-sm text-amber-950 dark:text-amber-100 leading-relaxed">
                      {localizeText(actionPlan?.whyItHurts, i18n.language)}
                    </p>
                  </div>
                ) : null}

                {localizeText(actionPlan?.whatToChangeNextCall, i18n.language) ? (
                  <div className="rounded-lg border border-amber-300/80 dark:border-amber-700 bg-card/70 dark:bg-amber-950/40 p-3 space-y-1">
                    <p className="text-xs text-amber-700 dark:text-amber-300 uppercase tracking-wide">
                      {t('callDetail.whatToChangeNextCall', 'Qué debes cambiar en la próxima llamada')}
                    </p>
                    <p className="text-sm text-amber-950 dark:text-amber-100 leading-relaxed">
                      {localizeText(actionPlan?.whatToChangeNextCall, i18n.language)}
                    </p>
                  </div>
                ) : null}

                {actionPlan?.whatToSayNext?.length ? (
                  <div className="space-y-2">
                    <p className="text-xs text-amber-700 dark:text-amber-300 uppercase tracking-wide">
                      {t('callDetail.whatShouldHaveSaidSection', 'Qué debes decir en la próxima llamada')}
                    </p>
                    <div className="grid gap-2">
                      {actionPlan.whatToSayNext.map(/** Handles the callback for this operation. */(item, idx) => (
                        <div
                          key={`${idx}-${item.es}-${item.en}`}
                          className="rounded-lg border border-amber-300/80 dark:border-amber-700 bg-card/70 dark:bg-amber-950/40 p-3"
                        >
                          <p className="text-sm text-amber-950 dark:text-amber-100 leading-relaxed">
                            {localizeText(item, i18n.language)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {actionPlan?.whatToTrain?.length ? (
                  <div className="space-y-2">
                    <p className="text-xs text-amber-700 dark:text-amber-300 uppercase tracking-wide">
                      {t('callDetail.whatToTrainSection', 'Qué debes entrenar')}
                    </p>
                    <div className="grid gap-2">
                      {actionPlan.whatToTrain.map(/** Handles the callback for this operation. */(item, idx) => (
                        <div
                          key={`${idx}-${item.es}-${item.en}`}
                          className="rounded-lg border border-amber-300/80 dark:border-amber-700 bg-card/70 dark:bg-amber-950/40 p-3"
                        >
                          <p className="text-sm text-amber-950 dark:text-amber-100 leading-relaxed">
                            {localizeText(item, i18n.language)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-3">
                {selectedWeakness.evidence && selectedWeakness.evidence.length > 0
                  ? t('callDetail.structuredEvidence', 'Supporting Evidence')
                  : t('callDetail.referencedTranscriptSegments', 'Referenced Transcript Segments')}
              </p>

              {/* V5 path: structured evidence items */}
              {selectedWeakness.evidence && selectedWeakness.evidence.length > 0 ? (
                <div className="space-y-3 max-h-[540px] overflow-y-auto pr-1">
                  {selectedWeakness.evidence.map(/** Handles the callback for this operation. */(ev: EvidenceItem, evIdx: number) => (
                    <div key={evIdx} className="rounded-lg border border-border bg-card p-3 space-y-1">
                      <p className="text-sm italic text-foreground leading-relaxed">"{ev.quote}"</p>
                      {formatEvidenceSpeakerLabel(ev, speakerContext) && (
                        <p className="text-xs text-muted-foreground">
                          {formatEvidenceSpeakerLabel(ev, speakerContext)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : !transcript ? (
                <p className="text-sm text-muted-foreground">
                  {t('callDetail.transcriptNotLoaded', 'Transcript is not loaded, so referenced segments cannot be shown.')}
                </p>
              ) : parsedAnchors.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('callDetail.noEvidenceFound', 'This critique does not include parseable evidence anchors in the detail.')}
                </p>
              ) : (
                <div className="space-y-4 max-h-[540px] overflow-y-auto pr-1">
                  {selectedWeaknessEvidence.map(/** Handles the callback for this operation. */(group, groupIndex) => (
                    <div key={groupIndex} className="rounded-lg border border-border bg-card p-3 space-y-2">
                      <p className="text-sm font-medium text-foreground">
                        {formatTimestamp(group.anchor.startSec)} - {formatTimestamp(group.anchor.endSec)}
                        {group.anchor.speakerDisplay ? ` | ${group.anchor.speakerDisplay}` : ''}
                        {group.anchor.speakerLabel ? ` (speaker ${group.anchor.speakerLabel})` : ''}
                      </p>
                      {group.anchor.quote && (
                        <p className="text-sm italic text-muted-foreground">"{group.anchor.quote}"</p>
                      )}

                      {group.segments.length > 0 ? (
                        <div className="space-y-2">
                          {group.segments.map(/** Handles the callback for this operation. */(segment) => (
                            <div key={segment.id} className="rounded border border-border bg-muted p-2">
                              <p className="text-sm font-medium text-foreground">
                                {formatSegmentSpeakerLabel(segment, speakerContext)}
                              </p>
                              <p className="text-xs text-muted-foreground mb-1">
                                {formatTimestamp(segment.start)} - {formatTimestamp(segment.end)}
                              </p>
                              <p className="text-sm text-foreground leading-relaxed">{segment.text}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {t('callDetail.noMatchingSegments', 'No exact segments were found for this evidence range.')}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
