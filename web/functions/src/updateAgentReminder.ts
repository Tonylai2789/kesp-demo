import { onCall, HttpsError, type CallableRequest } from "./demoHttps";
import * as admin from "firebase-admin";
import { updateAgentReminderByUser } from "./agentActivity";
import { assertDemoProfileResourceAccess } from './demoProfileAccess';

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

interface UpdateAgentReminderData {
  agentKey: string;
  reminderId: string;
  state?: "open" | "done" | "closed" | "superseded";
  dueDate?: string | null;
  dueTime?: string | null;
  timeRange?: string | null;
  conditionText?: string | null;
  notes?: string | null;
  closedReason?: string | null;
}

export const updateAgentReminder = onCall(
  /** Handles the callback for this operation. */
  async (request: CallableRequest<UpdateAgentReminderData>): Promise<{ success: true }> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const agentKey =
      typeof request.data?.agentKey === "string" ? request.data.agentKey.trim() : "";
    const reminderId =
      typeof request.data?.reminderId === "string" ? request.data.reminderId.trim() : "";
    if (!agentKey || !reminderId) {
      throw new HttpsError("invalid-argument", "agentKey and reminderId are required");
    }

    /** Calls Firebase Firestore to read or write persisted application data. */
    const agentDoc = await db.collection("agent_activity").doc(agentKey).get();
    const agentData = agentDoc.data();
    if (!agentDoc.exists || !agentData) {
      throw new HttpsError("not-found", "Agent activity not found");
    }
    await assertDemoProfileResourceAccess(request.auth.uid, agentData, db);

    await updateAgentReminderByUser({
      agentKey,
      reminderId,
      userId: request.auth.uid,
      state: request.data?.state,
      dueDate: request.data?.dueDate,
      dueTime: request.data?.dueTime,
      timeRange: request.data?.timeRange,
      conditionText: request.data?.conditionText,
      notes: request.data?.notes,
      closedReason: request.data?.closedReason,
    });

    return { success: true };
  }
);
