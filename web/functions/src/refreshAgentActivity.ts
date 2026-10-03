import { onPaidCall as onCall, HttpsError, type CallableRequest } from "./demoHttps";
import * as admin from "firebase-admin";
import { isAgentProfileCallExcluded } from "./callExclusions";
import { cleanupAgentActivityForExcludedCall, syncAgentActivityForCall } from "./agentActivity";
import { OPENAI_API_KEY_SECRET } from "./secrets";
import { assertDemoProfileResourceAccess } from './demoProfileAccess';

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

interface RefreshAgentActivityData {
  agentAnalysisId: string;
}

interface RefreshAgentActivityResponse {
  success: true;
  processedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
}

export const refreshAgentActivity = onCall(
  {
    timeoutSeconds: 540,
    memory: "2GiB",
    cpu: 1,
    secrets: [OPENAI_API_KEY_SECRET],
  },
  /** Handles the callback for this operation. */
  async (
    request: CallableRequest<RefreshAgentActivityData>
  ): Promise<RefreshAgentActivityResponse> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const agentAnalysisId =
      typeof request.data?.agentAnalysisId === "string" ? request.data.agentAnalysisId : "";
    if (!agentAnalysisId) {
      throw new HttpsError("invalid-argument", "agentAnalysisId is required");
    }

    /** Calls Firebase Firestore to read or write persisted application data. */
    const agentAnalysisRef = db.collection("agent_analyses").doc(agentAnalysisId);
    const agentAnalysisDoc = await agentAnalysisRef.get();
    if (!agentAnalysisDoc.exists) {
      throw new HttpsError("not-found", "Agent analysis not found");
    }

    const agentAnalysisData = agentAnalysisDoc.data();
    if (!agentAnalysisData) {
      throw new HttpsError("internal", "Agent analysis has no data");
    }

    await assertDemoProfileResourceAccess(request.auth.uid, agentAnalysisData, db);

    const uploadedBy =
      typeof agentAnalysisData.uploadedBy === "string" ? agentAnalysisData.uploadedBy : "";
    const salesAgentId =
      typeof agentAnalysisData.salesAgentId === "string" ? agentAnalysisData.salesAgentId : "";

    if (!uploadedBy || !salesAgentId) {
      throw new HttpsError(
        "failed-precondition",
        "Agent analysis is missing uploadedBy or salesAgentId"
      );
    }

    /** Calls Firebase Firestore to read or write persisted application data. */
    const callsSnapshot = await db
      .collection("calls")
      .where("uploadedBy", "==", uploadedBy)
      .where("salesAgentId", "==", salesAgentId)
      .where("status", "==", "complete")
      .get();

    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    for (const callDoc of callsSnapshot.docs) {
      try {
        const callData = callDoc.data();
        if (isAgentProfileCallExcluded(callData)) {
          /** Calls Firebase Firestore to remove stale agent-activity state for excluded duplicate calls. */
          const cleanup = await cleanupAgentActivityForExcludedCall({
            uploadedBy,
            salesAgentId,
            callId: callDoc.id,
          });
          if (cleanup.removedSnapshot || cleanup.removedReminder) {
            processedCount += 1;
          } else {
            skippedCount += 1;
          }
          continue;
        }

        const result = await syncAgentActivityForCall({
          callId: callDoc.id,
          callData,
        });
        if (result.updated) {
          processedCount += 1;
        } else {
          skippedCount += 1;
        }
      } catch (error: any) {
        errorCount += 1;
        errors.push(`${callDoc.id}: ${error?.message ?? "unknown error"}`);
      }
    }

    return {
      success: true,
      processedCount,
      skippedCount,
      errorCount,
      errors: errors.slice(0, 20),
    };
  }
);
