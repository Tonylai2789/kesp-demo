import { httpsCallable } from 'firebase/functions';
import { functions } from './firebaseFunctions';
import type { ManualShortCallPatternSummary } from '@/types';
import { registerKespDemoWorkflowRowTerms } from '@/lib/kespDemoRedaction';
import type { TranscriptionModel } from '@/types/call';
import type { ManualReminderInput } from '@/types';

export interface DemoProcessingStatus {
  enabled: boolean;
  remainingMicros: number;
  activeSlots: number;
  maxActiveSlots: 2;
  pauseReason: null | 'paused' | 'budget_exhausted' | 'capacity' | 'unavailable';
  canStart: boolean;
}

export async function getDemoProcessingStatus(): Promise<DemoProcessingStatus> {
  const callable = httpsCallable<void, DemoProcessingStatus>(
    functions, 'getDemoProcessingStatus', { timeout: 10_000 }
  );
  return (await callable()).data;
}

export interface PrepareConsubancoTranscriptionUploadInput {
  originalFilename: string;
  sizeBytes: number;
  contentType: string;
  audioSha256: string;
  transcriptionModel: TranscriptionModel;
  comparison: boolean;
  analyzerModel?: string;
  analyzerModelOverrides?: Record<string, string>;
  promptVersions?: Record<string, string>;
  activityPromptVersions?: Record<string, string>;
  agentRoutingMode?: 'none' | 'specific' | 'general';
  agentId?: string;
  agentName?: string;
  agentAnalysisId?: string;
  batchId?: string;
  manualReminderInput?: ManualReminderInput;
}

/** Prepare a backend-authorized private TEST upload before sending audio bytes. */
export async function prepareConsubancoTranscriptionUpload(input: PrepareConsubancoTranscriptionUploadInput): Promise<{ callId: string; storagePath: string }> {
  const callable = httpsCallable<PrepareConsubancoTranscriptionUploadInput, { callId: string; storagePath: string }>(
    functions, 'prepareConsubancoTranscriptionUpload'
  );
  // Firebase Functions validates TEST membership, comparison privileges, and the requested snapshot.
  const result = await callable(input);
  return result.data;
}

export interface ConversationMetricEvent {
  id: string;
  start: number;
  end: number;
  text: string;
  category?: 'possible_interruption' | 'brief_acknowledgment_candidate' | 'uncertain_overlap';
  kind?: 'lexical_filler_candidate' | 'repetition_candidate';
  seconds?: number;
  duration?: number;
  role?: 'agent' | 'customer' | 'unknown';
  evidenceIds?: string[];
  textTruncated?: boolean;
  evidenceIdsTruncated?: boolean;
}

export interface ConversationMetricSegment extends ConversationMetricEvent {
  speaker: string;
  role: 'agent' | 'customer' | 'unknown';
  wordCount: number;
  wpm: number | null;
  speedEligible: boolean;
  tooFast: boolean | null;
  exclusionReason: string | null;
  timingExcluded?: boolean;
}

export interface ConversationMetricsReport {
  schemaVersion: string;
  method: string;
  calculationVersion?: 'segment_timing_v2' | 'openai_segment_timing_v1';
  timingSource?: 'word' | 'segment';
  segmentEvidenceLocation?: string;
  limitations?: string[];
  status: 'available' | 'partial' | 'unavailable';
  availability: Record<'speed' | 'talkBalance' | 'turns' | 'gaps' | 'interruptions' | 'fillers', { available: boolean; reason: string | null }>;
  coverage: {
    inputWordCount: number; validatedWordCount: number; excludedWordCount: number; unknownRoleWordCount: number;
    totalSegmentCount?: number; excludedSegmentCount?: number; analyzedWordCount?: number;
  };
  evidenceTruncated?: boolean;
  evidenceTotals?: { words: number; segments: number; interruptions: number; gaps: number; fillers: number };
  summary: {
    fastSegmentCount: number | null;
    fastestWpm: number | null;
    agentSpeechSeconds: number | null;
    customerSpeechSeconds: number | null;
    overlapSeconds: number | null;
    agentTalkPercent: number | null;
    longestAgentTurnSeconds: number | null;
    medianResponseGapSeconds: number | null;
    interruptionCandidateCount: number | null;
    fillerCandidateCount: number | null;
    fillerCandidatesPer100Words: number | null;
  };
  segments: ConversationMetricSegment[];
  interruptions: ConversationMetricEvent[];
  gaps: ConversationMetricEvent[];
  fillers: ConversationMetricEvent[];
}

