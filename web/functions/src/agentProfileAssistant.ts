import { createDemoOpenAI } from './demoPaidProviders';
import { onCall, onPaidCall, HttpsError, type CallableRequest } from './demoHttps';
import { logger } from 'firebase-functions';
import * as admin from 'firebase-admin';
import OpenAI from 'openai';
import * as crypto from 'crypto';
import { OPENAI_API_KEY_SECRET } from './secrets';
import { assertDemoProfileResourceAccess } from './demoProfileAccess';

export const AGENT_PROFILE_ASSISTANT_MODEL = 'gpt-5.4';

const AGENT_PROFILE_ASSISTANT_CHAT_COLLECTION = 'agent_profile_assistant_chats';
const ASSISTANT_CONTEXT_TIME_ZONE = 'America/Mexico_City';
export const ASSISTANT_BEHAVIOR_VERSION = 4;

export const ASSISTANT_STORED_HISTORY_TOKEN_LIMIT = 10000;
export const ASSISTANT_RECENT_MESSAGE_LIMIT = 12;
export const ASSISTANT_COMPACTION_KEEP_RECENT_MESSAGES = 8;
export const ASSISTANT_MIN_REQUEST_INTERVAL_MS = 1500;
const ASSISTANT_IN_FLIGHT_REQUEST_TIMEOUT_MS = 60000;

export const ASSISTANT_CALL_SNAPSHOT_LIMIT = 12;
export const ASSISTANT_REMINDER_LIMIT = 10;
export const ASSISTANT_ROLLUP_LIMIT = 6;
export const ASSISTANT_PATTERN_LIMIT = 8;
const ASSISTANT_TARGETED_ROLLUP_DAY_LIMIT = 31;
const ASSISTANT_TARGETED_CALL_LIMIT = 12;
const ASSISTANT_TARGETED_FEEDBACK_LIMIT = 6;
const ASSISTANT_TARGETED_TRANSCRIPT_LIMIT = 3;
const ASSISTANT_TRANSCRIPT_SNIPPET_CHARS = 900;
const ASSISTANT_REMINDER_OVERFETCH_LIMIT = 20;
const ASSISTANT_MAX_ANSWER_CHARS = 4000;
const ASSISTANT_MAX_COMPACTION_SUMMARY_CHARS = 2200;
const ASSISTANT_COMPACTION_MAX_INPUT_CHARS = 40000;
const ASSISTANT_MAX_STRUCTURED_TEXT_CHARS = 700;
const ASSISTANT_MAX_STRUCTURED_INTRO_CHARS = 150;
const ASSISTANT_MAX_STRUCTURED_BLOCKS = 3;
const ASSISTANT_MAX_STRUCTURED_ITEMS = 4;
const ASSISTANT_SUGGESTED_QUESTION_LIMIT = 3;
const ASSISTANT_MAX_PLAN_STRUCTURED_ITEMS = 7;
const ASSISTANT_DEFAULT_PLAN_DAY_COUNT = 7;
const ASSISTANT_MAX_PLAN_DAY_COUNT = 14;

export type AgentProfileAssistantLanguage = 'es' | 'en';

export type AgentProfileAssistantReferenceType =
  | 'report'
  | 'call'
  | 'reminder'
  | 'progress_rollup'
  | 'sales_rollup';

const VALID_ASSISTANT_REFERENCE_TYPES: AgentProfileAssistantReferenceType[] = [
  'report',
  'call',
  'reminder',
  'progress_rollup',
  'sales_rollup',
];

const VALID_ASSISTANT_STRUCTURED_TONES: AgentProfileAssistantStructuredTone[] = [
  'neutral',
  'good',
  'warning',
  'bad',
];

const VALID_ASSISTANT_STRUCTURED_ICONS: AgentProfileAssistantStructuredIcon[] = [
  'chart',
  'trend',
  'phone',
  'clock',
  'flag',
  'check',
  'info',
  'bulb',
];

export interface GetAgentProfileAssistantChatRequest {
  agentAnalysisId: string;
}

export interface ResetAgentProfileAssistantChatRequest {
  agentAnalysisId: string;
}

export interface GetAgentProfileAssistantChatStatusRequest {
  agentAnalysisId: string;
}

export interface AskAgentProfileAssistantRequest {
  agentAnalysisId: string;
  question: string;
  language?: AgentProfileAssistantLanguage;
}

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

interface OwnedAgentProfileSnapshot {
  agentAnalysisId: string;
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  latestReportId: string | null;
}

interface NormalizedBehaviorPattern {
  patternId: string;
  patternName: string;
  priorityScore: number;
  seenInCallCount: number;
  totalCallCount: number;
  behaviorSummary: string;
  whenItHappens: string;
  businessImpact: string;
  rootCause: string;
  coachingFocus: string;
  severityDistribution: Partial<Record<string, number>>;
}

interface NormalizedLatestReportContext {
  reportId: string;
  sourceCallIds: string[];
  patterns: NormalizedBehaviorPattern[];
}

interface NormalizedCallSnapshotContext {
  callId: string;
  sourceCallId: string;
  latestFeedbackId?: string | null;
  callOccurredAtMs?: number;
  callOccurredAtIso?: string;
  bucketDay?: string;
  customerName?: string | null;
  overallScore?: number | null;
  performanceTier?: string | null;
  lowConfidence?: boolean;
  callOutcome?: string | null;
  loanCompleted?: string | null;
  strengthTitles: string[];
  weaknessTitles: string[];
  weaknessSeverities?: string[];
  followUpNeeded: boolean;
  nextAction?: string | null;
  lastCallSummary?: string | null;
  nextBestAction?: string | null;
  whatAgentShouldSayNext?: string | null;
}

interface NormalizedReminderContext {
  reminderId: string;
  sourceCallId?: string;
  state: string;
  effectiveDueDate?: string | null;
  effectiveDueTime?: string | null;
  effectiveTimeRange?: string | null;
  effectiveConditionText?: string | null;
  nextAction?: string | null;
  customerName?: string | null;
}

interface NormalizedProgressRollupContext {
  rollupId: string;
  periodType?: string;
  bucketKey?: string;
  sourceCallIds?: string[];
  totalReviewedCalls?: number;
  eligibleScoreCount?: number;
  lowConfidenceCallCount?: number;
  averageScore?: number | null;
  topStrengths?: Array<{ label: string; count: number }>;
  topWeaknesses?: Array<{ label: string; count: number }>;
  coachingPriorities: Array<{ label: string; count: number }>;
}

interface NormalizedSalesRollupContext {
  rollupId: string;
  periodType?: string;
  bucketKey?: string;
  soldLoanCount?: number;
  totalAmountSold?: number;
  followUpNeededCount?: number;
}

interface LoadedAgentProfileAssistantContext {
  latestReport: NormalizedLatestReportContext | null;
  callSnapshots: NormalizedCallSnapshotContext[];
  reminders: NormalizedReminderContext[];
  progressRollups: NormalizedProgressRollupContext[];
  salesRollups: NormalizedSalesRollupContext[];
  retrievalPlan?: AssistantRetrievalPlan;
  evidenceBundle?: AgentProfileAssistantEvidenceBundle;
  referenceMap: Map<string, AgentProfileAssistantReference>;
  contextSummary: AgentProfileAssistantContextSummary;
}

interface AssistantModelReference {
  type: AgentProfileAssistantReferenceType;
  id: string;
}

interface AssistantOpenAiError {
  status?: number;
  message?: string;
}

interface AssistantStructuredSanitizeOptions {
  maxItems: number;
}

type AssistantQuestionDomain =
  | 'coaching'
  | 'reminders'
  | 'sales'
  | 'score_progression'
  | 'performance_analysis'
  | 'ui'
  | 'out_of_scope'
  | 'unknown';

type AssistantFollowUpAction =
  | 'coaching_draft'
  | 'coaching_practice'
  | 'coaching_evidence'
  | 'reminder_draft';

interface AssistantQuestionIntent {
  domain: AssistantQuestionDomain;
  supported: boolean;
  requestedCount?: number;
  requestedPlanDays?: number;
  wantsPlan: boolean;
  wantsDayByDayPlan: boolean;
  wantsDistinctFromRecent: boolean;
  ambiguousFollowUp: boolean;
  affirmativeFollowUp: boolean;
  inheritedDomain?: AssistantQuestionDomain;
  inheritedFollowUpAction?: AssistantFollowUpAction;
  unsupportedReason?: string;
  instruction: string;
}

type AssistantRetrievalTopic =
  | 'profile'
  | 'score_progression'
  | 'performance_analysis'
  | 'call_diagnosis'
  | 'coaching'
  | 'reminders'
  | 'sales'
  | 'ui'
  | 'unknown';

type AssistantRetrievalDepth = 'minimal' | 'evidence' | 'transcript';

type AssistantPeriodAnalysisMode =
  | 'worst_period'
  | 'best_period'
  | 'pattern_drivers'
  | 'trend_summary';

type AssistantPeriodGranularity = 'day' | 'week' | 'month';

interface AssistantRetrievalDateRange {
  startDate: string;
  endDate: string;
  label: string;
}

export interface AssistantRetrievalPlan {
  topic: AssistantRetrievalTopic;
  depth: AssistantRetrievalDepth;
  reason: string;
  dateRange?: AssistantRetrievalDateRange;
  compareDateRange?: AssistantRetrievalDateRange;
  periodAnalysisMode?: AssistantPeriodAnalysisMode;
  periodGranularity?: AssistantPeriodGranularity;
  requiresReport: boolean;
  requiresProgressRollups: boolean;
  requiresCallSnapshots: boolean;
  requiresFeedback: boolean;
  requiresTranscripts: boolean;
  requiresReminders: boolean;
  requiresSales: boolean;
}

interface NormalizedRubricCriterionEvidence {
  quote: string;
  speaker: string | null;
}

interface NormalizedRubricCriterionIssue {
  title: string;
  detail: string;
  severity?: string | null;
  evidence: NormalizedRubricCriterionEvidence[];
}

interface NormalizedRubricCriterionSummary {
  criterionId: string;
  title: string;
  sectionTitle?: string;
  groupTitle?: string;
  earnedPoints?: number | null;
  maxPoints?: number | null;
  scorePercent?: number | null;
  status?: string | null;
  justification?: string | null;
  improvementTip?: string | null;
  issues: NormalizedRubricCriterionIssue[];
}

interface NormalizedCallFeedbackSummary {
  callId: string;
  feedbackId: string;
  overallScore?: number | null;
  performanceTier?: string | null;
  lowConfidence?: boolean;
  weakestCriteria: NormalizedRubricCriterionSummary[];
}

interface NormalizedCallTranscriptSnippet {
  callId: string;
  text: string;
}

interface AgentProfileAssistantEvidenceBundle {
  progressRollups: NormalizedProgressRollupContext[];
  compareProgressRollups: NormalizedProgressRollupContext[];
  callSnapshots: NormalizedCallSnapshotContext[];
  compareCallSnapshots: NormalizedCallSnapshotContext[];
  feedbackSummaries: NormalizedCallFeedbackSummary[];
  transcriptSnippets: NormalizedCallTranscriptSnippet[];
  missing: string[];
}

interface AssistantStepReference {
  kind: 'day' | 'step';
  value: number;
  label: string;
}

interface AssistantReferencedStep {
  item: AgentProfileAssistantStepItem;
  index: number;
}

/** Checks whether a domain can be inherited across conversational follow-ups. */
function isAssistantInheritableDomain(domain: AssistantQuestionDomain | undefined): boolean {
  return domain === 'coaching' || domain === 'reminders' || domain === 'sales' || domain === 'score_progression';
}

export interface AssistantModelJsonOutput {
  answer: string;
  structuredContent?: AgentProfileAssistantStructuredContent;
  references: AssistantModelReference[];
}

export function buildAgentProfileAssistantChatId(uid: string, agentAnalysisId: string): string {
  const safeAgentAnalysisId = agentAnalysisId.replace(/[\\/]/g, '_');
  return `${uid}__kesp__${safeAgentAnalysisId}`;
}

export function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.ceil(trimmed.length / 3.5);
}

export function normalizeAssistantLanguage(value: unknown): AgentProfileAssistantLanguage {
  return value === 'en' ? 'en' : 'es';
}

export function validateAgentAnalysisId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new HttpsError('invalid-argument', 'agentAnalysisId is required');
  }
  if (raw.includes('/') || raw.includes('\\')) {
    throw new HttpsError('invalid-argument', 'agentAnalysisId must not include path separators');
  }
  return raw;
}

export function validateAssistantQuestion(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new HttpsError('invalid-argument', 'question is required');
  }
  const maxChars = 2000;
  if (raw.length > maxChars) {
    throw new HttpsError('invalid-argument', `question must be <= ${maxChars} characters`);
  }
  return raw;
}

export function timestampToMs(value: FirebaseFirestore.Timestamp | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  return value.toMillis();
}

function requireAuthUid(request: CallableRequest<unknown>): string {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }
  return request.auth.uid;
}

/** Loads an owned or exact-namespace shared profile for verified demo staff. */
async function loadOwnedAgentProfile(
  db: FirebaseFirestore.Firestore,
  agentAnalysisId: string,
  uid: string
): Promise<OwnedAgentProfileSnapshot> {
  /** Calls Firestore Admin SDK to load the requested KESP agent profile. */
  const agentAnalysisDoc = await db.collection('agent_analyses').doc(agentAnalysisId).get();
  if (!agentAnalysisDoc.exists) {
    throw new HttpsError('not-found', 'Agent profile not found');
  }

  const data = agentAnalysisDoc.data();
  const uploadedBy = typeof data?.uploadedBy === 'string' ? data.uploadedBy : '';
  await assertDemoProfileResourceAccess(uid, data, db);

  const salesAgentId = typeof data?.salesAgentId === 'string' ? data.salesAgentId.trim() : '';
  if (!salesAgentId) {
    throw new HttpsError(
      'failed-precondition',
      'Este perfil no tiene un agente de ventas vinculado.'
    );
  }

  const salesAgentName = typeof data?.salesAgentName === 'string' ? data.salesAgentName.trim() : '';
  const latestReportId =
    typeof data?.latestReportId === 'string' && data.latestReportId.trim()
      ? data.latestReportId.trim()
      : null;
  return {
    agentAnalysisId,
    uploadedBy,
    salesAgentId,
    salesAgentName: salesAgentName || 'Agente',
    latestReportId,
  };
}

/** Builds the stable profile identity used to fetch activity and persist assistant chats. */
function buildChatIdentity(
  profile: OwnedAgentProfileSnapshot
): AgentProfileAssistantChatIdentity {
  return {
    profileScope: 'kesp',
    agentAnalysisId: profile.agentAnalysisId,
    salesAgentId: profile.salesAgentId,
    salesAgentNameSnapshot: profile.salesAgentName,
    // Mirrors buildAgentKey() in agentActivity.ts (not imported to avoid module-level side effects).
    agentKey: `${profile.uploadedBy}__${profile.salesAgentId}`,
    externalAgentSource: null,
    externalAgentId: null,
  };
}

function coerceEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (value && typeof (value as FirebaseFirestore.Timestamp).toMillis === 'function') {
    return (value as FirebaseFirestore.Timestamp).toMillis();
  }
  return undefined;
}

function coerceAssistantReference(value: unknown): AgentProfileAssistantReference | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const label = typeof record.label === 'string' ? record.label.trim() : '';
  if (typeof type !== 'string' || !VALID_ASSISTANT_REFERENCE_TYPES.includes(type as AgentProfileAssistantReferenceType)) {
    return undefined;
  }
  if (!id || !label) {
    return undefined;
  }
  return { type: type as AgentProfileAssistantReferenceType, id, label };
}

/** Sanitizes follow-up question chips generated from the assistant's latest answer. */
function sanitizeAssistantSuggestedQuestions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seen = new Set<string>();
  const questions = value
    .map(
      /** Sanitizes one suggested follow-up question. */
      (question) => (typeof question === 'string' ? sanitizeStructuredString(question, 120) : '')
    )
    .filter(
      /** Keeps non-empty and non-duplicated follow-up questions. */
      (question) => {
        const key = normalizeIntentText(question);
        if (!question || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      }
    )
    .slice(0, ASSISTANT_SUGGESTED_QUESTION_LIMIT);
  return questions.length > 0 ? questions : undefined;
}

/**
 * Builds a Firestore-safe assistant message without undefined optional fields.
 */
function serializeAssistantMessageForFirestore(
  message: AgentProfileAssistantChatMessage
): AgentProfileAssistantChatMessage {
  const baseMessage: AgentProfileAssistantChatMessage = {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAtMs: message.createdAtMs,
  };

  const withStructuredContent = message.structuredContent
    ? { ...baseMessage, structuredContent: message.structuredContent }
    : baseMessage;

  const withReferences = message.references && message.references.length > 0
    ? { ...withStructuredContent, references: message.references }
    : withStructuredContent;

  return message.suggestedQuestions && message.suggestedQuestions.length > 0
    ? { ...withReferences, suggestedQuestions: message.suggestedQuestions }
    : withReferences;
}

function coerceAssistantMessage(value: unknown): AgentProfileAssistantChatMessage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const role = record.role;
  const content = typeof record.content === 'string' ? record.content : '';
  const createdAtMs = typeof record.createdAtMs === 'number' ? record.createdAtMs : NaN;
  if (!id || (role !== 'user' && role !== 'assistant') || !content || !Number.isFinite(createdAtMs)) {
    return undefined;
  }

  const references = Array.isArray(record.references)
    ? record.references
        .map((ref) =>
          coerceAssistantReference(ref)
        )
        .filter((ref): ref is AgentProfileAssistantReference => Boolean(ref))
    : undefined;
  const structuredContent = sanitizeAssistantStructuredContent(record.structuredContent);
  const suggestedQuestions = sanitizeAssistantSuggestedQuestions(record.suggestedQuestions);

  return serializeAssistantMessageForFirestore({
    id,
    role,
    content,
    createdAtMs,
    ...(references && references.length > 0 ? { references } : {}),
    ...(structuredContent ? { structuredContent } : {}),
    ...(suggestedQuestions ? { suggestedQuestions } : {}),
  });
}

function buildEmptyChat(
  uid: string,
  agentAnalysisId: string,
  identity: AgentProfileAssistantChatIdentity
): AgentProfileAssistantChat {
  return {
    userId: uid,
    profileScope: 'kesp',
    agentAnalysisId,
    identity,
    assistantBehaviorVersion: ASSISTANT_BEHAVIOR_VERSION,
    messages: [],
    estimatedStoredHistoryTokens: 0,
    compactionVersion: 1,
  };
}

function coerceChatFromDoc(
  uid: string,
  agentAnalysisId: string,
  identity: AgentProfileAssistantChatIdentity,
  data: FirebaseFirestore.DocumentData | undefined
): AgentProfileAssistantChat {
  const storedUserId = typeof data?.userId === 'string' ? data.userId : '';
  if (storedUserId && storedUserId !== uid) {
    throw new HttpsError('permission-denied', 'Chat does not belong to this user');
  }
  const storedAgentAnalysisId = typeof data?.agentAnalysisId === 'string' ? data.agentAnalysisId : '';
  if (storedAgentAnalysisId && storedAgentAnalysisId !== agentAnalysisId) {
    throw new HttpsError('permission-denied', 'Chat does not belong to this profile');
  }

  const storedBehaviorVersion =
    typeof data?.assistantBehaviorVersion === 'number' && Number.isFinite(data.assistantBehaviorVersion)
      ? data.assistantBehaviorVersion
      : 0;
  if (storedBehaviorVersion !== ASSISTANT_BEHAVIOR_VERSION) {
    return buildEmptyChat(uid, agentAnalysisId, identity);
  }

  const messages = Array.isArray(data?.messages)
    ? data.messages
        .map((message) =>
          coerceAssistantMessage(message)
        )
        .filter((message): message is AgentProfileAssistantChatMessage => Boolean(message))
        .slice(-200)
    : [];

  const compactedSummary =
    typeof data?.compactedSummary === 'string' && data.compactedSummary.trim()
      ? data.compactedSummary.trim()
      : undefined;
  const compactedThroughMs =
    typeof data?.compactedThroughMs === 'number' && Number.isFinite(data.compactedThroughMs)
      ? data.compactedThroughMs
      : undefined;

  const estimatedStoredHistoryTokens =
    typeof data?.estimatedStoredHistoryTokens === 'number' &&
    Number.isFinite(data.estimatedStoredHistoryTokens) &&
    data.estimatedStoredHistoryTokens >= 0
      ? data.estimatedStoredHistoryTokens
      : estimateTextTokens(compactedSummary || '') +
        messages.reduce(
          (sum, message) =>
            sum + estimateTextTokens(message.content),
          0
        );

  return {
    userId: uid,
    profileScope: 'kesp',
    agentAnalysisId,
    identity,
    assistantBehaviorVersion: ASSISTANT_BEHAVIOR_VERSION,
    messages,
    compactedSummary,
    compactedThroughMs,
    estimatedStoredHistoryTokens,
    compactionVersion: 1,
    createdAtMs: coerceEpochMs(data?.createdAtMs),
    updatedAtMs: coerceEpochMs(data?.updatedAtMs),
  };
}

/** Clears an in-flight assistant ask claim after a handled backend failure. */
async function releaseAssistantAskClaim(chatRef: FirebaseFirestore.DocumentReference): Promise<void> {
  try {
    /** Calls Firestore Admin SDK to release the profile-assistant in-flight request marker. */
    await chatRef.set({ lastAskAtMs: null }, { merge: true });
  } catch (error) {
    logger.warn('Failed to release assistant ask claim:', error);
  }
}

function tAssistantLabel(language: AgentProfileAssistantLanguage, esLabel: string, enLabel: string): string {
  return language === 'en' ? enLabel : esLabel;
}

/** Formats the assistant business date in KESP's operating timezone. */
function getAssistantBusinessDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ASSISTANT_CONTEXT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const ASSISTANT_MONTH_INDEX: Record<string, number> = {
  enero: 1,
  january: 1,
  febrero: 2,
  february: 2,
  marzo: 3,
  march: 3,
  abril: 4,
  april: 4,
  mayo: 5,
  may: 5,
  junio: 6,
  june: 6,
  julio: 7,
  july: 7,
  agosto: 8,
  august: 8,
  septiembre: 9,
  setiembre: 9,
  september: 9,
  octubre: 10,
  october: 10,
  noviembre: 11,
  november: 11,
  diciembre: 12,
  december: 12,
};

const ASSISTANT_MONTH_PATTERN = Object.keys(ASSISTANT_MONTH_INDEX).join('|');
const ASSISTANT_WEEKDAY_PATTERN = [
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
  'domingo',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
].join('|');

/** Formats one UTC date object as an ISO calendar day. */
function formatAssistantIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Adds whole days to an ISO calendar date without depending on local timezone parsing. */
function addAssistantIsoDays(isoDate: string, offsetDays: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return formatAssistantIsoDate(date);
}

/** Builds a calendar date from partial user-provided date parts. */
function buildAssistantIsoDateFromParts(params: {
  referenceDate: string;
  day: number;
  month?: number;
  year?: number;
}): string | null {
  const [referenceYear, referenceMonth] = params.referenceDate.split('-').map(Number);
  const year = params.year ?? referenceYear;
  const month = params.month ?? referenceMonth;
  if (!Number.isInteger(params.day) || params.day < 1 || params.day > 31) {
    return null;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, params.day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== params.day) {
    return null;
  }
  return formatAssistantIsoDate(date);
}

/** Finds the first month name mentioned in a normalized question. */
function extractAssistantMentionedMonth(normalized: string): number | undefined {
  const match = normalized.match(new RegExp(`\\b(${ASSISTANT_MONTH_PATTERN})\\b`));
  const monthName = match?.[1];
  return monthName ? ASSISTANT_MONTH_INDEX[monthName] : undefined;
}

/** Counts inclusive days in a compact ISO range while capping unsafe ranges. */
function countAssistantInclusiveDays(range: AssistantRetrievalDateRange): number {
  let count = 1;
  let cursor = range.startDate;
  while (cursor < range.endDate && count <= ASSISTANT_TARGETED_ROLLUP_DAY_LIMIT) {
    cursor = addAssistantIsoDays(cursor, 1);
    count += 1;
  }
  return count;
}

/** Builds a localized retrieval range label without inventing extra meaning. */
function buildAssistantDateRangeLabel(
  language: AgentProfileAssistantLanguage,
  startDate: string,
  endDate: string
): string {
  if (startDate === endDate) {
    return startDate;
  }
  return tAssistantLabel(language, `${startDate} a ${endDate}`, `${startDate} to ${endDate}`);
}

/** Creates a normalized assistant retrieval range object. */
function buildAssistantDateRange(
  language: AgentProfileAssistantLanguage,
  startDate: string,
  endDate: string
): AssistantRetrievalDateRange {
  const normalizedStart = startDate <= endDate ? startDate : endDate;
  const normalizedEnd = startDate <= endDate ? endDate : startDate;
  return {
    startDate: normalizedStart,
    endDate: normalizedEnd,
    label: buildAssistantDateRangeLabel(language, normalizedStart, normalizedEnd),
  };
}

/** Extracts explicit day-to-day comparisons such as "miércoles 3 a jueves 4". */
function extractAssistantDateComparisonRange(params: {
  normalized: string;
  language: AgentProfileAssistantLanguage;
  referenceDate: string;
}): { compareDateRange: AssistantRetrievalDateRange; dateRange: AssistantRetrievalDateRange } | null {
  const monthContext = extractAssistantMentionedMonth(params.normalized);
  const optionalDateLead = `(?:dia\\s+)?(?:${ASSISTANT_WEEKDAY_PATTERN})?\\s*`;
  const rangePattern = new RegExp(
    `\\b(?:del?|from)?\\s*${optionalDateLead}(\\d{1,2})(?:\\s+de\\s+(${ASSISTANT_MONTH_PATTERN}))?\\s+(?:al|a|hasta|to|-)\\s*${optionalDateLead}(\\d{1,2})(?:\\s+de\\s+(${ASSISTANT_MONTH_PATTERN}))?\\b`
  );
  const match = params.normalized.match(rangePattern);
  if (!match) {
    return null;
  }
  const startDay = Number(match[1]);
  const endDay = Number(match[3]);
  const startMonth = match[2] ? ASSISTANT_MONTH_INDEX[match[2]] : monthContext;
  const endMonth = match[4] ? ASSISTANT_MONTH_INDEX[match[4]] : startMonth ?? monthContext;
  const startDate = buildAssistantIsoDateFromParts({
    referenceDate: params.referenceDate,
    day: startDay,
    month: startMonth,
  });
  const endDate = buildAssistantIsoDateFromParts({
    referenceDate: params.referenceDate,
    day: endDay,
    month: endMonth ?? startMonth,
  });
  if (!startDate || !endDate) {
    return null;
  }
  return {
    compareDateRange: buildAssistantDateRange(params.language, startDate, startDate),
    dateRange: buildAssistantDateRange(params.language, endDate, endDate),
  };
}

/** Extracts a single explicit date mention when the question has a date cue. */
function extractAssistantSingleDateRange(params: {
  normalized: string;
  language: AgentProfileAssistantLanguage;
  referenceDate: string;
}): AssistantRetrievalDateRange | undefined {
  if (includesAnyIntentTerm(params.normalized, ['ayer', 'yesterday'])) {
    const date = addAssistantIsoDays(params.referenceDate, -1);
    return buildAssistantDateRange(params.language, date, date);
  }
  if (includesAnyIntentTerm(params.normalized, ['hoy', 'today'])) {
    return buildAssistantDateRange(params.language, params.referenceDate, params.referenceDate);
  }

  const monthContext = extractAssistantMentionedMonth(params.normalized);
  const hasDateCue = Boolean(monthContext) ||
    includesAnyIntentTerm(params.normalized, [
      'dia',
      'fecha',
      'lunes',
      'martes',
      'miercoles',
      'jueves',
      'viernes',
      'sabado',
      'domingo',
      'day',
      'date',
    ]);
  if (!hasDateCue) {
    return undefined;
  }
  const match = params.normalized.match(
    new RegExp(`\\b(?:dia\\s+)?(?:${ASSISTANT_WEEKDAY_PATTERN})?\\s*(\\d{1,2})(?:\\s+de\\s+(${ASSISTANT_MONTH_PATTERN}))?\\b`)
  );
  const day = Number(match?.[1]);
  const month = match?.[2] ? ASSISTANT_MONTH_INDEX[match[2]] : monthContext;
  const date = buildAssistantIsoDateFromParts({
    referenceDate: params.referenceDate,
    day,
    month,
  });
  return date ? buildAssistantDateRange(params.language, date, date) : undefined;
}

/** Extracts a whole mentioned month as a capped profile-analysis range. */
function extractAssistantMentionedMonthRange(params: {
  normalized: string;
  language: AgentProfileAssistantLanguage;
  referenceDate: string;
}): AssistantRetrievalDateRange | undefined {
  const month = extractAssistantMentionedMonth(params.normalized);
  if (!month) {
    return undefined;
  }
  const [referenceYear, referenceMonth] = params.referenceDate.split('-').map(Number);
  const year = month > referenceMonth ? referenceYear - 1 : referenceYear;
  const startDate = formatAssistantIsoDate(new Date(Date.UTC(year, month - 1, 1)));
  const monthEndDate = formatAssistantIsoDate(new Date(Date.UTC(year, month, 0)));
  const endDate = month === referenceMonth && year === referenceYear
    ? params.referenceDate
    : monthEndDate;
  return buildAssistantDateRange(params.language, startDate, endDate);
}

/** Checks whether the user asks for a cause, comparison, or evidence-backed explanation. */
function wantsAssistantEvidenceRetrieval(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    'a que se debe',
    'a que se debio',
    'causa',
    'causo',
    'causó',
    'comparar',
    'compara',
    'comparado',
    'diferencia',
    'evidencia',
    'explica',
    'explicame',
    'explicación',
    'explicacion',
    'por que',
    'porque',
    'que cambio',
    'que pasó',
    'que paso',
    'responsable',
    'why',
    'what changed',
    'what happened',
    'evidence',
  ]);
}

/** Checks whether the user explicitly needs transcript-level conversation detail. */
function wantsAssistantTranscriptRetrieval(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    'conversacion',
    'conversación',
    'dialogo',
    'diálogo',
    'frase exacta',
    'literal',
    'quote',
    'transcripcion',
    'transcripción',
    'transcript',
    'que dijo',
    'qué dijo',
    'what did',
  ]);
}

/** Checks whether the user asks for score/progression trend analysis. */
function wantsAssistantScoreProgression(normalized: string): boolean {
  const mentionsScore = includesAnyIntentTerm(normalized, [
    'score',
    'puntaje',
    'puntuacion',
    'puntuación',
    'calificacion',
    'calificación',
    'progresion',
    'progresión',
    'avance',
    'promedio',
    'average',
    'progression',
  ]);
  const mentionsTrend = includesAnyIntentTerm(normalized, [
    'bajo',
    'bajó',
    'baja',
    'cayo',
    'cayó',
    'caida',
    'caída',
    'drop',
    'fell',
    'fall',
    'subio',
    'subió',
    'cambio',
    'cambió',
    'delta',
    'del ',
    ' al ',
    ' a ',
    'ayer',
    'hoy',
  ]);
  return mentionsScore && mentionsTrend;
}

/** Checks whether the user wants performance analysis across profile periods. */
function wantsAssistantPerformancePeriodAnalysis(normalized: string): boolean {
  const mentionsPeriod = includesAnyIntentTerm(normalized, [
    'analizando los dias',
    'por dia',
    'por dias',
    'dias',
    'dia',
    'semana',
    'semanas',
    'week',
    'weeks',
    'day',
    'days',
  ]);
  const mentionsExtreme = includesAnyIntentTerm(normalized, [
    'peor dia',
    'peor de los dias',
    'cual ha sido el peor',
    'cual fue el peor',
    'que dia estuvo peor',
    'dia mas bajo',
    'dia mas flojo',
    'le fue peor',
    'worst day',
    'lowest day',
    'best day',
    'mejor dia',
    'dia mas alto',
  ]);
  const mentionsDriver = includesAnyIntentTerm(normalized, [
    'patrones lo estan fregando',
    'patrones lo estan afectando',
    'patrones lo frenan',
    'patrones lo estan frenando',
    'que lo esta frenando',
    'que lo esta afectando',
    'que lo esta fregando',
    'fregando',
    'frenando',
    'jalando abajo',
    'lo bajan',
    'lo esta bajando',
    'hurting',
    'holding back',
    'pulling down',
  ]);
  return mentionsExtreme || (mentionsPeriod && mentionsDriver);
}

/** Infers the period-analysis mode from the user's phrasing. */
function inferAssistantPeriodAnalysisMode(normalized: string): AssistantPeriodAnalysisMode {
  if (includesAnyIntentTerm(normalized, ['mejor dia', 'dia mas alto', 'best day', 'highest day'])) {
    return 'best_period';
  }
  if (includesAnyIntentTerm(normalized, ['fregando', 'frenando', 'jalando abajo', 'lo bajan', 'hurting', 'holding back'])) {
    return 'pattern_drivers';
  }
  if (includesAnyIntentTerm(normalized, ['peor', 'mas bajo', 'mas flojo', 'worst', 'lowest'])) {
    return 'worst_period';
  }
  return 'trend_summary';
}

/** Infers whether the period-analysis question is about days, weeks, or months. */
function inferAssistantPeriodGranularity(normalized: string): AssistantPeriodGranularity {
  if (includesAnyIntentTerm(normalized, ['mes', 'mensual', 'month'])) {
    return 'month';
  }
  if (includesAnyIntentTerm(normalized, ['semana', 'semanal', 'week'])) {
    return 'week';
  }
  return 'day';
}

/** Checks whether the user asks to inspect what happened in the agent's calls. */
function wantsAssistantCallDiagnosis(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    'que hizo mal',
    'qué hizo mal',
    'hizo mal',
    'mal este agente',
    'mal esta agente',
    'donde fallo',
    'dónde falló',
    'en que fallo',
    'en qué falló',
    'que fallo',
    'qué falló',
    'que llamadas',
    'qué llamadas',
    'llamadas de ayer',
    'what went wrong',
    'did wrong',
    'call diagnosis',
  ]);
}

