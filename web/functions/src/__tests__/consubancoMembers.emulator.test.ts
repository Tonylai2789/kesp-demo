import { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { handleGetUserAccessContext, handleListUserDirectory, handleUpdateUserAccess, handleListUserAccessAudit } from '../consubancoMembers';
import { handleEnsureConsubancoMembershipForCurrentUser } from '../consubancoMembership';
import { readDemoMember, DEMO_PASSWORD_UID, DEMO_PASSWORD_EMAIL } from '../demoAccess';

const enabled = process.env.KESP_DEMO_AUTH_EMULATOR_TESTS === '1';
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = 'demo-kesp-auth';
if (enabled && !/^127\.0\.0\.1:\d+$/.test(host ?? '')) throw new Error('Loopback-only demo emulator required.');
const suite = enabled ? describe : describe.skip;
const emails: Record<string, string> = { tony: 'admin@example.com', logi: 'supervisor@example.com', third: 'new-supervisor@example.com', [DEMO_PASSWORD_UID]: DEMO_PASSWORD_EMAIL };
const invitedUsers = new Map<string, UserRecord>();
type Request = CallableRequest<Record<string, unknown>>;
/** Uses only synthetic Auth fixtures. */
function account(uid: string): UserRecord {
  if (invitedUsers.has(uid)) return invitedUsers.get(uid)!;
  if (uid === DEMO_PASSWORD_UID) return { uid, email: DEMO_PASSWORD_EMAIL, emailVerified: false, disabled: false, providerData: [{ providerId: 'password', email: DEMO_PASSWORD_EMAIL }] } as UserRecord;
  return { uid, email: emails[uid], emailVerified: true, disabled: false, providerData: [{ providerId: 'google.com', email: emails[uid] }] } as UserRecord;
}
const auth = {
  getUser: jest.fn(async (uid: string) => account(uid)),
  getUserByEmail: jest.fn(async (email: string) => {
    const invited = [...invitedUsers.values()].find((user) => user.email === email);
    if (invited) return invited;
    const uid = Object.keys(emails).find((key) => emails[key] === email);
    if (!uid) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
    return account(uid);
  }),
  createUser: jest.fn(async (properties: { email: string; emailVerified?: boolean }) => {
    if ([...invitedUsers.values()].some((user) => user.email === properties.email)) {
      throw Object.assign(new Error('already exists'), { code: 'auth/email-already-exists' });
    }
    const user = { uid: 'invited-' + invitedUsers.size, email: properties.email,
      emailVerified: properties.emailVerified === true, disabled: false, providerData: [] } as unknown as UserRecord;
    invitedUsers.set(user.uid, user);
    return user;
  }),
} as unknown as Auth;
/** Builds a verified Google request with no client role authority. */
function request(uid: string, data: Record<string, unknown> = {}): Request {
  if (uid === DEMO_PASSWORD_UID) return { data, auth: { uid, token: { email: DEMO_PASSWORD_EMAIL, email_verified: false, auth_time: 1900000000, firebase: { sign_in_provider: 'password' } } } } as Request;
  return { data, auth: { uid, token: { email: emails[uid], email_verified: true, auth_time: 1900000000, firebase: { sign_in_provider: 'google.com' } } } } as Request;
}
/** Generates an unsigned Firebase emulator token; never usable against real services. */
function token(uid: string, extra: Record<string, unknown> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({
    aud: projectId, iss: 'https://securetoken.google.com/' + projectId, sub: uid, user_id: uid,
    email: emails[uid], email_verified: true, firebase: { sign_in_provider: 'google.com' },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...extra,
  }) + '.';
}

suite('demo membership and Firestore rules integration', () => {
  let db: Firestore;
  /** Clears only our explicitly loopback emulator database. */
  async function clear() {
    const result = await fetch('http://' + host + '/emulator/v1/projects/' + projectId + '/databases/(default)/documents', { method: 'DELETE' });
    if (!result.ok) throw new Error('Emulator reset failed.');
  }
  /** Seeds only synthetic identities and a fictional profile/call. */
  async function seed() {
    const batch = db.batch();
    const docs: Record<string, unknown> = {
      'config/allowedEmails': { emails: [emails.tony, emails.logi, DEMO_PASSWORD_EMAIL],
        initialRoles: { [emails.tony]: 'admin', [emails.logi]: 'supervisor', [DEMO_PASSWORD_EMAIL]: 'supervisor' } },
      'organizations/consubanco': { organizationName: 'KESP Demo' },
      'organizations/consubanco/members/tony': { uid: 'tony', email: emails.tony, organizationId: 'consubanco', role: 'admin' },
      'organizations/consubanco/members/logi': { uid: 'logi', email: emails.logi, organizationId: 'consubanco', role: 'supervisor' },
      'agent_analyses/profile': { organizationId: 'consubanco', visibilityScope: 'organization', salesAgentId: 'fictional', salesAgentName: 'Demo Agent', uploadedBy: 'tony' },
      'calls/call': { uploadedBy: 'tony', organizationId: 'consubanco', visibilityScope: 'organization', salesAgentId: 'fictional', status: 'complete', name: 'Demo' },
    };
    for (const [path, data] of Object.entries(docs)) batch.set(db.doc(path), data as FirebaseFirestore.DocumentData);
    await batch.commit();
  }
  /** Gets the current concurrency token used by the UI. */
  async function version(uid: string) {
    const doc = await db.doc('organizations/consubanco/members/' + uid).get();
    return doc.updateTime ? doc.updateTime.seconds + ':' + doc.updateTime.nanoseconds : null;
  }
  /** Sends a client-rule REST request, rather than bypassing rules through Admin SDK. */
  async function rest(path: string, uid: string, method = 'GET', fields?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return fetch('http://' + host + '/v1/projects/' + projectId + '/databases/(default)/documents/' + path, {
      method, headers: { Authorization: 'Bearer ' + token(uid, extra), 'Content-Type': 'application/json' },
      ...(fields ? { body: JSON.stringify({ fields }) } : {}),
    });
  }
  beforeAll(() => { db = new Firestore({ projectId, host, ssl: false }); });
  beforeEach(async () => { invitedUsers.clear(); jest.clearAllMocks(); await clear(); await seed(); }, 30000);
  afterAll(async () => { await clear(); await db.terminate(); });
  it('lists exactly three approved accounts and denies supervisors the directory', async () => {
    const deps = { db, auth };
    expect(await handleGetUserAccessContext(request('tony'), deps)).toEqual({ adminOrganizationIds: ['consubanco'] });
    expect(await handleGetUserAccessContext(request('logi'), deps)).toEqual({ adminOrganizationIds: [] });
    expect((await handleListUserDirectory(request('tony'), deps)).users).toHaveLength(3);
    await expect(handleListUserDirectory(request('logi'), deps)).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('bootstraps the fixed password supervisor but rejects directory access and promotion', async () => {
    const login = request(DEMO_PASSWORD_UID) as CallableRequest<Record<string, never>>;
    expect(await handleEnsureConsubancoMembershipForCurrentUser(login, { db, auth })).toMatchObject({ created: true, role: 'supervisor' });
    expect(await handleGetUserAccessContext(request(DEMO_PASSWORD_UID), { db, auth })).toEqual({ adminOrganizationIds: [] });
    await expect(handleListUserDirectory(request(DEMO_PASSWORD_UID), { db, auth })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(handleUpdateUserAccess(request('tony', {
      organizationId: 'consubanco', uid: DEMO_PASSWORD_UID, role: 'admin',
      expectedVersion: await version(DEMO_PASSWORD_UID), approveEmail: false,
    }), { db, auth })).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await db.doc('organizations/consubanco/members/' + DEMO_PASSWORD_UID).get()).data()?.role).toBe('supervisor');
  });
  it('requires approval plus live membership for an arbitrary verified Google email', async () => {
    await db.doc('organizations/consubanco/members/third').set({ uid: 'third', email: emails.third, organizationId: 'consubanco', role: 'admin' });
    await expect(readDemoMember('third', db, auth)).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await rest('calls/call', 'third')).status).toBe(403);
    await db.doc('config/allowedEmails').update({ emails: Object.values(emails) });
    await expect(readDemoMember('third', db, auth)).resolves.toMatchObject({ role: 'admin' });
    expect((await rest('calls/call', 'third')).status).toBe(200);
  });
  it('preserves existing memberships byte-for-byte despite changed initial roles', async () => {
    const login = request('logi') as CallableRequest<Record<string, never>>;
    await db.doc('organizations/consubanco/members/logi').delete();
    expect(await handleEnsureConsubancoMembershipForCurrentUser(login, { db, auth })).toMatchObject({ created: true, role: 'supervisor' });
    await db.doc('organizations/consubanco/members/logi').update({ role: 'agent', salesAgentId: 'fictional' });
    await db.doc('config/allowedEmails').update({ initialRoles: {} });
    const before = await db.doc('organizations/consubanco/members/logi').get();
    expect(await handleEnsureConsubancoMembershipForCurrentUser(login, { db, auth })).toMatchObject({ created: false, role: 'agent' });
    const after = await db.doc('organizations/consubanco/members/logi').get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime!.isEqual(before.updateTime!)).toBe(true);
    await expect(handleEnsureConsubancoMembershipForCurrentUser(request('third') as CallableRequest<Record<string, never>>, { db, auth })).rejects.toThrow();
  });
  it('blocks self edits, supervisor edits, other organizations and stale third-email approval', async () => {
    const input = { organizationId: 'consubanco', uid: 'logi', role: 'admin', expectedVersion: await version('logi'), approveEmail: false };
    for (const [actor, changes] of [
      ['logi', {}], ['tony', { uid: 'tony' }], ['tony', { organizationId: 'other' }],
      ['tony', { uid: 'third', email: emails.third, approveEmail: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      await expect(handleUpdateUserAccess(request(actor, { ...input, ...changes }), { db, auth })).rejects.toThrow();
    }
  });
  it('writes supported roles and audit atomically, rejects agent assignments and stale editors', async () => {
    const input = { organizationId: 'consubanco', uid: 'logi', role: 'admin', expectedVersion: await version('logi'), approveEmail: false };
    await expect(handleUpdateUserAccess(request('tony', {...input,role:'agent'}), { db, auth })).rejects.toMatchObject({ code: 'invalid-argument' });
    await handleUpdateUserAccess(request('tony', { ...input, agentAnalysisId: 'profile' }), { db, auth });
    expect((await db.doc('organizations/consubanco/members/logi').get()).data()).toMatchObject({ role: 'admin', salesAgentId: 'fictional' });
    expect((await handleListUserAccessAudit(request('tony', { organizationId: 'consubanco' }), { db, auth })).events).toHaveLength(1);
    await expect(handleUpdateUserAccess(request('tony', { ...input, role: 'supervisor' }), { db, auth })).rejects.toMatchObject({ code: 'aborted' });
  });
  it.each([undefined, {}, { [emails.third]: 'agent' }])('cannot bootstrap without explicit supported initialRoles %j', async (initialRoles) => {
    await db.doc('config/allowedEmails').set({ emails: Object.values(emails), ...(initialRoles ? { initialRoles } : {}) });
    await expect(handleEnsureConsubancoMembershipForCurrentUser(request('third') as CallableRequest<Record<string, never>>, { db, auth }))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect((await db.doc('organizations/consubanco/members/third').get()).exists).toBe(false);
  });
  it('bootstraps an approved arbitrary email only once with its explicit supervisor role', async () => {
    await db.doc('config/allowedEmails').set({ emails: Object.values(emails), initialRoles: { [emails.third]: 'supervisor' } });
    const login = request('third') as CallableRequest<Record<string, never>>;
    const results = await Promise.all([
      handleEnsureConsubancoMembershipForCurrentUser(login, { db, auth }),
      handleEnsureConsubancoMembershipForCurrentUser(login, { db, auth }),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) => result.role === 'supervisor')).toBe(true);
    expect((await rest('calls/call', 'third')).status).toBe(200);
  }, 30000);
  it('cannot bootstrap a disabled membership even when approval and initial role remain', async () => {
    const ref = db.doc('organizations/consubanco/members/logi');
    await ref.update({ accessEnabled: false });
    const before = await ref.get();
    await expect(handleEnsureConsubancoMembershipForCurrentUser(request('logi') as CallableRequest<Record<string, never>>, { db, auth }))
      .rejects.toMatchObject({ code: 'permission-denied' });
    const after = await ref.get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime!.isEqual(before.updateTime!)).toBe(true);
    expect((await rest('calls/call', 'logi')).status).toBe(403);
  });
  it('approves pending invitation without granting an unlinked Auth account membership', async () => {
    const email = 'invited@example.com';
    const input = { organizationId: 'consubanco', email, role: 'supervisor', expectedVersion: null, approveEmail: true };
    await expect(handleUpdateUserAccess(request('tony', input), { db, auth })).resolves.toMatchObject({ success: true, pending: true });
    const allow = await db.doc('config/allowedEmails').get();
    expect(allow.data()?.emails).toContain(email);
    expect(allow.data()?.initialRoles[email]).toBe('supervisor');
    expect(auth.createUser).toHaveBeenCalledWith({ email, emailVerified: false });
    const invited = [...invitedUsers.values()][0];
    expect(invited.providerData).toEqual([]);
    expect((await db.doc('organizations/consubanco/members/' + invited.uid).get()).exists).toBe(false);
    await expect(readDemoMember(invited.uid, db, auth)).rejects.toMatchObject({ code: 'permission-denied' });
    const directory = await handleListUserDirectory(request('tony'), { db, auth });
    expect(directory.pending).toEqual([expect.objectContaining({ email, role: 'supervisor', version: allow.updateTime!.seconds + ':' + allow.updateTime!.nanoseconds })]);
    expect(directory.users.some((user) => user.email === email)).toBe(false);
    expect((await handleListUserAccessAudit(request('tony', { organizationId: 'consubanco' }), { db, auth })).events).toHaveLength(1);
    const login = request('third') as CallableRequest<Record<string, never>>;
    login.auth!.uid = invited.uid;
    login.auth!.token.email = email;
    await expect(handleEnsureConsubancoMembershipForCurrentUser(login, { db, auth })).rejects.toMatchObject({ code: 'permission-denied' });
    invitedUsers.set(invited.uid, { ...invited, emailVerified: true, providerData: [{ providerId: 'google.com', email }] } as UserRecord);
    await expect(handleEnsureConsubancoMembershipForCurrentUser(login, { db, auth })).resolves.toMatchObject({ created: true, role: 'supervisor' });
    expect((await handleListUserDirectory(request('tony'), { db, auth })).pending).toEqual([]);
  });
  it('retains an approved pending grant on provisioning failure and retries without implicit membership', async () => {
    const email = 'pending-retry@example.com';
    const input = { organizationId: 'consubanco', email, role: 'supervisor', expectedVersion: null, approveEmail: true };
    (auth.createUser as jest.Mock).mockImplementationOnce(async () => {
      // Provisioning must never precede the authoritative approval transaction.
      const allow = (await db.doc('config/allowedEmails').get()).data();
      expect(allow?.emails).toContain(email);
      expect(allow?.initialRoles[email]).toBe('supervisor');
      throw Object.assign(new Error('unavailable'), { code: 'auth/internal-error' });
    });
    await expect(handleUpdateUserAccess(request('tony', input), { db, auth })).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(invitedUsers.size).toBe(0);
    const pending = (await handleListUserDirectory(request('tony'), { db, auth })).pending[0];
    expect(pending).toMatchObject({ email, role: 'supervisor' });
    await handleUpdateUserAccess(request('tony', { ...input, expectedVersion: pending.version }), { db, auth });
    const invited = [...invitedUsers.values()][0];
    expect(invited.emailVerified).toBe(false);
    expect(invited.providerData).toEqual([]);
    expect((await db.doc('organizations/consubanco/members/' + invited.uid).get()).exists).toBe(false);
    expect(auth.createUser).toHaveBeenCalledTimes(2);
  });
  it('rejects unapproved pending invites and supervisor self-grants without any writes', async () => {
    const input = { organizationId: 'consubanco', email: 'new@example.com', role: 'supervisor', expectedVersion: null, approveEmail: true };
    await expect(handleUpdateUserAccess(request('logi', input), { db, auth })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(handleUpdateUserAccess(request('tony', { ...input, approveEmail: false }), { db, auth })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(auth.createUser).not.toHaveBeenCalled();
    expect((await db.doc('config/allowedEmails').get()).data()?.emails).not.toContain(input.email);
    expect((await db.collection('organizations/consubanco/access_audit').get()).empty).toBe(true);
  });
  it('serializes concurrent pending edits and rejects the stale allow-document version', async () => {
    const email = 'pending-race@example.com';
    const base = { organizationId: 'consubanco', email, role: 'supervisor', expectedVersion: null, approveEmail: true };
    await handleUpdateUserAccess(request('tony', base), { db, auth });
    const allow = await db.doc('config/allowedEmails').get();
    const expectedVersion = allow.updateTime!.seconds + ':' + allow.updateTime!.nanoseconds;
    const results = await Promise.allSettled(['admin', 'supervisor'].map((role) =>
      handleUpdateUserAccess(request('tony', { ...base, role, expectedVersion }), { db, auth })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: 'aborted' }) })]);
    await expect(handleUpdateUserAccess(request('tony', base), { db, auth })).rejects.toMatchObject({ code: 'aborted' });
    expect((await db.collection('organizations/consubanco/access_audit').get()).size).toBe(2);
  }, 30000);
  it('advances the pending version even when saving the same role', async () => {
    const email = 'pending-noop@example.com';
    const input = { organizationId: 'consubanco', email, role: 'supervisor', expectedVersion: null, approveEmail: true };
    await handleUpdateUserAccess(request('tony', input), { db, auth });
    const before = (await handleListUserDirectory(request('tony'), { db, auth })).pending[0];
    await handleUpdateUserAccess(request('tony', { ...input, expectedVersion: before.version }), { db, auth });
    const after = (await handleListUserDirectory(request('tony'), { db, auth })).pending[0];
    expect(after.version).not.toBe(before.version);
    await expect(handleUpdateUserAccess(request('tony', { ...input, role: 'admin', expectedVersion: before.version }), { db, auth }))
      .rejects.toMatchObject({ code: 'aborted' });
  });
  it('revokes pending approval with its current version and prevents later bootstrap', async () => {
    const email = 'pending-revoke@example.com';
    const input = { organizationId: 'consubanco', email, role: 'supervisor', expectedVersion: null, approveEmail: true };
    await handleUpdateUserAccess(request('tony', input), { db, auth });
    const pending = (await handleListUserDirectory(request('tony'), { db, auth })).pending[0];
    await handleUpdateUserAccess(request('tony', { ...input, expectedVersion: pending.version, accessEnabled: false, approveEmail: false }), { db, auth });
    expect((await db.doc('config/allowedEmails').get()).data()?.emails).not.toContain(email);
    expect((await handleListUserDirectory(request('tony'), { db, auth })).pending).toEqual([]);
    const invited = [...invitedUsers.values()][0];
    invitedUsers.set(invited.uid, { ...invited, emailVerified: true, providerData: [{ providerId: 'google.com', email }] } as UserRecord);
    const login = request('third') as CallableRequest<Record<string, never>>;
    login.auth!.uid = invited.uid;
    login.auth!.token.email = email;
    await expect(handleEnsureConsubancoMembershipForCurrentUser(login, { db, auth })).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await db.doc('organizations/consubanco/members/' + invited.uid).get()).exists).toBe(false);
  });
  it('rejects pending edits when membership has appeared without changing its role', async () => {
    const email = 'pending-bound@example.com';
    const input = { organizationId: 'consubanco', email, role: 'supervisor', expectedVersion: null, approveEmail: true };
    await handleUpdateUserAccess(request('tony', input), { db, auth });
    const pending = (await handleListUserDirectory(request('tony'), { db, auth })).pending[0];
    const invited = [...invitedUsers.values()][0];
    const ref = db.doc('organizations/consubanco/members/' + invited.uid);
    await ref.set({ uid: invited.uid, email, organizationId: 'consubanco', role: 'supervisor', accessEnabled: true });
    invitedUsers.set(invited.uid, { ...invited, emailVerified: true, providerData: [{ providerId: 'google.com', email }] } as UserRecord);
    await expect(handleUpdateUserAccess(request('tony', { ...input, role: 'admin', expectedVersion: pending.version }), { db, auth })).rejects.toMatchObject({ code: 'aborted' });
    expect((await ref.get()).data()?.role).toBe('supervisor');
  });
  it('admits staff reads, rejects password/anonymous/third-user reads and direct call creation', async () => {
    expect((await rest('calls/call', 'logi')).status).toBe(200);
    for (const provider of ['anonymous', 'password', 'custom']) {
      expect((await rest('calls/call', 'tony', 'GET', undefined, { firebase: { sign_in_provider: provider } })).status).toBe(403);
    }
    expect((await rest('calls/new', 'tony', 'PATCH', { uploadedBy: { stringValue: 'tony' }, status: { stringValue: 'uploaded' } })).status).toBe(403);
    expect((await rest('organizations/consubanco/members/tony', 'tony', 'PATCH', { role: { stringValue: 'admin' } })).status).toBe(403);
  });
  it.each(['status', 'analyzerModel', 'transcriptionProvider', 'demoSeed', 'budgetReservationId', 'processingGeneration', 'audioPath', 'salesAgentId'])('rejects call mutation of %s', async (field) => {
    expect((await rest('calls/call?updateMask.fieldPaths=' + field, 'tony', 'PATCH', { [field]: { stringValue: 'forged' } })).status).toBe(403);
  });
  it('allows a call rename and exact manual profile create but rejects server-field injection', async () => {
    expect((await rest('calls/call?updateMask.fieldPaths=name', 'tony', 'PATCH', { name: { stringValue: 'Renamed' } })).status).toBe(200);
    const fields = { uploadedBy: { stringValue: 'tony' }, salesAgentId: { stringValue: 'agent_new' },
      organizationId: { stringValue:'consubanco' }, visibilityScope: { stringValue:'organization' },
      salesAgentName: { stringValue: 'Fictional' }, status: { stringValue: 'ready' }, error: { nullValue: null },
      createdAt: { timestampValue: Timestamp.now().toDate().toISOString() }, updatedAt: { timestampValue: Timestamp.now().toDate().toISOString() } };
    expect((await rest('agent_analyses/new', 'tony', 'PATCH', fields)).status).toBe(200);
    expect((await rest('agent_analyses/new?updateMask.fieldPaths=demoSeed', 'tony', 'PATCH', { demoSeed: { booleanValue: true } })).status).toBe(403);
  });
  it('revokes rule access immediately when allowlist or role changes', async () => {
    await db.doc('config/allowedEmails').update({ emails: [emails.tony] });
    expect((await rest('calls/call', 'logi')).status).toBe(403);
    await expect(handleGetUserAccessContext(request('logi'), { db, auth })).rejects.toThrow();
  });
  it('management disable is atomic and cannot be reset by first-login bootstrap', async () => {
    const input = { organizationId: 'consubanco', uid: 'logi', role: 'supervisor', expectedVersion: await version('logi'), approveEmail: false, accessEnabled: false };
    await handleUpdateUserAccess(request('tony', input), { db, auth });
    expect((await db.doc('organizations/consubanco/members/logi').get()).data()?.accessEnabled).toBe(false);
    expect((await rest('calls/call', 'logi')).status).toBe(403);
    await expect(handleEnsureConsubancoMembershipForCurrentUser(request('logi') as CallableRequest<Record<string, never>>, { db, auth })).rejects.toThrow();
    await expect(handleListUserDirectory(request('logi'), { db, auth })).rejects.toThrow();
    expect((await handleListUserAccessAudit(request('tony', { organizationId: 'consubanco' }), { db, auth })).events[0].action).toBe('membership_disabled');
  });
});
