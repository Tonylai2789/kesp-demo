import { useEffect, useState, useMemo } from 'react';
import { useLocation, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileText, AlertCircle, ThumbsUp, ThumbsDown, Lightbulb, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fetchCall, fetchFeedback, fetchTranscript } from '@/services/firestore';
import type { Call, Feedback, Transcript, Severity, BadCritique, GoodCritique, RubricScorecardSubsection } from '@/types';
import { getSeverityDisplayConfig } from '@/lib/severity';
import { cn } from '@/lib/utils';
import { formatDetailTimestamps } from '@/lib/weaknessEvidence';
import { appendReturnTo, getReturnToFromSearch } from '@/lib/returnTo';

/** Documents the getScoreColor behavior. */
function getScoreColor(earned: number, max: number): string {
  if (max === 0) return 'text-muted-foreground';
  const pct = (earned / max) * 100;
  if (pct >= 90) return 'text-green-600';
  if (pct >= 70) return 'text-blue-600';
  if (pct >= 50) return 'text-amber-600';
  return 'text-red-600';
}

/** Documents the getScoreBarColor behavior. */
function getScoreBarColor(earned: number, max: number): string {
  if (max === 0) return 'bg-muted';
  const pct = (earned / max) * 100;
  if (pct >= 90) return 'bg-green-500';
  if (pct >= 70) return 'bg-blue-500';
  if (pct >= 50) return 'bg-amber-500';
  return 'bg-red-500';
}

/** Renders the SeverityBadge component. */
function SeverityBadge({ severity }: { severity: Severity }) {
  const { t } = useTranslation();
  const entry = getSeverityDisplayConfig(severity);
  if (!entry) {
    return <Badge variant="outline" className="text-xs px-2 py-0.5">{String(severity)}</Badge>;
  }
  const { icon: Icon, className } = entry;

  return (
    <Badge variant="outline" className={cn('text-xs px-2 py-0.5', className)}>
      <Icon className="h-3 w-3 mr-1" />
      {t(`callDetail.${severity}`)}
    </Badge>
  );
}

