import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, Check, History, Pencil, Plus, RefreshCw, X } from 'lucide-react';
import { DEMO_ADMIN_EMAIL, DEMO_EMAILS } from '@/lib/demoPolicy';
import { useAuth } from '@/contexts/useAuth';
import type { UserPermissionsAccess } from '@/hooks/useUserPermissionsAccess';
import { useKespTheme } from '@/hooks/useKespTheme';
import firebaseApp from '@/services/firebaseApp';
import { formatKespDate } from '@/lib/kespI18n';
import { maskKespDemoAgentDisplayName } from '@/lib/kespDemoRedaction';
import { groupDirectory, prepareAccessUpdate, resolveAccessTarget, type AccessTarget, type DirectoryRow } from '@/lib/userPermissions';
import {
  listUserDirectory, listUserAccessAudit, updateUserAccess, userAccessErrorKey,
  type UserDirectory, type UserAccessRole, type UserAccessAuditEvent,
} from '@/services/userPermissions';

const ROLES: UserAccessRole[] = ['supervisor', 'admin'];

/** Guards direct routes independently from Consubanco navigation. */
export function UsersPage() {
  const access = useOutletContext<UserPermissionsAccess>();
  const { user } = useAuth();
  const { t } = useTranslation();
  if (access.loading) return <main className="main kesp-users"><p role="status">{t('kesp.users.checking')}</p></main>;
  if (!user || user.email?.toLowerCase() !== DEMO_ADMIN_EMAIL || !access.adminOrganizationIds.includes('consubanco')) return (
    <main className="main kesp-users">
      <h1>{t('kesp.users.title')}</h1>
      <p role="alert">{t(`kesp.users.${access.error ? 'accessError' : 'denied'}`)}</p>
      <button className="btn btn-soft" onClick={access.refresh}><RefreshCw size={16} />{t('kesp.users.retry')}</button>
    </main>
  );
  // Losing any administered organization discards its open editor and previously fetched audit data.
  return <UsersDirectory key={`${user.uid}:${[...access.adminOrganizationIds].sort().join(',')}`} uid={user.uid} access={access} />;
}

