import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/useAuth';
import { Button, Pill, Section } from '@/components/kesp/primitives';
import { Icon } from '@/components/kesp/icons';
import { formatKespDate, getKespLocale } from '@/lib/kespI18n';
import { maskKespDemoCallString, maskKespDemoAgentDisplayName, maskKespDemoExcerptText } from '@/lib/kespDemoRedaction';
import {
  listCccRuntimeFailures,
  retryCccRuntimeFailures,
  type CccRuntimeFailureRow,
  type CccRuntimeFailureRetryStateFilter,
  type CccRuntimeFailureStageFilter,
} from '@/services/functions';
import {
  isConsubancoSupervisorOrAdminMember,
  subscribeToConsubancoMembership,
  type OrganizationMember,
} from '@/services/organizations';

const FAILURE_LIMIT = 150;
const SELECTED_DATE_CACHE_KEY = 'kesp.runtimeErrors.selectedDateKey';

function formatOptionalDate(value: string | null, language: string | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return formatKespDate(date, language, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDateKey(value: string | null, language: string | undefined): string {
  if (!value) return '-';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return formatKespDate(date, language, { dateStyle: 'medium' });
}

function stagePillKind(stage: CccRuntimeFailureRow['stage']) {
  return stage === 'analysis' ? 'bad' : 'warn';
}

function retryStatePillKind(state: CccRuntimeFailureRow['retryState']) {
  if (state === 'eligible') return 'info';
  if (state === 'running') return 'teal';
  if (state === 'exhausted') return 'bad';
  return 'soft';
}

function summarizeSkipped(skippedByReason: Record<string, number>): string {
  return Object.entries(skippedByReason)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ');
}

function readCachedDateKey(): string {
  if (typeof window === 'undefined') return '';
  return window.sessionStorage.getItem(SELECTED_DATE_CACHE_KEY) ?? '';
}

function cacheDateKey(dateKey: string): void {
  if (typeof window === 'undefined') return;
  if (dateKey) window.sessionStorage.setItem(SELECTED_DATE_CACHE_KEY, dateKey);
  else window.sessionStorage.removeItem(SELECTED_DATE_CACHE_KEY);
}

/** Renders the KESP runtime-error recovery page. */
export function RuntimeErrorsPage() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const locale = getKespLocale(i18n.resolvedLanguage);
  const [member, setMember] = useState<OrganizationMember | null>(null);
  const [membershipLoading, setMembershipLoading] = useState(true);
  const [rows, setRows] = useState<CccRuntimeFailureRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [stage, setStage] = useState<CccRuntimeFailureStageFilter>('all');
  const [retryState, setRetryState] = useState<CccRuntimeFailureRetryStateFilter>('all');
  const [agentFilter, setAgentFilter] = useState('');
  const [selectedDateKey, setSelectedDateKey] = useState(readCachedDateKey);
  const [allErrorCount, setAllErrorCount] = useState(0);
  const [selectedDateErrorCount, setSelectedDateErrorCount] = useState(0);
  const [latestErrorDateKey, setLatestErrorDateKey] = useState<string | null>(null);
  const [responseSelectedDateKey, setResponseSelectedDateKey] = useState<string | null>(null);
  const isAdmin = isConsubancoSupervisorOrAdminMember(member);

  useEffect(() => {
    if (!user?.uid) {
      setMember(null);
      setMembershipLoading(false);
      return () => undefined;
    }
    setMembershipLoading(true);
    return subscribeToConsubancoMembership(
      user.uid,
      (nextMember) => {
        setMember(nextMember);
        setMembershipLoading(false);
      },
      () => {
        setMember(null);
        setMembershipLoading(false);
      }
    );
  }, [user?.uid]);

  const loadFailures = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      /** Calls Firebase Functions to list current CCC runtime failures for this admin. */
      const response = await listCccRuntimeFailures({
        stage,
        retryState,
        salesAgentId: agentFilter || undefined,
        dateKey: selectedDateKey || undefined,
        limit: FAILURE_LIMIT,
      });
      setRows(response.rows);
      setAllErrorCount(response.allErrorCount);
      setSelectedDateErrorCount(response.selectedDateErrorCount);
      setLatestErrorDateKey(response.latestErrorDateKey);
      setResponseSelectedDateKey(response.selectedDateKey);
      if (!selectedDateKey && response.selectedDateKey) {
        setSelectedDateKey(response.selectedDateKey);
        cacheDateKey(response.selectedDateKey);
      }
      setSelectedIds((current) => current.filter((callId) => response.rows.some((row) => row.callId === callId && row.retryEligible)));
    } catch (error) {
      console.error('Failed to load runtime errors:', error);
      toast.error(t('kesp.runtimeErrors.toasts.loadError'));
    } finally {
      setLoading(false);
    }
  }, [agentFilter, isAdmin, retryState, selectedDateKey, stage, t]);

  useEffect(() => {
    void loadFailures();
  }, [loadFailures]);

  const agents = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((row) => {
      if (row.salesAgentId) map.set(row.salesAgentId, row.salesAgentName ?? row.salesAgentId);
    });
    if (agentFilter && !map.has(agentFilter)) map.set(agentFilter, agentFilter);
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [agentFilter, rows]);

  const selectedEligibleCount = rows.filter((row) => selectedIds.includes(row.callId) && row.retryEligible).length;
  const dayEligibleCount = rows.filter((row) => row.retryEligible).length;
  const agentEligibleCount = agentFilter ? rows.filter((row) => row.salesAgentId === agentFilter && row.retryEligible).length : 0;
  const activeSelectedDateKey = responseSelectedDateKey ?? (selectedDateKey || latestErrorDateKey);
  const selectedDateLabel = formatDateKey(activeSelectedDateKey, i18n.resolvedLanguage);

  const stageLabel = stage === 'all' ? t('kesp.runtimeErrors.filters.allStages') : t(`kesp.runtimeErrors.stage.${stage}`);
  const retryStateLabel = retryState === 'all'
    ? t('kesp.runtimeErrors.filters.allStates')
    : t(`kesp.runtimeErrors.retryState.${retryState}`, { defaultValue: retryState });
  const agentLabel = agentFilter
    ? maskKespDemoAgentDisplayName(agents.find(([id]) => id === agentFilter)?.[1] ?? agentFilter, agentFilter)
    : t('kesp.runtimeErrors.filters.allAgents');
  const activeFilterSummary = [stageLabel, retryStateLabel, agentLabel].join(' / ');

  const updateSelectedDate = (dateKey: string) => {
    setSelectedDateKey(dateKey);
    cacheDateKey(dateKey);
    setSelectedIds([]);
  };

  const toggleSelected = (callId: string) => {
    setSelectedIds((current) => current.includes(callId) ? current.filter((id) => id !== callId) : [...current, callId]);
  };

  const selectEligibleRows = () => {
    setSelectedIds(rows.filter((row) => row.retryEligible).map((row) => row.callId));
  };

  const runRetry = async (mode: 'selected' | 'all_eligible' | 'agent') => {
    if (retrying) return;
    const retryCount = mode === 'selected' ? selectedEligibleCount : mode === 'agent' ? agentEligibleCount : dayEligibleCount;
    if (retryCount <= 0) {
      toast.info(t('kesp.runtimeErrors.toasts.noEligible'));
      return;
    }
    const confirmed = window.confirm(t('kesp.runtimeErrors.retry.warning', { count: retryCount }));
    if (!confirmed) return;
    setRetrying(true);
    try {
      /** Calls Firebase Functions to requeue selected CCC runtime failures for this admin. */
      const response = await retryCccRuntimeFailures({
        mode,
        callIds: mode === 'selected' ? selectedIds : undefined,
        salesAgentId: mode === 'agent' ? agentFilter : undefined,
        stage,
        retryState,
        dateKey: activeSelectedDateKey ?? undefined,
        limit: 100,
      });
      const skippedSummary = summarizeSkipped(response.skippedByReason);
      toast.success(t('kesp.runtimeErrors.toasts.retryQueued', { queued: response.queued, skipped: response.skipped }));
      if (skippedSummary) toast.info(skippedSummary);
      setSelectedIds([]);
      await loadFailures();
    } catch (error) {
      console.error('Failed to retry runtime errors:', error);
      toast.error(t('kesp.runtimeErrors.toasts.retryError'));
    } finally {
      setRetrying(false);
    }
  };

  if (membershipLoading) {
    return <Section><div className="panel-empty">{t('common.loading')}</div></Section>;
  }

  if (!isAdmin) {
    return (
      <Section>
        <div className="panel-empty">{t('kesp.runtimeErrors.accessDenied')}</div>
      </Section>
    );
  }

  return (
    <main className="main runtime-errors-page">
      <Section className="runtime-errors-hero">
        <div className="runtime-errors-hero-main">
          <div>
            <div className="eyebrow">{t('kesp.runtimeErrors.eyebrow')}</div>
            <h2>{t('kesp.runtimeErrors.title')}</h2>
            <p>{t('kesp.runtimeErrors.subtitle')}</p>
          </div>
          <div className="runtime-errors-hero-actions">
            <Button kind="soft" onClick={() => void loadFailures()} disabled={loading} icon={<Icon name="refresh" size={14} />}>
              {loading ? t('common.loading') : t('kesp.runtimeErrors.actions.refresh')}
            </Button>
          </div>
        </div>
        <div className="runtime-errors-summary-grid">
          <div className="runtime-errors-kpi">
            <span>{t('kesp.runtimeErrors.stats.allErrors')}</span>
            <strong>{allErrorCount.toLocaleString(locale)}</strong>
            <small>{activeFilterSummary}</small>
          </div>
          <div className="runtime-errors-kpi">
            <span>{t('kesp.runtimeErrors.stats.total')}</span>
            <strong>{selectedDateErrorCount.toLocaleString(locale)}</strong>
            <small>{selectedDateLabel}</small>
          </div>
          <div className="runtime-errors-kpi">
            <span>{t('kesp.runtimeErrors.stats.eligible')}</span>
            <strong>{dayEligibleCount.toLocaleString(locale)}</strong>
            <small>{t('kesp.runtimeErrors.stats.maxRetries')}</small>
          </div>
          <div className="runtime-errors-kpi">
            <span>{t('kesp.runtimeErrors.stats.selected')}</span>
            <strong>{selectedEligibleCount.toLocaleString(locale)}</strong>
            <small>{t('kesp.runtimeErrors.stats.selectedEligible')}</small>
          </div>
        </div>
      </Section>

      <Section className="runtime-errors-workspace">
        <div className="runtime-errors-workspace-head">
          <div>
            <h3>{t('kesp.runtimeErrors.recovery.title')}</h3>
            <p>{t('kesp.runtimeErrors.recovery.subtitle')}</p>
          </div>
          <Pill kind={retrying ? 'teal' : 'soft'} icon={<Icon name="refresh" size={12} />}>
            {retrying ? t('kesp.runtimeErrors.recovery.retrying') : t('kesp.runtimeErrors.recovery.ready')}
          </Pill>
        </div>

        <div className="runtime-errors-control-panel">
          <div className="runtime-errors-filter-grid">
            <label className="runtime-errors-field">
              <span>{t('kesp.runtimeErrors.filters.date')}</span>
              <input type="date" value={activeSelectedDateKey ?? ''} onChange={(event) => updateSelectedDate(event.target.value)} />
            </label>
            <label className="runtime-errors-field">
              <span>{t('kesp.runtimeErrors.filters.stage')}</span>
              <select value={stage} onChange={(event) => { setStage(event.target.value as CccRuntimeFailureStageFilter); setSelectedIds([]); }}>
                <option value="all">{t('kesp.runtimeErrors.filters.allStages')}</option>
                <option value="analysis">{t('kesp.runtimeErrors.stage.analysis')}</option>
                <option value="transcription">{t('kesp.runtimeErrors.stage.transcription')}</option>
              </select>
            </label>
            <label className="runtime-errors-field">
              <span>{t('kesp.runtimeErrors.filters.retryState')}</span>
              <select value={retryState} onChange={(event) => { setRetryState(event.target.value as CccRuntimeFailureRetryStateFilter); setSelectedIds([]); }}>
                <option value="all">{t('kesp.runtimeErrors.filters.allStates')}</option>
                <option value="eligible">{t('kesp.runtimeErrors.retryState.eligible')}</option>
                <option value="not_retryable">{t('kesp.runtimeErrors.retryState.not_retryable')}</option>
                <option value="exhausted">{t('kesp.runtimeErrors.retryState.exhausted')}</option>
                <option value="running">{t('kesp.runtimeErrors.retryState.running')}</option>
                <option value="complete">{t('kesp.runtimeErrors.retryState.complete')}</option>
              </select>
            </label>
            <label className="runtime-errors-field">
              <span>{t('kesp.runtimeErrors.filters.agent')}</span>
              <select value={agentFilter} onChange={(event) => { setAgentFilter(event.target.value); setSelectedIds([]); }}>
                <option value="">{t('kesp.runtimeErrors.filters.allAgents')}</option>
                {agents.map(([id, name]) => <option key={id} value={id}>{maskKespDemoAgentDisplayName(name, id)}</option>)}
              </select>
            </label>
          </div>

          <div className="runtime-errors-action-stack">
            <Button kind="soft" disabled={retrying || dayEligibleCount === 0} onClick={selectEligibleRows} icon={<Icon name="check" size={14} />}>
              {t('kesp.runtimeErrors.actions.selectEligibleOnDate')}
            </Button>
            <Button kind="soft" disabled={retrying || selectedEligibleCount === 0} onClick={() => void runRetry('selected')} icon={<Icon name="refresh" size={14} />}>
              {t('kesp.runtimeErrors.actions.retrySelected')}
            </Button>
            <Button kind="soft" disabled={retrying || !agentFilter || agentEligibleCount === 0} onClick={() => void runRetry('agent')} icon={<Icon name="users" size={14} />}>
              {t('kesp.runtimeErrors.actions.retryAgent')}
            </Button>
            <Button kind="dark" disabled={retrying || dayEligibleCount === 0} onClick={() => void runRetry('all_eligible')} icon={<Icon name="refresh" size={14} />}>
              {t('kesp.runtimeErrors.actions.retryAll')}
            </Button>
          </div>
        </div>

        <div className="runtime-errors-warning">
          <Icon name="info" size={14} />
          <span>{t('kesp.runtimeErrors.retry.inlineWarning')}</span>
        </div>

        <div className="runtime-errors-list-head">
          <div>
            <h3>{t('kesp.runtimeErrors.list.title')}</h3>
            <p>{t('kesp.runtimeErrors.list.subtitleForDate', { count: rows.length, date: selectedDateLabel })}</p>
          </div>
          <span>{t('kesp.runtimeErrors.list.limit', { count: FAILURE_LIMIT })}</span>
        </div>

        {loading ? (
          <div className="panel-empty">{t('common.loading')}</div>
        ) : rows.length === 0 ? (
          <div className="panel-empty runtime-errors-empty">{t('kesp.runtimeErrors.empty')}</div>
        ) : (
          <div className="runtime-errors-list">
            {rows.map((row) => {
              const checked = selectedIds.includes(row.callId);
              return (
                <article key={row.callId} className="runtime-error-row" data-selected={checked ? 'true' : 'false'} data-disabled={!row.retryEligible ? 'true' : 'false'}>
                  <label className="runtime-error-select" aria-label={t('kesp.runtimeErrors.actions.selectCall', { callId: maskKespDemoCallString(row.callId) })}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!row.retryEligible || retrying}
                      onChange={() => toggleSelected(row.callId)}
                    />
                  </label>
                  <div className="runtime-error-content">
                    <div className="runtime-error-title-row">
                      <div className="runtime-error-pills">
                        <Pill kind={stagePillKind(row.stage)}>{t(`kesp.runtimeErrors.stage.${row.stage}`)}</Pill>
                        <Pill kind={retryStatePillKind(row.retryState)}>{t(`kesp.runtimeErrors.retryState.${row.retryState}`, { defaultValue: row.retryState })}</Pill>
                      </div>
                      <strong>{maskKespDemoAgentDisplayName(row.salesAgentName ?? row.salesAgentId, row.salesAgentId) || t('kesp.runtimeErrors.unknownAgent')}</strong>
                    </div>
                    <p
className="runtime-error-message">{row.lastError ? maskKespDemoExcerptText() : t('kesp.runtimeErrors.noErrorMessage')}</p>
                    {!row.retryEligible && <p className="runtime-error-disabled-note">{t('kesp.runtimeErrors.retry.notEligibleRow')}</p>}
                    <div className="runtime-error-meta">
                      <span>{maskKespDemoCallString(row.callId)}</span>
                      <span>{row.sourceFilename || row.sourceObjectPath ? maskKespDemoCallString(row.sourceFilename ?? row.sourceObjectPath!) : t('kesp.runtimeErrors.noSource')}</span>
                      <span>{formatOptionalDate(row.updatedAt ?? row.callTimestamp, i18n.resolvedLanguage)}</span>
                      <span>{t('kesp.runtimeErrors.retryCount', { count: row.retryCount, max: row.maxRetryCount })}</span>
                    </div>
                  </div>
                  <div className="runtime-error-actions">
                    <Link className="btn btn-ghost btn-sm" to={'/kesp/call/' + row.callId}>
                      <Icon name="eye" size={14} />
                      {t('kesp.runtimeErrors.actions.openCall')}
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Section>
    </main>
  );
}