export interface ConversationMetricsResponse {
  metrics: ConversationMetricsReport | null;
  interpretationStatus: string;
  observations: Array<{
    category?: 'speed' | 'talk_balance' | 'turn' | 'response_gap' | 'interruption_candidate' | 'filler_candidate';
    text: string;
    evidenceIds: string[];
  }>;
  speedAdjustment?: {
    baseCredit: number | null;
    deduction: number;
    finalCredit: number | null;
    ruleVersion: string;
    thresholdWpm: number;
    reason: 'adjusted' | 'unavailable' | 'no_fast_segments' | 'excluded' | 'invalid_credit';
  } | null;
}

export type GeminiAudioReviewStatus = 'queued' | 'running' | 'complete' | 'failed' | 'unavailable';
export type GeminiAudioReviewCategory = 'important_explanations' | 'turn_taking' | 'adaptation_courtesy';

export interface GeminiAudioReviewEvidence {
  id: string;
  start: number;
  end: number;
  text: string;
  role: 'agent' | 'customer' | 'unknown';
}

export interface GeminiAudioReviewObservation {
  category: GeminiAudioReviewCategory;
  text: string;
  coaching: string;
  evidenceIds: string[];
  uncertain: boolean;
}

export interface GeminiAudioReviewResult {
  status: GeminiAudioReviewStatus;
  reason?: string | null;
  model: string;
  observations: GeminiAudioReviewObservation[];
  evidence: GeminiAudioReviewEvidence[];
  attempts: number;
  error?: string | null;
  reviewId?: string;
  updatedAt?: string;
}

export interface GeminiAudioReviewResponse {
  enabled: boolean;
  privacyApproved: boolean;
  review: GeminiAudioReviewResult | null;
  error?: string | null;
}

export interface RequestGeminiAudioReviewResponse {
  status: GeminiAudioReviewStatus;
  reviewId?: string;
}

export interface RequestGeminiAudioReviewInput {
  callId: string;
  requestId: string;
  regenerate?: boolean;
  authCostConfirmed: boolean;
}

/** Creates the restricted metrics callable; authorization is enforced server-side. */
const getConversationMetricsFn = httpsCallable<{ callId: string }, ConversationMetricsResponse | null>(
  functions,
  'getConversationMetrics'
);

/** Reads metrics without triggering processing or changing a stored call. */
export async function getConversationMetrics(input: { callId: string }): Promise<ConversationMetricsResponse | null> {
  /** Calls Firebase Functions for supervisor/admin-only conversation evidence. */
  const result = await getConversationMetricsFn(input);
  return result.data;
}

/** Creates the read-only Gemini audio review callable; authorization is enforced server-side. */
const getGeminiAudioReviewFn = httpsCallable<{ callId: string }, GeminiAudioReviewResponse>(
  functions,
  'getGeminiAudioReview'
);

/** Creates the explicit admin Gemini review request callable; it may enqueue paid inference. */
const requestGeminiAudioReviewFn = httpsCallable<RequestGeminiAudioReviewInput, RequestGeminiAudioReviewResponse>(
  functions,
  'requestGeminiAudioReview'
);

/** Reads a stored or pending Gemini audio review without triggering inference. */
export async function getGeminiAudioReview(input: { callId: string }): Promise<GeminiAudioReviewResponse> {
  /** Calls Firebase Functions for supervisor/admin-only Gemini review state. */
  const result = await getGeminiAudioReviewFn(input);
  return result.data;
}

