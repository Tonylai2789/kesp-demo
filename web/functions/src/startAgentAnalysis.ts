import { onPaidCall as onCall, HttpsError, CallableRequest } from "./demoHttps";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import {
  collectAgentAnalysisInputState,
  normalizeAgentAnalysisProcessingConfig,
  resolveAgentAnalysisEnvironmentTarget,
  type AgentAnalysisProcessingConfig,
} from "./agentAnalyses";
import { assertDemoProfileResourceAccess } from './demoProfileAccess';
import { reconcileAgentProfileDuplicates } from "./agentDuplicateCalls";
import { createKespInboxMessage } from "./kespInbox";

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

interface StartAgentAnalysisData {
  agentAnalysisId: string;
  reportProcessingConfig?: AgentAnalysisProcessingConfig;
}

interface StartAgentAnalysisResponse {
  success: true;
  started: boolean;
  result:
  | "started"
  | "already_running"
  | "no_changes"
  | "no_complete_calls"
  | "no_eligible_calls";
  sourceCallCount: number;
  eligibleCallCount: number;
  latestReportId?: string;
  activeRunId?: string;
}

/** Documents the hasProcessingConfig behavior. */
function hasProcessingConfig(config: AgentAnalysisProcessingConfig): boolean {
  return Boolean(
    config.analyzerModel ||
    (config.promptVersions && Object.keys(config.promptVersions).length > 0)
  );
}

/** Documents the toStoredProcessingConfig behavior. */
function toStoredProcessingConfig(
  config: AgentAnalysisProcessingConfig
): AgentAnalysisProcessingConfig | undefined {
  if (!hasProcessingConfig(config)) return undefined;

  return {
    ...(config.analyzerModel ? { analyzerModel: config.analyzerModel } : {}),
    ...(config.promptVersions && Object.keys(config.promptVersions).length > 0
      ? { promptVersions: config.promptVersions }
      : {}),
  };
}

/** Documents the addReportProcessingConfigUpdate behavior. */
function addReportProcessingConfigUpdate(
  updatePayload: Record<string, unknown>,
  hasReportProcessingConfigInput: boolean,
  reportProcessingConfig: AgentAnalysisProcessingConfig
): void {
  if (!hasReportProcessingConfigInput) return;

  const storedConfig = toStoredProcessingConfig(reportProcessingConfig);
  updatePayload.reportProcessingConfig = storedConfig ?? FieldValue.delete();
}