/** Renders the GoodCritiqueCard component. */
function GoodCritiqueCard({ critique, transcript }: { critique: GoodCritique; transcript: Transcript | null }) {
  return (
    <div className="p-4 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950">
      <div className="flex items-center gap-2 mb-1.5">
        <h4 className="font-semibold text-green-800 dark:text-green-200 text-sm">{critique.title}</h4>
        {critique.category && (
          <Badge variant="outline" className="text-xs px-1.5 py-0 border-green-300 dark:border-green-700 text-green-600 dark:text-green-400">
            {critique.category}
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed">{formatDetailTimestamps(critique.detail, transcript)}</p>
    </div>
  );
}

/** Renders the BadCritiqueCard component. */
function BadCritiqueCard({ critique, onClick, transcript }: { critique: BadCritique; onClick: () => void; transcript: Transcript | null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left p-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950 hover:bg-red-100 dark:hover:bg-red-900 hover:border-red-300 dark:hover:border-red-700 transition-all group"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <h4 className="font-semibold text-red-800 dark:text-red-200 text-sm">{critique.title}</h4>
            <SeverityBadge severity={critique.severity} />
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">{formatDetailTimestamps(critique.detail, transcript)}</p>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground mt-1 flex-shrink-0 group-hover:text-red-600 transition-colors" />
      </div>
    </button>
  );
}

/** Renders the SubsectionCritiquePage component. */
export function SubsectionCritiquePage() {
  const { t } = useTranslation();
  const {
    id: callId,
    sectionIndex: sectionIndexParam,
    subsectionIndex: subsectionIndexParam,
  } = useParams<{ id: string; sectionIndex: string; subsectionIndex: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const [call, setCall] = useState<Call | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const returnTo = getReturnToFromSearch(location.search);
  const scorecardPath = callId
    ? appendReturnTo(`/calls/${callId}/scorecard`, returnTo)
    : returnTo ?? '/calls';

  const sectionIndex = Number.parseInt(sectionIndexParam || '', 10);
  const subsectionIndex = Number.parseInt(subsectionIndexParam || '', 10);

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
      } catch (err) {
        console.error('Error loading subsection critique data:', err);
        setError('Error loading data');
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, [callId]);

  const subsection: RubricScorecardSubsection | null = useMemo(/** Handles the callback for this operation. */() => {
    if (!feedback?.rubric_scorecard?.sections) return null;
    const section = feedback.rubric_scorecard.sections[sectionIndex];
    if (!section?.subsections) return null;
    return section.subsections[subsectionIndex] ?? null;
  }, [feedback, sectionIndex, subsectionIndex]);

  const sectionTitle = feedback?.rubric_scorecard?.sections?.[sectionIndex]?.title ?? '';

  const goodCritiques = subsection?.good_critiques ?? [];
  const badCritiques = subsection?.bad_critiques ?? [];
  const improvementTip = subsection?.subsection_improvement_tip;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error || !call) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <AlertCircle className="h-12 w-12 text-red-500" />
        <p className="text-red-600">{error || 'Call not found'}</p>
        <Button onClick={/** Handles the onClick interaction. */ () => navigate(scorecardPath)}>{t('common.back', 'Volver')}</Button>
      </div>
    );
  }

  if (!feedback || !subsection) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <p className="text-muted-foreground">{t('scorecard.noData', 'Data not available for this subsection.')}</p>
        <Button onClick={/** Handles the onClick interaction. */ () => navigate(scorecardPath)}>{t('common.back', 'Volver')}</Button>
      </div>
    );
  }

  const pct = subsection.max_points > 0 ? (subsection.earned_points / subsection.max_points) * 100 : 0;

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-card border-b">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={/** Handles the onClick interaction. */ () => navigate(scorecardPath)}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('common.back', 'Volver')}
          </Button>

          <div>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <span className="font-medium">{subsection.title}</span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {sectionTitle}
              {call?.name && ` \u00B7 ${call.name}`}
            </div>
          </div>
        </div>

        {/* Subsection Score */}
        <div className="flex items-center gap-3">
          <div className="w-24 h-2.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', getScoreBarColor(subsection.earned_points, subsection.max_points))}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={cn('font-bold text-lg', getScoreColor(subsection.earned_points, subsection.max_points))}>
            {subsection.earned_points.toFixed(1)} / {subsection.max_points.toFixed(1)}
          </span>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel — Critiques */}
        <div className="w-1/2 border-r overflow-auto">
          <div className="p-5 space-y-6">
            {/* Justification */}
            {subsection.justification && (
              <div className="p-4 rounded-lg border border-border bg-card">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1.5">
                  {t('scorecard.justification', 'Justificaci\u00F3n')}
                </p>
                <p className="text-sm text-foreground leading-relaxed">{subsection.justification}</p>
              </div>
            )}

            {/* Good Critiques */}
            {goodCritiques.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <ThumbsUp className="h-4 w-4 text-green-600" />
                  <h3 className="font-semibold text-green-700 dark:text-green-300 text-sm">
                    {t('scorecard.goodCritiques', 'Fortalezas')}
                    <span className="ml-1.5 font-normal text-muted-foreground">({goodCritiques.length})</span>
                  </h3>
                </div>
                <div className="space-y-3">
                  {goodCritiques.map(/** Handles the callback for this operation. */(critique, idx) => (
                    <GoodCritiqueCard key={idx} critique={critique} transcript={transcript} />
                  ))}
                </div>
              </div>
            )}

            {/* Bad Critiques */}
            {badCritiques.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <ThumbsDown className="h-4 w-4 text-red-600" />
                  <h3 className="font-semibold text-red-700 dark:text-red-300 text-sm">
                    {t('scorecard.badCritiques', '\u00C1reas de mejora')}
                    <span className="ml-1.5 font-normal text-muted-foreground">({badCritiques.length})</span>
                  </h3>
                </div>
                <div className="space-y-3">
                  {badCritiques.map(/** Handles the callback for this operation. */(critique, idx) => (
                    <BadCritiqueCard
                      key={idx}
                      critique={critique}
                      onClick={/** Handles the onClick interaction. */ () =>
                        navigate(
                          appendReturnTo(
                            `/calls/${callId}/scorecard/${sectionIndex}/${subsectionIndex}/weaknesses/${idx}`,
                            returnTo
                          )
                        )
                      }
                      transcript={transcript}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Empty state */}
            {goodCritiques.length === 0 && badCritiques.length === 0 && (
              <div className="p-6 text-center text-muted-foreground">
                <p className="text-sm">{t('scorecard.noCritiques', 'No se encontraron observaciones espec\u00EDficas para esta subsecci\u00F3n.')}</p>
              </div>
            )}

            {/* Subsection Improvement Tip */}
            {improvementTip && (
              <div className="p-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950">
                <div className="flex items-center gap-2 mb-1.5">
                  <Lightbulb className="h-4 w-4 text-amber-600" />
                  <p className="text-xs text-amber-700 dark:text-amber-300 uppercase tracking-wide font-medium">
                    {t('scorecard.improvementTip', 'Consejo de mejora')}
                  </p>
                </div>
                <p className="text-sm text-amber-900 dark:text-amber-100 leading-relaxed">{improvementTip}</p>
              </div>
            )}
          </div>
        </div>

        {/* Right Panel — Rubric Reference */}
        <div className="w-1/2 bg-muted">
          {subsection.rubric_ref ? (
            <div className="h-full overflow-auto p-5">
              <div className="p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950">
                <p className="text-xs text-blue-700 dark:text-blue-300 font-medium mb-2">
                  {subsection.rubric_ref.section_path}
                </p>
                <p className="text-sm text-blue-900 dark:text-blue-100 italic leading-relaxed">
                  &ldquo;{subsection.rubric_ref.subsection_text}&rdquo;
                </p>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p>{t('scorecard.noRubricRef', 'No hay referencia de r\u00FAbrica disponible.')}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SubsectionCritiquePage;
