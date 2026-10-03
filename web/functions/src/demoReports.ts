import * as admin from 'firebase-admin';
import { onCall, onReportCall, HttpsError, type CallableRequest } from './demoHttps';
import { assertConsubancoSupervisorOrAdmin } from './cccAutomaticWorkflowMonitor';
import { buildAgentKey } from './agentActivity';
import { buildAgentCoachingReport, listAgentCoachingReportCalls as listCalls, renderAgentCoachingReportPdf, normalizeAgentCoachingReportOptions, type AgentCoachingReportProfile, type AgentCoachingReportPeriodRange } from './agentCoachingReport';
import { redactDemoReport, demoReportFilename } from './demoReportRedaction';

const TIMEZONE = 'America/Mexico_City';
type ReportRequest = { salesAgentId?: string; startDate?: string; endDate?: string; reportType?: 'daily' | 'weekly'; selectedCallIds?: string[]; options?: Record<string, unknown>; includePdf?: boolean; periodKey?: string; dateKey?: string; weekKey?: string };

/** Rejects invalid dates rather than silently rolling them into another period. */
function dateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Adds calendar days without relying on the server's local timezone. */
function addDays(value: string, count: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** Resolves the reporting day in Mexico City. */
function localDay(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}

/** Supports the existing daily/ISO-week UI period contract. */
export function demoReportRange(data: ReportRequest): AgentCoachingReportPeriodRange {
  let start = data.startDate;
  let end = data.endDate;
  if (!start) {
    const key = data.periodKey || data.weekKey || data.dateKey;
    if (data.reportType === 'weekly') {
      if (key && /^\d{4}-W\d{2}$/.test(key)) {
        const [year, week] = key.split('-W').map(Number);
        if (week < 1 || week > 53) throw new HttpsError('invalid-argument', 'Invalid week');
        const jan4 = `${year}-01-04`;
        start = addDays(jan4, -((new Date(`${jan4}T12:00:00Z`).getUTCDay() + 6) % 7) + (week - 1) * 7);
      } else if (key && dateKey(key)) {
        start = key;
      } else if (key) {
        throw new HttpsError('invalid-argument', 'Invalid week');
      } else {
        const today = localDay();
        start = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) - 7);
      }
      end = addDays(start, 6);
    } else {
      start = key || addDays(localDay(), -1);
      end = start;
    }
  }
  end ||= start;
  if (!dateKey(start) || !dateKey(end) || end < start || Date.parse(end) - Date.parse(start) > 31 * 86400000) {
    throw new HttpsError('invalid-argument', 'Choose a valid date range of at most 32 days');
  }
  return { startDate:start, endDate:end, timezone:TIMEZONE, label:start === end ? start : `${start} a ${end}` };
}

/** Only organization-visible demo profiles can provide shared reports. */
function profileFromDoc(doc: FirebaseFirestore.DocumentSnapshot): AgentCoachingReportProfile | null {
  const data = doc.data();
  if (!data || data.organizationId !== 'consubanco' || data.visibilityScope !== 'organization' ||
      typeof data.uploadedBy !== 'string' || typeof data.salesAgentId !== 'string') return null;
  return { agentAnalysisId:doc.id, uploadedBy:data.uploadedBy, salesAgentId:data.salesAgentId,
    salesAgentName:typeof data.salesAgentName === 'string' ? data.salesAgentName : 'Agente de demostración',
    agentKey:buildAgentKey(data.uploadedBy, data.salesAgentId) };
}

/** Resolves canonical agent linkage without requiring or fabricating CCC provenance. */
async function profileForRequest(data: ReportRequest): Promise<AgentCoachingReportProfile> {
  if (typeof data.salesAgentId !== 'string' || !data.salesAgentId || data.salesAgentId.length > 160) throw new HttpsError('invalid-argument', 'Agent required');
  const profiles = await admin.firestore().collection('agent_analyses').where('organizationId', '==', 'consubanco')
    .where('salesAgentId', '==', data.salesAgentId).limit(10).get();
  const profile = profiles.docs.map(profileFromDoc).find(value => value !== null);
  if (!profile) throw new HttpsError('not-found', 'Demo agent not found');
  return profile;
}

/** Retains the supervisor report-list API without recipients or delivery side effects. */
export const listAgentEmailReportRecipients = onCall({ invoker:'public' }, async (request: CallableRequest<ReportRequest>) => {
  await assertConsubancoSupervisorOrAdmin(request.auth!.uid, admin.firestore());
  const data = request.data || {};
  const range = demoReportRange(data);
  const snapshot = await admin.firestore().collection('agent_analyses').where('organizationId', '==', 'consubanco').where('visibilityScope', '==', 'organization').limit(100).get();
  const rows = [];
  const seen = new Set<string>();
  for (const doc of snapshot.docs) {
    const profile = profileFromDoc(doc);
    if (!profile || seen.has(profile.salesAgentId)) continue;
    seen.add(profile.salesAgentId);
    const calls = await listCalls(admin.firestore(), profile, range);
    const scores = calls.map(call => call.overallScore).filter((value):value is number=>value !== null);
    const eligibility = { eligible:calls.length > 0, callCount:calls.length, skipReason:calls.length ? null : 'no_eligible_calls' };
    rows.push({ ...profile, ...eligibility, eligibleCallCount:calls.length,
      averageScore:scores.length ? scores.reduce((sum,value)=>sum+value,0)/scores.length : null,
      emailRedacted:null, emailDomain:null, mappingEnabled:false, mappingVerified:false, mappingPlaceholder:true,
      mappingDemoOnly:true, mappingStatus:'missing', latestDeliveryStatus:null, latestDeliveryAt:null, latestDeliveryId:null,
      mapping:null, eligibility, latestDelivery:null });
  }
  return { success:true, generatedAt:new Date().toISOString(), period:{...range,reportType:data.reportType || 'daily',periodKey:data.periodKey || data.weekKey || data.dateKey || range.startDate}, rows };
});

/** Lists selected-period final-feedback calls using the production report builder. */
export const listAgentCoachingReportCalls = onCall({ invoker:'public' }, async (request:CallableRequest<ReportRequest>) => {
  await assertConsubancoSupervisorOrAdmin(request.auth!.uid, admin.firestore());
  const range = demoReportRange(request.data || {});
  const profile = await profileForRequest(request.data || {});
  return { success:true, generatedAt:new Date().toISOString(), range, rows:await listCalls(admin.firestore(),profile,range) };
});

/** Returns a transient Spanish report/PDF; no email SDK, secrets or archive writes. */
export const generateAgentCoachingReport = onReportCall({invoker:'public',timeoutSeconds:120,memory:'1GiB'}, async (request:CallableRequest<ReportRequest>) => {
  await assertConsubancoSupervisorOrAdmin(request.auth!.uid, admin.firestore());
  const data = request.data || {};
  const profile = await profileForRequest(data);
  const report = await buildAgentCoachingReport(admin.firestore(),profile,demoReportRange(data), {
    ...normalizeAgentCoachingReportOptions({...data.options,selectedCallIds:data.selectedCallIds}),
    reportType:data.reportType === 'weekly' ? 'weekly' : 'daily',
  });
  if (!report) throw new HttpsError('failed-precondition','No hay llamadas elegibles analizadas en el periodo.');
  const maskedReport = redactDemoReport(report);
  const pdf = data.includePdf === false ? null : await renderAgentCoachingReportPdf(maskedReport);
  return { success:true, generatedAt:new Date().toISOString(), report:maskedReport, pdfBase64:pdf?.toString('base64') ?? null,
    filename:pdf ? demoReportFilename(maskedReport) : null };
});
