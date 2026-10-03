import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAuth } from '@/contexts/useAuth';
import { subscribeToManualAgentProfiles } from '@/services/agentAnalyses';
import type { AgentAnalysis } from '@/types/agentAnalysis';
import { Button, Pill } from '@/components/kesp/primitives';
import { Icon } from '@/components/kesp/icons';
import { formatKespDate } from '@/lib/kespI18n';
import { maskKespDemoAgentDisplayName } from '@/lib/kespDemoRedaction';

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
  if (agent.isActiveAgentProfile === true || agent.activeAgentProfileKey) {
    return <Pill kind="info">{t('kesp.manualProfiles.origin.active')}</Pill>;
  }
  if (agent.profileSource === 'manual') {
    return <Pill kind="default">{t('kesp.manualProfiles.origin.manual')}</Pill>;
  }
  if (agent.profileSource === 'custom') {
    return <Pill kind="default">{t('kesp.manualProfiles.origin.custom')}</Pill>;
  }
  return <Pill kind="default">{t('kesp.manualProfiles.origin.legacy')}</Pill>;
}

/** Renders the ManualProfilesPage component. */
export function ManualProfilesPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [profiles, setProfiles] = useState<AgentAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return;
    return subscribeToManualAgentProfiles(user.uid, /** Handles the callback for this operation. */(next) => {
      setProfiles(next);
      setLoading(false);
    });
  }, [user?.uid]);

  const filteredProfiles = useMemo(/** Handles the callback for this operation. */() => {
    const trimmed = q.trim();
    if (!trimmed) return profiles;

    const strip = /** Documents the strip behavior. */ (value: string) =>
      value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const needle = strip(trimmed);

    return profiles.filter(/** Handles the callback for this operation. */(profile) =>
      strip(
        [
          maskKespDemoAgentDisplayName(profile.salesAgentName, profile.salesAgentId),
          profile.salesAgentName,
          profile.salesAgentId,
          profile.id,
          profile.activeAgentDisplayName,
          profile.activeAgentProfileKey,
        ]
          .filter(Boolean)
          .join(' ')
      ).includes(needle)
    );
  }, [profiles, q]);

  const trimmedQ = q.trim();

  return (
    <main className="main">
      <div className="page-head">
        <div className="eyebrow">{t('kesp.manualProfiles.eyebrow')}</div>
        <h1 className="page-title">
          {t('kesp.manualProfiles.titlePrefix')}{' '}
          <span className="italic">{t('kesp.manualProfiles.titleItalic')}</span>
        </h1>
        <p className="page-sub">{t('kesp.manualProfiles.subtitle')}</p>
      </div>

      <div className="row row-between row-wrap" style={{ margin: '28px 0 14px', gap: 12 }}>
        <div>
          <h2 className="card-h" style={{ fontSize: 18 }}>
            {t('kesp.manualProfiles.profiles.title')}
          </h2>
          <div className="muted small">
            {t('kesp.manualProfiles.profiles.subtitle', { count: profiles.length })}
          </div>
        </div>
        <div className="row row-wrap" style={{ gap: 8 }}>
          <Button
            kind="soft"
            size="sm"
            icon={<Icon name="flag" size={14} />}
            onClick={/** Handles the onClick interaction. */ () => navigate('/kesp/analizador/unrecognized')}
          >
            {t('kesp.manualProfiles.actions.assignCalls')}
          </Button>
          <Button
            kind="primary"
            size="sm"
            icon={<Icon name="upload" size={14} />}
            onClick={/** Handles the onClick interaction. */ () => navigate('/kesp/subir')}
          >
            {t('kesp.manualProfiles.actions.upload')}
          </Button>
        </div>
      </div>

      <div className="filters-row" style={{ marginBottom: 14 }}>
        <div className="search-input" style={{ maxWidth: 520 }}>
          <Icon name="search" size={14} />
          <input
            type="text"
            placeholder={t('kesp.manualProfiles.profiles.searchPlaceholder')}
            value={q}
            onChange={/** Handles the onChange interaction. */(event) => setQ(event.target.value)}
            disabled={loading || profiles.length === 0}
          />
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.manualProfiles.profiles.loading')}</div>
        </div>
      ) : profiles.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.manualProfiles.profiles.empty')}</div>
        </div>
      ) : trimmedQ && filteredProfiles.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">
            {t('kesp.manualProfiles.profiles.noResults', { query: trimmedQ })}
          </div>
        </div>
      ) : (
        <div className="agent-grid">
          {filteredProfiles.map(/** Handles the callback for this operation. */(profile) => (
            <div
              key={profile.id}
              className="agent-card"
              onClick={/** Handles the onClick interaction. */() => navigate(`/kesp/agent/${profile.id}${profile.latestReportId ? '' : '?tab=carga'}`)}
            >
              <div className="head">
                <div className="agent-card-title">
                  <div className="name">{maskKespDemoAgentDisplayName(profile.salesAgentName, profile.salesAgentId)}</div>
                  <div className="agent-card-pills">{profileOriginPill(profile, t)}</div>
                </div>
                <div className="agent-card-status">{statusPill(profile.status, t)}</div>
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
                    {t('kesp.manualProfiles.profiles.lastUpdated')}
                  </div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 500,
                      letterSpacing: '-0.01em',
                      lineHeight: 1.2,
                    }}
                  >
                    {formatKespDate(profile.updatedAt, i18n.resolvedLanguage)}
                  </div>
                </div>
              </div>
              <div className="row-meta">
                <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                  {profile.latestReportId
                    ? t('kesp.common.reportAvailable')
                    : t('kesp.common.noReportYet')}
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
