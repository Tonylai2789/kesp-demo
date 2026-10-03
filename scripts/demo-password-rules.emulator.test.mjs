import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const functions = join(root, 'web/functions');
const host = process.env.FIRESTORE_EMULATOR_HOST;
const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const projectId = 'demo-kesp-auth';
if (![host, storageHost].every(value => /^127\.0\.0\.1:\d+$/.test(value ?? ''))
    || process.env.GCLOUD_PROJECT !== projectId) {
  throw new Error('Password supervisor tests require the isolated demo project and loopback emulators.');
}
const { test } = await import('node:test');
const { Firestore, Timestamp } = createRequire(join(functions, 'package.json'))('firebase-admin/firestore');
const db = new Firestore({ projectId, host, ssl: false });
const uid = 'kesp-demo-supervisor';
const email = 'demo-supervisor@kesp-demo.invalid';
const googleEmails = { tony: 'tonylai2789@gmail.com', logi: 'logitech2789@gmail.com' };
const bucket = 'kesp-demo-tonylai2789.firebasestorage.app';
const memberPath = 'organizations/consubanco/members/' + uid;
const callId = 'password-rules-call';
const audioPath = 'prepared-uploads/' + uid + '/' + callId + '/demo.wav';
const pendingId = 'password-rules-pending';
const pendingPath = 'prepared-uploads/' + uid + '/' + pendingId + '/demo.wav';
const profilePath = 'agent_analyses/password-rules-profile';
const membership = { uid, email, organizationId: 'consubanco', accessEnabled: true, role: 'supervisor' };
const identity = { uid, email, provider: 'password', verified: false };

