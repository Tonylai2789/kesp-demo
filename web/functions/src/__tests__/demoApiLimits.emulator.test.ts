import { Firestore } from 'firebase-admin/firestore';
import { enforceDemoApiLimit } from '../demoApiLimits';

const enabled = process.env.KESP_DEMO_AUTH_EMULATOR_TESTS === '1';
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = 'demo-kesp-auth';
if (enabled && !/^127\.0\.0\.1:\d+$/.test(host ?? '')) throw new Error('Explicit loopback emulator required');
const suite = enabled ? describe : describe.skip;

suite('demo transactional request limits', () => {
  let db: Firestore;
  beforeAll(() => { db = new Firestore({ projectId, host, ssl: false }); });
  beforeEach(async () => {
    const docs = await db.collection('_demo_api_limits').get();
    const batch = db.batch();
    docs.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  });
  afterAll(async () => { await db.terminate(); });
  test('simultaneous requests cannot both consume the last paid slot', async () => {
    const now = Date.UTC(2026, 9, 3, 12);
    for (let i = 0; i < 5; i++) await enforceDemoApiLimit('shared-reviewer', 'paid', db, now);
    const results = await Promise.allSettled([
      enforceDemoApiLimit('shared-reviewer', 'paid', db, now),
      enforceDemoApiLimit('shared-reviewer', 'paid', db, now),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'resource-exhausted' } });
    const snapshot = await db.doc('_demo_api_limits/global').get();
    expect(snapshot.data()?.counters.paid_3600000.count).toBe(6);
  });
  test('browser users cannot read or reset rate-limit counters', async () => {
    await db.doc('_demo_api_limits/global').set({ counters: {} });
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const uid = 'api-limit-admin';
    const email = 'tonylai2789@gmail.com';
    await db.doc('config/allowedEmails').set({ emails: [email] });
    await db.doc('organizations/consubanco/members/' + uid).set({ uid, email, organizationId: 'consubanco', role: 'admin' });
    const token = encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({ aud: projectId,
      iss: 'https://securetoken.google.com/' + projectId, sub: uid, user_id: uid, email,
      email_verified: true, firebase: { sign_in_provider: 'google.com' },
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }) + '.';
    for (const method of ['GET', 'PATCH']) {
      const response = await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents/_demo_api_limits/global`, {
        method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(method === 'PATCH' ? { body: JSON.stringify({ fields: {} }) } : {}),
      });
      expect(response.status).toBe(403);
    }
  });
});