/** Requests the backend to generate or regenerate a Gemini audio review for an authorized admin. */
export async function requestGeminiAudioReview(input: RequestGeminiAudioReviewInput): Promise<RequestGeminiAudioReviewResponse> {
  /** Calls Firebase Functions to enqueue paid Gemini audio review work after server-side gates. */
  const result = await requestGeminiAudioReviewFn(input);
  return result.data;
}

// Cloud Function callable references
const transcribeCallFn = httpsCallable<{ callId: string }, { success: boolean }>(
  functions,
  'transcribeCall'
);

const analyzeCallFn = httpsCallable<{ callId: string }, { success: boolean }>(
  functions,
  'analyzeCall'
);

const reprocessCallFn = /* @__PURE__ */ httpsCallable<
  { callId: string; stage: 'transcribe' | 'analyze' },
  { success: true; callId: string; newStatus: 'uploaded' | 'analyzing' }
>(functions, 'reprocessCall');

const cancelCallProcessingFn = httpsCallable<
  { callId: string },
  { success: boolean; callId: string; canceled: boolean; previousStatus: string; activeRunId?: string }
>(functions, 'cancelCallProcessing');

const deleteAgentAnalysisFn = httpsCallable<
  { agentAnalysisId: string },
  { success: boolean }
>(functions, 'deleteAgentAnalysis');
const deleteCallDeepFn = httpsCallable<
  { callId: string },
  {
    success: boolean;
    callId: string;
    removedTranscript: boolean;
    removedFeedbackCount: number;
    removedSnapshotCount: number;
    removedReminderCount: number;
    removedAudio: boolean;
    agentKey?: string;
  }
>(functions, 'deleteCallDeep');
const refreshAgentActivityFn = httpsCallable<
  { agentAnalysisId: string },
  {
    success: boolean;
    processedCount: number;
    skippedCount: number;
    errorCount: number;
    errors: string[];
  }
>(functions, 'refreshAgentActivity');
const ensureConsubancoMembershipForCurrentUserFn = httpsCallable<
  Record<string, never>,
  { success: boolean; created: boolean; uid: string; email: string; organizationId: string; role: string | null }
>(functions, 'ensureConsubancoMembershipForCurrentUser');
const assignUnrecognizedCallToAgentFn = httpsCallable<
  { callId: string; agentAnalysisId: string },
  {
    success: boolean;
    changed: boolean;
    activitySynced: boolean;
    agentKey?: string;
    callId: string;
    agentAnalysisId: string;
  }
>(functions, 'assignUnrecognizedCallToAgent');
const diagnoseAgentProfileCallLinksFn = httpsCallable<
  Record<string, never>,
  AgentProfileCallLinkDiagnosticResponse
>(functions, 'diagnoseAgentProfileCallLinks');
const repairAgentProfileCallLinksFn = httpsCallable<
  { dryRun?: boolean; maxCalls?: number },
  AgentProfileCallLinkRepairResponse
>(functions, 'repairAgentProfileCallLinks');

export interface AgentProfileLinkExample {
  callId: string;
  salesAgentId?: string;
  salesAgentName?: string;
  matchedAgentAnalysisId?: string;
  matchedAgentProfileKey?: string;
  expectedAgentAnalysisId?: string;
  expectedSalesAgentId?: string;
  reason: string;
}

export interface AgentProfileLinkDiagnosticBucket {
  count: number;
  examples: AgentProfileLinkExample[];
}

export interface AgentProfileCallLinkDiagnosticResponse {
  success: boolean;
  scannedCount: number;
  healthy: AgentProfileLinkDiagnosticBucket;
  missingSalesAgentId: AgentProfileLinkDiagnosticBucket;
  staleSalesAgentId: AgentProfileLinkDiagnosticBucket;
  missingMatchedAgentAnalysisId: AgentProfileLinkDiagnosticBucket;
  unknownTarget: AgentProfileLinkDiagnosticBucket;
  needsActivitySync: AgentProfileLinkDiagnosticBucket;
}

