import { httpsCallable } from 'firebase/functions';
import { functions } from './firebaseFunctions';

export type UserAccessRole = 'supervisor' | 'admin';

export interface Membership {
  organizationId: string;
  role: string | null;
  salesAgentId: string | null;
  agentAnalysisId: string | null;
  salesAgentName: string | null;
  version: string;
}

export interface DirectoryUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  disabled: boolean;
  allowed: boolean;
  memberships: Membership[];
}

export interface PendingUser {
  id: string;
  email: string;
  organizationId: string | null;
  role: string | null;
  agentAnalysisId: string | null;
  version: string;
}

export interface UserAccessContext { adminOrganizationIds: string[] }

export interface UserDirectory extends UserAccessContext {
  users: DirectoryUser[];
  pending: PendingUser[];
  organizations: { id: string; name: string }[];
  profiles: { id: string; organizationId: string; salesAgentId: string; name: string }[];
  nextPageToken: string | null;
}

export interface UpdateUserAccessInput {
  organizationId: string;
  uid?: string;
  email?: string;
  role: UserAccessRole;
  agentAnalysisId?: string;
  expectedVersion: string | null;
  approveEmail: boolean;
  accessEnabled?: boolean;
}

export interface UserAccessAuditEvent {
  id: string;
  actorUid: string;
  targetUid: string | null;
  email: string;
  organizationId: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  createdAt: string | null;
}

/** Checks current organization administration without granting Consubanco access. */
export async function getUserAccessContext(): Promise<UserAccessContext> {
  // Firebase Functions resolves the caller's current persisted memberships.
  const result = await httpsCallable<Record<string, never>, UserAccessContext>(functions, 'getUserAccessContext')({});
  return result.data;
}

/** Fetches one directory page; metadata is returned on the first page only. */
export async function listUserDirectory(input: { pageToken?: string } = {}): Promise<UserDirectory> {
  // Firebase Functions lists sanitized Auth accounts for an organization admin.
  const result = await httpsCallable<typeof input, UserDirectory>(functions, 'listUserDirectory', { timeout: 120_000 })(input);
  return result.data;
}

/** Saves an explicitly confirmed, version-checked organization access change. */
export async function updateUserAccess(input: UpdateUserAccessInput) {
  // Firebase Functions rechecks admin authority, profile validity, and stale versions.
  const result = await httpsCallable<UpdateUserAccessInput, { success: true; pending: boolean; uid: string | null }>(functions, 'updateUserAccess')(input);
  return result.data;
}

/** Reads a page of audit history for one administered organization. */
export async function listUserAccessAudit(input: { organizationId: string; pageToken?: string }) {
  // Firebase Functions restricts audit visibility to this organization's current admins.
  const result = await httpsCallable<typeof input, { events: UserAccessAuditEvent[]; nextPageToken: string | null }>(functions, 'listUserAccessAudit')(input);
  return result.data;
}

/** Maps callable failure codes without displaying backend internals. */
export function userAccessErrorKey(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code).replace('functions/', '') : '';
  if (code === 'permission-denied' || code === 'unauthenticated') return 'denied';
  if (code === 'aborted' || code === 'already-exists') return 'conflict';
  if (code === 'failed-precondition') return 'precondition';
  if (code === 'invalid-argument' || code === 'not-found') return 'invalid';
  return 'error';
}