/** Builds the internal retrieval plan that decides which profile sources to load. */
export function buildAssistantRetrievalPlan(params: {
  language: AgentProfileAssistantLanguage;
  question: string;
  recentMessages: AgentProfileAssistantChatMessage[];
  intent?: AssistantQuestionIntent;
  referenceDate?: string;
}): AssistantRetrievalPlan {
  const normalized = normalizeIntentText(params.question);
  const referenceDate = params.referenceDate ?? getAssistantBusinessDate();
  const dateComparison = extractAssistantDateComparisonRange({
    normalized,
    language: params.language,
    referenceDate,
  });
  const singleDateRange = dateComparison
    ? undefined
    : extractAssistantSingleDateRange({
        normalized,
        language: params.language,
        referenceDate,
      });
  const mentionedMonthRange = extractAssistantMentionedMonthRange({
    normalized,
    language: params.language,
    referenceDate,
  });
  const requiresTranscripts = wantsAssistantTranscriptRetrieval(normalized);
  const asksEvidence = wantsAssistantEvidenceRetrieval(normalized) || requiresTranscripts;

  if (wantsAssistantScoreProgression(normalized)) {
    const dateRange = dateComparison?.dateRange ?? singleDateRange;
    const compareDateRange =
      dateComparison?.compareDateRange ??
      (dateRange && includesAnyIntentTerm(normalized, ['bajo', 'bajó', 'cayo', 'cayó', 'drop', 'fell', 'fall'])
        ? buildAssistantDateRange(params.language, addAssistantIsoDays(dateRange.startDate, -1), addAssistantIsoDays(dateRange.endDate, -1))
        : undefined);
    return {
      topic: 'score_progression',
      depth: requiresTranscripts ? 'transcript' : 'evidence',
      reason: 'score_progression_question',
      ...(dateRange ? { dateRange } : {}),
      ...(compareDateRange ? { compareDateRange } : {}),
      requiresReport: false,
      requiresProgressRollups: true,
      requiresCallSnapshots: true,
      requiresFeedback: true,
      requiresTranscripts,
      requiresReminders: false,
      requiresSales: false,
    };
  }

  if (wantsAssistantPerformancePeriodAnalysis(normalized) || params.intent?.domain === 'performance_analysis') {
    const dateRange = singleDateRange ??
      mentionedMonthRange ??
      buildAssistantDateRange(params.language, addAssistantIsoDays(referenceDate, -30), referenceDate);
    return {
      topic: 'performance_analysis',
      depth: requiresTranscripts ? 'transcript' : 'evidence',
      reason: 'period_performance_question',
      dateRange,
      periodAnalysisMode: inferAssistantPeriodAnalysisMode(normalized),
      periodGranularity: inferAssistantPeriodGranularity(normalized),
      requiresReport: true,
      requiresProgressRollups: true,
      requiresCallSnapshots: true,
      requiresFeedback: true,
      requiresTranscripts,
      requiresReminders: false,
      requiresSales: false,
    };
  }

  if (wantsAssistantCallDiagnosis(normalized) && (Boolean(singleDateRange) || requiresTranscripts || asksEvidence)) {
    const dateRange = singleDateRange ??
      buildAssistantDateRange(params.language, addAssistantIsoDays(referenceDate, -7), referenceDate);
    return {
      topic: 'call_diagnosis',
      depth: requiresTranscripts ? 'transcript' : 'evidence',
      reason: 'call_quality_question',
      dateRange,
      requiresReport: false,
      requiresProgressRollups: false,
      requiresCallSnapshots: true,
      requiresFeedback: true,
      requiresTranscripts,
      requiresReminders: false,
      requiresSales: false,
    };
  }

  if (params.intent?.domain === 'reminders') {
    return {
      topic: 'reminders',
      depth: 'minimal',
      reason: 'reminder_question',
      requiresReport: false,
      requiresProgressRollups: false,
      requiresCallSnapshots: false,
      requiresFeedback: false,
      requiresTranscripts: false,
      requiresReminders: true,
      requiresSales: false,
    };
  }

  if (params.intent?.domain === 'sales') {
    return {
      topic: 'sales',
      depth: 'minimal',
      reason: 'sales_question',
      requiresReport: false,
      requiresProgressRollups: false,
      requiresCallSnapshots: false,
      requiresFeedback: false,
      requiresTranscripts: false,
      requiresReminders: false,
      requiresSales: true,
    };
  }

  if (params.intent?.domain === 'coaching') {
    return {
      topic: 'coaching',
      depth: asksEvidence ? 'evidence' : 'minimal',
      reason: asksEvidence ? 'coaching_evidence_question' : 'coaching_report_question',
      ...(singleDateRange ? { dateRange: singleDateRange } : {}),
      requiresReport: true,
      requiresProgressRollups: false,
      requiresCallSnapshots: asksEvidence,
      requiresFeedback: asksEvidence,
      requiresTranscripts,
      requiresReminders: false,
      requiresSales: false,
    };
  }

  return {
    topic: params.intent?.domain === 'ui' ? 'ui' : 'unknown',
    depth: asksEvidence ? 'evidence' : 'minimal',
    reason: asksEvidence ? 'unknown_profile_evidence_question' : 'base_profile_question',
    ...(singleDateRange ? { dateRange: singleDateRange } : {}),
    requiresReport: false,
    requiresProgressRollups: false,
    requiresCallSnapshots: asksEvidence,
    requiresFeedback: asksEvidence,
    requiresTranscripts,
    requiresReminders: false,
    requiresSales: false,
  };
}

/** Builds the source hierarchy sent beside the raw profile context. */
function buildAssistantSourceGuide(language: AgentProfileAssistantLanguage): Record<string, unknown> {
  if (language === 'en') {
    return {
      primaryRule: 'Answer the latest user question first; do not let recent chat override the current question.',
      recentChatRule:
        'Recent chat is only continuity and deduplication memory. It may contain old experimental assistant answers, so it is not a source of truth.',
      ambiguousFollowUpRule:
        'If the latest user message is elliptical or ambiguous, inherit the topic domain from the immediately previous user turn.',
      sourcePriority: {
        flexibleAnalysis:
          'Use retrievalPlan and evidenceBundle first for score progression, period performance analysis, call diagnosis, evidence, and transcript-level questions.',
        coaching:
          'Use latestReport.patterns first, in the provided order. Use progressRollups only for supporting metrics and callSnapshots only for evidence.',
        reminders:
          'Use reminders only. If a reminder has no effectiveDueDate, do not claim it is overdue.',
        sales: 'Use salesRollups for sales totals and follow-up counts.',
        ui: 'Use uiGlossary only for static KESP UI explanations.',
      },
      followUps: [
        'For "what else", "otra cosa", or "next", choose the next distinct item not already answered in recentChat.',
        'For "the most important one", "which one", or "why" after a reminder question, keep answering about reminders unless the user names a new domain.',
        'For top N requests, return exactly N items when N supported items exist.',
        'Do not repeat a previous answer unless the user explicitly asks to repeat it.',
      ],
      formatting: [
        'Translate backend action keys into user-facing Spanish or English labels.',
        'Use at most 3 blocks and at most 4 items per block; for long plans, group into phases.',
        'Intro must be one direct sentence. Do not explain which source you used unless the user explicitly asks for evidence or source.',
        'Metrics are only for numbers, dates, money, counts, scores, or very short categorical values; never put long recommendation text in a metric chip.',
        'Use concise structured blocks; avoid filler.',
      ],
      explanationQuality: [
        'Do not make circular feedback. If the user asks why something was unclear, weak, inconsistent, generic, confusing, or poor, do not reuse that same label as the explanation.',
        'Translate report labels into observable causes: what order changed, what detail was missing, what the customer could not decide, or what next step was absent.',
        'When giving "what to say instead", provide a natural sentence the supervisor can actually copy, then add only one short reason if useful.',
      ],
      deliveryRecipes: {
        scoreProgression:
          'For score drops or progression, compare the requested dates/ranges, identify the main changed criterion or weakness, name the responsible call when available, and end with what to coach first.',
        periodPerformance:
          'For worst/best day, daily trend, or pattern-driver questions, pick the relevant period from rollups, open that period’s calls/rubric when available, explain cause + numbers + calls + first coaching action.',
        singleCoachingFocus:
          'For one focus plus why, answer the focus in intro, use metrics for evidence, and use one status block for why it matters. Do not include a 3-step plan unless the user asks how.',
        topNCoaching:
          'For top N coaching requests, use one steps block with exactly N items. Keep evidence in optional metrics only if it adds clarity.',
        reminders:
          'For reminder questions, answer the open/past-due state first, then show the important reminder and why. Do not switch to coaching unless the user changes topic.',
        draftMessage:
          'For “what do I say/send” questions, provide the draft as a text block and use status only for missing context.',
        broadSummary:
          'For broad “how is this agent doing” questions, show metrics first and one status focus. Avoid long explanations.',
      },
    };
  }

  return {
    reglaPrincipal:
      'Responde primero la pregunta más reciente del usuario; no dejes que el historial cambie el tema actual.',
    reglaHistorial:
      'El historial reciente solo sirve para continuidad y para no repetir. Puede contener respuestas experimentales viejas, así que no es fuente de verdad.',
    reglaSeguimientoAmbiguo:
      'Si el último mensaje del usuario es elíptico o ambiguo, hereda el tema del turno inmediatamente anterior del usuario.',
    prioridadDeFuentes: {
      analisisFlexible:
        'Usa retrievalPlan y evidenceBundle primero para preguntas de progresión de score, análisis de desempeño por periodo, diagnóstico de llamadas, evidencia y transcripción.',
      coaching:
        'Usa latestReport.patterns primero, en el orden provisto. Usa progressRollups solo como métricas de apoyo y callSnapshots solo como evidencia.',
      recordatorios:
        'Usa solo reminders. Si un recordatorio no tiene effectiveDueDate, no afirmes que ya venció.',
      ventas: 'Usa salesRollups para totales de ventas y seguimientos.',
      ui: 'Usa uiGlossary solo para explicar conceptos estáticos de KESP.',
    },
    seguimientos: [
      'Para "qué más", "otra cosa" o "siguiente", elige el siguiente punto distinto que no se haya contestado ya en recentChat.',
      'Para "el más importante", "cuál" o "por qué" después de una pregunta de recordatorios, sigue respondiendo sobre recordatorios salvo que el usuario nombre otro tema.',
      'Para pedidos de top N, devuelve exactamente N puntos cuando existan N datos soportados.',
      'No repitas una respuesta anterior salvo que el usuario pida repetirla explícitamente.',
    ],
    formato: [
      'Convierte claves internas como send_whatsapp en etiquetas claras para el usuario.',
      'Usa máximo 3 bloques y máximo 4 items por bloque; para planes largos, agrupa en fases.',
      'El intro debe ser una sola frase directa. No expliques qué fuente usaste salvo que el usuario pida evidencia o fuente explícitamente.',
      'Las métricas son solo para números, fechas, dinero, conteos, scores o valores categóricos muy cortos; nunca pongas recomendaciones largas dentro de un chip.',
      'Usa bloques estructurados concisos; evita relleno.',
    ],
    calidadDeExplicacion: [
      'No hagas feedback circular. Si el usuario pregunta por qué algo fue poco claro, débil, inconsistente, genérico, confuso o malo, no uses esa misma etiqueta como explicación.',
      'Convierte etiquetas del reporte en causas observables: qué orden se mezcló, qué dato faltó, qué decisión no pudo tomar el cliente o qué siguiente paso quedó ausente.',
      'Cuando des “qué decir en vez”, entrega una frase natural que el supervisor pueda copiar y agrega solo una razón corta si ayuda.',
    ],
    recetasDeEntrega: {
      progresionDeScore:
        'Para caídas de score o progresión, compara las fechas/rangos pedidos, identifica el criterio o debilidad que cambió, nombra la llamada responsable cuando exista y cierra con qué coachear primero.',
      desempenoPorPeriodo:
        'Para peor/mejor día, tendencia diaria o patrones que frenan, elige el periodo relevante desde rollups, abre llamadas/rúbrica de ese periodo cuando exista y explica causa + números + llamadas + primera acción de coaching.',
      focoUnicoDeCoaching:
        'Para un foco único con por qué, responde el foco en el intro, usa metrics para evidencia y usa un status para por qué importa. No incluyas un plan de 3 pasos salvo que el usuario pregunte cómo.',
      topNCoaching:
        'Para top N de coaching, usa un bloque steps con exactamente N items. Agrega metrics solo si aclara.',
      recordatorios:
        'Para recordatorios, responde primero el estado abierto/vencido, luego muestra el recordatorio importante y por qué. No cambies a coaching salvo que el usuario cambie de tema.',
      mensajeBorrador:
        'Para preguntas de “qué le digo/envío”, entrega el borrador en un bloque text y usa status solo para contexto faltante.',
      resumenGeneral:
        'Para “cómo va este agente”, muestra metrics primero y un status de foco. Evita explicaciones largas.',
    },
  };
}

function normalizeIntentText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-MX')
    .replace(/[¿?¡!.,;:()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAnyIntentTerm(normalized: string, terms: string[]): boolean {
  return terms.some((term) => normalized.includes(term));
}

/** Checks exact token matches when substring matching would confuse verbs and nouns. */
function includesAnyIntentWord(normalized: string, words: string[]): boolean {
  const tokens = new Set(getIntentTokens(normalized));
  return words.some(
    /** Checks one expected word against the normalized token set. */
    (word) => tokens.has(word)
  );
}

/** Checks whether the normalized message exactly matches a short conversational token. */
function matchesExactIntentTerm(normalized: string, terms: string[]): boolean {
  return terms.includes(normalized);
}

/** Splits normalized intent text into searchable word tokens. */
function getIntentTokens(normalized: string): string[] {
  return normalized.split(' ').filter(Boolean);
}

/** Computes a small edit distance for short intent tokens. */
function getIntentTokenEditDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const distances = Array.from(
    { length: rows },
    /** Creates the dynamic-programming row for one source token position. */
    (_, rowIndex) => Array.from(
      { length: columns },
      /** Creates the initial dynamic-programming column for one target token position. */
      (_, columnIndex) => (rowIndex === 0 ? columnIndex : columnIndex === 0 ? rowIndex : 0)
    )
  );

  for (let rowIndex = 1; rowIndex < rows; rowIndex += 1) {
    for (let columnIndex = 1; columnIndex < columns; columnIndex += 1) {
      const substitutionCost = left[rowIndex - 1] === right[columnIndex - 1] ? 0 : 1;
      distances[rowIndex][columnIndex] = Math.min(
        distances[rowIndex - 1][columnIndex] + 1,
        distances[rowIndex][columnIndex - 1] + 1,
        distances[rowIndex - 1][columnIndex - 1] + substitutionCost
      );
    }
  }
  return distances[left.length][right.length];
}

/** Compares intent tokens with one-character typo tolerance for domain routing. */
function matchesNearIntentToken(token: string, target: string): boolean {
  if (token === target) {
    return true;
  }
  if (Math.min(token.length, target.length) < 3 || Math.max(token.length, target.length) > 14) {
    return false;
  }
  return getIntentTokenEditDistance(token, target) <= 1;
}

/** Checks whether a normalized message contains any exact or near token from a small allow-list. */
function includesAnyNearIntentToken(normalized: string, terms: string[]): boolean {
  const tokens = getIntentTokens(normalized);
  return tokens.some(
    /** Checks one user token against every expected intent token. */
    (token) => terms.some(
      /** Applies typo-tolerant matching to one expected token. */
      (term) => matchesNearIntentToken(token, term)
    )
  );
}

const ASSISTANT_NUMBER_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
};

const ASSISTANT_NUMBER_TOKEN_PATTERN = [
  '[1-9]',
  '1[0-4]',
  'un',
  'una',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
].join('|');

const ASSISTANT_COUNT_NOUN_PATTERN = [
  'recomendaci(?:on|ones)',
  'prioridad(?:es)?',
  'puntos?',
  'acci(?:on|ones)',
  'tips?',
  'consejos?',
  'enfoques?',
  'focos?',
  'areas?',
  'cosas?',
  'ideas?',
  'pasos?',
  'steps?',
  'recommendations?',
  'priorities?',
  'actions?',
  'tips?',
  'ideas?',
  'focus(?:es)?',
  'items?',
  'things?',
].join('|');

/** Parses the small numbers supported by assistant intent extraction. */
function parseAssistantSmallNumber(rawValue: string | undefined): number | undefined {
  const value = rawValue?.trim().toLocaleLowerCase('es-MX') ?? '';
  if (!value) {
    return undefined;
  }
  const digitValue = Number(value);
  if (Number.isInteger(digitValue) && digitValue > 0 && digitValue <= ASSISTANT_MAX_PLAN_DAY_COUNT) {
    return digitValue;
  }
  return ASSISTANT_NUMBER_WORDS[value];
}

/** Extracts a count value from the first capture group in a matched regex. */
function extractAssistantCountMatch(normalized: string, pattern: RegExp): number | undefined {
  const match = normalized.match(pattern);
  return parseAssistantSmallNumber(match?.[1]);
}

/** Detects whether the user is asking for a coaching practice plan. */
function wantsAssistantPlan(normalized: string): boolean {
  const mentionsPlan = includesAnyIntentTerm(normalized, [
    'plan',
    'programa',
    'rutina',
    'calendario',
    'roadmap',
    'schedule',
  ]);
  const mentionsDailyPractice =
    wantsDayByDayAssistantPlan(normalized) &&
    includesAnyIntentTerm(normalized, ['practico', 'practica', 'practicar', 'practice']);
  if (mentionsDailyPractice) {
    return true;
  }
  if (!mentionsPlan) {
    return false;
  }
  if (extractRequestedPlanDays(normalized) || wantsDayByDayAssistantPlan(normalized)) {
    return true;
  }
  return includesAnyIntentTerm(normalized, [
    'bloques',
    'cliente',
    'cierre',
    'corto',
    'hablar',
    'mejora',
    'mejorar',
    'coaching',
    'coach',
    'practica',
    'practicar',
    'entrenamiento',
    'acciones',
    'medible',
    'medibles',
    'muletillas',
    'manana',
    'mañana',
    'validar',
    'ventas',
    'llamadas',
    'improve',
    'improvement',
    'practice',
    'training',
    'calls',
  ]);
}

/** Detects whether the user explicitly wants one item per day. */
function wantsDayByDayAssistantPlan(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    'dia por dia',
    'cada dia',
    'por dia',
    'diario',
    'diaria',
    'day by day',
    'each day',
    'daily',
  ]);
}

/** Extracts an explicit day count for coaching plan requests. */
function extractRequestedPlanDays(normalized: string): number | undefined {
  const dayCount = extractAssistantCountMatch(
    normalized,
    new RegExp(`\\b(${ASSISTANT_NUMBER_TOKEN_PATTERN})\\s+(?:dias?|days?)\\b`)
  );
  if (dayCount) {
    return Math.min(dayCount, ASSISTANT_MAX_PLAN_DAY_COUNT);
  }
  if (includesAnyIntentTerm(normalized, ['semanal', 'semana', 'weekly', 'week'])) {
    return ASSISTANT_DEFAULT_PLAN_DAY_COUNT;
  }
  return undefined;
}

/** Extracts requested item counts without confusing articles like "un plan" for count requests. */
function extractRequestedCount(normalized: string): number | undefined {
  const topCount = extractAssistantCountMatch(
    normalized,
    new RegExp(`\\b(?:top|primer[oa]s?|principales|mejores)\\s+(${ASSISTANT_NUMBER_TOKEN_PATTERN})\\b`)
  );
  if (topCount) {
    return Math.min(topCount, ASSISTANT_MAX_STRUCTURED_ITEMS);
  }

  const nounCount = extractAssistantCountMatch(
    normalized,
    new RegExp(`\\b(${ASSISTANT_NUMBER_TOKEN_PATTERN})(?:\\s+\\w+){0,2}\\s+(?:${ASSISTANT_COUNT_NOUN_PATTERN})\\b`)
  );
  if (nounCount) {
    return Math.min(nounCount, ASSISTANT_MAX_STRUCTURED_ITEMS);
  }

  const soloCount = extractAssistantCountMatch(
    normalized,
    new RegExp(`\\b(?:solo|solamente|exactamente|only|exactly)\\s+(${ASSISTANT_NUMBER_TOKEN_PATTERN})\\s+(?:${ASSISTANT_COUNT_NOUN_PATTERN})\\b`)
  );
  if (soloCount) {
    return Math.min(soloCount, ASSISTANT_MAX_STRUCTURED_ITEMS);
  }

  const singlePriorityTerms = [
    'prioridad principal',
    'foco principal',
    'mas importante',
    'más importante',
    'una sola recomendacion',
    'un solo consejo',
    'one recommendation',
    'single priority',
    'main focus',
    'most important',
    'coachear primero',
    'coaching primero',
    'cambio deberia practicar',
    'practicar hoy',
  ];
  return includesAnyIntentTerm(normalized, singlePriorityTerms) ? 1 : undefined;
}

/** Detects static help and product-navigation questions the server can answer safely. */
function wantsAssistantHelp(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    'hola',
    'ayuda',
    'help',
    'analizador de llamadas',
    'botones',
    'como uso kesp',
    'como usar kesp',
    'como funciona',
    'donde veo llamadas',
    'explica kesp',
    'explica la pantalla',
    'fuentes usas',
    'informacion tienes',
    'pantalla del agente',
    'progreso',
    'que puedes hacer',
    'que puedes responder',
    'que haces',
    'que no puedes hacer',
    'que puedo preguntarte',
    'que significa',
    'para que sirves',
    'como subo',
    'subir',
    'subir llamadas',
    'subo llamadas',
    'upload calls',
  ]);
}

/** Detects simple date, identity, and reformatting questions the server can answer directly. */
function wantsAssistantUtility(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    'ayer que fecha',
    'dia cae',
    'dia fue ayer',
    'dia fue el',
    'dia sera',
    'como te llamas',
    'cual es la fecha actual',
    'cuantos dias faltan',
    'current date',
    'en que semana estamos',
    'en que zona horaria',
    'esta semana es',
    'estas funcionando',
    'fecha fue hace',
    'fecha sera',
    'fecha es hoy',
    'hazlo mas corto',
    'hazlo mas simple',
    'hoy es lunes',
    'misma idea',
    'manana que dia',
    'ponlo en bullets',
    'que dia estamos',
    'que fecha es hoy',
    'que hora es',
    'que mes es',
    'que mes sigue',
    'quien eres',
    'repite',
    'repetir',
    'respuesta anterior',
    'traducelo',
    'version formal',
    'what day is it',
    'what time is it',
  ]);
}

/** Detects short conversational turns that should never depend on the model. */
function wantsAssistantSmallTalk(normalized: string): boolean {
  if (matchesExactIntentTerm(normalized, [
    'entendido',
    'gracias',
    'jaja gracias',
    'listo',
    'muy bien',
    'no',
    'ok',
    'perfecto gracias',
    'probando',
    'si',
    'test',
    'va',
  ])) {
    return true;
  }
  return includesAnyIntentTerm(normalized, [
    'buenas tardes',
    'buenos dias',
    'continuemos',
    'eres util',
    'estas ahi',
    'me ayudas',
    'puedes ayudarme',
  ]);
}

/** Detects broad profile-summary questions that should not depend on model availability. */
function wantsAssistantProfileSummary(normalized: string): boolean {
  const profileEntityMentioned =
    includesAnyIntentTerm(normalized, [
      'este agente',
      'esta agente',
      'agente actual',
      'this agent',
      'the agent',
      'agent',
      'agente',
      'asesor',
      'asesora',
      'vendedor',
      'vendedora',
      'perfil',
      'profile',
    ]) ||
    includesAnyNearIntentToken(normalized, ['agente', 'asesor', 'vendedor', 'agent', 'profile']);
  const asksProfileState =
    includesAnyIntentTerm(normalized, [
      'como le fue',
      'que tal le fue',
      'como va',
      'cómo va',
      'como ves',
      'que opinas',
      'qué opinas',
      'que tan bien',
      'how is he doing',
      'how is she doing',
      'how is this agent doing',
      'how is the agent doing',
      'how is this profile doing',
      'what do you think',
      'honestly',
      'overall',
      'doing well',
      'doing badly',
      'performance',
    ]) ||
    (includesAnyNearIntentToken(normalized, ['como', 'how']) &&
      (includesAnyIntentWord(normalized, ['va', 'ba']) ||
        includesAnyNearIntentToken(normalized, ['doing'])));

  return includesAnyIntentTerm(normalized, [
    'debilidades',
    'debilidad',
    'feedback',
    'fortalezas',
    'fortaleza',
    'falta claridad',
    'grave',
    'haciendo bien',
    'haciendo mal',
    'hizo bien',
    'hizo mal',
    'le fue',
    'oportunidad de mejora',
    'patron aparece',
    'problema principal',
    'proximas llamadas',
    'próximas llamadas',
    'que debo revisar',
    'que esta haciendo',
    'que hizo bien',
    'como va',
    'cómo va',
    'resumen',
    'resume',
    'resumeme',
    'diagnostico',
    'diagnóstico',
    'status',
    'estado',
  ]) || (profileEntityMentioned && asksProfileState);
}

/** Detects coaching questions that ask for a copy-ready phrase or script. */
function wantsAssistantCoachingDraft(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    'antes de cotizar',
    'frase',
    'script',
    'guion',
    'guión',
    'copiar',
    'copiar y pegar',
    'feedback listo',
    'como le explico',
    'sin sonar duro',
    'sin sonar agresivo',
    'pregunta exacta',
    'que digo',
    'que le digo',
    'que puede decir',
    'decir cuando',
    'responder cuando',
    'objecion',
    'objeción',
    'duda',
  ]);
}

/** Detects explanation and evidence requests about call-quality issues. */
function wantsAssistantCoachingEvidence(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    'causa observable',
    'cliente se confunde',
    'con que dato',
    'dato respaldo',
    'evidencia',
    'ejemplo',
    'en que llamadas',
    'en q llamadas',
    'en cuales llamadas',
    'cuales llamadas',
    'explicacion mas profunda',
    'explicame por que',
    'impacto',
    'importa',
    'por que esa',
    'por que el cliente',
    'que comportamiento especifico',
    'que llamada',
    'respaldo',
    'confuso',
    'confusa',
    'poco claro',
    'poco clara',
    'claridad',
    'debil',
    'débil',
    'no entendi',
    'no entendí',
    'simple',
  ]);
}

/** Detects advanced but supported coaching asks that need practice, diagnosis, or supervisor delivery. */
function wantsAssistantCoachingTechnique(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    '15 minutos',
    '5 minutos',
    'abordar',
    'agente se defiende',
    'antes despues',
    'antes y despues',
    'antes/despues',
    'bloques cortos',
    'canal momento',
    'checklist',
    'cerrar',
    'cerrar la llamada',
    'cierra',
    'cierre',
    'cotizacion',
    'cotización',
    'cotizar',
    'deposito',
    'depósito',
    'directa',
    'directo',
    'distingo',
    'entrenar',
    'explicar deposito',
    'explicar monto',
    'frase buena',
    'frase mala',
    'indicador',
    'impacto comercial',
    'justificar',
    'llamada real',
    'mala vs buena',
    'manejar cliente',
    'medir',
    'metrica',
    'métrica',
    'monto y plazo',
    'muletilla',
    'muletillas',
    'necesidad',
    'no debo coachear',
    'no coachear',
    'observacion',
    'observación',
    'practica de',
    'repeticion',
    'repeticiones',
    'resistente',
    'requisito',
    'requisitos',
    'role play',
    'roleplay',
    'rol',
    'senal',
    'señal',
    'senales',
    'señales',
    'sensible',
    'simulacion',
    'simulación',
    'solo tengo',
    'siguiente paso',
    'supervisor',
    'tono',
  ]);
}

/** Detects sales metric questions before reminder terms like "seguimientos" win routing. */
function wantsAssistantSalesSummary(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    'como va en venta',
    'como va en ventas',
    'dinero',
    'loans',
    'loan',
    'venta',
    'ventas',
    'vende',
    'vendiendo',
    'vendieron',
    'vendio',
    'vendió',
    'monto colocado',
    'colocado',
    'coloco',
    'colocó',
    'colocacion',
    'colocación',
    'credito',
    'crédito',
    'creditos',
    'créditos',
    'sales',
    'sales wise',
  ]) || includesAnyNearIntentToken(normalized, [
    'vendio',
    'venta',
    'ventas',
    'coloco',
    'credito',
    'creditos',
    'sales',
  ]);
}

/** Detects manager-style asks about how to coach or interpret the current selling profile. */
function wantsAssistantSupervisorCoachingAction(normalized: string): boolean {
  const mentionsSellingContext =
    includesAnyIntentTerm(normalized, [
      'este agente',
      'esta agente',
      'agente',
      'asesor',
      'asesora',
      'vendedor',
      'vendedora',
      'llamada',
      'llamadas',
      'cliente',
      'clientes',
      'venta',
      'ventas',
      'credito',
      'creditos',
      'profile',
      'agent',
      'rep',
      'call',
      'calls',
      'customer',
      'sales',
      'loan',
    ]) ||
    includesAnyNearIntentToken(normalized, ['agente', 'asesor', 'vendedor', 'llamada', 'cliente']);
  const asksManagerAction =
    includesAnyIntentTerm(normalized, [
      'que harias',
      'q harias',
      'que arias',
      'q arias',
      'que hago',
      'que debo hacer',
      'que deberia hacer',
      'que le digo al agente',
      'que le digo a la agente',
      'que debo decirle',
      'como lo ayudarias',
      'como la ayudarias',
      'what would you do',
      'what should i do',
      'what would you tell',
      'how would you coach',
    ]) ||
    includesAnyIntentTerm(normalized, [
      'que hizo mal',
      'donde se equivoca',
      'en que fallo',
      'que fallo',
      'what went wrong',
      'what did the rep do wrong',
      'what did he do wrong',
      'what did she do wrong',
    ]);
  return mentionsSellingContext && asksManagerAction;
}

/** Detects non-local date or time questions that belong outside KESP Assist's product scope. */
function asksExternalDateTimeFact(normalized: string): boolean {
  if (includesAnyIntentTerm(normalized, ['zona horaria', 'time zone'])) {
    return false;
  }
  if (includesAnyIntentTerm(normalized, [
    'america/mexico_city',
    'cdmx',
    'ciudad de mexico',
    'ciudad de méxico',
    'kesp',
    'local',
    'mexico',
    'méxico',
  ])) {
    return false;
  }

  const asksLocationTime =
    /\b(?:que\s+)?hora(?:\s+actual)?(?:\s+es)?\s+en\s+[a-z]/.test(normalized) ||
    /\ben\s+[a-z][a-z\s]{1,40}\s+que\s+hora\s+es\b/.test(normalized) ||
    /\bwhat\s+time\s+is\s+it\s+in\s+[a-z]/.test(normalized) ||
    /\btime\s+in\s+[a-z]/.test(normalized);
  const asksLocationDate =
    /\b(?:que\s+)?(?:dia|fecha)(?:\s+actual)?(?:\s+es)?\s+en\s+[a-z]/.test(normalized) ||
    /\bwhat\s+(?:day|date)\s+is\s+it\s+in\s+[a-z]/.test(normalized) ||
    /\bcurrent\s+(?:day|date)\s+in\s+[a-z]/.test(normalized);
  return asksLocationTime || asksLocationDate;
}

function detectUnsupportedProfileReason(
  normalized: string,
  previousDomain: AssistantQuestionDomain | undefined
): string | undefined {
  const mentionsCurrentProfile = includesAnyIntentTerm(normalized, [
    'este agente',
    'esta agente',
    'agente actual',
    'asesor',
    'asesora',
    'vendedor',
    'vendedora',
    'llamada',
    'llamadas',
    'kesp',
    'reporte',
    'recordatorio',
    'cliente',
    'clientes',
  ]);
  const mentionsTeamScope = includesAnyIntentTerm(normalized, [
    'agentes',
    'equipo',
    'personal',
    'staff',
    'empleados',
    'colaboradores',
    'todos los agentes',
    'otros agentes',
    'team',
  ]);
  const asksTeamComparison =
    mentionsTeamScope &&
    includesAnyIntentTerm(normalized, ['compara', 'comparar', 'contra', 'versus', 'vs', 'ranking', 'rank']);
  if (asksTeamComparison) {
    return 'team_comparison';
  }

  const mentionsTeamMotivation =
    /\b(mi|nuestro|nuestra|el|la)\s+(personal|equipo|staff|empleados|colaboradores|gente)\b/.test(normalized) &&
    includesAnyIntentTerm(normalized, ['motiv', 'animo', 'desanim', 'moral']);
  if (mentionsTeamMotivation && !mentionsCurrentProfile) {
    return 'team_motivation';
  }

  const mentionsAttendance = includesAnyIntentTerm(normalized, [
    'llegue tarde',
    'llege tarde',
    'llega tarde',
    'llego tarde',
    'llegar tarde',
    'llegando tarde',
    'puntualidad',
    'retraso',
    'retrasarme',
  ]);
  if (mentionsAttendance) {
    return 'attendance';
  }

  if (
    asksExternalDateTimeFact(normalized) ||
    includesAnyIntentTerm(normalized, ['dolar', 'dólar', 'tipo de cambio', 'clima', 'noticias', 'precio hoy'])
  ) {
    return 'external_fact';
  }

  if (includesAnyIntentTerm(normalized, ['chiste', 'joke', 'cuentame algo divertido'])) {
    return 'smalltalk_out_of_scope';
  }

  if (includesAnyIntentTerm(normalized, [
    'asesoria legal',
    'abre google',
    'busca en internet',
    'boletos',
    'calorias',
    'consejos medicos',
    'correo',
    'dime una cancion',
    'gano el partido',
    'hazme una receta',
    'internet',
    'lee mi gmail',
    'plan de viaje',
    'receta',
    'restaurante',
    'restaurantes',
    'song',
    'viaje',
    'viajar',
    'vuelo',
    'vuelos',
  ])) {
    return 'general_out_of_scope';
  }

  if (
    includesAnyIntentTerm(normalized, ['calcula', 'calcular']) ||
    /\b\d+\s*(?:por|\*|x|\+|-|entre|\/)\s*\d+\b/.test(normalized)
  ) {
    return 'calculation';
  }

  const asksToCreateReminder =
    includesAnyIntentTerm(normalized, ['crea', 'crear', 'agendar', 'programa', 'programar']) &&
    includesAnyIntentTerm(normalized, ['recordatorio', 'recordatorios', 'reminder']);
  if (asksToCreateReminder) {
    return 'write_action';
  }

  const asksUnsupportedWriteAction =
    includesAnyIntentWord(normalized, [
      'agenda',
      'agendar',
      'abre',
      'abrir',
      'borra',
      'borrar',
      'cambia',
      'cambiar',
      'comparte',
      'compartir',
      'descarga',
      'descargar',
      'elimina',
      'eliminar',
      'exporta',
      'exportar',
      'llama',
      'llamar',
      'marca',
      'marcar',
      'programa',
      'programar',
      'sube',
      'subir',
    ]) &&
    includesAnyIntentTerm(normalized, [
      'audio',
      'cliente',
      'historial',
      'informacion',
      'información',
      'llamada',
      'llamadas',
      'recordatorio',
      'pendiente',
      'pendientes',
      'resuelto',
      'resueltos',
      'score',
      'seguimiento',
      'usuario',
      'whatsapp',
      'web',
    ]);
  if (
    asksUnsupportedWriteAction &&
    !wantsAssistantPlan(normalized) &&
    !wantsAssistantCoachingDraft(normalized) &&
    !wantsAssistantCoachingEvidence(normalized) &&
    !wantsAssistantCoachingTechnique(normalized) &&
    !includesAnyIntentTerm(normalized, ['mejorar', 'mejora', 'coaching', 'coach', 'practica', 'practicar', 'entrenamiento']) &&
    !includesAnyIntentTerm(normalized, ['como subo', 'subir llamadas', 'subo llamadas'])
  ) {
    return 'write_action';
  }

  const asksToSendMessage =
    includesAnyIntentTerm(normalized, ['manda tu', 'envia tu', 'envía tu', 'mandalo', 'mándalo', 'send it']) ||
    (includesAnyIntentTerm(normalized, ['manda', 'envia', 'envía', 'send']) &&
      includesAnyIntentTerm(normalized, ['whatsapp', 'mensaje']) &&
      !includesAnyIntentTerm(normalized, ['que mensaje', 'que le digo', 'borrador']));
  if (asksToSendMessage) {
    return 'send_action';
  }

  if (includesAnyIntentTerm(normalized, [
    'audio',
    'datos personales',
    'todos los datos',
    'telefono',
    'teléfono',
    'direccion',
    'dirección',
    'curp',
    'rfc',
  ])) {
    return 'private_data';
  }

  const isGenericRecommendation = includesAnyIntentTerm(normalized, [
    'que hago',
    'que deberia hacer',
    'que recomiendas',
    'recomiendas que haga',
    'what should i do',
    'what do you recommend',
  ]);
  if (previousDomain === 'out_of_scope' && isGenericRecommendation && !mentionsCurrentProfile) {
    return 'previous_out_of_scope';
  }

  return undefined;
}

function inferAssistantQuestionDomain(normalized: string): AssistantQuestionDomain {
  if (
    wantsAssistantUtility(normalized) ||
    wantsAssistantSmallTalk(normalized) ||
    wantsAssistantHelp(normalized) ||
    includesAnyIntentTerm(normalized, ['reporte de patrones', 'que es reporte', 'what is pattern report'])
  ) {
    return 'ui';
  }
  if (
    wantsAssistantSalesSummary(normalized) &&
    !wantsAssistantPlan(normalized) &&
    !wantsAssistantCoachingDraft(normalized) &&
    !wantsAssistantCoachingEvidence(normalized) &&
    !wantsAssistantCoachingTechnique(normalized) &&
    !wantsAssistantSupervisorCoachingAction(normalized)
  ) {
    return 'sales';
  }
  if (wantsAssistantScoreProgression(normalized)) {
    return 'score_progression';
  }
  if (wantsAssistantPerformancePeriodAnalysis(normalized)) {
    return 'performance_analysis';
  }
  if (
    wantsAssistantProfileSummary(normalized) ||
    wantsAssistantCoachingDraft(normalized) ||
    wantsAssistantCoachingEvidence(normalized) ||
    wantsAssistantCoachingTechnique(normalized) ||
    wantsAssistantSupervisorCoachingAction(normalized)
  ) {
    return 'coaching';
  }
  if (includesAnyIntentTerm(normalized, [
    'recordatorio',
    'recordatorios',
    'accion sigue',
    'acción sigue',
    'hacer manana',
    'hacer mañana',
    'pendiente',
    'pendientes',
    'recuperar',
    'requisitos',
    'vencido',
    'vencidos',
    'urgente',
    'urgentes',
    'whatsapp',
    'mensaje',
    'mensajes',
    'llamo',
    'llame',
    'llamar',
    'contacto',
    'contactar',
    'mando requisitos',
    'seguimiento',
    'follow up',
    'reminder',
  ])) {
    return 'reminders';
  }
  if (wantsAssistantPlan(normalized)) {
    return 'coaching';
  }
  if (includesAnyIntentTerm(normalized, [
    'coaching',
    'coach',
    'coachear',
    'recomienda',
    'recomiendas',
    'recomendacion',
    'recomendaciones',
    'deberia',
    'mejorar',
    'mejora',
    'prioridad',
    'prioridades',
    'enfoco',
    'enfocar',
    'hacer',
    'cambiar',
    'practica',
    'practico',
    'practicar',
    'entrenamiento',
    'focus',
    'mal en las llamadas',
    'bien este vendedor',
    'recommend',
    'improve',
    'practice',
    'training',
  ])) {
    return 'coaching';
  }
  return 'unknown';
}

