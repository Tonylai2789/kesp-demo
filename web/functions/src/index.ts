import * as admin from 'firebase-admin';
import { setGlobalOptions } from 'firebase-functions/v2';
import { assertDemoRuntime } from './demoConfig';

assertDemoRuntime();
setGlobalOptions({ serviceAccount: 'demo-runtime@kesp-demo-tonylai2789.iam.gserviceaccount.com', maxInstances: 2 });
admin.initializeApp();

// Deliberately explicit: no landing ingest, pipeline replay, schedulers or email.
export { prepareConsubancoTranscriptionUpload } from './preparedTranscriptionUpload';
export { ensureConsubancoMembershipForCurrentUser } from './consubancoMembership';
export { getUserAccessContext, listUserDirectory, updateUserAccess, listUserAccessAudit } from './consubancoMembers';
export { reprocessCall } from './reprocess';
export { cancelCallProcessing } from './cancelCallProcessing';
export { getAvailablePrompts } from './availablePrompts';
export { deleteAgentAnalysis } from './deleteAgentAnalysis';
export { deleteCallDeep } from './deleteCallDeep';
export { startAgentAnalysis } from './startAgentAnalysis';
export { assignUnrecognizedCallToAgent } from './assignUnrecognizedCallToAgent';
export { diagnoseAgentProfileCallLinks } from './diagnoseAgentProfileCallLinks';
export { repairAgentProfileCallLinks } from './repairAgentProfileCallLinks';
export { refreshAgentActivity } from './refreshAgentActivity';
export { updateAgentReminder } from './updateAgentReminder';
export { setLoanCaseStage } from './setLoanCaseStage';
export { askAgentProfileAssistant, getAgentProfileAssistantChat, getAgentProfileAssistantChatStatus, resetAgentProfileAssistantChat } from './agentProfileAssistant';
export { notifyUploadBatchCompleted } from './kespInbox';
export { onAudioUpload, onStartAnalyzing, onCallCreated, onChunkReady, onSubagentTaskCreated, onShortCallReviewTaskCreated, onAgentAnalysisStart, onAgentAnalysisTaskCreated } from './triggers';
export { refreshManualShortCallPatterns } from './manualShortCallReview';
export { listCccRuntimeFailures, retryCccRuntimeFailures } from './cccRuntimeErrors';
export { processTranscriptionTask, processTranscriptionChunkTask, processSubagentAnalysisTask, processShortCallReviewTask, processAgentAnalysisTask, processConversationMetricsTask } from './processingTaskWorkers';
export { getConversationMetrics } from './conversationMetricsStore';
export { listAgentEmailReportRecipients, listAgentCoachingReportCalls, generateAgentCoachingReport } from './demoReports';
export { getDemoProcessingStatus } from './demoProcessingStatus';
