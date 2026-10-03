import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { BehaviorPattern } from '@/types';
import { appendReturnTo } from '@/lib/returnTo';
import { maskKespDemoEvidenceText, redactKespDemoText } from '@/lib/kespDemoRedaction';
import { useKespDemoRedactionEnabled } from '@/hooks/useKespDemoRedactionEnabled';

interface PatternExamplesSectionProps {
  pattern: BehaviorPattern;
  returnTo: string;
  callLabelById?: Record<string, string>;
}

/** Renders the PatternExamplesSection component. */
export function PatternExamplesSection({
  pattern,
  returnTo,
  callLabelById = {},
}: PatternExamplesSectionProps) {
  const { t } = useTranslation();
  const demoMode = useKespDemoRedactionEnabled();

  if (!pattern.examples.length) {
    return null;
  }

  return (
    <div className="space-y-4">
      {pattern.examples.map(/** Handles the callback for this operation. */(example, index) => (
        <Card key={example.exampleId}>
          <CardHeader className="space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  {t('callAnalyzer.detail.patternExampleNumber', {
                    defaultValue: 'Ejemplo {{count}}',
                    count: index + 1,
                  })}
                </CardTitle>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Link
                    to={appendReturnTo(`/calls/${example.callId}`, returnTo)}
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {callLabelById[example.callId] ?? example.callId}
                  </Link>
                  {callLabelById[example.callId] &&
                    callLabelById[example.callId] !== example.callId ? (
                    <span className="text-xs text-muted-foreground">{example.callId}</span>
                  ) : null}
                </div>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link to={appendReturnTo(`/calls/${example.callId}`, returnTo)}>
                  {t('callAnalyzer.detail.patternCallsOpenCall', {
                    defaultValue: 'Ver llamada',
                  })}
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('callAnalyzer.detail.patternExampleObserved', {
                  defaultValue: 'Lo que dijo el agente / cliente',
                })}
              </p>
              <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">
                {demoMode ? maskKespDemoEvidenceText() : example.observedFragment}
              </blockquote>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('callAnalyzer.detail.patternExampleContext', {
                  defaultValue: 'Contexto',
                })}
              </p>
              <p className="text-sm text-muted-foreground">{demoMode ? maskKespDemoEvidenceText() : example.context}</p>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('callAnalyzer.detail.patternExampleWhyWrong', {
                  defaultValue: 'Por qué está mal aquí',
                })}
              </p>
              <p className="text-sm text-muted-foreground">{demoMode ? redactKespDemoText(example.whyItIsWrong) : example.whyItIsWrong}</p>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('callAnalyzer.detail.patternExampleWhatToDo', {
                  defaultValue: 'Lo que debió decir el agente',
                })}
              </p>
              <p className="text-sm text-muted-foreground">{example.whatShouldHaveDone}</p>
            </div>

            {example.whyItHelps ? (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('callAnalyzer.detail.patternExampleWhyHelps', {
                    defaultValue: 'Por qué ayuda',
                  })}
                </p>
                <p className="text-sm text-muted-foreground">{example.whyItHelps}</p>
              </div>
            ) : null}

            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('callAnalyzer.detail.executionGuideAvoidThis', {
                  defaultValue: 'No hagas esto',
                })}
              </p>
              <p className="text-sm text-muted-foreground">{example.avoid}</p>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('callAnalyzer.detail.executionGuideNextStep', {
                  defaultValue: 'Busca este siguiente paso',
                })}
              </p>
              <p className="text-sm text-muted-foreground">{example.nextStep}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
