import * as admin from "firebase-admin";
import { isTranscriptionComparisonCall } from "./callExclusions";
import { formatEmailPeriodDisplay } from "./agentEmailPeriodDisplay";
import { isDemoReportCall } from "./demoConfig";

const AGENT_ACTIVITY_COLLECTION = "agent_activity";
const CALLS_COLLECTION = "calls";
const MAX_REPORT_CALLS = 250;

export type AgentCoachingReportLength = "concise" | "detailed" | "extensive";
export type AgentCoachingReportType = "daily" | "weekly";

export interface AgentCoachingReportProfile {
  agentAnalysisId: string;
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  agentKey: string;
}

export interface AgentCoachingReportPeriodRange {
  startDate: string;
  endDate: string;
  label: string;
  timezone: string;
}

export interface AgentCoachingReportOptions {
  includeFollowUpOpportunities: boolean;
  includeTranscriptExcerpts: boolean;
  reportLength: AgentCoachingReportLength;
  selectedCallIds?: string[];
}

export interface AgentCoachingReportBuildOptions extends AgentCoachingReportOptions {
  reportType?: AgentCoachingReportType;
  previousAverageScore?: number | null;
}

export interface AgentCoachingReportCallRow {
  callId: string;
  callName: string | null;
  customerName: string | null;
  callOccurredAtIso: string | null;
  bucketDay: string | null;
  overallScore: number | null;
  summary: string | null;
  strengths: string[];
  weaknesses: string[];
  nextBestAction: string | null;
  selected: boolean;
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
  relatedRubricCriteria: string[];
}

export interface AgentFollowUpOpportunity {
  callId: string;
  customerName: string | null;
  reason: string;
  suggestedAction: string;
  evidence: string | null;
}

export interface AgentCoachingReportEvolution {
  label: string;
  previousAverageScore: number | null;
  delta: number | null;
  displayText: string;
}

export interface AgentCoachingReport {
  agent: { salesAgentId: string; salesAgentName: string };
  reportType: AgentCoachingReportType;
  dateRange: AgentCoachingReportPeriodRange;
  callsAnalyzed: number;
  averageScore: number | null;
  evolution: AgentCoachingReportEvolution;
  executiveSummary: string[];
  strengths: string[];
  coachingPriorities: AgentCoachingPriority[];
  suggestedCallFlow: Array<{ step: string; guidance: string; examplePhrase: string }>;
  objectionPlaybook: Array<{ objection: string; response: string; evidence: string | null }>;
  followUpOpportunities: AgentFollowUpOpportunity[];
  actionPlan: string[];
  selectedCalls: AgentCoachingReportCallRow[];
  generatedAt: string;
  options: AgentCoachingReportOptions;
}

interface CallEvidenceBundle {
  row: AgentCoachingReportCallRow;
  callData: FirebaseFirestore.DocumentData;
  feedback: FirebaseFirestore.DocumentData | null;
  transcriptExcerpt: string | null;
  weakCriteria: Array<{ title: string; evidence: string[]; issue: string | null; rubricRef: string | null; corrections: string[] }>;
}

/** Keeps text fields deterministic and API-safe without translating stored content. */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Converts timestamp-like values to ISO strings for report metadata. */
function timestampToIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof (value as { toDate?: unknown }).toDate === "function") return (value as { toDate: () => Date }).toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

/** Splits arrays into Firestore query-safe chunks. */
function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/** Normalizes report options from callable request data. */
export function normalizeAgentCoachingReportOptions(value: unknown): AgentCoachingReportOptions {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const reportLength: AgentCoachingReportLength = record.reportLength === "concise" || record.reportLength === "extensive" ? record.reportLength : "detailed";
  const selectedCallIds = Array.isArray(record.selectedCallIds)
    ? Array.from(new Set(record.selectedCallIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))).slice(0, MAX_REPORT_CALLS)
    : undefined;
  return {
    includeFollowUpOpportunities: record.includeFollowUpOpportunities !== false,
    includeTranscriptExcerpts: record.includeTranscriptExcerpts === true,
    reportLength,
    selectedCallIds,
  };
}

/** Normalizes the report kind used for labels and period comparison. */
function normalizeAgentCoachingReportType(value: unknown): AgentCoachingReportType {
  return value === "weekly" ? "weekly" : "daily";
}

/** Reads an explicit previous score override from scheduled/email report payloads. */
function previousAverageOverride(value: unknown): number | null | undefined {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return typeof record.previousAverageScore === "number" && Number.isFinite(record.previousAverageScore) ? record.previousAverageScore : undefined;
}

/** Formats a UTC date as an ISO date key. */
function formatUtcDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** Adds calendar days to an ISO date key without mutating state. */
function addDaysToDateKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatUtcDateKey(date);
}

/** Resolves the previous comparable range for daily or weekly evolution. */
function previousComparableRange(range: AgentCoachingReportPeriodRange, reportType: AgentCoachingReportType): AgentCoachingReportPeriodRange {
  if (reportType === "weekly") {
    const startDate = addDaysToDateKey(range.startDate, -7);
    const endDate = addDaysToDateKey(range.endDate, -7);
    return { ...range, startDate, endDate, label: `Semana anterior (${startDate} a ${endDate})` };
  }
  const start = new Date(`${range.startDate}T00:00:00.000Z`);
  const end = new Date(`${range.endDate}T00:00:00.000Z`);
  const durationDays = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
  const endDate = addDaysToDateKey(range.startDate, -1);
  const startDate = addDaysToDateKey(endDate, -durationDays);
  return { ...range, startDate, endDate, label: durationDays === 0 ? "Día anterior" : `Periodo anterior (${startDate} a ${endDate})` };
}

/** Calculates an eligible-call average score for a comparable historical range. */
async function loadComparisonAverageScore(firestore: FirebaseFirestore.Firestore, profile: AgentCoachingReportProfile, range: AgentCoachingReportPeriodRange): Promise<number | null> {
  const rows = await loadEligibleSnapshotRows(firestore, profile, range);
  const scores = rows
    .map(({ doc, callData }) => callRowFromSnapshot(doc, callData).overallScore)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  return scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
}

