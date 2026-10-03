import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { CONSUBANCO_ORGANIZATION_ID } from './callIdentity';
import type { CccPipelineConfigId } from './cccPipelineConfig';

export const CCC_PIPELINE_CONTROLS_COLLECTION = 'ccc_pipeline_controls';

export interface CccPipelineControlState {
  environment: CccPipelineConfigId;
  paused: boolean;
  pausedAt?: string | null;
  pausedBy?: string | null;
  resumedAt?: string | null;
  resumedBy?: string | null;
  updatedAt?: string | null;
}

function timestampToIso(value: unknown): string | null {
  if (value instanceof admin.firestore.Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && 'toDate' in value) {
    const maybeTimestamp = value as { toDate?: () => Date };
    if (typeof maybeTimestamp.toDate === 'function') return maybeTimestamp.toDate().toISOString();
  }
  return null;
}

export function normalizeCccPipelineEnvironment(value: unknown): CccPipelineConfigId {
  return value === 'production' || value === 'prod' ? 'production' : 'testing';
}

export function callEnvironmentTargetForPipeline(environment: CccPipelineConfigId): 'test' | 'prod' {
  return environment === 'production' ? 'prod' : 'test';
}

export function pipelineEnvironmentFromCallData(data: FirebaseFirestore.DocumentData): CccPipelineConfigId {
  if (data.environmentTarget === 'prod') return 'production';
  if (data.environmentTarget === 'test') return 'testing';
  const sourceObjectPath = typeof data.sourceObjectPath === 'string' ? data.sourceObjectPath : '';
  return sourceObjectPath.startsWith('prod-ready/') ? 'production' : 'testing';
}

export function isAutomaticCccCall(data: FirebaseFirestore.DocumentData): boolean {
  return data.organizationId === CONSUBANCO_ORGANIZATION_ID &&
    data.visibilityScope === 'organization' &&
    data.callSource === 'ccc_gcs';
}

export function serializeCccPipelineControlState(
  environment: CccPipelineConfigId,
  data?: FirebaseFirestore.DocumentData | null
): CccPipelineControlState {
  return {
    environment,
    paused: data?.paused === true,
    pausedAt: timestampToIso(data?.pausedAt),
    pausedBy: typeof data?.pausedBy === 'string' ? data.pausedBy : null,
    resumedAt: timestampToIso(data?.resumedAt),
    resumedBy: typeof data?.resumedBy === 'string' ? data.resumedBy : null,
    updatedAt: timestampToIso(data?.updatedAt),
  };
}

export async function readCccPipelineControlState(
  db: FirebaseFirestore.Firestore,
  environment: CccPipelineConfigId
): Promise<CccPipelineControlState> {
  const doc = await db.collection(CCC_PIPELINE_CONTROLS_COLLECTION).doc(environment).get();
  return serializeCccPipelineControlState(environment, doc.exists ? doc.data() : null);
}

export async function readCccPipelineControlStates(
  db: FirebaseFirestore.Firestore
): Promise<Record<CccPipelineConfigId, CccPipelineControlState>> {
  const [testing, production] = await Promise.all([
    readCccPipelineControlState(db, 'testing'),
    readCccPipelineControlState(db, 'production'),
  ]);
  return { testing, production };
}

export async function isCccPipelinePaused(
  db: FirebaseFirestore.Firestore,
  environment: CccPipelineConfigId
): Promise<boolean> {
  return (await readCccPipelineControlState(db, environment)).paused;
}

export async function shouldHoldAutomaticCccCall(
  db: FirebaseFirestore.Firestore,
  data: FirebaseFirestore.DocumentData
): Promise<boolean> {
  if (!isAutomaticCccCall(data)) return false;
  return isCccPipelinePaused(db, pipelineEnvironmentFromCallData(data));
}

export function buildPausedCallUpdate(): Record<string, unknown> {
  return {
    pipelineHoldState: 'paused',
    pipelineHoldReason: 'ccc_pipeline_paused',
    pipelinePausedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export function buildReleasedCallUpdate(uid: string): Record<string, unknown> {
  return {
    pipelineHoldState: FieldValue.delete(),
    pipelineHoldReason: FieldValue.delete(),
    pipelineResumedAt: FieldValue.serverTimestamp(),
    pipelineResumedBy: uid,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export async function setCccPipelinePausedState(params: {
  db: FirebaseFirestore.Firestore;
  environment: CccPipelineConfigId;
  paused: boolean;
  uid: string;
}): Promise<CccPipelineControlState> {
  const update = params.paused
    ? {
      environment: params.environment,
      paused: true,
      pausedAt: FieldValue.serverTimestamp(),
      pausedBy: params.uid,
      updatedAt: FieldValue.serverTimestamp(),
    }
    : {
      environment: params.environment,
      paused: false,
      resumedAt: FieldValue.serverTimestamp(),
      resumedBy: params.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
  const ref = params.db.collection(CCC_PIPELINE_CONTROLS_COLLECTION).doc(params.environment);
  await ref.set(update, { merge: true });
  const doc = await ref.get();
  return serializeCccPipelineControlState(params.environment, doc.data());
}

export async function releasePausedQueuedCccCalls(params: {
  db: FirebaseFirestore.Firestore;
  environment: CccPipelineConfigId;
  uid: string;
  limit?: number;
}): Promise<number> {
  const target = callEnvironmentTargetForPipeline(params.environment);
  const snapshot = await params.db.collection('calls')
    .where('organizationId', '==', CONSUBANCO_ORGANIZATION_ID)
    .where('visibilityScope', '==', 'organization')
    .where('callSource', '==', 'ccc_gcs')
    .where('environmentTarget', '==', target)
    .where('status', '==', 'uploaded')
    .where('pipelineHoldState', '==', 'paused')
    .limit(params.limit ?? 100)
    .get();

  if (snapshot.empty) return 0;
  const batch = params.db.batch();
  snapshot.docs.forEach((doc) => batch.update(doc.ref, buildReleasedCallUpdate(params.uid)));
  await batch.commit();
  return snapshot.size;
}
