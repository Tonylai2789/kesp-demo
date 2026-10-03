export type KespInboxMessageType =
  | 'duplicate_call_excluded'
  | 'reanalyze_no_changes'
  | 'upload_batch_completed'
  | 'call_unrecognized'
  | 'call_analysis_completed'
  | 'call_analysis_error'
  | 'agent_report_completed'
  | 'agent_report_error'
  | 'agent_check_in'
  | 'unknown';

export type KnownKespInboxMessageType = Exclude<KespInboxMessageType, 'unknown'>;

export interface KespInboxMessageBase {
  id: string;
  userId: string;
  type: KespInboxMessageType;
  agentAnalysisId: string | null;
  salesAgentId: string | null;
  salesAgentName: string | null;
  callId: string | null;
  callName: string | null;
  duplicateOfCallId: string | null;
  duplicateCacheKey: string | null;
  duplicateAudioHash: string | null;
  duplicateFingerprintKey: string | null;
  duplicateFingerprintSource: 'sha256' | 'gcs_md5' | null;
  uploadBatchId: string | null;
  callIds: string[] | null;
  callNames: string[] | null;
  callCount: number | null;
  terminalRunId: string | null;
  agentRoutingReason: string | null;
  analysisRunId: string | null;
  runId: string | null;
  errorStage: string | null;
  errorCode: string | null;
  originalType: string | null;
  source: string | null;
  readAt: Date | null;
  dismissedAt: Date | null;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface KespInboxMessageDuplicateCallExcluded extends KespInboxMessageBase {
  type: 'duplicate_call_excluded';
}

export interface KespInboxMessageReanalyzeNoChanges extends KespInboxMessageBase {
  type: 'reanalyze_no_changes';
}

export interface KespInboxMessageUploadBatchCompleted extends KespInboxMessageBase {
  type: 'upload_batch_completed';
}

export interface KespInboxMessageCallUnrecognized extends KespInboxMessageBase {
  type: 'call_unrecognized';
}

export interface KespInboxMessageCallAnalysisCompleted extends KespInboxMessageBase {
  type: 'call_analysis_completed';
}

export interface KespInboxMessageCallAnalysisError extends KespInboxMessageBase {
  type: 'call_analysis_error';
}

export interface KespInboxMessageAgentReportCompleted extends KespInboxMessageBase {
  type: 'agent_report_completed';
}

export interface KespInboxMessageAgentReportError extends KespInboxMessageBase {
  type: 'agent_report_error';
}

export interface KespInboxMessageAgentCheckIn extends KespInboxMessageBase {
  type: 'agent_check_in';
}

export interface KespInboxMessageUnknown extends KespInboxMessageBase {
  type: 'unknown';
}

export type KespInboxMessage =
  | KespInboxMessageDuplicateCallExcluded
  | KespInboxMessageReanalyzeNoChanges
  | KespInboxMessageUploadBatchCompleted
  | KespInboxMessageCallUnrecognized
  | KespInboxMessageCallAnalysisCompleted
  | KespInboxMessageCallAnalysisError
  | KespInboxMessageAgentReportCompleted
  | KespInboxMessageAgentReportError
  | KespInboxMessageAgentCheckIn
  | KespInboxMessageUnknown;
