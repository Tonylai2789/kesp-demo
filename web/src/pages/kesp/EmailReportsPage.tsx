import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileText, RefreshCw } from 'lucide-react';
import { Button, Pill, Section } from '@/components/kesp/primitives';
import { useAuth } from '@/contexts/useAuth';
import { isConsubancoSupervisorOrAdminMember, subscribeToConsubancoMembership } from '@/services/organizations';
import { previousDemoWeek } from '@/lib/demoReportPeriod';
import { maskKespDemoAgentDisplayName, maskKespDemoCallDisplayName } from '@/lib/kespDemoRedaction';
import {
  generateAgentCoachingReport, listAgentCoachingReportCalls, listAgentEmailReportRecipients,
  type AgentCoachingReport, type AgentCoachingReportCallRow, type AgentCoachingReportLength,
  type AgentEmailReportRecipientRow, type AgentCoachingReportType,
} from '@/services/functions';

/** Renders one generated Spanish coaching report preview. */
function CoachingReportPreview({ report, salesAgentId }: { report: AgentCoachingReport; salesAgentId: string }) {
  return (
    <div className="email-report-preview">
      <div className="email-report-preview-head">
        <div>
          <span>Reporte de coaching</span>
          <h3>{maskKespDemoAgentDisplayName(report.agent.salesAgentName, salesAgentId)}</h3>
          <p>{report.dateRange.label} · {report.callsAnalyzed} llamadas · {report.reportType === 'weekly' ? 'Semanal' : 'Diario'}</p>
        </div>
        <Pill kind="info">{report.averageScore == null ? 'Score no disponible' : `${report.averageScore.toFixed(1)}/100`}</Pill>
      </div>
      <div className="email-report-preview-section">
        <h4>Evolución</h4>
        <p>{report.evolution.label}: {report.evolution.displayText}</p>
      </div>
      <div className="email-report-preview-section">
        <h4>Resumen ejecutivo</h4>
        {report.executiveSummary.map((line) => <p key={line}>{line}</p>)}
      </div>
      <div className="email-report-preview-section">
        <h4>Prioridades de coaching</h4>
        {report.coachingPriorities.map((priority) => (
          <article key={priority.title} className="email-report-preview-card">
            <strong>{priority.title}</strong>
            <p>{priority.impact}</p>
            <ul>{priority.correctionSteps.map((step) => <li key={step}>{step}</li>)}</ul>
            <p><b>Frase sugerida:</b> {priority.examplePhrases[0]}</p>
          </article>
        ))}
      </div>
      <div className="email-report-preview-section">
        <h4>Oportunidades para retomar</h4>
        {report.followUpOpportunities.length === 0 ? (
          <p>No se detectaron suficientes oportunidades de alta probabilidad en el periodo seleccionado.</p>
        ) : report.followUpOpportunities.map((item) => (
          <p key={item.callId}><b>{item.customerName ?? 'Cliente'}:</b> {item.suggestedAction}</p>
        ))}
      </div>
      <div className="email-report-preview-section">
        <h4>Plan de acción</h4>
        <ul>{report.actionPlan.map((item) => <li key={item}>{item}</li>)}</ul>
      </div>
    </div>
  );
}