function isAmbiguousAssistantFollowUp(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    'que mas',
    'que otra',
    'que otras',
    'otra cosa',
    'otras cosas',
    'otro',
    'otros',
    'diferente',
    'diferentes',
    'otra',
    'otro',
    'siguiente',
    'primero',
    'cual',
    'explica',
    'explicame',
    'detalle',
    'detalla',
    'a fondo',
    'profundiza',
    'comparado',
    'que sigue',
    'despues',
    'después',
    'dime',
    'dimelo',
    'luego',
    'entonces',
    'tonces',
    'tons',
    'eso',
    'hazlo',
    'mas especifico',
    'más específico',
    'mido',
    'monto',
    'mandale',
    'mándale',
    'mandamelo',
    'mandame',
    'pasamelo',
    'pasame',
    'vence',
    'vencido',
    'bueno o malo',
    'ok y',
    'por que',
    'y eso',
    'what else',
    'another',
    'next',
    'which one',
    'explain',
    'tell me',
    'show me',
    'go ahead',
    'more detail',
    'why',
  ]);
}

/** Detects short affirmative replies that should continue the previous supported assistant topic. */
function isAffirmativeAssistantFollowUp(normalized: string): boolean {
  return /^(?:si+|sip|sipi|simon|yes|yep|yeah|claro|dale|va|ok|okay)(?:\s+(?:por\s+favor|porfavor|porfa|xfa|please|claro|dale|va|dime|dimelo|cuentame|explicame|muestrame|tell\s+me|show\s+me|go\s+ahead))*$/.test(normalized) ||
    matchesExactIntentTerm(normalized, [
      'dime',
      'dimelo',
      'cuentame',
      'explicame',
      'muestrame',
      'por favor',
      'porfavor',
      'porfa',
      'please',
      'go ahead',
      'do it',
      'hazlo',
      'mandamelo',
      'mandame',
      'pasamelo',
      'pasame',
      'tell me',
      'show me',
    ]);
}

/** Flattens an assistant message into text that can be used only for topic inheritance. */
function getAssistantMessageIntentText(message: AgentProfileAssistantChatMessage): string {
  const structuredTexts = message.structuredContent?.blocks.flatMap(
    /** Extracts compact searchable text from one assistant structured block. */
    (block) => {
      if (block.type === 'metrics') {
        return block.items.flatMap(
          /** Extracts metric labels and values for topic inheritance. */
          (item) => [item.label, item.value]
        );
      }
      if (block.type === 'steps') {
        return block.items.flatMap(
          /** Extracts step titles and bodies for topic inheritance. */
          (item) => [item.title, item.body]
        );
      }
      if (block.type === 'comparison') {
        return block.rows.flatMap(
          /** Extracts comparison labels and values for topic inheritance. */
          (row) => [row.label, row.left, row.right]
        );
      }
      if (block.type === 'status') {
        return [block.label, block.detail ?? ''];
      }
      return [block.text];
    }
  ) ?? [];
  const referenceTexts = message.references?.map(
    /** Extracts reference labels for topic inheritance. */
    (reference) => reference.label
  ) ?? [];
  return [message.content, message.structuredContent?.intro, message.structuredContent?.outro, ...structuredTexts, ...referenceTexts]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');
}

/** Infers the topic an assistant answer just offered so short replies can continue it. */
function inferPreviousAssistantResponseDomain(message: AgentProfileAssistantChatMessage | undefined): AssistantQuestionDomain | undefined {
  if (!message) {
    return undefined;
  }
  const normalized = normalizeIntentText(getAssistantMessageIntentText(message));
  if (
    !normalized ||
    includesAnyIntentTerm(normalized, [
      'no puedo responder esa informacion',
      'informacion no disponible',
      'i cannot answer that information',
      'information unavailable',
    ])
  ) {
    return undefined;
  }
  if (
    !message.references?.length &&
    includesAnyIntentTerm(normalized, [
      'temas disponibles',
      'available topics',
      'preguntame por este perfil',
      'ask me about this profile',
    ])
  ) {
    return undefined;
  }
  if (message.references?.some(
    /** Checks whether the assistant referenced a coaching report. */
    (reference) => reference.type === 'report'
  )) {
    return 'coaching';
  }
  if (message.references?.some(
    /** Checks whether the assistant referenced a reminder. */
    (reference) => reference.type === 'reminder'
  )) {
    return 'reminders';
  }
  if (message.references?.some(
    /** Checks whether the assistant referenced a sales rollup. */
    (reference) => reference.type === 'sales_rollup'
  )) {
    return 'sales';
  }
  if (includesAnyIntentTerm(normalized, [
    'practicar',
    'practica',
    'trabajarlo',
    'foco',
    'coaching',
    'patron',
    'propuesta de valor',
    'llamada',
    'llamadas',
    'beneficio',
    'roleplay',
    'practice',
    'coach',
    'focus',
  ])) {
    return 'coaching';
  }
  if (includesAnyIntentTerm(normalized, ['recordatorio', 'pendiente', 'whatsapp', 'reminder', 'follow up'])) {
    return 'reminders';
  }
  if (includesAnyIntentTerm(normalized, ['venta', 'ventas', 'credito', 'creditos', 'sales', 'loan', 'loans'])) {
    return 'sales';
  }
  return undefined;
}

/** Infers the concrete next step the assistant offered so a short yes can answer that offer. */
function inferPreviousAssistantFollowUpAction(message: AgentProfileAssistantChatMessage | undefined): AssistantFollowUpAction | undefined {
  if (!message) {
    return undefined;
  }
  const normalized = normalizeIntentText(getAssistantMessageIntentText(message));
  if (
    !normalized ||
    includesAnyIntentTerm(normalized, [
      'no puedo responder esa informacion',
      'informacion no disponible',
      'i cannot answer that information',
      'information unavailable',
    ])
  ) {
    return undefined;
  }

  if (includesAnyIntentTerm(normalized, [
    'que frase usar',
    'frase usar',
    'frase exacta',
    'frase lista',
    'frase para',
    'te doy una frase',
    'te paso una frase',
    'que decir',
    'que digo',
    'que le digo',
    'guion',
    'script',
    'aterrizar mejor',
    'copy ready',
  ])) {
    return 'coaching_draft';
  }
  if (includesAnyIntentTerm(normalized, [
    'como practicar',
    'practicar ese foco',
    'forma concreta de trabajarlo',
    'trabajarlo en llamada',
    'trabajarlo',
    'practica observable',
    'roleplay',
    'practice this',
    'practice it',
  ])) {
    return 'coaching_practice';
  }
  if (includesAnyIntentTerm(normalized, [
    'por que importa',
    'por que',
    'porque',
    'evidencia',
    'causa observable',
    'why it matters',
    'why',
  ])) {
    return 'coaching_evidence';
  }
  if (includesAnyIntentTerm(normalized, [
    'borrador',
    'mensaje de whatsapp',
    'que mensaje',
    'draft the message',
    'draft message',
  ])) {
    return 'reminder_draft';
  }
  return undefined;
}

function wantsDistinctAssistantAnswer(normalized: string): boolean {
  return includesAnyIntentTerm(normalized, [
    'que mas',
    'que otra',
    'que otras',
    'otra',
    'otra cosa',
    'otras cosas',
    'otro',
    'otros',
    'diferente',
    'diferentes',
    'siguiente',
    'que sigue',
    'despues',
    'después',
    'what else',
    'another',
    'different',
    'next',
  ]);
}

export function buildAssistantQuestionIntent(params: {
  language: AgentProfileAssistantLanguage;
  question: string;
  recentMessages: AgentProfileAssistantChatMessage[];
}): AssistantQuestionIntent {
  const normalized = normalizeIntentText(params.question);
  const previousUserMessage = [...params.recentMessages]
    .reverse()
    .find((message) => message.role === 'user');
  const previousAssistantMessages = [...params.recentMessages]
    .reverse()
    .filter(
      /** Keeps assistant turns as candidates for inheriting the active topic. */
      (message) => message.role === 'assistant'
    );
  const previousNormalized = previousUserMessage ? normalizeIntentText(previousUserMessage.content) : '';
  const previousUnsupportedReason = previousNormalized
    ? detectUnsupportedProfileReason(previousNormalized, undefined)
    : undefined;
  const previousDomain = previousUnsupportedReason
    ? 'out_of_scope'
    : previousNormalized
      ? inferAssistantQuestionDomain(previousNormalized)
      : undefined;
  const previousAssistantDomain = previousAssistantMessages
    .map(
      /** Infers a topic from the most recent useful assistant turns. */
      (message) => inferPreviousAssistantResponseDomain(message)
    )
    .find(
      /** Keeps the first available inherited assistant topic. */
      (domain): domain is AssistantQuestionDomain => Boolean(domain)
    );
  const previousAssistantFollowUpAction = previousAssistantMessages
    .map(
      /** Infers the concrete follow-up offer from recent assistant turns. */
      (message) => inferPreviousAssistantFollowUpAction(message)
    )
    .find(
      /** Keeps the first available inherited follow-up action. */
      (action): action is AssistantFollowUpAction => Boolean(action)
    );
  const explicitUnsupportedReason = detectUnsupportedProfileReason(normalized, previousDomain);
  const affirmativeFollowUp = isAffirmativeAssistantFollowUp(normalized);
  const ambiguousFollowUp = affirmativeFollowUp || isAmbiguousAssistantFollowUp(normalized);
  const rawDomain = inferAssistantQuestionDomain(normalized);
  const contextDomain = ambiguousFollowUp
    ? previousAssistantDomain ?? previousDomain
    : previousDomain;
  const inheritedDomain =
    (rawDomain === 'unknown' || (affirmativeFollowUp && rawDomain === 'ui')) &&
    ambiguousFollowUp &&
    isAssistantInheritableDomain(contextDomain)
      ? contextDomain
      : undefined;
  const unsupportedReason = explicitUnsupportedReason;
  const domain = unsupportedReason ? 'out_of_scope' : inheritedDomain ?? rawDomain;
  const wantsPlan = domain === 'coaching' && wantsAssistantPlan(normalized);
  const requestedPlanDays = wantsPlan ? extractRequestedPlanDays(normalized) : undefined;
  const wantsDayByDayPlan = wantsPlan && wantsDayByDayAssistantPlan(normalized);
  const requestedCount = extractRequestedCount(normalized);
  const wantsDistinctFromRecent = wantsDistinctAssistantAnswer(normalized);
  const inheritedFollowUpAction = affirmativeFollowUp ? previousAssistantFollowUpAction : undefined;
  const supported = domain !== 'out_of_scope';

  return {
    domain,
    supported,
    ...(requestedCount ? { requestedCount } : {}),
    ...(requestedPlanDays ? { requestedPlanDays } : {}),
    wantsPlan,
    wantsDayByDayPlan,
    wantsDistinctFromRecent,
    ambiguousFollowUp,
    affirmativeFollowUp,
    ...(inheritedDomain ? { inheritedDomain } : {}),
    ...(inheritedFollowUpAction ? { inheritedFollowUpAction } : {}),
    ...(unsupportedReason ? { unsupportedReason } : {}),
    instruction: tAssistantLabel(
      params.language,
      supported && domain === 'unknown'
        ? 'La pregunta no coincide con un dominio determinista. Respóndela como una pregunta del perfil actual usando solo el contexto disponible; si no hay datos suficientes, dilo sin cerrar la conversación.'
        : supported
          ? 'Responde solo dentro del dominio detectado. Respeta requestedCount si existe y no repitas recomendaciones recientes si wantsDistinctFromRecent=true.'
        : 'No respondas con coaching genérico. Di que no puedes responder esa información con los datos del perfil actual y ofrece hablar de coaching, recordatorios, ventas o el reporte de patrones.',
      supported && domain === 'unknown'
        ? 'The question does not match a deterministic domain. Answer it as a current-profile question using only the available context; if there is not enough data, say so without ending the conversation.'
        : supported
          ? 'Answer only inside the detected domain. Respect requestedCount when present and avoid repeating recent recommendations when wantsDistinctFromRecent=true.'
        : 'Do not answer with generic coaching. Say you cannot answer that information from the current profile data and offer to discuss coaching, reminders, sales, or the pattern report.'
    ),
  };
}

function buildUnsupportedAssistantResponse(
  language: AgentProfileAssistantLanguage
): AssistantModelJsonOutput {
  const intro = tAssistantLabel(
    language,
    'No puedo responder esa información con los datos de este perfil.',
    'I cannot answer that information from this profile data.'
  );
  const detail = tAssistantLabel(
    language,
    'Puedo ayudarte con coaching del agente, recordatorios, ventas o el reporte de patrones.',
    'I can help with this agent’s coaching, reminders, sales, or pattern report.'
  );
  const outro = tAssistantLabel(
    language,
    '¿Quieres hablar de alguno de esos temas?',
    'Would you like to talk about one of those topics?'
  );
  const structuredContent: AgentProfileAssistantStructuredContent = {
    intro,
    blocks: [{ type: 'status', label: tAssistantLabel(language, 'Información no disponible', 'Information unavailable'), tone: 'warning', detail }],
    outro,
  };
  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    structuredContent,
    references: [],
  };
}

/** Formats the assistant business date as a user-facing phrase. */
function formatAssistantBusinessDateDisplay(
  language: AgentProfileAssistantLanguage,
  dayOffset = 0
): string {
  const date = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'es-MX', {
    timeZone: ASSISTANT_CONTEXT_TIME_ZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

/** Formats the current time for a concrete IANA timezone. */
function formatAssistantTimeInZoneDisplay(
  language: AgentProfileAssistantLanguage,
  timeZone: string
): string {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'es-MX', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

/** Formats the assistant business time in KESP's operating timezone. */
function formatAssistantBusinessTimeDisplay(language: AgentProfileAssistantLanguage): string {
  return formatAssistantTimeInZoneDisplay(language, ASSISTANT_CONTEXT_TIME_ZONE);
}

/** Calculates the ISO week number for the current assistant business date. */
function getAssistantBusinessIsoWeek(): number {
  const [year, month, day] = getAssistantBusinessDate().split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNumber = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/** Returns the current weekday index in KESP's operating timezone. */
function getAssistantBusinessWeekdayIndex(): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: ASSISTANT_CONTEXT_TIME_ZONE,
    weekday: 'long',
  }).format(new Date()).toLocaleLowerCase('en-US');
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(weekday);
}

/** Extracts relative date offsets such as "hace 3 días" or "en 5 días". */
function extractAssistantRelativeDayOffset(normalized: string): number | null {
  const pastMatch = normalized.match(new RegExp(`\\bhace\\s+(${ASSISTANT_NUMBER_TOKEN_PATTERN})\\s+dias?\\b`));
  const pastValue = parseAssistantSmallNumber(pastMatch?.[1]);
  if (pastValue) {
    return -pastValue;
  }
  const futureMatch = normalized.match(new RegExp(`\\ben\\s+(${ASSISTANT_NUMBER_TOKEN_PATTERN})\\s+dias?\\b`));
  const futureValue = parseAssistantSmallNumber(futureMatch?.[1]);
  if (futureValue) {
    return futureValue;
  }
  return null;
}

/** Builds a simple deterministic date response for one relative day offset. */
function buildAssistantRelativeDateResponse(
  language: AgentProfileAssistantLanguage,
  dayOffset: number
): AssistantModelJsonOutput {
  const intro = dayOffset === 0
    ? tAssistantLabel(language, `Hoy es ${formatAssistantBusinessDateDisplay(language)}.`, `Today is ${formatAssistantBusinessDateDisplay(language)}.`)
    : dayOffset > 0
      ? tAssistantLabel(language, `En ${dayOffset} día(s) será ${formatAssistantBusinessDateDisplay(language, dayOffset)}.`, `In ${dayOffset} day(s), it will be ${formatAssistantBusinessDateDisplay(language, dayOffset)}.`)
      : tAssistantLabel(language, `Hace ${Math.abs(dayOffset)} día(s) fue ${formatAssistantBusinessDateDisplay(language, dayOffset)}.`, `${Math.abs(dayOffset)} day(s) ago was ${formatAssistantBusinessDateDisplay(language, dayOffset)}.`);
  const structuredContent: AgentProfileAssistantStructuredContent = {
    intro,
    blocks: [{ type: 'status', label: 'Zona horaria', tone: 'neutral', detail: ASSISTANT_CONTEXT_TIME_ZONE }],
  };
  return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
}

/** Computes the date offset for a requested weekday relative to the current KESP business day. */
function getAssistantWeekdayDateOffset(normalized: string, targetWeekdayIndex: number): number {
  const currentIndex = getAssistantBusinessWeekdayIndex();
  const forward = (targetWeekdayIndex - currentIndex + 7) % 7;
  const backward = (currentIndex - targetWeekdayIndex + 7) % 7;
  if (includesAnyIntentTerm(normalized, ['pasado', 'last'])) {
    return -(backward || 7);
  }
  if (includesAnyIntentTerm(normalized, ['proximo', 'próximo', 'next'])) {
    return forward || 7;
  }
  return forward;
}

/** Builds a deterministic response for weekday date questions. */
function buildAssistantWeekdayDateResponse(
  language: AgentProfileAssistantLanguage,
  normalized: string,
  targetWeekday: { label: string; index: number }
): AssistantModelJsonOutput {
  const offset = getAssistantWeekdayDateOffset(normalized, targetWeekday.index);
  const prefix = offset < 0
    ? tAssistantLabel(language, `El ${targetWeekday.label} pasado fue`, `Last ${targetWeekday.label} was`)
    : offset === 0
      ? tAssistantLabel(language, `El ${targetWeekday.label} es hoy:`, `${targetWeekday.label} is today:`)
      : tAssistantLabel(language, `El próximo ${targetWeekday.label} será`, `The next ${targetWeekday.label} will be`);
  const structuredContent: AgentProfileAssistantStructuredContent = {
    intro: `${prefix} ${formatAssistantBusinessDateDisplay(language, offset)}.`,
    blocks: [{ type: 'status', label: 'Zona horaria', tone: 'neutral', detail: ASSISTANT_CONTEXT_TIME_ZONE }],
  };
  return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
}

/** Builds a deterministic next-month response in KESP's business timezone. */
function buildAssistantNextMonthResponse(language: AgentProfileAssistantLanguage): AssistantModelJsonOutput {
  const [year, month] = getAssistantBusinessDate().split('-').map(Number);
  const date = new Date(Date.UTC(year, month, 1));
  const monthName = new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'es-MX', {
    timeZone: ASSISTANT_CONTEXT_TIME_ZONE,
    month: 'long',
    year: 'numeric',
  }).format(date);
  const structuredContent: AgentProfileAssistantStructuredContent = {
    intro: tAssistantLabel(language, `El mes que sigue es ${monthName}.`, `The next month is ${monthName}.`),
    blocks: [{ type: 'status', label: 'Zona horaria', tone: 'neutral', detail: ASSISTANT_CONTEXT_TIME_ZONE }],
  };
  return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
}

/** Extracts a weekday target from a normalized Spanish or English question. */
function extractAssistantTargetWeekday(normalized: string): { label: string; index: number } | null {
  const weekdays = [
    { label: 'domingo', index: 0, terms: ['domingo', 'sunday'] },
    { label: 'lunes', index: 1, terms: ['lunes', 'monday'] },
    { label: 'martes', index: 2, terms: ['martes', 'tuesday'] },
    { label: 'miércoles', index: 3, terms: ['miercoles', 'wednesday'] },
    { label: 'jueves', index: 4, terms: ['jueves', 'thursday'] },
    { label: 'viernes', index: 5, terms: ['viernes', 'friday'] },
    { label: 'sábado', index: 6, terms: ['sabado', 'saturday'] },
  ];
  return weekdays.find(
    /** Handles the callback for this operation. */
    (weekday) => includesAnyIntentTerm(normalized, weekday.terms)
  ) ?? null;
}

/** Finds the latest assistant turn in recent chat history. */
function findLatestAssistantMessage(
  recentMessages: AgentProfileAssistantChatMessage[]
): AgentProfileAssistantChatMessage | undefined {
  return [...recentMessages].reverse().find(
    /** Handles the callback for this operation. */
    (message) => message.role === 'assistant'
  );
}

/** Builds a concise text from the previous assistant answer for repeat or reformat requests. */
function summarizePreviousAssistantText(message: AgentProfileAssistantChatMessage | undefined): string | null {
  const raw = message?.content.trim();
  if (!raw) {
    return null;
  }
  const firstLine = raw.split('\n').find(
    /** Handles the callback for this operation. */
    (line) => line.trim().length > 0
  );
  return sanitizeStructuredString(firstLine || raw, 500) || null;
}

/** Builds a deterministic response for date, identity, and reformatting utility questions. */
function buildDeterministicUtilityResponse(params: {
  language: AgentProfileAssistantLanguage;
  question: string;
  recentMessages: AgentProfileAssistantChatMessage[];
}): AssistantModelJsonOutput | null {
  const normalized = normalizeIntentText(params.question);
  if (!wantsAssistantUtility(normalized)) {
    return null;
  }

  const asksTime = includesAnyIntentTerm(normalized, ['hora', 'what time']);
  const targetWeekday = extractAssistantTargetWeekday(normalized);
  const asksDaysUntil = includesAnyIntentTerm(normalized, ['cuantos dias faltan', 'how many days until']);
  const asksTodayIs = includesAnyIntentTerm(normalized, ['hoy es', 'is today']);
  const asksWeekdayDate = includesAnyIntentTerm(normalized, ['dia cae', 'dia fue el', 'fecha sera el', 'proximo', 'próximo', 'pasado']);
  if (targetWeekday && (asksDaysUntil || asksTodayIs)) {
    const currentIndex = getAssistantBusinessWeekdayIndex();
    const delta = (targetWeekday.index - currentIndex + 7) % 7;
    const intro = asksTodayIs
      ? tAssistantLabel(
          params.language,
          delta === 0 ? `Sí, hoy es ${targetWeekday.label}.` : `No, hoy no es ${targetWeekday.label}.`,
          delta === 0 ? `Yes, today is ${targetWeekday.label}.` : `No, today is not ${targetWeekday.label}.`
        )
      : tAssistantLabel(
          params.language,
          `Faltan ${delta} día(s) para ${targetWeekday.label}.`,
          `There are ${delta} day(s) until ${targetWeekday.label}.`
        );
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro,
      blocks: [{
        type: 'status',
        label: ASSISTANT_CONTEXT_TIME_ZONE,
        tone: 'neutral',
        detail: formatAssistantBusinessDateDisplay(params.language),
      }],
    };
    return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
  }
  if (targetWeekday && asksWeekdayDate) {
    return buildAssistantWeekdayDateResponse(params.language, normalized, targetWeekday);
  }

  const relativeDayOffset = extractAssistantRelativeDayOffset(normalized);
  if (relativeDayOffset !== null) {
    return buildAssistantRelativeDateResponse(params.language, relativeDayOffset);
  }

  if (includesAnyIntentTerm(normalized, ['zona horaria'])) {
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro: tAssistantLabel(
        params.language,
        `Uso la zona horaria ${ASSISTANT_CONTEXT_TIME_ZONE}.`,
        `I use the ${ASSISTANT_CONTEXT_TIME_ZONE} timezone.`
      ),
      blocks: [{ type: 'status', label: 'Fecha actual', tone: 'neutral', detail: formatAssistantBusinessDateDisplay(params.language) }],
    };
    return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
  }

  if (asksTime) {
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro: tAssistantLabel(
        params.language,
        `La hora de referencia es ${formatAssistantBusinessTimeDisplay(params.language)}.`,
        `The reference time is ${formatAssistantBusinessTimeDisplay(params.language)}.`
      ),
      blocks: [{ type: 'status', label: 'Zona horaria', tone: 'neutral', detail: ASSISTANT_CONTEXT_TIME_ZONE }],
    };
    return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
  }

  if (includesAnyIntentTerm(normalized, ['semana estamos'])) {
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro: tAssistantLabel(
        params.language,
        `Estamos en la semana ISO ${getAssistantBusinessIsoWeek()}.`,
        `We are in ISO week ${getAssistantBusinessIsoWeek()}.`
      ),
      blocks: [{ type: 'status', label: 'Fecha actual', tone: 'neutral', detail: formatAssistantBusinessDateDisplay(params.language) }],
    };
    return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
  }

  if (includesAnyIntentTerm(normalized, ['esta semana']) && /\b\d+\b/.test(normalized)) {
    const askedWeek = Number(normalized.match(/\b\d+\b/)?.[0]);
    const currentWeek = getAssistantBusinessIsoWeek();
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro: tAssistantLabel(
        params.language,
        askedWeek === currentWeek ? `Sí, esta es la semana ISO ${currentWeek}.` : `No, esta es la semana ISO ${currentWeek}.`,
        askedWeek === currentWeek ? `Yes, this is ISO week ${currentWeek}.` : `No, this is ISO week ${currentWeek}.`
      ),
      blocks: [{ type: 'status', label: 'Fecha actual', tone: 'neutral', detail: formatAssistantBusinessDateDisplay(params.language) }],
    };
    return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
  }

  if (includesAnyIntentTerm(normalized, ['que mes sigue'])) {
    return buildAssistantNextMonthResponse(params.language);
  }

  if (includesAnyIntentTerm(normalized, ['fecha', 'que dia estamos', 'manana que dia', 'dia sera manana', 'ayer que fecha', 'dia fue ayer', 'que mes es', 'current date', 'what day'])) {
    const offset = includesAnyIntentTerm(normalized, ['manana']) ? 1 : includesAnyIntentTerm(normalized, ['ayer']) ? -1 : 0;
    return buildAssistantRelativeDateResponse(params.language, offset);
  }

  if (includesAnyIntentTerm(normalized, ['quien eres', 'como te llamas', 'estas funcionando'])) {
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro: tAssistantLabel(
        params.language,
        'Soy KESP Assist y estoy funcionando para este perfil.',
        'I am KESP Assist and I am running for this profile.'
      ),
      blocks: [{
        type: 'status',
        label: tAssistantLabel(params.language, 'Alcance', 'Scope'),
        tone: 'good',
        detail: tAssistantLabel(
          params.language,
          'Respondo sobre coaching, recordatorios, ventas y conceptos de KESP con los datos disponibles.',
          'I answer about coaching, reminders, sales, and KESP concepts with the available data.'
        ),
      }],
    };
    return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
  }

  const previousText = summarizePreviousAssistantText(findLatestAssistantMessage(params.recentMessages));
  if (previousText) {
    const wantsBullets = includesAnyIntentTerm(normalized, ['bullets', 'viñetas', 'vinitas']);
    const wantsFormal = includesAnyIntentTerm(normalized, ['formal']);
    const text = wantsBullets
      ? previousText.split(/[.;]\s+/).filter(
          /** Handles the callback for this operation. */
          (line) => line.trim().length > 0
        ).slice(0, 3).map(
          /** Handles the callback for this operation. */
          (line) => `- ${line.trim()}`
        ).join('\n')
      : wantsFormal
        ? tAssistantLabel(
            params.language,
            `De manera formal: ${previousText}`,
            `Formally: ${previousText}`
          )
      : previousText;
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro: tAssistantLabel(
        params.language,
        'Claro, aquí va una versión directa de la respuesta anterior.',
        'Sure, here is a direct version of the previous answer.'
      ),
      blocks: [{ type: 'text', text }],
    };
    return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
  }

  const structuredContent: AgentProfileAssistantStructuredContent = {
    intro: tAssistantLabel(
      params.language,
      'Puedo ayudarte, pero necesito una respuesta previa o un fragmento específico para reformularlo.',
      'I can help, but I need a previous answer or a specific fragment to reformat it.'
    ),
    blocks: [{ type: 'status', label: tAssistantLabel(params.language, 'Falta contexto', 'Missing context'), tone: 'warning' }],
  };
  return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
}

/** Builds a deterministic response for short acknowledgements and simple greetings. */
function buildDeterministicSmallTalkResponse(params: {
  language: AgentProfileAssistantLanguage;
  question: string;
}): AssistantModelJsonOutput | null {
  const normalized = normalizeIntentText(params.question);
  if (!wantsAssistantSmallTalk(normalized)) {
    return null;
  }
  const structuredContent: AgentProfileAssistantStructuredContent = {
    intro: tAssistantLabel(
      params.language,
      'Listo. Cuando quieras, pregúntame por este perfil.',
      'Ready. Whenever you want, ask me about this profile.'
    ),
    blocks: [{
      type: 'status',
      label: tAssistantLabel(params.language, 'Temas disponibles', 'Available topics'),
      tone: 'good',
      detail: tAssistantLabel(
        params.language,
        'Coaching, score/progresión, llamadas, recordatorios, ventas y reporte de patrones.',
        'Coaching, score/progression, calls, reminders, sales, and pattern report.'
      ),
    }],
  };
  return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
}

/** Returns the most recent progress rollup available in loaded context. */
function getLatestProgressRollup(
  context: LoadedAgentProfileAssistantContext
): NormalizedProgressRollupContext | null {
  return context.progressRollups[0] ?? null;
}

/** Returns the most recent sales rollup available in loaded context. */
function getLatestSalesRollup(
  context: LoadedAgentProfileAssistantContext
): NormalizedSalesRollupContext | null {
  return context.salesRollups[0] ?? null;
}

/** Formats a Consubanco money amount for assistant metric chips. */
function formatAssistantMxnAmount(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  return `$${Math.round(value).toLocaleString('es-MX')} MXN`;
}

/** Returns open reminders in the same priority order used by the context loader. */
function getOpenAssistantReminders(
  context: LoadedAgentProfileAssistantContext
): NormalizedReminderContext[] {
  return context.reminders.filter(
    /** Handles the callback for this operation. */
    (reminder) => reminder.state === 'open'
  );
}

/** Formats the due information of a reminder without inventing missing fields. */
function formatAssistantReminderDue(
  language: AgentProfileAssistantLanguage,
  reminder: NormalizedReminderContext
): string {
  if (reminder.effectiveDueDate && reminder.effectiveDueTime) {
    return tAssistantLabel(
      language,
      `${reminder.effectiveDueDate} ${reminder.effectiveDueTime}`,
      `${reminder.effectiveDueDate} ${reminder.effectiveDueTime}`
    );
  }
  if (reminder.effectiveDueDate) {
    return reminder.effectiveDueDate;
  }
  if (reminder.effectiveTimeRange) {
    return reminder.effectiveTimeRange;
  }
  if (reminder.effectiveConditionText) {
    return reminder.effectiveConditionText;
  }
  return tAssistantLabel(language, 'Sin fecha explícita', 'No explicit due date');
}

/** Checks whether a reminder is past due using only explicit due dates. */
function isAssistantReminderOverdue(reminder: NormalizedReminderContext): boolean {
  if (!reminder.effectiveDueDate) {
    return false;
  }
  return reminder.effectiveDueDate < getAssistantBusinessDate();
}

/** Builds a general KESP assistant help response without calling the model. */
function buildDeterministicHelpResponse(params: {
  language: AgentProfileAssistantLanguage;
  question: string;
}): AssistantModelJsonOutput | null {
  const normalized = normalizeIntentText(params.question);
  const asksPatternReport = includesAnyIntentTerm(normalized, [
    'reporte de patrones',
    'que es reporte',
    'what is pattern report',
  ]);
  const asksUpload = includesAnyIntentTerm(normalized, ['subir', 'subo', 'upload']);
  if (!wantsAssistantHelp(normalized) && !asksPatternReport) {
    return null;
  }

  if (asksPatternReport) {
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro: tAssistantLabel(
        params.language,
        'El reporte de patrones resume conductas repetidas detectadas en las llamadas de este agente.',
        'The pattern report summarizes repeated behaviors detected in this agent’s calls.'
      ),
      blocks: [
        {
          type: 'steps',
          items: [
            {
              title: tAssistantLabel(params.language, 'Qué contiene', 'What it contains'),
              body: tAssistantLabel(
                params.language,
                'Prioridades de coaching, cuándo aparecen, impacto comercial y foco recomendado.',
                'Coaching priorities, when they appear, business impact, and recommended focus.'
              ),
            },
            {
              title: tAssistantLabel(params.language, 'Cómo usarlo', 'How to use it'),
              body: tAssistantLabel(
                params.language,
                'Úsalo para decidir qué practicar primero y para pedir ejemplos, planes o frases de coaching.',
                'Use it to decide what to practice first and to ask for examples, plans, or coaching phrases.'
              ),
            },
          ],
        },
      ],
    };
    return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
  }

  const structuredContent: AgentProfileAssistantStructuredContent = {
    intro: asksUpload
      ? tAssistantLabel(
          params.language,
          'Para subir llamadas nuevas, entra a Subir y carga los audios del agente.',
          'To upload new calls, go to Upload and add the agent’s audio files.'
        )
      : tAssistantLabel(
          params.language,
          'Puedo analizar coaching, score/progresión, llamadas, recordatorios, ventas y el reporte de patrones de este perfil.',
          'I can analyze coaching, score/progression, calls, reminders, sales, and the pattern report for this profile.'
        ),
    blocks: [
      {
        type: 'steps',
        items: asksUpload
          ? [
              {
                title: tAssistantLabel(params.language, 'Sube audios', 'Upload audio'),
                body: tAssistantLabel(
                  params.language,
                  'Usa la sección Subir para cargar llamadas y luego revisar el análisis dentro del perfil.',
                  'Use the Upload section to add calls and then review analysis inside the profile.'
                ),
              },
              {
                title: tAssistantLabel(params.language, 'Actualiza el perfil', 'Refresh the profile'),
                body: tAssistantLabel(
                  params.language,
                  'Cuando haya nuevas llamadas analizadas, el reporte y los recordatorios pueden reflejar esos datos.',
                  'When new calls are analyzed, the report and reminders can reflect those data.'
                ),
              },
            ]
          : [
              {
                title: tAssistantLabel(params.language, 'Coaching', 'Coaching'),
                body: tAssistantLabel(
                  params.language,
                  'Prioridad principal, explicación del problema, frase exacta o plan de práctica.',
                  'Main priority, problem explanation, exact phrase, or practice plan.'
                ),
              },
              {
                title: tAssistantLabel(params.language, 'Score y llamadas', 'Score and calls'),
                body: tAssistantLabel(
                  params.language,
                  'Caídas de score, comparación entre días, criterios responsables y llamadas con evidencia.',
                  'Score drops, date comparisons, responsible criteria, and calls with evidence.'
                ),
              },
              {
                title: tAssistantLabel(params.language, 'Recordatorios', 'Reminders'),
                body: tAssistantLabel(
                  params.language,
                  'Seguimientos abiertos, vencidos y borradores de WhatsApp.',
                  'Open follow-ups, overdue reminders, and WhatsApp drafts.'
                ),
              },
              {
                title: tAssistantLabel(params.language, 'Ventas', 'Sales'),
                body: tAssistantLabel(
                  params.language,
                  'Créditos vendidos, monto colocado y seguimientos comerciales disponibles.',
                  'Sold loans, amount sold, and available sales follow-ups.'
                ),
              },
            ],
      },
    ],
  };
  return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
}

