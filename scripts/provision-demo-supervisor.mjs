import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { chmodSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'web/functions/package.json'));
const admin = require('firebase-admin');
const { GoogleAuth } = require('google-auth-library');
const projectId = 'kesp-demo-tonylai2789';
const uid = 'kesp-demo-supervisor';
const email = 'demo-supervisor@kesp-demo.invalid';

// Operator-only, one-time provisioning. Never rotate or overwrite an existing account.
async function main() {
  const [output, confirmation] = process.argv.slice(2);
  if (!output || confirmation !== '--create-demo-supervisor' ||
      Object.keys(process.env).some(key => key.endsWith('_EMULATOR_HOST') && process.env[key])) {
    throw new Error('Use an external credential path and --create-demo-supervisor, without emulators.');
  }
  const directory = realpathSync(dirname(resolve(output)));
  if (directory === root || directory.startsWith(root + sep)) throw new Error('Credentials must stay outside the repository.');
  const app = admin.initializeApp({ projectId });
  const auth = app.auth();
  const db = app.firestore();
  for (const lookup of [() => auth.getUser(uid), () => auth.getUserByEmail(email)]) {
    try { await lookup(); } catch (error) {
      if (error.code === 'auth/user-not-found') continue;
      throw error;
    }
    throw new Error('Reserved account already exists; refuse to rotate credentials.');
  }
  for (const googleEmail of ['tonylai2789@gmail.com', 'logitech2789@gmail.com']) {
    const user = await auth.getUserByEmail(googleEmail);
    if (user.disabled || !user.emailVerified || !user.providerData.some(p => p.providerId === 'google.com')) {
      throw new Error('Existing approved Google account is not ready.');
    }
  }
  const member = db.doc('organizations/consubanco/members/' + uid);
  if ((await member.get()).exists) throw new Error('Reserved membership already exists.');
  const configUrl = 'https://identitytoolkit.googleapis.com/admin/v2/projects/' + projectId + '/config';
  const cloud = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  const { data: config } = await cloud.request({ url: configUrl });
  if (!config.name?.startsWith('projects/')) throw new Error('Auth configuration preflight failed.');
  const password = randomBytes(24).toString('base64url') + '9!aA';
  writeFileSync(resolve(output), JSON.stringify({ projectId, username: 'demo-supervisor', password,
    uid, role: 'supervisor', url: 'https://' + projectId + '.web.app/login' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  chmodSync(resolve(output), 0o600);
  await auth.createUser({ uid, email, password, emailVerified: false, disabled: true, displayName: 'Demo Supervisor' });
  const batch = db.batch();
  batch.create(member, { uid, email, organizationId: 'consubanco', organizationName: 'KESP Demo',
    role: 'supervisor', accessEnabled: true, demo: true, source: 'demo_fixed_identity',
    createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  batch.update(db.doc('config/allowedEmails'), { emails: admin.firestore.FieldValue.arrayUnion(email) });
  await batch.commit();
  await cloud.request({ url: configUrl, method: 'PATCH', params: { updateMask: 'signIn.email,client.permissions.disabledUserSignup' },
    data: { signIn: { email: { enabled: true, passwordRequired: true } }, client: { permissions: { disabledUserSignup: true } } } });
  const { data: configured } = await cloud.request({ url: configUrl });
  if (configured.signIn?.email?.enabled !== true || configured.signIn.email.passwordRequired !== true ||
      configured.client?.permissions?.disabledUserSignup !== true) throw new Error('Auth provider readback mismatch; account remains disabled.');
  await auth.updateUser(uid, { disabled: false });
  console.log(JSON.stringify({ projectId, uid, role: 'supervisor', created: true, publicSignupDisabled: true, credentialFile: resolve(output) }));
  await app.delete();
}
main().catch(error => {
  // SDK errors can contain request bodies; never print the raw error object.
  console.error('Provisioning failed. Code:', typeof error.code === 'string' ? error.code : 'precondition-or-request-failed');
  process.exitCode = 1;
});
