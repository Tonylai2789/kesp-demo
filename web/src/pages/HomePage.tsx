import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/useAuth';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/kesp/icons';
import { useKespTheme } from '@/hooks/useKespTheme';
import { subscribeToCalls } from '@/services/firestore';
import {
  subscribeToConsubancoMembership,
  type OrganizationMember,
} from '@/services/organizations';
import type { Call } from '@/types/call';
import styles from './HomePage.module.css';

/** Renders the ArrowIcon component. */
function ArrowIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

/** Renders the SpeakerIcon component. */
function SpeakerIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

/** Renders the HomePage component. */
export function HomePage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { theme, toggleTheme } = useKespTheme();
  const currentLanguage = i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'es';
  const [recentCalls, setRecentCalls] = useState<Call[]>([]);
  const [consubancoMember, setConsubancoMember] = useState<OrganizationMember | null>(null);
  const [mountedAt] = useState(/** Handles the callback for this operation. */() => Date.now());

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return;
    if (consubancoMember?.role === 'agent') return;
    return subscribeToCalls(
      { userId: user.uid, sortBy: 'createdAt', sortOrder: 'desc' },
      setRecentCalls
    );
  }, [consubancoMember?.role, user?.uid]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return;
    return subscribeToConsubancoMembership(
      user.uid,
      setConsubancoMember,
      /** Handles the callback for this operation. */() => setConsubancoMember(null)
    );
  }, [user?.uid]);

  const agentRedirectSalesAgentId = consubancoMember?.role === 'agent' ? consubancoMember.salesAgentId : null;
  const agentRedirectPath = agentRedirectSalesAgentId
    ? `/kesp/agent/${encodeURIComponent(agentRedirectSalesAgentId)}`
    : null;
  const analizadorMeta = useMemo(/** Handles the callback for this operation. */() => {
    const sevenDaysAgo = mountedAt - 7 * 24 * 60 * 60 * 1000;
    const recent = consubancoMember?.role === 'agent' ? [] : recentCalls.filter(/** Handles the callback for this operation. */(c) => c.createdAt && c.createdAt.getTime() >= sevenDaysAgo);
    if (!user?.uid) return t('kesp.home.analyzer.signedOut');
    if (recent.length === 0) return t('kesp.home.analyzer.empty');
    return t('kesp.home.analyzer.recent', { count: recent.length });
  }, [consubancoMember?.role, mountedAt, recentCalls, t, user?.uid]);

  if (agentRedirectPath) {
    return <Navigate to={agentRedirectPath} replace />;
  }

  return (
    <div className={styles.shell} data-theme={theme}>
      <header className={styles.nav}>
        <div className={styles.brand}>
          <span className={styles.brandLogo}>K</span>
          Arvo
        </div>
        <div className={styles.navRight}>
          <span className={styles.navTagline}>{t('kesp.home.tagline')}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`${styles.navIconBtn} ${styles.navLangBtn}`}
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
            className={styles.navIconBtn}
            title={t('kesp.nav.theme')}
            aria-label={t('kesp.nav.theme')}
            onClick={toggleTheme}
          >
            <Icon name="sun" size={16} />
          </button>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.heroMark}>
          <h1 className={styles.title}>Kesp.</h1>
          <div className={styles.arvoMark}>
            <span className={styles.arvoRule} />
            <span>Arvo</span>
          </div>
        </div>
        <p className={styles.lede}>
          {t('kesp.home.lede')}
        </p>

        <div className={styles.modLabel}>{t('kesp.home.modules')}</div>
        <div className={styles.modGrid}>
          <Link to="/kesp/analizador" className={styles.modCard}>
            <div className={styles.iconTile}>
              <SpeakerIcon />
            </div>
            <span className={styles.arrow}>
              <ArrowIcon />
            </span>
            <h3 className={styles.modTitle}>{t('kesp.home.analyzer.title')}</h3>
            <p className={styles.modDesc}>
              {t('kesp.home.analyzer.description')}
            </p>
            <div className={styles.meta}>
              <span className={styles.dot} /> {analizadorMeta}
            </div>
          </Link>
        </div>
      </main>

      <footer className={styles.footer}>
        <span>{t('kesp.home.footer.workspace')}</span>
        <span>{t('kesp.home.footer.version')}</span>
      </footer>
    </div>
  );
}