/** Builds a broad current-profile summary from deterministic context slices. */
function buildDeterministicProfileSummaryResponse(params: {
  language: AgentProfileAssistantLanguage;
  context: LoadedAgentProfileAssistantContext;
  question: string;
}): AssistantModelJsonOutput | null {
  const normalized = normalizeIntentText(params.question);
  const asksMixedSummary =
    wantsAssistantProfileSummary(normalized) ||
    (includesAnyIntentTerm(normalized, ['ventas']) &&
      includesAnyIntentTerm(normalized, ['recordatorios']) &&
      includesAnyIntentTerm(normalized, ['coaching']));
  if (!asksMixedSummary) {
    return null;
  }

  const progress = getLatestProgressRollup(params.context);
  const sales = getLatestSalesRollup(params.context);
  const topPattern = params.context.latestReport?.patterns[0];
  const openReminders = getOpenAssistantReminders(params.context);
  const metricItems: AgentProfileAssistantMetricItem[] = [
    {
      label: tAssistantLabel(params.language, 'Score prom.', 'Avg. score'),
      value: typeof progress?.averageScore === 'number' ? String(Math.round(progress.averageScore)) : '-',
      icon: 'chart',
      tone: 'neutral',
    },
    {
      label: tAssistantLabel(params.language, 'Llamadas', 'Calls'),
      value: String(progress?.totalReviewedCalls ?? params.context.callSnapshots.length),
      icon: 'phone',
      tone: 'neutral',
    },
    {
      label: tAssistantLabel(params.language, 'Recordatorios', 'Reminders'),
      value: String(openReminders.length),
      icon: 'clock',
      tone: openReminders.length > 0 ? 'warning' : 'good',
    },
    {
      label: tAssistantLabel(params.language, 'Ventas', 'Sales'),
      value: typeof sales?.soldLoanCount === 'number' ? String(sales.soldLoanCount) : '-',
      icon: 'trend',
      tone: 'neutral',
    },
  ];
  const blocks: AgentProfileAssistantStructuredBlock[] = [{ type: 'metrics', items: metricItems }];
  if (topPattern) {
    blocks.push({
      type: 'status',
      label: getPatternRecommendationTitle(topPattern),
      tone: 'warning',
      detail: getPatternRecommendationBody(topPattern),
    });
  }

  const structuredContent = sanitizeAssistantStructuredContent({
    intro: tAssistantLabel(
      params.language,
      'El resumen actual apunta a un foco de coaching claro y seguimiento comercial pendiente.',
      'The current summary points to one clear coaching focus and pending commercial follow-up.'
    ),
    blocks,
  });
  const references: AssistantModelReference[] = [];
  if (params.context.latestReport) {
    references.push({ type: 'report', id: params.context.latestReport.reportId });
  }
  if (progress) {
    references.push({ type: 'progress_rollup', id: progress.rollupId });
  }
  if (sales) {
    references.push({ type: 'sales_rollup', id: sales.rollupId });
  }
  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references,
  };
}

function getPatternRecommendationTitle(pattern: NormalizedBehaviorPattern): string {
  return sanitizeStructuredString(pattern.coachingFocus, 120) ||
    sanitizeStructuredString(pattern.patternName, 120) ||
    'Recomendación';
}

function getPatternRecommendationBody(pattern: NormalizedBehaviorPattern): string {
  return sanitizeStructuredString(pattern.behaviorSummary, 360) ||
    sanitizeStructuredString(pattern.whenItHappens, 360) ||
    sanitizeStructuredString(pattern.businessImpact, 360) ||
    sanitizeStructuredString(pattern.rootCause, 360) ||
    sanitizeStructuredString(pattern.patternName, 360);
}

function wasPatternRecentlyAnswered(
  pattern: NormalizedBehaviorPattern,
  recentMessages: AgentProfileAssistantChatMessage[]
): boolean {
  const recentAssistantText = recentMessages
    .filter((message) => message.role === 'assistant')
    .slice(-4)
    .map((message) => {
      const stepTitles = message.structuredContent?.blocks.flatMap((block) =>
        block.type === 'steps' ? block.items.map((item) => item.title) : []
      ) ?? [];
      return [message.content, ...stepTitles].join(' ');
    })
    .join(' ');
  const normalizedRecent = normalizeIntentText(recentAssistantText);
  if (!normalizedRecent) {
    return false;
  }
  return [getPatternRecommendationTitle(pattern), pattern.patternName, pattern.coachingFocus]
    .map((value) => normalizeIntentText(value))
    .filter((value) => value.length >= 8)
    .some((value) => normalizedRecent.includes(value));
}

function buildDeterministicCoachingCountResponse(params: {
  language: AgentProfileAssistantLanguage;
  latestReport: NormalizedLatestReportContext | null;
  intent: AssistantQuestionIntent;
  recentMessages: AgentProfileAssistantChatMessage[];
}): AssistantModelJsonOutput | null {
  const requestedCount = params.intent.requestedCount;
  if (!requestedCount || params.intent.domain !== 'coaching') {
    return null;
  }

  const patterns = params.latestReport?.patterns ?? [];
  const candidates = params.intent.wantsDistinctFromRecent
    ? patterns.filter((pattern) => !wasPatternRecentlyAnswered(pattern, params.recentMessages))
    : patterns;
  const selected = candidates.slice(0, requestedCount);

  if (selected.length === 0) {
    const intro = tAssistantLabel(
      params.language,
      params.intent.wantsDistinctFromRecent
        ? 'No tengo recomendaciones adicionales distintas con los datos actuales del perfil.'
        : 'No tengo recomendaciones de coaching suficientes con los datos actuales del perfil.',
      params.intent.wantsDistinctFromRecent
        ? 'I do not have additional distinct recommendations from the current profile data.'
        : 'I do not have enough coaching recommendations from the current profile data.'
    );
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro,
      blocks: [
        {
          type: 'status',
          label: tAssistantLabel(params.language, 'Datos insuficientes', 'Not enough data'),
          tone: 'warning',
          detail: tAssistantLabel(
            params.language,
            'No voy a inventar acciones fuera del reporte de patrones disponible.',
            'I will not invent actions outside the available pattern report.'
          ),
        },
      ],
    };
    return {
      answer: buildFallbackAnswerFromStructuredContent(structuredContent),
      structuredContent,
      references: params.latestReport ? [{ type: 'report', id: params.latestReport.reportId }] : [],
    };
  }

  const intro = selected.length === requestedCount
    ? tAssistantLabel(
        params.language,
        `Estas son ${requestedCount} recomendaciones concretas para trabajar en las próximas llamadas.`,
        `Here are ${requestedCount} concrete recommendations to work on in the next calls.`
      )
    : tAssistantLabel(
        params.language,
        `Solo tengo ${selected.length} recomendaciones distintas soportadas por los datos actuales.`,
        `I only have ${selected.length} distinct recommendations supported by the current data.`
      );
  const blocks: AgentProfileAssistantStructuredBlock[] = [
    {
      type: 'steps',
      items: selected.map((pattern) => ({
        title: getPatternRecommendationTitle(pattern),
        body: getPatternRecommendationBody(pattern),
      })),
    },
  ];

  if (selected.length < requestedCount) {
    blocks.push({
      type: 'status',
      label: tAssistantLabel(params.language, 'No hay más puntos distintos', 'No more distinct items'),
      tone: 'warning',
      detail: tAssistantLabel(
        params.language,
        'Para completar más recomendaciones necesito más patrones o llamadas analizadas.',
        'To complete more recommendations, I need more analyzed calls or patterns.'
      ),
    });
  }

  const structuredContent = sanitizeAssistantStructuredContent({
    intro,
    blocks,
  });
  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references: params.latestReport ? [{ type: 'report', id: params.latestReport.reportId }] : [],
  };
}

/** Builds a deterministic reminder answer from loaded reminder context. */
function buildDeterministicReminderResponse(params: {
  language: AgentProfileAssistantLanguage;
  context: LoadedAgentProfileAssistantContext;
  intent: AssistantQuestionIntent;
  question: string;
}): AssistantModelJsonOutput | null {
  if (params.intent.domain !== 'reminders') {
    return null;
  }

  const normalized = normalizeIntentText(params.question);
  const openReminders = getOpenAssistantReminders(params.context);
  if (openReminders.length === 0) {
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro: tAssistantLabel(
        params.language,
        'No hay recordatorios abiertos en este perfil.',
        'There are no open reminders in this profile.'
      ),
      blocks: [
        {
          type: 'status',
          label: tAssistantLabel(params.language, 'Sin pendientes abiertos', 'No open follow-ups'),
          tone: 'good',
          detail: tAssistantLabel(
            params.language,
            'Cuando una llamada genere seguimiento, aparecerá aquí con fecha, cliente y acción si esos datos existen.',
            'When a call generates follow-up, it will appear here with date, customer, and action when those data exist.'
          ),
        },
      ],
    };
    return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
  }

  const matchingReminder = openReminders.find(
    /** Handles the callback for this operation. */
    (reminder) => {
      const customer = reminder.customerName ? normalizeIntentText(reminder.customerName) : '';
      return Boolean(customer && normalized.includes(customer));
    }
  ) ?? openReminders[0];
  const asksDraft =
    params.intent.inheritedFollowUpAction === 'reminder_draft' ||
    includesAnyIntentTerm(normalized, ['whatsapp', 'mensaje', 'que le digo', 'borrador']);
  const asksOverdue = includesAnyIntentTerm(normalized, ['vencido', 'vencidos', 'atrasado', 'atrasados']);
  const asksUrgent = includesAnyIntentTerm(normalized, ['urgente', 'primero', 'cual', 'cuál', 'mas importante']);

  if (asksDraft) {
    const action = matchingReminder.nextAction || tAssistantLabel(
      params.language,
      'confirmar el siguiente paso pendiente',
      'confirm the pending next step'
    );
    const due = formatAssistantReminderDue(params.language, matchingReminder);
    const customer = matchingReminder.customerName || tAssistantLabel(params.language, 'cliente', 'customer');
    const structuredContent = sanitizeAssistantStructuredContent({
      intro: tAssistantLabel(
        params.language,
        `Este borrador sirve para ${customer}.`,
        `This draft is for ${customer}.`
      ),
      blocks: [
        {
          type: 'text',
          text: tAssistantLabel(
            params.language,
            `Hola, ${customer}. Te escribo para dar seguimiento: ${action}. ¿Te queda bien revisarlo hoy?`,
            `Hi, ${customer}. I am following up: ${action}. Does reviewing it today work for you?`
          ),
        },
        {
          type: 'status',
          label: tAssistantLabel(params.language, 'Referencia del recordatorio', 'Reminder reference'),
          tone: isAssistantReminderOverdue(matchingReminder) ? 'warning' : 'neutral',
          detail: tAssistantLabel(params.language, `Fecha: ${due}`, `Due: ${due}`),
        },
      ],
    });
    const references: AssistantModelReference[] = [{ type: 'reminder', id: matchingReminder.reminderId }];
    if (matchingReminder.sourceCallId) {
      references.push({ type: 'call', id: matchingReminder.sourceCallId });
    }
    return {
      answer: buildFallbackAnswerFromStructuredContent(structuredContent),
      ...(structuredContent ? { structuredContent } : {}),
      references,
    };
  }

  if (asksOverdue) {
    const overdue = openReminders.filter(
      /** Handles the callback for this operation. */
      (reminder) => isAssistantReminderOverdue(reminder)
    );
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro: overdue.length > 0
        ? tAssistantLabel(params.language, `Hay ${overdue.length} recordatorio(s) vencido(s).`, `There are ${overdue.length} overdue reminder(s).`)
        : tAssistantLabel(params.language, 'No veo recordatorios vencidos con fecha explícita.', 'I do not see overdue reminders with an explicit due date.'),
      blocks: overdue.length > 0
        ? [{
            type: 'steps',
            items: overdue.slice(0, ASSISTANT_MAX_STRUCTURED_ITEMS).map(
              /** Handles the callback for this operation. */
              (reminder) => ({
                title: reminder.customerName || tAssistantLabel(params.language, 'Recordatorio', 'Reminder'),
                body: `${formatAssistantReminderDue(params.language, reminder)} · ${reminder.nextAction || tAssistantLabel(params.language, 'Sin acción explícita', 'No explicit action')}`,
              })
            ),
          }]
        : [{
            type: 'status',
            label: tAssistantLabel(params.language, 'Sin vencidos comprobables', 'No provable overdue items'),
            tone: 'good',
            detail: tAssistantLabel(
              params.language,
              'Solo marco como vencido lo que tiene fecha anterior a hoy.',
              'I only mark as overdue items with a due date before today.'
            ),
          }],
    };
    return {
      answer: buildFallbackAnswerFromStructuredContent(structuredContent),
      structuredContent,
      references: overdue.map(
        /** Handles the callback for this operation. */
        (reminder) => ({ type: 'reminder', id: reminder.reminderId })
      ),
    };
  }

  const selected = asksUrgent ? [matchingReminder] : openReminders.slice(0, ASSISTANT_MAX_STRUCTURED_ITEMS);
  const structuredContent = sanitizeAssistantStructuredContent({
    intro: asksUrgent
      ? tAssistantLabel(params.language, 'El recordatorio más urgente es este.', 'The most urgent reminder is this one.')
      : tAssistantLabel(params.language, `Hay ${openReminders.length} recordatorio(s) abierto(s).`, `There are ${openReminders.length} open reminder(s).`),
    blocks: [
      {
        type: 'steps',
        items: selected.map(
          /** Handles the callback for this operation. */
          (reminder) => ({
            title: reminder.customerName || tAssistantLabel(params.language, 'Recordatorio abierto', 'Open reminder'),
            body: `${formatAssistantReminderDue(params.language, reminder)} · ${reminder.nextAction || tAssistantLabel(params.language, 'Sin acción explícita', 'No explicit action')}`,
          })
        ),
      },
    ],
  });
  const references: AssistantModelReference[] = [];
  selected.forEach(
    /** Handles the callback for this operation. */
    (reminder) => {
      references.push({ type: 'reminder', id: reminder.reminderId });
      if (reminder.sourceCallId) {
        references.push({ type: 'call', id: reminder.sourceCallId });
      }
    }
  );
  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references,
  };
}

/** Builds a deterministic sales answer from loaded sales rollups. */
function buildDeterministicSalesResponse(params: {
  language: AgentProfileAssistantLanguage;
  context: LoadedAgentProfileAssistantContext;
  intent: AssistantQuestionIntent;
}): AssistantModelJsonOutput | null {
  if (params.intent.domain !== 'sales') {
    return null;
  }

  const sales = getLatestSalesRollup(params.context);
  if (!sales) {
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro: tAssistantLabel(
        params.language,
        'No tengo un rollup de ventas disponible para este perfil.',
        'I do not have a sales rollup available for this profile.'
      ),
      blocks: [{
        type: 'status',
        label: tAssistantLabel(params.language, 'Ventas no disponibles', 'Sales unavailable'),
        tone: 'warning',
        detail: tAssistantLabel(
          params.language,
          'Necesito datos de salesRollups para responder montos o créditos vendidos.',
          'I need salesRollups data to answer amounts or sold-loan counts.'
        ),
      }],
    };
    return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
  }

  const structuredContent = sanitizeAssistantStructuredContent({
    intro: params.intent.inheritedDomain === 'sales'
      ? tAssistantLabel(
          params.language,
          'Sin una meta externa no puedo calificarlo como bueno o malo; sí puedo resumir el estado de ventas.',
          'Without an external target I cannot call it good or bad; I can summarize the sales state.'
        )
      : tAssistantLabel(params.language, 'Este es el resumen de ventas disponible.', 'This is the available sales summary.'),
    blocks: [
      {
        type: 'metrics',
        items: [
          {
            label: tAssistantLabel(params.language, 'Créditos', 'Loans'),
            value: typeof sales.soldLoanCount === 'number' ? String(sales.soldLoanCount) : '-',
            icon: 'trend',
            tone: 'neutral',
          },
          {
            label: tAssistantLabel(params.language, 'Monto', 'Amount'),
            value: formatAssistantMxnAmount(sales.totalAmountSold),
            icon: 'chart',
            tone: 'neutral',
          },
          {
            label: tAssistantLabel(params.language, 'Seguimientos', 'Follow-ups'),
            value: typeof sales.followUpNeededCount === 'number' ? String(sales.followUpNeededCount) : '-',
            icon: 'clock',
            tone: sales.followUpNeededCount && sales.followUpNeededCount > 0 ? 'warning' : 'good',
          },
        ],
      },
    ],
  });
  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references: [{ type: 'sales_rollup', id: sales.rollupId }],
  };
}

/** Builds a deterministic copy-ready coaching phrase or script. */
function buildDeterministicCoachingDraftResponse(params: {
  language: AgentProfileAssistantLanguage;
  latestReport: NormalizedLatestReportContext | null;
  intent: AssistantQuestionIntent;
  question: string;
}): AssistantModelJsonOutput | null {
  const normalized = normalizeIntentText(params.question);
  const inheritedDraft =
    params.intent.affirmativeFollowUp &&
    params.intent.inheritedFollowUpAction === 'coaching_draft';
  if (params.intent.domain !== 'coaching' || (!inheritedDraft && !wantsAssistantCoachingDraft(normalized))) {
    return null;
  }
  const pattern = params.latestReport?.patterns[0];
  if (!pattern) {
    return null;
  }

  const phrase = tAssistantLabel(
    params.language,
    'Para aterrizarlo a tu caso: este crédito te ayuda a resolver [necesidad del cliente] con [monto/plazo concreto]. Si eso te funciona, el siguiente paso es [acción concreta].',
    'To make it specific to your case: this loan helps you solve [customer need] with [specific amount/term]. If that works for you, the next step is [concrete action].'
  );
  const structuredContent = sanitizeAssistantStructuredContent({
    intro: tAssistantLabel(
      params.language,
      'Usaría una frase corta que valide la duda y ordene la explicación.',
      'I would use a short phrase that validates the concern and organizes the explanation.'
    ),
    blocks: [
      { type: 'text', text: phrase },
      {
        type: 'status',
        label: getPatternRecommendationTitle(pattern),
        tone: 'warning',
        detail: getPatternRecommendationBody(pattern),
      },
    ],
  });
  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references: params.latestReport ? [{ type: 'report', id: params.latestReport.reportId }] : [],
  };
}

/** Builds deterministic coaching evidence and why explanations from report patterns. */
function buildDeterministicCoachingEvidenceResponse(params: {
  language: AgentProfileAssistantLanguage;
  latestReport: NormalizedLatestReportContext | null;
  intent: AssistantQuestionIntent;
  question: string;
}): AssistantModelJsonOutput | null {
  const normalized = normalizeIntentText(params.question);
  if (
    params.intent.domain !== 'coaching' ||
    params.intent.requestedCount ||
    params.intent.wantsDistinctFromRecent ||
    (!wantsAssistantCoachingEvidence(normalized) &&
      params.intent.inheritedFollowUpAction !== 'coaching_evidence' &&
      (!params.intent.ambiguousFollowUp || params.intent.affirmativeFollowUp))
  ) {
    return null;
  }
  const pattern = params.latestReport?.patterns[0];
  if (!pattern) {
    return null;
  }

  const metrics: AgentProfileAssistantMetricItem[] = [
    {
      label: tAssistantLabel(params.language, 'Visto en', 'Seen in'),
      value: pattern.totalCallCount > 0 ? `${pattern.seenInCallCount}/${pattern.totalCallCount}` : String(pattern.seenInCallCount),
      icon: 'phone',
      tone: 'warning',
    },
    {
      label: tAssistantLabel(params.language, 'Prioridad', 'Priority'),
      value: String(Math.round(pattern.priorityScore)),
      icon: 'flag',
      tone: 'warning',
    },
  ];
  const structuredContent = sanitizeAssistantStructuredContent({
    intro: tAssistantLabel(
      params.language,
      `El punto clave es ${getPatternRecommendationTitle(pattern)}.`,
      `The key point is ${getPatternRecommendationTitle(pattern)}.`
    ),
    blocks: [
      { type: 'metrics', items: metrics },
      {
        type: 'status',
        label: tAssistantLabel(params.language, 'Causa observable', 'Observable cause'),
        tone: 'warning',
        detail: pattern.rootCause || pattern.whenItHappens || getPatternRecommendationBody(pattern),
      },
      {
        type: 'text',
        text: tAssistantLabel(
          params.language,
          pattern.businessImpact || getPatternRecommendationBody(pattern),
          pattern.businessImpact || getPatternRecommendationBody(pattern)
        ),
      },
    ],
  });
  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references: params.latestReport ? [{ type: 'report', id: params.latestReport.reportId }] : [],
  };
}

/** Builds a compact status block that ties advanced coaching guidance back to the active pattern. */
function buildAssistantTechniquePatternStatus(
  language: AgentProfileAssistantLanguage,
  pattern: NormalizedBehaviorPattern
): AgentProfileAssistantStructuredBlock {
  return {
    type: 'status',
    label: getPatternRecommendationTitle(pattern),
    tone: 'warning',
    detail: tAssistantLabel(
      language,
      getPatternRecommendationBody(pattern),
      getPatternRecommendationBody(pattern)
    ),
  };
}

/** Builds deterministic advanced coaching answers for practice, diagnosis, metrics, and supervisor delivery. */
function buildDeterministicCoachingTechniqueResponse(params: {
  language: AgentProfileAssistantLanguage;
  latestReport: NormalizedLatestReportContext | null;
  intent: AssistantQuestionIntent;
  question: string;
}): AssistantModelJsonOutput | null {
  const normalized = normalizeIntentText(params.question);
  const inheritedPractice =
    params.intent.affirmativeFollowUp &&
    params.intent.inheritedFollowUpAction === 'coaching_practice';
  if (
    params.intent.domain !== 'coaching' ||
    (!inheritedPractice && !wantsAssistantCoachingTechnique(normalized))
  ) {
    return null;
  }

  const pattern = params.latestReport?.patterns[0];
  if (!pattern) {
    return null;
  }

  const asksDiagnosis = includesAnyIntentTerm(normalized, ['distingo', 'necesidad o cierre']);
  const asksExactNeedQuestion =
    !asksDiagnosis && includesAnyIntentTerm(normalized, ['antes de cotizar', 'pregunta exacta', 'necesidad']);
  const asksMetric = includesAnyIntentTerm(normalized, ['medir', 'metrica', 'métrica', 'senal', 'señal', 'senales', 'señales', 'indicador']);
  const asksDelivery = includesAnyIntentTerm(normalized, [
    'agente se defiende',
    'resistente',
    'sensible',
    'supervisor',
    'tono',
    'directa',
    'directo',
  ]);
  const asksWhatNot = includesAnyIntentTerm(normalized, ['no debo coachear', 'no coachear']);
  const asksChecklist = includesAnyIntentTerm(normalized, ['checklist', 'observacion', 'observación']);

  if (asksExactNeedQuestion) {
    const structuredContent = sanitizeAssistantStructuredContent({
      intro: tAssistantLabel(
        params.language,
        'Antes de cotizar, usaría una pregunta que conecte necesidad, monto y decisión.',
        'Before quoting, I would use a question that connects need, amount, and decision.'
      ),
      blocks: [
        {
          type: 'text',
          text: tAssistantLabel(
            params.language,
            'Antes de darte una opción, dime: ¿qué necesitas resolver con este crédito y qué monto/plazo te dejaría cómodo para decidir hoy?',
            'Before I give you an option, tell me: what do you need this loan to solve, and what amount/term would make you comfortable deciding today?'
          ),
        },
        buildAssistantTechniquePatternStatus(params.language, pattern),
      ],
    });
    return {
      answer: buildFallbackAnswerFromStructuredContent(structuredContent),
      ...(structuredContent ? { structuredContent } : {}),
      references: params.latestReport ? [{ type: 'report', id: params.latestReport.reportId }] : [],
    };
  }

  if (asksDiagnosis) {
    const structuredContent = sanitizeAssistantStructuredContent({
      intro: tAssistantLabel(
        params.language,
        'Distingue necesidad vs. cierre mirando dónde se rompe la decisión del cliente.',
        'Separate need vs. closing by looking at where the customer decision breaks.'
      ),
      blocks: [
        {
          type: 'comparison',
          leftLabel: tAssistantLabel(params.language, 'Necesidad', 'Need'),
          rightLabel: tAssistantLabel(params.language, 'Cierre', 'Close'),
          rows: [
            {
              label: tAssistantLabel(params.language, 'Señal', 'Signal'),
              left: tAssistantLabel(params.language, 'El cliente no explica para qué lo quiere.', 'The customer does not explain what it is for.'),
              right: tAssistantLabel(params.language, 'Entiende la oferta, pero no confirma acción.', 'Understands the offer, but does not confirm action.'),
            },
            {
              label: tAssistantLabel(params.language, 'Coach', 'Coach'),
              left: tAssistantLabel(params.language, 'Pide una razón concreta antes de cotizar.', 'Ask for a concrete reason before quoting.'),
              right: tAssistantLabel(params.language, 'Cierra con canal, momento y siguiente paso.', 'Close with channel, timing, and next step.'),
            },
          ],
        },
        buildAssistantTechniquePatternStatus(params.language, pattern),
      ],
    });
    return {
      answer: buildFallbackAnswerFromStructuredContent(structuredContent),
      ...(structuredContent ? { structuredContent } : {}),
      references: params.latestReport ? [{ type: 'report', id: params.latestReport.reportId }] : [],
    };
  }

  const items: AgentProfileAssistantStepItem[] = asksMetric
    ? [
        {
          title: tAssistantLabel(params.language, 'Claridad repetible', 'Repeatable clarity'),
          body: tAssistantLabel(
            params.language,
            'El cliente puede repetir monto, plazo y requisito sin que el agente lo rescate.',
            'The customer can repeat amount, term, and requirement without the agent rescuing the explanation.'
          ),
        },
        {
          title: tAssistantLabel(params.language, 'Validación antes de avanzar', 'Validation before moving on'),
          body: tAssistantLabel(
            params.language,
            'El agente confirma la duda o necesidad antes de volver a explicar o cotizar.',
            'The agent confirms the concern or need before explaining again or quoting.'
          ),
        },
        {
          title: tAssistantLabel(params.language, 'Siguiente paso cerrado', 'Closed next step'),
          body: tAssistantLabel(
            params.language,
            'La llamada termina con canal, momento y acción confirmada por el cliente.',
            'The call ends with channel, timing, and action confirmed by the customer.'
          ),
        },
      ]
    : asksDelivery
      ? [
          {
            title: tAssistantLabel(params.language, 'Abre con conducta, no juicio', 'Open with behavior, not judgment'),
            body: tAssistantLabel(
              params.language,
              'Di qué se observó en la llamada y evita etiquetas personales.',
              'Name what was observed in the call and avoid personal labels.'
            ),
          },
          {
            title: tAssistantLabel(params.language, 'Pregunta primero', 'Ask first'),
            body: tAssistantLabel(
              params.language,
              'Pregunta qué intentaba lograr el agente antes de corregir la frase.',
              'Ask what the agent was trying to achieve before correcting the phrase.'
            ),
          },
          {
            title: tAssistantLabel(params.language, 'Cierra con práctica', 'Close with practice'),
            body: tAssistantLabel(
              params.language,
              'Acuerda una frase concreta para usar en la siguiente llamada y revisarla después.',
              'Agree on one concrete phrase to use in the next call and review afterward.'
            ),
          },
        ]
      : asksWhatNot
        ? [
            {
              title: tAssistantLabel(params.language, 'No empieces por estilo', 'Do not start with style'),
              body: tAssistantLabel(
                params.language,
                'No priorices velocidad, simpatía o tono si primero falta claridad de oferta o siguiente paso.',
                'Do not prioritize speed, friendliness, or tone if offer clarity or next step is missing first.'
              ),
            },
            {
              title: tAssistantLabel(params.language, 'No abras más frentes', 'Do not open too many fronts'),
              body: tAssistantLabel(
                params.language,
                'Elige un comportamiento observable y practícalo antes de agregar otro foco.',
                'Choose one observable behavior and practice it before adding another focus.'
              ),
            },
            {
              title: tAssistantLabel(params.language, 'Sí conecta con impacto', 'Do connect it to impact'),
              body: tAssistantLabel(
                params.language,
                'Explica cómo ese foco ayuda a que el cliente entienda, decida o cumpla el seguimiento.',
                'Explain how that focus helps the customer understand, decide, or complete follow-up.'
              ),
            },
          ]
        : asksChecklist
          ? [
              {
                title: tAssistantLabel(params.language, 'Antes de cotizar', 'Before quoting'),
                body: tAssistantLabel(
                  params.language,
                  'Busca una pregunta de necesidad o validación clara antes de presentar la opción.',
                  'Look for a clear need or validation question before presenting the option.'
                ),
              },
              {
                title: tAssistantLabel(params.language, 'Durante la oferta', 'During the offer'),
                body: tAssistantLabel(
                  params.language,
                  'Revisa si monto, plazo, requisito y beneficio quedan separados en bloques cortos.',
                  'Check whether amount, term, requirement, and benefit are separated into short blocks.'
                ),
              },
              {
                title: tAssistantLabel(params.language, 'Al cerrar', 'At close'),
                body: tAssistantLabel(
                  params.language,
                  'Confirma canal, momento y acción; si falta uno, ese es el ajuste de coaching.',
                  'Confirm channel, timing, and action; if one is missing, that is the coaching adjustment.'
                ),
              },
            ]
          : [
              {
                title: tAssistantLabel(params.language, '2 min: foco', '2 min: focus'),
                body: tAssistantLabel(
                  params.language,
                  `Define una sola conducta a practicar: ${getPatternRecommendationTitle(pattern)}.`,
                  `Define one behavior to practice: ${getPatternRecommendationTitle(pattern)}.`
                ),
              },
              {
                title: tAssistantLabel(params.language, '6 min: roleplay', '6 min: roleplay'),
                body: tAssistantLabel(
                  params.language,
                  'Simula cliente confundido o dudoso y exige que el agente valide antes de avanzar.',
                  'Simulate a confused or hesitant customer and require the agent to validate before moving on.'
                ),
              },
              {
                title: tAssistantLabel(params.language, '5 min: repetición', '5 min: repetition'),
                body: tAssistantLabel(
                  params.language,
                  'Repite la frase hasta que salga corta, clara y con siguiente paso.',
                  'Repeat the phrase until it is short, clear, and includes a next step.'
                ),
              },
              {
                title: tAssistantLabel(params.language, '2 min: criterio', '2 min: criterion'),
                body: tAssistantLabel(
                  params.language,
                  'Define qué vas a escuchar en la próxima llamada para saber si mejoró.',
                  'Define what you will listen for in the next call to know whether it improved.'
                ),
              },
            ];

  const structuredContent = sanitizeAssistantStructuredContent({
    intro: tAssistantLabel(
      params.language,
      'Lo convertiría en una práctica observable, no en consejo general.',
      'I would turn it into observable practice, not generic advice.'
    ),
    blocks: [
      { type: 'steps', items },
      buildAssistantTechniquePatternStatus(params.language, pattern),
    ],
  });
  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references: params.latestReport ? [{ type: 'report', id: params.latestReport.reportId }] : [],
  };
}

/** Builds the next distinct coaching item for open-ended follow-ups. */
function buildDeterministicNextCoachingResponse(params: {
  language: AgentProfileAssistantLanguage;
  latestReport: NormalizedLatestReportContext | null;
  intent: AssistantQuestionIntent;
  recentMessages: AgentProfileAssistantChatMessage[];
}): AssistantModelJsonOutput | null {
  if (params.intent.domain !== 'coaching' || !params.intent.wantsDistinctFromRecent || params.intent.requestedCount) {
    return null;
  }
  return buildDeterministicCoachingCountResponse({
    language: params.language,
    latestReport: params.latestReport,
    intent: { ...params.intent, requestedCount: 1 },
    recentMessages: params.recentMessages,
  });
}

/** Picks a behavior pattern while safely cycling when the plan has more slots than patterns. */
function getAssistantPlanPattern(
  patterns: NormalizedBehaviorPattern[],
  index: number
): NormalizedBehaviorPattern {
  return patterns[index % patterns.length];
}

/** Formats a localized day or day-range label for coaching plans. */
function formatAssistantPlanDayRange(
  language: AgentProfileAssistantLanguage,
  startDay: number,
  endDay: number
): string {
  if (startDay === endDay) {
    return tAssistantLabel(language, `Día ${startDay}`, `Day ${startDay}`);
  }
  return tAssistantLabel(language, `Días ${startDay}-${endDay}`, `Days ${startDay}-${endDay}`);
}

/** Builds the reusable action sentence for one coaching-plan item. */
function buildAssistantPlanActionBody(
  language: AgentProfileAssistantLanguage,
  action: string,
  pattern: NormalizedBehaviorPattern
): string {
  const recommendationBody = getPatternRecommendationBody(pattern);
  const fallbackFocus = getPatternRecommendationTitle(pattern);
  const detail = recommendationBody || fallbackFocus;
  return tAssistantLabel(
    language,
    `${action}: ${detail}`,
    `${action}: ${detail}`
  );
}

/** Builds one item for a day-by-day coaching plan. */
function buildAssistantDailyPlanItem(params: {
  language: AgentProfileAssistantLanguage;
  dayNumber: number;
  dayCount: number;
  pattern: NormalizedBehaviorPattern;
}): AgentProfileAssistantStepItem {
  const focus = getPatternRecommendationTitle(params.pattern);
  const action =
    params.dayNumber === 1
      ? tAssistantLabel(
          params.language,
          'Prepara un guion corto antes de llamar',
          'Prepare a short call script before calling'
        )
      : params.dayNumber === params.dayCount
        ? tAssistantLabel(
            params.language,
            'Revisa dos llamadas y deja la siguiente prioridad escrita',
            'Review two calls and write the next priority'
          )
        : params.dayNumber % 2 === 0
          ? tAssistantLabel(
              params.language,
              'Practica este foco en las primeras llamadas del día',
              'Practice this focus in the first calls of the day'
            )
          : tAssistantLabel(
              params.language,
              'Aplica el foco y anota una mejora observable',
              'Apply the focus and write down one observable improvement'
            );

  return {
    title: `${formatAssistantPlanDayRange(params.language, params.dayNumber, params.dayNumber)}: ${focus}`,
    body: buildAssistantPlanActionBody(params.language, action, params.pattern),
  };
}

/** Builds day-by-day coaching plan items when the user explicitly requests that format. */
function buildAssistantDailyPlanItems(params: {
  language: AgentProfileAssistantLanguage;
  dayCount: number;
  patterns: NormalizedBehaviorPattern[];
}): AgentProfileAssistantStepItem[] {
  const items: AgentProfileAssistantStepItem[] = [];
  for (let index = 0; index < params.dayCount; index += 1) {
    items.push(buildAssistantDailyPlanItem({
      language: params.language,
      dayNumber: index + 1,
      dayCount: params.dayCount,
      pattern: getAssistantPlanPattern(params.patterns, index),
    }));
  }
  return items;
}

/** Computes four phase ranges for longer coaching plans. */
function buildAssistantPlanPhaseRanges(dayCount: number): Array<[number, number]> {
  const secondEnd = Math.max(2, Math.floor(dayCount * 0.43));
  const thirdEnd = Math.max(secondEnd + 1, Math.floor(dayCount * 0.72));
  const ranges: Array<[number, number]> = [
    [1, 1],
    [2, Math.min(secondEnd, dayCount)],
    [Math.min(secondEnd + 1, dayCount), Math.min(thirdEnd, dayCount)],
    [Math.min(thirdEnd + 1, dayCount), dayCount],
  ];
  return ranges.filter(
    /** Handles the callback for this operation. */
    (range) => range[0] <= range[1]
  );
}

/** Builds the compact phased coaching-plan items used for weekly plans. */
function buildAssistantPhasedPlanItems(params: {
  language: AgentProfileAssistantLanguage;
  dayCount?: number;
  patterns: NormalizedBehaviorPattern[];
}): AgentProfileAssistantStepItem[] {
  const phaseTitles = [
    tAssistantLabel(params.language, 'Guion base', 'Base script'),
    tAssistantLabel(params.language, 'Práctica dirigida', 'Focused practice'),
    tAssistantLabel(params.language, 'Aplicación en llamadas', 'Apply in calls'),
    tAssistantLabel(params.language, 'Revisión y ajuste', 'Review and adjust'),
  ];
  const phaseActions = [
    tAssistantLabel(
      params.language,
      'Convierte el patrón en una frase de apertura, una explicación y un cierre de siguiente paso',
      'Turn the pattern into an opening phrase, an explanation, and a next-step close'
    ),
    tAssistantLabel(
      params.language,
      'Practica el foco antes de llamar y úsalo en al menos dos conversaciones',
      'Practice the focus before calling and use it in at least two conversations'
    ),
    tAssistantLabel(
      params.language,
      'Aplica el foco en llamadas reales y anota dónde el cliente decidió o se confundió',
      'Apply the focus in live calls and note where the customer decided or got confused'
    ),
    tAssistantLabel(
      params.language,
      'Revisa las llamadas recientes, conserva lo que funcionó y define el siguiente ajuste',
      'Review recent calls, keep what worked, and define the next adjustment'
    ),
  ];

  const ranges = params.dayCount ? buildAssistantPlanPhaseRanges(params.dayCount) : [];
  return phaseTitles.map(
    /** Handles the callback for this operation. */
    (phaseTitle, index) => {
      const pattern = getAssistantPlanPattern(params.patterns, index);
      const focus = getPatternRecommendationTitle(pattern);
      const range = ranges[index];
      const prefix = range
        ? formatAssistantPlanDayRange(params.language, range[0], range[1])
        : tAssistantLabel(params.language, `Paso ${index + 1}`, `Step ${index + 1}`);
      return {
        title: `${prefix}: ${phaseTitle} - ${focus}`,
        body: buildAssistantPlanActionBody(params.language, phaseActions[index] ?? phaseActions[0], pattern),
      };
    }
  ).slice(0, ASSISTANT_MAX_STRUCTURED_ITEMS);
}

