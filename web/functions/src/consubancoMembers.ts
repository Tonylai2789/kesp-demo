import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from './demoHttps';
import {
  assertDemoRequest, assertDemoEmailEnabled, readDemoInitialRole, DEMO_ORGANIZATION_ID,
  demoEmail, demoId, validateDemoAuthUser, validateDemoMember,
  DEMO_PASSWORD_EMAIL,
} from './demoAccess';

type Dependencies = { db: FirebaseFirestore.Firestore; auth: admin.auth.Auth };
type Request = CallableRequest<Record<string, unknown>>;

/** Uses the committed update time to reject stale permission editors. */
function version(snapshot: FirebaseFirestore.DocumentSnapshot): string | null {
  return snapshot.updateTime ? snapshot.updateTime.seconds + ':' + snapshot.updateTime.nanoseconds : null;
}

/** Restricts responses and audit history to membership-owned fields. */
function fields(data: FirebaseFirestore.DocumentData | undefined) {
  return {
    role: data?.role ?? null,
    accessEnabled: data?.accessEnabled !== false,
    salesAgentId: data?.salesAgentId ?? null,
    agentAnalysisId: data?.agentAnalysisId ?? null,
    salesAgentName: data?.salesAgentName ?? null,
  };
}

/** Reads authenticated live capability without listing other accounts. */
export async function handleGetUserAccessContext(request: Request, dependencies: Dependencies) {
  const identity = await assertDemoRequest(request, dependencies.db, dependencies.auth);
  // Firestore holds the current grant; token/custom claims never supply the role.
  const member = await dependencies.db.doc('organizations/consubanco/members/' + identity.uid).get();
  const role = member.exists ? validateDemoMember(member.data(), identity.uid, identity.email) : null;
  return { adminOrganizationIds: role === 'admin' ? [DEMO_ORGANIZATION_ID] : [] };
}

/** Enforces admin access before any Auth directory or permission lookup. */
async function requireAdmin(request: Request, dependencies: Dependencies) {
  const result = await handleGetUserAccessContext(request, dependencies);
  if (!result.adminOrganizationIds.length) throw new HttpsError('permission-denied', 'Demo admin access required.');
  return request.auth!.uid;
}

/** Lists only the approved identities, never the project's unrelated Auth users. */
export async function handleListUserDirectory(request: Request, dependencies: Dependencies) {
  await requireAdmin(request, dependencies);
  if (request.data?.pageToken !== undefined) throw new HttpsError('invalid-argument', 'The demo directory has one page.');
  const users = [];
  const pending = [];
  const allowSnapshot = await dependencies.db.doc('config/allowedEmails').get();
  const allowed = allowSnapshot.data()?.emails;
  const members = await dependencies.db.collection('organizations/consubanco/members').get();
  // Include disabled memberships so an admin can restore access.
  const emails = new Set<string>([
    ...(Array.isArray(allowed) ? allowed.filter((value): value is string => typeof value === 'string') : []),
    ...members.docs.map((doc) => doc.data().email).filter((value): value is string => typeof value === 'string'),
  ]);
  for (const email of emails) {
    let user: admin.auth.UserRecord;
    try {
      // Firebase Auth resolves only one explicitly permitted email.
      user = await dependencies.auth.getUserByEmail(email);
    } catch (error) {
      if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
      if (Array.isArray(allowed) && allowed.includes(email)) {
        pending.push({ id: 'demo:' + email, email, organizationId: DEMO_ORGANIZATION_ID,
          role: readDemoInitialRole(demoEmail(email), allowSnapshot.data()), agentAnalysisId: null, version: version(allowSnapshot) ?? '' });
      }
      continue;
    }
    const member = await dependencies.db.doc('organizations/consubanco/members/' + user.uid).get();
    if (!member.exists && !user.providerData.length && Array.isArray(allowed) && allowed.includes(email)) {
      pending.push({ id: 'demo:' + email, email, organizationId: DEMO_ORGANIZATION_ID,
        role: readDemoInitialRole(demoEmail(email), allowSnapshot.data()), agentAnalysisId: null, version: version(allowSnapshot) ?? '' });
      continue;
    }
    users.push({
      uid: user.uid, email, displayName: user.displayName ?? null, disabled: user.disabled || member.data()?.accessEnabled === false,
      allowed: Array.isArray(allowed) && allowed.includes(email),
      memberships: member.exists ? [{ organizationId: DEMO_ORGANIZATION_ID, ...fields(member.data()), version: version(member) }] : [],
    });
  }
  // Firestore profile metadata supplies only same-organization agent link choices.
  const profileDocs = await dependencies.db.collection('agent_analyses')
    .where('organizationId', '==', DEMO_ORGANIZATION_ID).where('visibilityScope', '==', 'organization').get();
  const profiles = profileDocs.docs.filter((doc) => typeof doc.data().salesAgentId === 'string').map((doc) => ({
    id: doc.id, organizationId: DEMO_ORGANIZATION_ID, salesAgentId: doc.data().salesAgentId,
    name: doc.data().salesAgentName ?? doc.data().agentName ?? doc.id,
  }));
  await requireAdmin(request, dependencies);
  return {
    users, pending, profiles, organizations: [{ id: DEMO_ORGANIZATION_ID, name: 'KESP Demo' }],
    adminOrganizationIds: [DEMO_ORGANIZATION_ID], nextPageToken: null,
  };
}

