import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LogIn, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { useUserPermissionsAccess } from '@/hooks/useUserPermissionsAccess';
import { useAuth } from '@/contexts/useAuth';
import { useKespTheme } from '@/hooks/useKespTheme';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Toaster } from '@/components/ui/sonner';
import '@/styles/kesp.css';
import { Icon } from './icons';
import { KespUploadDraftProvider } from './KespUploadDraftProvider';
import type { KespInboxMessage } from '@/types/kespInbox';
import {
  markAllKespInboxMessagesRead,
  markKespInboxMessageRead,
  subscribeToKespInboxMessages,
} from '@/services/kespInbox';
import { formatKespDate } from '@/lib/kespI18n';
import { describeKespInboxMessage, getKespInboxMessageHref } from '@/lib/kespInboxMessages';
import {
  isConsubancoAdminMember,
  isConsubancoAgentMember,
  isConsubancoSupervisorOrAdminMember,
  subscribeToConsubancoMembership,
  type OrganizationMember,
} from '@/services/organizations';

interface AuthLikeUser {
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
}

/** Documents the initialsFromUser behavior. */
function initialsFromUser(user: AuthLikeUser | null | undefined): string {
  if (!user) return '?';
  if (user.displayName) {
    const parts = user.displayName.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return user.displayName.slice(0, 2).toUpperCase();
  }
  if (user.email) {
    return user.email.slice(0, 2).toUpperCase();
  }
  return '?';
}

const NAV_ITEMS = [
  { id: 'users', to: '/kesp/users', labelKey: 'kesp.nav.users', icon: 'users' as const, adminOnly: true },
  { id: 'analizador', to: '/kesp/analizador', labelKey: 'kesp.nav.analyzer', icon: 'users' as const },
  { id: 'manualProfiles', to: '/kesp/manual-profiles', labelKey: 'kesp.nav.manualProfiles', icon: 'list' as const },
  { id: 'llamadas', to: '/kesp/llamadas', labelKey: 'kesp.nav.calls', icon: 'phone' as const },
  { id: 'subir', to: '/kesp/subir', labelKey: 'kesp.nav.upload', icon: 'upload' as const },
  { id: "runtimeErrors", to: "/kesp/runtime-errors", labelKey: "kesp.nav.runtimeErrors", icon: "flag" as const, supervisorOnly: true },
  { id: 'emailReports', to: '/kesp/email-reports', labelKey: 'kesp.nav.emailReports', icon: 'msg' as const, supervisorOnly: true },
];

