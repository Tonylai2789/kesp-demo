import { HttpsError } from './demoHttps';
import { readDemoMember, type DemoRole } from './demoAccess';

export interface ConsubancoAuthzMember {
  uid: string;
  role: DemoRole;
  salesAgentId: string | null;
  agentAnalysisId: string | null;
  salesAgentName: string | null;
}

/** Retains the legacy import path without registering production monitoring functions. */
export async function readConsubancoAuthzMember(uid: string, db: FirebaseFirestore.Firestore): Promise<ConsubancoAuthzMember | null> {
  const data = await readDemoMember(uid, db);
  if (!data) return null;
  const stringField = (field: string): string | null => {
    const value = data[field];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  return { uid, role: data.role as DemoRole, salesAgentId: stringField('salesAgentId'),
    agentAnalysisId: stringField('agentAnalysisId'), salesAgentName: stringField('salesAgentName') };
}

/** Requires current Auth identity, allowlist and live admin membership. */
export async function assertConsubancoAdmin(uid: string, db: FirebaseFirestore.Firestore): Promise<void> {
  const member = await readConsubancoAuthzMember(uid, db);
  if (member?.role !== 'admin') throw new HttpsError('permission-denied', 'Consubanco admin access is required.');
}

/** Requires current Auth identity, allowlist and live staff membership. */
export async function assertConsubancoSupervisorOrAdmin(uid: string, db: FirebaseFirestore.Firestore): Promise<void> {
  const member = await readConsubancoAuthzMember(uid, db);
  if (member?.role !== 'admin' && member?.role !== 'supervisor') {
    throw new HttpsError('permission-denied', 'Consubanco supervisor access is required.');
  }
}
