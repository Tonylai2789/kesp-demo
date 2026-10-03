import { CallableRequest, HttpsError, onCall } from "./demoHttps";
import { diagnoseAgentProfileCallLinksForOwner } from "./agentRouting";

export const diagnoseAgentProfileCallLinks = onCall(
  /** Handles the callback for this operation. */
  async (request: CallableRequest<Record<string, never>>) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    return diagnoseAgentProfileCallLinksForOwner(request.auth.uid);
  }
);
