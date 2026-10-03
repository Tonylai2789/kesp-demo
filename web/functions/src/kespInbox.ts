import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { CallableRequest, HttpsError, onCall } from "./demoHttps";

let db: FirebaseFirestore.Firestore | null = null;

/** Documents the getFirestore behavior. */
function getFirestore(): FirebaseFirestore.Firestore {
  if (db) return db;
  /** Calls Firebase Firestore to read or write persisted application data. */
  db = admin.firestore();
  return db;
}

export const KESP_INBOX_COLLECTION = "kesp_inbox";
export const KESP_INBOX_MESSAGES_SUBCOLLECTION = "messages";

export type KespInboxMessageType =
  | "duplicate_call_excluded"
  | "reanalyze_no_changes"
  | "upload_batch_completed"
  | "call_unrecognized"
  | "call_analysis_completed"
  | "call_analysis_error"
  | "agent_report_completed"
  | "agent_report_error"
  | "agent_check_in";

export interface CreateKespInboxMessageParams {
  userId: string;
  type: KespInboxMessageType;
  agentAnalysisId?: string;
  salesAgentId?: string;
  salesAgentName?: string;
  callId?: string;
  callName?: string | null;
  duplicateOfCallId?: string;
  duplicateCacheKey?: string;
  duplicateAudioHash?: string;
  duplicateFingerprintKey?: string;
  duplicateFingerprintSource?: string;
  uploadBatchId?: string;
  callIds?: string[];
  callNames?: string[] | null;
  callCount?: number;
  terminalRunId?: string;
  agentRoutingReason?: string | null;
  analysisRunId?: string;
  runId?: string;
  errorStage?: string | null;
  errorCode?: string | null;
  source?: string;
}

