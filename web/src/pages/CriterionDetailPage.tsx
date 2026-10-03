import { useEffect, useState, useMemo } from 'react';
import { useLocation, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, AlertCircle, ThumbsUp, ThumbsDown, Lightbulb, ChevronRight, CheckCircle, XCircle, MinusCircle, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fetchCall, fetchFeedback, fetchTranscript } from '@/services/firestore';
import type { Call, Feedback, Transcript, Severity, BadCritique, GoodCritique, RubricV2Criterion, RubricV2Status, Breakdown, EvidenceItem } from '@/types';
import { getSeverityDisplayConfig } from '@/lib/severity';
import { cn } from '@/lib/utils';
import { formatDetailTimestamps } from '@/lib/weaknessEvidence';
import { RUBRIC_REFERENCE_AVAILABLE, SECTION_DESCRIPTIONS, GROUP_DESCRIPTIONS, CRITERION_DESCRIPTIONS } from '@/lib/rubricV2Descriptions';
import { parseCoachingTip } from '@/lib/coachingTips';
import { appendReturnTo, getReturnToFromSearch } from '@/lib/returnTo';

// ── Status badge ────────────────────────────────────────────────────────────

const statusConfig: Record<RubricV2Status, { icon: typeof CheckCircle; label: string; className: string }> = {
  "Cumple": { icon: CheckCircle, label: "Cumple", className: "text-green-600 bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800" },
  "No cumple": { icon: XCircle, label: "No cumple", className: "text-red-600 bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800" },
  "No aplica": { icon: MinusCircle, label: "No aplica", className: "text-gray-500 bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700" },
  "No observable": { icon: HelpCircle, label: "No observable", className: "text-gray-400 bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700" },
};

/** Renders the StatusBadge component. */
function StatusBadge({ status }: { status: RubricV2Status }) {
  const config = statusConfig[status] ?? statusConfig["No observable"];
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={cn('text-xs px-2 py-0.5 gap-1', config.className)}>
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}

// ── Score helpers ───────────────────────────────────────────────────────────

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

// ── Severity badge ──────────────────────────────────────────────────────────

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

// ── Structured evidence list (v5) ───────────────────────────────────────────

function EvidenceList({ items }: { items: EvidenceItem[] }) {
  const { t } = useTranslation();
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('scorecard.structuredEvidence')}</p>
      {items.map(/** Handles the callback for this operation. */(ev, idx) => (
        <div key={idx} className="pl-3 border-l-2 border-muted-foreground/30">
          {ev.speaker_display && (
            <span className="text-xs font-medium text-muted-foreground">{ev.speaker_display}: </span>
          )}
          <span className="text-xs italic text-foreground/80">&ldquo;{ev.quote}&rdquo;</span>
        </div>
      ))}
    </div>
  );
}

// ── Breakdown panel (v5) ────────────────────────────────────────────────────

