import { useId, useState } from 'react';
import { Content } from '@radix-ui/react-dialog';
import { Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogClose, DialogDescription, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

const metricKeys = [
  'fastSegmentCount', 'fastestWpm', 'agentSpeechSeconds', 'customerSpeechSeconds',
  'overlapSeconds', 'agentTalkPercent', 'longestAgentTurnSeconds', 'medianResponseGapSeconds',
  'interruptionCandidateCount', 'fillerCandidateCount', 'fillerCandidatesPer100Words',
] as const;

interface ConversationMetricsHelpProps {
  timingSource?: 'word' | 'segment';
  deterministicOnly?: boolean;
}

/** Explains reviewer measurements without fetching data or changing call processing. */
export function ConversationMetricsHelp({ timingSource = 'word', deterministicOnly = false }: ConversationMetricsHelpProps) {
  const { t } = useTranslation();
  const [container, setContainer] = useState<HTMLSpanElement | null>(null);
  const tooltipId = useId();
  const [tooltipDismissed, setTooltipDismissed] = useState(false);
  return (
    <span className="cm-help-trigger" ref={setContainer}>
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="cm-play"
          aria-label={t('kesp.conversationMetrics.help.open')} aria-describedby={tooltipId}
          onPointerEnter={/** Allows the next deliberate hover to reveal the tooltip. */ () => setTooltipDismissed(false)}
          onFocus={/** Makes help discoverable through keyboard focus. */ () => setTooltipDismissed(false)}
          onKeyDown={/** Dismisses the nonmodal tooltip without moving focus. */ (event) => {
            if (event.key === 'Escape') setTooltipDismissed(true);
          }}>
          <Info size={16} aria-hidden="true" />
        </button>
      </DialogTrigger>
      <span id={tooltipId} role="tooltip" className="cm-help-tooltip" data-dismissed={tooltipDismissed}>{t('kesp.conversationMetrics.help.open')}</span>
      <DialogPortal container={container}>
        <DialogOverlay />
        <Content className="cm-help-dialog">
          <header className="cm-help-header">
            <div>
              <DialogTitle className="cm-help-title">{t('kesp.conversationMetrics.help.title')}</DialogTitle>
              <DialogDescription className="cm-help-description">{t('kesp.conversationMetrics.help.intro')}</DialogDescription>
            </div>
            <DialogClose asChild>
              <button type="button" className="cm-play" title={t('kesp.conversationMetrics.help.close')}
                aria-label={t('kesp.conversationMetrics.help.close')}><X size={16} aria-hidden="true" /></button>
            </DialogClose>
          </header>
          <div className="cm-help-body" tabIndex={0} role="region" aria-label={t('kesp.conversationMetrics.help.title')}>
            <p>{t('kesp.conversationMetrics.limitations')}</p>
            <p>{t(`kesp.conversationMetrics.timingSource.${timingSource}`)}</p>
            <h4>{t('kesp.conversationMetrics.help.measurements')}</h4>
            <dl>
              {metricKeys.map(/** Reuses visible metric names so the guide matches the results panel. */ (key) => (
                <div key={key}>
                  <dt>{t(`kesp.conversationMetrics.${timingSource === 'segment' ? 'segmentSummary' : 'summary'}.${key}`, {
                    defaultValue: t(`kesp.conversationMetrics.summary.${key}`),
                  })}</dt>
                  <dd>{t(`kesp.conversationMetrics.help.${timingSource === 'segment' ? 'segmentMetrics' : 'metrics'}.${key}`, {
                    defaultValue: t(`kesp.conversationMetrics.help.metrics.${key}`),
                  })}</dd>
                </div>
              ))}
            </dl>
            <h4>{t('kesp.conversationMetrics.help.segmentsTitle')}</h4>
            <p>{t(timingSource === 'segment' ? 'kesp.conversationMetrics.help.providerSegments.segments' : 'kesp.conversationMetrics.help.segments')}</p>
            <h4>{t('kesp.conversationMetrics.help.speedTitle')}</h4>
            <p>{t('kesp.conversationMetrics.speedRule')}</p>
            <p>{t('kesp.conversationMetrics.help.formula')}</p>
            <ul>{['fastExample', 'boundaryExample', 'shortExample'].map(/** Separates threshold examples for scanning. */ (key) =>
              <li key={key}>{t(`kesp.conversationMetrics.help.${key}`)}</li>)}</ul>
            <p>{t('kesp.conversationMetrics.help.scoring')}</p>
            <p>{t('kesp.conversationMetrics.help.exclusions')}</p>
            <h4>{t(deterministicOnly ? 'kesp.conversationMetrics.help.evidenceOnlyTitle' : 'kesp.conversationMetrics.help.evidenceTitle')}</h4>
            <p>{t(timingSource === 'segment' ? 'kesp.conversationMetrics.help.providerSegments.evidence' : 'kesp.conversationMetrics.help.evidence')}</p>
            <p>{t(deterministicOnly ? 'kesp.conversationMetrics.deterministicOnly' : 'kesp.conversationMetrics.help.observations')}</p>
            <h4>{t('kesp.conversationMetrics.help.statusTitle')}</h4>
            <p>{t(timingSource === 'segment' ? 'kesp.conversationMetrics.help.providerSegments.coverage' : 'kesp.conversationMetrics.help.coverage')}</p>
            <p>{t('kesp.conversationMetrics.help.statuses')}</p>
            <h5>{t('kesp.conversationMetrics.help.unavailableTitle')}</h5>
            <p>{t('kesp.conversationMetrics.unavailable')}</p>
            <h5>{t('kesp.conversationMetrics.help.truncationTitle')}</h5>
            <p>{t('kesp.conversationMetrics.help.fullCoverageContext')}</p>
            <p>{t('kesp.conversationMetrics.truncated')}</p>
            <p>{t(timingSource === 'segment' ? 'kesp.conversationMetrics.help.providerSegments.partialCoverage' : 'kesp.conversationMetrics.help.partialCoverage')}</p>
          </div>
        </Content>
      </DialogPortal>
    </Dialog>
    </span>
  );
}