/** Documents the handleStartAgentAnalysis behavior. */
export async function handleStartAgentAnalysis(
  request: CallableRequest<StartAgentAnalysisData>,
  firestoreDb: FirebaseFirestore.Firestore = db
): Promise<StartAgentAnalysisResponse> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }
  const uid = request.auth.uid;

  const agentAnalysisId =
    typeof request.data?.agentAnalysisId === "string"
      ? request.data.agentAnalysisId
      : "";
  if (!agentAnalysisId) {
    throw new HttpsError("invalid-argument", "agentAnalysisId is required");
  }

  const agentAnalysisRef = firestoreDb.collection("agent_analyses").doc(agentAnalysisId);
  /** Calls Firebase Firestore to read the agent analysis document before authorization. */
  const agentAnalysisDoc = await agentAnalysisRef.get();
  if (!agentAnalysisDoc.exists) {
    throw new HttpsError("not-found", "Agent analysis not found");
  }

  const agentAnalysisData = agentAnalysisDoc.data();
  if (!agentAnalysisData) {
    throw new HttpsError("internal", "Agent analysis has no data");
  }

  await assertDemoProfileResourceAccess(uid, agentAnalysisData, firestoreDb);

  const uploadedBy =
    typeof agentAnalysisData.uploadedBy === "string" ? agentAnalysisData.uploadedBy : "";
  const salesAgentId =
    typeof agentAnalysisData.salesAgentId === "string"
      ? agentAnalysisData.salesAgentId
      : "";
  const salesAgentName =
    typeof agentAnalysisData.salesAgentName === "string"
      ? agentAnalysisData.salesAgentName
      : undefined;

  if (!uploadedBy || !salesAgentId) {
    throw new HttpsError(
      "failed-precondition",
      "Agent analysis is missing uploadedBy or salesAgentId"
    );
  }

  /** Calls Firebase Firestore to reconcile duplicate calls before building agent-level report inputs. */
  await reconcileAgentProfileDuplicates({
    uploadedBy,
    salesAgentId,
    detectedBy: "reanalyze",
    actorUserId: uid,
    agentAnalysisId,
    salesAgentName,
  });

  const hasReportProcessingConfigInput = Object.prototype.hasOwnProperty.call(
    request.data ?? {},
    "reportProcessingConfig"
  );
  const requestedReportProcessingConfig = normalizeAgentAnalysisProcessingConfig(
    request.data?.reportProcessingConfig
  );
  const existingReportProcessingConfig = normalizeAgentAnalysisProcessingConfig(
    agentAnalysisData.reportProcessingConfig
  );
  const effectiveReportProcessingConfig = hasReportProcessingConfigInput
    ? requestedReportProcessingConfig
    : existingReportProcessingConfig;
  const environmentTarget = resolveAgentAnalysisEnvironmentTarget(agentAnalysisData);

  const inputState = await collectAgentAnalysisInputState(
    uploadedBy,
    salesAgentId,
    effectiveReportProcessingConfig,
    { agentAnalysisId, environmentTarget }
  );

  /** Calls Firebase Firestore to coordinate report start state atomically. */
  const outcome = await firestoreDb.runTransaction(/** Handles the callback for this operation. */ async (transaction) => {
    /** Calls Firebase Firestore to re-read the agent analysis inside the transaction. */
    const freshDoc = await transaction.get(agentAnalysisRef);
    if (!freshDoc.exists) {
      throw new HttpsError("not-found", "Agent analysis not found");
    }

    const freshData = freshDoc.data();
    if (!freshData) {
      throw new HttpsError("internal", "Agent analysis has no data");
    }

    await assertDemoProfileResourceAccess(uid, freshData, firestoreDb);

    const activeRunId =
      typeof freshData.activeRunId === "string" ? freshData.activeRunId : undefined;
    if (freshData.status === "analyzing" && activeRunId) {
      return {
        success: true as const,
        started: false,
        result: "already_running" as const,
        sourceCallCount: inputState.sourceCallIds.length,
        eligibleCallCount: inputState.eligibleCallIds.length,
        activeRunId,
      };
    }

    const latestReportId =
      typeof freshData.latestReportId === "string" ? freshData.latestReportId : undefined;
    const latestInputFingerprint =
      typeof freshData.latestInputFingerprint === "string"
        ? freshData.latestInputFingerprint
        : undefined;

    if (latestReportId && latestInputFingerprint === inputState.inputFingerprint) {
      /** Calls an external SDK or API dependency. */
      const configUpdatePayload: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
      };
      addReportProcessingConfigUpdate(
        configUpdatePayload,
        hasReportProcessingConfigInput,
        effectiveReportProcessingConfig
      );
      if (Object.keys(configUpdatePayload).length > 1) {
        /** Calls Firebase Firestore to persist processing-config changes without starting a duplicate run. */
        transaction.update(agentAnalysisRef, configUpdatePayload);
      }

      return {
        success: true as const,
        started: false,
        result: "no_changes" as const,
        sourceCallCount: inputState.sourceCallIds.length,
        eligibleCallCount: inputState.eligibleCallIds.length,
        latestReportId,
      };
    }

    if (inputState.sourceCallIds.length === 0) {
      /** Calls an external SDK or API dependency. */
      const configUpdatePayload: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
      };
      addReportProcessingConfigUpdate(
        configUpdatePayload,
        hasReportProcessingConfigInput,
        effectiveReportProcessingConfig
      );
      if (Object.keys(configUpdatePayload).length > 1) {
        /** Calls Firebase Firestore to persist processing-config changes when no complete calls exist. */
        transaction.update(agentAnalysisRef, configUpdatePayload);
      }

      return {
        success: true as const,
        started: false,
        result: "no_complete_calls" as const,
        sourceCallCount: 0,
        eligibleCallCount: 0,
      };
    }

    if (inputState.eligibleCallIds.length === 0) {
      /** Calls an external SDK or API dependency. */
      const configUpdatePayload: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
      };
      addReportProcessingConfigUpdate(
        configUpdatePayload,
        hasReportProcessingConfigInput,
        effectiveReportProcessingConfig
      );
      if (Object.keys(configUpdatePayload).length > 1) {
        /** Calls Firebase Firestore to persist processing-config changes when no eligible calls exist. */
        transaction.update(agentAnalysisRef, configUpdatePayload);
      }

      return {
        success: true as const,
        started: false,
        result: "no_eligible_calls" as const,
        sourceCallCount: inputState.sourceCallIds.length,
        eligibleCallCount: 0,
      };
    }

    /** Calls an external SDK or API dependency. */
    const startUpdatePayload: Record<string, unknown> = {
      status: "analyzing",
      error: null,
      lastRunSkippedReason: FieldValue.delete(),
      lastRunSkippedAt: FieldValue.delete(),
      analysisStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    addReportProcessingConfigUpdate(
      startUpdatePayload,
      hasReportProcessingConfigInput,
      effectiveReportProcessingConfig
    );

    /** Calls Firebase Firestore to mark the agent analysis as actively running. */
    transaction.update(agentAnalysisRef, startUpdatePayload);

    return {
      success: true as const,
      started: true,
      result: "started" as const,
      sourceCallCount: inputState.sourceCallIds.length,
      eligibleCallCount: inputState.eligibleCallIds.length,
    };
  });

  if (outcome.result === "no_changes") {
    /** Calls Firebase Firestore to write a KESP inbox message for no-op re-analysis attempts. */
    await createKespInboxMessage({
      userId: uploadedBy,
      type: "reanalyze_no_changes",
      agentAnalysisId,
      salesAgentId,
      salesAgentName,
      source: "reanalyze",
    });
  }

  return outcome;
}

export const startAgentAnalysis = onCall(
  /** Handles the callback for this operation. */
  async (
    request: CallableRequest<StartAgentAnalysisData>
  ): Promise<StartAgentAnalysisResponse> => handleStartAgentAnalysis(request, db)
);