function collectBreakdownEvidence(breakdown?: Breakdown): EvidenceItem[] {
  if (!breakdown) return [];
  const rawItems =
    breakdown.mode === "opportunity"
      ? breakdown.events.flatMap(/** Handles the callback for this operation. */(event) => event.evidence ?? [])
      : breakdown.checks.flatMap(/** Handles the callback for this operation. */(check) => check.evidence ?? []);

  const seen = new Set<string>();
  const deduped: EvidenceItem[] = [];
  for (const item of rawItems) {
    const key = `${item.speaker_label ?? ''}|${item.speaker_display ?? ''}|${item.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

/** Documents the normalizeEvidenceKey behavior. */
function normalizeEvidenceKey(item: EvidenceItem): string {
  const normalize = /** Documents the normalize behavior. */ (value: string | undefined) =>
    (value ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  return [
    normalize(item.quote),
    normalize(item.speaker_label),
    normalize(item.speaker_display),
  ].join('||');
}

/** Documents the getDistinctEvidenceItems behavior. */
function getDistinctEvidenceItems(source: EvidenceItem[] | undefined, alreadyVisible: EvidenceItem[]): EvidenceItem[] {
  const visibleKeys = new Set(alreadyVisible.map(/** Handles the callback for this operation. */(item) => normalizeEvidenceKey(item)));
  return (source ?? []).filter(/** Handles the callback for this operation. */(item) => !visibleKeys.has(normalizeEvidenceKey(item)));
}

// ── Critique cards ──────────────────────────────────────────────────────────

function GoodCritiqueCard({
  critique,
  transcript,
  evidence,
}: {
  critique: GoodCritique;
  transcript: Transcript | null;
  evidence: EvidenceItem[];
}) {
  const hasStructuredEvidence = evidence.length > 0;
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
      <p className="text-sm text-muted-foreground leading-relaxed">{hasStructuredEvidence ? critique.detail : formatDetailTimestamps(critique.detail, transcript)}</p>
      {hasStructuredEvidence && <EvidenceList items={evidence} />}
    </div>
  );
}

/** Renders the BadCritiqueCard component. */
function BadCritiqueCard({
  critique,
  onClick,
  transcript,
  evidence,
}: {
  critique: BadCritique;
  onClick: () => void;
  transcript: Transcript | null;
  evidence: EvidenceItem[];
}) {
  const hasStructuredEvidence = evidence.length > 0;
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
          <p className="text-sm text-muted-foreground leading-relaxed">{hasStructuredEvidence ? critique.detail : formatDetailTimestamps(critique.detail, transcript)}</p>
          {hasStructuredEvidence && <EvidenceList items={evidence} />}
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground mt-1 flex-shrink-0 group-hover:text-red-600 transition-colors" />
      </div>
    </button>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export function CriterionDetailPage() {
  const { t } = useTranslation();
  const {
    id: callId,
    sectionId,
    criterionId,
  } = useParams<{ id: string; sectionId: string; criterionId: string }>();
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

  useEffect(/** Handles the callback for this operation. */() => {
    /** Documents the loadData behavior. */
    async function loadData() {
      if (!callId) { setError('No call ID provided'); setLoading(false); return; }
      try {
        const [callData, feedbackData, transcriptData] = await Promise.all([
          fetchCall(callId),
          fetchFeedback(callId),
          fetchTranscript(callId),
        ]);
        if (!callData) { setError('Call not found'); setLoading(false); return; }
        setCall(callData);
        setFeedback(feedbackData);
        setTranscript(transcriptData);
      } catch (err) {
        console.error('Error loading criterion detail data:', err);
        setError('Error loading data');
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [callId]);

  // Look up criterion from the v2 rubric scorecard
  const criterion: RubricV2Criterion | null = useMemo(/** Handles the callback for this operation. */() => {
    if (!feedback?.rubric_scorecard_v2?.sections || !sectionId || !criterionId) return null;
    const section = feedback.rubric_scorecard_v2.sections.find(/** Handles the callback for this operation. */ s => s.id === sectionId);
    if (!section) return null;
    for (const group of section.groups) {
      const found = group.criteria.find(/** Handles the callback for this operation. */ c => c.id === criterionId);
      if (found) return found;
    }
    return null;
  }, [feedback, sectionId, criterionId]);

  const sectionTitle = feedback?.rubric_scorecard_v2?.sections?.find(/** Handles the callback for this operation. */ s => s.id === sectionId)?.title ?? '';
  const goodCritiques = criterion?.good_critiques ?? [];
  const badCritiques = criterion?.bad_critiques ?? [];
  const improvementTip = criterion?.criterion_improvement_tip;
  const parsedImprovementTip = parseCoachingTip(improvementTip);
  const criterionDesc = criterionId ? CRITERION_DESCRIPTIONS[criterionId] : null;
  const groupId = criterionId?.split(".")[0] ?? "";
  const groupDesc = GROUP_DESCRIPTIONS[groupId];
  const sectionDesc = sectionId ? SECTION_DESCRIPTIONS[sectionId] : null;
  const criterionEvidence = criterion?.evidence?.length
    ? criterion.evidence
    : collectBreakdownEvidence(criterion?.breakdown);
  const goodCritiquesWithEvidence = goodCritiques.map(/** Handles the callback for this operation. */(critique) => ({
    critique,
    visibleEvidence: getDistinctEvidenceItems(critique.evidence, criterionEvidence),
  }));
  const badCritiquesWithEvidence = badCritiques.map(/** Handles the callback for this operation. */(critique) => ({
    critique,
    visibleEvidence: getDistinctEvidenceItems(critique.evidence, criterionEvidence),
  }));

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
        <Button onClick={/** Handles the onClick interaction. */ () => navigate(scorecardPath)}>{t('common.back')}</Button>
      </div>
    );
  }

  if (!feedback || !criterion) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <p className="text-muted-foreground">{t('scorecard.noData')}</p>
        <Button onClick={/** Handles the onClick interaction. */ () => navigate(scorecardPath)}>{t('common.back')}</Button>
      </div>
    );
  }

  const pct = criterion.max_points > 0 ? (criterion.earned_points / criterion.max_points) * 100 : 0;
  const isPartial = criterion.max_points > 0 && criterion.earned_points > 0 && criterion.earned_points < criterion.max_points;

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-card border-b">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={/** Handles the onClick interaction. */ () => navigate(scorecardPath)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('common.back')}
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">{criterion.id}</span>
              <span className="font-medium">{criterion.title}</span>
              <StatusBadge status={criterion.state ?? criterion.status} />
              {isPartial && (
                <Badge
                  variant="outline"
                  className="text-xs px-2 py-0.5 text-amber-700 bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800"
                >
                  {t('scorecard.partial', 'Parcial')}
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {sectionTitle}
              {call?.name && ` \u00B7 ${call.name}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-24 h-2.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', getScoreBarColor(criterion.earned_points, criterion.max_points))}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={cn('font-bold text-lg', getScoreColor(criterion.earned_points, criterion.max_points))}>
            {criterion.earned_points.toFixed(1)} / {criterion.max_points.toFixed(1)}
          </span>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel — Critiques */}
        <div className="w-1/2 border-r overflow-auto">
          <div className="p-5 space-y-6">
            {/* Justification */}
            {criterion.justification && (
              <div className="p-4 rounded-lg border border-border bg-card">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1.5">
                  {t('scorecard.justification')}
                </p>
                <p className="text-sm text-foreground leading-relaxed">{criterion.justification}</p>
              </div>
            )}

            {/* Structured Evidence (agent-facing simplified view) */}
            {criterionEvidence && criterionEvidence.length > 0 && (
              <div className="p-4 rounded-lg border border-border bg-card">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">{t('scorecard.structuredEvidence')}</p>
                <EvidenceList items={criterionEvidence} />
              </div>
            )}

            {/* Good Critiques */}
            {goodCritiques.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <ThumbsUp className="h-4 w-4 text-green-600" />
                  <h3 className="font-semibold text-green-700 dark:text-green-300 text-sm">
                    {t('scorecard.goodCritiques')}
                    <span className="ml-1.5 font-normal text-muted-foreground">({goodCritiques.length})</span>
                  </h3>
                </div>
                <div className="space-y-3">
                  {goodCritiquesWithEvidence.map(/** Handles the callback for this operation. */({ critique, visibleEvidence }, idx) => (
                    <GoodCritiqueCard
                      key={idx}
                      critique={critique}
                      transcript={transcript}
                      evidence={visibleEvidence}
                    />
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
                    {t('scorecard.badCritiques')}
                    <span className="ml-1.5 font-normal text-muted-foreground">({badCritiques.length})</span>
                  </h3>
                </div>
                <div className="space-y-3">
                  {badCritiquesWithEvidence.map(/** Handles the callback for this operation. */({ critique, visibleEvidence }, idx) => (
                    <BadCritiqueCard
                      key={idx}
                      critique={critique}
                      evidence={visibleEvidence}
                      onClick={/** Handles the onClick interaction. */ () =>
                        navigate(
                          appendReturnTo(
                            `/calls/${callId}/scorecard/v2/${sectionId}/${criterionId}/weaknesses/${idx}`,
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
                <p className="text-sm">{t('scorecard.noCritiques')}</p>
              </div>
            )}

            {/* Improvement Tip */}
            {improvementTip && (
              <div className="p-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 space-y-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <Lightbulb className="h-4 w-4 text-amber-600" />
                  <p className="text-xs text-amber-700 dark:text-amber-300 uppercase tracking-wide font-medium">
                    {t('scorecard.improvementTip')}
                  </p>
                </div>

                {parsedImprovementTip.intro && (
                  <p className="text-sm text-amber-900 dark:text-amber-100 leading-relaxed">
                    {parsedImprovementTip.intro}
                  </p>
                )}

                {parsedImprovementTip.whatAgentShouldHaveSaid && (
                  <div className="rounded-lg border border-amber-300/80 dark:border-amber-700 bg-card/70 dark:bg-amber-950/40 p-3">
                    <p className="text-xs text-amber-700 dark:text-amber-300 uppercase tracking-wide mb-1">
                      {t('callDetail.whatShouldHaveSaid', 'Qué debió haber dicho')}
                    </p>
                    <p className="text-sm text-amber-950 dark:text-amber-100 leading-relaxed">
                      {parsedImprovementTip.whatAgentShouldHaveSaid}
                    </p>
                  </div>
                )}

                {parsedImprovementTip.mentorTips.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-amber-700 dark:text-amber-300 uppercase tracking-wide">
                      {t('callDetail.mentorTips', 'Mentor tips')}
                    </p>
                    <div className="grid gap-2">
                      {parsedImprovementTip.mentorTips.map(/** Handles the callback for this operation. */(tip, idx) => (
                        <div
                          key={`${idx}-${tip.slice(0, 24)}`}
                          className="rounded-lg border border-amber-300/80 dark:border-amber-700 bg-card/70 dark:bg-amber-950/40 p-3"
                        >
                          <div className="flex gap-2">
                            <span className="text-xs font-semibold text-amber-700 dark:text-amber-300 mt-0.5">
                              {idx + 1}.
                            </span>
                            <p className="text-sm text-amber-950 dark:text-amber-100 leading-relaxed">
                              {tip}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {parsedImprovementTip.remainder && (
                  <p className="text-sm text-amber-900 dark:text-amber-100 leading-relaxed">
                    {parsedImprovementTip.remainder}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Panel — Native Rubric Reference */}
        <div className="w-1/2 bg-muted overflow-auto p-5 space-y-4">
          {/* Breadcrumb */}
          <div className="text-xs text-muted-foreground">
            {sectionDesc?.title ?? sectionId} &gt; {groupDesc?.title ?? groupId} &gt; {criterionDesc?.title ?? criterionId}
          </div>

          {!RUBRIC_REFERENCE_AVAILABLE && <p className="text-sm text-muted-foreground">{t('scorecard.referenceUnavailable')}</p>}
          {/* Criterion description */}
          {criterionDesc && (
            <div className="p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-mono text-sm text-blue-600 dark:text-blue-400">{criterionDesc.id}</span>
                <span className="font-semibold text-blue-900 dark:text-blue-100">{criterionDesc.title}</span>
              </div>
              <p className="text-sm text-blue-800 dark:text-blue-200 leading-relaxed italic">
                &ldquo;{criterionDesc.description}&rdquo;
              </p>
            </div>
          )}

          {/* Group context */}
          {groupDesc && (
            <div className="p-3 rounded-lg border border-border bg-card">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{t('scorecard.group')}</p>
              <p className="text-sm font-medium">{groupDesc.id}. {groupDesc.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{groupDesc.description}</p>
            </div>
          )}

          {/* Section context */}
          {sectionDesc && (
            <div className="p-3 rounded-lg border border-border bg-card">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{t('scorecard.section')}</p>
              <p className="text-sm font-medium">{sectionDesc.id}. {sectionDesc.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{sectionDesc.description}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CriterionDetailPage;
