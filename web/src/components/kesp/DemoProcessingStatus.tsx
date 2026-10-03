import { useTranslation } from 'react-i18next';
import { useDemoProcessingStatus } from '@/hooks/useDemoProcessingStatus';
import { Pill } from '@/components/kesp/primitives';

export function DemoProcessingStatus() {
  const { t, i18n } = useTranslation();
  const { status, canStart, loading } = useDemoProcessingStatus();
  const reason = loading ? 'loading' : status?.pauseReason ?? (canStart ? 'ready' : 'unavailable');
  const remaining = status && Number.isFinite(status.remainingMicros)
    ? new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'currency', currency: 'USD' })
      .format(Math.max(0, status.remainingMicros) / 1_000_000)
    : t('kesp.common.notAvailable');

  return (
    <div role="status" className="row row-wrap" style={{ gap: 10, margin: '12px 0' }}>
      <Pill kind={canStart ? 'good' : 'warn'}>{t(`kesp.processing.${reason}`)}</Pill>
      <span className="muted small">{t('kesp.processing.remaining', { amount: remaining })}</span>
      {!canStart && <span className="muted small">{t('kesp.processing.readOnly')}</span>}
    </div>
  );
}
