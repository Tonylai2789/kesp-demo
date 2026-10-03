import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ThumbsUp, ThumbsDown, CheckCircle, XCircle, HelpCircle, Clock, MessageSquare, Lightbulb, BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import type { Feedback, FeedbackItem, WeaknessItem, Severity, PerformanceTier, Transcript, GoodCritique, BadCritique } from '@/types';
import { getSeverityDisplayConfig } from '@/lib/severity';
import { cn } from '@/lib/utils';
import { formatDetailTimestamps } from '@/lib/weaknessEvidence';
import { detectFeedbackVersion } from '@/lib/feedbackVersion';
import { getFeedbackManagementActionPlan, localizeText } from '@/lib/managementAction';
import { appendReturnTo, getReturnToFromSearch } from '@/lib/returnTo';

interface FeedbackViewerProps {
  feedback: Feedback | null;
  loading?: boolean;
  callId?: string;
  transcript?: Transcript | null;
  agentNameFallback?: string | null;
  selectedWeaknessIndex?: number;
  onWeaknessSelect?: (weakness: WeaknessItem, index: number) => void;
}

interface FeedbackCardProps {
  item: FeedbackItem | WeaknessItem;
  type: 'strength' | 'weakness';
  index: number;
  selected?: boolean;
  onClick?: () => void;
  transcript?: Transcript | null;
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

/** Renders the FeedbackCard component. */
function FeedbackCard({ item, type, index, selected = false, onClick, transcript }: FeedbackCardProps) {
  const isStrength = type === 'strength';
  const weaknessItem = type === 'weakness' ? (item as WeaknessItem) : null;

  const cardContent = (
    <div className="flex items-start gap-3">
      <div
        className={cn(
          'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
          isStrength ? 'bg-green-100 dark:bg-green-900' : 'bg-red-100 dark:bg-red-900'
        )}
      >
        <span
          className={cn(
            'text-sm font-bold',
            isStrength ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'
          )}
        >
          {index + 1}
        </span>
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <h4
            className={cn(
              'font-semibold',
              isStrength ? 'text-green-800 dark:text-green-200' : 'text-red-800 dark:text-red-200'
            )}
          >
            {item.title}
          </h4>
          {weaknessItem?.severity && (
            <SeverityBadge severity={weaknessItem.severity} />
          )}
        </div>
        <p className="text-sm text-muted-foreground">{formatDetailTimestamps(item.detail, transcript)}</p>
      </div>
    </div>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'w-full text-left p-4 rounded-lg border transition-all',
          isStrength
            ? 'bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900 hover:border-green-300 dark:hover:border-green-700'
            : 'bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900 hover:border-red-300 dark:hover:border-red-700',
          selected && 'ring-2 ring-red-500 ring-offset-1'
        )}
      >
        {cardContent}
      </button>
    );
  }

  return (
    <div
      className={cn(
        'p-4 rounded-lg border',
        isStrength ? 'bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800'
      )}
    >
      {cardContent}
    </div>
  );
}

/** Renders the LoanStatusBadge component. */
function LoanStatusBadge({ status }: { status: Feedback['loan_completed'] }) {
  const { t } = useTranslation();

  const config = {
    yes: {
      icon: CheckCircle,
      label: t('callDetail.yes'),
      className: 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 border-green-300 dark:border-green-700',
    },
    no: {
      icon: XCircle,
      label: t('callDetail.no'),
      className: 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 border-red-300 dark:border-red-700',
    },
    in_progress: {
      icon: Clock,
      label: t('callDetail.inProgress'),
      className: 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-700',
    },
    unclear: {
      icon: HelpCircle,
      label: t('callDetail.unclear'),
      className: 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700',
    },
  };

  const entry = config[status as keyof typeof config];
  if (!entry) {
    return <Badge variant="outline" className="text-sm px-3 py-1">{String(status)}</Badge>;
  }
  const { icon: Icon, label, className } = entry;

  return (
    <Badge variant="outline" className={cn('text-sm px-3 py-1', className)}>
      <Icon className="h-4 w-4 mr-1" />
      {label}
    </Badge>
  );
}