export interface AgentProfileCallLinkRepairResponse {
  success: boolean;
  dryRun: boolean;
  scannedCount: number;
  repairedCount: number;
  activitySyncedCount: number;
  skippedCount: number;
  moreRemaining: boolean;
  examples: AgentProfileLinkExample[];
}


export type CccRuntimeFailureStage = "analysis" | "transcription";
export type CccRuntimeFailureStageFilter = "all" | CccRuntimeFailureStage;
export type CccRuntimeFailureRetryState = "eligible" | "not_retryable" | "exhausted" | "running" | "complete" | "unknown";
export type CccRuntimeFailureRetryStateFilter = "all" | Exclude<CccRuntimeFailureRetryState, "unknown">;
export type CccRuntimeFailureEnvironmentFilter = "all" | "testing" | "production";
export type RetryCccRuntimeFailuresMode = "selected" | "all_eligible" | "agent";

export interface ListCccRuntimeFailuresRequest {
  stage?: CccRuntimeFailureStageFilter;
  retryState?: CccRuntimeFailureRetryStateFilter;
  workflowEnvironment?: CccRuntimeFailureEnvironmentFilter;
  salesAgentId?: string;
  dateKey?: string;
  limit?: number;
}

export interface CccRuntimeFailureRow {
  callId: string;
  stage: CccRuntimeFailureStage;
  retryState: CccRuntimeFailureRetryState;
  retryEligible: boolean;
  retryCount: number;
  maxRetryCount: number;
  salesAgentId: string | null;
  salesAgentName: string | null;
  sourceObjectPath: string | null;
  sourceFilename: string | null;
  callTimestamp: string | null;
  updatedAt: string | null;
  errorDateKey: string | null;
  workflowEnvironment: "testing" | "production" | "unknown";
  lastError: string | null;
  errorSource: string | null;
  status: string | null;
}

export interface ListCccRuntimeFailuresResponse {
  success: true;
  generatedAt: string;
  allErrorCount: number;
  selectedDateKey: string | null;
  selectedDateErrorCount: number;
  latestErrorDateKey: string | null;
  rows: CccRuntimeFailureRow[];
}

export interface RetryCccRuntimeFailuresRequest {
  mode: RetryCccRuntimeFailuresMode;
  callIds?: string[];
  salesAgentId?: string;
  stage?: CccRuntimeFailureStageFilter;
  retryState?: CccRuntimeFailureRetryStateFilter;
  workflowEnvironment?: CccRuntimeFailureEnvironmentFilter;
  dateKey?: string;
  limit?: number;
}

export interface RuntimeFailureRetryResult {
  queued: boolean;
  callId: string;
  stage?: CccRuntimeFailureStage;
  retryCount?: number;
  skippedReason?: string;
}

export interface RetryCccRuntimeFailuresResponse {
  success: true;
  mode: RetryCccRuntimeFailuresMode;
  scanned: number;
  queued: number;
  skipped: number;
  skippedByReason: Record<string, number>;
  results: RuntimeFailureRetryResult[];
}

export type AgentEmailReportType = 'daily' | 'weekly';
export type AgentEmailReportDeliveryStatus = 'dry_run' | 'skipped' | 'queued' | 'sent' | 'failed';

export interface AgentEmailReportPeriod {
  reportType: AgentEmailReportType;
  dateKey?: string | null;
  weekKey?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string | null;
}

export interface AgentEmailReportRecipientRow {
  salesAgentId: string;
  salesAgentName: string;
  agentAnalysisId?: string | null;
  agentKey?: string | null;
  eligible?: boolean;
  callCount?: number;
  eligibleCallCount?: number;
  averageScore?: number | null;
  emailRedacted?: string | null;
  emailDomain?: string | null;
  mappingEnabled?: boolean;
  mappingVerified?: boolean;
  mappingPlaceholder?: boolean;
  mappingDemoOnly?: boolean;
  mappingStatus?: string | null;
  latestDeliveryStatus?: AgentEmailReportDeliveryStatus | null;
  latestDeliveryAt?: string | null;
  latestDeliveryId?: string | null;
  skipReason?: string | null;
}

