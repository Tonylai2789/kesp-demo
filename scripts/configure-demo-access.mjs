import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(root, 'web/functions/package.json'));
const admin = require('firebase-admin');
const projectId = 'kesp-demo-tonylai2789';
const email = process.argv[2]?.trim().toLowerCase();
const apply = process.argv[3] === '--apply';
if (!email || !/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(email) ||
    (process.argv[3] && !apply) || process.argv.length > 4 ||
    Object.keys(process.env).some(key => key.endsWith('_EMULATOR_HOST') && process.env[key])) {
  throw new Error('Usage: node scripts/configure-demo-access.mjs <supervisor-email> [--apply], without emulators.');
}
const app = admin.initializeApp({ projectId });
const db = app.firestore();
const auth = app.auth();
try {
  let target;
  try { target = await auth.getUserByEmail(email); } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
  }
  if (target?.disabled || target?.providerData.some(provider => provider.providerId !== 'google.com')) {
    throw new Error('Refuse to modify disabled or non-Google identities.');
  }
  const allowRef = db.doc('config/allowedEmails');
  const organization = db.doc('organizations/consubanco');
  const audit = organization.collection('access_audit').doc();
  const result = await db.runTransaction(async transaction => {
    const allowed = await transaction.get(allowRef);
    const org = await transaction.get(organization);
    const members = await transaction.get(organization.collection('members'));
    if (!org.exists || !Array.isArray(allowed.data()?.emails)) throw new Error('Missing demo access configuration.');
    const roles = { ...allowed.data()?.initialRoles };
    for (const doc of members.docs) {
      const member = doc.data();
      if (member.email === email && (member.role !== 'supervisor' || member.accessEnabled === false)) {
        throw new Error('Existing target role/revocation requires an explicit admin edit.');
      }
      if (allowed.data().emails.includes(member.email) && ['admin', 'supervisor'].includes(member.role)) {
        roles[member.email] = member.role;
      }
    }
    roles[email] = 'supervisor';
    if (apply) {
      transaction.set(allowRef, { emails: admin.firestore.FieldValue.arrayUnion(email), initialRoles: roles }, { merge: true });
      transaction.create(audit, { actorUid: 'operator', targetUid: target?.uid ?? null, email,
        organizationId: 'consubanco', action: 'email_approved',
        before: { role: allowed.data()?.initialRoles?.[email] ?? null },
        after: { role: 'supervisor', accessEnabled: true }, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    return { projectId, email, role: roles[email], configuredRoleCount: Object.keys(roles).length, apply };
  });
  if (apply && !target) {
    // No password, provider binding, or verified-email claim is fabricated.
    target = await auth.createUser({ email, emailVerified: false });
  }
  console.log(JSON.stringify({ ...result, authProvisioned: Boolean(target), googleSignInStillRequired: !target?.providerData.length }));
} finally {
  await app.delete();
}
