import { FieldValue } from 'firebase-admin/firestore';

export const CONSUBANCO_ORGANIZATION_ID = 'consubanco';
export const CONSUBANCO_ORGANIZATION_NAME = 'Consubanco';
export const CCC_AUTOMATIC_UPLOADED_BY_SYSTEM_ID = 'ccc_gcs';
export const CCC_CALL_INDEX_COLLECTION = 'ccc_call_index';
export const CCC_CALL_DEDUPE_COLLECTION = 'ccc_call_dedupe';
export const CALL_DISPLAY_NAME_COUNTERS_COLLECTION = 'call_display_name_counters';

export type CallVisibilityScope = 'organization' | 'user';
export type CanonicalCallSource = 'ccc_gcs' | 'manual_upload' | 'legacy_manual';

export interface CccCallDocumentRefResult {
  ref: FirebaseFirestore.DocumentReference;
  callDocumentId: string;
  createdIndex: boolean;
}

export interface CccProductionDedupeReservation {
  reserved: boolean;
  existingCallDocumentId?: string | null;
}

export interface CallDisplayNameFields {
  displayNameBase: string;
  displayName: string;
  displayNameSuffix: number;
  displayNameScopeKey: string;
}

/** Documents the basename behavior. */
function basename(value: string): string {
  const parts = value.split('/');
  return parts[parts.length - 1] ?? value;
}

/** Documents the stripExtension behavior. */
function stripExtension(value: string): string {
  return value.replace(/\.[^/.]+$/, '');
}

/** Documents the safeToken behavior. */
function safeToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}