/** Builds the concrete plan items for plan-shaped coaching requests. */
function buildAssistantCoachingPlanItems(params: {
  language: AgentProfileAssistantLanguage;
  intent: AssistantQuestionIntent;
  patterns: NormalizedBehaviorPattern[];
}): AgentProfileAssistantStepItem[] {
  const explicitDayCount = params.intent.requestedPlanDays;
  const dayCount = explicitDayCount
    ? Math.min(explicitDayCount, ASSISTANT_MAX_PLAN_DAY_COUNT)
    : undefined;
  if (
    dayCount &&
    dayCount <= ASSISTANT_MAX_PLAN_STRUCTURED_ITEMS &&
    (params.intent.wantsDayByDayPlan || dayCount <= 4)
  ) {
    return buildAssistantDailyPlanItems({
      language: params.language,
      dayCount: Math.min(dayCount, ASSISTANT_MAX_PLAN_STRUCTURED_ITEMS),
      patterns: params.patterns,
    });
  }
  return buildAssistantPhasedPlanItems({
    language: params.language,
    dayCount,
    patterns: params.patterns,
  });
}

/** Builds a deterministic coaching-plan response for common improvement-plan prompts. */
function buildDeterministicCoachingPlanResponse(params: {
  language: AgentProfileAssistantLanguage;
  latestReport: NormalizedLatestReportContext | null;
  intent: AssistantQuestionIntent;
}): AssistantModelJsonOutput | null {
  if (!params.intent.wantsPlan || params.intent.domain !== 'coaching') {
    return null;
  }

  const patterns = params.latestReport?.patterns ?? [];
  if (patterns.length === 0) {
    const intro = tAssistantLabel(
      params.language,
      'Necesito un reporte de patrones para armar un plan de mejora confiable.',
      'I need a pattern report to build a reliable improvement plan.'
    );
    const structuredContent: AgentProfileAssistantStructuredContent = {
      intro,
      blocks: [
        {
          type: 'status',
          label: tAssistantLabel(params.language, 'Datos insuficientes', 'Not enough data'),
          tone: 'warning',
          detail: tAssistantLabel(
            params.language,
            'Genera o actualiza el reporte de patrones y con eso puedo convertir los hallazgos en un plan concreto.',
            'Generate or refresh the pattern report and I can turn those findings into a concrete plan.'
          ),
        },
      ],
    };
    return {
      answer: buildFallbackAnswerFromStructuredContent(structuredContent),
      structuredContent,
      references: [],
    };
  }

  const dayCount = params.intent.requestedPlanDays;
  const planItems = buildAssistantCoachingPlanItems({
    language: params.language,
    intent: params.intent,
    patterns,
  });
  const intro = dayCount
    ? tAssistantLabel(
        params.language,
        `Este plan de ${dayCount} días trabaja los patrones de mayor prioridad sin inventar puntos fuera del reporte.`,
        `This ${dayCount}-day plan works on the highest-priority patterns without inventing items outside the report.`
      )
    : tAssistantLabel(
        params.language,
        'Este plan convierte los patrones principales del reporte en práctica concreta para las próximas llamadas.',
        'This plan turns the main report patterns into concrete practice for the next calls.'
      );
  const structuredContent = sanitizeAssistantStructuredContent({
    intro,
    blocks: [{ type: 'steps', items: planItems }],
    outro: tAssistantLabel(
      params.language,
      'Al terminar, vuelve a preguntar por el siguiente foco y te doy el ajuste con los datos nuevos.',
      'After finishing, ask for the next focus and I will adjust it with the new data.'
    ),
  }, {
    maxItems: ASSISTANT_MAX_PLAN_STRUCTURED_ITEMS,
  });

  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references: params.latestReport ? [{ type: 'report', id: params.latestReport.reportId }] : [],
  };
}

/** Extracts a day or step number mentioned in a follow-up question. */
function extractAssistantStepReference(normalized: string): AssistantStepReference | null {
  const dayMatch = normalized.match(
    new RegExp(`\\b(?:dia|dias|day|days)\\s+(${ASSISTANT_NUMBER_TOKEN_PATTERN})\\b`)
  );
  const dayValue = parseAssistantSmallNumber(dayMatch?.[1]);
  if (dayValue) {
    return {
      kind: 'day',
      value: dayValue,
      label: `day ${dayValue}`,
    };
  }

  const stepMatch = normalized.match(
    new RegExp(`\\b(?:paso|step)\\s+(${ASSISTANT_NUMBER_TOKEN_PATTERN})\\b`)
  );
  const stepValue = parseAssistantSmallNumber(stepMatch?.[1]);
  if (stepValue) {
    return {
      kind: 'step',
      value: stepValue,
      label: `step ${stepValue}`,
    };
  }
  return null;
}

/** Parses day ranges from plan item titles such as "Día 4" or "Días 4-5". */
function parseAssistantStepDayRange(title: string): [number, number] | null {
  const normalized = normalizeIntentText(title);
  const match = normalized.match(
    new RegExp(`\\b(?:dia|dias|day|days)\\s+(${ASSISTANT_NUMBER_TOKEN_PATTERN})(?:\\s*-\\s*(${ASSISTANT_NUMBER_TOKEN_PATTERN}))?\\b`)
  );
  const start = parseAssistantSmallNumber(match?.[1]);
  const end = parseAssistantSmallNumber(match?.[2]) ?? start;
  return start && end ? [Math.min(start, end), Math.max(start, end)] : null;
}

/** Removes list numbering from a previous plan step title before reusing it as a focus. */
function stripAssistantStepPrefix(title: string): string {
  return title
    .replace(/^\s*(?:D[ií]as?|Days?)\s+\d+(?:\s*-\s*\d+)?\s*:\s*/i, '')
    .replace(/^\s*(?:Paso|Step)\s+\d+\s*:\s*/i, '')
    .trim();
}

/** Finds the recent structured step referenced by a follow-up question. */
function findRecentAssistantStepForReference(
  recentMessages: AgentProfileAssistantChatMessage[],
  reference: AssistantStepReference
): AssistantReferencedStep | null {
  const assistantMessages = recentMessages
    .filter(
      /** Handles the callback for this operation. */
      (message) => message.role === 'assistant'
    )
    .reverse();

  for (const message of assistantMessages) {
    const stepBlocks = message.structuredContent?.blocks.filter(
      /** Handles the callback for this operation. */
      (block): block is Extract<AgentProfileAssistantStructuredBlock, { type: 'steps' }> =>
        block.type === 'steps'
    ) ?? [];
    for (const block of stepBlocks) {
      const matchedIndex = block.items.findIndex(
        /** Handles the callback for this operation. */
        (item, index) => {
          if (reference.kind === 'step' && index + 1 === reference.value) {
            return true;
          }
          const range = parseAssistantStepDayRange(item.title);
          return Boolean(range && reference.value >= range[0] && reference.value <= range[1]);
        }
      );
      if (matchedIndex >= 0) {
        return {
          item: block.items[matchedIndex],
          index: matchedIndex,
        };
      }
    }
  }
  return null;
}

/** Builds a deterministic explanation for follow-ups that reference a previous plan step. */
function buildDeterministicStepDetailResponse(params: {
  language: AgentProfileAssistantLanguage;
  latestReport: NormalizedLatestReportContext | null;
  recentMessages: AgentProfileAssistantChatMessage[];
  question: string;
}): AssistantModelJsonOutput | null {
  const reference = extractAssistantStepReference(normalizeIntentText(params.question));
  if (!reference) {
    return null;
  }
  const referencedStep = findRecentAssistantStepForReference(params.recentMessages, reference);
  if (!referencedStep) {
    return null;
  }

  const stepTitle = referencedStep.item.title;
  const focus = sanitizeStructuredString(stripAssistantStepPrefix(stepTitle), 160) || stepTitle;
  const sourceBody = referencedStep.item.body;
  const intro = reference.kind === 'day'
    ? tAssistantLabel(
        params.language,
        `Día ${reference.value}: el foco es ${focus}.`,
        `Day ${reference.value}: the focus is ${focus}.`
      )
    : tAssistantLabel(
        params.language,
        `Paso ${reference.value}: el foco es ${focus}.`,
        `Step ${reference.value}: the focus is ${focus}.`
      );
  const structuredContent = sanitizeAssistantStructuredContent({
    intro,
    blocks: [
      {
        type: 'text',
        text: tAssistantLabel(
          params.language,
          `En concreto, significa esto: ${sourceBody}`,
          `In concrete terms, it means this: ${sourceBody}`
        ),
      },
      {
        type: 'steps',
        items: [
          {
            title: tAssistantLabel(params.language, 'Antes de llamar', 'Before the call'),
            body: tAssistantLabel(
              params.language,
              `Escribe una frase corta para aplicar "${focus}" y decide qué dato debe quedar claro antes de avanzar.`,
              `Write one short phrase to apply "${focus}" and decide which detail must be clear before moving on.`
            ),
          },
          {
            title: tAssistantLabel(params.language, 'Durante la llamada', 'During the call'),
            body: tAssistantLabel(
              params.language,
              'Usa esa frase, pausa y valida si el cliente entendió o si hay una objeción real que atender.',
              'Use that phrase, pause, and validate whether the customer understood or has a real objection to address.'
            ),
          },
          {
            title: tAssistantLabel(params.language, 'Después de la llamada', 'After the call'),
            body: tAssistantLabel(
              params.language,
              'Anota si el cliente quedó con monto, plazo, condición y siguiente paso claro; si faltó algo, ese es el ajuste.',
              'Note whether amount, term, condition, and next step were clear; if something was missing, that is the adjustment.'
            ),
          },
        ],
      },
    ],
  });

  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references: params.latestReport ? [{ type: 'report', id: params.latestReport.reportId }] : [],
  };
}

interface AssistantScoreEvidencePoint {
  label: string;
  averageScore: number | null;
  callCount: number;
  lowConfidenceCount: number;
  topWeaknesses: Array<{ label: string; count: number }>;
  references: AssistantModelReference[];
}

interface AssistantCriterionAverage {
  criterionId: string;
  title: string;
  averagePercent: number | null;
  count: number;
  issue?: NormalizedRubricCriterionIssue;
  improvementTip?: string | null;
  callId?: string;
}

/** Formats an assistant score metric compactly. */
function formatAssistantScoreMetric(score: number | null): string {
  return typeof score === 'number' && Number.isFinite(score) ? score.toFixed(1) : '-';
}

/** Computes the average call score from snapshots with scored calls only. */
function averageAssistantSnapshotScore(snapshots: NormalizedCallSnapshotContext[]): number | null {
  const scores = snapshots
    .map(
      /** Extracts a score from one snapshot. */
      (snapshot) => snapshot.overallScore
    )
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  if (scores.length === 0) {
    return null;
  }
  const total = scores.reduce(
    /** Adds one call score into the running total. */
    (sum, score) => sum + score,
    0
  );
  return total / scores.length;
}

/** Counts repeated weakness labels from call snapshots. */
function countAssistantSnapshotWeaknesses(
  snapshots: NormalizedCallSnapshotContext[]
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  snapshots.forEach(
    /** Counts weakness labels from one call snapshot. */
    (snapshot) => {
      snapshot.weaknessTitles.forEach(
        /** Counts one weakness label. */
        (title) => counts.set(title, (counts.get(title) ?? 0) + 1)
      );
    }
  );
  return Array.from(counts.entries())
    .sort(
      /** Sorts frequent weakness labels first. */
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'es')
    )
    .slice(0, ASSISTANT_MAX_STRUCTURED_ITEMS)
    .map(
      /** Converts a map entry into a label/count item. */
      ([label, count]) => ({ label, count })
    );
}

/** Builds one score evidence point from a rollup with snapshot fallback. */
function buildAssistantScoreEvidencePoint(params: {
  label: string;
  rollups: NormalizedProgressRollupContext[];
  snapshots: NormalizedCallSnapshotContext[];
}): AssistantScoreEvidencePoint {
  const rollup = params.rollups[0];
  const snapshotAverage = averageAssistantSnapshotScore(params.snapshots);
  const averageScore = typeof rollup?.averageScore === 'number' ? rollup.averageScore : snapshotAverage;
  const scoredSnapshotCount = params.snapshots.filter(
    /** Counts scored snapshots only. */
    (snapshot) => typeof snapshot.overallScore === 'number'
  ).length;
  const callCount = rollup?.eligibleScoreCount ?? rollup?.totalReviewedCalls ?? scoredSnapshotCount;
  const lowConfidenceCount =
    rollup?.lowConfidenceCallCount ??
    params.snapshots.filter(
      /** Counts low-confidence snapshots. */
      (snapshot) => snapshot.lowConfidence === true
    ).length;
  const topWeaknesses =
    rollup?.topWeaknesses?.length
      ? rollup.topWeaknesses
      : rollup?.coachingPriorities?.length
        ? rollup.coachingPriorities
        : countAssistantSnapshotWeaknesses(params.snapshots);
  const callReferences = params.snapshots.slice(0, 3).map(
    /** Builds a call reference from one evidence snapshot. */
    (snapshot) => ({ type: 'call' as const, id: snapshot.sourceCallId })
  );
  const rollupReferences = rollup ? [{ type: 'progress_rollup' as const, id: rollup.rollupId }] : [];
  return {
    label: params.label,
    averageScore,
    callCount,
    lowConfidenceCount,
    topWeaknesses,
    references: [...rollupReferences, ...callReferences],
  };
}

/** Builds criterion averages across feedback summaries. */
function buildAssistantCriterionAverages(
  summaries: NormalizedCallFeedbackSummary[]
): Map<string, AssistantCriterionAverage> {
  const aggregates = new Map<string, {
    criterionId: string;
    title: string;
    totalPercent: number;
    scoredCount: number;
    totalCount: number;
    issue?: NormalizedRubricCriterionIssue;
    improvementTip?: string | null;
    callId?: string;
  }>();
  summaries.forEach(
    /** Adds one call feedback summary into criterion aggregates. */
    (summary) => {
      summary.weakestCriteria.forEach(
        /** Adds one weak criterion into aggregate metrics. */
        (criterion) => {
          const existing = aggregates.get(criterion.criterionId) ?? {
            criterionId: criterion.criterionId,
            title: criterion.title,
            totalPercent: 0,
            scoredCount: 0,
            totalCount: 0,
          };
          if (typeof criterion.scorePercent === 'number') {
            existing.totalPercent += criterion.scorePercent;
            existing.scoredCount += 1;
          }
          existing.totalCount += 1;
          existing.issue = existing.issue ?? criterion.issues[0];
          existing.improvementTip = existing.improvementTip ?? criterion.improvementTip;
          existing.callId = existing.callId ?? summary.callId;
          aggregates.set(criterion.criterionId, existing);
        }
      );
    }
  );
  return new Map(Array.from(aggregates.entries()).map(
    /** Converts one aggregate entry into a stable average object. */
    ([key, value]) => [
      key,
      {
        criterionId: value.criterionId,
        title: value.title,
        averagePercent: value.scoredCount > 0 ? value.totalPercent / value.scoredCount : null,
        count: value.totalCount,
        issue: value.issue,
        improvementTip: value.improvementTip,
        callId: value.callId,
      },
    ]
  ));
}

/** Selects the criterion most likely responsible for a score movement. */
function selectAssistantPrimaryCriterionDrop(params: {
  baselineSummaries: NormalizedCallFeedbackSummary[];
  targetSummaries: NormalizedCallFeedbackSummary[];
}): AssistantCriterionAverage | null {
  const baseline = buildAssistantCriterionAverages(params.baselineSummaries);
  const target = Array.from(buildAssistantCriterionAverages(params.targetSummaries).values());
  if (target.length === 0) {
    return null;
  }
  return target
    .sort(
      /** Sorts by largest negative movement, then lowest target score. */
      (left, right) => {
        const leftBase = baseline.get(left.criterionId)?.averagePercent;
        const rightBase = baseline.get(right.criterionId)?.averagePercent;
        const leftDelta =
          typeof left.averagePercent === 'number' && typeof leftBase === 'number'
            ? left.averagePercent - leftBase
            : Number.POSITIVE_INFINITY;
        const rightDelta =
          typeof right.averagePercent === 'number' && typeof rightBase === 'number'
            ? right.averagePercent - rightBase
            : Number.POSITIVE_INFINITY;
        if (leftDelta !== rightDelta) {
          return leftDelta - rightDelta;
        }
        const leftScore = typeof left.averagePercent === 'number' ? left.averagePercent : 101;
        const rightScore = typeof right.averagePercent === 'number' ? right.averagePercent : 101;
        return leftScore - rightScore;
      }
    )[0] ?? null;
}

/** Filters feedback summaries to the provided call id set. */
function filterAssistantFeedbackByCalls(
  summaries: NormalizedCallFeedbackSummary[],
  snapshots: NormalizedCallSnapshotContext[]
): NormalizedCallFeedbackSummary[] {
  const callIds = new Set(snapshots.map(
    /** Extracts a source call id for filtering feedback summaries. */
    (snapshot) => snapshot.sourceCallId
  ));
  return summaries.filter(
    /** Keeps only feedback summaries for the requested calls. */
    (summary) => callIds.has(summary.callId)
  );
}

/** Keeps daily rollups that contain a usable performance score. */
function getAssistantScoredDailyRollups(
  rollups: NormalizedProgressRollupContext[]
): NormalizedProgressRollupContext[] {
  return rollups.filter(
    /** Keeps only day rollups with a bucket date and average score. */
    (rollup) =>
      Boolean(rollup.bucketKey) &&
      (rollup.periodType === undefined || rollup.periodType === 'day') &&
      typeof rollup.averageScore === 'number'
  );
}

/** Selects the profile period that best matches the requested analysis mode. */
function selectAssistantPerformanceRollup(params: {
  rollups: NormalizedProgressRollupContext[];
  mode?: AssistantPeriodAnalysisMode;
}): NormalizedProgressRollupContext | null {
  const scoredRollups = getAssistantScoredDailyRollups(params.rollups);
  if (scoredRollups.length === 0) {
    return null;
  }
  if (params.mode === 'best_period') {
    return [...scoredRollups].sort(
      /** Sorts the highest-score day first. */
      (left, right) => (right.averageScore ?? -1) - (left.averageScore ?? -1)
    )[0] ?? null;
  }
  if (params.mode === 'pattern_drivers') {
    return [...scoredRollups].sort(
      /** Sorts the most weakness-heavy low-score day first. */
      (left, right) => {
        const leftWeaknessCount = left.topWeaknesses?.[0]?.count ?? left.coachingPriorities[0]?.count ?? 0;
        const rightWeaknessCount = right.topWeaknesses?.[0]?.count ?? right.coachingPriorities[0]?.count ?? 0;
        if (leftWeaknessCount !== rightWeaknessCount) {
          return rightWeaknessCount - leftWeaknessCount;
        }
        return (left.averageScore ?? 101) - (right.averageScore ?? 101);
      }
    )[0] ?? null;
  }
  return [...scoredRollups].sort(
    /** Sorts the lowest-score day first. */
    (left, right) => (left.averageScore ?? 101) - (right.averageScore ?? 101)
  )[0] ?? null;
}

/** Builds a one-day retrieval range from a selected progress rollup. */
function buildAssistantRollupDateRange(rollup: NormalizedProgressRollupContext): AssistantRetrievalDateRange | null {
  if (!rollup.bucketKey) {
    return null;
  }
  return {
    startDate: rollup.bucketKey,
    endDate: rollup.bucketKey,
    label: rollup.bucketKey,
  };
}

/** Computes the average daily score across a set of progress rollups. */
function averageAssistantRollupScore(rollups: NormalizedProgressRollupContext[]): number | null {
  const scores = rollups
    .map(
      /** Extracts each numeric rollup score. */
      (rollup) => rollup.averageScore
    )
    .filter(
      /** Keeps finite rollup scores. */
      (score): score is number => typeof score === 'number' && Number.isFinite(score)
    );
  if (scores.length === 0) {
    return null;
  }
  return scores.reduce(
    /** Adds one score into the average numerator. */
    (sum, score) => sum + score,
    0
  ) / scores.length;
}

/** Counts the dominant weakness labels across daily progress rollups. */
function countAssistantRollupWeaknesses(
  rollups: NormalizedProgressRollupContext[]
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  rollups.forEach(
    /** Adds weakness counts from one daily rollup. */
    (rollup) => {
      const items = rollup.topWeaknesses?.length ? rollup.topWeaknesses : rollup.coachingPriorities;
      items.forEach(
        /** Adds one weakness item into the period-level counter. */
        (item) => {
          counts.set(item.label, (counts.get(item.label) ?? 0) + item.count);
        }
      );
    }
  );
  return Array.from(counts.entries())
    .sort(
      /** Sorts the most frequent weakness labels first. */
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'es')
    )
    .map(
      /** Converts one weakness counter entry into a label/count pair. */
      ([label, count]) => ({ label, count })
    );
}

/** Builds a missing-data response for evidence-backed profile questions. */
function buildAssistantMissingEvidenceResponse(params: {
  language: AgentProfileAssistantLanguage;
  plan: AssistantRetrievalPlan;
  missing: string[];
}): AssistantModelJsonOutput {
  const dateLabel = params.plan.compareDateRange
    ? `${params.plan.compareDateRange.label} vs. ${params.plan.dateRange?.label ?? 'rango objetivo'}`
    : params.plan.dateRange?.label ?? tAssistantLabel(params.language, 'el rango pedido', 'the requested range');
  const missingDetail = params.missing.length > 0
    ? params.missing.join(', ')
    : tAssistantLabel(params.language, 'datos del rango solicitado', 'data for the requested range');
  const structuredContent: AgentProfileAssistantStructuredContent = {
    intro: tAssistantLabel(
      params.language,
      `No tengo datos suficientes para responder ese análisis de ${dateLabel}.`,
      `I do not have enough data to answer that analysis for ${dateLabel}.`
    ),
    blocks: [{
      type: 'status',
      label: tAssistantLabel(params.language, 'Falta evidencia', 'Missing evidence'),
      tone: 'warning',
      detail: tAssistantLabel(
        params.language,
        `Falta: ${missingDetail}. Necesito rollups/snapshots del perfil y, para causas, feedback o rúbrica de las llamadas.`,
        `Missing: ${missingDetail}. I need profile rollups/snapshots and, for causes, call feedback or rubric evidence.`
      ),
    }],
  };
  return { answer: buildFallbackAnswerFromStructuredContent(structuredContent), structuredContent, references: [] };
}

/** Builds a deterministic performance-period analysis from rollups and selected-day evidence. */
function buildDeterministicPerformanceAnalysisResponse(params: {
  language: AgentProfileAssistantLanguage;
  context: LoadedAgentProfileAssistantContext;
}): AssistantModelJsonOutput | null {
  const plan = params.context.retrievalPlan;
  const evidence = params.context.evidenceBundle;
  if (!plan || plan.topic !== 'performance_analysis' || !evidence) {
    return null;
  }

  const dailyRollups = getAssistantScoredDailyRollups(evidence.progressRollups);
  const selectedRollup = selectAssistantPerformanceRollup({
    rollups: dailyRollups,
    mode: plan.periodAnalysisMode,
  });
  if (!selectedRollup || !selectedRollup.bucketKey || typeof selectedRollup.averageScore !== 'number') {
    return buildAssistantMissingEvidenceResponse({
      language: params.language,
      plan,
      missing: evidence.missing.length > 0 ? evidence.missing : ['progress_rollups diarios con score promedio'],
    });
  }

  const selectedPoint = buildAssistantScoreEvidencePoint({
    label: selectedRollup.bucketKey,
    rollups: [selectedRollup],
    snapshots: evidence.callSnapshots,
  });
  const rangeAverage = averageAssistantRollupScore(dailyRollups);
  const periodWeaknesses = countAssistantRollupWeaknesses(dailyRollups);
  const feedbackForSelectedDay = filterAssistantFeedbackByCalls(evidence.feedbackSummaries, evidence.callSnapshots);
  const primaryCriterion = selectAssistantPrimaryCriterionDrop({
    baselineSummaries: [],
    targetSummaries: feedbackForSelectedDay,
  });
  const snapshotWeakness = countAssistantSnapshotWeaknesses(evidence.callSnapshots)[0];
  const topWeakness =
    primaryCriterion?.title ??
    selectedRollup.topWeaknesses?.[0]?.label ??
    selectedRollup.coachingPriorities[0]?.label ??
    snapshotWeakness?.label ??
    periodWeaknesses[0]?.label;
  const causeDetail =
    primaryCriterion?.issue?.detail ||
    primaryCriterion?.issue?.title ||
    primaryCriterion?.improvementTip ||
    (topWeakness
      ? tAssistantLabel(
          params.language,
          `En los agregados del periodo, ${topWeakness} aparece como la debilidad más repetida; falta rúbrica más profunda para citar el criterio exacto.`,
          `Across the period aggregates, ${topWeakness} is the most repeated weakness; deeper rubric evidence is missing for an exact criterion quote.`
        )
      : tAssistantLabel(
          params.language,
          'El score identifica el periodo, pero no hay debilidades suficientes para atribuir la causa.',
          'The score identifies the period, but there are not enough weaknesses to attribute the cause.'
        ));
  const callIds = evidence.callSnapshots.slice(0, 3).map(
    /** Extracts candidate call ids for the selected period. */
    (snapshot) => snapshot.sourceCallId
  );
  const selectedScore = formatAssistantScoreMetric(selectedRollup.averageScore);
  const rangeScore = formatAssistantScoreMetric(rangeAverage);
  const mode = plan.periodAnalysisMode ?? 'trend_summary';
  const intro = mode === 'best_period'
    ? tAssistantLabel(
        params.language,
        `El mejor día fue ${selectedRollup.bucketKey}: ${selectedScore} promedio en ${selectedPoint.callCount} llamada(s).`,
        `The best day was ${selectedRollup.bucketKey}: ${selectedScore} average across ${selectedPoint.callCount} call(s).`
      )
    : mode === 'pattern_drivers'
      ? tAssistantLabel(
          params.language,
          `El patrón que más lo está frenando es ${topWeakness ?? 'sin etiqueta clara'}; se concentra en ${selectedRollup.bucketKey}.`,
          `The pattern holding the agent back most is ${topWeakness ?? 'unclear label'}; it concentrates on ${selectedRollup.bucketKey}.`
        )
      : tAssistantLabel(
          params.language,
          `El peor día fue ${selectedRollup.bucketKey}: ${selectedScore} promedio en ${selectedPoint.callCount} llamada(s).`,
          `The worst day was ${selectedRollup.bucketKey}: ${selectedScore} average across ${selectedPoint.callCount} call(s).`
        );
  const rangeDelta = rangeAverage == null ? null : selectedRollup.averageScore - rangeAverage;
  const coachingAction = primaryCriterion?.improvementTip ||
    (topWeakness
      ? tAssistantLabel(
          params.language,
          `Coachea primero ${topWeakness}: que el agente lo resuelva con una frase corta, validación del cliente y un siguiente paso concreto.`,
          `Coach ${topWeakness} first: have the agent handle it with a short phrase, customer validation, and a concrete next step.`
        )
      : tAssistantLabel(
          params.language,
          'Coachea una llamada candidata completa y marca el primer momento donde se perdió claridad o avance.',
          'Coach one candidate call end-to-end and mark the first moment where clarity or progress was lost.'
        ));
  const structuredContent = sanitizeAssistantStructuredContent({
    intro,
    blocks: [
      {
        type: 'metrics',
        items: [
          { icon: 'clock', label: tAssistantLabel(params.language, 'Días analizados', 'Days analyzed'), value: String(dailyRollups.length), tone: 'neutral' },
          { icon: 'chart', label: tAssistantLabel(params.language, 'Score del día', 'Day score'), value: selectedScore, tone: mode === 'best_period' ? 'good' : 'bad' },
          { icon: 'phone', label: tAssistantLabel(params.language, 'Llamadas', 'Calls'), value: String(selectedPoint.callCount), tone: 'neutral' },
          { icon: 'flag', label: tAssistantLabel(params.language, 'Patrón', 'Pattern'), value: topWeakness ?? '-', tone: mode === 'best_period' ? 'good' : 'warning' },
        ],
      },
      {
        type: 'comparison',
        leftLabel: tAssistantLabel(params.language, 'Rango', 'Range'),
        rightLabel: selectedRollup.bucketKey,
        rows: [
          {
            label: tAssistantLabel(params.language, 'Score promedio', 'Average score'),
            left: rangeScore,
            right: selectedScore,
          },
          {
            label: tAssistantLabel(params.language, 'Diferencia vs rango', 'Difference vs range'),
            left: '0.0',
            right: rangeDelta == null ? '-' : `${rangeDelta >= 0 ? '+' : ''}${rangeDelta.toFixed(1)}`,
          },
          {
            label: tAssistantLabel(params.language, 'Debilidad principal', 'Main weakness'),
            left: periodWeaknesses[0]?.label ?? '-',
            right: topWeakness ?? '-',
          },
        ],
      },
      {
        type: 'steps',
        items: [
          {
            title: tAssistantLabel(params.language, 'Por qué', 'Why'),
            body: causeDetail,
          },
          {
            title: tAssistantLabel(params.language, 'Llamadas que lo explican', 'Calls explaining it'),
            body: callIds.length > 0
              ? tAssistantLabel(
                  params.language,
                  `Empieza por ${callIds.join(', ')}; son las llamadas cargadas para el día seleccionado.`,
                  `Start with ${callIds.join(', ')}; these are the calls loaded for the selected day.`
                )
              : tAssistantLabel(
                  params.language,
                  'El rollup existe, pero faltan snapshots de llamadas para abrir evidencia concreta.',
                  'The rollup exists, but call snapshots are missing for concrete evidence.'
                ),
          },
          {
            title: tAssistantLabel(params.language, 'Qué coachear primero', 'What to coach first'),
            body: coachingAction,
          },
        ],
      },
    ],
  });
  const references = [
    { type: 'progress_rollup' as const, id: selectedRollup.rollupId },
    ...evidence.callSnapshots.slice(0, 4).map(
      /** Builds call references from the selected period snapshots. */
      (snapshot) => ({ type: 'call' as const, id: snapshot.sourceCallId })
    ),
  ];
  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references,
  };
}

/** Builds a deterministic score/progression explanation from retrieved evidence. */
function buildDeterministicScoreProgressionResponse(params: {
  language: AgentProfileAssistantLanguage;
  context: LoadedAgentProfileAssistantContext;
}): AssistantModelJsonOutput | null {
  const plan = params.context.retrievalPlan;
  const evidence = params.context.evidenceBundle;
  if (!plan || plan.topic !== 'score_progression' || !evidence) {
    return null;
  }
  const targetPoint = buildAssistantScoreEvidencePoint({
    label: plan.dateRange?.label ?? tAssistantLabel(params.language, 'Rango objetivo', 'Target range'),
    rollups: evidence.progressRollups,
    snapshots: evidence.callSnapshots,
  });
  const baselinePoint = buildAssistantScoreEvidencePoint({
    label: plan.compareDateRange?.label ?? tAssistantLabel(params.language, 'Rango anterior', 'Previous range'),
    rollups: evidence.compareProgressRollups,
    snapshots: evidence.compareCallSnapshots,
  });
  if (targetPoint.averageScore == null || baselinePoint.averageScore == null) {
    return buildAssistantMissingEvidenceResponse({
      language: params.language,
      plan,
      missing: evidence.missing.length > 0 ? evidence.missing : ['score promedio del rango comparado'],
    });
  }

  const targetFeedback = filterAssistantFeedbackByCalls(evidence.feedbackSummaries, evidence.callSnapshots);
  const baselineFeedback = filterAssistantFeedbackByCalls(evidence.feedbackSummaries, evidence.compareCallSnapshots);
  const primaryCriterion = selectAssistantPrimaryCriterionDrop({
    baselineSummaries: baselineFeedback,
    targetSummaries: targetFeedback,
  });
  const delta = targetPoint.averageScore - baselinePoint.averageScore;
  const topWeakness = primaryCriterion?.title ?? targetPoint.topWeaknesses[0]?.label;
  const causeDetail =
    primaryCriterion?.issue?.detail ||
    primaryCriterion?.issue?.title ||
    primaryCriterion?.improvementTip ||
    (topWeakness
      ? tAssistantLabel(
          params.language,
          `La debilidad que más aparece en el rango objetivo es ${topWeakness}.`,
          `The most visible weakness in the target range is ${topWeakness}.`
        )
      : tAssistantLabel(
          params.language,
          'No hay rúbrica suficiente para atribuir la causa a un criterio específico.',
          'There is not enough rubric evidence to attribute the cause to a specific criterion.'
        ));
  const criterionMetric =
    primaryCriterion && typeof primaryCriterion.averagePercent === 'number'
      ? `${primaryCriterion.averagePercent.toFixed(0)}%`
      : topWeakness ?? '-';
  const intro = delta < 0
    ? tAssistantLabel(
        params.language,
        `El score bajó ${Math.abs(delta).toFixed(1)} pts: de ${formatAssistantScoreMetric(baselinePoint.averageScore)} a ${formatAssistantScoreMetric(targetPoint.averageScore)}.`,
        `The score dropped ${Math.abs(delta).toFixed(1)} pts: from ${formatAssistantScoreMetric(baselinePoint.averageScore)} to ${formatAssistantScoreMetric(targetPoint.averageScore)}.`
      )
    : tAssistantLabel(
        params.language,
        `No veo una caída en ese rango: cambió ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts.`,
        `I do not see a drop in that range: it changed ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts.`
      );
  const evidenceCallId = primaryCriterion?.callId ?? evidence.callSnapshots[0]?.sourceCallId;
  const steps: AgentProfileAssistantStepItem[] = [
    {
      title: tAssistantLabel(params.language, 'Causa principal', 'Main cause'),
      body: topWeakness
        ? tAssistantLabel(
            params.language,
            `El cambio se concentra en ${topWeakness}: ${causeDetail}`,
            `The movement concentrates in ${topWeakness}: ${causeDetail}`
          )
        : causeDetail,
    },
    {
      title: tAssistantLabel(params.language, 'Llamadas responsables', 'Responsible calls'),
      body: evidenceCallId
        ? tAssistantLabel(
            params.language,
            `Revisa primero ${evidenceCallId}; es la llamada con evidencia más débil dentro del rango objetivo.`,
            `Review ${evidenceCallId} first; it is the weakest-evidence call in the target range.`
          )
        : tAssistantLabel(
            params.language,
            'Hay rollup de score, pero no encontré una llamada candidata para abrir la causa.',
            'There is a score rollup, but I did not find a candidate call to inspect the cause.'
          ),
    },
    {
      title: tAssistantLabel(params.language, 'Qué coachear primero', 'What to coach first'),
      body: primaryCriterion?.improvementTip ||
        tAssistantLabel(
          params.language,
          'Coachea una explicación corta con validación antes de avanzar y cierre con siguiente paso concreto.',
          'Coach a short explanation with validation before moving on and a close with a concrete next step.'
        ),
    },
  ];
  const structuredContent = sanitizeAssistantStructuredContent({
    intro,
    blocks: [
      {
        type: 'metrics',
        items: [
          { icon: 'chart', label: baselinePoint.label, value: formatAssistantScoreMetric(baselinePoint.averageScore), tone: 'neutral' },
          { icon: 'trend', label: targetPoint.label, value: formatAssistantScoreMetric(targetPoint.averageScore), tone: delta < 0 ? 'bad' : 'good' },
          { icon: 'phone', label: tAssistantLabel(params.language, 'Llamadas', 'Calls'), value: String(targetPoint.callCount), tone: 'neutral' },
          { icon: 'flag', label: tAssistantLabel(params.language, 'Criterio', 'Criterion'), value: criterionMetric, tone: delta < 0 ? 'warning' : 'neutral' },
        ],
      },
      {
        type: 'comparison',
        leftLabel: baselinePoint.label,
        rightLabel: targetPoint.label,
        rows: [
          {
            label: tAssistantLabel(params.language, 'Score promedio', 'Average score'),
            left: formatAssistantScoreMetric(baselinePoint.averageScore),
            right: formatAssistantScoreMetric(targetPoint.averageScore),
          },
          {
            label: tAssistantLabel(params.language, 'Llamadas con score', 'Scored calls'),
            left: String(baselinePoint.callCount),
            right: String(targetPoint.callCount),
          },
          {
            label: tAssistantLabel(params.language, 'Debilidad principal', 'Main weakness'),
            left: baselinePoint.topWeaknesses[0]?.label ?? '-',
            right: topWeakness ?? '-',
          },
        ],
      },
      { type: 'steps', items: steps },
    ],
  });
  const references = [
    ...baselinePoint.references,
    ...targetPoint.references,
    ...(evidenceCallId ? [{ type: 'call' as const, id: evidenceCallId }] : []),
  ];
  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references,
  };
}