/** Approves a future Google sign-in without creating an unverified Auth identity. */
async function updatePendingAccess(request: Request, dependencies: Dependencies, actorUid: string, email: string) {
  const input = request.data;
  if (input.uid !== undefined || email === DEMO_PASSWORD_EMAIL || input.agentAnalysisId !== undefined ||
      (input.accessEnabled !== false && input.approveEmail !== true)) {
    throw new HttpsError('invalid-argument', 'Explicit approval of a Google email is required.');
  }
  const actorIdentity = await assertDemoRequest(request, dependencies.db, dependencies.auth);
  const organizationRef = dependencies.db.doc('organizations/consubanco');
  const allowRef = dependencies.db.doc('config/allowedEmails');
  const auditRef = organizationRef.collection('access_audit').doc();
  await dependencies.db.runTransaction(async (transaction) => {
    const organization = await transaction.get(organizationRef);
    const actor = await transaction.get(organizationRef.collection('members').doc(actorUid));
    const allow = await transaction.get(allowRef);
    // A first login may race this pending edit. Never silently update its role.
    const targets = await transaction.get(organizationRef.collection('members').where('email', '==', email));
    assertDemoEmailEnabled(actorIdentity.email, allow.data());
    if (!organization.exists || validateDemoMember(actor.data(), actorUid, actorIdentity.email) !== 'admin') {
      throw new HttpsError('permission-denied', 'Admin access has changed.');
    }
    const existing = Array.isArray(allow.data()?.emails) && allow.data()!.emails.includes(email);
    if (!targets.empty || (existing ? version(allow) : null) !== input.expectedVersion) {
      throw new HttpsError('aborted', 'Permissions changed. Refresh and retry.');
    }
    const enabled = input.accessEnabled !== false;
    transaction.set(allowRef, {
      emails: enabled ? FieldValue.arrayUnion(email) : FieldValue.arrayRemove(email),
      initialRoles: { [email]: input.role },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.update(organizationRef, { accessRevision: FieldValue.increment(1) });
    transaction.create(auditRef, { actorUid, targetUid: null, email, organizationId: DEMO_ORGANIZATION_ID,
      action: enabled ? 'email_approved' : 'email_revoked',
      before: existing ? { role: allow.data()?.initialRoles?.[email] ?? null } : null,
      after: { role: input.role, accessEnabled: enabled }, createdAt: FieldValue.serverTimestamp() });
  });
  if (input.accessEnabled !== false) {
    // Public signup stays disabled. Precreate only an unverified, passwordless
    // identity; the membership still requires a real verified Google sign-in.
    try {
      await dependencies.auth.createUser({ email, emailVerified: false });
    } catch (error) {
      if ((error as { code?: string }).code !== 'auth/email-already-exists') {
        throw new HttpsError('failed-precondition', 'Email approval saved, but Auth provisioning failed. Refresh and retry the pending approval.');
      }
    }
  }
  return { success: true as const, pending: true, uid: null };
}

/** Edits an account or pending approval with live authority and an atomic audit. */
export async function handleUpdateUserAccess(request: Request, dependencies: Dependencies) {
  const actorUid = await requireAdmin(request, dependencies);
  const input = request.data ?? {};
  const acceptedFields = ['organizationId', 'uid', 'email', 'role', 'agentAnalysisId', 'expectedVersion', 'approveEmail', 'accessEnabled'];
  if (Object.keys(input).some((key) => !acceptedFields.includes(key)) ||
      (input.accessEnabled !== undefined && typeof input.accessEnabled !== 'boolean')) {
    throw new HttpsError('invalid-argument', 'Unsupported access update fields.');
  }
  if (input.organizationId !== DEMO_ORGANIZATION_ID) throw new HttpsError('permission-denied', 'Only the demo organization is supported.');
  if (!['supervisor', 'admin'].includes(String(input.role)) ||
      !(input.expectedVersion === null || typeof input.expectedVersion === 'string') ||
      typeof input.approveEmail !== 'boolean') throw new HttpsError('invalid-argument', 'Invalid access update.');
  const role = input.role as 'agent' | 'supervisor' | 'admin';
  const requestedEmail = input.email === undefined ? undefined : demoEmail(input.email);
  let target: admin.auth.UserRecord;
  try {
    // Firebase Auth resolves the target; a client cannot substitute a different UID/email binding.
    target = input.uid !== undefined ? await dependencies.auth.getUser(demoId(input.uid))
      : await dependencies.auth.getUserByEmail(demoEmail(input.email));
  } catch (error) {
    if ((error as { code?: string }).code === 'auth/user-not-found' && requestedEmail && input.uid === undefined) {
      return updatePendingAccess(request, dependencies, actorUid, requestedEmail);
    }
    throw error;
  }
  if (!target.disabled && !target.providerData.length && requestedEmail && input.uid === undefined &&
      demoEmail(target.email) === requestedEmail) {
    return updatePendingAccess(request, dependencies, actorUid, requestedEmail);
  }
  const email = validateDemoAuthUser(target);
  if (email === DEMO_PASSWORD_EMAIL && role !== 'supervisor') {
    throw new HttpsError('permission-denied', 'The demo password account must remain a supervisor.');
  }
  if (requestedEmail && requestedEmail !== email) throw new HttpsError('invalid-argument', 'UID and email do not match.');
  if (target.uid === actorUid) throw new HttpsError('failed-precondition', 'You cannot edit your own membership.');
  const organizationRef = dependencies.db.doc('organizations/consubanco');
  const actorRef = organizationRef.collection('members').doc(actorUid);
  const targetRef = organizationRef.collection('members').doc(target.uid);
  const auditRef = organizationRef.collection('access_audit').doc();
  const actorIdentity = await assertDemoRequest(request, dependencies.db, dependencies.auth);
  // Firestore retries conflicting role changes and commits the audit with the grant.
  await dependencies.db.runTransaction(async (transaction) => {
    const organization = await transaction.get(organizationRef);
    const actor = await transaction.get(actorRef);
    const current = await transaction.get(targetRef);
    const allowRef = dependencies.db.doc('config/allowedEmails');
    const allow = await transaction.get(allowRef);
    assertDemoEmailEnabled(demoEmail(actorIdentity.email), allow.data());
    if (!organization.exists || validateDemoMember(actor.data(), actorUid, actorIdentity.email) !== 'admin') {
      throw new HttpsError('permission-denied', 'Admin access has changed.');
    }
    if (version(current) !== input.expectedVersion) throw new HttpsError('aborted', 'Permissions changed. Refresh and retry.');
    const enabled = input.accessEnabled ?? (current.data()?.accessEnabled !== false);
    if (enabled && !input.approveEmail) assertDemoEmailEnabled(email, allow.data());
    // A disabled target may be restored by another admin; its identity must still match.
    if (current.exists) validateDemoMember({ ...current.data(), accessEnabled: true }, target.uid, email);
    if (current.data()?.role === 'admin' && (role !== 'admin' || !enabled)) {
      const admins = await transaction.get(organizationRef.collection('members').where('role', '==', 'admin'));
      if (admins.size <= 1) throw new HttpsError('failed-precondition', 'The last admin cannot be removed.');
    }
    const currentData = current.data();
    const profileId = input.agentAnalysisId ?? (role === 'agent' ? currentData?.agentAnalysisId : undefined);
    let profileFields: Record<string, string> = {};
    if (role === 'agent' && !profileId) throw new HttpsError('failed-precondition', 'Agent access requires a linked profile.');
    if (profileId !== undefined) {
      const profile = await transaction.get(dependencies.db.doc('agent_analyses/' + demoId(profileId)));
      const data = profile.data();
      if (!data || data.organizationId !== DEMO_ORGANIZATION_ID || data.visibilityScope !== 'organization' || typeof data.salesAgentId !== 'string') {
        throw new HttpsError('failed-precondition', 'Select an organization-visible demo profile.');
      }
      profileFields = { agentAnalysisId: profile.id, salesAgentId: data.salesAgentId, salesAgentName: data.salesAgentName ?? data.agentName ?? profile.id };
    }
    const payload = {
      uid: target.uid, email, organizationId: DEMO_ORGANIZATION_ID, organizationName: 'KESP Demo',
      role, ...profileFields, accessEnabled: enabled, demo: true, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid,
      ...(!current.exists ? { createdAt: FieldValue.serverTimestamp() } : {}),
    };
    transaction.set(targetRef, payload, { merge: true });
    transaction.set(allowRef, {
      ...(enabled && input.approveEmail ? { emails: FieldValue.arrayUnion(email) } : {}),
      ...(!enabled ? { emails: FieldValue.arrayRemove(email) } : {}),
      initialRoles: { [email]: role },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.update(organizationRef, { accessRevision: FieldValue.increment(1) });
    transaction.create(auditRef, {
      actorUid, targetUid: target.uid, email, organizationId: DEMO_ORGANIZATION_ID, action: enabled ? 'membership_updated' : 'membership_disabled',
      before: current.exists ? fields(currentData) : null,
      after: fields({ ...currentData, ...payload }), createdAt: FieldValue.serverTimestamp(),
    });
  });
  return { success: true as const, pending: false, uid: target.uid };
}

/** Lists a bounded page of backend-only audit entries after live admin checks. */
export async function handleListUserAccessAudit(request: Request, dependencies: Dependencies) {
  await requireAdmin(request, dependencies);
  if (request.data?.organizationId !== DEMO_ORGANIZATION_ID) throw new HttpsError('permission-denied', 'Invalid organization.');
  const collection = dependencies.db.collection('organizations/consubanco/access_audit');
  let query = collection.orderBy('createdAt', 'desc').limit(51);
  if (request.data?.pageToken !== undefined) {
    const cursor = await collection.doc(demoId(request.data.pageToken)).get();
    if (!cursor.exists) throw new HttpsError('invalid-argument', 'Invalid cursor.');
    query = query.startAfter(cursor);
  }
  // Firestore returns only a bounded audit page, not membership or customer contents.
  const page = await query.get();
  const events = page.docs.slice(0, 50).map((doc) => {
    const data = doc.data();
    return {
      id: doc.id, actorUid: data.actorUid, targetUid: data.targetUid, email: data.email,
      organizationId: DEMO_ORGANIZATION_ID, action: data.action, before: data.before, after: data.after,
      createdAt: data.createdAt?.toDate().toISOString() ?? null,
    };
  });
  await requireAdmin(request, dependencies);
  return { events, nextPageToken: page.size > 50 ? events[49].id : null };
}

/** Constructs dependencies only during invocation, after Admin initialization. */
function dependencies(): Dependencies { return { db: admin.firestore(), auth: admin.auth() }; }

export const getUserAccessContext = onCall({ timeoutSeconds: 60, invoker: 'public' }, async (request) => handleGetUserAccessContext(request, dependencies()));
export const listUserDirectory = onCall({ timeoutSeconds: 120 }, async (request) => handleListUserDirectory(request, dependencies()));
export const updateUserAccess = onCall({ timeoutSeconds: 60 }, async (request) => handleUpdateUserAccess(request, dependencies()));
export const listUserAccessAudit = onCall({ timeoutSeconds: 60 }, async (request) => handleListUserAccessAudit(request, dependencies()));