export interface ListAgentEmailReportRecipientsRequest {
  reportType: AgentEmailReportType;
  dateKey?: string | null;
  weekKey?: string | null;
}

export interface ListAgentEmailReportRecipientsResponse {
  success: true;
  period: AgentEmailReportPeriod;
  rows?: AgentEmailReportRecipientRow[];
  recipients?: AgentEmailReportRecipientRow[];
}

export type AgentCoachingReportLength = 'concise' | 'detailed' | 'extensive';
export type AgentCoachingReportType = 'daily' | 'weekly';

export interface AgentCoachingReportOptions {
  includeFollowUpOpportunities: boolean;
  includeTranscriptExcerpts: boolean;
  reportLength: AgentCoachingReportLength;
  selectedCallIds?: string[];
}

export interface AgentCoachingReportCallRow {
  callId: string;
  callName?: string | null;
  customerName?: string | null;
  callOccurredAtIso?: string | null;
  bucketDay?: string | null;
  overallScore?: number | null;
  summary?: string | null;
  strengths?: string[];
  weaknesses?: string[];
  nextBestAction?: string | null;
  selected?: boolean;
}

export interface AgentCoachingPriority {
  title: string;
  evidence: string[];
  impact: string;
  correctionSteps: string[];
  examplePhrases: string[];
  phrasesToAvoid: string[];
  practiceExercise: string;
  nextCallGoal: string;
  relatedRubricCriteria?: string[];
}

export interface AgentCoachingReportEvolution {
  label: string;
  previousAverageScore?: number | null;
  delta?: number | null;
  displayText: string;
}

export interface AgentCoachingReport {
  agent: { salesAgentId: string; salesAgentName: string };
  reportType: AgentCoachingReportType;
  dateRange: { startDate: string; endDate: string; label: string; timezone: string };
  callsAnalyzed: number;
  averageScore?: number | null;
  evolution: AgentCoachingReportEvolution;
  executiveSummary: string[];
  strengths: string[];
  coachingPriorities: AgentCoachingPriority[];
  suggestedCallFlow: Array<{ step: string; guidance: string; examplePhrase: string }>;
  objectionPlaybook: Array<{ objection: string; response: string; evidence?: string | null }>;
  followUpOpportunities: Array<{ callId: string; customerName?: string | null; reason: string; suggestedAction: string; evidence?: string | null }>;
  actionPlan: string[];
  selectedCalls: AgentCoachingReportCallRow[];
  generatedAt: string;
  options: AgentCoachingReportOptions;
}

export interface AgentCoachingReportBuilderRequest {
  salesAgentId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  reportType?: AgentCoachingReportType;
  selectedCallIds?: string[];
  options?: Partial<AgentCoachingReportOptions> | null;
  includePdf?: boolean;
}

export interface ListAgentCoachingReportCallsResponse {
  success: true;
  generatedAt: string;
  range: { startDate: string; endDate: string; label: string; timezone: string };
  rows: AgentCoachingReportCallRow[];
}

export interface GenerateAgentCoachingReportResponse {
  success: true;
  generatedAt: string;
  report: AgentCoachingReport;
  pdfBase64?: string | null;
  filename?: string | null;
}

export interface AvailablePromptsResponse {
  availableVersions: Record<string, string[]>;
  defaults: Record<string, string>;
  agentAnalysisVersions: Record<string, string[]>;
  agentAnalysisDefaults: Record<string, string>;
  activityVersions: Record<string, string[]>;
  activityDefaults: Record<string, string>;
  analyzerModels?: {
    available: string[];
    default: string;
  };
}

const refreshManualShortCallPatternsFn = httpsCallable<
  Record<string, never>,
  { success: true; pattern: ManualShortCallPatternSummary }
>(functions, 'refreshManualShortCallPatterns');

const getAvailablePromptsFn = httpsCallable<void, AvailablePromptsResponse>(
  functions,
  'getAvailablePrompts'
);


const listCccRuntimeFailuresFn = httpsCallable<
  ListCccRuntimeFailuresRequest,
  ListCccRuntimeFailuresResponse
>(functions, "listCccRuntimeFailures");