/** Builds a deterministic call-quality diagnosis from retrieved feedback and transcripts. */
function buildDeterministicCallDiagnosisResponse(params: {
  language: AgentProfileAssistantLanguage;
  context: LoadedAgentProfileAssistantContext;
}): AssistantModelJsonOutput | null {
  const plan = params.context.retrievalPlan;
  const evidence = params.context.evidenceBundle;
  if (!plan || plan.topic !== 'call_diagnosis' || !evidence) {
    return null;
  }
  if (evidence.callSnapshots.length === 0) {
    return buildAssistantMissingEvidenceResponse({
      language: params.language,
      plan,
      missing: evidence.missing.length > 0 ? evidence.missing : ['llamadas del rango pedido'],
    });
  }
  const targetFeedback = filterAssistantFeedbackByCalls(evidence.feedbackSummaries, evidence.callSnapshots);
  const primaryCriterion = selectAssistantPrimaryCriterionDrop({
    baselineSummaries: [],
    targetSummaries: targetFeedback,
  });
  const weaknessFallback = countAssistantSnapshotWeaknesses(evidence.callSnapshots)[0];
  if (!primaryCriterion && !weaknessFallback) {
    return buildAssistantMissingEvidenceResponse({
      language: params.language,
      plan,
      missing: evidence.missing.length > 0 ? evidence.missing : ['feedback/rubrica con debilidades observables'],
    });
  }
  const issueTitle = primaryCriterion?.title ?? weaknessFallback?.label ?? tAssistantLabel(params.language, 'Debilidad', 'Weakness');
  const issueDetail =
    primaryCriterion?.issue?.detail ||
    primaryCriterion?.issue?.title ||
    primaryCriterion?.improvementTip ||
    tAssistantLabel(
      params.language,
      `Aparece en ${weaknessFallback?.count ?? 1} llamada(s) del rango.`,
      `It appears in ${weaknessFallback?.count ?? 1} call(s) in the range.`
    );
  const weakestCall = primaryCriterion?.callId ?? evidence.callSnapshots[0]?.sourceCallId;
  const transcript = plan.requiresTranscripts ? evidence.transcriptSnippets[0] : null;
  const blocks: AgentProfileAssistantStructuredBlock[] = [
    {
      type: 'metrics',
      items: [
        { icon: 'phone', label: tAssistantLabel(params.language, 'Llamadas revisadas', 'Reviewed calls'), value: String(evidence.callSnapshots.length), tone: 'neutral' },
        { icon: 'chart', label: tAssistantLabel(params.language, 'Score promedio', 'Average score'), value: formatAssistantScoreMetric(averageAssistantSnapshotScore(evidence.callSnapshots)), tone: 'neutral' },
        { icon: 'flag', label: tAssistantLabel(params.language, 'Foco', 'Focus'), value: issueTitle, tone: 'warning' },
      ],
    },
    {
      type: 'steps',
      items: [
        {
          title: tAssistantLabel(params.language, 'Qué hizo mal', 'What went wrong'),
          body: issueDetail,
        },
        {
          title: tAssistantLabel(params.language, 'Dónde verlo', 'Where to see it'),
          body: weakestCall
            ? tAssistantLabel(
                params.language,
                `Empieza por la llamada ${weakestCall}; ahí está la evidencia más clara del foco.`,
                `Start with call ${weakestCall}; it has the clearest evidence for the focus.`
              )
            : tAssistantLabel(
                params.language,
                'Hay debilidad agregada, pero falta una llamada específica asociada.',
                'There is an aggregate weakness, but a specific linked call is missing.'
              ),
        },
        {
          title: tAssistantLabel(params.language, 'Qué coachear primero', 'What to coach first'),
          body: primaryCriterion?.improvementTip ||
            tAssistantLabel(
              params.language,
              'Pide que cierre cada explicación con validación del cliente y siguiente paso concreto.',
              'Ask the agent to close each explanation with customer validation and a concrete next step.'
            ),
        },
      ],
    },
  ];
  if (transcript) {
    blocks.push({
      type: 'text',
      text: tAssistantLabel(
        params.language,
        `Fragmento de conversación (${transcript.callId}): ${transcript.text}`,
        `Conversation snippet (${transcript.callId}): ${transcript.text}`
      ),
    });
  }
  const structuredContent = sanitizeAssistantStructuredContent({
    intro: tAssistantLabel(
      params.language,
      `El problema principal del rango es ${issueTitle}.`,
      `The main issue in the range is ${issueTitle}.`
    ),
    blocks,
  });
  const references = evidence.callSnapshots.slice(0, 4).map(
    /** Builds call references for the diagnosed calls. */
    (snapshot) => ({ type: 'call' as const, id: snapshot.sourceCallId })
  );
  return {
    answer: buildFallbackAnswerFromStructuredContent(structuredContent),
    ...(structuredContent ? { structuredContent } : {}),
    references,
  };
}

/** Extracts concise text from one structured response block for follow-up generation. */
function getStructuredBlockFollowUpText(block: AgentProfileAssistantStructuredBlock): string[] {
  if (block.type === 'metrics') {
    return block.items.flatMap(
      /** Extracts metric label/value text. */
      (item) => [item.label, item.value]
    );
  }
  if (block.type === 'steps') {
    return block.items.flatMap(
      /** Extracts step title/body text. */
      (item) => [item.title, item.body]
    );
  }
  if (block.type === 'comparison') {
    return [
      block.leftLabel,
      block.rightLabel,
      ...block.rows.flatMap(
        /** Extracts comparison row text. */
        (row) => [row.label, row.left, row.right]
      ),
    ];
  }
  if (block.type === 'status') {
    return [block.label, block.detail ?? ''];
  }
  return [block.text];
}

/** Builds searchable text from the assistant answer that was just generated. */
function buildLatestAssistantAnswerText(params: {
  answer: string;
  structuredContent?: AgentProfileAssistantStructuredContent;
  references: AgentProfileAssistantReference[];
}): string {
  const structuredTexts = params.structuredContent?.blocks.flatMap(
    /** Extracts text from one structured content block. */
    (block) => getStructuredBlockFollowUpText(block)
  ) ?? [];
  const referenceTexts = params.references.map(
    /** Extracts reference labels for follow-up generation. */
    (reference) => reference.label
  );
  return [
    params.answer,
    params.structuredContent?.intro,
    params.structuredContent?.outro,
    ...structuredTexts,
    ...referenceTexts,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');
}

/** Extracts a metric value from the latest structured answer by label text. */
function findAssistantMetricValue(
  structuredContent: AgentProfileAssistantStructuredContent | undefined,
  labelTerms: string[]
): string | null {
  const metricBlocks = structuredContent?.blocks.filter(
    /** Keeps metric blocks only. */
    (block): block is Extract<AgentProfileAssistantStructuredBlock, { type: 'metrics' }> =>
      block.type === 'metrics'
  ) ?? [];
  for (const block of metricBlocks) {
    const found = block.items.find(
      /** Finds a metric whose label matches the requested semantic terms. */
      (item) => includesAnyIntentTerm(normalizeIntentText(item.label), labelTerms)
    );
    if (found?.value) {
      return sanitizeStructuredString(found.value, 70);
    }
  }
  return null;
}

/** Returns the first referenced call id from the answer that was just generated. */
function findAssistantReferencedCallId(references: AgentProfileAssistantReference[]): string | null {
  return references.find(
    /** Finds the first call reference in the latest assistant answer. */
    (reference) => reference.type === 'call'
  )?.id ?? null;
}

/** Checks whether the latest assistant answer is primarily a missing-data result. */
function latestAnswerNeedsMissingDataFollowUps(normalizedAnswer: string): boolean {
  return includesAnyIntentTerm(normalizedAnswer, [
    'datos insuficientes',
    'falta evidencia',
    'falta:',
    'faltan datos',
    'no tengo datos suficientes',
    'missing evidence',
    'missing:',
    'not enough data',
  ]);
}

/** Sanitizes and deduplicates generated follow-up question strings. */
function finalizeAssistantFollowUpQuestions(questions: string[]): string[] {
  return sanitizeAssistantSuggestedQuestions(questions) ?? [];
}

/** Builds follow-up chips from the assistant's latest answer, not from static defaults. */
function buildAssistantFollowUpQuestions(params: {
  language: AgentProfileAssistantLanguage;
  answer: string;
  structuredContent?: AgentProfileAssistantStructuredContent;
  references: AgentProfileAssistantReference[];
  context: LoadedAgentProfileAssistantContext;
  intent: AssistantQuestionIntent;
}): string[] {
  const latestAnswerText = buildLatestAssistantAnswerText({
    answer: params.answer,
    structuredContent: params.structuredContent,
    references: params.references,
  });
  const normalizedAnswer = normalizeIntentText(latestAnswerText);
  const topic = params.context.retrievalPlan?.topic;
  const criterion = findAssistantMetricValue(params.structuredContent, ['criterio', 'criterion', 'foco', 'focus']);
  const callId = params.context.evidenceBundle?.callSnapshots[0]?.sourceCallId ??
    findAssistantReferencedCallId(params.references);

  if (latestAnswerNeedsMissingDataFollowUps(normalizedAnswer)) {
    return finalizeAssistantFollowUpQuestions([
      tAssistantLabel(params.language, '¿Qué datos faltan exactamente?', 'What exact data is missing?'),
      tAssistantLabel(params.language, '¿Qué puedo analizar con lo que sí existe?', 'What can we analyze with the data we do have?'),
      tAssistantLabel(params.language, '¿Hay llamadas sin rúbrica o transcripción?', 'Are there calls missing rubric or transcript data?'),
      tAssistantLabel(params.language, '¿Cómo actualizo este perfil?', 'How do I refresh this profile?'),
    ]);
  }

  if (topic === 'score_progression' || params.intent.domain === 'score_progression') {
    return finalizeAssistantFollowUpQuestions([
      tAssistantLabel(params.language, '¿Qué criterio jaló más el score?', 'Which criterion pulled the score the most?'),
      callId
        ? tAssistantLabel(params.language, `¿Por qué reviso primero la llamada ${callId}?`, `Why should I review call ${callId} first?`)
        : tAssistantLabel(params.language, '¿Qué llamada reviso primero y por qué?', 'Which call should I review first and why?'),
      criterion
        ? tAssistantLabel(params.language, `¿Qué frase exacta le digo para corregir ${criterion}?`, `What exact phrase should I use to correct ${criterion}?`)
        : tAssistantLabel(params.language, '¿Qué frase exacta le digo al agente?', 'What exact phrase should I tell the agent?'),
      tAssistantLabel(params.language, '¿Qué cambió contra el rango anterior?', 'What changed versus the previous range?'),
    ]);
  }

  if (topic === 'performance_analysis' || params.intent.domain === 'performance_analysis') {
    return finalizeAssistantFollowUpQuestions([
      tAssistantLabel(params.language, '¿Qué llamadas hicieron que ese día fuera el peor?', 'Which calls made that day the worst?'),
      tAssistantLabel(params.language, '¿Qué criterio se repitió más ese día?', 'Which criterion repeated most that day?'),
      criterion
        ? tAssistantLabel(params.language, `¿Qué frase practico para ${criterion}?`, `What phrase should we practice for ${criterion}?`)
        : tAssistantLabel(params.language, '¿Qué frase exacta practico para ese patrón?', 'What exact phrase should we practice for that pattern?'),
      tAssistantLabel(params.language, '¿Cómo se compara contra el mejor día?', 'How does it compare against the best day?'),
    ]);
  }

  if (topic === 'call_diagnosis' || includesAnyIntentTerm(normalizedAnswer, ['que hizo mal', 'what went wrong'])) {
    return finalizeAssistantFollowUpQuestions([
      tAssistantLabel(params.language, '¿Cuál fue la evidencia exacta?', 'What was the exact evidence?'),
      callId
        ? tAssistantLabel(params.language, `¿Qué pasó en la llamada ${callId}?`, `What happened in call ${callId}?`)
        : tAssistantLabel(params.language, '¿Qué llamada reviso primero?', 'Which call should I review first?'),
      tAssistantLabel(params.language, '¿Qué frase alternativa debía usar?', 'What alternative phrase should the agent have used?'),
      tAssistantLabel(params.language, '¿Cómo lo coacheo en 10 minutos?', 'How do I coach this in 10 minutes?'),
    ]);
  }

  if (params.intent.domain === 'reminders' || params.references.some(
    /** Checks whether the latest answer referenced reminders. */
    (reference) => reference.type === 'reminder'
  )) {
    return finalizeAssistantFollowUpQuestions([
      tAssistantLabel(params.language, '¿Qué cliente es más urgente?', 'Which customer is most urgent?'),
      tAssistantLabel(params.language, '¿Qué mensaje de WhatsApp le mando?', 'What WhatsApp message should I send?'),
      tAssistantLabel(params.language, '¿Qué seguimiento está vencido?', 'Which follow-up is overdue?'),
      tAssistantLabel(params.language, '¿Qué llamada originó este pendiente?', 'Which call created this pending item?'),
    ]);
  }

  if (params.intent.domain === 'sales' || params.references.some(
    /** Checks whether the latest answer referenced sales rollups. */
    (reference) => reference.type === 'sales_rollup'
  )) {
    return finalizeAssistantFollowUpQuestions([
      tAssistantLabel(params.language, '¿Qué venta o seguimiento pesa más?', 'Which sale or follow-up matters most?'),
      tAssistantLabel(params.language, '¿Qué cliente tiene mayor oportunidad?', 'Which customer has the biggest opportunity?'),
      tAssistantLabel(params.language, '¿Qué debe revisar antes de cerrar?', 'What should the agent review before closing?'),
      tAssistantLabel(params.language, '¿Qué le digo al agente comercialmente?', 'What should I tell the agent commercially?'),
    ]);
  }

  if (params.intent.domain === 'coaching' || params.references.some(
    /** Checks whether the latest answer referenced a coaching report. */
    (reference) => reference.type === 'report'
  )) {
    return finalizeAssistantFollowUpQuestions([
      tAssistantLabel(params.language, '¿Qué frase exacta le digo al agente?', 'What exact phrase should I tell the agent?'),
      tAssistantLabel(params.language, '¿Cómo practico este foco en llamada?', 'How do we practice this focus in a call?'),
      tAssistantLabel(params.language, '¿En qué llamadas se ve este patrón?', 'Which calls show this pattern?'),
      tAssistantLabel(params.language, '¿Qué mido para saber si mejoró?', 'What do I measure to know it improved?'),
    ]);
  }

  return finalizeAssistantFollowUpQuestions([
    tAssistantLabel(params.language, '¿Qué parte de esta respuesta revisamos primero?', 'Which part of this answer should we review first?'),
    tAssistantLabel(params.language, '¿Qué evidencia sostiene ese punto?', 'What evidence supports that point?'),
    tAssistantLabel(params.language, '¿Qué acción concreta sigue?', 'What concrete action comes next?'),
    tAssistantLabel(params.language, '¿Qué dato falta para confirmarlo?', 'What data is missing to confirm it?'),
  ]);
}

/** Builds a conservative coaching fallback when OpenAI is temporarily unavailable. */
function buildRetryableCoachingFallbackResponse(params: {
  language: AgentProfileAssistantLanguage;
  latestReport: NormalizedLatestReportContext | null;
  intent: AssistantQuestionIntent;
  recentMessages: AgentProfileAssistantChatMessage[];
}): AssistantModelJsonOutput | null {
  if (params.intent.domain !== 'coaching' || !params.latestReport) {
    return null;
  }
  return buildDeterministicCoachingCountResponse({
    language: params.language,
    latestReport: params.latestReport,
    intent: {
      ...params.intent,
      requestedCount: params.intent.requestedCount ?? 1,
      wantsDistinctFromRecent: params.intent.wantsDistinctFromRecent,
    },
    recentMessages: params.recentMessages,
  });
}

/** Routes stable assistant domains through deterministic builders before using OpenAI. */
function buildDeterministicAssistantServerResponse(params: {
  language: AgentProfileAssistantLanguage;
  context: LoadedAgentProfileAssistantContext;
  intent: AssistantQuestionIntent;
  recentMessages: AgentProfileAssistantChatMessage[];
  question: string;
}): AssistantModelJsonOutput | null {
  if (!params.intent.supported) {
    return buildUnsupportedAssistantResponse(params.language);
  }

  const smallTalkOutput = params.intent.inheritedDomain
    ? null
    : buildDeterministicSmallTalkResponse({
        language: params.language,
        question: params.question,
      });

  return buildDeterministicPerformanceAnalysisResponse({
    language: params.language,
    context: params.context,
  }) ?? buildDeterministicScoreProgressionResponse({
    language: params.language,
    context: params.context,
  }) ?? buildDeterministicCallDiagnosisResponse({
    language: params.language,
    context: params.context,
  }) ?? buildDeterministicHelpResponse({
    language: params.language,
    question: params.question,
  }) ?? buildDeterministicUtilityResponse({
    language: params.language,
    question: params.question,
    recentMessages: params.recentMessages,
  }) ?? buildDeterministicCoachingTechniqueResponse({
    language: params.language,
    latestReport: params.context.latestReport,
    intent: params.intent,
    question: params.question,
  }) ?? buildDeterministicCoachingDraftResponse({
    language: params.language,
    latestReport: params.context.latestReport,
    intent: params.intent,
    question: params.question,
  }) ?? smallTalkOutput ?? buildDeterministicProfileSummaryResponse({
    language: params.language,
    context: params.context,
    question: params.question,
  }) ?? buildDeterministicReminderResponse({
    language: params.language,
    context: params.context,
    intent: params.intent,
    question: params.question,
  }) ?? buildDeterministicSalesResponse({
    language: params.language,
    context: params.context,
    intent: params.intent,
  }) ?? buildDeterministicStepDetailResponse({
    language: params.language,
    latestReport: params.context.latestReport,
    recentMessages: params.recentMessages,
    question: params.question,
  }) ?? buildDeterministicCoachingPlanResponse({
    language: params.language,
    latestReport: params.context.latestReport,
    intent: params.intent,
  }) ?? buildDeterministicNextCoachingResponse({
    language: params.language,
    latestReport: params.context.latestReport,
    intent: params.intent,
    recentMessages: params.recentMessages,
  }) ?? buildDeterministicCoachingEvidenceResponse({
    language: params.language,
    latestReport: params.context.latestReport,
    intent: params.intent,
    question: params.question,
  }) ?? buildDeterministicCoachingCountResponse({
    language: params.language,
    latestReport: params.context.latestReport,
    intent: params.intent,
    recentMessages: params.recentMessages,
  });
}

export function buildAssistantSystemPrompt(language: AgentProfileAssistantLanguage): string {
  const typeList = VALID_ASSISTANT_REFERENCE_TYPES.join('|');
  const iconList = VALID_ASSISTANT_STRUCTURED_ICONS.join('|');
  const toneList = VALID_ASSISTANT_STRUCTURED_TONES.join('|');
  const jsonShape = [
    '{',
    '  "answer": "plain-text fallback for storage and history",',
    '  "intro": "one or two short contextual sentences",',
    '  "blocks": [',
    '    { "type": "metrics", "items": [{ "icon": "' + iconList + '", "label": "string", "value": "string", "tone": "' + toneList + '" }] },',
    '    { "type": "steps", "items": [{ "title": "key concept", "body": "short explanation" }] },',
    '    { "type": "comparison", "leftLabel": "string", "rightLabel": "string", "rows": [{ "label": "string", "left": "string", "right": "string" }] },',
    '    { "type": "status", "label": "string", "tone": "' + toneList + '", "detail": "optional short detail" },',
    '    { "type": "text", "text": "single short clarification" }',
    '  ],',
    '  "outro": "optional short closing sentence",',
    '  "references": [{ "type": "' + typeList + '", "id": "string" }]',
    '}',
  ].join('\n');

  if (language === 'en') {
    return [
      'You are an assistant embedded inside a single agent profile page.',
      'You may only answer using the provided current-profile context in the user message.',
      'If the user asks about other agents, team-wide comparisons, or data not present, clearly say V1 only has the current profile context.',
      'Do not invent scores, dates, calls, reminders, sales outcomes, trends, or evidence.',
      'You may explain static KESP UI concepts (e.g., what “Reporte de patrones” means) even when report data is missing.',
      'Mandatory structure: start with one direct intro sentence, then put the important information in typed blocks.',
      'Do not include source explanations in intro. Do not say “based on the report/current context/source” unless the user explicitly asks for source or evidence.',
      'Use metrics blocks for numbers, scores, counts, dates, amounts, or measurable facts; do not bury those values inside intro prose.',
      'Metrics must stay short: counts, scores, dates, amounts, or one-word/short-label states only. Put long priority names, coaching rationale, or recommendation text in status, steps, or intro.',
      'Use steps blocks for lists, recommendations, coaching actions, or process answers; each item needs a short title and body.',
      'Use comparison blocks for A vs. B answers instead of prose.',
      'Use status blocks for good/bad, high/low, complete/pending, available/missing, or similar outcomes.',
      'Use text blocks only for a single short clarification that does not need stronger structure.',
      'Use at most 3 blocks total and at most 4 items in any block. If the answer needs more, prioritize the useful parts and omit the rest.',
      'Source hierarchy is mandatory: retrievalPlan/evidenceBundle is primary for score progression, period performance analysis, call diagnosis, requested evidence, and transcript-level questions; latestReport.patterns are the primary source for broad coaching priorities; reminders are the only source for reminder questions; salesRollups are the source for sales totals.',
      'For score/progression questions, answer as cause + actions when evidence exists: main cause, comparative numbers, responsible calls/criteria, concrete evidence, and what to coach first.',
      'For worst/best day, daily trend, or pattern-driver questions, answer from rollups first, then selected-period calls and rubric: period, score, range comparison, responsible pattern/call, and first coaching action.',
      'Recent chat is not a source of truth. It may include older experimental assistant answers, so use it only to understand what has already been said and to avoid repetition.',
      'The latest user message wins. If it explicitly changes from reminders to coaching or sales, answer the new topic instead of continuing the old one.',
      'Read questionIntent before answering. If questionIntent.supported=false, do not answer with generic advice; say the information cannot be answered from the current profile data and offer coaching, reminders, sales, or pattern report topics.',
      'If questionIntent.supported=true and questionIntent.domain="unknown", do not refuse just because routing is uncertain. Interpret the message as a current-profile question when plausible, choose the most relevant available profile context, and answer. If it is clearly unrelated to the current profile, briefly say this assistant only has current-profile context.',
      'If questionIntent.requestedCount is set, return exactly that many step items when enough distinct supported items exist; otherwise say how many are available and do not invent the rest.',
      'If questionIntent.wantsDistinctFromRecent=true, exclude recommendations already given in recentChat.',
      'If the latest user message is ambiguous, such as “which one”, “why”, “the most important one”, or “what about that”, inherit the topic from the immediately previous user message.',
      'Respect the exact scope and quantity requested by the latest user message, especially in follow-ups.',
      'If the user asks for one thing, the most important thing, the main priority, or “which one”, choose exactly one and do not restate a top 3 or alternatives.',
      'If the user asks for top 3, exactly 3 things, or multiple priorities, return that exact count when the context contains enough distinct supported items.',
      'If the user asks “what else”, “another one”, or “next”, provide the next distinct supported item, not the same item again.',
      'If the user narrows a previous list, answer only the narrowed request instead of repeating the earlier list.',
      'Explanation quality rule: do not make circular feedback. If the source label or user wording says unclear, confusing, weak, inconsistent, generic, or poor, explain the observable cause instead of repeating the label.',
      'For "what was confusing/unclear/weak" questions, name the concrete issue: sequence jumped, amount/term/requirement was missing or late, objection was not answered, or no precise next step was set. Use only issues supported by context.',
      'For "what could I say instead" questions, give a natural copy-ready phrase before any explanation.',
      'For coaching, prioritization, or “what would you change” questions, answer with up to 3 steps only when the user asks for multiple actions.',
      'For “what should I focus on and why”, “main focus”, or “single priority” questions, return one focus only: intro = the focus, metrics = short evidence, status = why it matters. Do not add a 3-step plan unless the user asks how to practice it.',
      'For “what do I send/say/write” questions, answer with the actual draft first in a text block; do not turn it into generic steps.',
      'For broad summaries, use metrics + one coaching focus instead of many blocks.',
      'For weekly or long plans, group the plan into 3 or 4 phases instead of creating a card for every day unless the user explicitly asks for a day-by-day plan.',
      'For reminder overdue questions, only say a reminder is overdue when an explicit due date/time exists and proves it; if the due date is missing, say the due date is missing.',
      'Translate internal action keys into readable labels before showing them, for example send_whatsapp means send WhatsApp.',
      'Keep every field short and avoid filler.',
      'The answer field must be a concise plain-text fallback that preserves the same facts as intro + blocks + outro.',
      'Do not start with scope caveats when the question is about the current agent; mention V1 limits only when the user asks for other agents, team comparisons, or missing data.',
      'Return ONLY valid JSON with this shape:',
      jsonShape,
    ].join('\n');
  }

  return [
    'Responde en español.',
    'Eres un asistente dentro del perfil de un solo agente.',
    'Solo puedes responder usando el contexto del perfil actual provisto en el mensaje del usuario.',
    'Si te preguntan por otros agentes, comparaciones de equipo, o datos no presentes, explica que V1 solo tiene el contexto del perfil actual.',
    'No inventes puntajes, fechas, llamadas, recordatorios, ventas, tendencias, ni evidencia.',
    'Puedes explicar conceptos estáticos de la UI de KESP (por ejemplo, qué significa “Reporte de patrones”) aunque falte el reporte.',
    'Estructura obligatoria: empieza con una sola frase directa de intro y luego pon la información importante en bloques tipados.',
    'No expliques fuentes en el intro. No digas “basado en el reporte/contexto/fuente” salvo que el usuario pida evidencia o fuente explícitamente.',
    'Usa bloques metrics para números, scores, conteos, fechas, montos o hechos medibles; no escondas esos valores dentro de la intro.',
    'Las métricas deben ser cortas: conteos, scores, fechas, montos o estados de una palabra/frase corta. Pon nombres largos de prioridades, razones de coaching o recomendaciones en status, steps o intro.',
    'Usa bloques steps para listas, recomendaciones, acciones de coaching o procesos; cada item necesita título corto y explicación.',
    'Usa bloques comparison para respuestas de esto vs. aquello en lugar de prosa.',
    'Usa bloques status para bien/mal, alto/bajo, completo/pendiente, disponible/faltante o resultados similares.',
    'Usa bloques text solo para una aclaración corta que no necesita estructura fuerte.',
    'Usa máximo 3 bloques en total y máximo 4 items en cualquier bloque. Si la respuesta necesita más, prioriza lo útil y omite el resto.',
    'La jerarquía de fuentes es obligatoria: retrievalPlan/evidenceBundle es la fuente principal para progresión de score, análisis de desempeño por periodo, diagnóstico de llamadas, evidencia solicitada y preguntas de transcripción; latestReport.patterns es la fuente principal para prioridades amplias de coaching; reminders es la única fuente para recordatorios; salesRollups es la fuente para ventas.',
    'Para preguntas de score/progresión, responde como causa + acciones cuando haya evidencia: causa principal, números comparativos, llamadas/criterios responsables, evidencia concreta y qué coachear primero.',
    'Para preguntas de peor/mejor día, tendencia diaria o patrones que frenan, responde desde rollups primero y luego llamadas/rúbrica del periodo seleccionado: periodo, score, comparación contra el rango, patrón/llamada responsable y primera acción de coaching.',
    'El historial reciente no es fuente de verdad. Puede contener respuestas experimentales anteriores, así que úsalo solo para saber qué ya se dijo y evitar repetición.',
      'El último mensaje del usuario manda. Si cambia explícitamente de recordatorios a coaching o ventas, responde el tema nuevo en vez de continuar el anterior.',
      'Lee questionIntent antes de responder. Si questionIntent.supported=false, no contestes con consejo genérico; di que no se puede responder esa información con los datos del perfil actual y ofrece temas de coaching, recordatorios, ventas o reporte de patrones.',
      'Si questionIntent.supported=true y questionIntent.domain="unknown", no rechaces solo porque el ruteo es incierto. Interpreta el mensaje como pregunta del perfil actual cuando sea razonable, elige el contexto disponible más relevante y responde. Si claramente no tiene relación con el perfil actual, di brevemente que este asistente solo tiene contexto del perfil actual.',
      'Si questionIntent.requestedCount existe, devuelve exactamente esa cantidad de steps cuando haya suficientes puntos distintos soportados; si no alcanza, di cuántos hay y no inventes el resto.',
    'Si questionIntent.wantsDistinctFromRecent=true, excluye recomendaciones ya dadas en recentChat.',
    'Si el último mensaje es ambiguo, como “cuál”, “por qué”, “el más importante” o “y eso”, hereda el tema del mensaje inmediatamente anterior del usuario.',
    'Respeta el alcance y la cantidad exacta que pide el último mensaje del usuario, especialmente en seguimientos.',
    'Si el usuario pide una cosa, la más importante, la prioridad principal o “cuál”, elige exactamente una y no repitas un top 3 ni alternativas.',
    'Si el usuario pide top 3, exactamente 3 cosas o varias prioridades, devuelve esa cantidad exacta cuando el contexto tenga suficientes puntos distintos soportados.',
    'Si el usuario pregunta “qué más”, “otra cosa” o “siguiente”, da el siguiente punto distinto soportado, no el mismo punto otra vez.',
    'Si el usuario acota una lista previa, responde solo lo acotado en vez de repetir la lista anterior.',
    'Regla de calidad de explicación: no hagas feedback circular. Si la etiqueta de la fuente o el usuario dice poco claro, confuso, débil, inconsistente, genérico o malo, explica la causa observable en vez de repetir la etiqueta.',
    'Para preguntas de “qué fue confuso/poco claro/débil”, nombra el problema concreto: se brincó la secuencia, faltó o llegó tarde el monto/plazo/requisito, no se respondió la objeción o no quedó siguiente paso preciso. Usa solo problemas soportados por el contexto.',
    'Para preguntas de “qué pude decir en vez”, entrega primero una frase natural lista para copiar antes de explicar.',
    'Para coaching, prioridades o preguntas de “qué cambiarías”, responde con máximo 3 steps solo cuando el usuario pida varias acciones.',
    'Para preguntas de “en qué me enfoco y por qué”, “foco principal” o “una prioridad”, devuelve un solo foco: intro = el foco, metrics = evidencia corta, status = por qué importa. No agregues plan de 3 pasos salvo que el usuario pregunte cómo practicarlo.',
    'Para preguntas de “qué le digo/envío/escribo”, responde primero con el borrador real en un bloque text; no lo conviertas en pasos genéricos.',
    'Para resúmenes generales, usa metrics + un foco de coaching en vez de muchos bloques.',
    'Para planes semanales o largos, agrupa el plan en 3 o 4 fases en vez de crear una tarjeta por día, salvo que el usuario pida explícitamente día por día.',
    'Para preguntas de recordatorios vencidos, solo digas que venció si hay fecha/hora explícita que lo pruebe; si falta fecha, di que falta fecha.',
    'Traduce claves internas antes de mostrarlas: por ejemplo send_whatsapp significa enviar WhatsApp.',
    'Mantén cada campo corto y evita relleno.',
    'El campo answer debe ser un fallback de texto plano y conciso con los mismos hechos que intro + blocks + outro.',
    'No empieces con aclaraciones de alcance si la pregunta es sobre el agente actual; menciona límites de V1 solo cuando pidan otros agentes, comparaciones de equipo o datos faltantes.',
    'Devuelve SOLO JSON válido con esta forma:',
    jsonShape,
  ].join('\n');
}

export function buildAssistantUserPrompt(params: {
  language: AgentProfileAssistantLanguage;
  identity: AgentProfileAssistantChatIdentity;
  context: LoadedAgentProfileAssistantContext;
  compactedSummary: string | undefined;
  recentMessages: AgentProfileAssistantChatMessage[];
  question: string;
}): string {
  const { language, identity, context, compactedSummary, recentMessages, question } = params;
  const questionIntent = buildAssistantQuestionIntent({ language, question, recentMessages });

  const uiGlossary =
    language === 'en'
      ? {
          carga: 'Upload calls and (optionally) trigger a pattern report for this agent profile.',
          reporte_de_patrones:
            'Pattern report summarizing recurring coaching patterns detected from calls linked to this agent profile.',
          recordatorio_de_llamadas:
            'Reminders and follow-ups derived from this agent’s recent calls (open/past reminders).',
          progresion_del_supervisor:
            'Supervisor view of progress and sales rollups derived from this agent’s activity.',
        }
      : {
          carga: 'Sube llamadas y (opcionalmente) genera el reporte de patrones de este perfil.',
          reporte_de_patrones:
            'Reporte que resume patrones recurrentes de coaching detectados en las llamadas vinculadas a este perfil.',
          recordatorio_de_llamadas:
            'Recordatorios y seguimientos derivados de las llamadas recientes de este agente (abiertos y recientes).',
          progresion_del_supervisor:
            'Vista del supervisor con rollups de progreso y ventas derivados de la actividad del agente.',
        };

  const serializedContext = {
    currentDate: getAssistantBusinessDate(),
    currentTimeZone: ASSISTANT_CONTEXT_TIME_ZONE,
    sourceGuide: buildAssistantSourceGuide(language),
    uiGlossary,
    identity: {
      profileScope: identity.profileScope,
      agentAnalysisId: identity.agentAnalysisId,
      salesAgentId: identity.salesAgentId,
      salesAgentName: identity.salesAgentNameSnapshot,
      externalAgentSource: identity.externalAgentSource,
      externalAgentId: identity.externalAgentId,
    },
    contextSummary: context.contextSummary,
    latestReport: context.latestReport,
    callSnapshots: context.callSnapshots,
    reminders: context.reminders,
    progressRollups: context.progressRollups,
    salesRollups: context.salesRollups,
    retrievalPlan: context.retrievalPlan ?? null,
    evidenceBundle: context.evidenceBundle ?? null,
    compactedChatSummary: compactedSummary ?? null,
    recentChat: recentMessages.map((message) => ({
      role: message.role,
      content: message.content,
      createdAtMs: message.createdAtMs,
    })),
    questionIntent,
    question,
  };

  const instruction = tAssistantLabel(
    language,
    'Usa solo el JSON de contexto, sigue sourceGuide y obedece questionIntent. La pregunta actual manda, pero si es ambigua hereda el tema del turno anterior. Si retrievalPlan/evidenceBundle existe, úsalo primero para análisis de score, llamadas, evidencia o transcripción; si faltan datos, di exactamente qué falta. Para coaching amplio usa latestReport.patterns en orden; para recordatorios usa reminders; para ventas usa salesRollups. Devuelve máximo 3 bloques. Métricas van en metrics, recomendaciones en steps, comparaciones en comparison y resultados en status. Respeta la cantidad exacta pedida: si piden top 3, da 3; si piden la más importante o una prioridad, elige una sola dentro del tema correcto; si piden otra cosa, da un punto distinto ya soportado.',
    'Use only the context JSON, follow sourceGuide, and obey questionIntent. The current question wins, but if it is ambiguous inherit the previous turn topic. If retrievalPlan/evidenceBundle exists, use it first for score, call, evidence, or transcript analysis; if data is missing, say exactly what is missing. For broad coaching use latestReport.patterns in order; for reminders use reminders; for sales use salesRollups. Return at most 3 blocks. Metrics go in metrics, recommendations in steps, comparisons in comparison, and outcomes in status. Respect the exact requested quantity: if they ask for top 3, give 3; if they ask for the most important thing or one priority, choose only one within the correct topic; if they ask for something else, give a distinct supported point.'
  );

  const qualityInstruction = tAssistantLabel(
    language,
    'Calidad de explicación: evita feedback circular. No expliques “fue confuso” diciendo “hubo tramos confusos”; tradúcelo a causa observable, impacto y una frase alternativa natural si aplica.',
    'Explanation quality: avoid circular feedback. Do not explain “it was confusing” by saying “there were confusing parts”; translate it into observable cause, impact, and a natural alternative phrase when relevant.'
  );

  return `## Context JSON\n\n${JSON.stringify(serializedContext)}\n\n## Instruction\n\n${instruction}\n${qualityInstruction}`;
}

/** Trims a model-provided display string to the structured response limit. */
function sanitizeStructuredString(value: unknown, maxChars = ASSISTANT_MAX_STRUCTURED_TEXT_CHARS): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return '';
  }
  return text.length > maxChars ? text.slice(0, maxChars).trim() : text;
}

