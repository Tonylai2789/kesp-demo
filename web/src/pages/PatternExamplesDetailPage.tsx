import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PatternExamplesSection } from '@/components/call-analyzer/PatternExamplesSection';
import { fetchAgentAnalysis, fetchAgentAnalysisReport } from '@/services/agentAnalyses';
import type { AgentAnalysis, AgentAnalysisReportV2 } from '@/types';
import { getReturnToFromSearch } from '@/lib/returnTo';

/** Documents the formatPercent behavior. */
function formatPercent(seen: number, total: number): string | null {
  if (!total) return null;
  const raw = (seen / total) * 100;
  const rounded = Math.round(raw);
  return Math.abs(raw - rounded) < 0.05 ? `${rounded}%` : `${raw.toFixed(1)}%`;
}

/** Renders the PatternExamplesDetailPage component. */
export function PatternExamplesDetailPage() {
  const { id, patternId } = useParams<{ id: string; patternId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agentAnalysis, setAgentAnalysis] = useState<AgentAnalysis | null>(null);
  const [report, setReport] = useState<AgentAnalysisReportV2 | null>(null);
  const returnTo = getReturnToFromSearch(location.search);
  const backPath = returnTo ?? (id ? `/call-analyzer/${id}` : '/call-analyzer');

  useEffect(/** Handles the callback for this operation. */() => {
    let cancelled = false;

    /** Documents the load behavior. */
    async function load() {
      if (!id) {
        setError('No se encontró el análisis del agente.');
        setLoading(false);
        return;
      }

      try {
        const nextAgentAnalysis = await fetchAgentAnalysis(id);
        if (!nextAgentAnalysis?.latestReportId) {
          throw new Error('No report found');
        }
        const nextReport = await fetchAgentAnalysisReport(id, nextAgentAnalysis.latestReportId);
        if (!nextReport || nextReport.schemaVersion !== '2') {
          throw new Error('Schema version mismatch');
        }
        if (cancelled) return;
        setAgentAnalysis(nextAgentAnalysis);
        setReport(nextReport);
        setError(null);
      } catch (loadError) {
        console.error('Failed to load pattern examples detail page:', loadError);
        if (!cancelled) {
          setError('No se pudo cargar la explicación de ejemplos.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return /** Handles the callback for this operation. */ () => {
      cancelled = true;
    };
  }, [id, patternId]);

  const pattern = useMemo(
    /** Handles the callback for this operation. */
    () => report?.patterns.find(/** Handles the callback for this operation. */(item) => item.patternId === patternId) ?? null,
    [patternId, report]
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-52 w-full" />
      </div>
    );
  }

  if (error || !pattern || !agentAnalysis) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={/** Handles the onClick interaction. */ () => navigate(backPath)} className="-ml-2">
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('common.back')}
        </Button>
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {error || 'No se encontró el patrón.'}
          </CardContent>
        </Card>
      </div>
    );
  }

  const patternPercent = formatPercent(pattern.seenInCallCount, pattern.totalCallCount);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button variant="ghost" onClick={/** Handles the onClick interaction. */ () => navigate(backPath)} className="-ml-2">
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('common.back')}
        </Button>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">{pattern.patternName}</h1>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>
              {t('callAnalyzer.detail.patternCoverage', {
                seen: pattern.seenInCallCount,
                total: pattern.totalCallCount,
              })}
            </span>
            {patternPercent ? (
              <span>
                {t('callAnalyzer.detail.patternCoveragePercent', {
                  defaultValue: '{{percent}} de las llamadas analizadas',
                  percent: patternPercent,
                })}
              </span>
            ) : null}
            <Badge variant="outline">
              {t('callAnalyzer.detail.patternPriority', { score: pattern.priorityScore })}
            </Badge>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {t('callAnalyzer.detail.patternExamplesSummaryTitle', {
              defaultValue: 'Resumen del patrón',
            })}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('callAnalyzer.detail.behaviorSummaryCompact', { defaultValue: 'Qué está pasando' })}
            </p>
            <p className="text-sm text-muted-foreground">{pattern.behaviorSummary}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('callAnalyzer.detail.businessImpactCompact', { defaultValue: 'Por qué importa' })}
            </p>
            <p className="text-sm text-muted-foreground">{pattern.businessImpact}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('callAnalyzer.detail.coachingFocusCompact', { defaultValue: 'Qué hacer ya' })}
            </p>
            <p className="text-sm font-medium">{pattern.coachingFocus}</p>
          </div>
        </CardContent>
      </Card>

      <PatternExamplesSection
        pattern={pattern}
        returnTo={location.pathname + location.search}
      />
    </div>
  );
}