const retryCccRuntimeFailuresFn = httpsCallable<
  RetryCccRuntimeFailuresRequest,
  RetryCccRuntimeFailuresResponse
>(functions, "retryCccRuntimeFailures");

const listAgentEmailReportRecipientsFn = httpsCallable<
  ListAgentEmailReportRecipientsRequest,
  ListAgentEmailReportRecipientsResponse
>(functions, 'listAgentEmailReportRecipients');

const listAgentCoachingReportCallsFn = httpsCallable<
  AgentCoachingReportBuilderRequest,
  ListAgentCoachingReportCallsResponse
>(functions, 'listAgentCoachingReportCalls');

const generateAgentCoachingReportFn = httpsCallable<
  AgentCoachingReportBuilderRequest,
  GenerateAgentCoachingReportResponse
>(functions, 'generateAgentCoachingReport');

const notifyUploadBatchCompletedFn = httpsCallable<
  { uploadBatchId: string; callIds: string[]; callNames?: string[] | null },
  { success: boolean; messageId: string; created: boolean }
>(functions, 'notifyUploadBatchCompleted');

export type AgentProfileAssistantLanguage = 'es' | 'en';
export type AgentProfileAssistantReferenceType =
  | 'report'
  | 'call'
  | 'reminder'
  | 'progress_rollup'
  | 'sales_rollup';

export interface AgentProfileAssistantReference {
  type: AgentProfileAssistantReferenceType;
  id: string;
  label: string;
}

export type AgentProfileAssistantStructuredTone = 'neutral' | 'good' | 'warning' | 'bad';

export type AgentProfileAssistantStructuredIcon =
  | 'chart'
  | 'trend'
  | 'phone'
  | 'clock'
  | 'flag'
  | 'check'
  | 'info'
  | 'bulb';

export interface AgentProfileAssistantMetricItem {
  label: string;
  value: string;
  icon: AgentProfileAssistantStructuredIcon;
  tone: AgentProfileAssistantStructuredTone;
}

export interface AgentProfileAssistantStepItem {
  title: string;
  body: string;
}

export interface AgentProfileAssistantComparisonRow {
  label: string;
  left: string;
  right: string;
}

export type AgentProfileAssistantStructuredBlock =
  | {
      type: 'metrics';
      items: AgentProfileAssistantMetricItem[];
    }
  | {
      type: 'steps';
      items: AgentProfileAssistantStepItem[];
    }
  | {
      type: 'comparison';
      leftLabel: string;
      rightLabel: string;
      rows: AgentProfileAssistantComparisonRow[];
    }
  | {
      type: 'status';
      label: string;
      tone: AgentProfileAssistantStructuredTone;
      detail?: string;
    }
  | {
      type: 'text';
      text: string;
    };

export interface AgentProfileAssistantStructuredContent {
  intro: string;
  blocks: AgentProfileAssistantStructuredBlock[];
  outro?: string;
}

export interface AgentProfileAssistantChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAtMs: number;
  references?: AgentProfileAssistantReference[];
  structuredContent?: AgentProfileAssistantStructuredContent;
  suggestedQuestions?: string[];
}

export interface AgentProfileAssistantChatIdentity {
  profileScope: 'kesp';
  agentAnalysisId: string;
  salesAgentId: string;
  salesAgentNameSnapshot: string;
  agentKey: string;
  externalAgentSource: 'consubanco' | null;
  externalAgentId: string | null;
}

export interface AgentProfileAssistantChat {
  userId: string;
  profileScope: 'kesp';
  agentAnalysisId: string;
  identity: AgentProfileAssistantChatIdentity;
  assistantBehaviorVersion?: number;
  messages: AgentProfileAssistantChatMessage[];
  compactedSummary?: string;
  compactedThroughMs?: number;
  estimatedStoredHistoryTokens: number;
  compactionVersion: 1;
  createdAtMs?: number;
  updatedAtMs?: number;
}