/** Loads every Auth page before exposing global filters or mutations. */
function UsersDirectory({ uid, access }: { uid: string; access: UserPermissionsAccess }) {
  const { t } = useTranslation();
  const [directory, setDirectory] = useState<UserDirectory | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [organization, setOrganization] = useState('*');
  const [role, setRole] = useState('*');
  const [editor, setEditor] = useState<{ target: AccessTarget | null } | null>(null);
  const [auditOrganization, setAuditOrganization] = useState('');
  const [success, setSuccess] = useState('');
  const { refresh } = access;

  useEffect(/** Rejects unfinished and stale paginated loads. */ () => {
    let cancelled = false;
    /** Fetches pages sequentially; partial users are progress, never directory results. */
    async function load() {
      try {
        // Firebase Functions returns metadata on the first page only.
        const first = await listUserDirectory();
        if (cancelled) return;
        const users = [...first.users];
        setProgress(users.length);
        let token = first.nextPageToken;
        const seen = new Set<string>();
        while (token) {
          if (seen.has(token)) throw new Error('Repeated directory cursor');
          seen.add(token);
          // Firebase Functions continues the complete project account listing.
          const page = await listUserDirectory({ pageToken: token });
          if (cancelled) return;
          users.push(...page.users);
          setProgress(users.length);
          token = page.nextPageToken;
        }
        if (!cancelled) setDirectory({ ...first, users, nextPageToken: null });
      } catch (failure) {
        if (!cancelled) {
          const key = userAccessErrorKey(failure);
          setError(key);
          if (key === 'denied') refresh();
        }
      }
    }
    void load();
    return /** Prevents an earlier load from exposing stale directory data. */ () => { cancelled = true; };
  }, [revision, refresh]);

  /** Clears the full snapshot before requesting another complete directory. */
  const reload = useCallback(/** Restarts pagination without retaining stale mutation versions. */ () => {
    setDirectory(null); setProgress(0); setError(''); setEditor(null); setAuditOrganization('');
    setRevision(/** Invalidates the current load. */ (value) => value + 1);
    refresh();
  }, [refresh]);
  const groups = useMemo(/** Groups all loaded users by their actual memberships. */ () => directory ? groupDirectory(directory, search, organization, role) : new Map<string, DirectoryRow[]>(), [directory, search, organization, role]);
  const pending = directory?.pending.filter(/** Applies the same global filters to pending email assignments. */ (entry) =>
    entry.email.toLowerCase().includes(search.trim().toLowerCase()) &&
    (organization === '*' || (entry.organizationId ?? '') === organization) &&
    (role === '*' || (entry.role ?? '') === role)
  ) ?? [];

  /** Uses actual organization labels, retaining unknown IDs rather than misgrouping. */
  function organizationName(id: string | null) { return id ? directory?.organizations.find(/** Resolves a returned organization. */ (entry) => entry.id === id)?.name ?? id : t('kesp.users.unassigned'); }
  /** Displays legacy and missing roles explicitly without silently converting them. */
  function roleName(value: string | null | undefined) { return value && [...ROLES, 'agent', 'member'].includes(value) ? t(`kesp.users.roles.${value}`) : value ?? t('kesp.users.noRole'); }
  /** Summarizes only the verified role-specific scope, not unrelated organization privileges. */
  function permissionText(value: string | null | undefined, organizationId?: string) {
    if (!value) return t('kesp.users.permissions.none');
    if (!ROLES.includes(value as UserAccessRole)) return t('kesp.users.unsupportedRole');
    if (value === 'admin') return t(organizationId === 'consubanco' ? 'kesp.users.permissions.consubancoAdmin' : 'kesp.users.permissions.admin');
    if (organizationId !== 'consubanco') return t('kesp.users.permissions.other');
    return t(`kesp.users.permissions.${value === 'agent' || value === 'supervisor' ? value : 'member'}`);
  }

  return (
    <main className="main main-wide kesp-users">
      <header className="kesp-users-heading">
        <div><h1>{t('kesp.users.title')}</h1><p>{firebaseApp.options.projectId} · DEMO</p></div>
        <div className="kesp-users-actions">
          <button className="btn btn-soft btn-icon" title={t('kesp.users.refresh')} aria-label={t('kesp.users.refresh')} onClick={reload} disabled={!directory && !error}><RefreshCw size={16} /></button>
          <button className="btn btn-primary" disabled={!directory} onClick={/** Opens explicit email onboarding. */ () => { setSuccess(''); setEditor({ target: null }); }}><Plus size={16} />{t('kesp.users.addEmail')}</button>
        </div>
      </header>
      {success && <p className="kesp-users-success" role="status">{t(`kesp.users.${success}`)}</p>}
      {error ? <div role="alert"><p>{t(`kesp.users.${error}`)}</p><p>{t('kesp.users.incomplete')}</p><button className="btn btn-soft" onClick={reload}>{t('kesp.users.retry')}</button></div> : !directory ? <p role="status">{t('kesp.users.loading', { count: progress })}</p> : <>
        <p className="kesp-users-muted" role="status">{t('kesp.users.complete', { count: directory.users.length })}</p>
        <div className="kesp-users-filters">
          <label>{t('kesp.users.search')}<input type="search" value={search} onChange={/** Filters the complete snapshot. */ (event) => setSearch(event.target.value)} /></label>
          <label>{t('kesp.users.organization')}<select value={organization} onChange={/** Selects an organization filter. */ (event) => setOrganization(event.target.value)}><option value="*">{t('kesp.users.allOrganizations')}</option><option value="">{t('kesp.users.unassigned')}</option>{directory.organizations.map(/** Lists actual organizations. */ (entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
          <label>{t('kesp.users.role')}<select value={role} onChange={/** Selects a role filter. */ (event) => setRole(event.target.value)}><option value="*">{t('kesp.users.allRoles')}</option><option value="">{t('kesp.users.noRole')}</option>{[...ROLES, 'agent', 'member'].map(/** Includes legacy roles for inspection only. */ (value) => <option key={value} value={value}>{roleName(value)}</option>)}</select></label>
        </div>
        {!groups.size && <p>{t('kesp.users.empty')}</p>}
        {[...groups.entries()].map(/** Renders an unframed organization group. */ ([id, rows]) => (
          <section key={id} className="kesp-users-group">
            <h2>{organizationName(id)} <span>({rows.length})</span></h2>
            <div className="kesp-users-table-scroll"><table><thead><tr>{['user', 'role', 'profile', 'login', 'permissionsHeading', 'actions'].map(/** Labels each directory column. */ (key) => <th key={key}>{t(`kesp.users.${key}`)}</th>)}</tr></thead><tbody>
              {rows.map(/** Renders each account once per matching membership. */ ({ user, membership }: { user: UserDirectory['users'][number]; membership?: UserDirectory['users'][number]['memberships'][number] }) => <tr key={user.uid}>
                <td><strong>{user.displayName ?? user.email ?? user.uid}</strong><div>{user.email ?? t('kesp.users.noEmail')}</div><small>{user.uid}</small></td>
                <td>{roleName(membership?.role)}</td>
                <td>{membership?.salesAgentName ?? membership?.salesAgentId ?? membership?.agentAnalysisId ?? t('kesp.users.noProfile')}</td>
                <td><span>{t(`kesp.users.${user.allowed ? 'approved' : 'notApproved'}`)}</span><div className={user.disabled ? 'kesp-users-error' : ''}>{t(`kesp.users.${user.disabled ? 'disabled' : 'enabled'}`)}</div></td>
                <td>{permissionText(membership?.role, membership?.organizationId)}</td>
                <td>{!membership || access.adminOrganizationIds.includes(id) ? <button className="btn btn-soft btn-icon" title={t(`kesp.users.${membership ? 'edit' : 'assign'}`)} aria-label={t(`kesp.users.${membership ? 'edit' : 'assign'}`)} onClick={/** Opens this membership without altering other organizations. */ () => { setSuccess(''); setEditor({ target: { user, membership } }); }}>{membership ? <Pencil size={16} /> : <Plus size={16} />}</button> : <span className="kesp-users-muted">{t('kesp.users.readOnly')}</span>}</td>
              </tr>)}
            </tbody></table></div>
          </section>
        ))}
        <section className="kesp-users-group">
          <h2>{t('kesp.users.pending')} <span>({pending.length})</span></h2>
          {!pending.length ? <p>{t('kesp.users.noPending')}</p> : <div className="kesp-users-table-scroll"><table><thead><tr>{['email', 'organization', 'role', 'profile', 'login', 'actions'].map(/** Labels pending account columns. */ (key) => <th key={key}>{t(`kesp.users.${key}`)}</th>)}</tr></thead><tbody>{pending.map(/** Distinguishes approved email records from existing Auth identities. */ (entry) => <tr key={entry.id}>
            <td>{entry.email}</td><td>{organizationName(entry.organizationId)}</td><td>{roleName(entry.role)}</td><td>{directory.profiles.find(/** Resolves an exact pending profile ID. */ (profile) => profile.id === entry.agentAnalysisId)?.name ?? entry.agentAnalysisId ?? t('kesp.users.noProfile')}</td><td>{t('kesp.users.pendingSignup')}</td><td>{!entry.organizationId || access.adminOrganizationIds.includes(entry.organizationId) ? <button className="btn btn-soft btn-icon" title={t('kesp.users.edit')} aria-label={t('kesp.users.edit')} onClick={/** Edits pending state by email and stored version. */ () => setEditor({ target: { pending: entry } })}><Pencil size={16} /></button> : t('kesp.users.readOnly')}</td>
          </tr>)}</tbody></table></div>}
        </section>
        <section className="kesp-users-group">
          <h2><History size={18} />{t('kesp.users.audit')}</h2>
          <label className="kesp-users-audit-select">{t('kesp.users.organization')}<select value={auditOrganization} onChange={/** Selects an administered audit scope. */ (event) => setAuditOrganization(event.target.value)}><option value="">{t('kesp.users.chooseOrganization')}</option>{directory.organizations.filter(/** Restricts audit choices to current grants. */ (entry) => access.adminOrganizationIds.includes(entry.id)).map(/** Labels audit organization choices. */ (entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
          {auditOrganization && <AccessAudit key={`${auditOrganization}:${revision}`} organizationId={auditOrganization} onDenied={refresh} />}
        </section>
        {editor && <AccessEditor directory={directory} target={editor.target} uid={uid} access={access} onClose={/** Closes without saving. */ () => setEditor(null)} onSaved={/** Reconciles the confirmed backend result with a fresh full directory. */ (isPending) => { setSuccess(isPending ? 'savedPending' : 'saved'); reload(); }} onConflict={reload} />}
      </>}
    </main>
  );
}

/** Presents versioned access edits and an explicit before/after confirmation. */
function AccessEditor({ directory, target, uid, access, onClose, onSaved, onConflict }: {
  directory: UserDirectory; target: AccessTarget | null; uid: string; access: UserPermissionsAccess;
  onClose: () => void; onSaved: (pending: boolean) => void; onConflict: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useKespTheme();
  const [email, setEmail] = useState(target?.user?.email ?? target?.pending?.email ?? DEMO_EMAILS[1]);
  const [organizationId, setOrganizationId] = useState(target?.membership?.organizationId ?? target?.pending?.organizationId ?? access.adminOrganizationIds[0] ?? '');
  const originalRole = target?.membership?.role ?? target?.pending?.role;
  const [role, setRole] = useState<UserAccessRole | ''>(ROLES.includes(originalRole as UserAccessRole) ? originalRole as UserAccessRole : '');
  const [profileId, setProfileId] = useState('');
  const [approveEmail, setApproveEmail] = useState(target === null);
  const [accessEnabled, setAccessEnabled] = useState(target?.user ? !target.user.disabled && target.user.allowed : true);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const resolved = resolveAccessTarget(directory, target, email, organizationId);
  const prepared = prepareAccessUpdate(directory, resolved, { callerUid: uid, adminOrganizationIds: access.adminOrganizationIds, organizationId, email, role, profileId, approveEmail, accessEnabled });
  const selfAdmin = resolved.user?.uid === uid && resolved.membership?.role === 'admin';
  const beforeRole = resolved.membership?.role ?? resolved.pending?.role;
  const beforeProfile = resolved.membership?.salesAgentName ?? resolved.membership?.salesAgentId ?? resolved.membership?.agentAnalysisId ?? resolved.pending?.agentAnalysisId;
  const beforeProfileSalesAgentId = resolved.membership?.salesAgentId ?? directory.profiles.find(
    (profile) => profile.id === (resolved.membership?.agentAnalysisId ?? resolved.pending?.agentAnalysisId),
  )?.salesAgentId;
  const beforeProfileLabel = beforeProfile ? maskKespDemoAgentDisplayName(beforeProfile, beforeProfileSalesAgentId) : t('kesp.users.noProfile');
  const chosenProfile = directory.profiles.find(/** Resolves the explicitly selected profile for confirmation. */ (profile) => profile.id === profileId);
  const organizationName = directory.organizations.find(/** Resolves the selected organization label. */ (organization) => organization.id === organizationId)?.name ?? organizationId;

  /** Saves only after confirmation; backend rechecks every authorization invariant. */
  async function save() {
    if (!prepared.request || saving) return;
    setSaving(true); setError('');
    try {
      // Firebase Functions atomically changes access and records the audit event, without sending email.
      const result = await updateUserAccess(prepared.request);
      onSaved(result.pending);
    } catch (failure) {
      const key = userAccessErrorKey(failure);
      setError(key);
      if (key === 'denied') access.refresh();
    } finally { setSaving(false); }
  }

  /** Renders stored roles without suggesting a legacy role is newly assignable. */
  function roleLabel(value: string | null | undefined) { return value && [...ROLES, 'agent', 'member'].includes(value) ? t(`kesp.users.roles.${value}`) : value ?? t('kesp.users.noRole'); }

  return <Dialog.Root open onOpenChange={/** Blocks dismissing a pending mutation. */ (open) => { if (!open && !saving) onClose(); }}><Dialog.Portal><Dialog.Overlay className="kesp-model-overlay" /><Dialog.Content className="kesp-root kesp-model-dialog kesp-users-dialog" data-theme={theme}>
    <div className="kesp-model-header"><div><Dialog.Title>{t(`kesp.users.${confirming ? 'confirmTitle' : target ? 'edit' : 'addEmail'}`)}</Dialog.Title><Dialog.Description>{t('kesp.users.project', { project: firebaseApp.options.projectId })}</Dialog.Description></div><button className="btn btn-ghost btn-icon" disabled={saving} onClick={onClose} title={t('kesp.users.close')} aria-label={t('kesp.users.close')}><X size={18} /></button></div>
    <form className="kesp-model-body" onSubmit={/** Requires review before executing the mutation. */ (event) => { event.preventDefault(); if (confirming) void save(); else if (prepared.request) { setError(''); setConfirming(true); } }}>
      {confirming ? <div className="kesp-users-confirm">
        <h3>{resolved.user?.displayName ?? email ?? resolved.user?.uid}</h3><p>{email || resolved.user?.uid}</p><p>{organizationName}</p>
        <dl><dt>{t('kesp.users.role')}</dt><dd>{roleLabel(beforeRole)} → {roleLabel(role)}</dd><dt>{t('kesp.users.profile')}</dt><dd>{beforeProfileLabel} → {chosenProfile ? maskKespDemoAgentDisplayName(chosenProfile.name, chosenProfile.salesAgentId) : beforeProfileLabel}</dd><dt>{t('kesp.users.login')}</dt><dd>{t(`kesp.users.${resolved.user ? resolved.user.allowed ? 'approved' : 'notApproved' : resolved.pending ? 'approved' : 'notApproved'}`)} → {t(`kesp.users.${!accessEnabled ? 'disabled' : approveEmail ? 'approved' : 'unchanged'}`)}</dd></dl>
        {!accessEnabled && <p className="kesp-users-error">{t('kesp.users.staysDisabled')}</p>}
        <p>{t('kesp.users.confirmScope')}</p>
      </div> : <div className="kesp-users-form-fields">
        <label>{t('kesp.users.email')}<select disabled={Boolean(target)} value={email} onChange={(event) => { setEmail(event.target.value); setProfileId(''); }}>{DEMO_EMAILS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>{t('kesp.users.organization')}<select required value={organizationId} disabled={Boolean(target?.membership || target?.pending?.organizationId)} onChange={/** Never carries a profile across organizations. */ (event) => { setOrganizationId(event.target.value); setProfileId(''); }}>
          {directory.organizations.filter(/** Restricts assignment choices to current admin grants. */ (entry) => access.adminOrganizationIds.includes(entry.id)).map(/** Displays an authorized organization. */ (entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        <p className="kesp-users-muted">{t('kesp.users.currentRole')}: {roleLabel(beforeRole)}</p>
        <label>{t('kesp.users.role')}<select value={role} onChange={/** Selects a supported assignment role. */ (event) => setRole(event.target.value as UserAccessRole)}><option value="" disabled>{t('kesp.users.selectSupportedRole')}</option>{ROLES.map(/** Disables self-demotion options. */ (value) => <option key={value} value={value} disabled={selfAdmin && value !== 'admin'}>{roleLabel(value)}</option>)}</select></label>
        {selfAdmin && <p className="kesp-users-muted">{t('kesp.users.selfDemotion')}</p>}
        <label>{t('kesp.users.profile')}<select value={profileId} onChange={/** Records only explicit profile edits. */ (event) => setProfileId(event.target.value)}><option value="">{beforeProfile ? t('kesp.users.preserveProfile', { profile: beforeProfileLabel }) : t('kesp.users.noProfile')}</option>{directory.profiles.filter(/** Allows only valid organization-local profiles. */ (profile) => profile.organizationId === organizationId && Boolean(profile.salesAgentId)).map(/** Masks each option by canonical identity without changing its value. */ (profile) => <option key={profile.id} value={profile.id}>{maskKespDemoAgentDisplayName(profile.name, profile.salesAgentId)}</option>)}</select></label>
        <label className="kesp-users-checkbox"><input type="checkbox" checked={accessEnabled} onChange={(event) => { setAccessEnabled(event.target.checked); if (event.target.checked) setApproveEmail(true); }} />{t('kesp.users.accessEnabled')}</label>
        <label className="kesp-users-checkbox"><input type="checkbox" disabled={!accessEnabled} checked={approveEmail} onChange={/** Requires an explicit approval decision outside onboarding. */ (event) => setApproveEmail(event.target.checked)} />{t('kesp.users.approveEmail')}</label>
        {prepared.error && <p className="kesp-users-error" role="status">{t(`kesp.users.${prepared.error}`)}</p>}
      </div>}
      {error && <p className="kesp-users-error" role="alert">{t(`kesp.users.${error}`)}</p>}
      <div className="kesp-users-actions kesp-users-form-footer">
        {error === 'conflict' ? <button type="button" className="btn btn-primary" onClick={onConflict}><RefreshCw size={16} />{t('kesp.users.refresh')}</button> : <>
          {confirming && <button type="button" className="btn btn-soft" disabled={saving} onClick={/** Returns to editing without saving. */ () => { setConfirming(false); setError(''); }}><ArrowLeft size={16} />{t('kesp.users.back')}</button>}
          <button type="submit" className="btn btn-primary" disabled={!prepared.request || saving || error === 'denied'}><Check size={16} />{t(`kesp.users.${saving ? 'saving' : confirming ? 'confirmSave' : 'review'}`)}</button>
        </>}
      </div>
    </form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

/** Reads explicit pages of audit history without suggesting a partial history is complete. */
function AccessAudit({ organizationId, onDenied }: { organizationId: string; onDenied: () => void }) {
  const { t, i18n } = useTranslation();
  const [events, setEvents] = useState<UserAccessAuditEvent[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [request, setRequest] = useState<{ pageToken?: string; revision: number }>({ revision: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(/** Cancels late audit responses after scope changes or revocation. */ () => {
    let cancelled = false;
    /** Fetches one organization-restricted audit page. */
    async function load() {
      try {
        // Firebase Functions verifies the caller still administers this audit scope.
        const result = await listUserAccessAudit({ organizationId, ...(request.pageToken ? { pageToken: request.pageToken } : {}) });
        if (cancelled) return;
        setEvents(/** Appends only an explicitly requested continuation. */ (current) => request.pageToken ? [...current, ...result.events] : result.events);
        setNextToken(result.nextPageToken);
      } catch (failure) {
        if (cancelled) return;
        const key = userAccessErrorKey(failure); setError(key);
        if (key === 'denied') { setEvents([]); onDenied(); }
      } finally { if (!cancelled) setLoading(false); }
    }
    void load();
    return /** Ignores results outside the current audit scope. */ () => { cancelled = true; };
  }, [organizationId, request, onDenied]);
  return <div className="kesp-users-audit">
    {events.map(/** Displays stored limited before/after access fields without reinterpretation. */ (event) => <details key={event.id}><summary>{formatKespDate(event.createdAt ? new Date(event.createdAt) : null, i18n.resolvedLanguage, { dateStyle: 'short', timeStyle: 'short' })} · {event.email} · {event.action}</summary><p>{t('kesp.users.actor')}: {event.actorUid}</p><div className="kesp-users-audit-values"><div><strong>{t('kesp.users.before')}</strong><pre>{JSON.stringify(event.before, null, 2)}</pre></div><div><strong>{t('kesp.users.after')}</strong><pre>{JSON.stringify(event.after, null, 2)}</pre></div></div></details>)}
    {loading && <p role="status">{t('kesp.users.auditLoading')}</p>}
    {error && <p role="alert">{t(`kesp.users.${error}`)}</p>}
    {!loading && !error && !events.length && <p>{t('kesp.users.noAudit')}</p>}
    {!loading && !error && events.length > 0 && <p className="kesp-users-muted">{t(`kesp.users.${nextToken ? 'auditPartial' : 'auditComplete'}`, { count: events.length })}</p>}
    {!loading && (error || nextToken) && <button className="btn btn-soft" onClick={/** Loads more history or retries exactly the failed page. */ () => { setLoading(true); setError(''); setRequest(/** Advances the cursor only after a successful page. */ (current) => ({ pageToken: error ? current.pageToken : nextToken ?? undefined, revision: current.revision + 1 })); }}>{t(`kesp.users.${error ? 'retry' : 'loadMore'}`)}</button>}
  </div>;
}
