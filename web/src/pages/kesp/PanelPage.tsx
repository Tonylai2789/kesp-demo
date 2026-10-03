import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/useAuth';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { subscribeToAutomaticAgentProfiles } from '@/services/agentAnalyses';
import { Icon } from '@/components/kesp/icons';
import { Sparkline } from '@/components/kesp/primitives';
import { useKespTheme } from '@/hooks/useKespTheme';
import { getKespLocale } from '@/lib/kespI18n';
import { useConsubancoTeamMetrics, type ConsubancoAgentMetrics } from '@/hooks/useConsubancoTeamMetrics';
import type { AgentAnalysis } from '@/types/agentAnalysis';
import '@/styles/kesp.css';

/** Documents the formatMoney behavior. */
function formatMoney(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
    notation: value >= 1_000_000 ? 'compact' : 'standard',
  }).format(value);
}

/** Documents the formatScore behavior. */
function formatScore(value: number | null): string {
  return value == null ? '—' : value.toFixed(1);
}

/** Documents the formatDelta behavior. */
function formatDelta(value: number | null): string {
  if (value == null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

/** Documents the formatPercent behavior. */
function formatPercent(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(1)}%`;
}

/** Documents the sparklineData behavior. */
function sparklineData(metric: ConsubancoAgentMetrics): number[] {
  const values = metric.scoreTrend.filter(/** Handles the callback for this operation. */(value): value is number => typeof value === 'number');
  if (values.length >= 2) return values;
  const fallback = metric.averageScore ?? 0;
  return [fallback, fallback];
}

/** Renders the PanelPage component. */
export function PanelPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { theme, toggleTheme } = useKespTheme();
  const currentLanguage = i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'es';
  const locale = getKespLocale(i18n.resolvedLanguage);
  const [profileState, setProfileState] = useState<{
    userId?: string;
    agentAnalyses: AgentAnalysis[];
  }>({ agentAnalyses: [] });
  const agentAnalyses = profileState.userId === user?.uid ? profileState.agentAnalyses : [];
  const profilesLoaded = Boolean(user?.uid && profileState.userId === user.uid);
  const team = useConsubancoTeamMetrics(agentAnalyses, i18n.resolvedLanguage);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return undefined;
    return subscribeToAutomaticAgentProfiles(/** Handles the callback for this operation. */(next) => {
      setProfileState({ userId: user.uid, agentAnalyses: next });
    });
  }, [user?.uid]);

  const environmentLabel = 'DEMO';
  const showNoProfiles = profilesLoaded && agentAnalyses.length === 0;

  const leaderboard = useMemo(
    /** Handles the callback for this operation. */
    () =>
      [...team.agents].sort(
        /** Handles the callback for this operation. */
        (left, right) =>
          right.amountPlaced - left.amountPlaced ||
          right.soldLoanCount - left.soldLoanCount ||
          (right.averageScore ?? -1) - (left.averageScore ?? -1) ||
          left.agent.salesAgentName.localeCompare(right.agent.salesAgentName)
      ),
    [team.agents]
  );

  const trendScaleMax = Math.max(
    ...team.teamTrend.map(/** Handles the callback for this operation. */(month) => month.amountPlaced),
    ...team.teamTrend.map(/** Handles the callback for this operation. */(month) => month.analyzedCalls),
    1
  );

  const openAgent = /** Documents the openAgent behavior. */ (metric: ConsubancoAgentMetrics) => {
    navigate(`/kesp/agent/${metric.agent.id}`);
  };

  return (
    <div className="kesp-root" data-theme={theme} data-density="default">
      <div className="panel-shell">
        <header className="panel-nav">
          <button className="panel-back" onClick={/** Handles the onClick interaction. */ () => navigate('/')}>
            <Icon name="arrowLeft" size={13} /> Kesp
          </button>
          <div className="panel-nav-actions">
            <button
              type="button"
              className="nav-icon-btn"
              onClick={/** Handles the onClick interaction. */ () => navigate('/kesp/analizador')}
              title={t('kesp.nav.analyzer')}
              aria-label={t('kesp.nav.analyzer')}
            >
              <Icon name="users" size={16} />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="nav-icon-btn nav-lang-btn"
                  title={t('kesp.nav.language')}
                  aria-label={t('kesp.nav.language')}
                >
                  <Icon name="globe" size={16} />
                  <span>{currentLanguage.toUpperCase()}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[120px]">
                <DropdownMenuItem
                  onClick={/** Handles the onClick interaction. */ () => i18n.changeLanguage('es')}
                  aria-current={currentLanguage === 'es' ? 'true' : undefined}
                >
                  {t('kesp.language.spanish')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={/** Handles the onClick interaction. */ () => i18n.changeLanguage('en')}
                  aria-current={currentLanguage === 'en' ? 'true' : undefined}
                >
                  {t('kesp.language.english')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              className="nav-icon-btn"
              title={t('kesp.nav.theme')}
              aria-label={t('kesp.nav.theme')}
              onClick={toggleTheme}
            >
              <Icon name="sun" size={16} />
            </button>
            <div className="right">{t('kesp.panel.nav')}</div>
          </div>
        </header>
        <main className="panel-main rise">
          <div className="panel-team-head">
            <div className="left">
              <div className="eyebrow">{t('kesp.panel.eyebrow')}</div>
              <h1 className="team-title">{t('kesp.panel.teamName')}</h1>
              <div className="team-meta">
                <span>
                  <b>{team.officialAgentCount}</b> {t('kesp.panel.advisors')}
                </span>
                <span className="dot">·</span>
                <span>
                  <b style={{ color: 'var(--good)' }}>{team.activeAgentCount}</b>{' '}
                  {t('kesp.panel.withAnalyzedCalls')}
                </span>
                <span className="dot">·</span>
                <span>
                  <b>{team.totalAnalyzedCalls.toLocaleString(locale)}</b>{' '}
                  {t('kesp.panel.analyzedCalls')}
                </span>
                <span className="dot">·</span>
                <span>
                  {t('kesp.panel.period')} <b>{team.periodLabel}</b>
                </span>
                <span className="dot">·</span>
                <span>
                  {t('kesp.panel.environment.label')} <b>{environmentLabel}</b>
                </span>
              </div>
            </div>
            <div className="right">
              <div className="panel-avatar">CB</div>
              <div>
                <div className="sup-name">{t('kesp.panel.realDataTitle')}</div>
                <div className="sup-role">{t('kesp.panel.realDataSubtitle')}</div>
              </div>
            </div>
          </div>

          {showNoProfiles && (
            <div className="panel-card">
              <div className="trend-sub">{t('kesp.panel.empty.noProfiles')}</div>
            </div>
          )}

          <div className="panel-kpi-grid four">
            <div className="panel-kpi">
              <div className="lbl">
                <Icon name="file" size={12} /> {t('kesp.panel.kpis.credits')}
              </div>
              <div className="val">{team.soldLoanCount.toLocaleString(locale)}</div>
              <div className="foot trend-good">{t('kesp.panel.kpis.currentPeriod')}</div>
            </div>
            <div className="panel-kpi">
              <div className="lbl">
                <Icon name="chart" size={12} /> {t('kesp.panel.kpis.amount')}
              </div>
              <div className="val">{formatMoney(team.amountPlaced, locale)}</div>
              <div className="foot trend-good">{t('kesp.panel.kpis.fromSoldLoans')}</div>
            </div>
            <div className="panel-kpi">
              <div className="lbl">
                <Icon name="bulb" size={12} /> {t('kesp.panel.kpis.score')}
              </div>
              <div className="val">
                {formatScore(team.averageScore)}
                {team.averageScore != null && <small>/100</small>}
              </div>
              <div className="foot trend-good">
                {team.totalAnalyzedCalls.toLocaleString(locale)} {t('kesp.panel.kpis.calls')}
              </div>
            </div>
            <div className="panel-kpi">
              <div className="lbl">
                <Icon name="flag" size={12} /> {t('kesp.panel.kpis.conversion')}
              </div>
              <div className="val">{formatPercent(team.conversionRate)}</div>
              <div className="foot trend-good">{t('kesp.panel.kpis.realPortfolio')}</div>
            </div>
          </div>

          <div className="panel-card panel-trend-card">
            <div className="trend-head">
              <div>
                <div className="lbl">
                  <Icon name="chart" size={12} /> {t('kesp.panel.trend.title')}
                </div>
                <div className="trend-sub">{t('kesp.panel.trend.subtitle')}</div>
              </div>
              <div className="trend-pills">
                <span className="trend-pill active">{t('kesp.panel.trend.amount')}</span>
                <span className="trend-pill">{t('kesp.panel.trend.score')}</span>
                <span className="trend-pill">{t('kesp.panel.trend.calls')}</span>
              </div>
            </div>
            <div className="trend-chart">
              {team.teamTrend.map(/** Handles the callback for this operation. */(month) => {
                const scaleValue = month.amountPlaced > 0 ? month.amountPlaced : month.analyzedCalls;
                const height = Math.max(8, (scaleValue / trendScaleMax) * 100);
                return (
                  <div key={month.monthKey} className="trend-bar-col">
                    <div className="trend-bar-val">
                      {month.amountPlaced > 0
                        ? formatMoney(month.amountPlaced, locale)
                        : month.analyzedCalls.toLocaleString(locale)}
                    </div>
                    <div
                      className={'trend-bar' + (month.monthKey === team.latestMonthKey ? ' active' : '')}
                      style={{ height: `${height}%` }}
                    />
                    <div className="trend-bar-lbl">{month.label}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="panel-row-2">
            <div className="panel-card movers-card">
              <div className="lbl">
                <Icon name="check" size={12} /> {t('kesp.panel.moversUp')}
              </div>
              <div className="movers-list">
                {team.moversUp.length === 0 ? (
                  <div className="muted small">{t('kesp.panel.empty.moversUp')}</div>
                ) : (
                  team.moversUp.map(/** Handles the callback for this operation. */(metric) => (
                    <div key={metric.agent.salesAgentId} className="mover-row">
                      <span className="mover-avatar good">{metric.initials}</span>
                      <div className="mover-body">
                        <div className="mover-name">{metric.agent.salesAgentName}</div>
                        <div className="mover-note">
                          {t('kesp.panel.scoreNow', { score: formatScore(metric.averageScore) })}
                        </div>
                      </div>
                      <span className="mover-delta good">{formatDelta(metric.scoreDelta)} pts</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="panel-card movers-card">
              <div className="lbl">
                <Icon name="info" size={12} /> {t('kesp.panel.moversDown')}
              </div>
              <div className="movers-list">
                {team.moversDown.length === 0 ? (
                  <div className="muted small">{t('kesp.panel.empty.moversDown')}</div>
                ) : (
                  team.moversDown.map(/** Handles the callback for this operation. */(metric) => (
                    <div key={metric.agent.salesAgentId} className="mover-row">
                      <span className="mover-avatar bad">{metric.initials}</span>
                      <div className="mover-body">
                        <div className="mover-name">{metric.agent.salesAgentName}</div>
                        <div className="mover-note">
                          {metric.topWeakness ?? t('kesp.panel.noRepeatedWeakness')}
                        </div>
                      </div>
                      <span className="mover-delta bad">{formatDelta(metric.scoreDelta)} pts</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="panel-table-card">
            <div className="head">
              <span>{t('kesp.panel.table.title', { count: leaderboard.length })}</span>
              <span className="sub">
                {t('kesp.panel.table.subtitle', { period: team.periodLabel })}
              </span>
            </div>
            <table className="panel-table leaderboard">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>#</th>
                  <th>{t('kesp.panel.table.advisor')}</th>
                  <th className="r">{t('kesp.panel.table.credits')}</th>
                  <th className="r">{t('kesp.panel.table.amount')}</th>
                  <th className="r">{t('kesp.panel.table.score')}</th>
                  <th className="r">{t('kesp.panel.table.change')}</th>
                  <th>{t('kesp.panel.table.trend')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map(/** Handles the callback for this operation. */(metric, index) => (
                  <tr key={metric.agent.salesAgentId} className={`lb-row lb-${metric.status}`}>
                    <td className="pos">#{String(index + 1).padStart(2, '0')}</td>
                    <td>
                      <div className="lb-asesor">
                        <span className={'lb-avatar ' + metric.status}>{metric.initials}</span>
                        <span className="lb-name">{metric.agent.salesAgentName}</span>
                      </div>
                    </td>
                    <td className="r">{metric.soldLoanCount}</td>
                    <td className="r mono">
                      <b style={{ fontWeight: 500 }}>{formatMoney(metric.amountPlaced, locale)}</b>
                    </td>
                    <td className="r">
                      <span className={'lb-score ' + metric.status}>
                        {formatScore(metric.averageScore)}
                      </span>
                    </td>
                    <td className={'r lb-change ' + ((metric.scoreDelta ?? 0) >= 0 ? 'good' : 'bad')}>
                      {formatDelta(metric.scoreDelta)}
                    </td>
                    <td className="lb-spark">
                      <Sparkline
                        data={sparklineData(metric)}
                        w={64}
                        h={20}
                        color={
                          metric.status === 'good'
                            ? 'var(--good)'
                            : metric.status === 'warn'
                              ? 'var(--warn)'
                              : 'var(--bad)'
                        }
                      />
                    </td>
                    <td className="r">
                      <button
                        className="btn-ghost"
                        style={{ padding: '4px 8px', fontSize: 11.5 }}
                        onClick={/** Handles the onClick interaction. */ () => openAgent(metric)}
                      >
                        {t('kesp.panel.table.view')} →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel-row-2">
            <div className="panel-card team-patterns-card">
              <div className="lbl">
                <Icon name="bulb" size={12} /> {t('kesp.panel.patterns.title')}
              </div>
              <div className="trend-sub" style={{ marginBottom: 16 }}>
                {t('kesp.panel.patterns.subtitle', {
                  formattedCount: team.totalAnalyzedCalls.toLocaleString(locale),
                })}
              </div>
              <div className="team-patterns-list">
                {team.teamPatterns.length === 0 ? (
                  <div className="muted small">{t('kesp.panel.empty.patterns')}</div>
                ) : (
                  team.teamPatterns.map(/** Handles the callback for this operation. */(pattern) => (
                    <div key={pattern.title} className="team-pattern-row">
                      <div className="tp-bar-wrap">
                        <div className="tp-row-head">
                          <span className="tp-title">{pattern.title}</span>
                          <span className="tp-count">
                            {t('kesp.panel.patterns.affected', {
                              count: pattern.affectedAgents,
                              pct: pattern.pct,
                            })}
                          </span>
                        </div>
                        <div className="tp-bar">
                          <div
                            className={'tp-bar-fill sev-' + pattern.severity}
                            style={{ width: `${Math.max(4, pattern.pct)}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="panel-card coaching-card">
              <div className="lbl">
                <Icon name="check" size={12} /> {t('kesp.panel.coaching.title')}
              </div>
              <div className="trend-sub" style={{ marginBottom: 16 }}>
                {t('kesp.panel.coaching.subtitle')}
              </div>
              <div className="coaching-list">
                {team.coachingPriority.length === 0 ? (
                  <div className="muted small">{t('kesp.panel.empty.coaching')}</div>
                ) : (
                  team.coachingPriority.map(/** Handles the callback for this operation. */(metric) => (
                    <div key={metric.agent.salesAgentId} className="coaching-row">
                      <span className={'lb-avatar ' + metric.status}>{metric.initials}</span>
                      <div className="coaching-body">
                        <div className="coaching-name">{metric.agent.salesAgentName}</div>
                        <div className="coaching-motivo">
                          {metric.topWeakness ?? t('kesp.panel.noRepeatedWeakness')}
                        </div>
                      </div>
                      <div className="coaching-meta">
                        <span className={'coaching-urg sev-' + metric.status}>
                          {formatScore(metric.averageScore)}
                        </span>
                        <button
                          className="btn-ghost"
                          style={{ padding: '4px 10px', fontSize: 11.5 }}
                          onClick={/** Handles the onClick interaction. */ () => openAgent(metric)}
                        >
                          {t('kesp.panel.table.view')}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
          {(!profilesLoaded || team.loading) && (
            <div className="muted tiny" style={{ marginTop: 14 }}>
              {t('kesp.panel.loadingRealData')}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
