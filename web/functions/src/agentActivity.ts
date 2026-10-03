import { createDemoOpenAI } from './demoPaidProviders';
import { isDemoManualCall } from './demoConfig';
import * as admin from "firebase-admin";
import { isAgentProfileCallExcluded } from "./callExclusions";
import { FieldValue } from "firebase-admin/firestore";
import { analyzerRequestOptions } from "./analyzerRequestOptions";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { CONSUBANCO_ORGANIZATION_ID, CONSUBANCO_ORGANIZATION_NAME } from "./callIdentity";
import { buildCallActivityExtractorInput } from "./callActivityExtractorInput";
import { resolveCallOccurredAtDate, type CallOccurredAtSource } from "./callOccurrence";
import {
  CALL_ACTIVITY_EXTRACTOR_PROMPT,
  CALL_ACTIVITY_EXTRACTOR_TASK_ID,
  DEFAULT_ANALYZER_MODEL,
  resolveAnalyzerModel,
  resolveCallActivityExtractorPromptPath,
} from "./promptConfig";

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

export const AGENT_ACTIVITY_COLLECTION = "agent_activity";
export const AGENT_ACTIVITY_TIMEZONE = "America/Mexico_City";
const AGENT_ACTIVITY_SCHEMA_VERSION = "2";
const TOP_LIST_LIMIT = 5;

export function isAutomaticShortCallReviewCall(callData: Record<string, unknown>): boolean {
  return callData.shortCallReviewSource === "automatic_ccc_gcs" ||
    (callData.callSource === "ccc_gcs" && callData.analysisPipeline === "manual_short_call_review");
}

type LoanStatus = "yes" | "no" | "in_progress" | "unclear";
type CallOutcome =
  | "success"
  | "follow_up_needed"
  | "failure"
  | "in_progress"
  | "no_contact"
  | "unclear";
type ReminderOrigin = "ai_transcript" | "manual_first_call" | "manual_and_ai";
type ReminderState = "open" | "done" | "closed" | "superseded";
type ReminderPrecision =
  | "exact_datetime"
  | "date_only"
  | "time_range"
  | "condition_based"
  | "unscheduled";
type LoanLifecycleStage =
  | "not_sold"
  | "future_follow_up"
  | "sold_pending_follow_through"
  | "fully_completed"
  | "lost_cancelled"
  | "unknown";
type ReminderTaskType =
  | "call_back"
  | "send_whatsapp"
  | "send_info"
  | "collect_documents"
  | "confirm_payment"
  | "wait_for_customer"
  | "other";
type ReminderChannel = "call" | "whatsapp" | "sms" | "email" | "unknown";
type LifecycleStageSource =
  | "ai_inferred"
  | "manual_confirmed"
  | "manual_cancelled"
  | "manual_pending"
  | "system_resolved";

interface EvidenceQuote {
  quote: string;
  speaker_label?: string | null;
  speaker_display?: string | null;
}

interface ManualReminderInput {
  needsFollowUp: boolean;
  nextAction: string | null;
  followUpDate: string | null;
  followUpTime: string | null;
  note: string | null;
}

interface CallActivityExtraction {
  call_id: string;
  agent_name: string | null;
  client_name: string | null;
  call_outcome: CallOutcome;
  loan_completed: LoanStatus;
  loan_amount: number | null;
  currency: string | null;
  sale_date: string | null;
  follow_up_needed: boolean;
  next_action: string | null;
  follow_up_date: string | null;
  follow_up_time: string | null;
  follow_up_time_range: string | null;
  follow_up_reason: string | null;
  follow_up_notes: string | null;
  client_callback_condition: string | null;
  confidence_score: number | null;
  last_call_summary: string | null;
  next_best_action: string | null;
  what_agent_should_say_next: string | null;
  evidence_quotes: EvidenceQuote[];
}

interface AgentCallSnapshot {
  sourceCallId: string;
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  agentKey: string;
  latestFeedbackId: string;
  feedbackSchemaVersion: string;
  analyzerModel: string;
  environmentTarget?: "test" | "prod";
  callName: string | null;
  callOccurredAtMs: number;
  callOccurredAtIso: string;
  callOccurredAtSource: string;
  bucketDay: string;
  bucketWeek: string;
  bucketMonth: string;
  agentName: string | null;
  customerName: string | null;
  clientKey: string;
  clientKeyConfidence: "high" | "low";
  caseId: string;
  callOutcome: CallOutcome;
  loanCompleted: LoanStatus;
  saleReachedOnCall: boolean;
  inferredLifecycleStage: LoanLifecycleStage;
  effectiveLifecycleStage: LoanLifecycleStage;
  lifecycleStageSource: LifecycleStageSource;
  loanAmount: number | null;
  currency: string | null;
  saleDate: string | null;
  followUpNeeded: boolean;
  reminderTaskType: ReminderTaskType | null;
  reminderChannel: ReminderChannel | null;
  nextAction: string | null;
  followUpDate: string | null;
  followUpTime: string | null;
  followUpTimeRange: string | null;
  followUpReason: string | null;
  followUpNotes: string | null;
  clientCallbackCondition: string | null;
  confidenceScore: number | null;
  lastCallSummary: string | null;
  nextBestAction: string | null;
  whatAgentShouldSayNext: string | null;
  reminderOrigin: ReminderOrigin | null;
  reminderPrecision: ReminderPrecision | null;
  reminderSortKey: string | null;
  suggestedFollowupMessage: string | null;
  overallScore: number | null;
  lowConfidence: boolean;
  performanceTier: string | null;
  callCategory: string | null;
  strengthTitles: string[];
  weaknessTitles: string[];
  weaknessSeverities: string[];
  manualReminderInput: ManualReminderInput | null;
  activityExtraction: CallActivityExtraction | null;
  snapshotFingerprint: string;
}

interface LoanCaseDocument {
  caseId: string;
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  agentKey: string;
  clientKey: string;
  clientKeyConfidence: "high" | "low";
  customerName: string | null;
  linkedCallIds: string[];
  callCount: number;
  latestCallId: string | null;
  latestCallOccurredAtMs: number | null;
  latestCallOccurredAtIso: string | null;
  latestBucketDay: string | null;
  latestBucketWeek: string | null;
  latestBucketMonth: string | null;
  saleReachedOnCall: boolean;
  saleReachedCallId: string | null;
  saleReachedAtIso: string | null;
  aiInferredStage: LoanLifecycleStage;
  manualStageOverride: LoanLifecycleStage | null;
  effectiveStage: LoanLifecycleStage;
  stageSource: LifecycleStageSource;
  followThroughRequired: boolean;
  latestNextAction: string | null;
  latestWhatAgentShouldSayNext: string | null;
  latestSummary: string | null;
  loanAmount: number | null;
  currency: string | null;
  activeReminderIds: string[];
  overrideNote: string | null;
  overrideUpdatedBy: string | null;
  overrideUpdatedAtIso: string | null;
}


