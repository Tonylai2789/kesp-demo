import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { buildProgressSynopsis, getCurrentBucketKey } from '@/lib/agentActivity';
import { subscribeToProgressRollups, subscribeToSalesRollups } from '@/services/agentActivity';
import type { ProgressRollup, SalesRollup } from '@/types';

interface AgentProgressViewProps {
  agentKey: string;
}

/** Documents the deltaLabel behavior. */
function deltaLabel(current: number | null | undefined, previous: number | null | undefined): string {
  if (typeof current !== 'number' || typeof previous !== 'number') {
    return '--';
  }
  const delta = current - previous;
  if (Math.abs(delta) < 0.05) {
    return '0.0';
  }
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`;
}

/** Documents the formatMoney behavior. */
function formatMoney(amount: number | null | undefined, currency = 'MXN', language = 'es'): string {
  if (typeof amount !== 'number' || Number.isNaN(amount)) {
    return '--';
  }
  return new Intl.NumberFormat(language === 'es' ? 'es-MX' : 'en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Renders the AgentProgressView component. */
export function AgentProgressView({ agentKey }: AgentProgressViewProps) {
  const { t, i18n } = useTranslation();
  const [rollups, setRollups] = useState<ProgressRollup[]>([]);
  const [salesRollups, setSalesRollups] = useState<SalesRollup[]>([]);
  const [periodType, setPeriodType] = useState<'day' | 'week' | 'month'>('week');

  useEffect(/** Handles the callback for this operation. */() => {
    const unsubscribe = subscribeToProgressRollups(agentKey, setRollups);
    return /** Handles the callback for this operation. */ () => unsubscribe();
  }, [agentKey]);

  useEffect(/** Handles the callback for this operation. */() => {
    const unsubscribe = subscribeToSalesRollups(agentKey, setSalesRollups);
    return /** Handles the callback for this operation. */ () => unsubscribe();
  }, [agentKey]);

  const currentBucketKey = getCurrentBucketKey(periodType);

  const periodRollups = useMemo(/** Handles the callback for this operation. */() => {
    return rollups
      .filter(/** Handles the callback for this operation. */(rollup) => rollup.periodType === periodType)
      .sort(/** Handles the callback for this operation. */(a, b) => b.bucketKey.localeCompare(a.bucketKey));
  }, [periodType, rollups]);

  const currentRollup = useMemo(/** Handles the callback for this operation. */() => {
    return periodRollups.find(/** Handles the callback for this operation. */(rollup) => rollup.bucketKey === currentBucketKey) ?? periodRollups[0] ?? null;
  }, [currentBucketKey, periodRollups]);

  const previousRollup = useMemo(/** Handles the callback for this operation. */() => {
    if (!currentRollup) {
      return null;
    }
    const currentIndex = periodRollups.findIndex(/** Handles the callback for this operation. */(rollup) => rollup.id === currentRollup.id);
    if (currentIndex < 0 || currentIndex + 1 >= periodRollups.length) {
      return null;
    }
    return periodRollups[currentIndex + 1];
  }, [currentRollup, periodRollups]);

  const periodSalesRollups = useMemo(/** Handles the callback for this operation. */() => {
    return salesRollups
      .filter(/** Handles the callback for this operation. */(rollup) => rollup.periodType === periodType)
      .sort(/** Handles the callback for this operation. */(a, b) => b.bucketKey.localeCompare(a.bucketKey));
  }, [periodType, salesRollups]);

  const currentSalesRollup = useMemo(/** Handles the callback for this operation. */() => {
    return (
      periodSalesRollups.find(/** Handles the callback for this operation. */(rollup) => rollup.bucketKey === currentBucketKey) ??
      periodSalesRollups[0] ??
      null
    );
  }, [currentBucketKey, periodSalesRollups]);

  const synopsis = useMemo(
    /** Handles the callback for this operation. */
    () => buildProgressSynopsis(currentRollup, previousRollup, i18n.language),
    [currentRollup, i18n.language, previousRollup]
  );

  const executiveSummary = useMemo(/** Handles the callback for this operation. */() => {
    if (!currentRollup) {
      return [];
    }

    const lines: string[] = [];
    lines.push(
      t('callAnalyzer.progress.executiveReviewed', {
        defaultValue: 'Se revisaron {{count}} llamadas con promedio de {{score}}.',
        count: currentRollup.totalReviewedCalls,
        score:
          typeof currentRollup.averageScore === 'number'
            ? currentRollup.averageScore.toFixed(1)
            : '--',
      })
    );

    if (currentRollup.topStrengths[0]?.label) {
      lines.push(
        t('callAnalyzer.progress.executiveStrength', {
          defaultValue: 'Fortaleza más repetida: {{label}}.',
          label: currentRollup.topStrengths[0].label,
        })
      );
    }

    if (currentRollup.topWeaknesses[0]?.label) {
      lines.push(
        t('callAnalyzer.progress.executiveWeakness', {
          defaultValue: 'Debilidad más repetida: {{label}}.',
          label: currentRollup.topWeaknesses[0].label,
        })
      );
    }

    return lines.slice(0, 3);
  }, [currentRollup, t]);

  const coachingPriorities = useMemo(/** Handles the callback for this operation. */() => {
    return (currentRollup?.coachingPriorities ?? []).map(/** Handles the callback for this operation. */(item) => ({
      ...item,
      action:
        item.label.includes('valid')
          ? t('callAnalyzer.progress.trainingValidate', {
            defaultValue: 'Valida primero y luego responde con un avance corto.',
          })
          : item.label.includes('discover') || item.label.includes('descubr')
            ? t('callAnalyzer.progress.trainingDiscover', {
              defaultValue: 'Haz una pregunta útil antes de cotizar o insistir.',
            })
            : item.label.includes('cier') || item.label.includes('seguim')
              ? t('callAnalyzer.progress.trainingClose', {
                defaultValue: 'Cierra con fecha, canal y siguiente paso confirmados.',
              })
              : t('callAnalyzer.progress.trainingDefault', {
                defaultValue: 'Convierte esta debilidad en una rutina concreta para la próxima llamada.',
              }),
    }));
  }, [currentRollup?.coachingPriorities, t]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('callAnalyzer.progress.filters', { defaultValue: 'Periodo' })}</CardTitle>
          <CardDescription>
            {t('callAnalyzer.progress.filtersDescription', {
              defaultValue: 'Cambia entre día, semana y mes sin volver a procesar llamadas.',
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="max-w-xs">
          <Select
            value={periodType}
            onValueChange={/** Handles the onValueChange interaction. */ (value) => setPeriodType(value as 'day' | 'week' | 'month')}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">{t('callAnalyzer.progress.day', { defaultValue: 'Día' })}</SelectItem>
              <SelectItem value="week">{t('callAnalyzer.progress.week', { defaultValue: 'Semana' })}</SelectItem>
              <SelectItem value="month">{t('callAnalyzer.progress.month', { defaultValue: 'Mes' })}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {t('callAnalyzer.progress.reviewedCalls', { defaultValue: 'Llamadas revisadas' })}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{currentRollup?.totalReviewedCalls ?? 0}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {t('callAnalyzer.progress.averageScore', { defaultValue: 'Puntuación promedio' })}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {typeof currentRollup?.averageScore === 'number' ? currentRollup.averageScore.toFixed(1) : '--'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {t('callAnalyzer.progress.scoreDelta', { defaultValue: 'Cambio de puntuación' })}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {deltaLabel(currentRollup?.averageScore, previousRollup?.averageScore)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {t('callAnalyzer.progress.soldLoans', { defaultValue: 'Créditos vendidos' })}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{currentSalesRollup?.soldLoanCount ?? 0}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {t('callAnalyzer.progress.amountPlaced', { defaultValue: 'Monto colocado' })}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {formatMoney(currentSalesRollup?.totalAmountSold ?? null, 'MXN', i18n.language)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {t('callAnalyzer.progress.averageTicket', { defaultValue: 'Ticket promedio' })}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {formatMoney(currentSalesRollup?.averageLoanAmount ?? null, 'MXN', i18n.language)}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('callAnalyzer.progress.synopsis', { defaultValue: 'Resumen' })}</CardTitle>
          <CardDescription>
            {currentRollup
              ? t('callAnalyzer.progress.synopsisDescription', {
                defaultValue: 'Resumen de {{bucket}}.',
                bucket: currentRollup.bucketKey,
              })
              : t('callAnalyzer.progress.synopsisEmpty', {
                defaultValue: 'Todavía no hay datos de progreso para este periodo.',
              })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(executiveSummary.length ? executiveSummary : synopsis.slice(0, 2)).map(/** Handles the callback for this operation. */(line, index) => (
            <p key={`synopsis-${index}`} className="text-sm text-muted-foreground">
              {line}
            </p>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t('callAnalyzer.progress.strengths', { defaultValue: 'Fortalezas repetidas' })}</CardTitle>
          </CardHeader>
          <CardContent>
            {currentRollup?.topStrengths.length ? (
              <ul className="space-y-2 text-sm">
                {currentRollup.topStrengths.map(/** Handles the callback for this operation. */(item) => (
                  <li key={item.label} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <span>{item.label}</span>
                    <span className="text-muted-foreground">{item.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('callAnalyzer.progress.noStrengths', { defaultValue: 'No se encontraron fortalezas repetidas en este periodo.' })}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('callAnalyzer.progress.weaknesses', { defaultValue: 'Debilidades repetidas' })}</CardTitle>
          </CardHeader>
          <CardContent>
            {currentRollup?.topWeaknesses.length ? (
              <ul className="space-y-2 text-sm">
                {currentRollup.topWeaknesses.map(/** Handles the callback for this operation. */(item) => (
                  <li key={item.label} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <span>{item.label}</span>
                    <span className="text-muted-foreground">{item.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('callAnalyzer.progress.noWeaknesses', { defaultValue: 'No se encontraron debilidades repetidas en este periodo.' })}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('callDetail.whatToTrainSection', { defaultValue: 'Qué entrenar' })}</CardTitle>
            <CardDescription>
              {t('callAnalyzer.progress.trainingDescription', {
                defaultValue: 'Convierte los patrones repetidos en una práctica concreta.',
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {coachingPriorities.length ? (
              <div className="space-y-3 text-sm">
                {coachingPriorities.map(/** Handles the callback for this operation. */(item) => (
                  <div key={item.label} className="rounded-md border px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium">{item.label}</p>
                      <span className="text-xs text-muted-foreground">{item.count}</span>
                    </div>
                    <p className="mt-2 text-muted-foreground">{item.action}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('callAnalyzer.progress.noWeaknesses', { defaultValue: 'No se encontraron debilidades repetidas en este periodo.' })}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('callAnalyzer.progress.progression', { defaultValue: 'Progresión' })}</CardTitle>
          <CardDescription>
            {t('callAnalyzer.progress.progressionDescription', {
              defaultValue: 'Revisa buckets recientes de {{periodType}} para este agente.',
              periodType,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {periodRollups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('callAnalyzer.progress.noHistory', { defaultValue: 'Todavía no hay buckets históricos de progreso.' })}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4">Periodo</th>
                    <th className="py-2 pr-4">Revisadas</th>
                    <th className="py-2 pr-4">Promedio</th>
                    <th className="py-2 pr-4">Debilidad principal</th>
                  </tr>
                </thead>
                <tbody>
                  {periodRollups.slice(0, 12).map(/** Handles the callback for this operation. */(rollup) => (
                    <tr key={rollup.id} className="border-b">
                      <td className="py-3 pr-4 font-medium">{rollup.bucketKey}</td>
                      <td className="py-3 pr-4">{rollup.totalReviewedCalls}</td>
                      <td className="py-3 pr-4">
                        {typeof rollup.averageScore === 'number' ? rollup.averageScore.toFixed(1) : '--'}
                      </td>
                      <td className="py-3 pr-4">{rollup.topWeaknesses[0]?.label ?? '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
