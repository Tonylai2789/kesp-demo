import { HttpsError } from './demoHttps';
import { assertConsubancoSupervisorOrAdmin } from './cccAutomaticWorkflowMonitor';

/** Shared demo resources need their real namespace, never a fabricated CCC flag. */
export function canAccessDemoProfileResource(uid: string, data: FirebaseFirestore.DocumentData | undefined): boolean {
  if (!data || typeof data.uploadedBy !== 'string' || !data.uploadedBy.trim() ||
      typeof data.salesAgentId !== 'string' || !data.salesAgentId.trim()) return false;
  if (data.organizationId === 'consubanco' && data.visibilityScope === 'organization') return true;
  // Retain access to preexisting private owned profiles, without accepting another namespace.
  return data.uploadedBy === uid && data.organizationId === undefined && data.visibilityScope === undefined;
}

/** Rechecks current Google identity, fixed allowlist and live staff role on retained handlers. */
export async function assertDemoProfileResourceAccess(uid: string, data: FirebaseFirestore.DocumentData | undefined,
  db: FirebaseFirestore.Firestore): Promise<void> {
  await assertConsubancoSupervisorOrAdmin(uid, db);
  if (!canAccessDemoProfileResource(uid, data)) {
    throw new HttpsError('permission-denied', 'Demo staff access to this profile is required.');
  }
}
