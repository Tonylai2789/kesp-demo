import * as admin from 'firebase-admin';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';

export const DEMO_ORGANIZATION_ID = 'consubanco';
export const DEMO_PASSWORD_UID = 'kesp-demo-supervisor';
export const DEMO_PASSWORD_EMAIL = 'demo-supervisor@kesp-demo.invalid';
export const DEMO_INITIAL_ROLES = {
  'tonylai2789@gmail.com': 'admin',
  'logitech2789@gmail.com': 'supervisor',
  [DEMO_PASSWORD_EMAIL]: 'supervisor',
} as const;
export type DemoEmail = keyof typeof DEMO_INITIAL_ROLES;
export type DemoRole = 'admin' | 'supervisor' | 'agent';

/** Canonicalizes email comparisons without allowing aliases outside the ceiling. */
export function demoEmail(value: unknown): DemoEmail {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!Object.prototype.hasOwnProperty.call(DEMO_INITIAL_ROLES, email)) {
    throw new HttpsError('permission-denied', 'This account is not enabled for the demo.');
  }
  return email as DemoEmail;
}

/** Rejects path injection before constructing a membership reference. */
export function demoId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.includes('/') || value === '.' || value === '..') {
    throw new HttpsError('invalid-argument', 'Invalid identifier.');
  }
  return value;
}

/** Requires the mutable allowlist as well as the immutable identity ceiling. */
export function assertDemoEmailEnabled(email: DemoEmail, data: FirebaseFirestore.DocumentData | undefined): void {
  if (!Array.isArray(data?.emails) || !data.emails.some((value: unknown) => typeof value === 'string' && value.trim().toLowerCase() === email)) {
    throw new HttpsError('permission-denied', 'Demo access has been revoked.');
  }
}

/** Validates the current Auth account, not user-controlled membership identity fields. */
export function validateDemoAuthUser(user: admin.auth.UserRecord): DemoEmail {
  const email = demoEmail(user.email);
  const password = email === DEMO_PASSWORD_EMAIL;
  if (user.disabled || (password ? user.uid !== DEMO_PASSWORD_UID : !user.emailVerified || user.uid === DEMO_PASSWORD_UID) ||
      !user.providerData.length || user.providerData.some((provider) =>
        provider.providerId !== (password ? 'password' : 'google.com') || provider.email?.trim().toLowerCase() !== email)) {
    throw new HttpsError('permission-denied', 'An approved demo identity is required.');
  }
  return email;
}

/** Rechecks Auth and the current allowlist for APIs that historically receive only a UID. */
export async function assertDemoUid(uid: string, db: FirebaseFirestore.Firestore, auth: admin.auth.Auth = admin.auth()) {
  demoId(uid);
  // Firebase Auth is authoritative for disabled users, identity and linked providers.
  const user = await auth.getUser(uid);
  const email = validateDemoAuthUser(user);
  // Firestore permits immediate allowlist revocation without waiting for token expiry.
  const allowed = await db.doc('config/allowedEmails').get();
  assertDemoEmailEnabled(email, allowed.data());
  return { uid, email, user };
}

/** Checks the actual sign-in method and rejects stale/revoked callable sessions. */
export async function assertDemoRequest(request: Pick<CallableRequest, 'auth'>, db: FirebaseFirestore.Firestore, auth: admin.auth.Auth = admin.auth()) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  const token = request.auth.token;
  const password = token.email === DEMO_PASSWORD_EMAIL && request.auth.uid === DEMO_PASSWORD_UID;
  if ((password ? token.firebase?.sign_in_provider !== 'password' : token.email_verified !== true || token.firebase?.sign_in_provider !== 'google.com') ||
      !Number.isFinite(token.auth_time)) {
    throw new HttpsError('permission-denied', 'An approved demo sign-in is required.');
  }
  const identity = await assertDemoUid(request.auth.uid, db, auth);
  if (demoEmail(token.email) !== identity.email ||
      (identity.user.tokensValidAfterTime && Number(token.auth_time) * 1000 < Date.parse(identity.user.tokensValidAfterTime))) {
    throw new HttpsError('permission-denied', 'Sign in again with the approved account.');
  }
  return identity;
}

/** Identity-only exception for the single membership bootstrap callable. */
export async function assertDemoEnrollmentCaller(request: Pick<CallableRequest, 'auth'>, db: FirebaseFirestore.Firestore = admin.firestore(), auth: admin.auth.Auth = admin.auth()) {
  return assertDemoRequest(request, db, auth);
}

/** Every other callable requires current enabled membership before its own role checks. */
export async function assertDemoCaller(request: Pick<CallableRequest, 'auth'>, db: FirebaseFirestore.Firestore = admin.firestore(), auth: admin.auth.Auth = admin.auth()) {
  const identity = await assertDemoRequest(request, db, auth);
  const member = await db.doc('organizations/' + DEMO_ORGANIZATION_ID + '/members/' + identity.uid).get();
  const role = validateDemoMember(member.data(), identity.uid, identity.email);
  if (role !== 'admin' && role !== 'supervisor') {
    throw new HttpsError('permission-denied', 'Only demo admin and supervisor roles are enabled.');
  }
  return { ...identity, role };
}

/** Binds authorization to the live membership and its authenticated identity. */
export function validateDemoMember(data: FirebaseFirestore.DocumentData | undefined, uid: string, email: string): DemoRole {
  if (!data || data.accessEnabled === false || data.uid !== uid || data.email !== email || data.organizationId !== DEMO_ORGANIZATION_ID ||
      ((uid === DEMO_PASSWORD_UID || email === DEMO_PASSWORD_EMAIL) &&
        (uid !== DEMO_PASSWORD_UID || email !== DEMO_PASSWORD_EMAIL || data.role !== 'supervisor')) ||
      !['admin', 'supervisor', 'agent'].includes(data.role)) {
    throw new HttpsError('permission-denied', 'An active demo membership is required.');
  }
  return data.role as DemoRole;
}

/** Reads membership after verifying the account; retained UID gates all share this check. */
export async function readDemoMember(uid: string, db: FirebaseFirestore.Firestore, auth: admin.auth.Auth = admin.auth()) {
  const identity = await assertDemoUid(uid, db, auth);
  // Firestore provides the current role on every request, without caching privileges.
  const member = await db.doc('organizations/' + DEMO_ORGANIZATION_ID + '/members/' + uid).get();
  if (!member.exists) return null;
  const data = member.data()!;
  validateDemoMember(data, uid, identity.email);
  return data;
}