export interface AgentProfileAssistantContextSummary {
  agentAnalysisId: string;
  salesAgentId: string;
  salesAgentName: string;
  externalAgentSource: 'consubanco' | null;
  externalAgentId: string | null;
  hasLatestReport: boolean;
  recentCallCount: number;
  openReminderCount: number;
  progressRollupCount: number;
  salesRollupCount: number;
}

export interface AgentProfileAssistantChatResponse {
  success: true;
  chat: AgentProfileAssistantChat;
  contextSummary?: AgentProfileAssistantContextSummary;
}

export interface AgentProfileAssistantChatStatusResponse {
  success: true;
  status: {
    exists: boolean;
    assistantBehaviorVersion: number | null;
    updatedAtMs?: number;
    messageCount: number;
    latestMessageId: string | null;
  };
}

export interface AgentProfileAssistantResponse {
  success: true;
  answer: string;
  references: AgentProfileAssistantReference[];
  chat: AgentProfileAssistantChat;
  contextSummary: AgentProfileAssistantContextSummary;
}

/** Calls an external SDK or API dependency. */
const getAgentProfileAssistantChatFn = httpsCallable<
  { agentAnalysisId: string },
  AgentProfileAssistantChatResponse
>(functions, 'getAgentProfileAssistantChat');

/** Calls an external SDK or API dependency. */
const getAgentProfileAssistantChatStatusFn = httpsCallable<
  { agentAnalysisId: string },
  AgentProfileAssistantChatStatusResponse
>(functions, 'getAgentProfileAssistantChatStatus');

/** Calls an external SDK or API dependency. */
const resetAgentProfileAssistantChatFn = httpsCallable<
  { agentAnalysisId: string },
  AgentProfileAssistantChatResponse
>(functions, 'resetAgentProfileAssistantChat');

/** Calls an external SDK or API dependency. */
const askAgentProfileAssistantFn = httpsCallable<
  { agentAnalysisId: string; question: string; language?: AgentProfileAssistantLanguage },
  AgentProfileAssistantResponse
>(functions, 'askAgentProfileAssistant');


export async function listCccRuntimeFailures(
  request: ListCccRuntimeFailuresRequest = {}
): Promise<ListCccRuntimeFailuresResponse> {
  const result = await listCccRuntimeFailuresFn(request);
  result.data.rows.forEach(registerKespDemoWorkflowRowTerms);
  return result.data;
}

export async function retryCccRuntimeFailures(
  request: RetryCccRuntimeFailuresRequest
): Promise<RetryCccRuntimeFailuresResponse> {
  const result = await retryCccRuntimeFailuresFn(request);
  return result.data;
}

export async function listAgentEmailReportRecipients(
  request: ListAgentEmailReportRecipientsRequest
): Promise<ListAgentEmailReportRecipientsResponse> {
  const result = await listAgentEmailReportRecipientsFn(request);
  return result.data;
}

export async function listAgentCoachingReportCalls(
  request: AgentCoachingReportBuilderRequest
): Promise<ListAgentCoachingReportCallsResponse> {
  const result = await listAgentCoachingReportCallsFn(request);
  return result.data;
}

export async function generateAgentCoachingReport(
  request: AgentCoachingReportBuilderRequest
): Promise<GenerateAgentCoachingReportResponse> {
  const result = await generateAgentCoachingReportFn(request);
  return result.data;
}

export async function refreshManualShortCallPatterns(): Promise<ManualShortCallPatternSummary> {
  const result = await refreshManualShortCallPatternsFn({});
  return result.data.pattern;
}

export async function triggerTranscription(callId: string): Promise<void> {
  await transcribeCallFn({ callId });
}

// Trigger analysis for a call
export async function triggerAnalysis(callId: string): Promise<void> {
  await analyzeCallFn({ callId });
}

// Reprocess a failed call
export async function reprocessCall(
  callId: string,
  stage: 'transcribe' | 'analyze'
): Promise<{ success: true; callId: string; newStatus: 'uploaded' | 'analyzing' }> {
  const result = await reprocessCallFn({ callId, stage });
  return result.data;
}

