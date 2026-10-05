import { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { handleUpdateUserAccess } from '../consubancoMembers';

const enabled = process.env.KESP_DEMO_STORAGE_EMULATOR_TESTS === '1';
const host = process.env.FIRESTORE_EMULATOR_HOST;
const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const projectId = 'demo-kesp-auth';
const bucket = 'kesp-demo-tonylai2789.firebasestorage.app';
if (enabled && (!/^127\.0\.0\.1:\d+$/.test(host ?? '') || !/^127\.0\.0\.1:\d+$/.test(storageHost ?? ''))) {
  throw new Error('Storage tests require explicit loopback-only emulators.');
}
const suite = enabled ? describe : describe.skip;
const emails: Record<string, string> = { tony: 'admin@example.com', logi: 'new-supervisor@example.com', third: 'third@example.com' };
/** Creates tokens accepted only by the in-memory emulator. */
function token(uid: string, provider = 'google.com') {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({
    aud: projectId, iss: 'https://securetoken.google.com/' + projectId, sub: uid, user_id: uid,
    email: emails[uid], email_verified: true, firebase: { sign_in_provider: provider },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  }) + '.';
}

suite('demo Storage rules', () => {
  let db: Firestore;
  /** Prepares exact synthetic reservations using only the emulator Admin connection. */
  async function reservation(callId: string, size: number, overrides: Record<string, unknown> = {}) {
    await db.doc('manual_upload_requests/' + callId).set({
      ownerUid: 'tony', callId, callFields: { transcriptionComparison: false },
      status: 'prepared', expiresAt: Timestamp.fromMillis(Date.now() + 60000), bucket,
      originalFilename: 'demo.wav', storagePath: 'prepared-uploads/tony/' + callId + '/demo.wav',
      sizeBytes: size, contentType: 'audio/wav', ...overrides,
    });
  }
  /** Uses the same Firebase multipart protocol as uploadBytes, without cloud credentials. */
  async function upload(path: string, uid = 'tony', size = 16, targetBucket = bucket, provider = 'google.com') {
    const boundary = 'demo_test_boundary_349128';
    const body = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=utf-8\r\n\r\n' + JSON.stringify({ name: path, contentType: 'audio/wav' }) +
        '\r\n--' + boundary + '\r\nContent-Type: audio/wav\r\n\r\n'),
      Buffer.alloc(size, 0),
      Buffer.from('\r\n--' + boundary + '--'),
    ]);
    return fetch('http://' + storageHost + '/v0/b/' + targetBucket + '/o?name=' + encodeURIComponent(path), {
      method: 'POST', headers: { Authorization: 'Firebase ' + token(uid, provider),
        'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': 'multipart/related; boundary=' + boundary },
      body,
    });
  }
  /** Fetches bytes using authenticated Firebase Storage rules, never a download token. */
  async function download(path: string, uid = 'logi') {
    return fetch('http://' + storageHost + '/v0/b/' + bucket + '/o/' + encodeURIComponent(path) + '?alt=media', {
      headers: { Authorization: 'Firebase ' + token(uid) },
    });
  }
  beforeAll(async () => {
    db = new Firestore({ projectId, host, ssl: false });
    const batch = db.batch();
    batch.delete(db.doc('organizations/consubanco/members/third'));
    batch.set(db.doc('organizations/consubanco'), { organizationName: 'KESP Demo' });
    batch.set(db.doc('config/allowedEmails'), { emails: [emails.tony, emails.logi] });
    for (const uid of ['tony', 'logi']) {
      batch.set(db.doc('organizations/consubanco/members/' + uid), { uid, email: emails[uid], organizationId: 'consubanco', role: uid === 'logi' ? 'supervisor' : 'admin' });
    }
    await batch.commit();
  }, 30000);
  afterAll(async () => { await db.terminate(); });
  it('allows exact reserved upload and staff playback through two Firestore reads', async () => {
    await reservation('ok', 16);
    const path = 'prepared-uploads/tony/ok/demo.wav';
    const response = await upload(path);
    if (!response.ok) throw new Error('Valid upload failed: ' + response.status + ' ' + await response.text());
    await db.doc('calls/ok').set({ uploadedBy: 'tony', audioStorageBucket: bucket, audioPath: path,
      organizationId: 'consubanco', visibilityScope: 'organization', salesAgentId: 'fictional' });
    expect((await download(path)).status).toBe(200);
    expect((await download(path, 'third')).status).toBe(403);
    await db.doc('organizations/consubanco/members/logi').update({role:'agent',salesAgentId:'fictional'});
    expect((await download(path)).status).toBe(403);
    await db.doc('organizations/consubanco/members/logi').update({role:'supervisor'});
    expect((await upload(path)).status).toBe(403);
  }, 30000);
  it('denies missing, expired or altered reservations and non-Google upload', async () => {
    expect((await upload('prepared-uploads/tony/missing/demo.wav')).status).toBe(403);
    await reservation('expired', 16, { expiresAt: Timestamp.fromMillis(0) });
    expect((await upload('prepared-uploads/tony/expired/demo.wav')).status).toBe(403);
    await reservation('size', 32);
    expect((await upload('prepared-uploads/tony/size/demo.wav')).status).toBe(403);
    await reservation('provider', 16);
    expect((await upload('prepared-uploads/tony/provider/demo.wav', 'tony', 16, bucket, 'password')).status).toBe(403);
    expect((await upload('prepared-uploads/tony/provider/demo.wav', 'logi')).status).toBe(403);
  });
  it('requires live matching membership independently of email approval', async () => {
    const ref = db.doc('organizations/consubanco/members/logi');
    const original = (await ref.get()).data()!;
    const path = 'prepared-uploads/tony/ok/demo.wav';
    for (const change of [{ accessEnabled: false }, { uid: 'other' }, { email: emails.third }, { organizationId: 'other' }]) {
      await ref.set({ ...original, ...change });
      expect((await download(path)).status).toBe(403);
    }
    await ref.delete();
    expect((await download(path)).status).toBe(403);
    await ref.set(original);
    await db.doc('config/allowedEmails').update({ emails: [emails.tony] });
    // The third Firestore lookup is unavailable; revocation must disable membership.
    expect((await download(path)).status).toBe(200);
    await db.doc('config/allowedEmails').update({ emails: [emails.tony, emails.logi] });
  });
  it('denies legacy audio writes and other buckets', async () => {
    expect((await upload('audio/unknown/legacy.wav')).status).toBe(403);
    await reservation('wrongbucket', 16);
    expect((await upload('prepared-uploads/tony/wrongbucket/demo.wav', 'tony', 16, 'other-demo-bucket')).status).toBe(403);
  });
  it('enforces 25 MB inclusive and denies oversized reservations even when backend size matches', async () => {
    const limit = 25 * 1024 * 1024;
    await reservation('limit', limit);
    expect((await upload('prepared-uploads/tony/limit/demo.wav', 'tony', limit)).status).toBe(200);
    await reservation('oversize', limit + 1);
    expect((await upload('prepared-uploads/tony/oversize/demo.wav', 'tony', limit + 1)).status).toBe(403);
  }, 60000);
  it('management API disable revokes playback, then explicit admin enable restores it', async () => {
    const auth = { getUser: async (uid: string) => ({
      uid, email: emails[uid], disabled: false, emailVerified: true,
      providerData: [{ providerId: 'google.com', email: emails[uid] }],
    } as UserRecord) } as unknown as Auth;
    const memberRef = db.doc('organizations/consubanco/members/logi');
    const before = await memberRef.get();
    const request = {
      auth: { uid: 'tony', token: { email: emails.tony, email_verified: true, auth_time: 1900000000, firebase: { sign_in_provider: 'google.com' } } },
      data: { organizationId: 'consubanco', uid: 'logi', role: 'supervisor', approveEmail: false,
        accessEnabled: false, expectedVersion: before.updateTime!.seconds + ':' + before.updateTime!.nanoseconds },
    } as unknown as CallableRequest<Record<string, unknown>>;
    await handleUpdateUserAccess(request, { db, auth });
    expect((await memberRef.get()).data()?.accessEnabled).toBe(false);
    expect((await db.doc('config/allowedEmails').get()).data()?.emails).not.toContain(emails.logi);
    expect((await download('prepared-uploads/tony/ok/demo.wav')).status).toBe(403);
    const disabled = await memberRef.get();
    request.data = { ...request.data, accessEnabled: true, approveEmail: true,
      expectedVersion: disabled.updateTime!.seconds + ':' + disabled.updateTime!.nanoseconds };
    await handleUpdateUserAccess(request, { db, auth });
    expect((await download('prepared-uploads/tony/ok/demo.wav')).status).toBe(200);
  });
});