/** Documents the createKespInboxMessage behavior. */
export async function createKespInboxMessage(
  params: CreateKespInboxMessageParams
): Promise<{ messageId: string }> {
  if (!params.userId) {
    throw new Error("createKespInboxMessage requires userId");
  }
  if (!params.type) {
    throw new Error("createKespInboxMessage requires type");
  }

  const firestore = getFirestore();

  /** Calls Firebase Firestore to write user-scoped inbox messages for KESP. */
  const messageRef = firestore
    .collection(KESP_INBOX_COLLECTION)
    .doc(params.userId)
    .collection(KESP_INBOX_MESSAGES_SUBCOLLECTION)
    .doc();

  /** Calls Firebase Firestore to write user-scoped inbox messages for KESP. */
  await messageRef.set({
    userId: params.userId,
    type: params.type,
    agentAnalysisId: params.agentAnalysisId ?? null,
    salesAgentId: params.salesAgentId ?? null,
    salesAgentName: params.salesAgentName ?? null,
    callId: params.callId ?? null,
    callName: params.callName ?? null,
    duplicateOfCallId: params.duplicateOfCallId ?? null,
    duplicateCacheKey: params.duplicateCacheKey ?? null,
    duplicateAudioHash: params.duplicateAudioHash ?? null,
    duplicateFingerprintKey: params.duplicateFingerprintKey ?? null,
    duplicateFingerprintSource: params.duplicateFingerprintSource ?? null,
    uploadBatchId: params.uploadBatchId ?? null,
    callIds: params.callIds ?? null,
    callNames: params.callNames ?? null,
    callCount: typeof params.callCount === "number" ? params.callCount : null,
    terminalRunId: params.terminalRunId ?? null,
    agentRoutingReason: params.agentRoutingReason ?? null,
    analysisRunId: params.analysisRunId ?? null,
    runId: params.runId ?? null,
    errorStage: params.errorStage ?? null,
    errorCode: params.errorCode ?? null,
    source: params.source ?? null,
    readAt: null,
    dismissedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { messageId: messageRef.id };
}

/** Documents the createKespInboxMessageWithId behavior. */
export async function createKespInboxMessageWithId(
  params: CreateKespInboxMessageParams & { messageId: string }
): Promise<{ messageId: string; created: boolean }> {
  if (!params.userId) {
    throw new Error("createKespInboxMessageWithId requires userId");
  }
  if (!params.type) {
    throw new Error("createKespInboxMessageWithId requires type");
  }
  if (!params.messageId) {
    throw new Error("createKespInboxMessageWithId requires messageId");
  }

  const firestore = getFirestore();

  /** Calls Firebase Firestore to write a deterministic, user-scoped inbox message for KESP. */
  const messageRef = firestore
    .collection(KESP_INBOX_COLLECTION)
    .doc(params.userId)
    .collection(KESP_INBOX_MESSAGES_SUBCOLLECTION)
    .doc(params.messageId);

  const payload = {
    userId: params.userId,
    type: params.type,
    agentAnalysisId: params.agentAnalysisId ?? null,
    salesAgentId: params.salesAgentId ?? null,
    salesAgentName: params.salesAgentName ?? null,
    callId: params.callId ?? null,
    callName: params.callName ?? null,
    duplicateOfCallId: params.duplicateOfCallId ?? null,
    duplicateCacheKey: params.duplicateCacheKey ?? null,
    duplicateAudioHash: params.duplicateAudioHash ?? null,
    duplicateFingerprintKey: params.duplicateFingerprintKey ?? null,
    duplicateFingerprintSource: params.duplicateFingerprintSource ?? null,
    uploadBatchId: params.uploadBatchId ?? null,
    callIds: params.callIds ?? null,
    callNames: params.callNames ?? null,
    callCount: typeof params.callCount === "number" ? params.callCount : null,
    terminalRunId: params.terminalRunId ?? null,
    agentRoutingReason: params.agentRoutingReason ?? null,
    analysisRunId: params.analysisRunId ?? null,
    runId: params.runId ?? null,
    errorStage: params.errorStage ?? null,
    errorCode: params.errorCode ?? null,
    source: params.source ?? null,
    readAt: null,
    dismissedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  let created = false;
  /** Calls Firebase Firestore to create (idempotently) a deterministic inbox message for KESP. */
  await firestore.runTransaction(
    /** Handles the callback for this operation. */
    async (txn) => {
      /** Calls Firebase Firestore to check if the deterministic inbox message already exists. */
      const existing = await txn.get(messageRef);
      if (existing.exists) return;
      /** Calls Firebase Firestore to create the deterministic inbox message when absent. */
      txn.set(messageRef, payload);
      created = true;
    }
  );

  return { messageId: messageRef.id, created };
}

interface NotifyUploadBatchCompletedData {
  uploadBatchId: string;
  callIds: string[];
  callNames?: string[] | null;
}

interface NotifyUploadBatchCompletedResult {
  success: boolean;
  messageId: string;
  created: boolean;
}

/** Documents the isSafeUploadBatchId behavior. */
function isSafeUploadBatchId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{6,200}$/.test(value);
}

/** Documents the notifyUploadBatchCompleted behavior. */
export const notifyUploadBatchCompleted = onCall(
  /** Handles the callback for this operation. */
  async (
    request: CallableRequest<NotifyUploadBatchCompletedData>
  ): Promise<NotifyUploadBatchCompletedResult> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const uploadBatchId = request.data?.uploadBatchId;
    const callIds = request.data?.callIds;
    const callNames = request.data?.callNames ?? null;

    if (!uploadBatchId || typeof uploadBatchId !== "string" || !isSafeUploadBatchId(uploadBatchId)) {
      throw new HttpsError("invalid-argument", "uploadBatchId is required");
    }
    if (!Array.isArray(callIds) || callIds.length === 0 || callIds.length > 50) {
      throw new HttpsError("invalid-argument", "callIds must be a non-empty array of at most 50 items");
    }

    const normalizedCallIds = callIds
      .filter(/** Handles the callback for this operation. */ (id): id is string => typeof id === "string" && id.trim().length > 0)
      .map(/** Handles the callback for this operation. */ (id) => id.trim());

    if (normalizedCallIds.length !== callIds.length) {
      throw new HttpsError("invalid-argument", "callIds must be an array of strings");
    }

    const uniqueCallIds = Array.from(new Set(normalizedCallIds));
    if (uniqueCallIds.length !== normalizedCallIds.length) {
      throw new HttpsError("invalid-argument", "callIds must not contain duplicates");
    }

    let normalizedCallNames: string[] | null = null;
    if (Array.isArray(callNames)) {
      const normalized = callNames
        .filter(/** Handles the callback for this operation. */ (name): name is string => typeof name === "string" && name.trim().length > 0)
        .map(/** Handles the callback for this operation. */ (name) => name.trim())
        .slice(0, 3);
      normalizedCallNames = normalized.length > 0 ? normalized : null;
    }

    const messageId = `upload_batch_completed:${uploadBatchId}`;

    /** Calls Firebase Firestore to create a deterministic inbox message for a completed upload batch. */
    const result = await createKespInboxMessageWithId({
      messageId,
      userId: request.auth.uid,
      type: "upload_batch_completed",
      uploadBatchId,
      callIds: uniqueCallIds,
      callNames: normalizedCallNames,
      callCount: uniqueCallIds.length,
      source: "callable:notifyUploadBatchCompleted",
    });

    return { success: true, messageId: result.messageId, created: result.created };
  }
);