/** Keeps the model intro to the first useful sentence so chat bubbles stay scannable. */
function sanitizeStructuredIntro(value: unknown): string {
  const text = sanitizeStructuredString(value, ASSISTANT_MAX_STRUCTURED_TEXT_CHARS);
  if (!text) {
    return '';
  }
  const firstSentenceMatch = text.match(/^.+?[.!?](?:\s|$)/);
  const firstSentence = firstSentenceMatch?.[0]?.trim() || text;
  if (firstSentence.length <= ASSISTANT_MAX_STRUCTURED_INTRO_CHARS) {
    return firstSentence;
  }
  const trimmed = firstSentence.slice(0, ASSISTANT_MAX_STRUCTURED_INTRO_CHARS).trim();
  const lastSpace = trimmed.lastIndexOf(' ');
  return `${trimmed.slice(0, lastSpace > 80 ? lastSpace : trimmed.length).trim()}...`;
}

/** Coerces model-provided status and metric tones into supported UI tones. */
function sanitizeStructuredTone(value: unknown): AgentProfileAssistantStructuredTone {
  return typeof value === 'string' &&
    VALID_ASSISTANT_STRUCTURED_TONES.includes(value as AgentProfileAssistantStructuredTone)
    ? (value as AgentProfileAssistantStructuredTone)
    : 'neutral';
}

/** Coerces model-provided metric icons into supported KESP icons. */
function sanitizeStructuredIcon(value: unknown): AgentProfileAssistantStructuredIcon {
  return typeof value === 'string' &&
    VALID_ASSISTANT_STRUCTURED_ICONS.includes(value as AgentProfileAssistantStructuredIcon)
    ? (value as AgentProfileAssistantStructuredIcon)
    : 'info';
}

/** Sanitizes a metrics block for safe Firestore persistence and UI rendering. */
function sanitizeMetricsBlock(
  record: Record<string, unknown>,
  options: AssistantStructuredSanitizeOptions
): AgentProfileAssistantStructuredBlock | null {
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items = rawItems
    .map(
      /** Handles the callback for this operation. */
      (item) => {
        if (!item || typeof item !== 'object') {
          return undefined;
        }
        const itemRecord = item as Record<string, unknown>;
        const label = sanitizeStructuredString(itemRecord.label, 80);
        const value = sanitizeStructuredString(itemRecord.value, 80);
        if (!value) {
          return undefined;
        }
        const tone = sanitizeStructuredTone(itemRecord.tone);
        return {
          label,
          value,
          icon: sanitizeStructuredIcon(itemRecord.icon),
          tone,
        };
      }
    )
    .filter((item): item is AgentProfileAssistantMetricItem => Boolean(item))
    .slice(0, options.maxItems);

  return items.length > 0 ? { type: 'metrics', items } : null;
}

/** Sanitizes a steps block for safe Firestore persistence and UI rendering. */
function sanitizeStepsBlock(
  record: Record<string, unknown>,
  options: AssistantStructuredSanitizeOptions
): AgentProfileAssistantStructuredBlock | null {
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items = rawItems
    .map(
      /** Handles the callback for this operation. */
      (item) => {
        if (!item || typeof item !== 'object') {
          return undefined;
        }
        const itemRecord = item as Record<string, unknown>;
        const title = sanitizeStructuredString(itemRecord.title, 120);
        const body = sanitizeStructuredString(itemRecord.body, 360) ||
          sanitizeStructuredString(itemRecord.description, 360);
        if (!title || !body) {
          return undefined;
        }
        return { title, body };
      }
    )
    .filter((item): item is AgentProfileAssistantStepItem => Boolean(item))
    .slice(0, options.maxItems);

  return items.length > 0 ? { type: 'steps', items } : null;
}

/** Sanitizes a comparison block for safe Firestore persistence and UI rendering. */
function sanitizeComparisonBlock(
  record: Record<string, unknown>,
  options: AssistantStructuredSanitizeOptions
): AgentProfileAssistantStructuredBlock | null {
  const leftLabel = sanitizeStructuredString(record.leftLabel, 80);
  const rightLabel = sanitizeStructuredString(record.rightLabel, 80);
  const rawRows = Array.isArray(record.rows) ? record.rows : [];
  const rows = rawRows
    .map(
      /** Handles the callback for this operation. */
      (row) => {
        if (!row || typeof row !== 'object') {
          return undefined;
        }
        const rowRecord = row as Record<string, unknown>;
        const label = sanitizeStructuredString(rowRecord.label, 100);
        const left = sanitizeStructuredString(rowRecord.left, 220);
        const right = sanitizeStructuredString(rowRecord.right, 220);
        if (!label || (!left && !right)) {
          return undefined;
        }
        return { label, left, right };
      }
    )
    .filter((row): row is AgentProfileAssistantComparisonRow => Boolean(row))
    .slice(0, options.maxItems);

  return leftLabel && rightLabel && rows.length > 0
    ? { type: 'comparison', leftLabel, rightLabel, rows }
    : null;
}

/** Sanitizes a status block for safe Firestore persistence and UI rendering. */
function sanitizeStatusBlock(record: Record<string, unknown>): AgentProfileAssistantStructuredBlock | null {
  const label = sanitizeStructuredString(record.label, 120);
  const detail = sanitizeStructuredString(record.detail, 360);
  if (!label) {
    return null;
  }
  return {
    type: 'status',
    label,
    tone: sanitizeStructuredTone(record.tone),
    ...(detail ? { detail } : {}),
  };
}

/** Sanitizes a freeform text block for safe Firestore persistence and UI rendering. */
function sanitizeTextBlock(record: Record<string, unknown>): AgentProfileAssistantStructuredBlock | null {
  const text = sanitizeStructuredString(record.text) || sanitizeStructuredString(record.content);
  return text ? { type: 'text', text } : null;
}

/** Sanitizes a table-shaped block into the existing comparison component contract. */
function sanitizeTableBlock(
  record: Record<string, unknown>,
  options: AssistantStructuredSanitizeOptions
): AgentProfileAssistantStructuredBlock | null {
  const headers = Array.isArray(record.headers)
    ? record.headers
        .map(
          /** Handles the callback for this operation. */
          (header) => sanitizeStructuredString(header, 80)
        )
        .filter(Boolean)
    : [];
  const rawRows = Array.isArray(record.rows) ? record.rows : [];
  const rows = rawRows
    .map(
      /** Handles the callback for this operation. */
      (row) => {
        const cells = Array.isArray(row)
          ? row.map(
              /** Handles the callback for this operation. */
              (cell) => sanitizeStructuredString(cell, 220)
            )
          : [];
        if (cells.length < 2) {
          return undefined;
        }
        if (cells.length >= 3) {
          return {
            label: cells[0] || '-',
            left: cells[1] || '-',
            right: cells[2] || '-',
          };
        }
        return {
          label: cells[0] || '-',
          left: '',
          right: cells[1] || '-',
        };
      }
    )
    .filter((row): row is AgentProfileAssistantComparisonRow => Boolean(row))
    .slice(0, options.maxItems);

  if (rows.length === 0) {
    return null;
  }

  return {
    type: 'comparison',
    leftLabel: headers.length >= 3 ? headers[1] : '',
    rightLabel: headers.length >= 3 ? headers[2] : headers[1] || 'Valor',
    rows,
  };
}

/** Sanitizes a callout-shaped block into the existing status component contract. */
function sanitizeCalloutBlock(record: Record<string, unknown>): AgentProfileAssistantStructuredBlock | null {
  const label = sanitizeStructuredString(record.title, 120) || sanitizeStructuredString(record.label, 120);
  const detail = sanitizeStructuredString(record.text, 360) || sanitizeStructuredString(record.detail, 360);
  if (!label) {
    return null;
  }
  return {
    type: 'status',
    label,
    tone: sanitizeStructuredTone(record.tone),
    ...(detail ? { detail } : {}),
  };
}

/** Sanitizes one model-provided structured response block. */
function sanitizeStructuredBlock(
  value: unknown,
  options: AssistantStructuredSanitizeOptions
): AgentProfileAssistantStructuredBlock | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case 'metrics':
      return sanitizeMetricsBlock(record, options);
    case 'steps':
      return sanitizeStepsBlock(record, options);
    case 'comparison':
      return sanitizeComparisonBlock(record, options);
    case 'status':
      return sanitizeStatusBlock(record);
    case 'text':
      return sanitizeTextBlock(record);
    case 'table':
      return sanitizeTableBlock(record, options);
    case 'callout':
      return sanitizeCalloutBlock(record);
    default:
      return null;
  }
}

/** Builds a stable key for removing duplicated structured list items. */
function getStructuredDedupeKey(...values: string[]): string {
  return values
    .join('|')
    .toLocaleLowerCase('es-MX')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compacts compatible blocks so repeated model fragments render as one coherent answer. */
function compactAssistantStructuredBlocks(
  blocks: AgentProfileAssistantStructuredBlock[],
  options: AssistantStructuredSanitizeOptions
): AgentProfileAssistantStructuredBlock[] {
  const compacted: AgentProfileAssistantStructuredBlock[] = [];

  blocks.forEach(
    /** Handles the callback for this operation. */
    (block) => {
      if (block.type === 'metrics') {
        const existingMetrics = compacted.find(
          /** Handles the callback for this operation. */
          (candidate): candidate is Extract<AgentProfileAssistantStructuredBlock, { type: 'metrics' }> =>
            candidate.type === 'metrics'
        );
        const existingKeys = new Set(
          existingMetrics?.items.map(
            /** Handles the callback for this operation. */
            (item) => getStructuredDedupeKey(item.label, item.value)
          ) ?? []
        );
        const newItems = block.items.filter(
          /** Handles the callback for this operation. */
          (item) => !existingKeys.has(getStructuredDedupeKey(item.label, item.value))
        );
        if (existingMetrics) {
          existingMetrics.items = [...existingMetrics.items, ...newItems].slice(0, options.maxItems);
        } else if (newItems.length > 0) {
          compacted.push({ type: 'metrics', items: newItems.slice(0, options.maxItems) });
        }
        return;
      }

      if (block.type === 'steps') {
        const existingSteps = compacted.find(
          /** Handles the callback for this operation. */
          (candidate): candidate is Extract<AgentProfileAssistantStructuredBlock, { type: 'steps' }> =>
            candidate.type === 'steps'
        );
        const existingKeys = new Set(
          existingSteps?.items.map(
            /** Handles the callback for this operation. */
            (item) => getStructuredDedupeKey(item.title, item.body)
          ) ?? []
        );
        const newItems = block.items.filter(
          /** Handles the callback for this operation. */
          (item) => !existingKeys.has(getStructuredDedupeKey(item.title, item.body))
        );
        if (existingSteps) {
          existingSteps.items = [...existingSteps.items, ...newItems].slice(0, options.maxItems);
        } else if (newItems.length > 0) {
          compacted.push({ type: 'steps', items: newItems.slice(0, options.maxItems) });
        }
        return;
      }

      compacted.push(block);
    }
  );

  return compacted.slice(0, ASSISTANT_MAX_STRUCTURED_BLOCKS);
}

/** Sanitizes the assistant structured response object generated by the model. */
function sanitizeAssistantStructuredContent(
  value: unknown,
  options: AssistantStructuredSanitizeOptions = { maxItems: ASSISTANT_MAX_STRUCTURED_ITEMS }
): AgentProfileAssistantStructuredContent | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const intro = sanitizeStructuredIntro(record.intro);
  const outro = sanitizeStructuredString(record.outro);
  const rawBlocks = Array.isArray(record.blocks) ? record.blocks : [];
  const blocks = rawBlocks
    .map(
      /** Handles the callback for this operation. */
      (block) => sanitizeStructuredBlock(block, options)
    )
    .filter((block): block is AgentProfileAssistantStructuredBlock => Boolean(block));
  const compactedBlocks = compactAssistantStructuredBlocks(blocks, options);

  if (!intro && compactedBlocks.length === 0 && !outro) {
    return undefined;
  }
  return {
    intro,
    blocks: compactedBlocks,
    ...(outro ? { outro } : {}),
  };
}

/** Builds a compact fallback string from structured blocks when the model omits answer. */
function buildFallbackAnswerFromStructuredContent(
  structuredContent: AgentProfileAssistantStructuredContent | undefined
): string {
  if (!structuredContent) {
    return '';
  }
  const lines: string[] = [];
  if (structuredContent.intro) {
    lines.push(structuredContent.intro);
  }
  structuredContent.blocks.forEach(
    /** Handles the callback for this operation. */
    (block, blockIndex) => {
      if (block.type === 'metrics') {
        const metrics = block.items
          .map(
            /** Handles the callback for this operation. */
            (item) => `${item.label ? `${item.label}: ` : ''}${item.value}`
          )
          .join('; ');
        if (metrics) {
          lines.push(metrics);
        }
      }
      if (block.type === 'steps') {
        block.items.forEach(
          /** Handles the callback for this operation. */
          (item, itemIndex) => {
            lines.push(`${itemIndex + 1}. ${item.title}: ${item.body}`);
          }
        );
      }
      if (block.type === 'comparison') {
        lines.push(`${block.leftLabel} vs. ${block.rightLabel}`);
      }
      if (block.type === 'status') {
        lines.push(`${block.label}${block.detail ? `: ${block.detail}` : ''}`);
      }
      if (block.type === 'text') {
        lines.push(block.text);
      }
      if (blockIndex >= ASSISTANT_MAX_STRUCTURED_BLOCKS) {
        return;
      }
    }
  );
  if (structuredContent.outro) {
    lines.push(structuredContent.outro);
  }
  return lines.join('\n').slice(0, ASSISTANT_MAX_ANSWER_CHARS).trim();
}

export function sanitizeAssistantModelJson(value: unknown): AssistantModelJsonOutput | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const structuredInput =
    record.structuredContent && typeof record.structuredContent === 'object'
      ? record.structuredContent
      : {
          intro: record.intro,
          blocks: record.blocks,
          outro: record.outro,
        };
  const structuredContent = sanitizeAssistantStructuredContent(structuredInput);
  const fallbackAnswer = buildFallbackAnswerFromStructuredContent(structuredContent);
  const answerRaw = typeof record.answer === 'string' ? record.answer.trim() : fallbackAnswer;
  if (!answerRaw) {
    return null;
  }

  const answer = answerRaw.length > ASSISTANT_MAX_ANSWER_CHARS
    ? answerRaw.slice(0, ASSISTANT_MAX_ANSWER_CHARS)
    : answerRaw;

  const referencesRaw = Array.isArray(record.references) ? record.references : [];
  const references: AssistantModelReference[] = referencesRaw
    .map((ref) => {
      if (!ref || typeof ref !== 'object') {
        return undefined;
      }
      const refRecord = ref as Record<string, unknown>;
      const type = refRecord.type;
      const id = typeof refRecord.id === 'string' ? refRecord.id.trim() : '';
      if (typeof type !== 'string' || !VALID_ASSISTANT_REFERENCE_TYPES.includes(type as AgentProfileAssistantReferenceType)) {
        return undefined;
      }
      if (!id) {
        return undefined;
      }
      return { type: type as AgentProfileAssistantReferenceType, id };
    })
    .filter((ref): ref is AssistantModelReference => Boolean(ref))
    .slice(0, 12);

  return {
    answer,
    ...(structuredContent ? { structuredContent } : {}),
    references,
  };
}

export function parseAssistantModelJson(text: string): AssistantModelJsonOutput | null {
  try {
    return sanitizeAssistantModelJson(JSON.parse(text));
  } catch {
    return null;
  }
}

export function filterAssistantReferences(
  modelReferences: AssistantModelReference[],
  referenceMap: Map<string, AgentProfileAssistantReference>
): AgentProfileAssistantReference[] {
  const unique = new Map<string, AgentProfileAssistantReference>();
  modelReferences.forEach((ref) => {
    const key = `${ref.type}:${ref.id}`;
    const resolved = referenceMap.get(key);
    if (!resolved) {
      return;
    }
    unique.set(key, resolved);
  });
  return Array.from(unique.values());
}