/** Builds the Spanish evolution summary shown in the report. */
function buildEvolution(reportType: AgentCoachingReportType, currentAverage: number | null, previousAverage: number | null, dateRange: AgentCoachingReportPeriodRange): AgentCoachingReportEvolution {
  const multiDayDaily = reportType === "daily" && dateRange.startDate !== dateRange.endDate;
  const label = reportType === "weekly" ? "Evolución vs semana anterior" : multiDayDaily ? "Evolución vs periodo anterior" : "Evolución vs ayer";
  const delta = currentAverage == null || previousAverage == null ? null : currentAverage - previousAverage;
  const displayText = delta == null ? "No disponible" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pts`;
  return { label, previousAverageScore: previousAverage, delta, displayText };
}

/** Applies the same production eligible call rules used by email reports. */
export function isCoachingReportEligibleProductionCall(data: FirebaseFirestore.DocumentData | undefined): boolean {
  return !isTranscriptionComparisonCall(data) && isDemoReportCall(data);
}

/** Extracts strings from arrays without mutating generated analysis output. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

/** Reads a shallow string from the first available field name. */
function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringOrNull(record[key]);
    if (value) return value;
  }
  return null;
}

/** Reads a numeric score from the first available field name. */
function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** Converts a snapshot and call document into the manager-selectable call row. */
function callRowFromSnapshot(doc: FirebaseFirestore.QueryDocumentSnapshot, callData: FirebaseFirestore.DocumentData): AgentCoachingReportCallRow {
  const data = doc.data() as Record<string, unknown>;
  const callRecord = callData as Record<string, unknown>;
  const callId = stringOrNull(data.sourceCallId) ?? doc.id;
  return {
    callId,
    callName: firstString(data, ["callName", "displayName", "name"]) ?? firstString(callRecord, ["displayName", "name", "filename"]),
    customerName: firstString(data, ["customerName", "clientName", "borrowerName"]),
    callOccurredAtIso: firstString(data, ["callOccurredAtIso", "startedAtIso"]) ?? timestampToIso(callRecord.callTimestamp),
    bucketDay: firstString(data, ["bucketDay"]),
    overallScore: firstNumber(data, ["overallScore", "score"]) ?? firstNumber(callRecord, ["overallScore"]),
    summary: firstString(data, ["lastCallSummary", "summary", "feedbackSummary"]),
    strengths: stringList(data.strengthTitles).concat(stringList(data.strengths)).slice(0, 4),
    weaknesses: stringList(data.weaknessTitles).concat(stringList(data.weaknesses)).slice(0, 4),
    nextBestAction: firstString(data, ["nextBestAction"]),
    selected: true,
  };
}

/** Loads production call docs for candidate snapshot source ids. */
async function loadEligibleCallDocs(firestore: FirebaseFirestore.Firestore, callIds: string[]): Promise<Map<string, FirebaseFirestore.DocumentData>> {
  const calls = new Map<string, FirebaseFirestore.DocumentData>();
  for (const ids of chunkArray(Array.from(new Set(callIds)).slice(0, MAX_REPORT_CALLS), 30)) {
    if (ids.length === 0) continue;
    /** Calls Firestore to load candidate call docs by document id for report filtering. */
    const snapshot = await firestore.collection(CALLS_COLLECTION).where(admin.firestore.FieldPath.documentId(), "in", ids).get();
    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (isCoachingReportEligibleProductionCall(data)) calls.set(doc.id, data);
    });
  }
  return calls;
}

/** Loads eligible activity snapshots for one agent and date range. */
async function loadEligibleSnapshotRows(firestore: FirebaseFirestore.Firestore, profile: AgentCoachingReportProfile, range: AgentCoachingReportPeriodRange): Promise<Array<{ doc: FirebaseFirestore.QueryDocumentSnapshot; callData: FirebaseFirestore.DocumentData }>> {
  // Shared agents collect uploads from both approved accounts; activity remains owner-partitioned.
  const activity = firestore.collection(AGENT_ACTIVITY_COLLECTION);
  const roots = await activity.where('salesAgentId', '==', profile.salesAgentId).get();
  const rootIds = Array.from(new Set([profile.agentKey, ...roots.docs.map((doc) => doc.id)]));
  const snapshots = await Promise.all(rootIds.map((id) => activity.doc(id).collection('call_snapshots')
    .where('bucketDay', '>=', range.startDate).where('bucketDay', '<=', range.endDate).limit(MAX_REPORT_CALLS).get()));
  const documents = snapshots.flatMap((snapshot) => snapshot.docs);
  const candidateIds = documents.map((doc) => stringOrNull(doc.data().sourceCallId) ?? doc.id);
  const eligibleCalls = await loadEligibleCallDocs(firestore, candidateIds);
  const rows: Array<{ doc: FirebaseFirestore.QueryDocumentSnapshot; callData: FirebaseFirestore.DocumentData }> = [];
  const seen = new Set<string>();
  for (const doc of documents) {
    const callId = stringOrNull(doc.data().sourceCallId) ?? doc.id;
    const callData = eligibleCalls.get(callId);
    const snapshotData = doc.data();
    if (!callData || seen.has(callId) || callData.salesAgentId !== profile.salesAgentId ||
        snapshotData.uploadedBy !== callData.uploadedBy || snapshotData.salesAgentId !== callData.salesAgentId ||
        snapshotData.latestFeedbackId !== callData.latestFeedbackId) continue;
    // A feedback pointer alone is not a final analysis; reject missing/deleted feedback documents.
    if (!(await loadFeedback(firestore, callId, callData))) continue;
    seen.add(callId);
    rows.push({ doc, callData });
  }
  return rows;
}

/** Lists eligible calls that can be selected in the report-builder UI. */
export async function listAgentCoachingReportCalls(firestore: FirebaseFirestore.Firestore, profile: AgentCoachingReportProfile, range: AgentCoachingReportPeriodRange): Promise<AgentCoachingReportCallRow[]> {
  const rows = await loadEligibleSnapshotRows(firestore, profile, range);
  return rows.map(({ doc, callData }) => callRowFromSnapshot(doc, callData)).sort((a, b) => (a.callOccurredAtIso ?? "").localeCompare(b.callOccurredAtIso ?? ""));
}

/** Loads the latest feedback document for one eligible call. */
async function loadFeedback(firestore: FirebaseFirestore.Firestore, callId: string, callData: FirebaseFirestore.DocumentData): Promise<FirebaseFirestore.DocumentData | null> {
  const feedbackId = stringOrNull(callData.latestFeedbackId);
  if (!feedbackId) return null;
  /** Calls Firestore to load the feedback document used for report evidence. */
  const doc = await firestore.collection(CALLS_COLLECTION).doc(callId).collection("feedback").doc(feedbackId).get();
  return doc.exists ? doc.data() ?? null : null;
}

/** Builds a compact transcript excerpt only when the manager enables transcript details. */
async function loadTranscriptExcerpt(firestore: FirebaseFirestore.Firestore, callId: string, enabled: boolean): Promise<string | null> {
  if (!enabled) return null;
  /** Calls Firestore to load a bounded transcript snippet for report evidence. */
  const doc = await firestore.collection(CALLS_COLLECTION).doc(callId).collection("transcript").doc("data").get();
  if (!doc.exists) return null;
  const data = doc.data() ?? {};
  const text = firstString(data, ["text", "transcript", "fullText"]);
  if (text) return text.replace(/\s+/g, " ").slice(0, 420);
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const compact = segments.slice(0, 8).map((segment) => {
    const record = segment && typeof segment === "object" ? segment as Record<string, unknown> : {};
    const speaker = stringOrNull(record.speaker) ?? stringOrNull(record.role) ?? "Parte";
    const segmentText = stringOrNull(record.text) ?? stringOrNull(record.content);
    return segmentText ? `${speaker}: ${segmentText}` : null;
  }).filter((value): value is string => Boolean(value)).join(" ");
  return compact ? compact.replace(/\s+/g, " ").slice(0, 420) : null;
}

/** Unwraps feedback objects that store analysis under a nested output field. */
function normalizedFeedback(feedback: FirebaseFirestore.DocumentData | null): Record<string, unknown> {
  const record = feedback && typeof feedback === "object" ? feedback as Record<string, unknown> : {};
  return record.output && typeof record.output === "object" ? record.output as Record<string, unknown> : record;
}

/** Extracts weak rubric criteria as natural titles plus internal trace refs. */
function weakCriteriaFromFeedback(feedback: FirebaseFirestore.DocumentData | null): CallEvidenceBundle["weakCriteria"] {
  const root = normalizedFeedback(feedback);
  const scorecard = (root.rubric_scorecard_v2 && typeof root.rubric_scorecard_v2 === "object" ? root.rubric_scorecard_v2 : root.rubric_scorecard) as Record<string, unknown> | undefined;
  const sections = Array.isArray(scorecard?.sections) ? scorecard.sections : [];
  const out: CallEvidenceBundle["weakCriteria"] = [];
  sections.forEach((section) => {
    const sectionRecord = section && typeof section === "object" ? section as Record<string, unknown> : {};
    const groups = Array.isArray(sectionRecord.groups) ? sectionRecord.groups : [];
    groups.forEach((group) => {
      const groupRecord = group && typeof group === "object" ? group as Record<string, unknown> : {};
      const criteria = Array.isArray(groupRecord.criteria) ? groupRecord.criteria : [];
      criteria.forEach((criterion) => {
        const record = criterion && typeof criterion === "object" ? criterion as Record<string, unknown> : {};
        const title = firstString(record, ["title", "name", "criterionTitle"]);
        if (!title) return;
        const earned = firstNumber(record, ["earned_points", "earned", "earnedPoints", "score"]);
        const max = firstNumber(record, ["max_points", "max", "maxPoints", "possible"]);
        const status = firstString(record, ["status", "result"]);
        if (status && /^(no aplica|not applicable|n\/a)$/i.test(status.trim())) return;
        const issue = firstString(record, ["improvementTip", "justification", "detail", "reason"]);
        const scoreLow = typeof earned === "number" && typeof max === "number" && max > 0 && earned / max < 0.7;
        const statusLow = status ? !/^(cumple|aprobado|ok|satisfactorio)$/i.test(status.trim()) : false;
        if (!scoreLow && !statusLow) return;
        const evidence = stringList(record.evidence).concat(stringList(record.examples)).slice(0, 2);
        const critiques = Array.isArray(record.bad_critiques) ? record.bad_critiques : [];
        const corrections = [firstString(record, ["criterion_improvement_tip", "improvementTip"]),
          ...critiques.map((critique) => critique && typeof critique === "object"
            ? firstString(critique, ["weakness_improvement_tip", "improvement_tip"]) : null),
        ].filter((value): value is string => Boolean(value));
        out.push({ title, evidence, issue, rubricRef: firstString(record, ["id", "criterionId"]), corrections });
      });
    });
  });
  return out.slice(0, 24);
}

/** Loads all detailed report evidence for selected call rows. */
async function loadCallEvidenceBundles(firestore: FirebaseFirestore.Firestore, rows: Array<{ doc: FirebaseFirestore.QueryDocumentSnapshot; callData: FirebaseFirestore.DocumentData }>, options: AgentCoachingReportOptions): Promise<CallEvidenceBundle[]> {
  return Promise.all(rows.map(async ({ doc, callData }) => {
    const row = callRowFromSnapshot(doc, callData);
    const feedback = await loadFeedback(firestore, row.callId, callData);
    const transcriptExcerpt = await loadTranscriptExcerpt(firestore, row.callId, options.includeTranscriptExcerpts);
    return { row, callData, feedback, transcriptExcerpt, weakCriteria: weakCriteriaFromFeedback(feedback) };
  }));
}

/** Counts repeated strings while preserving readable labels. */
function topCounts(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  values.forEach((value) => {
    const clean = value.trim();
    if (clean) counts.set(clean, (counts.get(clean) ?? 0) + 1);
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([label, count]) => `${label}${count > 1 ? ` (${count} llamadas)` : ""}`);
}

/** Normalizes matching only; stored instructions remain unchanged in the report. */
function matchingText(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Accepts explicit next actions, never inferred interest from summaries or weaknesses. */
function hasFollowUpSignal(bundle: CallEvidenceBundle): boolean {
  const text = matchingText(bundle.row.nextBestAction ?? "");
  if (!text) return false;
  // Negative or conflicting instructions take precedence over positive keywords.
  const excluded = [
    /\b(?:no|sin|nunca|evitar)\b[^.;]*\b(?:contact\w*|llam\w*|seguimiento|retomar|insist\w*|envi\w*|compart\w*)\b/,
    /\b(?:rechaz\w*|declin\w*|cancel\w*)\b[^.;]*\b(?:contact\w*|llam\w*|seguimiento|cita)\b/,
    /\b(?:contacto|llamada|seguimiento|cita)\b[^.;]*\b(?:rechazad[oa]|declinad[oa]|cancelad[oa])\b/,
    /\b(?:cerrar|archivar|cierre de|cierre del|cerrado|cerrada)\b[^.;]*\b(?:caso|gestion|expediente)\b/,
    /\b(?:caso|gestion|expediente)\s+(?:cerrad[oa]|archivad[oa])\b/,
    /\bno\s+(?:esta\s+)?interesad[oa]\b/,
  ];
  const ambiguous = /[?¿]|\b(?:quizas|tal vez|posiblemente|podria|evaluar si|valorar si|considerar|por definir|sin confirmar|cuando corresponda|cuando sea posible|segun corresponda|si aplica|si procede|si es necesario|de ser necesario)\b|^(?:retomar|contactar|llamar|dar seguimiento)[.!\s]*$/;
  if (excluded.some((pattern) => pattern.test(text)) || ambiguous.test(text)) return false;
  // Accept a leading or coordinated imperative, preserving any prerequisite verbatim.
  const action = /(?:^|[.;:,]\s*|\by\s+)(?:(?:solo|solamente|unicamente)\s+)?(?:volver a (?:llamar|contactar)|llamar|contactar|retomar|dar seguimiento|agendar (?:una |el |un )?(?:llamada|cita|seguimiento)|confirmar (?:la |una )?cita|enviar (?:la |el |los |las )?(?:informacion|documentacion|documentos|propuesta))\b/;
  return action.test(text);
}

/** Builds a conservative Spanish summary from stored call evidence. */
function executiveSummary(profile: AgentCoachingReportProfile, bundles: CallEvidenceBundle[], averageScore: number | null, followUps: AgentFollowUpOpportunity[]): string[] {
  const scoreText = averageScore == null ? "no disponible" : `${averageScore.toFixed(1)}/100`;
  return [
    `${profile.salesAgentName} tuvo ${bundles.length} llamadas elegibles analizadas en el periodo seleccionado, con promedio ${scoreText}.`,
    followUps.length > 0 ? `Se detectaron ${followUps.length} oportunidades con una acción explícita; se deben respetar sus condiciones previas.` : "No se incluyen oportunidades con una acción de seguimiento suficientemente explícita en este periodo.",
    "El enfoque recomendado es revisar la evidencia de cada prioridad y respetar las decisiones y condiciones registradas del cliente.",
  ];
}

/** Reuses only legacy corrections tied to the same criterion or exact title. */
function matchedWeaknessCorrections(bundle: CallEvidenceBundle, title: string, rubricRef: string | null): string[] {
  const root = normalizedFeedback(bundle.feedback);
  const weaknesses = Array.isArray(root.agent_weaknesses) ? root.agent_weaknesses : [];
  return weaknesses.flatMap((weakness) => {
    if (!weakness || typeof weakness !== "object") return [];
    const ref = firstString(weakness, ["criterionId", "criterion_id"]);
    const weaknessTitle = firstString(weakness, ["title"]);
    const matches = ref && rubricRef ? ref === rubricRef : weaknessTitle && matchingText(weaknessTitle) === matchingText(title);
    const tip = matches ? firstString(weakness, ["weakness_improvement_tip", "improvement_tip", "improvementTip"]) : null;
    return tip ? [tip] : [];
  });
}

/** Converts repeated evidence into coaching priorities without exposing rubric ids to the agent. */
function coachingPriorities(bundles: CallEvidenceBundle[], length: AgentCoachingReportLength): AgentCoachingPriority[] {
  const limit = length === "concise" ? 2 : length === "extensive" ? 5 : 3;
  const candidates: Array<{ title: string; evidence: string | null; rubricRef: string | null; corrections: string[] }> = [];
  bundles.forEach((bundle) => {
    if (bundle.weakCriteria.length > 0) {
      bundle.weakCriteria.forEach((criterion) => {
        candidates.push({ title: criterion.title, evidence: criterion.evidence[0] ?? bundle.row.summary ?? criterion.issue, rubricRef: criterion.rubricRef,
          corrections: criterion.corrections.concat(matchedWeaknessCorrections(bundle, criterion.title, criterion.rubricRef)) });
      });
      return;
    }
    bundle.row.weaknesses.forEach((title) => {
      candidates.push({ title, evidence: bundle.row.summary, rubricRef: null, corrections: matchedWeaknessCorrections(bundle, title, null) });
    });
  });
  const grouped = new Map<string, { title: string; evidence: string[]; refs: string[]; corrections: string[] }>();
  candidates.forEach((candidate) => {
    const key = matchingText(candidate.title);
    const current = grouped.get(key) ?? { title: candidate.title, evidence: [], refs: [], corrections: [] };
    if (candidate.evidence) current.evidence.push(candidate.evidence);
    if (candidate.rubricRef) current.refs.push(candidate.rubricRef);
    current.corrections.push(...candidate.corrections);
    grouped.set(key, current);
  });
  const rows = Array.from(grouped.values()).sort((a, b) => b.evidence.length - a.evidence.length).slice(0, limit);
  if (rows.length === 0) rows.push({ title: "Revisar la evidencia disponible", evidence: [], refs: [], corrections: [] });
  return rows.map((row) => ({
    title: row.title,
    evidence: row.evidence.slice(0, 3),
    impact: `Revisar el comportamiento observado en «${row.title}» según la evidencia y el criterio aplicable.`,
    correctionSteps: row.corrections.length > 0 ? Array.from(new Set(row.corrections)).slice(0, 3)
      : [`Revisar la evidencia de «${row.title}» con el supervisor y acordar una corrección específica antes de aplicarla.`],
    examplePhrases: [],
    phrasesToAvoid: [],
    practiceExercise: `Revisar un ejemplo de «${row.title}» y contrastarlo con el criterio aplicable.`,
    nextCallGoal: `Verificar la corrección acordada para «${row.title}» cuando el criterio sea aplicable.`,
    relatedRubricCriteria: Array.from(new Set(row.refs)).slice(0, 5),
  }));
}

/** Builds a compliant suggested call flow in Spanish. */
function suggestedCallFlow(): AgentCoachingReport["suggestedCallFlow"] {
  return [
    { step: "1. Apertura", guidance: "Identificar al cliente, confirmar disponibilidad y explicar el motivo de la llamada en lenguaje simple.", examplePhrase: "Le llamo para revisar una opción que podría ayudarle con su crédito; ¿tiene dos minutos?" },
    { step: "2. Diagnóstico", guidance: "Hacer una pregunta corta para entender necesidad, objeción o momento de compra antes de presentar detalles.", examplePhrase: "¿Qué sería más importante para usted: bajar presión mensual, resolver rápido o comparar condiciones?" },
    { step: "3. Presentación", guidance: "Conectar solo uno o dos beneficios con lo que el cliente dijo; evitar recitar todo el producto.", examplePhrase: "Por lo que me comenta, lo más relevante sería revisar una alternativa que le dé claridad en pagos y tiempos." },
    { step: "4. Objeción", guidance: "Validar la duda, responder con precisión y volver a una pregunta de avance.", examplePhrase: "Tiene sentido revisarlo. Para orientarlo mejor, ¿la duda principal es el monto, la fecha o los requisitos?" },
    { step: "5. Cierre", guidance: "Confirmar autorización y siguiente paso; registrar solo las condiciones acordadas y respetar la decisión de no continuar.", examplePhrase: "Si autoriza un siguiente paso, confirmemos la acción y las condiciones acordadas; si prefiere no continuar, lo respetamos." },
  ];
}

/** Builds an objection playbook from summaries and common Consubanco call patterns. */
function objectionPlaybook(bundles: CallEvidenceBundle[]): AgentCoachingReport["objectionPlaybook"] {
  const costo = bundles.find((bundle) => /caro|tasa|inter[eé]s|monto|pago|mensual/i.test([bundle.row.summary, bundle.transcriptExcerpt].join(" ")));
  const tiempo = bundles.find((bundle) => /despu[eé]s|luego|pensar|tiempo|ocupad/i.test([bundle.row.summary, bundle.transcriptExcerpt].join(" ")));
  return [
    { objection: "Quiero pensarlo / ahora no tengo tiempo", response: "Validar y convertirlo en seguimiento concreto: confirmar cuándo retomarlo y qué información necesita revisar antes de decidir.", evidence: tiempo?.row.summary ?? null },
    { objection: "Me preocupa el pago, tasa o monto", response: "No prometer condiciones. Aclarar que se revisa la opción disponible y preguntar qué variable necesita comparar para avanzar.", evidence: costo?.row.summary ?? null },
  ];
}

/** Builds follow-up opportunities only from calls with clear follow-up signals. */
function followUpOpportunities(bundles: CallEvidenceBundle[], enabled: boolean): AgentFollowUpOpportunity[] {
  if (!enabled) return [];
  return bundles.filter(hasFollowUpSignal).slice(0, 12).map((bundle) => ({
    callId: bundle.row.callId,
    customerName: bundle.row.customerName,
    reason: bundle.row.nextBestAction!,
    suggestedAction: bundle.row.nextBestAction!,
    evidence: bundle.row.summary,
  }));
}

/** Builds the immediate action plan shown at the end of the report. */
function actionPlan(priorities: AgentCoachingPriority[], followUps: AgentFollowUpOpportunity[]): string[] {
  const firstPriority = priorities[0]?.title ?? "confirmar el siguiente paso";
  const items = [`Meta 1: En las próximas llamadas, enfocarse en ${firstPriority.toLowerCase()}.`, "Meta 2: Registrar una razón clara cuando el cliente no avance, para evitar cierres ambiguos.", "Meta 3: Usar una pregunta de diagnóstico antes de explicar beneficios o condiciones."];
  followUps.forEach((followUp) => items.push(`Seguimiento (${followUp.customerName ?? "Cliente"}): ${followUp.suggestedAction}`));
  return items;
}

/** Builds one transient Spanish-only coaching report from eligible selected calls. */
export async function buildAgentCoachingReport(firestore: FirebaseFirestore.Firestore, profile: AgentCoachingReportProfile, range: AgentCoachingReportPeriodRange, rawOptions: unknown = {}): Promise<AgentCoachingReport | null> {
  const options = normalizeAgentCoachingReportOptions(rawOptions);
  const reportType = normalizeAgentCoachingReportType((rawOptions && typeof rawOptions === "object" ? rawOptions as Record<string, unknown> : {}).reportType);
  const rows = await loadEligibleSnapshotRows(firestore, profile, range);
  const selectedSet = new Set(options.selectedCallIds ?? []);
  const scopedRows = selectedSet.size > 0 ? rows.filter(({ doc }) => selectedSet.has(stringOrNull(doc.data().sourceCallId) ?? doc.id)) : rows;
  if (scopedRows.length === 0) return null;
  const bundles = await loadCallEvidenceBundles(firestore, scopedRows, options);
  const selectedCalls = bundles.map((bundle) => ({ ...bundle.row, selected: true }));
  const scores = selectedCalls.map((row) => row.overallScore).filter((score): score is number => typeof score === "number");
  const averageScore = scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
  const previousAverage = previousAverageOverride(rawOptions) ?? await loadComparisonAverageScore(firestore, profile, previousComparableRange(range, reportType));
  const priorities = coachingPriorities(bundles, options.reportLength);
  const followUps = followUpOpportunities(bundles, options.includeFollowUpOpportunities);
  return {
    agent: { salesAgentId: profile.salesAgentId, salesAgentName: profile.salesAgentName },
    reportType,
    dateRange: range,
    callsAnalyzed: bundles.length,
    averageScore,
    evolution: buildEvolution(reportType, averageScore, previousAverage, range),
    executiveSummary: executiveSummary(profile, bundles, averageScore, followUps),
    strengths: topCounts(bundles.flatMap((bundle) => bundle.row.strengths), options.reportLength === "concise" ? 3 : 5),
    coachingPriorities: priorities,
    suggestedCallFlow: suggestedCallFlow(),
    objectionPlaybook: objectionPlaybook(bundles),
    followUpOpportunities: followUps,
    actionPlan: actionPlan(priorities, followUps),
    selectedCalls,
    generatedAt: new Date().toISOString(),
    options: { ...options, selectedCallIds: selectedCalls.map((row) => row.callId) },
  };
}

/** Builds Spanish report lines that are safe for preview and PDF rendering. */
export function agentCoachingReportLines(report: AgentCoachingReport): string[] {
  const label = report.reportType === "weekly" ? "semanal" : "diario";
  const lines = ["Reporte de coaching para agente", `Tipo: ${label}`, `Agente: ${report.agent.salesAgentName}`, `Periodo: ${report.dateRange.label}`, `Llamadas analizadas: ${report.callsAnalyzed}`, `Promedio: ${report.averageScore == null ? "No disponible" : `${report.averageScore.toFixed(1)}/100`}`, `${report.evolution.label}: ${report.evolution.displayText}`, "", "Resumen ejecutivo", ...report.executiveSummary.map((line) => `- ${line}`), "", "Fortalezas para seguir usando", ...(report.strengths.length > 0 ? report.strengths.map((line) => `- ${line}`) : ["- No hay suficientes fortalezas repetidas en el periodo seleccionado."]), "", "Prioridades personalizadas de coaching"];
  report.coachingPriorities.forEach((priority, index) => {
    lines.push(`${index + 1}. ${priority.title}`, `Impacto: ${priority.impact}`);
    if (priority.evidence.length > 0) lines.push(`Evidencia: ${priority.evidence.slice(0, 2).join(" | ")}`);
    lines.push("Pasos de corrección:", ...priority.correctionSteps.map((step) => `- ${step}`), "Frases sugeridas:", ...priority.examplePhrases.map((phrase) => `- ${phrase}`), "Evitar:", ...priority.phrasesToAvoid.map((phrase) => `- ${phrase}`), `Ejercicio: ${priority.practiceExercise}`, `Meta de siguiente llamada: ${priority.nextCallGoal}`, "");
  });
  lines.push("Flujo sugerido de llamada");
  report.suggestedCallFlow.forEach((step) => lines.push(`${step.step}: ${step.guidance}`, `Frase ejemplo: ${step.examplePhrase}`));
  lines.push("", "Manejo de objeciones");
  report.objectionPlaybook.forEach((item) => {
    lines.push(`- ${item.objection}: ${item.response}`);
    if (item.evidence) lines.push(`  Evidencia: ${item.evidence}`);
  });
  lines.push("", "Oportunidades para retomar");
  if (report.options.includeFollowUpOpportunities && report.followUpOpportunities.length > 0) {
    report.followUpOpportunities.forEach((item) => {
      lines.push(`- ${item.customerName ?? "Cliente"}: ${item.suggestedAction}`);
      if (item.evidence) lines.push(`  Evidencia: ${item.evidence}`);
    });
  } else {
    lines.push("- No se detectaron suficientes oportunidades de alta probabilidad en el periodo seleccionado.");
  }
  lines.push("", "Plan de acción", ...report.actionPlan.map((item) => `- ${item}`), "", "Llamadas incluidas");
  report.selectedCalls.slice(0, report.options.reportLength === "extensive" ? 30 : 15).forEach((call) => {
    lines.push(`- ${call.customerName ?? "Cliente"} / ${call.callName ?? call.callId} / ${call.overallScore == null ? "score no disponible" : `${call.overallScore.toFixed(1)}/100`}`);
    if (call.summary) lines.push(`  Resumen: ${call.summary}`);
  });
  return lines;
}

const PDF_LAYOUT = {
  pageWidth: 792,
  pageHeight: 612,
  margin: 32,
  headerHeight: 58,
  footerTop: 556,
  contentTop: 84,
  contentBottom: 540,
};

const PDF_COLORS = {
  navy: "#0B2A5B",
  navyDark: "#061C3D",
  blue: "#2468B2",
  red: "#C93434",
  green: "#218A57",
  gold: "#F2B632",
  grayText: "#4B5563",
  border: "#D6DEE8",
  panel: "#F7FAFD",
  white: "#FFFFFF",
};

/** Cleans text before PDF rendering without translating stored analysis content. */
function pdfText(value: string | null | undefined): string {
  return (value ?? "").replace(/[•–—]/g, "-").replace(/\s+/g, " ").trim();
}

/** Formats a score for the Consubanco-style KPI widgets. */
function scoreLabel(score: number | null): string {
  return typeof score === "number" && Number.isFinite(score) ? `${score.toFixed(1)}/100` : "No disponible";
}

/** Returns the score band label required by Consubanco. */
function scoreBandLabel(score: number | null): string {
  if (score == null) return "Sin puntaje";
  if (score < 60) return "En riesgo";
  if (score < 80) return "Necesita mejorar";
  return "En objetivo";
}

/** Restricts a number to a visual drawing range. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Converts report type into Spanish visible copy. */
function reportTypeLabel(reportType: AgentCoachingReportType): string {
  return reportType === "weekly" ? "Reporte semanal de coaching" : "Reporte diario de coaching";
}

/** Adds a Consubanco-style page shell and returns the first content y-position. */
function addReportPage(doc: PDFKit.PDFDocument, report: AgentCoachingReport, title: string): number {
  doc.addPage({ size: "LETTER", layout: "landscape", margin: PDF_LAYOUT.margin });
  doc.rect(0, 0, PDF_LAYOUT.pageWidth, PDF_LAYOUT.pageHeight).fill(PDF_COLORS.white);
  doc.rect(0, 0, PDF_LAYOUT.pageWidth, PDF_LAYOUT.headerHeight).fill(PDF_COLORS.navyDark);
  doc.font("Helvetica-Bold").fontSize(18).fillColor(PDF_COLORS.white).text("Consubanco", PDF_LAYOUT.margin, 18, { width: 180 });
  doc.font("Helvetica").fontSize(8).fillColor("#D8E4F2").text("KESP coaching operativo", PDF_LAYOUT.margin, 38, { width: 190 });
  doc.font("Helvetica-Bold").fontSize(14).fillColor(PDF_COLORS.white).text(title, 250, 18, { width: 270, align: "center" });
  doc.font("Helvetica").fontSize(9).fillColor("#D8E4F2").text(`${pdfText(report.agent.salesAgentName)} - ${pdfText(report.dateRange.label)}`, 540, 18, { width: 220, align: "right" });
  return PDF_LAYOUT.contentTop;
}

/** Adds page numbers after the PDF pages have been buffered. */
function addBufferedFooters(doc: PDFKit.PDFDocument, report: AgentCoachingReport): void {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    doc.moveTo(PDF_LAYOUT.margin, PDF_LAYOUT.footerTop).lineTo(PDF_LAYOUT.pageWidth - PDF_LAYOUT.margin, PDF_LAYOUT.footerTop).strokeColor(PDF_COLORS.border).lineWidth(0.5).stroke();
    doc.font("Helvetica").fontSize(8).fillColor(PDF_COLORS.grayText).text(`Página ${index + 1} de ${range.count}`, 360, 566, { width: 80, align: "center", lineBreak: false });
    doc.text(`${pdfText(report.agent.salesAgentName)} - ${pdfText(report.dateRange.label)}`, PDF_LAYOUT.margin, 566, { width: 360, lineBreak: false });
  }
}

/** Ensures the next block has room and creates a continuation page when needed. */
function ensureSpace(doc: PDFKit.PDFDocument, report: AgentCoachingReport, y: number, neededHeight: number, title: string): number {
  return y + neededHeight > PDF_LAYOUT.contentBottom ? addReportPage(doc, report, title) : y;
}

/** Draws one section title and returns the next y-position. */
function drawSectionTitle(doc: PDFKit.PDFDocument, title: string, y: number): number {
  doc.font("Helvetica-Bold").fontSize(12).fillColor(PDF_COLORS.navy).text(title, PDF_LAYOUT.margin, y);
  doc.moveTo(PDF_LAYOUT.margin, y + 17).lineTo(PDF_LAYOUT.pageWidth - PDF_LAYOUT.margin, y + 17).strokeColor(PDF_COLORS.border).lineWidth(0.8).stroke();
  return y + 25;
}

/** Draws a rounded panel behind a content area. */
function drawPanel(doc: PDFKit.PDFDocument, x: number, y: number, width: number, height: number, fill = PDF_COLORS.panel): void {
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(fill, PDF_COLORS.border);
}

/** Measures text height with the requested font style. */
function measureText(doc: PDFKit.PDFDocument, value: string, width: number, fontSize: number, bold = false): number {
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
  return doc.heightOfString(pdfText(value), { width, lineGap: 2 });
}

/** Draws wrapped text and returns its height. */
function drawWrappedText(doc: PDFKit.PDFDocument, value: string, x: number, y: number, width: number, fontSize: number, color = PDF_COLORS.grayText, bold = false): number {
  const clean = pdfText(value);
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize).fillColor(color).text(clean || "No disponible", x, y, { width, lineGap: 2 });
  return doc.heightOfString(clean || "No disponible", { width, lineGap: 2 });
}

/** Draws the top KPI strip with agent, period, score, target, and evolution. */
function drawKpiStrip(doc: PDFKit.PDFDocument, report: AgentCoachingReport, y: number): number {
  const items = [
    { label: "Agente", value: report.agent.salesAgentName },
    { label: "Periodo", value: report.dateRange.label },
    { label: "Llamadas evaluadas", value: String(report.callsAnalyzed) },
    { label: "Puntaje", value: scoreLabel(report.averageScore) },
    { label: "Meta", value: "80/100" },
    { label: report.evolution.label, value: report.evolution.displayText },
  ];
  const width = (PDF_LAYOUT.pageWidth - PDF_LAYOUT.margin * 2) / items.length;
  doc.roundedRect(PDF_LAYOUT.margin, y, PDF_LAYOUT.pageWidth - PDF_LAYOUT.margin * 2, 66, 8).fill(PDF_COLORS.navy);
  items.forEach(/** Draws one KPI cell. */(item, index) => {
    const x = PDF_LAYOUT.margin + index * width;
    if (index > 0) doc.moveTo(x, y + 12).lineTo(x, y + 54).strokeColor("#52739E").lineWidth(0.6).stroke();
    doc.font("Helvetica").fontSize(7).fillColor("#CAD8E8").text(pdfText(item.label), x + 10, y + 14, { width: width - 20 });
    let valueFontSize = index === 0 || index === 1 ? 10 : 14;
    doc.font("Helvetica-Bold").fontSize(valueFontSize);
    if (index === 0) {
      const valueWidth = doc.widthOfString(pdfText(item.value));
      if (valueWidth > width - 20) valueFontSize = Math.max(8, valueFontSize * (width - 20) / valueWidth);
    }
    doc.fontSize(valueFontSize).fillColor(PDF_COLORS.white).text(pdfText(item.value), x + 10, y + 31, { width: width - 20 });
  });
  return y + 82;
}

/** Draws the score gauge and requested score bands. */
function drawScoreGauge(doc: PDFKit.PDFDocument, report: AgentCoachingReport, x: number, y: number, width: number): void {
  drawPanel(doc, x, y, width, 115, PDF_COLORS.white);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(PDF_COLORS.navy).text("Nivel de desempeño", x + 14, y + 14, { width: width - 28 });
  doc.font("Helvetica-Bold").fontSize(26).fillColor(PDF_COLORS.navyDark).text(scoreLabel(report.averageScore), x + 14, y + 34, { width: 135 });
  doc.font("Helvetica").fontSize(9).fillColor(PDF_COLORS.grayText).text(scoreBandLabel(report.averageScore), x + 14, y + 68, { width: 135 });
  const barX = x + 160;
  const barY = y + 38;
  const barWidth = width - 184;
  const segments = [
    { label: "0-59 En riesgo", color: PDF_COLORS.red, start: 0, end: 59 },
    { label: "60-79 Necesita mejorar", color: PDF_COLORS.gold, start: 60, end: 79 },
    { label: "80-100 En objetivo", color: PDF_COLORS.green, start: 80, end: 100 },
  ];
  segments.forEach(/** Draws one score-band segment. */(segment) => {
    const start = barX + (segment.start / 100) * barWidth;
    const segmentWidth = ((segment.end - segment.start + 1) / 100) * barWidth;
    doc.rect(start, barY, segmentWidth, 18).fill(segment.color);
    doc.font("Helvetica").fontSize(7).fillColor(PDF_COLORS.grayText).text(segment.label, start, barY + 26, { width: segmentWidth, align: "center" });
  });
  const score = report.averageScore == null ? 0 : clamp(report.averageScore, 0, 100);
  const markerX = barX + (score / 100) * barWidth;
  doc.circle(markerX, barY + 9, 5).fill(PDF_COLORS.navyDark);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(PDF_COLORS.navyDark).text("Meta 80", barX + barWidth * 0.8 - 18, barY - 16, { width: 60, align: "center" });
  doc.moveTo(barX + barWidth * 0.8, barY - 1).lineTo(barX + barWidth * 0.8, barY + 22).strokeColor(PDF_COLORS.navyDark).lineWidth(1).stroke();
}

/** Draws the strengths panel for the first page. */
function drawStrengthsPanel(doc: PDFKit.PDFDocument, report: AgentCoachingReport, x: number, y: number, width: number): void {
  drawPanel(doc, x, y, width, 115, "#F2FAF5");
  doc.font("Helvetica-Bold").fontSize(12).fillColor(PDF_COLORS.green).text("Fortalezas observadas", x + 14, y + 14, { width: width - 28 });
  const strengths = report.strengths.length > 0 ? report.strengths.slice(0, 4) : ["No hay suficientes fortalezas repetidas en el periodo."];
  strengths.forEach(/** Draws one strength row. */(strength, index) => {
    const rowY = y + 38 + index * 17;
    doc.circle(x + 19, rowY + 4, 3).fill(PDF_COLORS.green);
    drawWrappedText(doc, strength, x + 29, rowY, width - 42, 8, PDF_COLORS.grayText);
  });
}

/** Builds a compact text value for a priority field. */
function priorityFieldText(values: string[], fallback: string): string {
  return values.length > 0 ? values.slice(0, 2).map(pdfText).join(" / ") : fallback;
}

/** Draws a labeled priority field inside an opportunity card. */
function drawPriorityField(doc: PDFKit.PDFDocument, label: string, value: string, x: number, y: number, width: number): number {
  doc.font("Helvetica-Bold").fontSize(7).fillColor(PDF_COLORS.navy).text(label, x, y, { width });
  return 10 + drawWrappedText(doc, value, x, y + 10, width, 7, PDF_COLORS.grayText);
}

/** Measures the height needed for one opportunity priority card. */
function priorityCardLayout(doc: PDFKit.PDFDocument, priority: AgentCoachingPriority, width: number): { values: string[]; rowHeights: number[]; height: number } {
  const fieldWidth = (width - 54) / 4;
  const values = [
    priority.impact,
    priorityFieldText(priority.evidence, "Sin evidencia textual suficiente."),
    priorityFieldText(priority.correctionSteps, "Practicar corrección guiada."),
    priorityFieldText(priority.examplePhrases, "Sin frase específica registrada; revisar con el supervisor."),
    priorityFieldText(priority.phrasesToAvoid, "Revisar las expresiones según la evidencia del criterio."),
    priority.practiceExercise,
    priority.nextCallGoal,
    priority.title,
  ];
  const rowHeights = [0, 1].map(/** Measures one row of four priority fields. */(rowIndex) => Math.max(...values.slice(rowIndex * 4, rowIndex * 4 + 4).map((value) => measureText(doc, value, fieldWidth, 7) + 16)));
  return { values, rowHeights, height: 42 + rowHeights.reduce((sum, height) => sum + height, 0) };
}

/** Draws the top two or three coaching priorities as dense opportunity rows. */
function drawOpportunityTable(doc: PDFKit.PDFDocument, report: AgentCoachingReport, y: number): number {
  const priorities = report.coachingPriorities.slice(0, 3);
  const width = PDF_LAYOUT.pageWidth - PDF_LAYOUT.margin * 2;
  const firstCardHeight = priorities[0] ? priorityCardLayout(doc, priorities[0], width).height : 0;
  let currentY = ensureSpace(doc, report, y, firstCardHeight + 40, "Principales áreas de oportunidad");
  currentY = drawSectionTitle(doc, "Principales áreas de oportunidad", currentY);
  priorities.forEach(/** Draws one opportunity priority. */(priority, index) => {
    const { values, rowHeights, height } = priorityCardLayout(doc, priority, width);
    currentY = ensureSpace(doc, report, currentY, height + 12, "Áreas de oportunidad (continuación)");
    drawPanel(doc, PDF_LAYOUT.margin, currentY, width, height, PDF_COLORS.white);
    doc.rect(PDF_LAYOUT.margin, currentY, width, 24).fill(index === 0 ? PDF_COLORS.red : PDF_COLORS.gold);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(PDF_COLORS.white).text(`${index + 1}. ${pdfText(priority.title)}`, PDF_LAYOUT.margin + 12, currentY + 7, { width: width - 24 });
    const labels = ["Impacto", "Evidencia", "Corrección", "Frases sugeridas", "Evitar", "Tarea", "Meta", "Patrón"];
    const fieldWidth = (width - 54) / 4;
    for (let fieldIndex = 0; fieldIndex < labels.length; fieldIndex += 1) {
      const row = Math.floor(fieldIndex / 4);
      const column = fieldIndex % 4;
      const fieldY = currentY + 35 + (row === 0 ? 0 : rowHeights[0]);
      drawPriorityField(doc, labels[fieldIndex], values[fieldIndex], PDF_LAYOUT.margin + 12 + column * (fieldWidth + 10), fieldY, fieldWidth);
    }
    currentY += height + 12;
  });
  return currentY;
}

/** Draws objection-response coaching cards. */
function drawObjectionCards(doc: PDFKit.PDFDocument, report: AgentCoachingReport, y: number): number {
  let currentY = ensureSpace(doc, report, y, 150, "Objeciones y respuestas sugeridas");
  currentY = drawSectionTitle(doc, "Manejo de objeciones", currentY);
  const cards = report.objectionPlaybook.slice(0, 4);
  const width = (PDF_LAYOUT.pageWidth - PDF_LAYOUT.margin * 2 - 14) / 2;
  cards.forEach(/** Draws one objection card. */(item, index) => {
    const x = PDF_LAYOUT.margin + (index % 2) * (width + 14);
    const rowY = currentY + Math.floor(index / 2) * 92;
    drawPanel(doc, x, rowY, width, 80, index % 2 === 0 ? "#FFF8F8" : "#F6FAFF");
    doc.font("Helvetica-Bold").fontSize(9).fillColor(PDF_COLORS.red).text(pdfText(item.objection), x + 12, rowY + 12, { width: width - 24 });
    drawWrappedText(doc, item.response, x + 12, rowY + 31, width - 24, 8);
    if (item.evidence) drawWrappedText(doc, `Evidencia: ${item.evidence}`, x + 12, rowY + 58, width - 24, 7, PDF_COLORS.grayText);
  });
  return currentY + Math.ceil(cards.length / 2) * 92 + 8;
}

/** Draws the suggested five-step call flow grid. */
function drawCallFlowGrid(doc: PDFKit.PDFDocument, report: AgentCoachingReport, y: number): number {
  let currentY = ensureSpace(doc, report, y, 155, "Flujo sugerido de llamada");
  currentY = drawSectionTitle(doc, "Flujo sugerido de llamada", currentY);
  const columns = report.suggestedCallFlow.slice(0, 5);
  const width = (PDF_LAYOUT.pageWidth - PDF_LAYOUT.margin * 2 - 32) / 5;
  columns.forEach(/** Draws one call-flow step. */(step, index) => {
    const x = PDF_LAYOUT.margin + index * (width + 8);
    drawPanel(doc, x, currentY, width, 122, PDF_COLORS.white);
    doc.circle(x + 15, currentY + 16, 10).fill(PDF_COLORS.blue);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(PDF_COLORS.white).text(String(index + 1), x + 11, currentY + 11, { width: 8, align: "center" });
    doc.font("Helvetica-Bold").fontSize(8).fillColor(PDF_COLORS.navy).text(pdfText(step.step).replace(/^\d+\.\s*/, ""), x + 30, currentY + 10, { width: width - 42 });
    drawWrappedText(doc, step.guidance, x + 10, currentY + 34, width - 20, 7);
    drawWrappedText(doc, `Frase: ${step.examplePhrase}`, x + 10, currentY + 78, width - 20, 7, PDF_COLORS.navy);
  });
  return currentY + 138;
}

/** Draws the follow-up agenda table with page-safe row breaks. */
function drawFollowUpAgenda(doc: PDFKit.PDFDocument, report: AgentCoachingReport, y: number): number {
  let currentY = ensureSpace(doc, report, y, 82, "Agenda de pendientes");
  currentY = drawSectionTitle(doc, "Agenda de pendientes", currentY);
  const rows = report.followUpOpportunities.length > 0 ? report.followUpOpportunities : [{ callId: "-", customerName: "Sin pendientes", reason: "No se detectaron suficientes oportunidades de alta probabilidad.", suggestedAction: "Mantener seguimiento normal.", evidence: null }];
  const widths = [120, 145, 310, 130];
  const headers = ["Cliente", "Llamada", "Resumen / evidencia", "Acción pendiente"];
  const drawHeader = /** Draws the agenda table header. */(): void => {
    let x = PDF_LAYOUT.margin;
    doc.rect(x, currentY, widths.reduce((sum, width) => sum + width, 0), 22).fill(PDF_COLORS.navy);
    headers.forEach(/** Draws one agenda header cell. */(header, index) => {
      doc.font("Helvetica-Bold").fontSize(7).fillColor(PDF_COLORS.white).text(header, x + 6, currentY + 7, { width: widths[index] - 12 });
      x += widths[index];
    });
    currentY += 22;
  };
  drawHeader();
  rows.slice(0, 18).forEach(/** Draws one follow-up row. */(item) => {
    const rowTexts = [item.customerName ?? "Cliente", item.callId, item.evidence ?? item.reason, item.suggestedAction];
    const rowHeight = Math.max(30, ...rowTexts.map((text, index) => measureText(doc, text, widths[index] - 12, 7) + 14));
    if (currentY + rowHeight > PDF_LAYOUT.contentBottom) {
      currentY = addReportPage(doc, report, "Agenda de pendientes (continuación)");
      drawHeader();
    }
    let x = PDF_LAYOUT.margin;
    doc.rect(x, currentY, widths.reduce((sum, width) => sum + width, 0), rowHeight).fillAndStroke(PDF_COLORS.white, PDF_COLORS.border);
    rowTexts.forEach(/** Draws one follow-up cell. */(text, index) => {
      drawWrappedText(doc, text, x + 6, currentY + 7, widths[index] - 12, 7);
      x += widths[index];
      if (index < widths.length - 1) doc.moveTo(x, currentY).lineTo(x, currentY + rowHeight).strokeColor(PDF_COLORS.border).stroke();
    });
    currentY += rowHeight;
  });
  return currentY + 14;
}

/** Draws a color-coded action plan and best-practice section. */
function drawActionPlan(doc: PDFKit.PDFDocument, report: AgentCoachingReport, y: number): number {
  const goals = report.actionPlan.slice(0, 4).map((item) => item.replace(/^Meta \d+:\s*/i, ""));
  const practices = ["Diagnosticar antes de presentar beneficios.", "Responder objeciones con una pregunta de avance.", "Cerrar con fecha, canal y responsable.", "Registrar una razón clara cuando no avance."];
  const banner = "La mejora visible nace de repetir un cierre claro en cada llamada.";
  const width = PDF_LAYOUT.pageWidth - PDF_LAYOUT.margin * 2;
  const goalHeight = Math.max(92, ...goals.map((item) => 31 + measureText(doc, item, 148, 8) + 12));
  const practiceHeight = Math.max(54, ...practices.map((item) => 27 + measureText(doc, item, 148, 7) + 10));
  const bannerHeight = Math.max(38, 24 + measureText(doc, banner, width, 13, true));
  const sectionHeight = 25 + goalHeight + 18 + 25 + practiceHeight + 20 + bannerHeight;
  // Reserve all rendered content, not just the goals; large sections may continue between rows.
  const initialHeight = sectionHeight <= PDF_LAYOUT.contentBottom - PDF_LAYOUT.contentTop ? sectionHeight : 25 + goalHeight;
  let currentY = ensureSpace(doc, report, y, initialHeight, "Plan de acción");
  currentY = drawSectionTitle(doc, "Plan de acción", currentY);
  const colors = [PDF_COLORS.red, PDF_COLORS.gold, PDF_COLORS.green, PDF_COLORS.blue];
  goals.forEach(/** Draws one action-plan goal. */(item, index) => {
    const x = PDF_LAYOUT.margin + index * 181;
    doc.roundedRect(x, currentY, 168, goalHeight, 7).fillAndStroke("#FFFFFF", PDF_COLORS.border);
    doc.rect(x, currentY, 168, 20).fill(colors[index % colors.length]);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(PDF_COLORS.white).text(`Meta ${index + 1}`, x + 10, currentY + 6, { width: 148 });
    drawWrappedText(doc, item, x + 10, currentY + 31, 148, 8);
  });
  currentY += goalHeight + 18;
  currentY = ensureSpace(doc, report, currentY, 25 + practiceHeight + 20 + bannerHeight, "Plan de acción (continuación)");
  currentY = drawSectionTitle(doc, "Buenas prácticas para la siguiente jornada", currentY);
  practices.forEach(/** Draws one best-practice tile. */(practice, index) => {
    const x = PDF_LAYOUT.margin + index * 181;
    drawPanel(doc, x, currentY, 168, practiceHeight, "#F6FAFF");
    doc.font("Helvetica-Bold").fontSize(9).fillColor(PDF_COLORS.navy).text(`Práctica ${index + 1}`, x + 10, currentY + 10, { width: 148 });
    drawWrappedText(doc, practice, x + 10, currentY + 27, 148, 7);
  });
  currentY += practiceHeight + 20;
  currentY = ensureSpace(doc, report, currentY, bannerHeight, "Plan de acción (continuación)");
  doc.roundedRect(PDF_LAYOUT.margin, currentY, width, bannerHeight, 8).fill(PDF_COLORS.navy);
  doc.font("Helvetica-Bold").fontSize(13).fillColor(PDF_COLORS.white).text(banner, PDF_LAYOUT.margin, currentY + 12, { width, align: "center" });
  return currentY + bannerHeight + 16;
}

/** Renders a multi-page Consubanco-style PDF buffer for the transient coaching report. */
export async function renderAgentCoachingReportPdf(report: AgentCoachingReport): Promise<Buffer> {
  const { default: PDFDocument } = await import("pdfkit");
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
      bufferPages: true,
      compress: false,
      margins: { top: PDF_LAYOUT.margin, right: PDF_LAYOUT.margin, bottom: PDF_LAYOUT.margin, left: PDF_LAYOUT.margin },
      size: "LETTER",
      layout: "landscape",
      info: { Title: reportTypeLabel(report.reportType), Author: "KESP" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", /** Collects one generated PDF chunk. */(chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    doc.on("end", /** Resolves the final in-memory PDF buffer. */() => {
      resolve(Buffer.concat(chunks));
    });
    doc.on("error", /** Rejects the render promise on PDFKit stream errors. */(error: Error) => {
      reject(error);
    });

    let y = addReportPage(doc, report, reportTypeLabel(report.reportType));
    y = drawKpiStrip(doc, report, y);
    drawScoreGauge(doc, report, PDF_LAYOUT.margin, y, 355);
    drawStrengthsPanel(doc, report, PDF_LAYOUT.margin + 375, y, 353);
    y += 132;
    y = drawOpportunityTable(doc, report, y);
    y = drawObjectionCards(doc, report, y);
    y = drawCallFlowGrid(doc, report, y);
    y = drawFollowUpAgenda(doc, report, y);
    drawActionPlan(doc, report, y);
    addBufferedFooters(doc, report);
    doc.end();
  });
}

/** Builds the Spanish email body for a coaching report attachment. */
export function buildAgentCoachingReportEmailBody(report: AgentCoachingReport, reportType: "daily" | "weekly"): string {
  const reportLabel = reportType === "weekly" ? "semanal" : "diario";
  const periodDisplay = formatEmailPeriodDisplay({ ...report.dateRange, reportType });
  return [`Hola ${report.agent.salesAgentName},`, "", `Adjunto encontrarás tu reporte ${reportLabel} de coaching KESP para ${periodDisplay}.`, `El reporte incluye ${report.callsAnalyzed} llamadas elegibles analizadas, prioridades de práctica, frases sugeridas y oportunidades para retomar cuando existen señales suficientes.`, "", "Este material es para coaching operativo y debe usarse con criterio profesional y cumplimiento interno.", "", "Equipo KESP"].join("\n");
}

/** Builds a stable report PDF filename without storing generated content. */
export function agentCoachingReportFilename(report: AgentCoachingReport, reportType: "daily" | "weekly"): string {
  const label = reportType === "weekly" ? "semanal" : "diario";
  return `kesp-coaching-${label}-${report.agent.salesAgentId}-${report.dateRange.startDate}-${report.dateRange.endDate}.pdf`;
}
