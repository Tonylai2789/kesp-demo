import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onEnrollmentCall, type CallableRequest } from "./demoHttps";
import { CONSUBANCO_ORGANIZATION_ID, CONSUBANCO_ORGANIZATION_NAME } from "./callIdentity";
import { assertDemoRequest, assertDemoUid, assertDemoEmailEnabled, demoEmail, readDemoInitialRole, validateDemoMember } from './demoAccess';

export interface ConsubancoMembershipMember {
  uid: string;
  email: string;
}

export type ConsubancoMembershipRole = "agent" | "supervisor" | "admin" | "member";

export interface ConsubancoMembershipRepairResult {
  dryRun: boolean;
  allowedEmailCount: number;
  matchedUserCount: number;
  missingEmails: string[];
  existingMemberCount: number;
  existingAdminCount: number;
  writtenMemberCount: number;
  existingMembers: Array<ConsubancoMembershipMember & { role: string | null }>;
  writtenMembers: ConsubancoMembershipMember[];
}

export interface EnsureConsubancoMembershipResult {
  success: boolean;
  created: boolean;
  uid: string;
  email: string;
  organizationId: string;
  role: ConsubancoMembershipRole | null;
  salesAgentId: string | null;
  agentAnalysisId: string | null;
  salesAgentName: string | null;
}

interface RepairDependencies {
  db: FirebaseFirestore.Firestore;
  auth: admin.auth.Auth;
  dryRun?: boolean;
}

interface EnsureDependencies {
  db: FirebaseFirestore.Firestore;
  uid: string;
  email: string | null | undefined;
  auth?: admin.auth.Auth;
}

/** Normalizes an email address for allowlist and Auth comparisons. */
export function normalizeConsubancoEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Normalizes persisted Consubanco roles to the supported role hierarchy. */
export function normalizeConsubancoMembershipRole(value: unknown): ConsubancoMembershipRole | null {
  return value === "agent" || value === "supervisor" || value === "admin" || value === "member" ? value : null;
}

/** Checks whether one Consubanco role has full admin access. */
export function isConsubancoAdminRole(role: unknown): boolean {
  return normalizeConsubancoMembershipRole(role) === "admin";
}

/** Checks whether one Consubanco role can use supervisor-facing surfaces. */
export function isConsubancoSupervisorOrAdminRole(role: unknown): boolean {
  const normalized = normalizeConsubancoMembershipRole(role);
  return normalized === "supervisor" || normalized === "admin";
}