export async function cancelCallProcessing(callId: string): Promise<{
  success: boolean;
  callId: string;
  canceled: boolean;
  previousStatus: string;
  activeRunId?: string;
}> {
  const result = await cancelCallProcessingFn({ callId });
  return result.data;
}

export async function deleteAgentAnalysis(agentAnalysisId: string): Promise<void> {
  await deleteAgentAnalysisFn({ agentAnalysisId });
}

export async function deleteCallDeep(callId: string): Promise<{
  success: boolean;
  removedTranscript: boolean;
  removedFeedbackCount: number;
  removedSnapshotCount: number;
  removedReminderCount: number;
  removedAudio: boolean;
  agentKey?: string;
}> {
  const result = await deleteCallDeepFn({ callId });
  return result.data;
}

export async function refreshAgentActivity(agentAnalysisId: string): Promise<{
  success: boolean;
  processedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
}> {
  const result = await refreshAgentActivityFn({ agentAnalysisId });
  return result.data;
}

export async function ensureConsubancoMembershipForCurrentUser(): Promise<{
  success: boolean;
  created: boolean;
  uid: string;
  email: string;
  organizationId: string;
  role: string | null;
}> {
  const result = await ensureConsubancoMembershipForCurrentUserFn({});
  return result.data;
}

export async function assignUnrecognizedCallToAgent(
  callId: string,
  agentAnalysisId: string
): Promise<{
  success: boolean;
  changed: boolean;
  activitySynced: boolean;
  agentKey?: string;
  callId: string;
  agentAnalysisId: string;
}> {
  const result = await assignUnrecognizedCallToAgentFn({ callId, agentAnalysisId });
  return result.data;
}

export async function diagnoseAgentProfileCallLinks(): Promise<AgentProfileCallLinkDiagnosticResponse> {
  const result = await diagnoseAgentProfileCallLinksFn({});
  return result.data;
}

export async function repairAgentProfileCallLinks(input: {
  dryRun?: boolean;
  maxCalls?: number;
} = {}): Promise<AgentProfileCallLinkRepairResponse> {
  const result = await repairAgentProfileCallLinksFn(input);
  return result.data;
}

// Get available Subagent 2.0 prompt versions
export async function getAvailablePrompts(): Promise<AvailablePromptsResponse> {
  const result = await getAvailablePromptsFn();
  return result.data;
}

export async function notifyUploadBatchCompleted(input: {
  uploadBatchId: string;
  callIds: string[];
  callNames?: string[] | null;
}): Promise<{ success: boolean; messageId: string; created: boolean }> {
  const result = await notifyUploadBatchCompletedFn(input);
  return result.data;
}

/** Documents the getAgentProfileAssistantChat behavior. */
export async function getAgentProfileAssistantChat(
  agentAnalysisId: string
): Promise<AgentProfileAssistantChatResponse> {
  /** Calls an external SDK or API dependency. */
  const result = await getAgentProfileAssistantChatFn({ agentAnalysisId });
  return result.data;
}

/** Documents the getAgentProfileAssistantChatStatus behavior. */
export async function getAgentProfileAssistantChatStatus(
  agentAnalysisId: string
): Promise<AgentProfileAssistantChatStatusResponse> {
  /** Calls an external SDK or API dependency. */
  const result = await getAgentProfileAssistantChatStatusFn({ agentAnalysisId });
  return result.data;
}

/** Documents the resetAgentProfileAssistantChat behavior. */
export async function resetAgentProfileAssistantChat(
  agentAnalysisId: string
): Promise<AgentProfileAssistantChatResponse> {
  /** Calls an external SDK or API dependency. */
  const result = await resetAgentProfileAssistantChatFn({ agentAnalysisId });
  return result.data;
}

/** Documents the askAgentProfileAssistant behavior. */
export async function askAgentProfileAssistant(input: {
  agentAnalysisId: string;
  question: string;
  language?: AgentProfileAssistantLanguage;
}): Promise<AgentProfileAssistantResponse> {
  /** Calls an external SDK or API dependency. */
  const result = await askAgentProfileAssistantFn(input);
  return result.data;
}
