import { httpsCallable } from 'firebase/functions';
import { functions } from './firebaseFunctions';

export interface AgentProfileCheckInResponse {
  success: true;
  status: 'created' | 'already_checked_in';
  checkInId: string;
  businessDate: string;
  salesAgentId: string;
  salesAgentName: string | null;
  inboxNotifiedCount: number;
  emailSentCount: number;
  emailSkippedCount: number;
  emailFailedCount: number;
}

/** Notifies Consubanco supervisors that the mapped agent has checked into their profile. */
export async function agentProfileCheckIn(salesAgentId: string): Promise<AgentProfileCheckInResponse> {
  const callable = httpsCallable<{ salesAgentId: string }, AgentProfileCheckInResponse>(functions, 'agentProfileCheckIn');
  const result = await callable({ salesAgentId });
  return result.data;
}