// Unsigned tokens are accepted only by the loopback emulators, never Firebase production.
function token(auth) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({
    aud: projectId, iss: 'https://securetoken.google.com/' + projectId,
    sub: auth.uid, user_id: auth.uid, email: auth.email,
    ...(auth.verified === undefined ? {} : { email_verified: auth.verified }),
    firebase: { sign_in_provider: auth.provider },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  }) + '.';
}
async function status(response, expected, label) {
  const body = await response.text();
  assert.equal(response.status, expected, label + ': ' + body.slice(0, 500));
}
async function firestore(path, auth = identity, method = 'GET', fields) {
  return fetch('http://' + host + '/v1/projects/' + projectId + '/databases/(default)/documents/' + path, {
    method, headers: { ...(auth ? { Authorization: 'Bearer ' + token(auth) } : {}), 'Content-Type': 'application/json' },
    ...(fields ? { body: JSON.stringify({ fields }) } : {}),
  });
}
async function download(auth = identity) {
  return fetch('http://' + storageHost + '/v0/b/' + bucket + '/o/' + encodeURIComponent(audioPath) + '?alt=media', {
    headers: auth ? { Authorization: 'Firebase ' + token(auth) } : {},
  });
}
async function upload(path = pendingPath, auth = identity) {
  const boundary = 'password_supervisor_rules_boundary';
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'
      + JSON.stringify({ name: path, contentType: 'audio/wav' })
      + '\r\n--' + boundary + '\r\nContent-Type: audio/wav\r\n\r\n'),
    Buffer.alloc(16), Buffer.from('\r\n--' + boundary + '--'),
  ]);
  return fetch('http://' + storageHost + '/v0/b/' + bucket + '/o?name=' + encodeURIComponent(path), {
    method: 'POST', headers: { ...(auth ? { Authorization: 'Firebase ' + token(auth) } : {}),
      'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': 'multipart/related; boundary=' + boundary }, body,
  });
}
function reservation(id) {
  return { ownerUid: uid, callId: id, callFields: { transcriptionComparison: false }, status: 'prepared',
    expiresAt: Timestamp.fromMillis(Date.now() + 600000), bucket, originalFilename: 'demo.wav',
    storagePath: 'prepared-uploads/' + uid + '/' + id + '/demo.wav', sizeBytes: 16, contentType: 'audio/wav' };
}
async function reset() {
  const batch = db.batch();
  batch.set(db.doc('config/allowedEmails'), { emails: [...Object.values(googleEmails), email, 'outsider@example.com'] });
  batch.set(db.doc(memberPath), membership);
  for (const [googleUid, googleEmail] of Object.entries(googleEmails)) {
    batch.set(db.doc('organizations/consubanco/members/' + googleUid), {
      uid: googleUid, email: googleEmail, organizationId: 'consubanco', role: googleUid === 'tony' ? 'admin' : 'supervisor',
    });
  }
  batch.set(db.doc('calls/' + callId), { uploadedBy: uid, organizationId: 'consubanco', visibilityScope: 'organization',
    salesAgentId: 'fictional', name: 'Demo', audioStorageBucket: bucket, audioPath });
  batch.set(db.doc(profilePath), { uploadedBy: 'tony', organizationId: 'consubanco', visibilityScope: 'organization', salesAgentId: 'fictional' });
  batch.set(db.doc('manual_upload_requests/' + pendingId), reservation(pendingId));
  await batch.commit();
}
async function denied(auth = identity) {
  await status(await firestore('calls/' + callId, auth), 403, 'call read');
  await status(await firestore(profilePath, auth), 403, 'profile read');
  await status(await download(auth), 403, 'audio playback');
  await status(await upload(pendingPath, auth), 403, 'reserved upload');
}
try {
  await test('pinned demo password supervisor rules', async t => {
    await reset();
    await db.doc('manual_upload_requests/' + callId).set(reservation(callId));
    await status(await upload(audioPath), 200, 'authorized initial audio upload');
    const check = async (name, run) => t.test(name, async () => { await reset(); await run(); });
    await check('allows unverified password supervisor calls, profiles and two-read audio access', async () => {
      await status(await firestore('calls/' + callId), 200, 'call read');
      await status(await firestore(profilePath), 200, 'shared profile read');
      await status(await firestore(memberPath), 200, 'own membership read');
      await status(await download(), 200, 'audio playback');
      await status(await firestore('calls/' + callId + '?updateMask.fieldPaths=name', identity, 'PATCH', {
        name: { stringValue: 'Renamed demo' },
      }), 200, 'own call rename');
      await db.doc('calls/' + callId).update({ uploadedBy: 'tony' });
      await status(await firestore('calls/' + callId), 200, 'shared call read');
      await status(await download(), 200, 'shared audio playback');
      const profileId = 'password-rules-created';
      await db.doc('agent_analyses/' + profileId).delete();
      await status(await firestore('agent_analyses/' + profileId, identity, 'PATCH', {
        uploadedBy: { stringValue: uid }, salesAgentId: { stringValue: 'agent_' + profileId },
        organizationId: { stringValue: 'consubanco' }, visibilityScope: { stringValue: 'organization' },
        salesAgentName: { stringValue: 'Fictional' }, status: { stringValue: 'ready' }, error: { nullValue: null },
        createdAt: { timestampValue: new Date().toISOString() }, updatedAt: { timestampValue: new Date().toISOString() },
      }), 200, 'supervisor profile creation');
    });
    await check('does not require an email_verified claim for the reserved identity', async () => {
      const auth = { ...identity, verified: undefined };
      await status(await firestore('calls/' + callId, auth), 200, 'call without verification claim');
      await status(await download(auth), 200, 'audio without verification claim');
    });
    for (const [name, overrides] of [
      ['wrong UID', { uid: 'password-rules-wrong-uid' }],
      ['wrong email', { email: 'wrong@kesp-demo.invalid' }],
      ['outsider password identity', { uid: 'password-rules-outsider', email: 'outsider@example.com' }],
      ['reserved UID with Google identity', { email: googleEmails.tony, provider: 'google.com', verified: true }],
    ]) {
      await check('denies ' + name + ' even with matching live membership and allowlist', async () => {
        const auth = { ...identity, ...overrides };
        await db.doc('organizations/consubanco/members/' + auth.uid).set({ ...membership, uid: auth.uid, email: auth.email });
        await db.doc('config/allowedEmails').set({ emails: [...Object.values(googleEmails), email, auth.email] });
        await denied(auth);
      });
    }
    for (const provider of ['google.com', 'custom', 'anonymous']) {
      await check('denies reserved identity with provider ' + provider, () => denied({ ...identity, provider, verified: true }));
    }
    for (const role of ['admin', 'agent']) {
      await check('denies all access for forged ' + role + ' membership', async () => {
        await db.doc(memberPath).update({ role, salesAgentId: 'fictional' });
        await denied();
      });
    }
    for (const [field, value] of [['uid', 'wrong'], ['email', 'wrong@example.com'], ['organizationId', 'other'], ['accessEnabled', false]]) {
      await check('requires matching live membership ' + field, async () => {
        await db.doc(memberPath).update({ [field]: value });
        await denied();
      });
    }
    await check('requires explicit accessEnabled on the reserved membership', async () => {
      const { accessEnabled, ...withoutAccess } = membership;
      await db.doc(memberPath).set(withoutAccess);
      await denied();
    });
    await check('denies missing membership and unauthenticated signup/self-promotion', async () => {
      await db.doc(memberPath).delete();
      await denied();
      for (const auth of [identity, null]) {
        await status(await firestore(memberPath, auth, 'PATCH', { role: { stringValue: 'supervisor' } }), 403, 'membership creation');
      }
      await denied(null);
    });
    await check('Firestore requires the live allowlist in addition to membership', async () => {
      await db.doc('config/allowedEmails').set({ emails: Object.values(googleEmails) });
      await status(await firestore('calls/' + callId), 403, 'allowlist revocation');
      await status(await firestore(profilePath), 403, 'allowlist profile revocation');
      // Storage deliberately uses member + call/reservation, not a third allowlist read.
      await status(await download(), 200, 'Storage remains membership gated');
    });
    for (const [googleUid, googleEmail] of Object.entries(googleEmails)) {
      await check('preserves verified Google identity ' + googleUid + ' and rejects password downgrade', async () => {
        const auth = { uid: googleUid, email: googleEmail, provider: 'google.com', verified: true };
        await status(await firestore('calls/' + callId, auth), 200, 'Google call read');
        await status(await download(auth), 200, 'Google audio read');
        await denied({ ...auth, provider: 'password' });
        await denied({ ...auth, verified: false });
      });
    }
    await check('denies Users/Permissions administration and every direct access-policy write', async () => {
      for (const path of ['adminUsers/x', 'permissions/x', 'config/permissions',
        'organizations/consubanco/members/tony', 'organizations/consubanco/access_audit/password-rules',
        'organizations/consubanco/permissions/x', 'user_access_pending/' + uid]) {
        await status(await firestore(path), 403, 'admin read ' + path);
      }
      await status(await firestore('organizations/consubanco/members'), 403, 'member listing');
      for (const path of ['adminUsers/x', 'permissions/x', 'config/permissions', 'config/allowedEmails', memberPath,
        'organizations/consubanco/members/password-rules-new', 'organizations/consubanco/permissions/x',
        'organizations/consubanco/access_audit/password-rules', 'user_access_pending/' + uid]) {
        await status(await firestore(path, identity, 'PATCH', { role: { stringValue: 'admin' } }), 403, 'admin write ' + path);
        await status(await firestore(path, identity, 'DELETE'), 403, 'admin delete ' + path);
      }
    });
    await check('denies the admin-only comparison upload with valid reservation', async () => {
      await db.doc('manual_upload_requests/' + pendingId).update({ callFields: { transcriptionComparison: true } });
      await status(await upload(), 403, 'comparison upload');
    });
  });
} finally {
  await db.terminate();
}