/** Transient report builder with no recipient mapping, delivery, or send dependency. */
export function EmailReportsPage() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [period] = useState(() => previousDemoWeek());
  const [authorized, setAuthorized] = useState(false);
  const [profiles, setProfiles] = useState<AgentEmailReportRecipientRow[]>([]);
  const [agentId, setAgentId] = useState('');
  const [startDate, setStartDate] = useState(period.startDate);
  const [endDate, setEndDate] = useState(period.endDate);
  const [reportType, setReportType] = useState<AgentCoachingReportType>('weekly');
  const [reportLength, setReportLength] = useState<AgentCoachingReportLength>('detailed');
  const [includeFollowUps, setIncludeFollowUps] = useState(true);
  const [includeExcerpts, setIncludeExcerpts] = useState(false);
  const [calls, setCalls] = useState<AgentCoachingReportCallRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [report, setReport] = useState<AgentCoachingReport | null>(null);
  const [pdf, setPdf] = useState<{ url: string; filename: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [profileRevision, setProfileRevision] = useState(0);
  const generation = useRef(0);
  const pdfUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!user?.uid) return;
    return subscribeToConsubancoMembership(user.uid, (member) => setAuthorized(isConsubancoSupervisorOrAdminMember(member)), () => setAuthorized(false));
  }, [user?.uid]);

  useEffect(() => {
    if (!authorized) return;
    let active = true;
    // Compatibility API lists demo profiles; no email mappings or delivery operations are used.
    void listAgentEmailReportRecipients({ reportType: 'weekly', weekKey: period.weekKey }).then((result) => {
      if (!active) return;
      const rows = result.rows ?? result.recipients ?? [];
      setProfiles(rows); setAgentId((current) => rows.some((row) => row.salesAgentId === current) ? current : rows[0]?.salesAgentId ?? '');
    }).catch(() => { if (active) setError(t('demo.loadError')); });
    return () => { active = false; };
  }, [authorized, period.weekKey, profileRevision, t]);

  useEffect(() => () => {
    generation.current += 1;
    if (pdfUrl.current) URL.revokeObjectURL(pdfUrl.current);
  }, []);

  /** Drop transient results whenever their input identity changes. */
  function clearReport() {
    generation.current += 1; setReport(null); setPdf(null); setError('');
    if (pdfUrl.current) URL.revokeObjectURL(pdfUrl.current);
    pdfUrl.current = null;
  }

  /** Load an exact agent/date snapshot before enabling PDF generation. */
  async function loadCalls() {
    if (busy || !agentId || !authorized) return;
    clearReport(); setCalls([]); setSelected([]);
    if (!startDate || !endDate || startDate > endDate) { setError(t('demo.invalidDates')); return; }
    const request = generation.current; setBusy(true);
    try {
      const result = await listAgentCoachingReportCalls({ salesAgentId: agentId, startDate, endDate, reportType });
      if (request !== generation.current) return;
      setCalls(result.rows); setSelected(result.rows.map((row) => row.callId));
    } catch { if (request === generation.current) setError(t('kesp.emailReports.toasts.callsLoadError')); }
    finally { if (request === generation.current) setBusy(false); }
  }

  /** The PDF buffer lives only in browser memory and is revoked on replacement/unmount. */
  async function generate() {
    if (busy || !authorized || !selected.length) return;
    clearReport(); const request = generation.current; setBusy(true);
    try {
      const result = await generateAgentCoachingReport({ salesAgentId: agentId, startDate, endDate, reportType, selectedCallIds: selected, includePdf: true, options: { includeFollowUpOpportunities: includeFollowUps, includeTranscriptExcerpts: includeExcerpts, reportLength } });
      if (request !== generation.current) return;
      setReport(result.report);
      if (result.pdfBase64) {
        const bytes = Uint8Array.from(window.atob(result.pdfBase64), (character) => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        pdfUrl.current = url; setPdf({ url, filename: result.filename ?? 'reporte-demo.pdf' });
      }
    } catch { if (request === generation.current) setError(t('kesp.emailReports.toasts.reportGenerateError')); }
    finally { if (request === generation.current) setBusy(false); }
  }

  /** A different period/profile requires fresh eligible call selection. */
  function clearCalls() { clearReport(); setCalls([]); setSelected([]); }

  if (!authorized) return <main className="main"><p role="status">{t('kesp.emailReports.accessDenied')}</p></main>;
  return <main className="main email-reports-page">
    <h1 className="text-2xl font-semibold">{t('demo.reports')}</h1>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <Section className="email-reports-workspace">
      <div className="email-report-builder-grid">
        <label className="email-reports-field"><span>{t('kesp.emailReports.builder.agent')}</span><select disabled={busy} value={agentId} onChange={(event) => { setAgentId(event.target.value); clearCalls(); }}>{!profiles.length && <option value="">{t('demo.noAgents')}</option>}{profiles.map((row) => <option key={row.salesAgentId} value={row.salesAgentId}>{maskKespDemoAgentDisplayName(row.salesAgentName, row.salesAgentId)}</option>)}</select></label>
        <label className="email-reports-field"><span>{t('kesp.emailReports.controls.reportType')}</span><select disabled={busy} value={reportType} onChange={(event) => { setReportType(event.target.value as AgentCoachingReportType); clearCalls(); }}><option value="daily">{t('kesp.emailReports.reportType.daily')}</option><option value="weekly">{t('kesp.emailReports.reportType.weekly')}</option></select></label>
        <label className="email-reports-field"><span>{t('kesp.emailReports.builder.startDate')}</span><input type="date" disabled={busy} value={startDate} onChange={(event) => { setStartDate(event.target.value); clearCalls(); }} /></label>
        <label className="email-reports-field"><span>{t('kesp.emailReports.builder.endDate')}</span><input type="date" disabled={busy} value={endDate} onChange={(event) => { setEndDate(event.target.value); clearCalls(); }} /></label>
        <label className="email-reports-field"><span>{t('kesp.emailReports.builder.length')}</span><select disabled={busy} value={reportLength} onChange={(event) => { setReportLength(event.target.value as AgentCoachingReportLength); clearReport(); }}>{(['concise','detailed','extensive'] as const).map((value) => <option key={value} value={value}>{t('kesp.emailReports.builder.length' + value[0].toUpperCase() + value.slice(1))}</option>)}</select></label>
      </div>
      <div className="email-report-builder-options">
        <label><input type="checkbox" disabled={busy} checked={includeFollowUps} onChange={(event) => { setIncludeFollowUps(event.target.checked); clearReport(); }} /> {t('kesp.emailReports.builder.includeFollowUps')}</label>
        <label><input type="checkbox" disabled={busy} checked={includeExcerpts} onChange={(event) => { setIncludeExcerpts(event.target.checked); clearReport(); }} /> {t('kesp.emailReports.builder.includeTranscripts')}</label>
      </div>
      <div className="email-reports-action-stack">
        <Button kind="ghost" disabled={busy} onClick={() => { clearCalls(); setProfileRevision((value) => value + 1); }} icon={<RefreshCw size={16} />}>{t('kesp.emailReports.actions.refresh')}</Button>
        <Button kind="soft" disabled={busy || !agentId} onClick={() => void loadCalls()} icon={<RefreshCw size={16} />}>{t('kesp.emailReports.actions.loadCalls')}</Button>
        <Button kind="soft" disabled={busy || !selected.length} onClick={() => void generate()} icon={<FileText size={16} />}>{t(busy ? 'common.loading' : 'kesp.emailReports.actions.generateReport')}</Button>
        {pdf && <a className="btn btn-soft" href={pdf.url} download={pdf.filename}><Download size={16} />{t('kesp.emailReports.actions.downloadPdf')}</a>}
      </div>
      <div className="email-report-call-picker">
        {!calls.length && <p>{t('kesp.emailReports.builder.noCalls')}</p>}
        {calls.map((call) => <label key={call.callId} className="email-report-call-row"><input type="checkbox" disabled={busy} checked={selected.includes(call.callId)} onChange={() => { setSelected((current) => current.includes(call.callId) ? current.filter((id) => id !== call.callId) : [...current, call.callId]); clearReport(); }} /><span><strong>{maskKespDemoCallDisplayName(call.callName ?? call.customerName ?? call.callId)}</strong><small>{call.bucketDay ?? call.callOccurredAtIso ?? '-'} · {call.overallScore == null ? '-' : call.overallScore.toFixed(1) + '/100'}</small></span></label>)}
      </div>
      {report && <CoachingReportPreview report={report} salesAgentId={agentId} />}
      {pdf && <iframe title={t('demo.reports')} src={pdf.url} className="w-full border-0" style={{ height: 650, marginTop: 20 }} />}
    </Section>
  </main>;
}
