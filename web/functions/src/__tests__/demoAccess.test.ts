import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { CallableRequest } from 'firebase-functions/v2/https';
import {
  assertDemoCaller, assertDemoEnrollmentCaller, assertDemoEmailEnabled, assertDemoRequest, assertDemoUid, demoEmail, demoId,
  readDemoInitialRole, readDemoMember, validateDemoAuthUser, validateDemoMember,
  DEMO_PASSWORD_EMAIL, DEMO_PASSWORD_UID,
} from '../demoAccess';

const email = 'admin@example.com';
/** Builds synthetic Auth data, with no network or credential dependency. */
function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return { uid: 'tony', email, disabled: false, emailVerified: true, providerData: [{ providerId: 'google.com', email }], ...overrides } as UserRecord;
}
/** Supplies minimal injected Auth/Firestore stores for identity checks. */
function deps(account = user(), allowed: string[] = [email], member: Record<string, unknown> | undefined = { uid: 'tony', email, role: 'admin', organizationId: 'consubanco' }) {
  const getUser = jest.fn(async () => account);
  const db = { doc: jest.fn((path: string) => ({ get: async () => ({
    exists: path === 'config/allowedEmails' || Boolean(member),
    data: () => path === 'config/allowedEmails' ? { emails: allowed } : member,
  }) })) } as unknown as FirebaseFirestore.Firestore;
  return { db, auth: { getUser } as unknown as Auth, getUser };
}
/** Constructs a verified Google callable token. */
function request(overrides: Record<string, unknown> = {}): CallableRequest {
  return { auth: { uid: 'tony', token: { email, email_verified: true, auth_time: 1900000000, firebase: { sign_in_provider: 'google.com' }, ...overrides } } } as CallableRequest;
}

