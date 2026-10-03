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
const emails: Record<string, string> = { tony: 'tonylai2789@gmail.com', logi: 'logitech2789@gmail.com', third: 'third@example.com', [DEMO_PASSWORD_UID]: DEMO_PASSWORD_EMAIL };
type Request = CallableRequest<Record<string, unknown>>;
/** Uses only synthetic Auth fixtures. */
function account(uid: string): UserRecord {
  if (uid === DEMO_PASSWORD_UID) return { uid, email: DEMO_PASSWORD_EMAIL, emailVerified: false, disabled: false, providerData: [{ providerId: 'password', email: DEMO_PASSWORD_EMAIL }] } as UserRecord;
  return { uid, email: emails[uid], emailVerified: true, disabled: false, providerData: [{ providerId: 'google.com', email: emails[uid] }] } as UserRecord;
}
const auth = {
  getUser: jest.fn(async (uid: string) => account(uid)),
  getUserByEmail: jest.fn(async (email: string) => {
    const uid = Object.keys(emails).find((key) => emails[key] === email);
    if (!uid) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
    return account(uid);
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
      'config/allowedEmails': { emails: [emails.tony, emails.logi, DEMO_PASSWORD_EMAIL] },
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
  beforeEach(async () => { await clear(); await seed(); });
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
  it('denies forged third-email membership even after config is widened', async () => {
    await db.doc('config/allowedEmails').update({ emails: Object.values(emails) });
    await db.doc('organizations/consubanco/members/third').set({ uid: 'third', email: emails.third, organizationId: 'consubanco', role: 'admin' });
    await expect(readDemoMember('third', db, auth)).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await rest('calls/call', 'third')).status).toBe(403);
  });
  it('preserves existing roles and permits only fixed first-login roles', async () => {
    const login = request('logi') as CallableRequest<Record<string, never>>;
    await db.doc('organizations/consubanco/members/logi').delete();
    expect(await handleEnsureConsubancoMembershipForCurrentUser(login, { db, auth })).toMatchObject({ created: true, role: 'supervisor' });
    await db.doc('organizations/consubanco/members/logi').update({ role: 'agent', salesAgentId: 'fictional' });
    expect(await handleEnsureConsubancoMembershipForCurrentUser(login, { db, auth })).toMatchObject({ created: false, role: 'agent' });
    await expect(handleEnsureConsubancoMembershipForCurrentUser(request('third') as CallableRequest<Record<string, never>>, { db, auth })).rejects.toThrow();
  });
  it('blocks self edits, supervisor edits, other organizations and third-email approval', async () => {
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
