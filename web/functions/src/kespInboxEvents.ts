import { createKespInboxMessageWithId } from "./kespInbox";
import { isTranscriptionComparisonCall } from "./callExclusions";

/** Documents the maybeCreateCallUnrecognizedInboxMessage behavior. */
export async function maybeCreateCallUnrecognizedInboxMessage(params: {
  callId: string;
  runId: string;
  callData: FirebaseFirestore.DocumentData;
  routingResult: { callUpdate: Record<string, unknown>; materializedCallFields: Record<string, unknown> };
}): Promise<void> {
  if (isTranscriptionComparisonCall(params.callData)) return;
  try {
    const uploadedBy = typeof params.callData.uploadedBy === "string" ? params.callData.uploadedBy : "";
    if (!uploadedBy) {
      console.warn(`Skipping call_unrecognized inbox message for ownerless call ${params.callId}/${params.runId}`);
      return;
    }

    const routingStatus = params.routingResult.callUpdate.agentRoutingStatus ?? params.routingResult.materializedCallFields.agentRoutingStatus;
    if (routingStatus !== "unrecognized") return;

    const callName = typeof params.callData.name === "string" ? params.callData.name : null;
    const agentRoutingReason =
      typeof params.routingResult.materializedCallFields.agentRoutingReason === "string"
        ? (params.routingResult.materializedCallFields.agentRoutingReason as string)
        : null;

    /** Calls Firebase Firestore to create a deterministic inbox message for unrecognized routing outcomes. */
    await createKespInboxMessageWithId({
      messageId: `call_unrecognized:${params.callId}:${params.runId}`,
      userId: uploadedBy,
      type: "call_unrecognized",
      callId: params.callId,
      callName,
      terminalRunId: params.runId,
      agentRoutingReason,
      source: "analysisSubagents:routeGeneralAgentCallAfterFeedback",
    });
  } catch (error) {
    console.error(`Failed to create call_unrecognized inbox message for ${params.callId}/${params.runId}:`, error);
  }
}

/** Documents the maybeCreateCallAnalysisTerminalInboxMessage behavior. */
export async function maybeCreateCallAnalysisTerminalInboxMessage(params: {
  callId: string;
  runId: string;
  callData: FirebaseFirestore.DocumentData;
  status: "complete" | "error";
  errorCode?: string | null;
}): Promise<void> {
  if (isTranscriptionComparisonCall(params.callData)) return;
  try {
    const uploadedBy = typeof params.callData.uploadedBy === "string" ? params.callData.uploadedBy : "";
    if (!uploadedBy) {
      console.warn(`Skipping call analysis inbox message for ownerless call ${params.callId}/${params.runId}`);
      return;
    }

    const callName = typeof params.callData.name === "string" ? params.callData.name : null;

    if (params.status === "complete") {
      /** Calls Firebase Firestore to create a deterministic inbox message for completed call analysis. */
      await createKespInboxMessageWithId({
        messageId: `call_analysis_completed:${params.callId}:${params.runId}`,
        userId: uploadedBy,
        type: "call_analysis_completed",
        callId: params.callId,
        callName,
        analysisRunId: params.runId,
        source: "analysisSubagents:finalizeAnalysis",
      });
      return;
    }

    /** Calls Firebase Firestore to create a deterministic inbox message for terminal call analysis errors. */
    await createKespInboxMessageWithId({
      messageId: `call_analysis_error:${params.callId}:${params.runId}`,
      userId: uploadedBy,
      type: "call_analysis_error",
      callId: params.callId,
      callName,
      analysisRunId: params.runId,
      errorStage: "analysis_finalizer",
      errorCode: params.errorCode ?? null,
      source: "analysisSubagents:finalizeAnalysis",
    });
  } catch (error) {
    console.error(`Failed to create call analysis inbox message for ${params.callId}/${params.runId}:`, error);
  }
}