/** Documents the clampConfidence behavior. */
function clampConfidence(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Documents the normalizeNullableString behavior. */
function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Documents the normalizeCurrency behavior. */
function normalizeCurrency(value: unknown): string | null {
  const next = normalizeNullableString(value);
  return next ? next.toUpperCase() : null;
}

/** Documents the normalizeLoanAmount behavior. */
function normalizeLoanAmount(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

/** Documents the normalizeLoanStatus behavior. */
function normalizeLoanStatus(value: unknown, fallback: LoanStatus = "unclear"): LoanStatus {
  return value === "yes" || value === "no" || value === "in_progress" || value === "unclear"
    ? value
    : fallback;
}

/** Documents the normalizeCallOutcome behavior. */
function normalizeCallOutcome(
  value: unknown,
  fallbackLoanStatus: LoanStatus,
  suggestedFollowupMessage?: string | null
): CallOutcome {
  if (
    value === "success" ||
    value === "follow_up_needed" ||
    value === "failure" ||
    value === "in_progress" ||
    value === "no_contact" ||
    value === "unclear"
  ) {
    return value;
  }

  if (fallbackLoanStatus === "yes") return "success";
  if (fallbackLoanStatus === "no") return "failure";
  if (fallbackLoanStatus === "in_progress") return "in_progress";
  if (suggestedFollowupMessage) return "follow_up_needed";
  return "unclear";
}

/** Documents the normalizeEvidenceQuotes behavior. */
function normalizeEvidenceQuotes(value: unknown): EvidenceQuote[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(/** Handles the callback for this operation. */(item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map(/** Handles the callback for this operation. */(item) => ({
      quote: typeof item.quote === "string" ? item.quote.trim() : "",
      speaker_label:
        typeof item.speaker_label === "string"
          ? item.speaker_label
          : typeof item.speakerLabel === "string"
            ? item.speakerLabel
            : null,
      speaker_display:
        typeof item.speaker_display === "string"
          ? item.speaker_display
          : typeof item.speakerDisplay === "string"
            ? item.speakerDisplay
            : null,
    }))
    .filter(/** Handles the callback for this operation. */(item) => item.quote.length > 0);
}

/** Documents the parseManualReminderInput behavior. */
function parseManualReminderInput(value: unknown): ManualReminderInput | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Record<string, unknown>;
  if (typeof input.needsFollowUp !== "boolean") {
    return null;
  }

  return {
    needsFollowUp: input.needsFollowUp,
    nextAction: normalizeNullableString(input.nextAction),
    followUpDate: normalizeNullableString(input.followUpDate),
    followUpTime: normalizeNullableString(input.followUpTime),
    note: normalizeNullableString(input.note),
  };
}

/** Documents the normalizeCallActivityExtraction behavior. */
function normalizeCallActivityExtraction(
  callId: string,
  value: unknown,
  feedback: Record<string, any>
): CallActivityExtraction {
  const extraction = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const fallbackLoanStatus = normalizeLoanStatus(feedback.loan_completed);

  return {
    call_id: typeof extraction.call_id === "string" ? extraction.call_id : callId,
    agent_name: normalizeNullableString(extraction.agent_name) ?? normalizeNullableString(feedback.agent_name),
    client_name:
      normalizeNullableString(extraction.client_name) ?? normalizeNullableString(feedback.customer_name),
    call_outcome: normalizeCallOutcome(
      extraction.call_outcome,
      fallbackLoanStatus,
      normalizeNullableString(feedback.suggested_followup_message)
    ),
    loan_completed: normalizeLoanStatus(extraction.loan_completed, fallbackLoanStatus),
    loan_amount: normalizeLoanAmount(extraction.loan_amount),
    currency: normalizeCurrency(extraction.currency),
    sale_date: normalizeNullableString(extraction.sale_date),
    follow_up_needed: extraction.follow_up_needed === true,
    next_action: normalizeNullableString(extraction.next_action),
    follow_up_date: normalizeNullableString(extraction.follow_up_date),
    follow_up_time: normalizeNullableString(extraction.follow_up_time),
    follow_up_time_range: normalizeNullableString(extraction.follow_up_time_range),
    follow_up_reason: normalizeNullableString(extraction.follow_up_reason),
    follow_up_notes: normalizeNullableString(extraction.follow_up_notes),
    client_callback_condition: normalizeNullableString(extraction.client_callback_condition),
    confidence_score: clampConfidence(extraction.confidence_score),
    last_call_summary: normalizeNullableString(extraction.last_call_summary),
    next_best_action: normalizeNullableString(extraction.next_best_action),
    what_agent_should_say_next: normalizeNullableString(extraction.what_agent_should_say_next),
    evidence_quotes: normalizeEvidenceQuotes(extraction.evidence_quotes),
  };
}

/** Documents the formatDateParts behavior. */
function formatDateParts(parts: { year: number; month: number; day: number }): string {
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

/** Documents the getDatePartsInTimeZone behavior. */
function getDatePartsInTimeZone(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map(/** Handles the callback for this operation. */(part) => [part.type, part.value]));
  return {
    year: Number(lookup.get("year")),
    month: Number(lookup.get("month")),
    day: Number(lookup.get("day")),
  };
}

/** Documents the shiftUtcDate behavior. */
function shiftUtcDate(date: Date, deltaDays: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + deltaDays);
  return next;
}

/** Documents the getBucketKeys behavior. */
function getBucketKeys(date: Date): { day: string; week: string; month: string } {
  const localParts = getDatePartsInTimeZone(date, AGENT_ACTIVITY_TIMEZONE);
  const localDateUtc = new Date(Date.UTC(localParts.year, localParts.month - 1, localParts.day));
  const weekday = localDateUtc.getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  const monday = shiftUtcDate(localDateUtc, -mondayOffset);

  return {
    day: formatDateParts(localParts),
    week: formatDateParts({
      year: monday.getUTCFullYear(),
      month: monday.getUTCMonth() + 1,
      day: monday.getUTCDate(),
    }),
    month: `${localParts.year}-${String(localParts.month).padStart(2, "0")}`,
  };
}

/** Documents the normalizeClientKey behavior. */
function normalizeClientKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

/** Documents the buildClientIdentity behavior. */
function buildClientIdentity(customerName: string | null, callId: string): {
  clientKey: string;
  confidence: "high" | "low";
} {
  const normalized = customerName ? normalizeClientKey(customerName) : "";
  if (normalized.length >= 3) {
    return {
      clientKey: `name:${normalized}`,
      confidence: "high",
    };
  }

  return {
    clientKey: `call:${callId}`,
    confidence: "low",
  };
}

/** Documents the normalizeLifecycleStage behavior. */
function normalizeLifecycleStage(
  value: unknown,
  fallback: LoanLifecycleStage = "unknown"
): LoanLifecycleStage {
  return value === "not_sold" ||
    value === "future_follow_up" ||
    value === "sold_pending_follow_through" ||
    value === "fully_completed" ||
    value === "lost_cancelled" ||
    value === "unknown"
    ? value
    : fallback;
}

/** Documents the normalizeTextForHeuristics behavior. */
function normalizeTextForHeuristics(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Documents the buildLifecycleSignalText behavior. */
function buildLifecycleSignalText(snapshot: {
  nextAction: string | null;
  followUpReason: string | null;
  followUpNotes: string | null;
  lastCallSummary: string | null;
  suggestedFollowupMessage: string | null;
}): string {
  return normalizeTextForHeuristics(
    [
      snapshot.nextAction,
      snapshot.followUpReason,
      snapshot.followUpNotes,
      snapshot.lastCallSummary,
      snapshot.suggestedFollowupMessage,
    ]
      .filter(Boolean)
      .join(" | ")
  );
}

/** Documents the includesAny behavior. */
function includesAny(value: string, terms: string[]): boolean {
  return terms.some(/** Handles the callback for this operation. */(term) => value.includes(term));
}

/** Documents the inferReminderTaskType behavior. */
function inferReminderTaskType(snapshot: {
  nextAction: string | null;
  followUpReason: string | null;
  followUpNotes: string | null;
  lastCallSummary: string | null;
}): ReminderTaskType | null {
  const signal = buildLifecycleSignalText({
    nextAction: snapshot.nextAction,
    followUpReason: snapshot.followUpReason,
    followUpNotes: snapshot.followUpNotes,
    lastCallSummary: snapshot.lastCallSummary,
    suggestedFollowupMessage: null,
  });

  if (!signal) return null;
  if (includesAny(signal, ["whatsapp", "wasap", "whats"])) return "send_whatsapp";
  if (includesAny(signal, ["document", "papel", "ine", "comprobante", "archivo"])) {
    return "collect_documents";
  }
  if (includesAny(signal, ["pago", "deposit", "deposito", "completar", "finalizar", "firma"])) {
    return "confirm_payment";
  }
  if (includesAny(signal, ["info", "informacion", "cotizacion", "detalle"])) {
    return "send_info";
  }
  if (includesAny(signal, ["esper", "qued", "revis", "piens", "pendiente"])) {
    return "wait_for_customer";
  }
  if (includesAny(signal, ["marc", "llam", "hablar", "contact"])) {
    return "call_back";
  }
  return "other";
}

/** Documents the inferReminderChannel behavior. */
function inferReminderChannel(
  taskType: ReminderTaskType | null,
  snapshot: { nextAction: string | null; followUpReason: string | null }
): ReminderChannel | null {
  const signal = buildLifecycleSignalText({
    nextAction: snapshot.nextAction,
    followUpReason: snapshot.followUpReason,
    followUpNotes: null,
    lastCallSummary: null,
    suggestedFollowupMessage: null,
  });
  if (taskType === "send_whatsapp" || includesAny(signal, ["whatsapp", "wasap", "whats"])) {
    return "whatsapp";
  }
  if (taskType === "call_back" || includesAny(signal, ["llam", "marc", "hablar"])) {
    return "call";
  }
  if (includesAny(signal, ["correo", "email", "mail"])) {
    return "email";
  }
  return taskType ? "unknown" : null;
}

/** Documents the inferSaleReachedOnCall behavior. */
function inferSaleReachedOnCall(snapshot: {
  loanCompleted: LoanStatus;
  callOutcome: CallOutcome;
  followUpNeeded: boolean;
  loanAmount: number | null;
  nextAction: string | null;
  followUpReason: string | null;
  followUpNotes: string | null;
  lastCallSummary: string | null;
  suggestedFollowupMessage: string | null;
}): boolean {
  if (snapshot.loanCompleted === "yes") {
    return true;
  }
  if (snapshot.callOutcome === "success") {
    return true;
  }
  if (snapshot.callOutcome === "failure" || snapshot.callOutcome === "no_contact") {
    return false;
  }

  const signal = buildLifecycleSignalText(snapshot);
  if (!snapshot.followUpNeeded || !signal) {
    return false;
  }

  const hasAgreementSignal = includesAny(signal, [
    "acept",
    "de acuerdo",
    "si quiero",
    "si me interesa",
    "le interesa",
    "avanzar",
    "proced",
    "continua con el credito",
    "continuar con el credito",
    "tomar el credito",
    "lo toma",
    "lo quiere",
    "autoriz",
  ]);
  const hasCompletionSignal = includesAny(signal, [
    "completar",
    "finalizar",
    "document",
    "papel",
    "pago",
    "deposit",
    "firma",
    "formalizar",
    "continuar con el tramite",
    "continuar con tramite",
    "seguir con el tramite",
    "seguir con tramite",
    "validacion",
    "confirmar pago",
    "juntar documentos",
    "subir documentos",
  ]);
  const hasPostCallFollowThroughSignal = includesAny(signal, [
    "whatsapp",
    "wasap",
    "whats",
    "enviar informacion",
    "mandar informacion",
    "mandar info",
    "enviar info",
    "enviar datos",
    "mandar datos",
    "liga",
    "link",
    "formulario",
    "solicitud",
    "validar",
  ]);
  const hasFutureInterestSignal = includesAny(signal, [
    "mas adelante",
    "por ahora no",
    "ahorita no",
    "no lo necesito",
    "no necesito",
    "no por ahora",
    "lo pensare",
    "pensarlo",
    "revisarlo",
    "revisar",
    "me avisa",
    "me avisas",
    "si luego",
    "si mas adelante",
    "cuando lo necesite",
  ]);

  return (
    (hasCompletionSignal || (hasAgreementSignal && hasPostCallFollowThroughSignal)) &&
    !hasFutureInterestSignal
  );
}

/** Documents the inferLifecycleStage behavior. */
function inferLifecycleStage(snapshot: {
  loanCompleted: LoanStatus;
  callOutcome: CallOutcome;
  followUpNeeded: boolean;
  saleReachedOnCall: boolean;
}): LoanLifecycleStage {
  if (snapshot.loanCompleted === "yes") {
    return "fully_completed";
  }
  if (snapshot.saleReachedOnCall) {
    return "sold_pending_follow_through";
  }
  if (
    snapshot.callOutcome === "failure" &&
    !snapshot.followUpNeeded
  ) {
    return "lost_cancelled";
  }
  if (snapshot.callOutcome === "no_contact" || snapshot.callOutcome === "unclear") {
    return "unknown";
  }
  if (snapshot.followUpNeeded) {
    return "future_follow_up";
  }
  return "not_sold";
}

/** Documents the resolveEffectiveLoanStatus behavior. */
function resolveEffectiveLoanStatus(input: {
  rawLoanCompleted: LoanStatus;
  saleReachedOnCall: boolean;
}): LoanStatus {
  if (input.rawLoanCompleted === "yes") {
    return "yes";
  }
  if (input.saleReachedOnCall) {
    return "in_progress";
  }
  return input.rawLoanCompleted;
}

/** Documents the deriveStageSource behavior. */
function deriveStageSource(
  stage: LoanLifecycleStage,
  manualOverride: LoanLifecycleStage | null
): LifecycleStageSource {
  if (!manualOverride) {
    return "ai_inferred";
  }
  if (manualOverride === "fully_completed") return "manual_confirmed";
  if (manualOverride === "lost_cancelled") return "manual_cancelled";
  if (manualOverride === "sold_pending_follow_through") return "manual_pending";
  return stage === "fully_completed" || stage === "lost_cancelled"
    ? "system_resolved"
    : "ai_inferred";
}

/** Documents the buildCaseId behavior. */
function buildCaseId(clientKey: string): string {
  return clientKey;
}

/** Documents the buildReminderPrecision behavior. */
function buildReminderPrecision(input: {
  dueDate: string | null;
  dueTime: string | null;
  timeRange: string | null;
  conditionText: string | null;
  needsFollowUp: boolean;
}): ReminderPrecision | null {
  if (!input.needsFollowUp) {
    return null;
  }
  if (input.dueDate && input.dueTime) return "exact_datetime";
  if (input.dueDate) return "date_only";
  if (input.timeRange) return "time_range";
  if (input.conditionText) return "condition_based";
  return "unscheduled";
}

/** Documents the buildReminderSortKey behavior. */
function buildReminderSortKey(
  precision: ReminderPrecision | null,
  dueDate: string | null,
  dueTime: string | null
): string | null {
  if (!precision) return null;
  if (dueDate && dueTime) return `${dueDate}T${dueTime}`;
  if (dueDate) return `${dueDate}T23:59`;
  if (precision === "condition_based") return "9999-12-30T23:59";
  if (precision === "unscheduled") return "9999-12-31T23:59";
  return null;
}

/** Documents the buildFingerprint behavior. */
function buildFingerprint(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Documents the uniqueTitles behavior. */
function uniqueTitles(values: unknown[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

/** Documents the buildTopCounts behavior. */
function buildTopCounts(source: Record<string, number>): Array<{ label: string; count: number }> {
  return Object.entries(source)
    .sort(/** Handles the callback for this operation. */(a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0], "es");
    })
    .slice(0, TOP_LIST_LIMIT)
    .map(/** Handles the callback for this operation. */([label, count]) => ({ label, count }));
}

/** Documents the resolveActivityPromptPath behavior. */
function resolveActivityPromptPath(
  activityPromptOverrides?: Record<string, unknown> | null
): string {
  const requestedVersion = activityPromptOverrides?.[CALL_ACTIVITY_EXTRACTOR_TASK_ID];
  if (typeof requestedVersion !== "string" || requestedVersion.trim().length === 0) {
    return CALL_ACTIVITY_EXTRACTOR_PROMPT;
  }

  const promptPath = resolveCallActivityExtractorPromptPath(requestedVersion.trim());
  if (fs.existsSync(path.join(__dirname, promptPath))) {
    return promptPath;
  }

  console.warn("Ignoring missing call activity extractor prompt override:", promptPath);
  return CALL_ACTIVITY_EXTRACTOR_PROMPT;
}

/** Documents the extractCallActivity behavior. */
async function extractCallActivity(params: {
  callId: string;
  callOccurredAt: Date | null;
  callOccurredAtSource: CallOccurredAtSource | null;
  transcriptData: Record<string, any>;
  feedback: Record<string, any>;
  analyzerModel?: string | null;
  activityPromptOverrides?: Record<string, unknown> | null;
}): Promise<CallActivityExtraction> {
  const { callId, callOccurredAt, callOccurredAtSource, transcriptData, feedback } = params;
  const analyzerModel = resolveAnalyzerModel(params.analyzerModel ?? DEFAULT_ANALYZER_MODEL);

  const promptPath = resolveActivityPromptPath(params.activityPromptOverrides);
  const systemPrompt = fs.readFileSync(path.join(__dirname, promptPath), "utf-8");
  const inputJson = buildCallActivityExtractorInput({
    callId,
    callOccurredAt,
    callOccurredAtSource,
    referenceTimeZone: AGENT_ACTIVITY_TIMEZONE,
    transcriptData,
    feedback,
  });

  const userPrompt = `## Input JSON

\`\`\`json
${JSON.stringify(inputJson, null, 2)}
\`\`\`

Analiza la llamada y devuelve solo el objeto JSON final.`;

  const openai = createDemoOpenAI({ purpose: 'call_activity' });
  /** Calls the OpenAI API for model inference or transcription. */
  const response = await openai.chat.completions.create({
    model: analyzerModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    ...analyzerRequestOptions(analyzerModel),
  });

  const responseText = response.choices[0]?.message?.content;
  if (!responseText) {
    throw new Error("No response from call activity extractor");
  }

  return normalizeCallActivityExtraction(callId, JSON.parse(responseText), feedback);
}

/** Documents the buildSnapshot behavior. */
export function buildSnapshot(params: {
  callId: string;
  callData: Record<string, any>;
  feedback: Record<string, any>;
  latestFeedbackId: string;
  activityExtraction: CallActivityExtraction | null;
  manualReminderInput: ManualReminderInput | null;
}): AgentCallSnapshot {
  const { callId, callData, feedback, latestFeedbackId, activityExtraction, manualReminderInput } = params;
  const uploadedBy = typeof callData.uploadedBy === "string" ? callData.uploadedBy : "";
  const salesAgentId = typeof callData.salesAgentId === "string" ? callData.salesAgentId : "";
  const salesAgentName = typeof callData.salesAgentName === "string" ? callData.salesAgentName : salesAgentId;
  const agentKey = buildAgentKey(uploadedBy, salesAgentId);
  const environmentTarget = callData.environmentTarget === 'test' || callData.environmentTarget === 'prod'
    ? callData.environmentTarget
    : undefined;
  const callOccurrence = resolveCallOccurredAtDate(callData);
  const bucketKeys = getBucketKeys(callOccurrence.date);
  const suggestedFollowupMessage = normalizeNullableString(feedback.suggested_followup_message);
  const rawLoanCompleted = normalizeLoanStatus(
    activityExtraction?.loan_completed ?? feedback.loan_completed,
    "unclear"
  );
  const callOutcome = normalizeCallOutcome(
    activityExtraction?.call_outcome,
    rawLoanCompleted,
    suggestedFollowupMessage
  );
  const customerName =
    activityExtraction?.client_name ??
    normalizeNullableString(feedback.customer_name) ??
    null;
  const clientIdentity = buildClientIdentity(customerName, callId);
  const caseId = buildCaseId(clientIdentity.clientKey);
  const manualNeedsFollowUp = manualReminderInput?.needsFollowUp === true;
  const aiNeedsFollowUp = activityExtraction?.follow_up_needed === true;
  const needsFollowUp = manualNeedsFollowUp || aiNeedsFollowUp;
  const followUpDate = manualReminderInput?.followUpDate ?? activityExtraction?.follow_up_date ?? null;
  const followUpTime = manualReminderInput?.followUpTime ?? activityExtraction?.follow_up_time ?? null;
  const followUpTimeRange = activityExtraction?.follow_up_time_range ?? null;
  const callbackCondition = activityExtraction?.client_callback_condition ?? null;
  const nextAction = manualReminderInput?.nextAction ?? activityExtraction?.next_action ?? null;
  const followUpNotes = manualReminderInput?.note ?? activityExtraction?.follow_up_notes ?? null;
  const reminderPrecision = buildReminderPrecision({
    dueDate: followUpDate,
    dueTime: followUpTime,
    timeRange: followUpTimeRange,
    conditionText: callbackCondition,
    needsFollowUp,
  });
  let reminderOrigin: ReminderOrigin | null = null;
  if (manualNeedsFollowUp && aiNeedsFollowUp) reminderOrigin = "manual_and_ai";
  else if (manualNeedsFollowUp) reminderOrigin = "manual_first_call";
  else if (aiNeedsFollowUp) reminderOrigin = "ai_transcript";
  const reminderTaskType = inferReminderTaskType({
    nextAction,
    followUpReason: activityExtraction?.follow_up_reason ?? null,
    followUpNotes,
    lastCallSummary: activityExtraction?.last_call_summary ?? null,
  });
  const reminderChannel = inferReminderChannel(reminderTaskType, {
    nextAction,
    followUpReason: activityExtraction?.follow_up_reason ?? null,
  });
  const saleReachedOnCall = inferSaleReachedOnCall({
    loanCompleted: rawLoanCompleted,
    callOutcome,
    followUpNeeded: needsFollowUp,
    loanAmount: activityExtraction?.loan_amount ?? null,
    nextAction,
    followUpReason: activityExtraction?.follow_up_reason ?? null,
    followUpNotes,
    lastCallSummary: activityExtraction?.last_call_summary ?? null,
    suggestedFollowupMessage,
  });
  const loanCompleted = resolveEffectiveLoanStatus({
    rawLoanCompleted,
    saleReachedOnCall,
  });
  const inferredLifecycleStage = inferLifecycleStage({
    loanCompleted,
    callOutcome,
    followUpNeeded: needsFollowUp,
    saleReachedOnCall,
  });

  const strengthTitles = uniqueTitles(
    Array.isArray(feedback.agent_strengths) ? feedback.agent_strengths.map(/** Handles the callback for this operation. */(item: any) => item?.title) : []
  );
  const weaknessTitles = uniqueTitles(
    Array.isArray(feedback.agent_weaknesses) ? feedback.agent_weaknesses.map(/** Handles the callback for this operation. */(item: any) => item?.title) : []
  );
  const weaknessSeverities = uniqueTitles(
    Array.isArray(feedback.agent_weaknesses)
      ? feedback.agent_weaknesses.map(/** Handles the callback for this operation. */(item: any) => item?.severity)
      : []
  );

  const snapshot: AgentCallSnapshot = {
    sourceCallId: callId,
    uploadedBy,
    salesAgentId,
    salesAgentName,
    agentKey,
    latestFeedbackId,
    feedbackSchemaVersion:
      typeof feedback?.rubric_scorecard_v2?.rubric_version === "string"
        ? feedback.rubric_scorecard_v2.rubric_version
        : feedback?.rubric_scorecard
          ? "legacy_tmk"
          : "unknown",
    analyzerModel:
      typeof callData.analyzerModel === "string" && callData.analyzerModel.length > 0
        ? callData.analyzerModel
        : DEFAULT_ANALYZER_MODEL,
    ...(environmentTarget ? { environmentTarget } : {}),
    callName: normalizeNullableString(callData.name),
    callOccurredAtMs: callOccurrence.date.getTime(),
    callOccurredAtIso: callOccurrence.date.toISOString(),
    callOccurredAtSource: callOccurrence.source,
    bucketDay: bucketKeys.day,
    bucketWeek: bucketKeys.week,
    bucketMonth: bucketKeys.month,
    agentName:
      activityExtraction?.agent_name ??
      normalizeNullableString(feedback.agent_name) ??
      null,
    customerName,
    clientKey: clientIdentity.clientKey,
    clientKeyConfidence: clientIdentity.confidence,
    caseId,
    callOutcome,
    loanCompleted,
    saleReachedOnCall,
    inferredLifecycleStage,
    effectiveLifecycleStage: inferredLifecycleStage,
    lifecycleStageSource: "ai_inferred",
    loanAmount: activityExtraction?.loan_amount ?? null,
    currency: activityExtraction?.currency ?? null,
    saleDate: activityExtraction?.sale_date ?? null,
    followUpNeeded: needsFollowUp,
    reminderTaskType,
    reminderChannel,
    nextAction,
    followUpDate,
    followUpTime,
    followUpTimeRange,
    followUpReason: activityExtraction?.follow_up_reason ?? null,
    followUpNotes,
    clientCallbackCondition: callbackCondition,
    confidenceScore: activityExtraction?.confidence_score ?? null,
    lastCallSummary: activityExtraction?.last_call_summary ?? null,
    nextBestAction: activityExtraction?.next_best_action ?? null,
    whatAgentShouldSayNext: activityExtraction?.what_agent_should_say_next ?? null,
    reminderOrigin,
    reminderPrecision,
    reminderSortKey: buildReminderSortKey(reminderPrecision, followUpDate, followUpTime),
    suggestedFollowupMessage,
    overallScore: typeof feedback.overall_score === "number" ? feedback.overall_score : null,
    lowConfidence: Boolean(feedback.low_confidence),
    performanceTier: normalizeNullableString(feedback.performance_tier),
    callCategory: normalizeNullableString(feedback.call_category),
    strengthTitles,
    weaknessTitles,
    weaknessSeverities,
    manualReminderInput,
    activityExtraction,
    snapshotFingerprint: "",
  };

  snapshot.snapshotFingerprint = buildFingerprint({
    latestFeedbackId,
    reminderOrigin: snapshot.reminderOrigin,
    reminderPrecision: snapshot.reminderPrecision,
    followUpDate: snapshot.followUpDate,
    followUpTime: snapshot.followUpTime,
    clientKey: snapshot.clientKey,
    caseId: snapshot.caseId,
    callOutcome: snapshot.callOutcome,
    loanCompleted: snapshot.loanCompleted,
    saleReachedOnCall: snapshot.saleReachedOnCall,
    inferredLifecycleStage: snapshot.inferredLifecycleStage,
    loanAmount: snapshot.loanAmount,
    overallScore: snapshot.overallScore,
    lowConfidence: snapshot.lowConfidence,
    strengthTitles: snapshot.strengthTitles,
    weaknessTitles: snapshot.weaknessTitles,
  });

  return snapshot;
}

/** Documents the buildReminderDocument behavior. */
function buildReminderDocument(snapshot: AgentCallSnapshot): Record<string, any> | null {
  if (!snapshot.followUpNeeded || !snapshot.reminderOrigin || !snapshot.reminderPrecision) {
    return null;
  }

  /** Calls an external SDK or API dependency. */
  return {
    reminderId: snapshot.sourceCallId,
    uploadedBy: snapshot.uploadedBy,
    salesAgentId: snapshot.salesAgentId,
    salesAgentName: snapshot.salesAgentName,
    agentKey: snapshot.agentKey,
    clientKey: snapshot.clientKey,
    clientKeyConfidence: snapshot.clientKeyConfidence,
    customerName: snapshot.customerName,
    sourceCallId: snapshot.sourceCallId,
    caseId: snapshot.caseId,
    callOutcome: snapshot.callOutcome,
    loanCompleted: snapshot.loanCompleted,
    lifecycleStage: snapshot.inferredLifecycleStage,
    lifecycleStageSource: snapshot.lifecycleStageSource,
    origin: snapshot.reminderOrigin,
    state: "open" as ReminderState,
    taskType: snapshot.reminderTaskType,
    channel: snapshot.reminderChannel,
    temporalConfidence: snapshot.confidenceScore,
    dateInterpretation: snapshot.followUpDate ? "explicit_date" : snapshot.clientCallbackCondition ? "condition_based" : "unspecified",
    aiDueDate: snapshot.activityExtraction?.follow_up_date ?? null,
    aiDueTime: snapshot.activityExtraction?.follow_up_time ?? null,
    aiTimeRange: snapshot.activityExtraction?.follow_up_time_range ?? null,
    aiConditionText: snapshot.activityExtraction?.client_callback_condition ?? null,
    nextAction: snapshot.nextAction,
    reason: snapshot.followUpReason,
    notes: snapshot.followUpNotes,
    confidenceScore: snapshot.confidenceScore,
    lastCallSummary: snapshot.lastCallSummary,
    nextBestAction: snapshot.nextBestAction,
    whatAgentShouldSayNext: snapshot.whatAgentShouldSayNext,
    suggestedFollowupMessage: snapshot.suggestedFollowupMessage,
    evidenceQuotes: snapshot.activityExtraction?.evidence_quotes ?? [],
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/** Documents the buildEffectiveReminderFields behavior. */
function buildEffectiveReminderFields(input: {
  dueDate: string | null;
  dueTime: string | null;
  timeRange: string | null;
  conditionText: string | null;
  needsFollowUp: boolean;
}) {
  const precision = buildReminderPrecision(input);
  const sortKey = buildReminderSortKey(precision, input.dueDate, input.dueTime);
  return {
    precision,
    sortKey,
  };
}

/** Documents the upsertReminderForSnapshot behavior. */
async function upsertReminderForSnapshot(
  agentRef: FirebaseFirestore.DocumentReference,
  snapshot: AgentCallSnapshot
): Promise<void> {
  const remindersRef = agentRef.collection("reminders");
  const reminderDoc = buildReminderDocument(snapshot);
  /** Calls an external SDK or API dependency. */
  const existingReminderRef = remindersRef.doc(snapshot.sourceCallId);
  const existingReminderDoc = await existingReminderRef.get();
  const existingReminderData = existingReminderDoc.data();

  if (reminderDoc) {
    /** Calls an external SDK or API dependency. */
    const relatedRemindersSnapshot = await remindersRef
      .where("clientKey", "==", snapshot.clientKey)
      .get();

    /** Calls Firebase Firestore to read or write persisted application data. */
    const batch = db.batch();
    for (const doc of relatedRemindersSnapshot.docs) {
      if (doc.id === snapshot.sourceCallId) {
        continue;
      }
      const data = doc.data();
      if (data.state === "open") {
        /** Calls an external SDK or API dependency. */
        batch.update(doc.ref, {
          state: "superseded",
          supersededBy: snapshot.sourceCallId,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    const preservedState =
      existingReminderData?.state === "done" ||
        existingReminderData?.state === "closed" ||
        existingReminderData?.state === "superseded"
        ? existingReminderData.state
        : "open";
    const manualDueDate =
      normalizeNullableString(existingReminderData?.manualDueDate) ??
      snapshot.manualReminderInput?.followUpDate ??
      null;
    const manualDueTime =
      normalizeNullableString(existingReminderData?.manualDueTime) ??
      snapshot.manualReminderInput?.followUpTime ??
      null;
    const manualTimeRange = normalizeNullableString(existingReminderData?.manualTimeRange);
    const manualConditionText = normalizeNullableString(existingReminderData?.manualConditionText);
    const manualNotes =
      normalizeNullableString(existingReminderData?.manualNotes) ??
      snapshot.manualReminderInput?.note ??
      null;

    const effectiveDueDate = manualDueDate ?? reminderDoc.aiDueDate ?? null;
    const effectiveDueTime = manualDueTime ?? reminderDoc.aiDueTime ?? null;
    const effectiveTimeRange = manualTimeRange ?? reminderDoc.aiTimeRange ?? null;
    const effectiveConditionText = manualConditionText ?? reminderDoc.aiConditionText ?? null;
    const effectiveSchedule = buildEffectiveReminderFields({
      dueDate: effectiveDueDate,
      dueTime: effectiveDueTime,
      timeRange: effectiveTimeRange,
      conditionText: effectiveConditionText,
      needsFollowUp: true,
    });

    /** Calls an external SDK or API dependency. */
    batch.set(
      existingReminderRef,
      {
        ...reminderDoc,
        uploadedBy: snapshot.uploadedBy,
        manualDueDate,
        manualDueTime,
        manualTimeRange,
        manualConditionText,
        manualNotes,
        effectiveDueDate,
        effectiveDueTime,
        effectiveTimeRange,
        effectiveConditionText,
        effectivePrecision: effectiveSchedule.precision,
        effectiveSortKey: effectiveSchedule.sortKey,
        dueDate: effectiveDueDate,
        dueTime: effectiveDueTime,
        timeRange: effectiveTimeRange,
        conditionText: effectiveConditionText,
        precision: effectiveSchedule.precision,
        sortKey: effectiveSchedule.sortKey,
        notes: manualNotes ?? reminderDoc.notes ?? null,
        createdAt: existingReminderDoc.exists
          ? existingReminderData?.createdAt ?? FieldValue.serverTimestamp()
          : FieldValue.serverTimestamp(),
        state: preservedState,
      },
      { merge: true }
    );
    await batch.commit();
    return;
  }

  if (existingReminderDoc.exists && existingReminderData?.state === "open") {
    /** Calls an external SDK or API dependency. */
    await existingReminderRef.update({
      state: "closed",
      closedReason: "no_longer_supported",
      closedByCallId: snapshot.sourceCallId,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  if (
    snapshot.clientKeyConfidence === "high" &&
    (snapshot.callOutcome === "success" || snapshot.callOutcome === "failure")
  ) {
    /** Calls an external SDK or API dependency. */
    const relatedRemindersSnapshot = await remindersRef
      .where("clientKey", "==", snapshot.clientKey)
      .get();
    /** Calls Firebase Firestore to read or write persisted application data. */
    const batch = db.batch();
    for (const doc of relatedRemindersSnapshot.docs) {
      if (doc.id === snapshot.sourceCallId) {
        continue;
      }
      const data = doc.data();
      if (data.state === "open") {
        /** Calls an external SDK or API dependency. */
        batch.update(doc.ref, {
          state: "closed",
          closedReason: `resolved_by_${snapshot.callOutcome}`,
          closedByCallId: snapshot.sourceCallId,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
    await batch.commit();
  }
}

/** Documents the upsertLoanCaseForSnapshot behavior. */
async function upsertLoanCaseForSnapshot(
  agentRef: FirebaseFirestore.DocumentReference,
  snapshot: AgentCallSnapshot
): Promise<void> {
  /** Calls an external SDK or API dependency. */
  const caseRef = agentRef.collection("loan_cases").doc(snapshot.caseId);
  /** Calls an external SDK or API dependency. */
  const [existingCaseDoc, snapshotsForClient, activeRemindersSnapshot] = await Promise.all([
    caseRef.get(),
    agentRef.collection("call_snapshots").where("clientKey", "==", snapshot.clientKey).get(),
    agentRef
      .collection("reminders")
      .where("caseId", "==", snapshot.caseId)
      .where("state", "==", "open")
      .get(),
  ]);

  const caseData = existingCaseDoc.data() ?? {};
  const snapshots = snapshotsForClient.docs
    .map(/** Handles the callback for this operation. */(doc) => doc.data() as Record<string, any>)
    .sort(/** Handles the callback for this operation. */(a, b) => (Number(a.callOccurredAtMs) || 0) - (Number(b.callOccurredAtMs) || 0));

  const latestSnapshot = snapshots[snapshots.length - 1] ?? snapshot;
  const linkedCallIds = snapshotsForClient.docs
    .map(/** Handles the callback for this operation. */(doc) => doc.id)
    .sort(/** Handles the callback for this operation. */(a, b) => {
      const aData = snapshotsForClient.docs.find(/** Handles the callback for this operation. */(doc) => doc.id === a)?.data();
      const bData = snapshotsForClient.docs.find(/** Handles the callback for this operation. */(doc) => doc.id === b)?.data();
      return (Number(aData?.callOccurredAtMs) || 0) - (Number(bData?.callOccurredAtMs) || 0);
    });

  const saleReachedSnapshot = [...snapshots].reverse().find(/** Handles the callback for this operation. */(entry) => entry.saleReachedOnCall === true);
  const amountSourceSnapshot = saleReachedSnapshot ?? latestSnapshot;
  const aiInferredStage =
    normalizeLifecycleStage(
      latestSnapshot.effectiveLifecycleStage ?? latestSnapshot.inferredLifecycleStage,
      snapshot.inferredLifecycleStage
    );
  const manualStageOverride = normalizeLifecycleStage(caseData.manualStageOverride, "unknown");
  const manualOverride = manualStageOverride === "unknown" ? null : manualStageOverride;
  const effectiveStage = manualOverride ?? aiInferredStage;
  const activeReminderIds = activeRemindersSnapshot.docs.map(/** Handles the callback for this operation. */(doc) => doc.id);

  const loanCase: LoanCaseDocument = {
    caseId: snapshot.caseId,
    uploadedBy: snapshot.uploadedBy,
    salesAgentId: snapshot.salesAgentId,
    salesAgentName: snapshot.salesAgentName,
    agentKey: snapshot.agentKey,
    clientKey: snapshot.clientKey,
    clientKeyConfidence: snapshot.clientKeyConfidence,
    customerName:
      normalizeNullableString(caseData.customerName) ??
      normalizeNullableString(latestSnapshot.customerName) ??
      snapshot.customerName,
    linkedCallIds,
    callCount: linkedCallIds.length,
    latestCallId: typeof latestSnapshot.sourceCallId === "string" ? latestSnapshot.sourceCallId : snapshot.sourceCallId,
    latestCallOccurredAtMs: Number(latestSnapshot.callOccurredAtMs) || snapshot.callOccurredAtMs,
    latestCallOccurredAtIso:
      typeof latestSnapshot.callOccurredAtIso === "string"
        ? latestSnapshot.callOccurredAtIso
        : snapshot.callOccurredAtIso,
    latestBucketDay:
      typeof latestSnapshot.bucketDay === "string" ? latestSnapshot.bucketDay : snapshot.bucketDay,
    latestBucketWeek:
      typeof latestSnapshot.bucketWeek === "string" ? latestSnapshot.bucketWeek : snapshot.bucketWeek,
    latestBucketMonth:
      typeof latestSnapshot.bucketMonth === "string" ? latestSnapshot.bucketMonth : snapshot.bucketMonth,
    saleReachedOnCall: snapshots.some(/** Handles the callback for this operation. */(entry) => entry.saleReachedOnCall === true),
    saleReachedCallId:
      typeof saleReachedSnapshot?.sourceCallId === "string" ? saleReachedSnapshot.sourceCallId : null,
    saleReachedAtIso:
      typeof saleReachedSnapshot?.callOccurredAtIso === "string" ? saleReachedSnapshot.callOccurredAtIso : null,
    loanAmount:
      typeof amountSourceSnapshot?.loanAmount === "number" ? amountSourceSnapshot.loanAmount : null,
    currency:
      typeof amountSourceSnapshot?.currency === "string" ? amountSourceSnapshot.currency : null,
    aiInferredStage,
    manualStageOverride: manualOverride,
    effectiveStage,
    stageSource: deriveStageSource(effectiveStage, manualOverride),
    followThroughRequired: effectiveStage === "sold_pending_follow_through",
    latestNextAction:
      normalizeNullableString(latestSnapshot.nextAction) ?? snapshot.nextAction,
    latestWhatAgentShouldSayNext:
      normalizeNullableString(latestSnapshot.whatAgentShouldSayNext) ?? snapshot.whatAgentShouldSayNext,
    latestSummary:
      normalizeNullableString(latestSnapshot.lastCallSummary) ?? snapshot.lastCallSummary,
    activeReminderIds,
    overrideNote: normalizeNullableString(caseData.overrideNote),
    overrideUpdatedBy: normalizeNullableString(caseData.overrideUpdatedBy),
    overrideUpdatedAtIso: normalizeNullableString(caseData.overrideUpdatedAtIso),
  };

  /** Calls an external SDK or API dependency. */
  await caseRef.set(
    {
      ...loanCase,
      createdAt: existingCaseDoc.exists
        ? caseData.createdAt ?? FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Documents the recomputeSalesRollup behavior. */
async function recomputeSalesRollup(
  agentRef: FirebaseFirestore.DocumentReference,
  periodType: "day" | "week" | "month",
  bucketKey: string
): Promise<void> {
  const bucketField = periodType === "day" ? "bucketDay" : periodType === "week" ? "bucketWeek" : "bucketMonth";
  const caseBucketField =
    periodType === "day" ? "latestBucketDay" : periodType === "week" ? "latestBucketWeek" : "latestBucketMonth";
  /** Calls an external SDK or API dependency. */
  const [snapshots, loanCases] = await Promise.all([
    agentRef.collection("call_snapshots").where(bucketField, "==", bucketKey).get(),
    agentRef.collection("loan_cases").where(caseBucketField, "==", bucketKey).get(),
  ]);

  const outcomeCounts: Record<string, number> = {};
  let totalCalls = 0;
  let soldLoanCount = 0;
  let soldOnCallCount = 0;
  let soldPendingFollowThroughCount = 0;
  let confirmedCompletedCount = 0;
  let lostCancelledCount = 0;
  let activeCaseCount = 0;
  let totalAmountSold = 0;
  let knownLoanAmountCount = 0;
  let followUpNeededCount = 0;
  let pendingLoanAmountTotal = 0;
  let completedLoanAmountTotal = 0;

  const sourceCallIds: string[] = [];

  for (const doc of snapshots.docs) {
    const data = doc.data();
    totalCalls += 1;
    sourceCallIds.push(doc.id);
    const callOutcome = typeof data.callOutcome === "string" ? data.callOutcome : "unclear";
    outcomeCounts[callOutcome] = (outcomeCounts[callOutcome] || 0) + 1;

    if (data.followUpNeeded === true) {
      followUpNeededCount += 1;
    }
  }

  for (const doc of loanCases.docs) {
    const data = doc.data();
    activeCaseCount += 1;
    const effectiveStage = normalizeLifecycleStage(data.effectiveStage);
    const stageSource =
      typeof data.stageSource === "string" ? data.stageSource : "ai_inferred";
    const countsAsSold =
      effectiveStage === "sold_pending_follow_through" || effectiveStage === "fully_completed";
    if (data.saleReachedOnCall === true && countsAsSold) {
      soldOnCallCount += 1;
    }
    if (countsAsSold) {
      soldLoanCount += 1;
      if (typeof data.loanAmount === "number") {
        totalAmountSold += data.loanAmount;
        knownLoanAmountCount += 1;
      }
    }
    if (effectiveStage === "sold_pending_follow_through") {
      soldPendingFollowThroughCount += 1;
      if (typeof data.loanAmount === "number") {
        pendingLoanAmountTotal += data.loanAmount;
      }
    }
    if (effectiveStage === "fully_completed" && stageSource !== "ai_inferred") {
      confirmedCompletedCount += 1;
      if (typeof data.loanAmount === "number") {
        completedLoanAmountTotal += data.loanAmount;
      }
    }
    if (effectiveStage === "lost_cancelled") {
      lostCancelledCount += 1;
    }
  }

  /** Calls an external SDK or API dependency. */
  await agentRef.collection("sales_rollups").doc(`${periodType}_${bucketKey}`).set(
    {
      periodType,
      bucketKey,
      sourceCallIds,
      totalCalls,
      soldLoanCount,
      soldOnCallCount,
      soldPendingFollowThroughCount,
      confirmedCompletedCount,
      lostCancelledCount,
      activeCaseCount,
      totalAmountSold,
      knownLoanAmountCount,
      averageLoanAmount: knownLoanAmountCount > 0 ? totalAmountSold / knownLoanAmountCount : null,
      pendingLoanAmountTotal,
      completedLoanAmountTotal,
      outcomeCounts,
      followUpNeededCount,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Documents the recomputeProgressRollup behavior. */
async function recomputeProgressRollup(
  agentRef: FirebaseFirestore.DocumentReference,
  periodType: "day" | "week" | "month",
  bucketKey: string
): Promise<void> {
  const bucketField = periodType === "day" ? "bucketDay" : periodType === "week" ? "bucketWeek" : "bucketMonth";
  /** Calls an external SDK or API dependency. */
  const snapshots = await agentRef.collection("call_snapshots").where(bucketField, "==", bucketKey).get();

  const outcomeCounts: Record<string, number> = {};
  const performanceTierCounts: Record<string, number> = {};
  const strengthCounts: Record<string, number> = {};
  const weaknessCounts: Record<string, number> = {};

  let totalReviewedCalls = 0;
  let lowConfidenceCallCount = 0;
  let eligibleScoreCount = 0;
  let scoreSum = 0;

  const sourceCallIds: string[] = [];

  for (const doc of snapshots.docs) {
    const data = doc.data();
    totalReviewedCalls += 1;
    sourceCallIds.push(doc.id);

    const callOutcome = typeof data.callOutcome === "string" ? data.callOutcome : "unclear";
    outcomeCounts[callOutcome] = (outcomeCounts[callOutcome] || 0) + 1;

    if (typeof data.performanceTier === "string" && data.performanceTier.length > 0) {
      performanceTierCounts[data.performanceTier] = (performanceTierCounts[data.performanceTier] || 0) + 1;
    }

    if (data.lowConfidence === true) {
      lowConfidenceCallCount += 1;
    } else if (typeof data.overallScore === "number") {
      eligibleScoreCount += 1;
      scoreSum += data.overallScore;
    }

    const strengthTitles = Array.isArray(data.strengthTitles) ? uniqueTitles(data.strengthTitles) : [];
    const weaknessTitles = Array.isArray(data.weaknessTitles) ? uniqueTitles(data.weaknessTitles) : [];

    for (const title of strengthTitles) {
      strengthCounts[title] = (strengthCounts[title] || 0) + 1;
    }
    for (const title of weaknessTitles) {
      weaknessCounts[title] = (weaknessCounts[title] || 0) + 1;
    }
  }

  /** Calls an external SDK or API dependency. */
  await agentRef.collection("progress_rollups").doc(`${periodType}_${bucketKey}`).set(
    {
      periodType,
      bucketKey,
      sourceCallIds,
      totalReviewedCalls,
      lowConfidenceCallCount,
      eligibleScoreCount,
      averageScore: eligibleScoreCount > 0 ? scoreSum / eligibleScoreCount : null,
      outcomeCounts,
      performanceTierCounts,
      strengthCounts,
      weaknessCounts,
      topStrengths: buildTopCounts(strengthCounts),
      topWeaknesses: buildTopCounts(weaknessCounts),
      coachingPriorities: buildTopCounts(weaknessCounts),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Documents the buildAgentKey behavior. */
export function buildAgentKey(uploadedBy: string, salesAgentId: string): string {
  return `${uploadedBy}__${salesAgentId}`;
}

export interface RefreshAgentActivityDateFieldsResult {
  updated: boolean;
  skippedReason?: "missing_call" | "missing_agent" | "excluded" | "missing_snapshot" | "already_current";
  agentKey?: string;
  oldBuckets?: { day: string | null; week: string | null; month: string | null };
  newBuckets?: { day: string; week: string; month: string };
  oldCallOccurredAtSource?: string | null;
}

function addBucketTarget(targets: Map<string, Set<string>>, periodType: "day" | "week" | "month", bucketKey: unknown): void {
  if (typeof bucketKey !== "string" || bucketKey.length === 0) return;
  const existing = targets.get(periodType) ?? new Set<string>();
  existing.add(bucketKey);
  targets.set(periodType, existing);
}

async function recomputeAgentActivityRollupsForBuckets(
  agentRef: FirebaseFirestore.DocumentReference,
  oldBuckets: { day?: unknown; week?: unknown; month?: unknown },
  newBuckets: { day: string; week: string; month: string }
): Promise<void> {
  const targets = new Map<"day" | "week" | "month", Set<string>>();
  addBucketTarget(targets, "day", oldBuckets.day);
  addBucketTarget(targets, "week", oldBuckets.week);
  addBucketTarget(targets, "month", oldBuckets.month);
  addBucketTarget(targets, "day", newBuckets.day);
  addBucketTarget(targets, "week", newBuckets.week);
  addBucketTarget(targets, "month", newBuckets.month);

  const jobs: Promise<void>[] = [];
  for (const [periodType, bucketKeys] of targets.entries()) {
    for (const bucketKey of bucketKeys) {
      jobs.push(recomputeSalesRollup(agentRef, periodType, bucketKey));
      jobs.push(recomputeProgressRollup(agentRef, periodType, bucketKey));
    }
  }
  await Promise.all(jobs);
}

export async function refreshAgentActivityDateFieldsForCall(params: {
  callId: string;
  callData?: FirebaseFirestore.DocumentData;
}): Promise<RefreshAgentActivityDateFieldsResult> {
  const callRef = db.collection("calls").doc(params.callId);
  const callDoc = params.callData ? null : await callRef.get();
  const callData = (params.callData ?? callDoc?.data()) as Record<string, any> | undefined;
  if (!callData) return { updated: false, skippedReason: "missing_call" };

  const uploadedBy = typeof callData.uploadedBy === "string" ? callData.uploadedBy : "";
  const salesAgentId = typeof callData.salesAgentId === "string" ? callData.salesAgentId : "";
  if (!uploadedBy || !salesAgentId) return { updated: false, skippedReason: "missing_agent" };
  const agentKey = buildAgentKey(uploadedBy, salesAgentId);

  if (isAgentProfileCallExcluded(callData)) {
    return { updated: false, skippedReason: "excluded", agentKey };
  }

  const callOccurrence = resolveCallOccurredAtDate(callData);
  const nextBuckets = getBucketKeys(callOccurrence.date);
  const agentRef = db.collection(AGENT_ACTIVITY_COLLECTION).doc(agentKey);
  const snapshotRef = agentRef.collection("call_snapshots").doc(params.callId);
  const snapshotDoc = await snapshotRef.get();
  if (!snapshotDoc.exists) return { updated: false, skippedReason: "missing_snapshot", agentKey };

  const snapshotData = snapshotDoc.data() ?? {};
  const oldBuckets = {
    day: typeof snapshotData.bucketDay === "string" ? snapshotData.bucketDay : null,
    week: typeof snapshotData.bucketWeek === "string" ? snapshotData.bucketWeek : null,
    month: typeof snapshotData.bucketMonth === "string" ? snapshotData.bucketMonth : null,
  };
  const nextCallOccurredAtMs = callOccurrence.date.getTime();
  const nextCallOccurredAtIso = callOccurrence.date.toISOString();
  const oldSource = typeof snapshotData.callOccurredAtSource === "string" ? snapshotData.callOccurredAtSource : null;
  const alreadyCurrent =
    snapshotData.callOccurredAtMs === nextCallOccurredAtMs &&
    snapshotData.callOccurredAtIso === nextCallOccurredAtIso &&
    snapshotData.callOccurredAtSource === callOccurrence.source &&
    snapshotData.bucketDay === nextBuckets.day &&
    snapshotData.bucketWeek === nextBuckets.week &&
    snapshotData.bucketMonth === nextBuckets.month;

  if (alreadyCurrent) {
    return {
      updated: false,
      skippedReason: "already_current",
      agentKey,
      oldBuckets,
      newBuckets: nextBuckets,
      oldCallOccurredAtSource: oldSource,
    };
  }

  const update = {
    callOccurredAtMs: nextCallOccurredAtMs,
    callOccurredAtIso: nextCallOccurredAtIso,
    callOccurredAtSource: callOccurrence.source,
    bucketDay: nextBuckets.day,
    bucketWeek: nextBuckets.week,
    bucketMonth: nextBuckets.month,
    updatedAt: FieldValue.serverTimestamp(),
  };
  await snapshotRef.set(update, { merge: true });
  const nextSnapshot = { ...(snapshotData as Record<string, any>), ...update } as unknown as AgentCallSnapshot;
  if (typeof nextSnapshot.caseId === "string" && nextSnapshot.caseId.length > 0) {
    await upsertLoanCaseForSnapshot(agentRef, nextSnapshot);
  }
  await recomputeAgentActivityRollupsForBuckets(agentRef, oldBuckets, nextBuckets);

  return {
    updated: true,
    agentKey,
    oldBuckets,
    newBuckets: nextBuckets,
    oldCallOccurredAtSource: oldSource,
  };
}

/** Documents the cccAgentActivityVisibilityFields behavior. */
export function cccAgentActivityVisibilityFields(callData: Record<string, unknown>): Record<string, unknown> {
  if (isDemoManualCall(callData)) {
    return {
      organizationId: CONSUBANCO_ORGANIZATION_ID,
      organizationName: CONSUBANCO_ORGANIZATION_NAME,
      visibilityScope: "organization",
      activitySource: "manual_upload",
    };
  }
  return {};
}

/** Documents the cleanupAgentActivityForExcludedCall behavior. */
export async function cleanupAgentActivityForExcludedCall(params: {
  uploadedBy: string;
  salesAgentId: string;
  callId: string;
}): Promise<{
  removedSnapshot: boolean;
  removedReminder: boolean;
  recomputedBuckets: string[];
  recomputedCaseId?: string;
}> {
  const uploadedBy = params.uploadedBy.trim();
  const salesAgentId = params.salesAgentId.trim();
  const callId = params.callId.trim();
  if (!uploadedBy || !salesAgentId || !callId) {
    return {
      removedSnapshot: false,
      removedReminder: false,
      recomputedBuckets: [],
    };
  }

  const agentKey = buildAgentKey(uploadedBy, salesAgentId);
  /** Calls Firebase Firestore to read or write persisted application data. */
  const agentRef = db.collection(AGENT_ACTIVITY_COLLECTION).doc(agentKey);
  /** Calls Firebase Firestore to read or write persisted application data. */
  const snapshotRef = agentRef.collection("call_snapshots").doc(callId);
  /** Calls Firebase Firestore to read or write persisted application data. */
  const reminderRef = agentRef.collection("reminders").doc(callId);

  /** Calls Firebase Firestore to read the current snapshot before cleanup. */
  const snapshotDoc = await snapshotRef.get();
  const snapshotData = snapshotDoc.data() ?? {};

  /** Calls Firebase Firestore to read the reminder before cleanup. */
  const reminderDoc = await reminderRef.get();

  const removedSnapshot = snapshotDoc.exists;
  const removedReminder = reminderDoc.exists;

  const bucketDay = typeof snapshotData.bucketDay === "string" ? snapshotData.bucketDay : null;
  const bucketWeek = typeof snapshotData.bucketWeek === "string" ? snapshotData.bucketWeek : null;
  const bucketMonth = typeof snapshotData.bucketMonth === "string" ? snapshotData.bucketMonth : null;
  const clientKey = typeof snapshotData.clientKey === "string" ? snapshotData.clientKey : null;
  const caseId =
    typeof snapshotData.caseId === "string"
      ? snapshotData.caseId
      : clientKey
        ? buildCaseId(clientKey)
        : null;

  if (removedSnapshot || removedReminder) {
    /** Calls Firebase Firestore to delete stale agent-activity state for excluded duplicate calls. */
    const batch = db.batch();
    if (removedSnapshot) {
      batch.delete(snapshotRef);
    }
    if (removedReminder) {
      batch.delete(reminderRef);
    }
    await batch.commit();
  }

  let recomputedCaseId: string | undefined;
  if (clientKey && caseId) {
    recomputedCaseId = caseId;
    /** Calls Firebase Firestore to recompute loan-case state after excluding a call. */
    const snapshotsForClient = await agentRef
      .collection("call_snapshots")
      .where("clientKey", "==", clientKey)
      .get();

    if (snapshotsForClient.size === 0) {
      /** Calls Firebase Firestore to remove orphaned loan-case docs after excluding calls. */
      await agentRef.collection("loan_cases").doc(caseId).delete().catch(/** Handles the callback for this operation. */ () => undefined);
    } else {
      const latestSnapshot = snapshotsForClient.docs
        .map(/** Handles the callback for this operation. */ (doc) => doc.data() as Record<string, unknown>)
        .sort(/** Handles the callback for this operation. */ (left, right) => (Number(left.callOccurredAtMs) || 0) - (Number(right.callOccurredAtMs) || 0))
        .slice(-1)[0] as unknown as AgentCallSnapshot;
      await upsertLoanCaseForSnapshot(agentRef, latestSnapshot);
    }

    await refreshCaseReminderState(agentRef, caseId);
  }

  const recomputedBuckets: string[] = [];
  const bucketJobs: Array<Promise<void>> = [];

  if (bucketDay) {
    recomputedBuckets.push(`day:${bucketDay}`);
    bucketJobs.push(recomputeSalesRollup(agentRef, "day", bucketDay));
    bucketJobs.push(recomputeProgressRollup(agentRef, "day", bucketDay));
  }
  if (bucketWeek) {
    recomputedBuckets.push(`week:${bucketWeek}`);
    bucketJobs.push(recomputeSalesRollup(agentRef, "week", bucketWeek));
    bucketJobs.push(recomputeProgressRollup(agentRef, "week", bucketWeek));
  }
  if (bucketMonth) {
    recomputedBuckets.push(`month:${bucketMonth}`);
    bucketJobs.push(recomputeSalesRollup(agentRef, "month", bucketMonth));
    bucketJobs.push(recomputeProgressRollup(agentRef, "month", bucketMonth));
  }

  await Promise.all(bucketJobs);

  return {
    removedSnapshot,
    removedReminder,
    recomputedBuckets,
    ...(recomputedCaseId ? { recomputedCaseId } : {}),
  };
}

/** Documents the syncAgentActivityForCall behavior. */
export async function syncAgentActivityForCall(params: {
  callId: string;
  callData?: FirebaseFirestore.DocumentData;
  feedback?: Record<string, any> | null;
}): Promise<{ updated: boolean; agentKey?: string }> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection("calls").doc(params.callId);
  const callDoc = params.callData ? null : await callRef.get();
  const callData = (params.callData ?? callDoc?.data()) as Record<string, any> | undefined;
  if (!callData) {
    return { updated: false };
  }

  const uploadedBy = typeof callData.uploadedBy === "string" ? callData.uploadedBy : "";
  const salesAgentId = typeof callData.salesAgentId === "string" ? callData.salesAgentId : "";
  const salesAgentName = typeof callData.salesAgentName === "string" ? callData.salesAgentName : salesAgentId;
  if (!uploadedBy || !salesAgentId) {
    return { updated: false };
  }

  if (isAgentProfileCallExcluded(callData)) {
    /** Calls Firebase Firestore to remove stale agent-activity state for excluded duplicate calls. */
    await cleanupAgentActivityForExcludedCall({
      uploadedBy,
      salesAgentId,
      callId: params.callId,
    });
    return { updated: false, agentKey: buildAgentKey(uploadedBy, salesAgentId) };
  }

  if (isAutomaticShortCallReviewCall(callData)) {
    return { updated: false, agentKey: buildAgentKey(uploadedBy, salesAgentId) };
  }

  const latestFeedbackId =
    typeof callData.latestFeedbackId === "string" && callData.latestFeedbackId.length > 0
      ? callData.latestFeedbackId
      : null;
  if (!latestFeedbackId) {
    return { updated: false };
  }

  /** Calls an external SDK or API dependency. */
  const feedback =
    params.feedback ??
    (await callRef.collection("feedback").doc(latestFeedbackId).get()).data();
  if (!feedback) {
    return { updated: false };
  }

  const manualReminderInput = parseManualReminderInput(callData.manualReminderInput);
  const callOccurrence = resolveCallOccurredAtDate(callData);
  let activityExtraction: CallActivityExtraction | null = null;

  try {
    /** Calls an external SDK or API dependency. */
    const transcriptDoc = await callRef.collection("transcript").doc("data").get();
    if (transcriptDoc.exists) {
      activityExtraction = await extractCallActivity({
        callId: params.callId,
        callOccurredAt: callOccurrence.date,
        callOccurredAtSource: callOccurrence.source,
        transcriptData: transcriptDoc.data() as Record<string, any>,
        feedback,
        analyzerModel: typeof callData.analyzerModel === "string" ? callData.analyzerModel : null,
        activityPromptOverrides:
          callData.activityPromptOverrides && typeof callData.activityPromptOverrides === "object"
            ? (callData.activityPromptOverrides as Record<string, unknown>)
            : null,
      });
    }
  } catch (error) {
    console.error(`Call activity extraction failed for ${params.callId}:`, error);
  }

  const snapshot = buildSnapshot({
    callId: params.callId,
    callData,
    feedback,
    latestFeedbackId,
    activityExtraction,
    manualReminderInput,
  });

  const agentKey = buildAgentKey(uploadedBy, salesAgentId);
  /** Calls Firebase Firestore to read or write persisted application data. */
  const agentRef = db.collection(AGENT_ACTIVITY_COLLECTION).doc(agentKey);

  /** Calls an external SDK or API dependency. */
  await agentRef.set(
    {
      uploadedBy,
      salesAgentId,
      salesAgentName,
      schemaVersion: AGENT_ACTIVITY_SCHEMA_VERSION,
      timeZone: AGENT_ACTIVITY_TIMEZONE,
      ...cccAgentActivityVisibilityFields(callData),
      latestSnapshotAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  /** Calls an external SDK or API dependency. */
  await agentRef.collection("call_snapshots").doc(params.callId).set(
    {
      ...snapshot,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await upsertReminderForSnapshot(agentRef, snapshot);
  await upsertLoanCaseForSnapshot(agentRef, snapshot);

  await Promise.all([
    recomputeSalesRollup(agentRef, "day", snapshot.bucketDay),
    recomputeSalesRollup(agentRef, "week", snapshot.bucketWeek),
    recomputeSalesRollup(agentRef, "month", snapshot.bucketMonth),
    recomputeProgressRollup(agentRef, "day", snapshot.bucketDay),
    recomputeProgressRollup(agentRef, "week", snapshot.bucketWeek),
    recomputeProgressRollup(agentRef, "month", snapshot.bucketMonth),
  ]);

  return { updated: true, agentKey };
}

/** Documents the refreshCaseReminderState behavior. */
async function refreshCaseReminderState(
  agentRef: FirebaseFirestore.DocumentReference,
  caseId: string
): Promise<void> {
  /** Calls an external SDK or API dependency. */
  const [caseDoc, remindersSnapshot] = await Promise.all([
    agentRef.collection("loan_cases").doc(caseId).get(),
    agentRef.collection("reminders").where("caseId", "==", caseId).where("state", "==", "open").get(),
  ]);

  if (!caseDoc.exists) {
    return;
  }

  /** Calls an external SDK or API dependency. */
  await caseDoc.ref.set(
    {
      activeReminderIds: remindersSnapshot.docs.map(/** Handles the callback for this operation. */(doc) => doc.id),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Documents the updateAgentReminderByUser behavior. */
export async function updateAgentReminderByUser(params: {
  agentKey: string;
  reminderId: string;
  userId: string;
  state?: ReminderState;
  dueDate?: string | null;
  dueTime?: string | null;
  timeRange?: string | null;
  conditionText?: string | null;
  notes?: string | null;
  closedReason?: string | null;
}): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const reminderRef = db
    .collection(AGENT_ACTIVITY_COLLECTION)
    .doc(params.agentKey)
    .collection("reminders")
    .doc(params.reminderId);
  const reminderDoc = await reminderRef.get();
  if (!reminderDoc.exists) {
    throw new Error("Reminder not found");
  }

  const data = reminderDoc.data() ?? {};
  const manualDueDate = Object.prototype.hasOwnProperty.call(params, "dueDate")
    ? normalizeNullableString(params.dueDate)
    : normalizeNullableString(data.manualDueDate);
  const manualDueTime = Object.prototype.hasOwnProperty.call(params, "dueTime")
    ? normalizeNullableString(params.dueTime)
    : normalizeNullableString(data.manualDueTime);
  const manualTimeRange = Object.prototype.hasOwnProperty.call(params, "timeRange")
    ? normalizeNullableString(params.timeRange)
    : normalizeNullableString(data.manualTimeRange);
  const manualConditionText = Object.prototype.hasOwnProperty.call(params, "conditionText")
    ? normalizeNullableString(params.conditionText)
    : normalizeNullableString(data.manualConditionText);
  const manualNotes = Object.prototype.hasOwnProperty.call(params, "notes")
    ? normalizeNullableString(params.notes)
    : normalizeNullableString(data.manualNotes);

  const effectiveDueDate = manualDueDate ?? normalizeNullableString(data.aiDueDate);
  const effectiveDueTime = manualDueTime ?? normalizeNullableString(data.aiDueTime);
  const effectiveTimeRange = manualTimeRange ?? normalizeNullableString(data.aiTimeRange);
  const effectiveConditionText =
    manualConditionText ?? normalizeNullableString(data.aiConditionText);
  const effectiveSchedule = buildEffectiveReminderFields({
    dueDate: effectiveDueDate,
    dueTime: effectiveDueTime,
    timeRange: effectiveTimeRange,
    conditionText: effectiveConditionText,
    needsFollowUp: true,
  });

  const nextState = params.state ?? (data.state as ReminderState) ?? "open";
  /** Calls an external SDK or API dependency. */
  const update: Record<string, unknown> = {
    manualDueDate,
    manualDueTime,
    manualTimeRange,
    manualConditionText,
    manualNotes,
    effectiveDueDate,
    effectiveDueTime,
    effectiveTimeRange,
    effectiveConditionText,
    effectivePrecision: effectiveSchedule.precision,
    effectiveSortKey: effectiveSchedule.sortKey,
    dueDate: effectiveDueDate,
    dueTime: effectiveDueTime,
    timeRange: effectiveTimeRange,
    conditionText: effectiveConditionText,
    precision: effectiveSchedule.precision,
    sortKey: effectiveSchedule.sortKey,
    notes: manualNotes ?? normalizeNullableString(data.notes),
    state: nextState,
    updatedBy: params.userId,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (params.closedReason !== undefined) {
    update.closedReason = normalizeNullableString(params.closedReason);
  }
  if (nextState === "done") {
    /** Calls an external SDK or API dependency. */
    update.doneAt = FieldValue.serverTimestamp();
  }
  if (nextState === "closed") {
    /** Calls an external SDK or API dependency. */
    update.closedAt = FieldValue.serverTimestamp();
  }
  if (nextState === "open") {
    /** Calls an external SDK or API dependency. */
    update.reopenedAt = FieldValue.serverTimestamp();
  }

  await reminderRef.set(update, { merge: true });

  const caseId = normalizeNullableString(data.caseId);
  if (caseId) {
    /** Calls Firebase Firestore to read or write persisted application data. */
    await refreshCaseReminderState(
      db.collection(AGENT_ACTIVITY_COLLECTION).doc(params.agentKey),
      caseId
    );
  }
}

/** Documents the setLoanCaseStageByUser behavior. */
export async function setLoanCaseStageByUser(params: {
  agentKey: string;
  caseId: string;
  userId: string;
  stage: LoanLifecycleStage;
  note?: string | null;
}): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const agentRef = db.collection(AGENT_ACTIVITY_COLLECTION).doc(params.agentKey);
  /** Calls an external SDK or API dependency. */
  const caseRef = agentRef.collection("loan_cases").doc(params.caseId);
  const caseDoc = await caseRef.get();
  if (!caseDoc.exists) {
    throw new Error("Loan case not found");
  }

  const caseData = caseDoc.data() ?? {};
  const stage = normalizeLifecycleStage(params.stage);
  const stageSource = deriveStageSource(stage, stage);
  const overrideNote = normalizeNullableString(params.note);
  const overrideUpdatedAtIso = new Date().toISOString();

  /** Calls an external SDK or API dependency. */
  await caseRef.set(
    {
      manualStageOverride: stage,
      effectiveStage: stage,
      stageSource,
      overrideNote,
      overrideUpdatedBy: params.userId,
      overrideUpdatedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  /** Calls an external SDK or API dependency. */
  await caseRef.collection("events").add({
    eventType: "manual_stage_override",
    actorUid: params.userId,
    before: {
      manualStageOverride: caseData.manualStageOverride ?? null,
      effectiveStage: caseData.effectiveStage ?? null,
    },
    after: {
      manualStageOverride: stage,
      effectiveStage: stage,
    },
    note: overrideNote,
    createdAt: FieldValue.serverTimestamp(),
  });

  if (stage === "fully_completed" || stage === "lost_cancelled") {
    /** Calls an external SDK or API dependency. */
    const openReminders = await agentRef
      .collection("reminders")
      .where("caseId", "==", params.caseId)
      .where("state", "==", "open")
      .get();
    /** Calls Firebase Firestore to read or write persisted application data. */
    const batch = db.batch();
    for (const doc of openReminders.docs) {
      /** Calls an external SDK or API dependency. */
      batch.set(
        doc.ref,
        {
          state: "closed",
          closedReason:
            stage === "fully_completed"
              ? "closed_by_manual_completion"
              : "closed_by_manual_cancellation",
          closedAt: FieldValue.serverTimestamp(),
          updatedBy: params.userId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await batch.commit();
  }

  await refreshCaseReminderState(agentRef, params.caseId);

  const bucketKeys = [
    normalizeNullableString(caseData.latestBucketDay),
    normalizeNullableString(caseData.latestBucketWeek),
    normalizeNullableString(caseData.latestBucketMonth),
  ];
  await Promise.all([
    bucketKeys[0] ? recomputeSalesRollup(agentRef, "day", bucketKeys[0]) : Promise.resolve(),
    bucketKeys[1] ? recomputeSalesRollup(agentRef, "week", bucketKeys[1]) : Promise.resolve(),
    bucketKeys[2] ? recomputeSalesRollup(agentRef, "month", bucketKeys[2]) : Promise.resolve(),
  ]);
}
