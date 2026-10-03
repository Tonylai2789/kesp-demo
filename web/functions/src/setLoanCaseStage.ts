import { onCall, HttpsError, type CallableRequest } from "./demoHttps";
import * as admin from "firebase-admin";
import { setLoanCaseStageByUser } from "./agentActivity";
import { assertDemoProfileResourceAccess } from './demoProfileAccess';

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

interface SetLoanCaseStageData {
  agentKey: string;
  caseId: string;
  stage: "sold_pending_follow_through" | "fully_completed" | "lost_cancelled";
  note?: string | null;
}

export const setLoanCaseStage = onCall(
  /** Handles the callback for this operation. */
  async (request: CallableRequest<SetLoanCaseStageData>): Promise<{ success: true }> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const agentKey =
      typeof request.data?.agentKey === "string" ? request.data.agentKey.trim() : "";
    const caseId = typeof request.data?.caseId === "string" ? request.data.caseId.trim() : "";
    const stage = request.data?.stage;
    if (!agentKey || !caseId || !stage) {
      throw new HttpsError("invalid-argument", "agentKey, caseId, and stage are required");
    }

    /** Calls Firebase Firestore to read or write persisted application data. */
    const agentDoc = await db.collection("agent_activity").doc(agentKey).get();
    const agentData = agentDoc.data();
    if (!agentDoc.exists || !agentData) {
      throw new HttpsError("not-found", "Agent activity not found");
    }
    await assertDemoProfileResourceAccess(request.auth.uid, agentData, db);

    await setLoanCaseStageByUser({
      agentKey,
      caseId,
      stage,
      note: request.data?.note,
      userId: request.auth.uid,
    });

    return { success: true };
  }
);
