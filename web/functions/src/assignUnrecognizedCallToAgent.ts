import { CallableRequest, HttpsError, onPaidCall as onCall } from "./demoHttps";
import { assignGeneralAgentCallToAgent } from "./agentRouting";

interface AssignUnrecognizedCallToAgentData {
  callId: string;
  agentAnalysisId: string;
}

export const assignUnrecognizedCallToAgent = onCall(
  /** Handles the callback for this operation. */
  async (request: CallableRequest<AssignUnrecognizedCallToAgentData>) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const callId = typeof request.data?.callId === "string" ? request.data.callId : "";
    const agentAnalysisId =
      typeof request.data?.agentAnalysisId === "string" ? request.data.agentAnalysisId : "";

    return assignGeneralAgentCallToAgent({
      userId: request.auth.uid,
      callId,
      agentAnalysisId,
    });
  }
);