/** Renders the ScoreDisplay component. */
function ScoreDisplay({
  score,
  tier,
  callId,
  hasScorecard,
  scorecardPath,
}: {
  score: number;
  tier: PerformanceTier;
  callId?: string;
  hasScorecard?: boolean;
  scorecardPath?: string;
}) {
  const { t } = useTranslation();

  const getScoreColor = /** Documents the getScoreColor behavior. */ (score: number) => {
    if (score >= 90) return 'text-green-600';
    if (score >= 70) return 'text-blue-600';
    if (score >= 50) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getProgressColor = /** Documents the getProgressColor behavior. */ (score: number) => {
    if (score >= 90) return 'bg-green-500';
    if (score >= 70) return 'bg-blue-500';
    if (score >= 50) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  const getTierBadgeClass = /** Documents the getTierBadgeClass behavior. */ (tier: PerformanceTier) => {
    switch (tier) {
      case 'excellent':
        return 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 border-green-300 dark:border-green-700';
      case 'good':
        return 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-700';
      case 'needs_improvement':
        return 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700';
      case 'poor':
        return 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 border-red-300 dark:border-red-700';
    }
  };

  const scoreContent = (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <span className={cn('text-3xl font-bold', getScoreColor(score))}>
          {score}
        </span>
        <span className="text-muted-foreground text-sm">/100</span>
      </div>
      <div className="flex-1 max-w-[200px]">
        <Progress
          value={score}
          className="h-2"
          style={{
            ['--progress-background' as string]: getProgressColor(score).replace('bg-', 'var(--'),
          }}
        />
      </div>
      <Badge variant="outline" className={cn('text-sm px-3 py-1', getTierBadgeClass(tier))}>
        {t(`callDetail.${tier}`)}
      </Badge>
      {callId && hasScorecard && (
        <BarChart3 className="h-4 w-4 text-muted-foreground" />
      )}
    </div>
  );

  // Make score clickable if we have a callId and scorecard
  if (callId && hasScorecard) {
    return (
      <Link
        to={scorecardPath ?? `/calls/${callId}/scorecard`}
        className="block hover:bg-muted rounded-lg p-2 -m-2 transition-colors"
        title={t('callDetail.viewScorecard')}
      >
        {scoreContent}
      </Link>
    );
  }

  return scoreContent;
}

/** Renders the FollowupMessage component. */
function FollowupMessage({ message }: { message: string }) {
  const { t } = useTranslation();

  return (
    <Card className="border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center text-blue-700 dark:text-blue-300 text-base">
          <MessageSquare className="h-4 w-4 mr-2" />
          {t('callDetail.suggestedFollowup')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-blue-900 dark:text-blue-100 italic">"{message}"</p>
      </CardContent>
    </Card>
  );
}

/** Renders the MentorshipTip component. */
function MentorshipTip({ tip }: { tip: string }) {
  const { t } = useTranslation();

  return (
    <Card className="border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center text-amber-700 dark:text-amber-300 text-base">
          <Lightbulb className="h-4 w-4 mr-2" />
          {t('callDetail.mentorshipTip')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-amber-900 dark:text-amber-100">{tip}</p>
      </CardContent>
    </Card>
  );
}

/** Renders the ManagementActionSummary component. */
function ManagementActionSummary({ feedback }: { feedback: Feedback }) {
  const { t, i18n } = useTranslation();
  const actionPlan = getFeedbackManagementActionPlan(feedback);
  if (!actionPlan) {
    return null;
  }

  const callSynopsis = actionPlan.callSynopsis;
  const whatWentWrong = localizeText(callSynopsis?.whatWentWrong, i18n.language);
  const whatToDoDifferently = localizeText(callSynopsis?.whatToDoDifferently, i18n.language);
  const whatToSay = localizeText(callSynopsis?.whatToSay, i18n.language);
  const whatToTrain = localizeText(callSynopsis?.whatToTrain, i18n.language);

  return (
    <Card className="border-slate-200 dark:border-slate-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {t('callDetail.managementActionTitle', { defaultValue: 'Management Action' })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {whatWentWrong && (
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('callDetail.whatWentWrongSummary', { defaultValue: 'Qué salió mal' })}
            </p>
            <p className="text-sm text-foreground leading-relaxed">{whatWentWrong}</p>
          </div>
        )}

        {whatToDoDifferently && (
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('callDetail.whatToDoDifferently', { defaultValue: 'Qué hacer distinto' })}
            </p>
            <p className="text-sm text-foreground leading-relaxed">{whatToDoDifferently}</p>
          </div>
        )}

        {whatToSay && (
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('callDetail.whatToSay', { defaultValue: 'Qué debes decir en la próxima llamada' })}
            </p>
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              {whatToSay}
            </div>
          </div>
        )}

        {whatToTrain && (
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('callDetail.whatToTrainSection', { defaultValue: 'Qué debes entrenar' })}
            </p>
            <Badge variant="outline">{whatToTrain}</Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Renders the FeedbackSkeleton component. */
function FeedbackSkeleton() {
  return (
    <div className="space-y-6">
      {/* Score skeleton */}
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-16" />
        <Skeleton className="h-2 w-48" />
        <Skeleton className="h-6 w-24" />
      </div>
      {/* Status skeleton */}
      <div className="flex items-center gap-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-6 w-24" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <Skeleton className="h-6 w-24" />
          {[...Array(2)].map(/** Handles the callback for this operation. */(_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <div className="space-y-4">
          <Skeleton className="h-6 w-32" />
          {[...Array(2)].map(/** Handles the callback for this operation. */(_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Renders the FeedbackViewer component. */
export function FeedbackViewer({
  feedback,
  loading,
  callId,
  transcript,
  agentNameFallback,
  selectedWeaknessIndex,
  onWeaknessSelect,
}: FeedbackViewerProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = getReturnToFromSearch(location.search);
  const withReturnTo = /** Documents the withReturnTo behavior. */ (path: string) => appendReturnTo(path, returnTo);

  // All hooks MUST be called before any early returns (React rules of hooks)
  const feedbackVersion = useMemo(/** Handles the callback for this operation. */() => detectFeedbackVersion(feedback), [feedback]);

  // Legacy TMK embedded critiques
  const hasEmbeddedCritiques = useMemo(/** Handles the callback for this operation. */() => {
    if (feedbackVersion !== "legacy_tmk" || !feedback?.rubric_scorecard?.sections) return false;
    return feedback.rubric_scorecard.sections.some(
      /** Handles the callback for this operation. */
      s => s.subsections?.some(
        /** Handles the callback for this operation. */
        sub => (sub.good_critiques?.length ?? 0) > 0 || (sub.bad_critiques?.length ?? 0) > 0
      )
    );
  }, [feedback, feedbackVersion]);

  const { flatStrengths, flatWeaknesses } = useMemo(/** Handles the callback for this operation. */() => {
    if (!hasEmbeddedCritiques || !feedback?.rubric_scorecard?.sections) {
      return { flatStrengths: [] as { critique: GoodCritique; sectionIndex: number; subsectionIndex: number }[], flatWeaknesses: [] as { critique: BadCritique; sectionIndex: number; subsectionIndex: number }[] };
    }
    const strengths: { critique: GoodCritique; sectionIndex: number; subsectionIndex: number }[] = [];
    const weaknesses: { critique: BadCritique; sectionIndex: number; subsectionIndex: number }[] = [];
    for (const [sIdx, section] of feedback.rubric_scorecard.sections.entries()) {
      for (const [subIdx, sub] of (section.subsections ?? []).entries()) {
        for (const gc of sub.good_critiques ?? []) {
          strengths.push({ critique: gc, sectionIndex: sIdx, subsectionIndex: subIdx });
        }
        for (const bc of sub.bad_critiques ?? []) {
          weaknesses.push({ critique: bc, sectionIndex: sIdx, subsectionIndex: subIdx });
        }
      }
    }
    return { flatStrengths: strengths, flatWeaknesses: weaknesses };
  }, [hasEmbeddedCritiques, feedback]);

  // V2 embedded critiques
  const { flatStrengthsV2, flatWeaknessesV2 } = useMemo(/** Handles the callback for this operation. */() => {
    if (feedbackVersion !== "v2" || !feedback?.rubric_scorecard_v2?.sections) {
      return { flatStrengthsV2: [] as { critique: GoodCritique; sectionId: string; criterionId: string }[], flatWeaknessesV2: [] as { critique: BadCritique; sectionId: string; criterionId: string }[] };
    }
    const strengths: { critique: GoodCritique; sectionId: string; criterionId: string }[] = [];
    const weaknesses: { critique: BadCritique; sectionId: string; criterionId: string }[] = [];
    for (const section of feedback.rubric_scorecard_v2.sections) {
      for (const group of section.groups) {
        for (const criterion of group.criteria) {
          for (const gc of criterion.good_critiques ?? []) {
            strengths.push({ critique: gc, sectionId: section.id, criterionId: criterion.id });
          }
          for (const bc of criterion.bad_critiques ?? []) {
            weaknesses.push({ critique: bc, sectionId: section.id, criterionId: criterion.id });
          }
        }
      }
    }
    return { flatStrengthsV2: strengths, flatWeaknessesV2: weaknesses };
  }, [feedbackVersion, feedback]);

  if (loading) {
    return <FeedbackSkeleton />;
  }

  if (!feedback) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        {t('callDetail.noFeedback')}
      </div>
    );
  }

  const strengths = feedback.agent_strengths ?? [];
  const weaknesses = feedback.agent_weaknesses ?? [];
  const hasScorecard = !!feedback.rubric_scorecard || !!feedback.rubric_scorecard_v2;
  const resolvedAgentName = feedback.agent_name?.trim() || agentNameFallback?.trim() || null;
  const hasManagementActionPlan = Boolean(getFeedbackManagementActionPlan(feedback));

  return (
    <div className="space-y-6">
      {/* Overall Score */}
      {feedback.overall_score !== undefined && feedback.performance_tier && (
        <div className="pb-2">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-muted-foreground">
              {t('callDetail.overallScore')}
            </span>
            {hasScorecard && callId && (
              <span className="text-xs text-blue-600">
                {t('callDetail.clickForDetails')}
              </span>
            )}
          </div>
          <ScoreDisplay
            score={feedback.overall_score}
            tier={feedback.performance_tier}
            callId={callId}
            hasScorecard={hasScorecard}
            scorecardPath={callId ? withReturnTo(`/calls/${callId}/scorecard`) : undefined}
          />
        </div>
      )}

      {/* Loan Status and Speaker Info */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{t('callDetail.loanCompleted')}:</span>
          <LoanStatusBadge status={feedback.loan_completed} />
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            {t('callDetail.agent')}:{' '}
            {resolvedAgentName ? (
              <><span className="font-medium text-foreground">{resolvedAgentName}</span> ({feedback.agent_speaker})</>
            ) : (
              feedback.agent_speaker
            )}
          </span>
          <span>|</span>
          <span>
            {t('callDetail.customer')}:{' '}
            {feedback.customer_name ? (
              <><span className="font-medium text-foreground">{feedback.customer_name}</span> ({feedback.customer_speaker})</>
            ) : (
              feedback.customer_speaker
            )}
          </span>
        </div>
      </div>

      <ManagementActionSummary feedback={feedback} />

      {/* V2 critiques, legacy per-subsection critiques, or flat grid */}
      {feedbackVersion === "v2" && callId ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Strengths Column */}
            <Card className="border-green-200 dark:border-green-800">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center text-green-700 dark:text-green-300">
                  <ThumbsUp className="h-5 w-5 mr-2" />
                  {t('callDetail.strengths')}
                  {flatStrengthsV2.length > 0 && (
                    <span className="ml-2 text-sm font-normal">({flatStrengthsV2.length})</span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {flatStrengthsV2.length > 0 ? (
                  flatStrengthsV2.map(/** Handles the callback for this operation. */(item, index) => (
                    <FeedbackCard
                      key={index}
                      item={item.critique}
                      type="strength"
                      index={index}
                      transcript={transcript}
                      onClick={/** Handles the onClick interaction. */ () => navigate(withReturnTo(`/calls/${callId}/scorecard/v2/${item.sectionId}/${item.criterionId}`))}
                    />
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    {t('callDetail.noStrengths')}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Weaknesses Column */}
            <Card className="border-red-200 dark:border-red-800">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center text-red-700 dark:text-red-300">
                  <ThumbsDown className="h-5 w-5 mr-2" />
                  {t('callDetail.weaknesses')}
                  {flatWeaknessesV2.length > 0 && (
                    <span className="ml-2 text-sm font-normal">({flatWeaknessesV2.length})</span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {flatWeaknessesV2.length > 0 ? (
                  flatWeaknessesV2.map(/** Handles the callback for this operation. */(item, index) => (
                    <FeedbackCard
                      key={index}
                      item={item.critique}
                      type="weakness"
                      index={index}
                      transcript={transcript}
                      onClick={/** Handles the onClick interaction. */ () => navigate(withReturnTo(`/calls/${callId}/scorecard/v2/${item.sectionId}/${item.criterionId}`))}
                    />
                  ))
                ) : (
                  <p className="text-sm text-green-600 italic">
                    {t('callDetail.noWeaknesses')}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <Link
            to={withReturnTo(`/calls/${callId}/scorecard`)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            <BarChart3 className="h-4 w-4" />
            {t('callDetail.viewBySubsection')}
          </Link>
        </>
      ) : hasEmbeddedCritiques && callId ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Strengths Column */}
            <Card className="border-green-200 dark:border-green-800">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center text-green-700 dark:text-green-300">
                  <ThumbsUp className="h-5 w-5 mr-2" />
                  {t('callDetail.strengths')}
                  {flatStrengths.length > 0 && (
                    <span className="ml-2 text-sm font-normal">({flatStrengths.length})</span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {flatStrengths.length > 0 ? (
                  flatStrengths.map(/** Handles the callback for this operation. */(item, index) => (
                    <FeedbackCard
                      key={index}
                      item={item.critique}
                      type="strength"
                      index={index}
                      transcript={transcript}
                      onClick={/** Handles the onClick interaction. */ () => navigate(withReturnTo(`/calls/${callId}/scorecard/${item.sectionIndex}/${item.subsectionIndex}`))}
                    />
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    {t('callDetail.noStrengths')}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Weaknesses Column */}
            <Card className="border-red-200 dark:border-red-800">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center text-red-700 dark:text-red-300">
                  <ThumbsDown className="h-5 w-5 mr-2" />
                  {t('callDetail.weaknesses')}
                  {flatWeaknesses.length > 0 && (
                    <span className="ml-2 text-sm font-normal">({flatWeaknesses.length})</span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {flatWeaknesses.length > 0 ? (
                  flatWeaknesses.map(/** Handles the callback for this operation. */(item, index) => (
                    <FeedbackCard
                      key={index}
                      item={item.critique}
                      type="weakness"
                      index={index}
                      transcript={transcript}
                      onClick={/** Handles the onClick interaction. */ () => navigate(withReturnTo(`/calls/${callId}/scorecard/${item.sectionIndex}/${item.subsectionIndex}`))}
                    />
                  ))
                ) : (
                  <p className="text-sm text-green-600 italic">
                    {t('callDetail.noWeaknesses')}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <Link
            to={withReturnTo(`/calls/${callId}/scorecard`)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            <BarChart3 className="h-4 w-4" />
            {t('callDetail.viewBySubsection')}
          </Link>
        </>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Strengths Column */}
          <Card className="border-green-200 dark:border-green-800">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center text-green-700 dark:text-green-300">
                <ThumbsUp className="h-5 w-5 mr-2" />
                {t('callDetail.strengths')}
                {strengths.length > 0 && (
                  <span className="ml-2 text-sm font-normal">({strengths.length})</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {strengths.length > 0 ? (
                strengths.map(/** Handles the callback for this operation. */(strength, index) => (
                  <FeedbackCard
                    key={index}
                    item={strength}
                    type="strength"
                    index={index}
                    transcript={transcript}
                  />
                ))
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  {t('callDetail.noStrengths')}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Weaknesses Column */}
          <Card className="border-red-200 dark:border-red-800">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center text-red-700 dark:text-red-300 flex-wrap gap-x-2 gap-y-1">
                <ThumbsDown className="h-5 w-5 mr-2" />
                {t('callDetail.weaknesses')}
                {weaknesses.length > 0 && (
                  <span className="ml-2 text-sm font-normal">({weaknesses.length})</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {weaknesses.length > 0 ? (
                weaknesses.map(/** Handles the callback for this operation. */(weakness, index) => (
                  <FeedbackCard
                    key={index}
                    item={weakness}
                    type="weakness"
                    index={index}
                    selected={selectedWeaknessIndex === index}
                    onClick={onWeaknessSelect ? /** Handles the callback for this operation. */ () => onWeaknessSelect(weakness, index) : undefined}
                    transcript={transcript}
                  />
                ))
              ) : (
                <p className="text-sm text-green-600 italic">
                  {t('callDetail.noWeaknesses')}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Mentorship Tip */}
      {!hasManagementActionPlan && feedback.mentorship_tip && (
        <MentorshipTip tip={feedback.mentorship_tip} />
      )}

      {/* Suggested Follow-up Message */}
      {feedback.suggested_followup_message && (
        <FollowupMessage message={feedback.suggested_followup_message} />
      )}
    </div>
  );
}
