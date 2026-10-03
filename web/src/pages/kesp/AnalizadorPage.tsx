import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAuth } from '@/contexts/useAuth';
import { subscribeToAutomaticAgentProfiles } from '@/services/agentAnalyses';
import { subscribeToCalls } from '@/services/firestore';
import type { AgentAnalysis } from '@/types/agentAnalysis';
import { Icon } from '@/components/kesp/icons';
import { Button, Pill } from '@/components/kesp/primitives';
import { formatKespDate, getKespLocale } from '@/lib/kespI18n';
import { maskKespDemoAgentDisplayName } from '@/lib/kespDemoRedaction';
import { useConsubancoTeamMetrics } from '@/hooks/useConsubancoTeamMetrics';

/** Documents the formatRelative behavior. */
function formatRelative(date: Date | undefined, language: string | undefined, t: TFunction): string {
  if (!date) return t('kesp.common.notAvailable');
  const now = Date.now();
  const diff = now - date.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return t('kesp.analyzer.relative.justNow');
  if (min < 60) return t('kesp.analyzer.relative.minutesAgo', { count: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t('kesp.analyzer.relative.hoursAgo', { count: hr });
  const day = Math.round(hr / 24);
  if (day === 1) return t('kesp.analyzer.relative.yesterday');
  if (day < 7) return t('kesp.analyzer.relative.daysAgo', { count: day });
  return formatKespDate(date, language);
}

/** Documents the statusPill behavior. */
function statusPill(status: AgentAnalysis['status'], t: TFunction) {
  if (status === 'complete') {
    return (
      <Pill kind="good" icon={<span className="dot" />}>
        {t('kesp.status.complete')}
      </Pill>
    );
  }
  if (status === 'analyzing') {
    return (
      <Pill kind="warn" icon={<span className="dot" />}>
        {t('kesp.status.analyzing')}
      </Pill>
    );
  }
  if (status === 'error') {
    return (
      <Pill kind="bad" icon={<span className="dot" />}>
        {t('kesp.status.error')}
      </Pill>
    );
  }
  return (
    <Pill kind="default" icon={<span className="dot" />}>
      {t('kesp.status.ready')}
    </Pill>
  );
}

/** Documents the profileOriginPill behavior. */
function profileOriginPill(agent: AgentAnalysis, t: TFunction) {
  if (agent.isCccCanonicalProfile === true) {
    return <Pill kind="info">CCC</Pill>;
  }

  const isPreset = agent.isActiveAgentProfile === true || Boolean(agent.activeAgentProfileKey);

  return (
    <Pill kind={isPreset ? 'info' : 'default'}>
      {isPreset ? t('kesp.analyzer.origin.preset') : t('kesp.analyzer.origin.custom')}
    </Pill>
  );
}

/** Renders the AnalizadorPage component. */
export function AnalizadorPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [agentAnalyses, setAgentAnalyses] = useState<AgentAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [unrecognizedCount, setUnrecognizedCount] = useState(0);
  const [q, setQ] = useState('');
  const teamMetrics = useConsubancoTeamMetrics(agentAnalyses, i18n.resolvedLanguage);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return;
    return subscribeToAutomaticAgentProfiles(/** Handles the callback for this operation. */(next) => {
      setAgentAnalyses(next);
      setLoading(false);
    });
  }, [user?.uid]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return;
    return subscribeToCalls(
      {
        userId: user.uid,
        agentRoutingMode: 'general',
        agentRoutingStatus: 'unrecognized',
        sortBy: 'createdAt',
        sortOrder: 'desc',
      },
      /** Handles the callback for this operation. */
      (calls) => setUnrecognizedCount(calls.length)
    );
  }, [user?.uid]);

  const stats = useMemo(/** Handles the callback for this operation. */() => {
    return {
      total: teamMetrics.officialAgentCount,
      active: teamMetrics.activeAgentCount,
    };
  }, [teamMetrics.activeAgentCount, teamMetrics.officialAgentCount]);

  const filteredAgentAnalyses = useMemo(/** Handles the callback for this operation. */() => {
    const trimmed = q.trim();
    if (!trimmed) return agentAnalyses;

    const strip = /** Documents the strip behavior. */ (s: string) =>
      s.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const needle = strip(trimmed);

    return agentAnalyses.filter(/** Handles the callback for this operation. */(a) => {
      const haystack = strip(
        [
          maskKespDemoAgentDisplayName(a.salesAgentName, a.salesAgentId),
          a.salesAgentName,
          a.salesAgentId,
          a.id,
          a.activeAgentDisplayName,
          a.activeAgentProfileKey,
        ]
          .filter(Boolean)
          .join(' '),
      );

      return haystack.includes(needle);
    });
  }, [agentAnalyses, q]);



  const trimmedQ = q.trim();

  return (
    <main className="main">
      <div className="page-head">
        <div className="eyebrow">{t('kesp.analyzer.eyebrow')}</div>
        <h1 className="page-title">
          {t('kesp.analyzer.titlePrefix')} <span className="italic">{t('kesp.analyzer.titleItalic')}</span>
        </h1>
        <p className="page-sub">
          {t('kesp.analyzer.subtitle')}
        </p>
      </div>

      <div className="kpi-grid kpi-grid-4" style={{ marginBottom: 28 }}>
        <div className="kpi">
          <div className="kpi-label">{t('kesp.analyzer.stats.activeAgents')}</div>
          <div className="kpi-value">
            {stats.active}
            <span className="muted" style={{ fontSize: 16, fontWeight: 400 }}>
              /{stats.total}
            </span>
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('kesp.analyzer.stats.analyzedCalls')}</div>
          <div className="kpi-value">
            {teamMetrics.totalAnalyzedCalls.toLocaleString(getKespLocale(i18n.resolvedLanguage))}
          </div>
          <div className="kpi-foot">{t('kesp.analyzer.stats.teamTotal')}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('kesp.analyzer.stats.averageScore')}</div>
          <div className="kpi-value">
            {teamMetrics.averageScore == null ? '—' : teamMetrics.averageScore.toFixed(1)}
          </div>
          <div className="kpi-foot">{t('kesp.analyzer.stats.realTeamAverage')}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('kesp.analyzer.stats.unrecognized')}</div>
          <div className="kpi-value">{unrecognizedCount}</div>
          <div className="kpi-foot">{t('kesp.analyzer.stats.pendingAssignment')}</div>
        </div>
      </div>

      <div className="row row-between row-wrap" style={{ margin: '28px 0 14px', gap: 12 }}>
        <div>
          <h2 className="card-h" style={{ fontSize: 18 }}>
            {t('kesp.analyzer.agents.title')}
          </h2>
          <div className="muted small">{t('kesp.analyzer.agents.subtitle')}</div>
        </div>
        <Button
          kind={unrecognizedCount > 0 ? 'primary' : 'soft'}
          size="sm"
          icon={<Icon name="flag" size={14} />}
          onClick={/** Handles the onClick interaction. */ () => navigate('/kesp/analizador/unrecognized')}
        >
          {t('kesp.analyzer.agents.unrecognizedButton', { count: unrecognizedCount })}
        </Button>
      </div>

      <div className="filters-row" style={{ marginBottom: 14 }}>
        <div className="search-input" style={{ maxWidth: 520 }}>
          <Icon name="search" size={14} />
          <input
            type="text"
            placeholder={t('kesp.analyzer.agents.searchPlaceholder')}
            value={q}
            onChange={/** Handles the onChange interaction. */ (e) => setQ(e.target.value)}
            disabled={loading || agentAnalyses.length === 0}
          />
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.analyzer.agents.loading')}</div>
        </div>
      ) : agentAnalyses.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">
            {t('kesp.analyzer.agents.empty')}
          </div>
        </div>
      ) : trimmedQ && filteredAgentAnalyses.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">
            {t('kesp.analyzer.agents.noResults', { query: trimmedQ })}
          </div>
        </div>
      ) : (
        <div className="agent-grid">
          {filteredAgentAnalyses.map(/** Handles the callback for this operation. */(a) => (
            <div
              key={a.id}
              className="agent-card"
              onClick={/** Opens linked calls when no portfolio aggregate exists. */ () => navigate(`/kesp/agent/${a.id}${a.latestReportId ? '' : '?tab=carga'}`)}
            >
              <div className="head">
                <div className="agent-card-title">
                  <div className="name">{maskKespDemoAgentDisplayName(a.salesAgentName, a.salesAgentId)}</div>
                  <div className="agent-card-pills">
                    {profileOriginPill(a, t)}
                  </div>
                </div>
                <div className="agent-card-status">
                  {statusPill(a.status, t)}
                </div>
              </div>
              <div className="row row-between" style={{ alignItems: 'flex-end' }}>
                <div>
                  <div
                    className="muted tiny"
                    style={{
                      textTransform: 'uppercase',
                      letterSpacing: '.08em',
                      marginBottom: 4,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('kesp.analyzer.agents.lastUpdated')}
                  </div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 500,
                      letterSpacing: '-0.01em',
                      lineHeight: 1.2,
                    }}
                  >
                    {formatRelative(a.updatedAt, i18n.resolvedLanguage, t)}
                  </div>
                </div>
              </div>
              <div className="row-meta">
                <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                  {a.latestReportId ? t('kesp.analyzer.agents.aggregateAvailable') : t('kesp.analyzer.agents.noAggregateYet')}
                </div>
                <div className="spacer" />
                <Icon name="arrow" size={16} />
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
