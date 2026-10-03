import * as admin from 'firebase-admin';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import PDFDocument from 'pdfkit';
import { buildAgentCoachingReport, renderAgentCoachingReportPdf, type AgentCoachingReport } from '../agentCoachingReport';
import { demoReportFilename, redactDemoReport } from '../demoReportRedaction';
import { generateAgentCoachingReport } from '../demoReports';

jest.mock('../demoHttps', () => ({
  onReportCall: (_options: unknown, handler: unknown) => handler,
  onCall: (_options: unknown, handler: unknown) => handler,
  HttpsError: class extends Error {},
}));
jest.mock('../cccAutomaticWorkflowMonitor', () => ({ assertConsubancoSupervisorOrAdmin: jest.fn() }));
jest.mock('../agentActivity', () => ({ buildAgentKey: () => 'fixture-profile-key' }));
jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
jest.mock('../agentCoachingReport', () => ({
  ...jest.requireActual('../agentCoachingReport'), buildAgentCoachingReport: jest.fn(),
}));

const secrets = ['FixtureAgent', 'agentPrivateId', 'FixtureCustomer', 'FixtureOtherCustomer',
  'callPrivateId', 'otherCallPrivateId', 'fixtureRecording.wav', 'EvidenceSecretPhrase',
  'TranscriptSecretPhrase', 'ObjectionSecretPhrase', 'AgendaSecretPhrase', 'internalRubricId'];
const embedded = secrets.join(' / ');
const agentLabel = (id: string) => `AGENTE-${createHash('sha256').update(id).digest('hex').slice(0, 12).toUpperCase()}`;

/** Entirely invented local input; no provider or Firestore access. */
function fixture(reportType: 'daily' | 'weekly' = 'daily'): AgentCoachingReport {
  const startDate = '2026-09-21', endDate = reportType === 'weekly' ? '2026-09-27' : startDate;
  return {
    agent: { salesAgentName: secrets[0], salesAgentId: secrets[1] }, reportType,
    dateRange: { startDate, endDate, label: `${startDate} - ${endDate}`, timezone: 'America/Mexico_City' },
    callsAnalyzed: 2, averageScore: 82.4,
    evolution: { label: 'Cambio', previousAverageScore: 77.2, delta: 5.2, displayText: '+5.2 puntos' },
    executiveSummary: ['Conservar el seguimiento. ' + embedded],
    strengths: ['Escucha activa', embedded],
    coachingPriorities: [{
      title: 'Confirmar siguiente paso', evidence: [secrets[7]], impact: 'Mejorar claridad. ' + embedded,
      correctionSteps: ['Confirmar disponibilidad.', embedded], examplePhrases: ['Que horario prefiere?', embedded],
      phrasesToAvoid: [embedded], practiceExercise: 'Practicar el cierre. ' + embedded,
      nextCallGoal: 'Acordar horario. ' + embedded, relatedRubricCriteria: [secrets[11]],
    }],
    suggestedCallFlow: [{ step: 'Cierre', guidance: 'Confirmar el acuerdo. ' + embedded, examplePhrase: embedded }],
    objectionPlaybook: [{ objection: 'Necesita tiempo', response: 'Acordar seguimiento. ' + embedded, evidence: secrets[9] }],
    followUpOpportunities: [
      { callId: secrets[4], customerName: secrets[2], reason: embedded, suggestedAction: 'Confirmar horario. ' + embedded, evidence: secrets[10] },
      { callId: secrets[5], customerName: secrets[3], reason: embedded, suggestedAction: embedded, evidence: null },
    ],
    actionPlan: ['Meta: Confirmar horario. ' + embedded.toLowerCase()],
    selectedCalls: [{ callId: secrets[4], callName: secrets[6], customerName: secrets[2],
      callOccurredAtIso: '2026-09-21T16:00:00.000Z', bucketDay: startDate, overallScore: 82.4,
      summary: secrets[8], strengths: ['Escucha activa'], weaknesses: [embedded], nextBestAction: embedded, selected: true }],
    generatedAt: '2026-10-01T12:00:00.000Z',
    options: { includeFollowUpOpportunities: true, includeTranscriptExcerpts: true, reportLength: 'extensive', selectedCallIds: [secrets[4]] },
  };
}

