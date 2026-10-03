import { onCall, HttpsError, CallableRequest } from './demoHttps';
import * as admin from 'firebase-admin';

interface DeleteAgentAnalysisData {
  agentAnalysisId: string;
}

/** Documents the deleteDocumentRefs behavior. */
async function deleteDocumentRefs(
  db: FirebaseFirestore.Firestore,
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
 * Pure handler so tests can drive it without going through onCall.
 * Deletes one agent-analysis workspace and its known subcollections.
 * Rejects preset profiles (`isActiveAgentProfile === true`) — they are
 * provisioned by seedActiveAgentProfiles and are deterministic / re-seedable.
 */
export async function handleDeleteAgentAnalysis(
  request: CallableRequest<DeleteAgentAnalysisData>,
  db: FirebaseFirestore.Firestore = admin.firestore()
): Promise<{ success: true; agentAnalysisId: string }> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  const { agentAnalysisId } = request.data;
  if (!agentAnalysisId) {
    throw new HttpsError('invalid-argument', 'agentAnalysisId is required');
  }

  /** Calls Firebase Firestore to read or write persisted application data. */
  const agentAnalysisRef = db.collection('agent_analyses').doc(agentAnalysisId);
  const agentAnalysisDoc = await agentAnalysisRef.get();

  if (!agentAnalysisDoc.exists) {
    throw new HttpsError('not-found', 'Agent analysis not found');
  }

  const agentAnalysisData = agentAnalysisDoc.data();
  if (agentAnalysisData?.uploadedBy && agentAnalysisData.uploadedBy !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'You do not own this agent analysis');
  }

  // Preset / seeded profiles (provisioned by seedActiveAgentProfiles) are
  // not user-deletable. They are deterministic and re-seedable; deletion is
  // not the right primitive for them.
  if (agentAnalysisData?.isActiveAgentProfile === true) {
    throw new HttpsError(
      'failed-precondition',
      'Preset agent profiles cannot be deleted.'
    );
  }

  try {
    const reportsSnapshot = await agentAnalysisRef.collection('reports').get();
    if (reportsSnapshot.size > 0) {
      await deleteDocumentRefs(db, reportsSnapshot.docs.map(/** Handles the callback for this operation. */(doc) => doc.ref));
    }

    const runsSnapshot = await agentAnalysisRef.collection('analysis_runs').get();
    for (const runDoc of runsSnapshot.docs) {
      const tasksSnapshot = await runDoc.ref.collection('tasks').get();
      if (tasksSnapshot.size > 0) {
        await deleteDocumentRefs(db, tasksSnapshot.docs.map(/** Handles the callback for this operation. */(doc) => doc.ref));
      }
    }

    if (runsSnapshot.size > 0) {
      await deleteDocumentRefs(db, runsSnapshot.docs.map(/** Handles the callback for this operation. */(doc) => doc.ref));
    }

    await agentAnalysisRef.delete();

    return { success: true, agentAnalysisId };
  } catch (error: any) {
    if (error instanceof HttpsError) {
      throw error;
    }
    console.error('Delete agent analysis error:', error);
    throw new HttpsError(
      'internal',
      error?.message || 'Failed to delete agent analysis'
    );
  }
}

export const deleteAgentAnalysis = onCall(
  /** Handles the callback for this operation. */
  async (request: CallableRequest<DeleteAgentAnalysisData>) => handleDeleteAgentAnalysis(request)
);