export async function callAssistantOpenAi(params: {
  openai: OpenAI;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<AssistantModelJsonOutput> {
  /** Calls the OpenAI API to answer the scoped profile-assistant question. */
  const response = await params.openai.chat.completions.create({
    model: params.model,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const responseText = response.choices[0]?.message?.content;
  if (!responseText) {
    throw new Error('No response from agent profile assistant model');
  }

  const parsed = parseAssistantModelJson(responseText);
  if (!parsed) {
    throw new Error('Failed to parse agent profile assistant JSON response');
  }
  return parsed;
}

interface CompactionJsonOutput {
  summary: string;
}

function buildCompactionSystemPrompt(language: AgentProfileAssistantLanguage): string {
  return language === 'en'
    ? [
        'You compact chat history into a short durable memory.',
        'Write a concise summary that preserves important facts, constraints, and user preferences.',
        'Do not invent new facts. Do not include long raw quotes.',
        'Return ONLY valid JSON: { "summary": "string" }',
      ].join('\n')
    : [
        'Compactas el historial del chat en una memoria breve y durable.',
        'Escribe un resumen conciso que preserve hechos importantes, restricciones y preferencias del usuario.',
        'No inventes hechos. No incluyas citas largas textuales.',
        'Devuelve SOLO JSON válido: { "summary": "string" }',
      ].join('\n');
}

function parseCompactionJson(text: string): CompactionJsonOutput | null {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') {
      return null;
    }
    const record = value as Record<string, unknown>;
    const summaryRaw = typeof record.summary === 'string' ? record.summary.trim() : '';
    if (!summaryRaw) {
      return null;
    }
    return {
      summary:
        summaryRaw.length > ASSISTANT_MAX_COMPACTION_SUMMARY_CHARS
          ? summaryRaw.slice(0, ASSISTANT_MAX_COMPACTION_SUMMARY_CHARS)
          : summaryRaw,
    };
  } catch {
    return null;
  }
}

function estimateChatHistoryTokens(params: {
  compactedSummary?: string;
  messages: AgentProfileAssistantChatMessage[];
}): number {
  const summaryTokens = estimateTextTokens(params.compactedSummary || '');
  const messageTokens = params.messages.reduce(
    (sum, message) =>
      sum + estimateTextTokens(message.content),
    0
  );
  return summaryTokens + messageTokens;
}

function buildCompactionUserPrompt(params: {
  language: AgentProfileAssistantLanguage;
  existingSummary: string | undefined;
  messagesToSummarize: AgentProfileAssistantChatMessage[];
}): string {
  const header = tAssistantLabel(
    params.language,
    'Resumen existente (puede ser null):',
    'Existing summary (may be null):'
  );
  const messagesLabel = tAssistantLabel(params.language, 'Mensajes:', 'Messages:');

  const lines: string[] = [];
  lines.push(`${header}\n${params.existingSummary || 'null'}`);
  lines.push(messagesLabel);
  params.messagesToSummarize.forEach((message) => {
    lines.push(`- ${message.role.toUpperCase()}: ${message.content}`);
  });

  const joined = lines.join('\n');
  if (joined.length <= ASSISTANT_COMPACTION_MAX_INPUT_CHARS) {
    return joined;
  }
  return joined.slice(joined.length - ASSISTANT_COMPACTION_MAX_INPUT_CHARS);
}

async function compactChatIfNeeded(params: {
  openai: OpenAI;
  model: string;
  language: AgentProfileAssistantLanguage;
  chat: AgentProfileAssistantChat;
}): Promise<AgentProfileAssistantChat> {
  const estimatedTokens = estimateChatHistoryTokens({
    compactedSummary: params.chat.compactedSummary,
    messages: params.chat.messages,
  });
  if (estimatedTokens <= ASSISTANT_STORED_HISTORY_TOKEN_LIMIT) {
    return { ...params.chat, estimatedStoredHistoryTokens: estimatedTokens };
  }

  const keepCount = Math.min(ASSISTANT_COMPACTION_KEEP_RECENT_MESSAGES, params.chat.messages.length);
  const messagesToKeep = params.chat.messages.slice(-keepCount);
  const messagesToSummarize = params.chat.messages.slice(
    0,
    Math.max(0, params.chat.messages.length - keepCount)
  );
  if (messagesToSummarize.length === 0) {
    return { ...params.chat, messages: messagesToKeep, estimatedStoredHistoryTokens: estimatedTokens };
  }

  const compactedThroughMs = Math.max(
    ...messagesToSummarize.map((m) => m.createdAtMs)
  );

  const systemPrompt = buildCompactionSystemPrompt(params.language);
  const userPrompt = buildCompactionUserPrompt({
    language: params.language,
    existingSummary: params.chat.compactedSummary,
    messagesToSummarize,
  });

  /** Calls the OpenAI API to compact long assistant chat history. */
  const response = await params.openai.chat.completions.create({
    model: params.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const responseText = response.choices[0]?.message?.content;
  if (!responseText) {
    throw new Error('No response from assistant compaction model');
  }
  const parsed = parseCompactionJson(responseText);
  if (!parsed) {
    throw new Error('Failed to parse assistant compaction JSON response');
  }

  const nextChat: AgentProfileAssistantChat = {
    ...params.chat,
    messages: messagesToKeep,
    compactedSummary: parsed.summary,
    compactedThroughMs,
    compactionVersion: 1,
  };

  return {
    ...nextChat,
    estimatedStoredHistoryTokens: estimateChatHistoryTokens({
      compactedSummary: nextChat.compactedSummary,
      messages: nextChat.messages,
    }),
  };
}

function buildReferenceMap(
  language: AgentProfileAssistantLanguage,
  identity: AgentProfileAssistantChatIdentity,
  latestReport: NormalizedLatestReportContext | null,
  callSnapshots: NormalizedCallSnapshotContext[],
  reminders: NormalizedReminderContext[],
  progressRollups: NormalizedProgressRollupContext[],
  salesRollups: NormalizedSalesRollupContext[]
): Map<string, AgentProfileAssistantReference> {
  const map = new Map<string, AgentProfileAssistantReference>();

  if (latestReport) {
    map.set(`report:${latestReport.reportId}`, {
      type: 'report',
      id: latestReport.reportId,
      label: tAssistantLabel(language, 'Reporte actual', 'Latest report'),
    });
    latestReport.sourceCallIds.forEach((callId) => {
      map.set(`call:${callId}`, {
        type: 'call',
        id: callId,
        label: tAssistantLabel(language, `Llamada ${callId.slice(0, 8)}`, `Call ${callId.slice(0, 8)}`),
      });
    });
  }

  callSnapshots.forEach((snapshot) => {
    const callId = snapshot.sourceCallId || snapshot.callId;
    map.set(`call:${callId}`, {
      type: 'call',
      id: callId,
      label: snapshot.callOccurredAtIso
        ? tAssistantLabel(language, `Llamada ${snapshot.callOccurredAtIso.slice(0, 10)}`, `Call ${snapshot.callOccurredAtIso.slice(0, 10)}`)
        : tAssistantLabel(language, `Llamada ${callId.slice(0, 8)}`, `Call ${callId.slice(0, 8)}`),
    });
  });

  reminders.forEach((reminder) => {
    map.set(`reminder:${reminder.reminderId}`, {
      type: 'reminder',
      id: reminder.reminderId,
      label: reminder.effectiveDueDate
        ? tAssistantLabel(language, `Recordatorio ${reminder.effectiveDueDate}`, `Reminder ${reminder.effectiveDueDate}`)
        : tAssistantLabel(language, 'Recordatorio', 'Reminder'),
    });
    if (reminder.sourceCallId) {
      map.set(`call:${reminder.sourceCallId}`, {
        type: 'call',
        id: reminder.sourceCallId,
        label: tAssistantLabel(language, `Llamada ${reminder.sourceCallId.slice(0, 8)}`, `Call ${reminder.sourceCallId.slice(0, 8)}`),
      });
    }
  });

  progressRollups.forEach((rollup) => {
    map.set(`progress_rollup:${rollup.rollupId}`, {
      type: 'progress_rollup',
      id: rollup.rollupId,
      label: tAssistantLabel(language, 'Progreso', 'Progress'),
    });
  });

  salesRollups.forEach((rollup) => {
    map.set(`sales_rollup:${rollup.rollupId}`, {
      type: 'sales_rollup',
      id: rollup.rollupId,
      label: tAssistantLabel(language, 'Ventas', 'Sales'),
    });
  });

  return map;
}

function normalizeBehaviorPattern(value: unknown): NormalizedBehaviorPattern | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const patternId = typeof record.patternId === 'string' ? record.patternId : '';
  const patternName = typeof record.patternName === 'string' ? record.patternName : '';
  if (!patternId || !patternName) {
    return undefined;
  }
  return {
    patternId,
    patternName,
    priorityScore: typeof record.priorityScore === 'number' ? record.priorityScore : 0,
    seenInCallCount: typeof record.seenInCallCount === 'number' ? record.seenInCallCount : 0,
    totalCallCount: typeof record.totalCallCount === 'number' ? record.totalCallCount : 0,
    behaviorSummary: typeof record.behaviorSummary === 'string' ? record.behaviorSummary : '',
    whenItHappens: typeof record.whenItHappens === 'string' ? record.whenItHappens : '',
    businessImpact: typeof record.businessImpact === 'string' ? record.businessImpact : '',
    rootCause: typeof record.rootCause === 'string' ? record.rootCause : '',
    coachingFocus: typeof record.coachingFocus === 'string' ? record.coachingFocus : '',
    severityDistribution:
      record.severityDistribution && typeof record.severityDistribution === 'object'
        ? (record.severityDistribution as Partial<Record<string, number>>)
        : {},
  };
}

/** Normalizes count-label arrays stored by agent activity rollups. */
function normalizeAssistantCountLabelItems(value: unknown, limit = 6): Array<{ label: string; count: number }> {
  const rawItems = Array.isArray(value) ? value : [];
  return rawItems
    .map(
      /** Normalizes one stored count-label item. */
      (item) => {
        if (!item || typeof item !== 'object') {
          return undefined;
        }
        const record = item as Record<string, unknown>;
        const label = typeof record.label === 'string' ? record.label.trim() : '';
        const count = typeof record.count === 'number' ? record.count : 0;
        return label ? { label, count } : undefined;
      }
    )
    .filter((item): item is { label: string; count: number } => Boolean(item))
    .slice(0, limit);
}

/** Normalizes strings from mixed Firestore arrays. */
function normalizeAssistantStringArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter(
    /** Keeps only non-empty strings. */
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
}

/** Normalizes one stored agent activity call snapshot. */
function normalizeCallSnapshotContextDoc(
  doc: FirebaseFirestore.QueryDocumentSnapshot
): NormalizedCallSnapshotContext {
  const data = doc.data();
  const strengthTitles = normalizeAssistantStringArray(data.strengthTitles);
  const weaknessTitles = normalizeAssistantStringArray(data.weaknessTitles);
  const weaknessSeverities = normalizeAssistantStringArray(data.weaknessSeverities);
  return {
    callId: doc.id,
    sourceCallId: typeof data.sourceCallId === 'string' ? data.sourceCallId : doc.id,
    latestFeedbackId: typeof data.latestFeedbackId === 'string' ? data.latestFeedbackId : null,
    callOccurredAtMs: typeof data.callOccurredAtMs === 'number' ? data.callOccurredAtMs : undefined,
    callOccurredAtIso: typeof data.callOccurredAtIso === 'string' ? data.callOccurredAtIso : undefined,
    bucketDay: typeof data.bucketDay === 'string' ? data.bucketDay : undefined,
    customerName: typeof data.customerName === 'string' ? data.customerName : null,
    overallScore: typeof data.overallScore === 'number' ? data.overallScore : null,
    performanceTier: typeof data.performanceTier === 'string' ? data.performanceTier : null,
    lowConfidence: data.lowConfidence === true,
    callOutcome: typeof data.callOutcome === 'string' ? data.callOutcome : null,
    loanCompleted: typeof data.loanCompleted === 'string' ? data.loanCompleted : null,
    strengthTitles,
    weaknessTitles,
    weaknessSeverities,
    followUpNeeded: data.followUpNeeded === true,
    nextAction: typeof data.nextAction === 'string' ? data.nextAction : null,
    lastCallSummary: typeof data.lastCallSummary === 'string' ? data.lastCallSummary : null,
    nextBestAction: typeof data.nextBestAction === 'string' ? data.nextBestAction : null,
    whatAgentShouldSayNext:
      typeof data.whatAgentShouldSayNext === 'string' ? data.whatAgentShouldSayNext : null,
  };
}

/** Normalizes one stored progress rollup. */
function normalizeProgressRollupContextDoc(
  doc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot
): NormalizedProgressRollupContext {
  const data = doc.data() ?? {};
  return {
    rollupId: doc.id,
    periodType: typeof data.periodType === 'string' ? data.periodType : undefined,
    bucketKey: typeof data.bucketKey === 'string' ? data.bucketKey : undefined,
    sourceCallIds: normalizeAssistantStringArray(data.sourceCallIds),
    totalReviewedCalls: typeof data.totalReviewedCalls === 'number' ? data.totalReviewedCalls : undefined,
    eligibleScoreCount: typeof data.eligibleScoreCount === 'number' ? data.eligibleScoreCount : undefined,
    lowConfidenceCallCount:
      typeof data.lowConfidenceCallCount === 'number' ? data.lowConfidenceCallCount : undefined,
    averageScore: typeof data.averageScore === 'number' ? data.averageScore : null,
    topStrengths: normalizeAssistantCountLabelItems(data.topStrengths),
    topWeaknesses: normalizeAssistantCountLabelItems(data.topWeaknesses),
    coachingPriorities: normalizeAssistantCountLabelItems(data.coachingPriorities),
  };
}

async function loadLatestReportContext(
  db: FirebaseFirestore.Firestore,
  agentAnalysisId: string,
  latestReportId: string | null
): Promise<NormalizedLatestReportContext | null> {
  if (!latestReportId) {
    return null;
  }

  const reportDoc = await db
    .collection('agent_analyses')
    .doc(agentAnalysisId)
    .collection('reports')
    .doc(latestReportId)
    .get();

  if (!reportDoc.exists) {
    return null;
  }

  const data = reportDoc.data();
  const patternsRaw = Array.isArray(data?.patterns) ? data.patterns : [];
  const patterns = patternsRaw
    .map((pattern) => normalizeBehaviorPattern(pattern))
    .filter((pattern): pattern is NormalizedBehaviorPattern => Boolean(pattern));

  const patternOrder = Array.isArray(data?.patternOrder) ? data.patternOrder : [];
  const orderedPatterns =
    patternOrder.length > 0
      ? patternOrder
          .map((id) =>
            patterns.find((p) => p.patternId === id)
          )
          .filter((p): p is NormalizedBehaviorPattern => Boolean(p))
      : patterns.sort((a, b) => b.priorityScore - a.priorityScore);

  const sourceCallIds = Array.isArray(data?.sourceCallIds) ? data.sourceCallIds : [];
  const reportId = typeof data?.reportId === 'string' ? data.reportId : reportDoc.id;

  return {
    reportId,
    sourceCallIds: sourceCallIds.filter((id) => typeof id === 'string' && id),
    patterns: orderedPatterns.slice(0, ASSISTANT_PATTERN_LIMIT),
  };
}

async function loadCallSnapshotContexts(
  db: FirebaseFirestore.Firestore,
  agentKey: string
): Promise<NormalizedCallSnapshotContext[]> {
  /** Calls Firestore Admin SDK to load recent profile call snapshots. */
  const snapshotDocs = await db
    .collection('agent_activity')
    .doc(agentKey)
    .collection('call_snapshots')
    .orderBy('callOccurredAtMs', 'desc')
    .limit(ASSISTANT_CALL_SNAPSHOT_LIMIT)
    .get();

  return snapshotDocs.docs.map(
    /** Normalizes one recent call snapshot. */
    (doc) => normalizeCallSnapshotContextDoc(doc)
  );
}

async function loadReminderContexts(
  db: FirebaseFirestore.Firestore,
  agentKey: string
): Promise<NormalizedReminderContext[]> {
  const reminderDocs = await db
    .collection('agent_activity')
    .doc(agentKey)
    .collection('reminders')
    .orderBy('updatedAt', 'desc')
    .limit(ASSISTANT_REMINDER_OVERFETCH_LIMIT)
    .get();

  const normalized = reminderDocs.docs.map((doc) => {
    const data = doc.data();
    return {
      reminderId: doc.id,
      sourceCallId: typeof data.sourceCallId === 'string' ? data.sourceCallId : undefined,
      state: typeof data.state === 'string' ? data.state : 'unknown',
      effectiveDueDate: typeof data.effectiveDueDate === 'string' ? data.effectiveDueDate : null,
      effectiveDueTime: typeof data.effectiveDueTime === 'string' ? data.effectiveDueTime : null,
      effectiveTimeRange: typeof data.effectiveTimeRange === 'string' ? data.effectiveTimeRange : null,
      effectiveConditionText: typeof data.effectiveConditionText === 'string' ? data.effectiveConditionText : null,
      nextAction: typeof data.nextAction === 'string' ? data.nextAction : null,
      customerName: typeof data.customerName === 'string' ? data.customerName : null,
    };
  });

  const open = normalized.filter((r) => r.state === 'open');
  const nonOpen = normalized.filter((r) => r.state !== 'open');
  return [...open, ...nonOpen].slice(0, ASSISTANT_REMINDER_LIMIT);
}

async function loadProgressRollupContexts(
  db: FirebaseFirestore.Firestore,
  agentKey: string
): Promise<NormalizedProgressRollupContext[]> {
  /** Calls Firestore Admin SDK to load recent profile progress rollups. */
  const docs = await db
    .collection('agent_activity')
    .doc(agentKey)
    .collection('progress_rollups')
    .orderBy('bucketKey', 'desc')
    .limit(ASSISTANT_ROLLUP_LIMIT)
    .get();

  return docs.docs.map(
    /** Normalizes one recent progress rollup. */
    (doc) => normalizeProgressRollupContextDoc(doc)
  );
}

async function loadSalesRollupContexts(
  db: FirebaseFirestore.Firestore,
  agentKey: string
): Promise<NormalizedSalesRollupContext[]> {
  /** Calls Firestore Admin SDK to load recent profile sales rollups. */
  const docs = await db
    .collection('agent_activity')
    .doc(agentKey)
    .collection('sales_rollups')
    .orderBy('bucketKey', 'desc')
    .limit(ASSISTANT_ROLLUP_LIMIT)
    .get();

  return docs.docs.map((doc) => {
    const data = doc.data();
    return {
      rollupId: doc.id,
      periodType: typeof data.periodType === 'string' ? data.periodType : undefined,
      bucketKey: typeof data.bucketKey === 'string' ? data.bucketKey : undefined,
      soldLoanCount: typeof data.soldLoanCount === 'number' ? data.soldLoanCount : undefined,
      totalAmountSold: typeof data.totalAmountSold === 'number' ? data.totalAmountSold : undefined,
      followUpNeededCount: typeof data.followUpNeededCount === 'number' ? data.followUpNeededCount : undefined,
    };
  });
}

/** Lists ISO day keys in an inclusive retrieval range while enforcing backend caps. */
function listAssistantRangeDays(range: AssistantRetrievalDateRange): string[] {
  const days: string[] = [];
  let cursor = range.startDate;
  while (cursor <= range.endDate && days.length < ASSISTANT_TARGETED_ROLLUP_DAY_LIMIT) {
    days.push(cursor);
    cursor = addAssistantIsoDays(cursor, 1);
  }
  return days;
}

/** Loads day progress rollups directly by deterministic rollup ids. */
async function loadProgressRollupsForDateRange(
  db: FirebaseFirestore.Firestore,
  agentKey: string,
  range: AssistantRetrievalDateRange
): Promise<NormalizedProgressRollupContext[]> {
  const days = listAssistantRangeDays(range);
  const rollupRefs = days.map(
    /** Builds the deterministic day rollup document reference. */
    (day) => db.collection('agent_activity').doc(agentKey).collection('progress_rollups').doc(`day_${day}`)
  );
  /** Calls Firestore Admin SDK to load targeted progress rollup documents. */
  const docs = await Promise.all(rollupRefs.map(
    /** Loads one day rollup document. */
    (ref) => ref.get()
  ));
  return docs
    .filter(
      /** Keeps only existing day rollups. */
      (doc) => doc.exists
    )
    .map(
      /** Normalizes one targeted progress rollup. */
      (doc) => normalizeProgressRollupContextDoc(doc)
    );
}

/** Loads call snapshots for a specific bucketDay range. */
async function loadCallSnapshotsForDateRange(
  db: FirebaseFirestore.Firestore,
  agentKey: string,
  range: AssistantRetrievalDateRange
): Promise<NormalizedCallSnapshotContext[]> {
  const limit = Math.min(ASSISTANT_TARGETED_CALL_LIMIT, countAssistantInclusiveDays(range) * 8);
  /** Calls Firestore Admin SDK to query profile call snapshots for the requested day range. */
  const snapshotDocs = await db
    .collection('agent_activity')
    .doc(agentKey)
    .collection('call_snapshots')
    .where('bucketDay', '>=', range.startDate)
    .where('bucketDay', '<=', range.endDate)
    .orderBy('bucketDay', 'asc')
    .limit(limit)
    .get();
  return snapshotDocs.docs
    .map(
      /** Normalizes one targeted call snapshot. */
      (doc) => normalizeCallSnapshotContextDoc(doc)
    )
    .sort(
      /** Sorts worse scored calls first, then newest calls first. */
      (left, right) => {
        const leftScore = typeof left.overallScore === 'number' ? left.overallScore : Number.POSITIVE_INFINITY;
        const rightScore = typeof right.overallScore === 'number' ? right.overallScore : Number.POSITIVE_INFINITY;
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        return (right.callOccurredAtMs ?? 0) - (left.callOccurredAtMs ?? 0);
      }
    );
}

/** Returns a stable key for deduplicating call snapshots. */
function getAssistantCallSnapshotKey(snapshot: NormalizedCallSnapshotContext): string {
  return snapshot.sourceCallId || snapshot.callId;
}

/** Deduplicates call snapshots while preserving first-seen order. */
function dedupeAssistantCallSnapshots(
  snapshots: NormalizedCallSnapshotContext[]
): NormalizedCallSnapshotContext[] {
  const seen = new Set<string>();
  const unique: NormalizedCallSnapshotContext[] = [];
  snapshots.forEach(
    /** Keeps the first snapshot for each source call id. */
    (snapshot) => {
      const key = getAssistantCallSnapshotKey(snapshot);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      unique.push(snapshot);
    }
  );
  return unique;
}

/** Extracts compact quote evidence from rubric critique fields. */
function normalizeRubricEvidenceItems(value: unknown): NormalizedRubricCriterionEvidence[] {
  const rawItems = Array.isArray(value) ? value : [];
  return rawItems
    .map(
      /** Normalizes one evidence quote. */
      (item) => {
        if (!item || typeof item !== 'object') {
          return undefined;
        }
        const record = item as Record<string, unknown>;
        const quote = typeof record.quote === 'string' ? sanitizeStructuredString(record.quote, 220) : '';
        const speaker =
          typeof record.speaker_display === 'string'
            ? record.speaker_display
            : typeof record.speaker_label === 'string'
              ? record.speaker_label
              : null;
        return quote ? { quote, speaker } : undefined;
      }
    )
    .filter((item): item is NormalizedRubricCriterionEvidence => Boolean(item))
    .slice(0, 2);
}

/** Normalizes one rubric bad-critique style issue. */
function normalizeRubricIssue(value: unknown): NormalizedRubricCriterionIssue | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === 'string' ? sanitizeStructuredString(record.title, 120) : '';
  const detail = typeof record.detail === 'string' ? sanitizeStructuredString(record.detail, 260) : '';
  const severity = typeof record.severity === 'string' ? record.severity : null;
  const evidence = normalizeRubricEvidenceItems(record.evidence);
  if (!title && !detail) {
    return undefined;
  }
  return {
    title: title || detail.slice(0, 80),
    detail,
    severity,
    evidence,
  };
}

/** Normalizes one rubric criterion into a compact assistant evidence item. */
function normalizeRubricCriterionSummary(params: {
  sectionTitle?: string;
  groupTitle?: string;
  criterion: unknown;
}): NormalizedRubricCriterionSummary | undefined {
  if (!params.criterion || typeof params.criterion !== 'object') {
    return undefined;
  }
  const record = params.criterion as Record<string, unknown>;
  const criterionId = typeof record.id === 'string' ? record.id : '';
  const title = typeof record.title === 'string' ? sanitizeStructuredString(record.title, 140) : criterionId;
  if (!criterionId && !title) {
    return undefined;
  }
  const earnedPoints = typeof record.earned_points === 'number' ? record.earned_points : null;
  const maxPoints = typeof record.max_points === 'number' ? record.max_points : null;
  const scorePercent =
    typeof earnedPoints === 'number' && typeof maxPoints === 'number' && maxPoints > 0
      ? (earnedPoints / maxPoints) * 100
      : null;
  const badCritiques = Array.isArray(record.bad_critiques) ? record.bad_critiques : [];
  const issues = badCritiques
    .map(
      /** Normalizes one bad critique as a rubric issue. */
      (critique) => normalizeRubricIssue(critique)
    )
    .filter((issue): issue is NormalizedRubricCriterionIssue => Boolean(issue));
  const status = typeof record.status === 'string' ? record.status : null;
  const failedStatus = status && !['Cumple', 'No aplica'].includes(status);
  if (!failedStatus && issues.length === 0 && !(typeof scorePercent === 'number' && scorePercent < 70)) {
    return undefined;
  }
  return {
    criterionId: criterionId || title,
    title,
    ...(params.sectionTitle ? { sectionTitle: params.sectionTitle } : {}),
    ...(params.groupTitle ? { groupTitle: params.groupTitle } : {}),
    earnedPoints,
    maxPoints,
    scorePercent,
    status,
    justification: typeof record.justification === 'string' ? sanitizeStructuredString(record.justification, 260) : null,
    improvementTip:
      typeof record.criterion_improvement_tip === 'string'
        ? sanitizeStructuredString(record.criterion_improvement_tip, 260)
        : null,
    issues,
  };
}

/** Builds fallback feedback evidence from legacy top-level weakness arrays. */
function normalizeLegacyWeaknessCriteria(feedback: Record<string, unknown>): NormalizedRubricCriterionSummary[] {
  const weaknesses = Array.isArray(feedback.agent_weaknesses) ? feedback.agent_weaknesses : [];
  return weaknesses
    .map(
      /** Normalizes one legacy weakness item. */
      (weakness, index): NormalizedRubricCriterionSummary | undefined => {
        if (!weakness || typeof weakness !== 'object') {
          return undefined;
        }
        const record = weakness as Record<string, unknown>;
        const title = typeof record.title === 'string' ? sanitizeStructuredString(record.title, 140) : `Debilidad ${index + 1}`;
        const detail = typeof record.detail === 'string' ? sanitizeStructuredString(record.detail, 260) : '';
        return {
          criterionId: `legacy_${index + 1}`,
          title,
          scorePercent: null,
          status: 'No cumple',
          justification: detail || null,
          improvementTip:
            typeof record.improvement_tip === 'string' ? sanitizeStructuredString(record.improvement_tip, 260) : null,
          issues: [{
            title,
            detail,
            severity: typeof record.severity === 'string' ? record.severity : null,
            evidence: normalizeRubricEvidenceItems(record.evidence),
          }],
        };
      }
    )
    .filter((item): item is NormalizedRubricCriterionSummary => Boolean(item))
    .slice(0, ASSISTANT_MAX_STRUCTURED_ITEMS);
}

/** Extracts the weakest rubric criteria from a feedback document. */
function normalizeFeedbackWeakestCriteria(feedback: Record<string, unknown>): NormalizedRubricCriterionSummary[] {
  const scorecard =
    feedback.rubric_scorecard_v2 && typeof feedback.rubric_scorecard_v2 === 'object'
      ? (feedback.rubric_scorecard_v2 as Record<string, unknown>)
      : null;
  const sections = Array.isArray(scorecard?.sections) ? scorecard.sections : [];
  const criteria: NormalizedRubricCriterionSummary[] = [];
  for (const section of sections) {
    if (!section || typeof section !== 'object') {
      continue;
    }
    const sectionRecord = section as Record<string, unknown>;
    const sectionTitle = typeof sectionRecord.title === 'string' ? sectionRecord.title : undefined;
    const groups = Array.isArray(sectionRecord.groups) ? sectionRecord.groups : [];
    for (const group of groups) {
      if (!group || typeof group !== 'object') {
        continue;
      }
      const groupRecord = group as Record<string, unknown>;
      const groupTitle = typeof groupRecord.title === 'string' ? groupRecord.title : undefined;
      const rawCriteria = Array.isArray(groupRecord.criteria) ? groupRecord.criteria : [];
      rawCriteria.forEach(
        /** Adds one normalized rubric criterion when it represents an issue. */
        (criterion) => {
          const summary = normalizeRubricCriterionSummary({ sectionTitle, groupTitle, criterion });
          if (summary) {
            criteria.push(summary);
          }
        }
      );
    }
  }
  const normalized = criteria.length > 0 ? criteria : normalizeLegacyWeaknessCriteria(feedback);
  return normalized
    .sort(
      /** Sorts lowest scoring criteria before broad text-only weaknesses. */
      (left, right) => {
        const leftScore = typeof left.scorePercent === 'number' ? left.scorePercent : 101;
        const rightScore = typeof right.scorePercent === 'number' ? right.scorePercent : 101;
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        return right.issues.length - left.issues.length;
      }
    )
    .slice(0, ASSISTANT_MAX_STRUCTURED_ITEMS);
}

/** Normalizes one call feedback document for assistant evidence. */
function normalizeCallFeedbackSummary(params: {
  snapshot: NormalizedCallSnapshotContext;
  feedbackId: string;
  feedback: Record<string, unknown>;
}): NormalizedCallFeedbackSummary | null {
  const weakestCriteria = normalizeFeedbackWeakestCriteria(params.feedback);
  if (weakestCriteria.length === 0) {
    return null;
  }
  return {
    callId: params.snapshot.sourceCallId,
    feedbackId: params.feedbackId,
    overallScore:
      typeof params.feedback.overall_score === 'number'
        ? params.feedback.overall_score
        : params.snapshot.overallScore ?? null,
    performanceTier:
      typeof params.feedback.performance_tier === 'string'
        ? params.feedback.performance_tier
        : params.snapshot.performanceTier ?? null,
    lowConfidence: params.feedback.low_confidence === true || params.snapshot.lowConfidence === true,
    weakestCriteria,
  };
}

/** Loads compact feedback/rubric evidence for one call snapshot. */
async function loadCallFeedbackSummary(
  db: FirebaseFirestore.Firestore,
  snapshot: NormalizedCallSnapshotContext
): Promise<NormalizedCallFeedbackSummary | null> {
  const feedbackId = snapshot.latestFeedbackId || 'data';
  const feedbackRef = db.collection('calls').doc(snapshot.sourceCallId).collection('feedback').doc(feedbackId);
  /** Calls Firestore Admin SDK to load the requested call feedback document. */
  let feedbackDoc = await feedbackRef.get();
  if (!feedbackDoc.exists && feedbackId !== 'data') {
    /** Calls Firestore Admin SDK to load legacy fallback call feedback evidence. */
    feedbackDoc = await db.collection('calls').doc(snapshot.sourceCallId).collection('feedback').doc('data').get();
  }
  if (!feedbackDoc.exists) {
    return null;
  }
  const data = feedbackDoc.data();
  return data ? normalizeCallFeedbackSummary({ snapshot, feedbackId: feedbackDoc.id, feedback: data }) : null;
}

/** Ranks snapshots for deeper feedback/transcript retrieval. */
function selectAssistantEvidenceCallSnapshots(
  snapshots: NormalizedCallSnapshotContext[],
  limit: number
): NormalizedCallSnapshotContext[] {
  return dedupeAssistantCallSnapshots(snapshots)
    .sort(
      /** Puts lower-scoring and weakness-bearing calls first. */
      (left, right) => {
        const leftScore = typeof left.overallScore === 'number' ? left.overallScore : Number.POSITIVE_INFINITY;
        const rightScore = typeof right.overallScore === 'number' ? right.overallScore : Number.POSITIVE_INFINITY;
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        if (left.weaknessTitles.length !== right.weaknessTitles.length) {
          return right.weaknessTitles.length - left.weaknessTitles.length;
        }
        return (right.callOccurredAtMs ?? 0) - (left.callOccurredAtMs ?? 0);
      }
    )
    .slice(0, limit);
}

/** Loads compact feedback summaries for the most relevant candidate calls. */
async function loadCallFeedbackSummaries(
  db: FirebaseFirestore.Firestore,
  snapshots: NormalizedCallSnapshotContext[]
): Promise<NormalizedCallFeedbackSummary[]> {
  const candidates = selectAssistantEvidenceCallSnapshots(snapshots, ASSISTANT_TARGETED_FEEDBACK_LIMIT);
  const summaries = await Promise.all(candidates.map(
    /** Loads feedback evidence for one candidate call. */
    (snapshot) => loadCallFeedbackSummary(db, snapshot)
  ));
  return summaries.filter(
    /** Keeps feedback summaries that contain usable evidence. */
    (summary): summary is NormalizedCallFeedbackSummary => Boolean(summary)
  );
}

/** Builds compact text from transcript data without loading it into the answer unbounded. */
function normalizeTranscriptSnippetText(data: Record<string, unknown>): string {
  if (typeof data.text === 'string' && data.text.trim()) {
    return sanitizeStructuredString(data.text, ASSISTANT_TRANSCRIPT_SNIPPET_CHARS);
  }
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const text = segments
    .map(
      /** Formats one transcript segment for compact assistant context. */
      (segment) => {
        if (!segment || typeof segment !== 'object') {
          return '';
        }
        const record = segment as Record<string, unknown>;
        const speaker = typeof record.speaker === 'string' ? `${record.speaker}: ` : '';
        const segmentText = typeof record.text === 'string' ? record.text : '';
        return `${speaker}${segmentText}`.trim();
      }
    )
    .filter(Boolean)
    .join('\n');
  return sanitizeStructuredString(text, ASSISTANT_TRANSCRIPT_SNIPPET_CHARS);
}

/** Loads a bounded transcript snippet for one call. */
async function loadCallTranscriptSnippet(
  db: FirebaseFirestore.Firestore,
  snapshot: NormalizedCallSnapshotContext
): Promise<NormalizedCallTranscriptSnippet | null> {
  /** Calls Firestore Admin SDK to load the call transcript only for transcript-depth questions. */
  const transcriptDoc = await db
    .collection('calls')
    .doc(snapshot.sourceCallId)
    .collection('transcript')
    .doc('data')
    .get();
  if (!transcriptDoc.exists) {
    return null;
  }
  const data = transcriptDoc.data();
  const text = data ? normalizeTranscriptSnippetText(data) : '';
  return text ? { callId: snapshot.sourceCallId, text } : null;
}

/** Loads transcript snippets for a capped list of candidate calls. */
async function loadCallTranscriptSnippets(
  db: FirebaseFirestore.Firestore,
  snapshots: NormalizedCallSnapshotContext[]
): Promise<NormalizedCallTranscriptSnippet[]> {
  const candidates = selectAssistantEvidenceCallSnapshots(snapshots, ASSISTANT_TARGETED_TRANSCRIPT_LIMIT);
  const snippets = await Promise.all(candidates.map(
    /** Loads transcript text for one candidate call. */
    (snapshot) => loadCallTranscriptSnippet(db, snapshot)
  ));
  return snippets.filter(
    /** Keeps available transcript snippets. */
    (snippet): snippet is NormalizedCallTranscriptSnippet => Boolean(snippet)
  );
}

/** Loads all extra evidence required by the assistant retrieval plan. */
async function loadAgentProfileAssistantEvidence(
  db: FirebaseFirestore.Firestore,
  identity: AgentProfileAssistantChatIdentity,
  plan: AssistantRetrievalPlan,
  context: LoadedAgentProfileAssistantContext
): Promise<AgentProfileAssistantEvidenceBundle> {
  const missing: string[] = [];
  const progressRollups = plan.requiresProgressRollups && plan.dateRange
    ? await loadProgressRollupsForDateRange(db, identity.agentKey, plan.dateRange)
    : [];
  const compareProgressRollups = plan.requiresProgressRollups && plan.compareDateRange
    ? await loadProgressRollupsForDateRange(db, identity.agentKey, plan.compareDateRange)
    : [];
  const performanceFocusRollup = plan.topic === 'performance_analysis'
    ? selectAssistantPerformanceRollup({
        rollups: progressRollups,
        mode: plan.periodAnalysisMode,
      })
    : null;
  const performanceFocusRange = performanceFocusRollup
    ? buildAssistantRollupDateRange(performanceFocusRollup)
    : null;
  const callDateRange = performanceFocusRange ?? plan.dateRange;
  const callSnapshots = plan.requiresCallSnapshots && callDateRange
    ? await loadCallSnapshotsForDateRange(db, identity.agentKey, callDateRange)
    : plan.requiresCallSnapshots
      ? context.callSnapshots
      : [];
  const compareCallSnapshots = plan.requiresCallSnapshots && plan.compareDateRange
    ? await loadCallSnapshotsForDateRange(db, identity.agentKey, plan.compareDateRange)
    : [];

  if (plan.requiresProgressRollups && plan.dateRange && progressRollups.length === 0) {
    missing.push(`progress_rollups:${plan.dateRange.label}`);
  }
  if (plan.requiresProgressRollups && plan.compareDateRange && compareProgressRollups.length === 0) {
    missing.push(`progress_rollups:${plan.compareDateRange.label}`);
  }
  if (plan.requiresCallSnapshots && callDateRange && callSnapshots.length === 0) {
    missing.push(`call_snapshots:${callDateRange.label}`);
  }
  if (plan.requiresCallSnapshots && plan.compareDateRange && compareCallSnapshots.length === 0) {
    missing.push(`call_snapshots:${plan.compareDateRange.label}`);
  }

  const candidateSnapshots = dedupeAssistantCallSnapshots([...callSnapshots, ...compareCallSnapshots]);
  const feedbackSummaries = plan.requiresFeedback
    ? await loadCallFeedbackSummaries(db, candidateSnapshots)
    : [];
  if (plan.requiresFeedback && candidateSnapshots.length > 0 && feedbackSummaries.length === 0) {
    missing.push('feedback/rubrica');
  }

  const transcriptSnippets = plan.requiresTranscripts
    ? await loadCallTranscriptSnippets(db, callSnapshots)
    : [];
  if (plan.requiresTranscripts && callSnapshots.length > 0 && transcriptSnippets.length === 0) {
    missing.push('transcript');
  }

  return {
    progressRollups,
    compareProgressRollups,
    callSnapshots,
    compareCallSnapshots,
    feedbackSummaries,
    transcriptSnippets,
    missing,
  };
}

/** Adds references from targeted evidence into the context reference map. */
function mergeAssistantEvidenceReferences(
  language: AgentProfileAssistantLanguage,
  referenceMap: Map<string, AgentProfileAssistantReference>,
  evidenceBundle: AgentProfileAssistantEvidenceBundle
): void {
  [...evidenceBundle.progressRollups, ...evidenceBundle.compareProgressRollups].forEach(
    /** Adds one targeted progress rollup reference. */
    (rollup) => {
      referenceMap.set(`progress_rollup:${rollup.rollupId}`, {
        type: 'progress_rollup',
        id: rollup.rollupId,
        label: rollup.bucketKey
          ? tAssistantLabel(language, `Progreso ${rollup.bucketKey}`, `Progress ${rollup.bucketKey}`)
          : tAssistantLabel(language, 'Progreso', 'Progress'),
      });
    }
  );
  [...evidenceBundle.callSnapshots, ...evidenceBundle.compareCallSnapshots].forEach(
    /** Adds one targeted call reference. */
    (snapshot) => {
      referenceMap.set(`call:${snapshot.sourceCallId}`, {
        type: 'call',
        id: snapshot.sourceCallId,
        label: snapshot.bucketDay
          ? tAssistantLabel(language, `Llamada ${snapshot.bucketDay}`, `Call ${snapshot.bucketDay}`)
          : tAssistantLabel(language, `Llamada ${snapshot.sourceCallId.slice(0, 8)}`, `Call ${snapshot.sourceCallId.slice(0, 8)}`),
      });
    }
  );
}

export async function loadAgentProfileAssistantContext(
  db: FirebaseFirestore.Firestore,
  identity: AgentProfileAssistantChatIdentity,
  profile: OwnedAgentProfileSnapshot,
  language: AgentProfileAssistantLanguage
): Promise<LoadedAgentProfileAssistantContext> {
  const [latestReport, callSnapshots, reminders, progressRollups, salesRollups] = await Promise.all([
    loadLatestReportContext(db, profile.agentAnalysisId, profile.latestReportId),
    loadCallSnapshotContexts(db, identity.agentKey),
    loadReminderContexts(db, identity.agentKey),
    loadProgressRollupContexts(db, identity.agentKey),
    loadSalesRollupContexts(db, identity.agentKey),
  ]);

  const referenceMap = buildReferenceMap(
    language,
    identity,
    latestReport,
    callSnapshots,
    reminders,
    progressRollups,
    salesRollups
  );

  const contextSummary: AgentProfileAssistantContextSummary = {
    agentAnalysisId: profile.agentAnalysisId,
    salesAgentId: profile.salesAgentId,
    salesAgentName: profile.salesAgentName,
    externalAgentSource: identity.externalAgentSource,
    externalAgentId: identity.externalAgentId,
    hasLatestReport: Boolean(latestReport),
    recentCallCount: callSnapshots.length,
    openReminderCount: reminders.filter((r) => r.state === 'open').length,
    progressRollupCount: progressRollups.length,
    salesRollupCount: salesRollups.length,
  };

  return {
    latestReport,
    callSnapshots,
    reminders,
    progressRollups,
    salesRollups,
    referenceMap,
    contextSummary,
  };
}

/**
 * Pure handler so tests can drive it without going through onCall.
 * Loads chat state for the current authenticated user and owned KESP profile.
 */
export async function handleGetAgentProfileAssistantChat(
  request: CallableRequest<GetAgentProfileAssistantChatRequest>,
  db: FirebaseFirestore.Firestore = admin.firestore()
): Promise<AgentProfileAssistantChatResponse> {
  const uid = requireAuthUid(request);
  const agentAnalysisId = validateAgentAnalysisId(request.data?.agentAnalysisId);

  const profile = await loadOwnedAgentProfile(db, agentAnalysisId, uid);
  const identity = buildChatIdentity(profile);

  const chatId = buildAgentProfileAssistantChatId(uid, agentAnalysisId);
  const chatDoc = await db.collection(AGENT_PROFILE_ASSISTANT_CHAT_COLLECTION).doc(chatId).get();

  const chat = chatDoc.exists
    ? coerceChatFromDoc(uid, agentAnalysisId, identity, chatDoc.data())
    : buildEmptyChat(uid, agentAnalysisId, identity);

  return { success: true, chat };
}

/**
 * Pure handler so lightweight frontend polling can check whether chat state changed.
 */
export async function handleGetAgentProfileAssistantChatStatus(
  request: CallableRequest<GetAgentProfileAssistantChatStatusRequest>,
  db: FirebaseFirestore.Firestore = admin.firestore()
): Promise<AgentProfileAssistantChatStatusResponse> {
  const uid = requireAuthUid(request);
  const agentAnalysisId = validateAgentAnalysisId(request.data?.agentAnalysisId);

  await loadOwnedAgentProfile(db, agentAnalysisId, uid);
  const chatId = buildAgentProfileAssistantChatId(uid, agentAnalysisId);
  const chatDoc = await db.collection(AGENT_PROFILE_ASSISTANT_CHAT_COLLECTION).doc(chatId).get();
  if (!chatDoc.exists) {
    return { success: true, status: { exists: false, assistantBehaviorVersion: null, messageCount: 0, latestMessageId: null } };
  }

  const data = chatDoc.data() ?? {};
  const messages = Array.isArray(data.messages)
    ? data.messages.map((message) => coerceAssistantMessage(message)).filter((message): message is AgentProfileAssistantChatMessage => Boolean(message))
    : [];
  const latestMessage = messages[messages.length - 1] ?? null;
  const assistantBehaviorVersion = typeof data.assistantBehaviorVersion === 'number' && Number.isFinite(data.assistantBehaviorVersion)
    ? data.assistantBehaviorVersion
    : null;
  return {
    success: true,
    status: {
      exists: true,
      assistantBehaviorVersion,
      updatedAtMs: coerceEpochMs(data.updatedAtMs),
      messageCount: messages.length,
      latestMessageId: latestMessage?.id ?? null,
    },
  };
}

/**
 * Pure handler so tests can drive it without going through onCall.
 * Clears only the caller's persisted assistant chat for the requested KESP profile.
 */
export async function handleResetAgentProfileAssistantChat(
  request: CallableRequest<ResetAgentProfileAssistantChatRequest>,
  db: FirebaseFirestore.Firestore = admin.firestore()
): Promise<AgentProfileAssistantChatResponse> {
  const uid = requireAuthUid(request);
  const agentAnalysisId = validateAgentAnalysisId(request.data?.agentAnalysisId);

  const profile = await loadOwnedAgentProfile(db, agentAnalysisId, uid);
  const identity = buildChatIdentity(profile);
  const chatId = buildAgentProfileAssistantChatId(uid, agentAnalysisId);
  const chatRef = db.collection(AGENT_PROFILE_ASSISTANT_CHAT_COLLECTION).doc(chatId);
  const nowMs = Date.now();
  const chat: AgentProfileAssistantChat = {
    ...buildEmptyChat(uid, agentAnalysisId, identity),
    assistantBehaviorVersion: ASSISTANT_BEHAVIOR_VERSION,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };

  /** Calls Firestore Admin SDK to replace only this scoped assistant chat document. */
  await chatRef.set(
    {
      userId: uid,
      profileScope: 'kesp',
      agentAnalysisId,
      identity,
      assistantBehaviorVersion: ASSISTANT_BEHAVIOR_VERSION,
      messages: [],
      compactedSummary: null,
      compactedThroughMs: null,
      estimatedStoredHistoryTokens: 0,
      compactionVersion: 1,
      lastAskAtMs: null,
      createdAtMs: admin.firestore.FieldValue.serverTimestamp(),
      updatedAtMs: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { success: true, chat };
}

/**
 * Pure handler so tests can drive it without going through onCall.
 * Answers a question about the current authenticated user’s owned KESP profile and persists chat state.
 */
export async function handleAskAgentProfileAssistant(
  request: CallableRequest<AskAgentProfileAssistantRequest>,
  db: FirebaseFirestore.Firestore = admin.firestore()
): Promise<AgentProfileAssistantResponse> {
  const uid = requireAuthUid(request);
  const agentAnalysisId = validateAgentAnalysisId(request.data?.agentAnalysisId);
  const question = validateAssistantQuestion(request.data?.question);
  const language = normalizeAssistantLanguage(request.data?.language);

  const profile = await loadOwnedAgentProfile(db, agentAnalysisId, uid);
  const identity = buildChatIdentity(profile);

  const chatId = buildAgentProfileAssistantChatId(uid, agentAnalysisId);
  const chatRef = db.collection(AGENT_PROFILE_ASSISTANT_CHAT_COLLECTION).doc(chatId);
  const nowMs = Date.now();

  // Transaction serializes the read + rate-limit check so concurrent asks
  // for the same chat cannot both pass the gate and double-spend on OpenAI.
  const { existingChat, isNewChat } = await db.runTransaction(async (txn) => {
    const chatDoc = await txn.get(chatRef);
    const chatData = chatDoc.data();

    const chat = chatDoc.exists
      ? coerceChatFromDoc(uid, agentAnalysisId, identity, chatData)
      : buildEmptyChat(uid, agentAnalysisId, identity);

    const lastAskAtMs =
      typeof chatData?.lastAskAtMs === 'number' && Number.isFinite(chatData.lastAskAtMs)
        ? chatData.lastAskAtMs
        : 0;
    const lastMessageMs = chat.messages.reduce(
      /** Handles the callback for this operation. */
      (latest, message) => Math.max(latest, message.createdAtMs),
      0
    );
    if (
      lastAskAtMs > lastMessageMs &&
      nowMs - lastAskAtMs < ASSISTANT_IN_FLIGHT_REQUEST_TIMEOUT_MS
    ) {
      throw new HttpsError(
        'resource-exhausted',
        tAssistantLabel(
          language,
          'Ya estoy procesando tu pregunta anterior.',
          'I am still processing your previous question.'
        )
      );
    }

    const lastUserMessage = [...chat.messages]
      .reverse()
      .find((message) => message.role === 'user');

    if (lastUserMessage && nowMs - lastUserMessage.createdAtMs < ASSISTANT_MIN_REQUEST_INTERVAL_MS) {
      throw new HttpsError(
        'resource-exhausted',
        tAssistantLabel(
          language,
          'Espera unos segundos antes de volver a preguntar.',
          'Please wait a few seconds before asking again.'
        )
      );
    }

    // Atomically claim the slot so a concurrent request retries and sees this write.
    txn.set(chatRef, { lastAskAtMs: nowMs }, { merge: true });

    return { existingChat: chat, isNewChat: !chatDoc.exists };
  });

  const promptRecentMessages = existingChat.messages.slice(-ASSISTANT_RECENT_MESSAGE_LIMIT);
  const questionIntent = buildAssistantQuestionIntent({
    language,
    question,
    recentMessages: promptRecentMessages,
  });
  const retrievalPlan = buildAssistantRetrievalPlan({
    language,
    question,
    recentMessages: promptRecentMessages,
    intent: questionIntent,
  });
  const baseContext = await loadAgentProfileAssistantContext(db, identity, profile, language);
  const evidenceBundle = await loadAgentProfileAssistantEvidence(db, identity, retrievalPlan, baseContext);
  mergeAssistantEvidenceReferences(language, baseContext.referenceMap, evidenceBundle);
  const context: LoadedAgentProfileAssistantContext = {
    ...baseContext,
    retrievalPlan,
    evidenceBundle,
  };

  let answerText: string;
  let structuredContent: AgentProfileAssistantStructuredContent | undefined;
  let references: AgentProfileAssistantReference[];
  let openai: OpenAI | null = null;

  const serverHandledOutput = buildDeterministicAssistantServerResponse({
    language,
    context,
    intent: questionIntent,
    recentMessages: promptRecentMessages,
    question,
  });

  if (serverHandledOutput) {
    answerText = serverHandledOutput.answer;
    structuredContent = serverHandledOutput.structuredContent;
    references = filterAssistantReferences(serverHandledOutput.references, context.referenceMap);
  } else {
    const systemPrompt = buildAssistantSystemPrompt(language);
    const userPrompt = buildAssistantUserPrompt({
      language,
      identity,
      context,
      compactedSummary: existingChat.compactedSummary,
      recentMessages: promptRecentMessages,
      question,
    });

    try {
      /** Depends on the OpenAI SDK using the Firebase secret-provided API key. */
      openai = createDemoOpenAI({ purpose: 'profile_assistant' });
      const modelOutput = await callAssistantOpenAi({
        openai,
        model: AGENT_PROFILE_ASSISTANT_MODEL,
        systemPrompt,
        userPrompt,
      });
      answerText = modelOutput.answer;
      structuredContent = modelOutput.structuredContent;
      references = filterAssistantReferences(modelOutput.references, context.referenceMap);
    } catch (error: unknown) {
      const openAiError = error as AssistantOpenAiError;
      const status = typeof openAiError?.status === 'number' ? openAiError.status : null;
      const isRetryable = status === 429 || status === 408 || (status != null && status >= 500);
      if (isRetryable) {
        const fallbackOutput = buildDeterministicAssistantServerResponse({
          language,
          context,
          intent: questionIntent,
          recentMessages: promptRecentMessages,
          question,
        }) ?? buildRetryableCoachingFallbackResponse({
            language,
            latestReport: context.latestReport,
            intent: questionIntent,
            recentMessages: promptRecentMessages,
          }) ?? buildUnsupportedAssistantResponse(language);
        if (fallbackOutput) {
          logger.warn('Assistant OpenAI retryable error; returning deterministic assistant fallback.', { status });
          answerText = fallbackOutput.answer;
          structuredContent = fallbackOutput.structuredContent;
          references = filterAssistantReferences(fallbackOutput.references, context.referenceMap);
        } else {
          await releaseAssistantAskClaim(chatRef);
          throw new HttpsError(
            'unavailable',
            tAssistantLabel(
              language,
              'El asistente no está disponible en este momento. Intenta de nuevo más tarde.',
              'The assistant is unavailable right now. Please try again later.'
            )
          );
        }
      } else {
        const parseFailed =
          typeof openAiError?.message === 'string' &&
          openAiError.message.includes('Failed to parse agent profile assistant JSON response');
        if (parseFailed) {
          logger.warn('Assistant JSON parse failed; returning safe fallback answer.');
          answerText = tAssistantLabel(
            language,
            'No pude generar una respuesta confiable con los datos disponibles. Intenta reformular la pregunta.',
            'I could not generate a reliable answer with the available data. Please try rephrasing your question.'
          );
          structuredContent = undefined;
          references = [];
        } else {
          await releaseAssistantAskClaim(chatRef);
          throw new HttpsError(
            'internal',
            tAssistantLabel(
              language,
              'Ocurrió un error inesperado al consultar el asistente.',
              'An unexpected error occurred while querying the assistant.'
            )
          );
        }
      }
    }
  }

  const userMessage: AgentProfileAssistantChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: question,
    createdAtMs: nowMs,
  };
  const suggestedQuestions = buildAssistantFollowUpQuestions({
    language,
    answer: answerText,
    structuredContent,
    references,
    context,
    intent: questionIntent,
  });
  const assistantMessage: AgentProfileAssistantChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: answerText,
    createdAtMs: nowMs + 1,
    ...(structuredContent ? { structuredContent } : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(suggestedQuestions.length > 0 ? { suggestedQuestions } : {}),
  };

  const unboundedMessages = [...existingChat.messages, userMessage, assistantMessage];
  const unboundedChat: AgentProfileAssistantChat = {
    ...existingChat,
    userId: uid,
    profileScope: 'kesp',
    agentAnalysisId,
    identity,
    assistantBehaviorVersion: ASSISTANT_BEHAVIOR_VERSION,
    messages: unboundedMessages,
    compactionVersion: 1,
  };

  let finalChat = {
    ...unboundedChat,
    estimatedStoredHistoryTokens: estimateChatHistoryTokens({
      compactedSummary: unboundedChat.compactedSummary,
      messages: unboundedChat.messages,
    }),
  };

  try {
    if (!openai) {
      /** Depends on the OpenAI SDK using the Firebase secret-provided API key. */
      openai = createDemoOpenAI({ purpose: 'profile_assistant' });
    }
    finalChat = await compactChatIfNeeded({
      openai,
      model: AGENT_PROFILE_ASSISTANT_MODEL,
      language,
      chat: finalChat,
    });
  } catch (compactionError) {
    logger.warn('Assistant post-answer compaction failed; persisting un-compacted chat:', compactionError);
  }

  /** Calls Firestore Admin SDK to persist scoped profile-assistant chat state. */
  await chatRef.set(
    {
      userId: uid,
      profileScope: 'kesp',
      agentAnalysisId,
      identity,
      assistantBehaviorVersion: ASSISTANT_BEHAVIOR_VERSION,
      messages: finalChat.messages.map((message) =>
        serializeAssistantMessageForFirestore(message)
      ),
      compactedSummary: finalChat.compactedSummary ?? null,
      compactedThroughMs: finalChat.compactedThroughMs ?? null,
      estimatedStoredHistoryTokens: finalChat.estimatedStoredHistoryTokens,
      compactionVersion: 1,
      lastAskAtMs: null,
      ...(isNewChat ? { createdAtMs: admin.firestore.FieldValue.serverTimestamp() } : {}),
      updatedAtMs: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    success: true,
    answer: answerText,
    references,
    chat: {
      ...finalChat,
      createdAtMs: finalChat.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    },
    contextSummary: context.contextSummary,
  };
}

export const getAgentProfileAssistantChat = onCall(
  async (request: CallableRequest<GetAgentProfileAssistantChatRequest>) =>
    handleGetAgentProfileAssistantChat(request)
);

export const getAgentProfileAssistantChatStatus = onCall(
  async (request: CallableRequest<GetAgentProfileAssistantChatStatusRequest>) =>
    handleGetAgentProfileAssistantChatStatus(request)
);

export const resetAgentProfileAssistantChat = onCall(
  async (request: CallableRequest<ResetAgentProfileAssistantChatRequest>) =>
    handleResetAgentProfileAssistantChat(request)
);

export const askAgentProfileAssistant = onPaidCall(
  {
    secrets: [OPENAI_API_KEY_SECRET],
    timeoutSeconds: 120,
    memory: '1GiB',
    cpu: 1,
  },

  async (request: CallableRequest<AskAgentProfileAssistantRequest>) =>
    handleAskAgentProfileAssistant(request)
);