/** Reads an optional string field from a membership document. */
function optionalMembershipString(data: FirebaseFirestore.DocumentData | undefined, field: string): string | null {
  const value = data?.[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Builds the login-time response for one existing or newly created member document. */
function ensureResultFromMemberData(params: {
  created: boolean;
  uid: string;
  email: string;
  data?: FirebaseFirestore.DocumentData;
}): EnsureConsubancoMembershipResult {
  return {
    success: true,
    created: params.created,
    uid: params.uid,
    email: params.email,
    organizationId: CONSUBANCO_ORGANIZATION_ID,
    role: normalizeConsubancoMembershipRole(params.data?.role),
    salesAgentId: optionalMembershipString(params.data, "salesAgentId"),
    agentAnalysisId: optionalMembershipString(params.data, "agentAnalysisId"),
    salesAgentName: optionalMembershipString(params.data, "salesAgentName"),
  };
}

/** Reads the configured email allowlist from Firestore. */
export async function readConsubancoAllowedEmails(db: FirebaseFirestore.Firestore): Promise<string[]> {
  /** Calls Firestore to read the KESP allowed email configuration. */
  const doc = await db.collection("config").doc("allowedEmails").get();
  const emails = doc.data()?.emails;
  if (!Array.isArray(emails)) return [];
  return [...new Set(emails.filter((value): value is string => typeof value === 'string').map(normalizeConsubancoEmail).filter(Boolean))];
}

/** Lists Firebase Auth users keyed by normalized email. */
async function listAuthUsersByEmail(auth: admin.auth.Auth): Promise<Map<string, admin.auth.UserRecord>> {
  const usersByEmail = new Map<string, admin.auth.UserRecord>();
  let pageToken: string | undefined;
  do {
    /** Calls Firebase Auth to list users for allowlist membership repair. */
    const page = await auth.listUsers(1000, pageToken);
    page.users.forEach(/** Handles the callback for this operation. */(user) => {
      const email = normalizeConsubancoEmail(user.email);
      if (email) usersByEmail.set(email, user);
    });
    pageToken = page.pageToken;
  } while (pageToken);
  return usersByEmail;
}

/** Writes the Consubanco organization document when a repair operation needs it. */
async function ensureConsubancoOrganization(db: FirebaseFirestore.Firestore): Promise<void> {
  /** Calls Firestore to create or update the Consubanco organization label. */
  await db.collection("organizations").doc(CONSUBANCO_ORGANIZATION_ID).set(
    {
      organizationId: CONSUBANCO_ORGANIZATION_ID,
      organizationName: CONSUBANCO_ORGANIZATION_NAME,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Builds the Firestore member payload for a newly repaired allowlisted user. */
function memberWriteData(uid: string, email: string, role: 'admin' | 'supervisor'): Record<string, unknown> {
  return {
    uid,
    email,
    organizationId: CONSUBANCO_ORGANIZATION_ID,
    organizationName: CONSUBANCO_ORGANIZATION_NAME,
    role,
    accessEnabled: true,
    source: "demo_approved_email",
    demo: true,
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  };
}

/** Repairs missing Consubanco memberships for existing Auth users in the allowlist. */
export async function repairConsubancoMembershipForAllowedEmails(
  dependencies: RepairDependencies
): Promise<ConsubancoMembershipRepairResult> {
  const dryRun = dependencies.dryRun !== false;
  if (!dryRun) throw new HttpsError("failed-precondition", "Demo memberships are bound only by verified Google sign-in.");
  const allowedEmails = await readConsubancoAllowedEmails(dependencies.db);
  const usersByEmail = await listAuthUsersByEmail(dependencies.auth);
  const missingEmails: string[] = [];
  const matchedMembers: ConsubancoMembershipMember[] = [];
  const existingMembers: Array<ConsubancoMembershipMember & { role: string | null }> = [];
  const writtenMembers: ConsubancoMembershipMember[] = [];
  let existingAdminCount = 0;

  for (const email of allowedEmails) {
    const user = usersByEmail.get(email);
    if (!user) {
      missingEmails.push(email);
      continue;
    }
    matchedMembers.push({ uid: user.uid, email });
  }

  let organizationEnsured = false;
  for (const member of matchedMembers) {
    const memberRef = dependencies.db
      .collection("organizations")
      .doc(CONSUBANCO_ORGANIZATION_ID)
      .collection("members")
      .doc(member.uid);
    /** Calls Firestore to check whether this allowlisted Auth user already has membership. */
    const memberDoc = await memberRef.get();
    if (memberDoc.exists) {
      const role = normalizeConsubancoMembershipRole(memberDoc.data()?.role);
      if (isConsubancoAdminRole(role)) existingAdminCount += 1;
      existingMembers.push({ ...member, role });
      continue;
    }

    if (!dryRun) {
      if (!organizationEnsured) {
        await ensureConsubancoOrganization(dependencies.db);
        organizationEnsured = true;
      }
      /** Calls Firestore to create the missing Consubanco member document. */
      const allowed = await dependencies.db.doc('config/allowedEmails').get();
      await memberRef.set(memberWriteData(member.uid, member.email, readDemoInitialRole(member.email, allowed.data())), { merge: false });
    }
    writtenMembers.push(member);
  }

  return {
    dryRun,
    allowedEmailCount: allowedEmails.length,
    matchedUserCount: matchedMembers.length,
    missingEmails,
    existingMemberCount: existingMembers.length,
    existingAdminCount,
    writtenMemberCount: dryRun ? 0 : writtenMembers.length,
    existingMembers,
    writtenMembers,
  };
}

/** Ensures the current allowlisted signed-in user has a Consubanco member document. */
export async function ensureConsubancoMembershipForAuthUser(
  dependencies: EnsureDependencies
): Promise<EnsureConsubancoMembershipResult> {
  const identity = await assertDemoUid(dependencies.uid, dependencies.db, dependencies.auth);
  const email = demoEmail(dependencies.email);
  if (identity.email !== email) throw new HttpsError("permission-denied", "Identity mismatch.");
  if (!email) {
    throw new HttpsError("invalid-argument", "A signed-in email is required.");
  }

  const allowedEmails = await readConsubancoAllowedEmails(dependencies.db);
  if (!allowedEmails.includes(email)) {
    throw new HttpsError("permission-denied", "This email is not allowed for Consubanco membership.");
  }

  const memberRef = dependencies.db
    .collection("organizations")
    .doc(CONSUBANCO_ORGANIZATION_ID)
    .collection("members")
    .doc(dependencies.uid);
  /** Calls Firestore to check the current signed-in user's Consubanco membership. */
  const memberDoc = await memberRef.get();
  if (memberDoc.exists) {
    validateDemoMember(memberDoc.data(), dependencies.uid, email);
    return ensureResultFromMemberData({ created: false, uid: dependencies.uid, email, data: memberDoc.data() });
  }

  // Firestore serializes first login; an existing role can never be reset by login.
  return dependencies.db.runTransaction(async (transaction) => {
    const current = await transaction.get(memberRef);
    const allowed = await transaction.get(dependencies.db.doc("config/allowedEmails"));
    const organization = await transaction.get(dependencies.db.doc("organizations/" + CONSUBANCO_ORGANIZATION_ID));
    assertDemoEmailEnabled(email, allowed.data());
    if (!organization.exists) throw new HttpsError("failed-precondition", "Demo organization must be provisioned first.");
    if (current.exists) {
      validateDemoMember(current.data(), dependencies.uid, email);
      return ensureResultFromMemberData({ created: false, uid: dependencies.uid, email, data: current.data() });
    }
    const data = memberWriteData(dependencies.uid, email, readDemoInitialRole(email, allowed.data()));
    transaction.create(memberRef, data);
    return ensureResultFromMemberData({ created: true, uid: dependencies.uid, email, data });
  });
}

/** Handles the callable request for login-time Consubanco membership repair. */
export async function handleEnsureConsubancoMembershipForCurrentUser(
  request: CallableRequest<Record<string, never>>,
  dependencies: { db?: FirebaseFirestore.Firestore; auth?: admin.auth.Auth } = {}
): Promise<EnsureConsubancoMembershipResult> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const db = dependencies.db ?? admin.firestore();
  const identity = await assertDemoRequest(request, db, dependencies.auth);
  const email = identity.email;
  return ensureConsubancoMembershipForAuthUser({
    db,
    auth: dependencies.auth,
    uid: request.auth.uid,
    email,
  });
}

export const ensureConsubancoMembershipForCurrentUser = onEnrollmentCall(
  /** Handles the callable adapter for login-time Consubanco membership repair. */
  async (request) => handleEnsureConsubancoMembershipForCurrentUser(request)
);
