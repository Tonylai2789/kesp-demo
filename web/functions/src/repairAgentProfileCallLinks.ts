import { CallableRequest, HttpsError, onPaidCall as onCall } from "./demoHttps";
import { repairAgentProfileCallLinksForOwner } from "./agentRouting";

interface RepairAgentProfileCallLinksData {
  dryRun?: boolean;
  maxCalls?: number;
}

export const repairAgentProfileCallLinks = onCall(
  /** Handles the callback for this operation. */
  async (request: CallableRequest<RepairAgentProfileCallLinksData>) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    return repairAgentProfileCallLinksForOwner(request.auth.uid, {
      dryRun: request.data?.dryRun === true,
      maxCalls:
        typeof request.data?.maxCalls === "number" ? request.data.maxCalls : undefined,
    });
  }
);