/** Documents the displayNameBaseKey behavior. */
function displayNameBaseKey(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** Documents the normalizeDisplayNameBase behavior. */
export function normalizeDisplayNameBase(value: string | undefined): string {
  const normalized = stripExtension(basename(value ?? '')).trim().replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized : 'Call';
}

/** Documents the buildCallDisplayNameScopeKey behavior. */
export function buildCallDisplayNameScopeKey(params: {
  organizationId: string;
  callSource: CanonicalCallSource;
  uploadedByUserId?: string;
}): string {
  const organizationToken = safeToken(params.organizationId);
  if (params.callSource === 'ccc_gcs') {
    return organizationToken + '__automatic';
  }
  return organizationToken + '__manual__' + safeToken(params.uploadedByUserId ?? 'unknown');
}

/** Documents the buildConsubancoAutomaticCallFields behavior. */
export function buildConsubancoAutomaticCallFields(legacyUploadedBy: string): Record<string, unknown> {
  return {
    uploadedBy: legacyUploadedBy,
    uploadedBySystemId: CCC_AUTOMATIC_UPLOADED_BY_SYSTEM_ID,
    uploadedByUserId: null,
    organizationId: CONSUBANCO_ORGANIZATION_ID,
    organizationName: CONSUBANCO_ORGANIZATION_NAME,
    visibilityScope: 'organization',
    callSource: 'ccc_gcs',
    uploadOwnerType: 'automatic_system',
  };
}

/** Documents the buildConsubancoManualCallFields behavior. */
export function buildConsubancoManualCallFields(uploadedByUserId: string): Record<string, unknown> {
  return {
    uploadedBy: uploadedByUserId,
    uploadedByUserId,
    uploadedBySystemId: null,
    organizationId: CONSUBANCO_ORGANIZATION_ID,
    organizationName: CONSUBANCO_ORGANIZATION_NAME,
    visibilityScope: 'user',
    callSource: 'manual_upload',
    uploadOwnerType: 'manual_user',
  };
}

/** Documents the getOrCreateCccCallDocumentRef behavior. */
export async function getOrCreateCccCallDocumentRef(
  db: FirebaseFirestore.Firestore,
  canonicalCallId: string
): Promise<CccCallDocumentRefResult> {
  const indexRef = db.collection(CCC_CALL_INDEX_COLLECTION).doc(canonicalCallId);
  const callRef = db.collection('calls').doc(canonicalCallId);
  /** Calls Firebase Firestore to reserve the direct canonical CCC call document id. */
  return db.runTransaction(/** Handles the callback for this operation. */ async (transaction) => {
    /** Calls Firebase Firestore to read the CCC call index inside the idempotency transaction. */
    const indexDoc = await transaction.get(indexRef);
    transaction.set(
      indexRef,
      {
        canonicalCallId,
        callDocumentId: canonicalCallId,
        createdAt: indexDoc.exists ? indexDoc.data()?.createdAt ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return {
      ref: callRef,
      callDocumentId: canonicalCallId,
      createdIndex: !indexDoc.exists,
    };
  });
}

/** Documents the createCccAutomaticCallDocumentRef behavior. */
export function createCccAutomaticCallDocumentRef(
  db: FirebaseFirestore.Firestore,
  canonicalCallId: string
): CccCallDocumentRefResult {
  void canonicalCallId;
  const callRef = db.collection('calls').doc();
  return {
    ref: callRef,
    callDocumentId: callRef.id,
    createdIndex: true,
  };
}

/** Documents the recordLatestCccCallIndex behavior. */
export async function recordLatestCccCallIndex(
  db: FirebaseFirestore.Firestore,
  params: {
    canonicalCallId: string;
    callDocumentId: string;
    environmentTarget: 'test' | 'prod';
  }
): Promise<void> {
  await db.collection(CCC_CALL_INDEX_COLLECTION).doc(params.canonicalCallId).set(
    {
      canonicalCallId: params.canonicalCallId,
      latestCallDocumentId: params.callDocumentId,
      latestEnvironmentTarget: params.environmentTarget,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Documents the reserveCccProductionDedupe behavior. */
export async function reserveCccProductionDedupe(
  db: FirebaseFirestore.Firestore,
  params: {
    dedupeKey: string;
    canonicalCallId: string;
    callDocumentId: string;
    sourceBucket: string;
    sourceObjectPath: string;
    sourceObjectGeneration?: string;
    sourceObjectMd5Hash?: string;
    analyzerModel?: string;
    transcriptionModel?: string;
    pipelineConfigId?: string;
    pipelineRunId?: string;
  }
): Promise<CccProductionDedupeReservation> {
  const dedupeRef = db.collection(CCC_CALL_DEDUPE_COLLECTION).doc(params.dedupeKey);
  const reservationData = {
    dedupeKey: params.dedupeKey,
    canonicalCallId: params.canonicalCallId,
    callDocumentId: params.callDocumentId,
    sourceBucket: params.sourceBucket,
    sourceObjectPath: params.sourceObjectPath,
    sourceObjectGeneration: params.sourceObjectGeneration ?? null,
    sourceObjectMd5Hash: params.sourceObjectMd5Hash ?? null,
    analyzerModel: params.analyzerModel ?? null,
    transcriptionModel: params.transcriptionModel ?? null,
    pipelineConfigId: params.pipelineConfigId ?? null,
    pipelineRunId: params.pipelineRunId ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  };
  return db.runTransaction(async (transaction) => {
    const dedupeDoc = await transaction.get(dedupeRef);
    if (dedupeDoc.exists) {
      const data = dedupeDoc.data();
      const existingCallDocumentId = typeof data?.callDocumentId === "string" ? data.callDocumentId : null;
      const existingCallDoc = existingCallDocumentId
        ? await transaction.get(db.collection("calls").doc(existingCallDocumentId))
        : null;
      if (!existingCallDoc?.exists) {
        transaction.set(dedupeRef, {
          ...reservationData,
          staleCallDocumentId: existingCallDocumentId,
          staleReservationReplacedAt: FieldValue.serverTimestamp(),
          createdAt: data?.createdAt ?? FieldValue.serverTimestamp(),
        });
        return { reserved: true };
      }
      return {
        reserved: false,
        existingCallDocumentId,
      };
    }
    transaction.set(dedupeRef, {
      ...reservationData,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { reserved: true };
  });
}

/** Documents the allocateCallDisplayName behavior. */
export async function allocateCallDisplayName(
  db: FirebaseFirestore.Firestore,
  params: {
    organizationId: string;
    callSource: CanonicalCallSource;
    uploadedByUserId?: string;
    baseName?: string;
  }
): Promise<CallDisplayNameFields> {
  const displayNameBase = normalizeDisplayNameBase(params.baseName);
  const displayNameScopeKey = buildCallDisplayNameScopeKey(params);
  if (params.callSource === "ccc_gcs") {
    return {
      displayNameBase,
      displayName: displayNameBase,
      displayNameSuffix: 0,
      displayNameScopeKey,
    };
  }
  const counterRef = db.collection(CALL_DISPLAY_NAME_COUNTERS_COLLECTION).doc(displayNameScopeKey);
  const baseKey = displayNameBaseKey(displayNameBase);

  /** Calls Firebase Firestore to atomically allocate the next human display-name suffix. */
  return db.runTransaction(/** Handles the callback for this operation. */ async (transaction) => {
    /** Calls Firebase Firestore to read display-name counters inside the allocation transaction. */
    const counterDoc = await transaction.get(counterRef);
    const bases = counterDoc.data()?.bases;
    const currentEntry = bases && typeof bases === 'object'
      ? (bases as Record<string, { nextSuffix?: unknown }>)[baseKey]
      : undefined;
    const nextSuffix = typeof currentEntry?.nextSuffix === 'number' && currentEntry.nextSuffix > 0
      ? currentEntry.nextSuffix
      : 0;
    const displayName = nextSuffix === 0 ? displayNameBase : displayNameBase + '_' + nextSuffix;

    transaction.set(
      counterRef,
      {
        organizationId: params.organizationId,
        callSource: params.callSource,
        uploadedByUserId: params.uploadedByUserId ?? null,
        bases: {
          [baseKey]: {
            baseName: displayNameBase,
            nextSuffix: nextSuffix + 1,
          },
        },
        updatedAt: FieldValue.serverTimestamp(),
        ...(counterDoc.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true }
    );

    return {
      displayNameBase,
      displayName,
      displayNameSuffix: nextSuffix,
      displayNameScopeKey,
    };
  });
}
