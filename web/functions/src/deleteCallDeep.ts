import { onCall, HttpsError, CallableRequest } from './demoHttps';
import * as admin from 'firebase-admin';
import { buildAgentKey, AGENT_ACTIVITY_COLLECTION } from './agentActivity';
import { getProcessingGeneration } from './callState';
import { releaseDemoCallSlot } from './demoBudget';

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();
/** Calls Firebase Firestore to read or write persisted application data. */
const storage = admin.storage();

interface DeleteCallDeepData {
  callId: string;
}

interface DeleteCallDeepResult {
  success: boolean;
  callId: string;
  removedTranscript: boolean;
  removedFeedbackCount: number;
  removedSnapshotCount: number;
  removedReminderCount: number;
  removedAudio: boolean;
  agentKey?: string;
}

/** Documents the deleteDocumentRefs behavior. */
async function deleteDocumentRefs(
  refs: FirebaseFirestore.DocumentReference[]
): Promise<void> {
  const batchSize = 400;
  for (let index = 0; index < refs.length; index += batchSize) {
    /** Calls Firebase Firestore to read or write persisted application data. */
    const batch = db.batch();
    refs.slice(index, index + batchSize).forEach(/** Handles the callback for this operation. */(ref) => batch.delete(ref));
    await batch.commit();
  }
}

/**
 * Cascade-deletes a single call:
 *   - calls/{callId}/transcript/*
 *   - calls/{callId}/feedback/*
 *   - agent_activity/{agentKey}/call_snapshots/{*} where sourceCallId === callId
 *   - agent_activity/{agentKey}/reminders/{*} where sourceCallId === callId
 *   - the audio object in Firebase Storage at call.audioPath
 *   - calls/{callId}
 *
 * Auth: caller must own the call (call.uploadedBy === auth.uid).
 *
 * Subsequent triggerAgentAnalysisRun calls will recompute the input fingerprint
 * from current Firestore state and produce a fresh report excluding the deleted
 * call. Per-agent activity rollups (sales_rollups, progress_rollups) are not
 * recomputed by this function — they will reconcile on the next refreshAgentActivity.
 */
export const deleteCallDeep = onCall(
  /** Handles the callback for this operation. */
  async (request: CallableRequest<DeleteCallDeepData>): Promise<DeleteCallDeepResult> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication required');
    }

    const { callId } = request.data ?? { callId: '' };
    if (!callId || typeof callId !== 'string') {
      throw new HttpsError('invalid-argument', 'callId is required');
    }

    /** Calls Firebase Firestore to read or write persisted application data. */
    const callRef = db.collection('calls').doc(callId);
    const callSnap = await callRef.get();
    if (!callSnap.exists) {
      throw new HttpsError('not-found', 'Call not found');
    }

    const callData = callSnap.data() ?? {};
    if (callData.uploadedBy && callData.uploadedBy !== request.auth.uid) {
      throw new HttpsError('permission-denied', 'You do not own this call');
    }

    const uploadedBy: string | undefined = callData.uploadedBy;
    const salesAgentId: string | undefined = callData.salesAgentId;
    const audioPath: string | undefined = callData.audioPath;

    let removedTranscript = false;
    let removedFeedbackCount = 0;
    let removedSnapshotCount = 0;
    let removedReminderCount = 0;
    let removedAudio = false;
    let agentKey: string | undefined;

    try {
      // Invalidate pending workers before removing their inputs or releasing capacity.
      await callRef.update({ status: 'deleted', processingGeneration: getProcessingGeneration(callData) + 1 });
      await releaseDemoCallSlot(callId, getProcessingGeneration(callData), db);
      // 1. transcript subcollection (typically a single doc 'data')
      const transcriptSnap = await callRef.collection('transcript').get();
      if (transcriptSnap.size > 0) {
        await deleteDocumentRefs(transcriptSnap.docs.map(/** Handles the callback for this operation. */(d) => d.ref));
        removedTranscript = true;
      }

      // 2. feedback subcollection (versioned docs analysis_*)
      const feedbackSnap = await callRef.collection('feedback').get();
      if (feedbackSnap.size > 0) {
        await deleteDocumentRefs(feedbackSnap.docs.map(/** Handles the callback for this operation. */(d) => d.ref));
        removedFeedbackCount = feedbackSnap.size;
      }

      // 3. agent_activity cleanup for this caller's agent workspace, if linked
      if (uploadedBy && salesAgentId) {
        agentKey = buildAgentKey(uploadedBy, salesAgentId);
        /** Calls Firebase Firestore to read or write persisted application data. */
        const agentRef = db.collection(AGENT_ACTIVITY_COLLECTION).doc(agentKey);

        /** Calls an external SDK or API dependency. */
        const snapshotsSnap = await agentRef
          .collection('call_snapshots')
          .where('sourceCallId', '==', callId)
          .get();
        if (snapshotsSnap.size > 0) {
          await deleteDocumentRefs(snapshotsSnap.docs.map(/** Handles the callback for this operation. */(d) => d.ref));
          removedSnapshotCount = snapshotsSnap.size;
        }

        /** Calls an external SDK or API dependency. */
        const remindersSnap = await agentRef
          .collection('reminders')
          .where('sourceCallId', '==', callId)
          .get();
        if (remindersSnap.size > 0) {
          await deleteDocumentRefs(remindersSnap.docs.map(/** Handles the callback for this operation. */(d) => d.ref));
          removedReminderCount = remindersSnap.size;
        }
      }

      // 4. storage audio file (best-effort — may already be missing)
      if (audioPath && typeof audioPath === 'string') {
        try {
          /** Calls Firebase Storage to read or write call media. */
          await storage.bucket().file(audioPath).delete();
          removedAudio = true;
        } catch (storageErr: any) {
          if (storageErr?.code !== 404) {
            console.warn(`Failed to delete audio at ${audioPath}:`, storageErr);
          }
        }
      }

      // 5. the call doc itself
      await callRef.delete();

      return {
        success: true,
        callId,
        removedTranscript,
        removedFeedbackCount,
        removedSnapshotCount,
        removedReminderCount,
        removedAudio,
        agentKey,
      };
    } catch (error: any) {
      console.error('Delete call deep error:', error);
      throw new HttpsError(
        'internal',
        error?.message || 'Failed to delete call'
      );
    }
  }
);