/** Renders the KespLayout component. */
export function KespLayout() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, switchAccountWithGoogle } = useAuth();
  const permissions = useUserPermissionsAccess(user?.uid);
  const currentLanguage = i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'es';
  const { theme, toggleTheme } = useKespTheme();
  const [signingOut, setSigningOut] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [inboxMessages, setInboxMessages] = useState<KespInboxMessage[]>([]);
  const [consubancoMember, setConsubancoMember] = useState<OrganizationMember | null>(null);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) {
      setConsubancoMember(null);
      return /** Handles the callback for this operation. */ () => undefined;
    }

    return subscribeToConsubancoMembership(
      user.uid,
      setConsubancoMember,
      /** Handles the callback for this operation. */() => setConsubancoMember(null)
    );
  }, [user?.uid]);

  const isConsubancoAdmin = isConsubancoAdminMember(consubancoMember);
  const isConsubancoSupervisor = isConsubancoSupervisorOrAdminMember(consubancoMember);
  const isConsubancoAgent = isConsubancoAgentMember(consubancoMember);
  const agentProfilePath = consubancoMember?.salesAgentId ? `/kesp/agent/${encodeURIComponent(consubancoMember.salesAgentId)}` : '/kesp';
  const homePath = isConsubancoAgent ? agentProfilePath : '/';
  const visibleNavItems = useMemo(
    /** Builds the KESP nav items visible to the current Consubanco role. */
    () => NAV_ITEMS.filter((item) => {
      if (isConsubancoAgent) return false;
      if ('adminOnly' in item && item.adminOnly) return permissions.adminOrganizationIds.includes('consubanco');
      if ('supervisorOnly' in item && item.supervisorOnly) return isConsubancoSupervisor;
      return true;
    }),
    [isConsubancoAgent, isConsubancoSupervisor, permissions.adminOrganizationIds]
  );

  useEffect(/** Handles role-aware KESP route redirects. */() => {
    if (!consubancoMember) return;
    const path = location.pathname;
    if (isConsubancoAgent) {
      const salesAgentId = consubancoMember.salesAgentId;
      if (!salesAgentId) return;
      const encodedAgentId = encodeURIComponent(salesAgentId);
      const allowedAgentPath = path === `/kesp/agent/${encodedAgentId}` || path.startsWith(`/kesp/agent/${encodedAgentId}/`);
      const allowedDetailPath = path.startsWith('/kesp/call/') || path.startsWith('/kesp/short-calls/');
      if (path === '/kesp' || path === '/kesp/agent' || (!allowedAgentPath && !allowedDetailPath)) {
        navigate(agentProfilePath, { replace: true });
      }
      return;
    }
    if (!isConsubancoSupervisor && (path.startsWith('/kesp/runtime-errors') || path.startsWith('/kesp/email-reports'))) {
      navigate('/kesp/analizador', { replace: true });
    }
  }, [agentProfilePath, consubancoMember, isConsubancoAdmin, isConsubancoAgent, isConsubancoSupervisor, location.pathname, navigate]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) {
      setInboxMessages([]);
      return /** Handles the callback for this operation. */ () => undefined;
    }

    /** Calls Firebase Firestore to subscribe to unread KESP inbox messages for the nav dropdown. */
    return subscribeToKespInboxMessages({ userId: user.uid, maxResults: 25, unreadOnly: true }, setInboxMessages);
  }, [user?.uid]);

  const unreadInboxCount = inboxMessages.length;

  const handleInboxMessageClick = /** Handles the handleInboxMessageClick interaction. */ async (
    message: KespInboxMessage
  ) => {
    if (!user?.uid) return;
    try {
      if (!message.readAt) {
        await markKespInboxMessageRead({ userId: user.uid, messageId: message.id });
      }
    } catch (err) {
      console.error('Failed to mark inbox message read:', err);
    }

    const href = getKespInboxMessageHref(message);
    if (href) {
      navigate(href);
    }
  };

  const handleInboxMessageMarkRead = /** Handles the handleInboxMessageMarkRead interaction. */ async (
    message: KespInboxMessage
  ) => {
    if (!user?.uid) return;
    if (message.readAt) return;
    try {
      // Firebase Firestore: marks this single KESP inbox message as read for the signed-in user.
      await markKespInboxMessageRead({ userId: user.uid, messageId: message.id });
    } catch (err) {
      console.error('Failed to mark inbox message read:', err);
      toast.error(t('kesp.inbox.toasts.markReadError'));
    }
  };

  const handleInboxMarkAllRead = /** Handles the handleInboxMarkAllRead interaction. */ async () => {
    if (!user?.uid) return;
    try {
      // Firebase Firestore: marks all active KESP inbox messages as read for the signed-in user.
      await markAllKespInboxMessagesRead({ userId: user.uid });
      toast.success(t('kesp.inbox.toasts.markAllReadSuccess'));
    } catch (err) {
      console.error('Failed to mark all inbox messages read:', err);
      toast.error(t('kesp.inbox.toasts.markAllReadError'));
    }
  };

  const handleSwitchAccount = /** Handles the handleSwitchAccount interaction. */ async () => {
    if (signingOut || switchingAccount) return;
    setSwitchingAccount(true);
    try {
      await switchAccountWithGoogle();
      toast.success(t('kesp.layout.switchAccountSuccess'));
    } catch (err) {
      console.error('Failed to switch account:', err);
      toast.error(t('kesp.layout.switchAccountError'));
    } finally {
      setSwitchingAccount(false);
    }
  };

  const handleLogout = /** Handles the handleLogout interaction. */ async () => {
    if (signingOut || switchingAccount) return;
    setSigningOut(true);
    try {
      await logout();
      toast.success(t('kesp.layout.logoutSuccess'));
    } catch (err) {
      console.error('Failed to sign out:', err);
      toast.error(t('kesp.layout.logoutError'));
    } finally {
      setSigningOut(false);
    }
  };

  const isActive = /** Documents the isActive behavior. */ (id: string) => {
    const path = location.pathname;
    if (id === 'analizador') {
      return path.startsWith('/kesp/analizador') || path.startsWith('/kesp/agent');
    }
    if (id === 'manualProfiles') return path.startsWith('/kesp/manual-profiles');
    if (id === 'llamadas') {
      return path.startsWith('/kesp/llamadas') || path.startsWith('/kesp/call');
    }
    if (id === 'subir') return path.startsWith('/kesp/subir');
    if (id === 'shortCalls') return path.startsWith('/kesp/short-calls');
    if (id === 'users') return path.startsWith('/kesp/users');
    if (id === "runtimeErrors") return path.startsWith("/kesp/runtime-errors");
    if (id === 'emailReports') return path.startsWith('/kesp/email-reports');
    return false;
  };

  return (
    <div className="kesp-root" data-theme={theme} data-density="default">
      <header className="topnav">
        <div className="topnav-inner">
          <Link to={homePath} className="brand" style={{ textDecoration: 'none' }}>
            <span className="brand-logo">K</span>
            Kesp
            <span className="brand-test">DEMO</span>
          </Link>
          <nav className="nav-tabs">
            {visibleNavItems.map(/** Handles the callback for this operation. */(item) => (
              <NavLink
                key={item.id}
                to={item.to}
                className="nav-tab"
                aria-current={isActive(item.id) ? 'true' : undefined}
              >
                <Icon name={item.icon} size={14} />
                {t(item.labelKey)}
              </NavLink>
            ))}
          </nav>
          <div className="nav-right">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="nav-icon-btn nav-inbox-btn"
                  title={t('kesp.nav.inbox')}
                  aria-label={t('kesp.nav.inbox')}
                >
                  <Icon name="msg" size={16} />
                  {unreadInboxCount > 0 && (
                    <span className="kesp-nav-badge" aria-label={t('kesp.inbox.unreadCount', { count: unreadInboxCount })}>
                      {unreadInboxCount > 99 ? '99+' : unreadInboxCount}
                    </span>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="kesp-inbox-menu">
                <div className="kesp-inbox-header">
                  <div className="kesp-inbox-title">{t('kesp.inbox.title')}</div>
                  <button
                    type="button"
                    className="kesp-inbox-header-action"
                    disabled={!user?.uid || unreadInboxCount === 0}
                    title={t('kesp.inbox.markAllRead')}
                    aria-label={t('kesp.inbox.markAllRead')}
                    onClick={/** Handles the onClick interaction. */ (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void handleInboxMarkAllRead();
                    }}
                  >
                    <Icon name="check" size={14} />
                  </button>
                  <div className="kesp-inbox-subtitle">
                    {t('kesp.inbox.unreadCount', { count: unreadInboxCount })}
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={/** Handles the onClick interaction. */ () => navigate('/kesp/inbox')}
                >
                  {t('kesp.inbox.open')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {inboxMessages.length === 0 ? (
                  <div className="kesp-inbox-empty">{t('kesp.inbox.empty')}</div>
                ) : (
                  inboxMessages.map(/** Handles the callback for this operation. */(message) => {
                    const description = describeKespInboxMessage(message, t);
                    return (
                      <DropdownMenuItem
                        key={message.id}
                        onClick={/** Handles the onClick interaction. */ () => handleInboxMessageClick(message)}
                        className={message.readAt ? 'kesp-inbox-item' : 'kesp-inbox-item kesp-inbox-item-unread'}
                      >
                        <div className="kesp-inbox-item-body">
                          <div className="kesp-inbox-item-title">{description.title}</div>
                          <div className="kesp-inbox-item-text">{description.body}</div>
                          <div className="kesp-inbox-item-meta">
                            {formatKespDate(message.createdAt, i18n.resolvedLanguage, {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        </div>
                        {!message.readAt && (
                          <button
                            type="button"
                            className="kesp-inbox-mark-read"
                            title={t('kesp.inbox.markRead')}
                            aria-label={t('kesp.inbox.markRead')}
                            onClick={/** Handles the onClick interaction. */ (event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void handleInboxMessageMarkRead(message);
                            }}
                          >
                            <Icon name="check" size={14} />
                          </button>
                        )}
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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
              className="nav-icon-btn"
              title={t('kesp.nav.theme')}
              aria-label={t('kesp.nav.theme')}
              onClick={toggleTheme}
            >
              <Icon name="sun" size={16} />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="nav-avatar"
                  title={user?.email ?? t('kesp.layout.account')}
                  aria-label={t('kesp.layout.account')}
                  disabled={signingOut || switchingAccount}
                >
                  {user?.photoURL ? (
                    <img src={user.photoURL} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    initialsFromUser(user)
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[200px]">
                <DropdownMenuItem
                  disabled
                  className="text-xs text-muted-foreground"
                >
                  {user?.email ?? t('kesp.layout.activeSession')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleSwitchAccount}
                  disabled={signingOut || switchingAccount}
                >
                  <LogIn className="h-4 w-4 mr-2" />
                  {switchingAccount ? t('kesp.layout.switchingAccount') : t('kesp.layout.switchAccount')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleLogout}
                  className="text-red-600 focus:text-red-600"
                  disabled={signingOut || switchingAccount}
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  {signingOut ? t('kesp.layout.signingOut') : t('kesp.layout.signOut')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <KespUploadDraftProvider>
        <Outlet context={permissions} />
      </KespUploadDraftProvider>
      <Toaster />
    </div>
  );
}