describe('database-backed demo identity', () => {
  it('allows enrollment without a member but rejects ordinary callables until membership exists', async () => {
    const d = deps(user(), [email], {});
    await expect(assertDemoEnrollmentCaller(request(), d.db, d.auth)).resolves.toMatchObject({ uid: 'tony' });
    await expect(assertDemoCaller(request(), d.db, d.auth)).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('rejects disabled live membership even when an allowed Google session remains', async () => {
    const d = deps(user(), [email], { uid: 'tony', email, organizationId: 'consubanco', role: 'admin', accessEnabled: false });
    await expect(assertDemoCaller(request(), d.db, d.auth)).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('returns the current member role for ordinary callables', async () => {
    const d = deps();
    await expect(assertDemoCaller(request(), d.db, d.auth)).resolves.toMatchObject({ role: 'admin' });
  });
  it('does not promote or admit a stored agent through ordinary demo callables', async () => {
    const d = deps(user(), [email], { uid:'tony', email, organizationId:'consubanco', role:'agent' });
    await expect(assertDemoCaller(request(), d.db, d.auth)).rejects.toMatchObject({code:'permission-denied'});
  });
  it.each(['admin', 'supervisor'])('reads explicit configured initial role %s', (role) => {
    expect(readDemoInitialRole(email, { emails: [email], initialRoles: { [email]: role } })).toBe(role);
  });
  it('fails closed without an explicit supported initial role', () => {
    for (const data of [undefined, {}, { emails: [email] }, { emails: [email], initialRoles: {} }, { emails: [email], initialRoles: { [email]: 'agent' } }, { emails: [email], initialRoles: { [email]: 'owner' } }, { emails: [], initialRoles: { [email]: 'admin' } }]) {
      expect(() => readDemoInitialRole(email, data)).toThrow();
    }
    for (const role of ['admin', 'agent']) {
      expect(() => readDemoInitialRole(DEMO_PASSWORD_EMAIL, { emails: [DEMO_PASSWORD_EMAIL], initialRoles: { [DEMO_PASSWORD_EMAIL]: role } })).toThrow();
    }
    expect(readDemoInitialRole(DEMO_PASSWORD_EMAIL, { emails: [DEMO_PASSWORD_EMAIL], initialRoles: { [DEMO_PASSWORD_EMAIL]: 'supervisor' } })).toBe('supervisor');
  });
  it('normalizes arbitrary syntactically valid emails without granting approval', () => {
    expect(demoEmail(' Admin@Example.com ')).toBe(email);
    expect(demoEmail('reviewer+demo@example.com')).toBe('reviewer+demo@example.com');
    expect(demoEmail('new-supervisor@example.com')).toBe('new-supervisor@example.com');
    for (const value of ['', 'not-an-email', 'a b@example.com', 'a/b@example.com', undefined, '__proto__']) expect(() => demoEmail(value)).toThrow();
  });
  it.each(['../x', 'a/b', '', '..', '.'])('rejects invalid uid %s', (value) => expect(() => demoId(value)).toThrow());
  it.each([
    { disabled: true }, { emailVerified: false }, { email: 'outsider@example.com' }, { providerData: [] },
    { providerData: [{ providerId: 'password', email }] },
    { providerData: [{ providerId: 'google.com', email }, { providerId: 'password', email }] },
    { providerData: [{ providerId: 'google.com', email: 'outsider@example.com' }] },
  ])('rejects unsafe Auth accounts %j', (overrides) => expect(() => validateDemoAuthUser(user(overrides as Partial<UserRecord>))).toThrow());
  it('admits an arbitrary verified Google account only with approval and matching live membership', async () => {
    const other = 'new-supervisor@example.com';
    const account = user({ email: other, providerData: [{ providerId: 'google.com', email: other }] as UserRecord['providerData'] });
    const member = { uid: 'tony', email: other, organizationId: 'consubanco', role: 'supervisor' };
    const approved = deps(account, [other], member);
    await expect(assertDemoCaller(request({ email: other }), approved.db, approved.auth)).resolves.toMatchObject({ email: other, role: 'supervisor' });
    const unapproved = deps(account, [], member);
    await expect(assertDemoCaller(request({ email: other }), unapproved.db, unapproved.auth)).rejects.toMatchObject({ code: 'permission-denied' });
    const missing = deps(account, [other], {});
    await expect(assertDemoCaller(request({ email: other }), missing.db, missing.auth)).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('honors immediate allowlist revocation', async () => {
    const d = deps(user(), []);
    await expect(assertDemoUid('tony', d.db, d.auth)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(() => assertDemoEmailEnabled(email, undefined)).toThrow();
  });
  it.each([{ email_verified: false }, { firebase: { sign_in_provider: 'anonymous' } }, { firebase: { sign_in_provider: 'password' } }, { email: 'supervisor@example.com' }])('rejects untrusted token %j', async (token) => {
    const d = deps();
    await expect(assertDemoRequest(request(token), d.db, d.auth)).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('rejects missing authentication and revoked sessions', async () => {
    const d = deps(user({ tokensValidAfterTime: new Date(1900000001000).toISOString() }));
    await expect(assertDemoRequest({} as CallableRequest, d.db, d.auth)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(assertDemoRequest(request(), d.db, d.auth)).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('uses Auth identity and live membership, not a claimed role', async () => {
    const d = deps();
    expect(await readDemoMember('tony', d.db, d.auth)).toMatchObject({ role: 'admin' });
    const forged = deps(user({ email: 'outsider@example.com' }));
    await expect(readDemoMember('tony', forged.db, forged.auth)).rejects.toThrow();
    const mismatched = deps(user(), [email], { uid: 'other', email, organizationId: 'consubanco', role: 'admin' });
    await expect(readDemoMember('tony', mismatched.db, mismatched.auth)).rejects.toThrow();
  });
  it('does not treat a membership in another organization as authority', () => {
    expect(() => validateDemoMember({ uid: 'tony', email, role: 'admin', organizationId: 'other' }, 'tony', email)).toThrow();
  });
});

describe('single provisioned password supervisor', () => {
  const account = () => user({ uid: DEMO_PASSWORD_UID, email: DEMO_PASSWORD_EMAIL, emailVerified: false,
    providerData: [{ providerId: 'password', email: DEMO_PASSWORD_EMAIL }] as UserRecord['providerData'] });
  const member = { uid: DEMO_PASSWORD_UID, email: DEMO_PASSWORD_EMAIL, organizationId: 'consubanco', role: 'supervisor' };
  const passwordRequest = (): CallableRequest => ({ auth: { uid: DEMO_PASSWORD_UID, token: {
    email: DEMO_PASSWORD_EMAIL, email_verified: false, auth_time: 1900000000, firebase: { sign_in_provider: 'password' },
  } } } as CallableRequest);
  it('accepts only the fixed admin-provisioned identity without claiming mailbox verification', async () => {
    const d = deps(account(), [DEMO_PASSWORD_EMAIL], member);
    expect(validateDemoAuthUser(account())).toBe(DEMO_PASSWORD_EMAIL);
    await expect(assertDemoCaller(passwordRequest(), d.db, d.auth)).resolves.toMatchObject({ role: 'supervisor' });
  });
  it.each([
    { uid: 'other' }, { disabled: true }, { email: 'other@example.com' }, { providerData: [] },
    { providerData: [{ providerId: 'google.com', email: DEMO_PASSWORD_EMAIL }] },
    { providerData: [{ providerId: 'password', email: DEMO_PASSWORD_EMAIL }, { providerId: 'google.com', email: DEMO_PASSWORD_EMAIL }] },
  ])('rejects unsafe password Auth identity %j', (overrides) => {
    expect(() => validateDemoAuthUser({ ...account(), ...overrides } as UserRecord)).toThrow();
  });
  it('rejects forged elevated/agent roles and mismatched UID/email bindings', () => {
    for (const role of ['admin', 'agent']) expect(() => validateDemoMember({ ...member, role }, DEMO_PASSWORD_UID, DEMO_PASSWORD_EMAIL)).toThrow();
    expect(() => validateDemoMember({ ...member, uid: 'other' }, 'other', DEMO_PASSWORD_EMAIL)).toThrow();
    expect(() => validateDemoMember({ ...member, email }, DEMO_PASSWORD_UID, email)).toThrow();
  });
  it('requires password session and live enabled membership/allowlist', async () => {
    const d = deps(account(), [DEMO_PASSWORD_EMAIL], member);
    const r = passwordRequest();
    r.auth!.token.firebase.sign_in_provider = 'google.com';
    await expect(assertDemoCaller(r, d.db, d.auth)).rejects.toMatchObject({ code: 'permission-denied' });
    for (const [allowed, data] of [[[], member], [[DEMO_PASSWORD_EMAIL], { ...member, accessEnabled: false }]] as const) {
      const revoked = deps(account(), [...allowed], data);
      await expect(assertDemoCaller(passwordRequest(), revoked.db, revoked.auth)).rejects.toMatchObject({ code: 'permission-denied' });
    }
  });
  it('honors disabled accounts and revoked password sessions', async () => {
    const d = deps({ ...account(), tokensValidAfterTime: new Date(1900000001000).toISOString() } as UserRecord, [DEMO_PASSWORD_EMAIL], member);
    await expect(assertDemoRequest(passwordRequest(), d.db, d.auth)).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