/** The shared renderer uses uncompressed standard-font text, with kerning fragments. */
function pdfText(bytes: Buffer): string {
  const text: string[] = [];
  for (const stream of bytes.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const content = stream[1];
    for (const operator of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      text.push([...operator[1].matchAll(/<([a-f\d]+)>/gi)].map(match => Buffer.from(match[1], 'hex').toString('latin1')).join(''));
    }
  }
  expect(text.length).toBeGreaterThan(20);
  return text.join('\n');
}

function expectMasked(value: string) {
  const compact = value.toLowerCase().replace(/\s/g, '');
  for (const secret of secrets) expect(compact).not.toContain(secret.toLowerCase());
}

describe('demo report presentation masking', () => {
  test.each(['daily', 'weekly'] as const)('%s coaching rows reserve the full height of long suggested phrases', async kind => {
    const report = fixture(kind);
    const phrase = 'Confirmar el siguiente paso y explicar las condiciones con claridad. '.repeat(8).trim();
    report.coachingPriorities = [{ title: 'Cierre claro', impact: 'Claridad', evidence: ['Evidencia'],
      correctionSteps: ['Confirmar'], examplePhrases: [phrase], phrasesToAvoid: ['Evitar'],
      practiceExercise: 'Practicar', nextCallGoal: 'Confirmar', relatedRubricCriteria: [] }];
    const spy = jest.spyOn(PDFDocument.prototype, 'text');
    try {
      await renderAgentCoachingReportPdf(report);
      const calls = spy.mock.calls as unknown as [string, number, number, PDFKit.Mixins.TextOptions][];
      const drawnPhrase = calls.find(([text]) => text === phrase)!;
      const nextRow = calls.find(([text]) => text === 'Patrón')!;
      expect(drawnPhrase).toBeDefined();
      expect(nextRow).toBeDefined();
      const measure = new PDFDocument();
      const phraseHeight = measure.font('Helvetica').fontSize(7).heightOfString(phrase, drawnPhrase[3]);
      measure.end();
      expect(nextRow[2]).toBeGreaterThanOrEqual(drawnPhrase[2] + phraseHeight);
    } finally {
      spy.mockRestore();
    }
  });

  test('clones all report text, preserves KPIs/coaching/options, and keeps preview keys distinct', () => {
    const raw = fixture();
    const before = structuredClone(raw);
    const masked = redactDemoReport(raw);
    expect(raw).toEqual(before);
    expectMasked(JSON.stringify(masked));
    expect(masked.agent).toEqual({ salesAgentId: agentLabel(raw.agent.salesAgentId), salesAgentName: agentLabel(raw.agent.salesAgentId) });
    expect(masked.followUpOpportunities.map(row => row.customerName)).toEqual(['*CLIENTE 01*', '*CLIENTE 02*']);
    expect(new Set(masked.followUpOpportunities.map(row => row.callId)).size).toBe(2);
    expect(masked.options.selectedCallIds).toEqual([masked.selectedCalls[0].callId]);
    expect(masked.followUpOpportunities[0].callId).toBe(masked.selectedCalls[0].callId);
    expect(masked.coachingPriorities[0].evidence).toEqual(['*EVIDENCIA OCULTA PARA DEMO*']);
    expect(masked.selectedCalls[0].summary).toBe('*EVIDENCIA OCULTA PARA DEMO*');
    expect(masked.followUpOpportunities[1].evidence).toBeNull();
    expect(masked).toMatchObject({ callsAnalyzed: raw.callsAnalyzed, averageScore: raw.averageScore,
      dateRange: raw.dateRange, evolution: raw.evolution, generatedAt: raw.generatedAt,
      options: { includeFollowUpOpportunities: true, includeTranscriptExcerpts: true, reportLength: 'extensive' } });
    expect(masked.coachingPriorities[0].correctionSteps[0]).toBe('Confirmar disponibilidad.');
    expect(masked.strengths[0]).toBe('Escucha activa');
    expect(masked.actionPlan[0]).toContain('*EVIDENCIA OCULTA PARA DEMO*');
  });

  test('handles short names, regex characters and whitespace/case variants without damaging coaching words', () => {
    const raw = fixture();
    raw.agent.salesAgentName = 'Ana';
    raw.agent.salesAgentId = 'agent.[a]+(b)';
    raw.coachingPriorities[0].evidence = ['Private quote\nwith details'];
    raw.actionPlan = ['ANA: analizar el cierre de agent.[a]+(b). PRIVATE QUOTE  WITH DETAILS'];
    const masked = redactDemoReport(raw);
    const label = agentLabel(raw.agent.salesAgentId);
    expect(masked.actionPlan).toEqual([`${label}: analizar el cierre de ${label}. *EVIDENCIA OCULTA PARA DEMO*`]);
  });

  test.each(['daily', 'weekly'] as const)('%s PDF extracts masks, not source text, while retaining coaching and KPIs', async kind => {
    const raw = fixture(kind);
    const originalText = pdfText(await renderAgentCoachingReportPdf(raw)).replace(/\s/g, '');
    // Positive control: the byte extractor actually sees the original sensitive text.
    for (const secret of secrets) expect(originalText.toLowerCase()).toContain(secret.toLowerCase());
    const masked = redactDemoReport(raw);
    const bytes = await renderAgentCoachingReportPdf(masked);
    const text = pdfText(bytes);
    expectMasked(text);
    expectMasked(bytes.toString('latin1'));
    for (const label of [agentLabel(raw.agent.salesAgentId), '*CLIENTE 01*', '*LLAMADA DEMO*', '*EVIDENCIA OCULTA PARA DEMO*', '82.4', 'Escucha activa']) {
      expect(text.replace(/\s/g, '')).toContain(label.replace(/\s/g, ''));
    }
    expect(demoReportFilename(masked)).toBe(`demo-${kind}-${raw.dateRange.startDate}-${raw.dateRange.endDate}.pdf`);
  });

  test('stable canonical labels distinguish identical names and ignore report order', () => {
    const first = fixture();
    const second = fixture();
    second.agent.salesAgentId = 'otherCanonicalAgent';
    const labels = [first, second].map(report => redactDemoReport(report).agent.salesAgentName);
    expect(labels).toEqual([first, second].map(report => agentLabel(report.agent.salesAgentId)));
    expect(labels[0]).not.toBe(labels[1]);
    expect([second, first].map(report => redactDemoReport(report).agent.salesAgentName)).toEqual([...labels].reverse());
  });

  test('browser selector/portfolio/preview and PDF rendering use the identical canonical label', async () => {
    const raw = fixture();
    const moduleUrl = pathToFileURL(resolve(__dirname, '../../../src/lib/kespDemoRedaction.ts')).href;
    const browserLabels = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import { maskKespDemoAgentDisplayName, registerKespDemoAgentAnalysisTerms, redactKespDemoText } from ${JSON.stringify(moduleUrl)};
      const agent = ${JSON.stringify(raw.agent)};
      registerKespDemoAgentAnalysisTerms(agent);
      const direct = maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId);
      console.log(JSON.stringify([direct, maskKespDemoAgentDisplayName(agent.salesAgentName), redactKespDemoText(direct)]));
    `], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } })) as string[];
    const masked = redactDemoReport(raw);
    expect(browserLabels).toEqual(Array(3).fill(masked.agent.salesAgentName));
    const text = pdfText(await renderAgentCoachingReportPdf(masked));
    expect(text).toContain(browserLabels[0]);
    expectMasked(text);
  });

  test('repeated redaction preserves generated labels and existing placeholders verbatim', () => {
    const masked = redactDemoReport(fixture());
    expect(redactDemoReport(masked)).toEqual(masked);
    const legacy = fixture();
    legacy.agent = { salesAgentId: '*ID AGENTE 03*', salesAgentName: '*AGENTE 03*' };
    legacy.executiveSummary = ['*AGENTE 03* / *CLIENTE 07* / *LLAMADA DEMO* 09'];
    expect(redactDemoReport(legacy).agent).toEqual(legacy.agent);
    expect(redactDemoReport(legacy).executiveSummary).toEqual(legacy.executiveSummary);
  });

  test('first-name fragments cannot escape report masking or alter masked labels', () => {
    const raw = fixture();
    raw.agent.salesAgentName = 'Ana FictionalSurname';
    raw.actionPlan = ['Ana: ayudar a FictionalSurname; analizar el cierre.', '*AGENTE 01* / AGENTE-123456789012'];
    const masked = redactDemoReport(raw);
    const label = agentLabel(raw.agent.salesAgentId);
    expect(masked.actionPlan).toEqual([`${label}: ayudar a ${label}; analizar el cierre.`, raw.actionPlan[1]]);
    expect(redactDemoReport(masked)).toEqual(masked);
  });

  test('whole names stay masked without redacting common Spanish connectors or initials', () => {
    const raw = fixture();
    raw.agent.salesAgentName = 'Ana de la Fictional A.';
    raw.actionPlan = ['Ana de la Fictional A.: Ana Fictional.', 'A. partir de la llamada, explicar el cierre y las condiciones.'];
    const label = agentLabel(raw.agent.salesAgentId);
    expect(redactDemoReport(raw).actionPlan).toEqual([`${label}: ${label} ${label}.`, raw.actionPlan[1]]);
    raw.agent.salesAgentName = '*PrivateName*';
    raw.actionPlan = ['*PrivateName*'];
    expect(redactDemoReport(raw).agent.salesAgentName).toBe(label);
    expect(redactDemoReport(raw).actionPlan).toEqual([label]);
  });

  test('numeric identities after placeholders remain masked in preview and PDF', async () => {
    const raw = fixture();
    raw.agent.salesAgentId = '5512345678';
    raw.actionPlan = ['*AGENTE 01* 5512345678', '*LLAMADA DEMO* 5512345678', '*EVIDENCIA OCULTA PARA DEMO* 5512345678'];
    const masked = redactDemoReport(raw);
    const label = agentLabel(raw.agent.salesAgentId);
    expect(masked.actionPlan).toEqual([`*AGENTE 01* ${label}`, `*LLAMADA DEMO* ${label}`, `*EVIDENCIA OCULTA PARA DEMO* ${label}`]);
    expect(JSON.stringify(masked)).not.toContain(raw.agent.salesAgentId);
    expect(pdfText(await renderAgentCoachingReportPdf(masked))).not.toContain(raw.agent.salesAgentId);
    expect(redactDemoReport(masked)).toEqual(masked);
  });

  test.each([false, true])('callable returns masked preview with includePdf=%s, without archival/provider writes', async includePdf => {
    const raw = fixture('weekly');
    const query = { where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [{ id: 'profile', data: () => ({
      organizationId: 'consubanco', visibilityScope: 'organization', uploadedBy: 'demo-owner',
      salesAgentId: raw.agent.salesAgentId, salesAgentName: raw.agent.salesAgentName,
    }) }] }) };
    const db = { collection: jest.fn().mockReturnValue(query) };
    jest.mocked(admin.firestore).mockReturnValue(db as unknown as FirebaseFirestore.Firestore);
    jest.mocked(buildAgentCoachingReport).mockResolvedValue(raw);
    const invoke = generateAgentCoachingReport as unknown as (request: unknown) => Promise<{
      report: AgentCoachingReport; filename: string | null; pdfBase64: string | null;
    }>;
    const response = await invoke({ auth: { uid: 'supervisor' }, data: {
      salesAgentId: raw.agent.salesAgentId, reportType: 'weekly', startDate: '2026-09-21', endDate: '2026-09-27', includePdf,
    } });
    expectMasked(JSON.stringify(response.report));
    expect(response.report).toEqual(redactDemoReport(raw));
    if (includePdf) {
      expectMasked(pdfText(Buffer.from(response.pdfBase64!, 'base64')));
      expect(response.filename).toBe('demo-weekly-2026-09-21-2026-09-27.pdf');
    } else {
      expect(response.pdfBase64).toBeNull();
      expect(response.filename).toBeNull();
    }
    expect(db.collection).toHaveBeenCalledWith('agent_analyses');
  });
});
