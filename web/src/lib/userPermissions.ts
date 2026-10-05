import { DEMO_PASSWORD_EMAIL, DEMO_PASSWORD_UID } from './demoPolicy.ts';
import type { DirectoryUser, Membership, PendingUser, UpdateUserAccessInput, UserAccessRole, UserDirectory } from '../services/userPermissions';

export interface DirectoryRow { user: DirectoryUser; membership?: Membership }
export interface AccessTarget { user?: DirectoryUser; membership?: Membership; pending?: PendingUser }

/** Applies global filters only to a fully loaded directory, preserving multi-org rows. */
export function groupDirectory(directory: UserDirectory, search: string, organizationId: string, role: string) {
  const groups = new Map<string, DirectoryRow[]>();
  const needle = search.trim().toLowerCase();
  for (const user of directory.users) {
    if (needle && !`${user.displayName ?? ''} ${user.email ?? ''} ${user.uid}`.toLowerCase().includes(needle)) continue;
    const memberships: (Membership | undefined)[] = user.memberships.length ? user.memberships : [undefined];
    for (const membership of memberships) {
      const id = membership?.organizationId ?? '';
      if (organizationId !== '*' && id !== organizationId) continue;
      if (role !== '*' && (membership?.role ?? '') !== role) continue;
      const rows = groups.get(id) ?? [];
      rows.push({ user, membership });
      groups.set(id, rows);
    }
  }
  return groups;
}

/** Resolves exact normalized emails against the full directory before editing. */
export function resolveAccessTarget(directory: UserDirectory, target: AccessTarget | null, email: string, organizationId: string): AccessTarget {
  const normalized = email.trim().toLowerCase();
  const user = target?.user ?? directory.users.find(/** Matches only the exact email. */ (entry) => entry.email?.toLowerCase() === normalized);
  const membership = user?.memberships.find(/** Finds the selected organization's version. */ (entry) => entry.organizationId === organizationId);
  const pending = directory.pending.find(/** Prefers an organization-specific pending assignment. */ (entry) => entry.email.toLowerCase() === normalized && entry.organizationId === organizationId)
    ?? directory.pending.find(/** Retains the version of a plain approved email. */ (entry) => entry.email.toLowerCase() === normalized && entry.organizationId === null);
  return { user, membership, pending };
}

/** Validates editable fields and omits unchanged profile links from the mutation. */
export function prepareAccessUpdate(directory: UserDirectory, target: AccessTarget, input: {
  callerUid: string;
  adminOrganizationIds: string[];
  organizationId: string;
  email: string;
  role: UserAccessRole | '';
  profileId: string;
  approveEmail: boolean;
  accessEnabled?: boolean;
}): { request?: UpdateUserAccessInput; error?: string } {
  const { membership, user, pending } = target;
  if (input.role !== 'supervisor' && input.role !== 'admin') return { error: 'unsupportedRole' };
  const passwordIdentity = user?.uid === DEMO_PASSWORD_UID && user.email === DEMO_PASSWORD_EMAIL;
  const email = (user?.email ?? input.email).trim().toLowerCase();
  if (input.organizationId !== 'consubanco' || (!passwordIdentity &&
      (user?.uid === DEMO_PASSWORD_UID || email === DEMO_PASSWORD_EMAIL))) return { error: 'denied' };
  if (passwordIdentity && input.role !== 'supervisor') return { error: 'unsupportedRole' };
  if (user?.uid === input.callerUid) return { error: 'selfDemotion' };
  if (!input.adminOrganizationIds.includes(input.organizationId)) return { error: 'denied' };
  if (email.length > 254 || !/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(email)) return { error: 'invalidEmail' };
  if (!user && ((!input.approveEmail && input.accessEnabled !== false) || input.profileId)) return { error: 'precondition' };
  const profile = directory.profiles.find(/** Validates explicit profile selection within its organization. */ (entry) => entry.id === input.profileId && entry.organizationId === input.organizationId && Boolean(entry.salesAgentId));
  if (input.profileId && !profile) return { error: 'profileRequired' };
  return { request: {
    organizationId: input.organizationId,
    ...(user ? { uid: user.uid } : { email }),
    role: input.role,
    ...(profile ? { agentAnalysisId: profile.id } : {}),
    // Pending grants carry the config snapshot version, including plain email approvals.
    expectedVersion: user ? membership?.version ?? null : pending?.version ?? null,
    approveEmail: input.approveEmail,
    ...(input.accessEnabled !== undefined ? { accessEnabled: input.accessEnabled } : {}),
  } };
}
