import { onCall, HttpsError, CallableRequest } from './demoHttps';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { releaseDemoCallSlot } from './demoBudget';
import {
  buildClearCallErrorUpdate,
  getProcessingGeneration,
} from './callState';

interface CancelCallProcessingData {
  callId: string;
}

interface CancelCallProcessingResponse {
  success: true;
  callId: string;
  canceled: boolean;
  previousStatus: string;
  activeRunId?: string;
}

/** Documents the cancelPendingDocs behavior. */
async function cancelPendingDocs(
  db: FirebaseFirestore.Firestore,
  docs: FirebaseFirestore.QueryDocumentSnapshot[]
): Promise<number> {
  const docsToCancel = docs.filter(
    /** Handles the callback for this operation. */
    (doc) => {
      const status = doc.data().status;
      return status === 'pending' || status === 'running' || status === 'transcribing';
    }
  );

  for (let index = 0; index < docsToCancel.length; index += 400) {
    /** Calls Firebase Firestore to read or write persisted application data. */
    const batch = db.batch();
    docsToCancel.slice(index, index + 400).forEach(
      /** Handles the callback for this operation. */
      (doc) => {
        batch.update(doc.ref, {
          status: 'canceled',
          canceledAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    );
    await batch.commit();
  }

  return docsToCancel.length;
}

/** Documents the cancelActiveRun behavior. */
async function cancelActiveRun(
  db: FirebaseFirestore.Firestore,
  callRef: FirebaseFirestore.DocumentReference,
  activeRunId: string | undefined
): Promise<number> {
  if (!activeRunId) return 0;

  /** Calls Firebase Firestore to read or write persisted application data. */
  const runRef = callRef.collection('analysis_runs').doc(activeRunId);
  const runDoc = await runRef.get();
  if (!runDoc.exists) return 0;

  /** Calls Firebase Firestore to read or write persisted application data. */
  const tasksSnapshot = await runRef.collection('tasks').get();
  const canceledTaskCount = await cancelPendingDocs(db, tasksSnapshot.docs);

  /** Calls Firebase Firestore to read or write persisted application data. */
  await runRef.update({
    status: 'canceled',
    finalizedAt: FieldValue.serverTimestamp(),
    canceledAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return canceledTaskCount;
}

/** Documents the cancelActiveChunks behavior. */
async function cancelActiveChunks(
  db: FirebaseFirestore.Firestore,
  callRef: FirebaseFirestore.DocumentReference
): Promise<number> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const chunksSnapshot = await callRef.collection('chunks').get();
  return cancelPendingDocs(db, chunksSnapshot.docs);
}

/** Documents the handleCancelCallProcessing behavior. */
export async function handleCancelCallProcessing(
  request: CallableRequest<CancelCallProcessingData>,
  db: FirebaseFirestore.Firestore = admin.firestore()
): Promise<CancelCallProcessingResponse> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  const callId = typeof request.data?.callId === 'string' ? request.data.callId : '';
  if (!callId) {
    throw new HttpsError('invalid-argument', 'callId is required');
  }

  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection('calls').doc(callId);
  const callDoc = await callRef.get();
  if (!callDoc.exists) {
    throw new HttpsError('not-found', 'Call not found');
  }

  const callData = callDoc.data() ?? {};
  if (callData.uploadedBy && callData.uploadedBy !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'You do not own this call');
  }

  const previousStatus = typeof callData.status === 'string' ? callData.status : 'unknown';
  if (previousStatus === 'canceled') {
    return { success: true, callId, canceled: false, previousStatus };
  }

  if (previousStatus !== 'transcribing' && previousStatus !== 'analyzing') {
    throw new HttpsError(
      'failed-precondition',
      'Only transcribing or analyzing calls can be canceled'
    );
  }

  const activeRunId =
    typeof callData.activeAnalysisRunId === 'string' ? callData.activeAnalysisRunId : undefined;
  const nextProcessingGeneration = getProcessingGeneration(callData) + 1;
  const terminalTimestampField =
    previousStatus === 'transcribing' ? 'transcriptionCompletedAt' : 'analysisCompletedAt';

  /** Calls Firebase Firestore to read or write persisted application data. */
  await callRef.update({
    status: 'canceled',
    processingGeneration: nextProcessingGeneration,
    activeAnalysisRunId: FieldValue.delete(),
    ...(activeRunId ? { lastTerminalRunId: activeRunId, lastRunStatus: 'canceled' } : {}),
    canceledAt: FieldValue.serverTimestamp(),
    canceledBy: request.auth.uid,
    [terminalTimestampField]: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...buildClearCallErrorUpdate(),
  });

  await cancelActiveChunks(db, callRef);
  await cancelActiveRun(db, callRef, activeRunId);
  await releaseDemoCallSlot(callId, getProcessingGeneration(callData), db);

  return {
    success: true,
    callId,
    canceled: true,
    previousStatus,
    ...(activeRunId ? { activeRunId } : {}),
  };
}

export const cancelCallProcessing = onCall(
  /** Handles the callback for this operation. */
  async (request: CallableRequest<CancelCallProcessingData>) => handleCancelCallProcessing(request)
);
