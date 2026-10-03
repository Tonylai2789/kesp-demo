export type CallCategory = "good" | "medium" | "bad" | "unknown";
export type TranscriptionModel = 'gpt-4o-transcribe-diarize' | 'scribe_v2';

export type CallStatus =
  | "uploaded"
  | "transcribing"
  | "analyzing"
  | "canceled"
  | "complete"
  | "error";

export type AgentRoutingMode = "none" | "specific" | "general";
export type AgentRoutingStatus =
  | "not_applicable"
  | "pending"
  | "matched"
  | "unrecognized"
  | "manually_assigned"
  | "no_agent"
  | "pending_mapping";

export type CallSource = "ccc_gcs" | "manual_upload" | "legacy_manual";
export type CallAnalysisPipeline = "full_scorecard" | "manual_short_call_review";
export type ShortCallReviewSource = "manual_upload" | "automatic_ccc_gcs";
export type ShortCallReviewStatus = "pending" | "running" | "complete" | "error";
export type UploadOwnerType = "automatic_system" | "manual_user";
export type CallVisibilityScope = "organization" | "user";
export type CccEnvironmentTarget = "test" | "prod";

export type CallErrorSource =
  | "transcription"
  | "analysis_dispatch"
  | "analysis_task"
  | "analysis_finalizer"
  | "reconcile";

export interface Call {
  id: string;
  name?: string;
  displayName?: string;
  displayNameBase?: string;
  displayNameSuffix?: number;
  displayNameScopeKey?: string;
  uploadedBy: string;
  uploadedByUserId?: string | null;
  uploadedBySystemId?: string | null;
  organizationId?: string;
  organizationName?: string;
  visibilityScope?: CallVisibilityScope;
  callDocumentId?: string;
  originalFilename?: string;
  aiAgentUpload?: boolean;
  callSource?: CallSource;
  environmentTarget?: CccEnvironmentTarget;
  analysisPipeline?: CallAnalysisPipeline;
  shortCallReviewSource?: ShortCallReviewSource;
  shortCallReviewStatus?: ShortCallReviewStatus;
  shortCallThresholdSeconds?: number;
  uploadOwnerType?: UploadOwnerType;
  accountNumber?: string;
  cccUserId?: string;
  cccCallId?: string;
  cccCallTimestamp?: string;
  callOccurredAt?: Date;
  callOccurredAtSource?: 'ccc_filename' | 'created_at_fallback';
  cccDestination?: string;
  canonicalCallId?: string;
  canonicalSalesAgentId?: string;
  cccAgentMappingId?: string;
  cccAgentMappingStatus?: string;
  cccOriginalFilename?: string;
  cccParseClassification?: string;
  salesAgentId?: string;
  salesAgentName?: string;
  agentRoutingMode?: AgentRoutingMode;
  agentRoutingStatus?: AgentRoutingStatus;
  agentRoutingReason?: string;
  matchedBy?: "upload_metadata" | "auto_feedback_agent_name" | "manual" | "ccc_filename_mapping";
  matchedAgentAnalysisId?: string;
  matchedAgentProfileKey?: string;
  matchedAgentName?: string;
  matchedAgentConfidence?: number;
  extractedAgentName?: string | null;
  extractedAgentNameNormalized?: string | null;
  agentNameMatchMethod?: "normalized_exact" | "deterministic_fuzzy" | "manual" | "none";
  agentNameMatchScore?: number;
  matchedAt?: Date;
  assignedAt?: Date;
  manualReminderInput?: import('./agentActivity').ManualReminderInput | null;
  category: CallCategory;
  status: CallStatus;
  audioPath: string;
  audioUrl?: string;
  audioContentHash?: string;
  audioHashAlgorithm?: "sha256";
  audioHashSource?: "client_file_bytes";
  audioStorageMd5Hash?: string;
  audioStorageMd5HashSource?: "gcs_object_md5_base64";
  duration?: number;
  createdAt: Date;
  updatedAt: Date;
  transcriptionStartedAt?: Date;
  transcriptionCompletedAt?: Date;
  analysisStartedAt?: Date;
  analysisCompletedAt?: Date;
  canceledAt?: Date;
  canceledBy?: string;
  latestFeedbackId?: string; // Pointer to the latest versioned feedback document
  latestFeedbackCacheKey?: string;
  agentProfileExcluded?: boolean;
  agentProfileExclusionReason?: string;
  duplicateOfCallId?: string;
  duplicateCacheKey?: string;
  duplicateAudioHash?: string;
  duplicateFingerprintKey?: string;
  duplicateFingerprintSource?: "sha256" | "gcs_md5";
  duplicateDetectedAt?: Date;
  duplicateDetectedBy?: string;
  isChunked?: boolean;
  totalChunks?: number;
  completedChunks?: number;
  chunkingStartedAt?: Date;
  error?: string;
  errorSource?: CallErrorSource;
  errorCode?: string;
  errorType?: string;
  errorRequestId?: string;
  retryable?: boolean;
  statusReason?: string;
  promptOverrides?: Record<string, string>;
  activityPromptOverrides?: Record<string, string>;
  analyzerModel?: string;
  activeAnalysisRunId?: string;
  activeShortCallReviewRunId?: string;
  latestShortCallReviewRunId?: string;
  lastTerminalRunId?: string;
  lastRunStatus?: "complete" | "error" | "superseded" | "canceled";
  processingGeneration?: number;
  transcriptionMode?: "direct" | "chunked";
  transcriptionModel?: TranscriptionModel;
  transcriptionProvider?: 'openai' | 'elevenlabs';
  transcriptionComparison?: boolean;
  probeDurationSec?: number;
}

export interface CallWithDetails extends Call {
  transcript?: import('./transcript').Transcript;
  feedback?: import('./feedback').Feedback;
}
