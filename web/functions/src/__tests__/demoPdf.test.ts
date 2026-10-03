import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import PDFDocument from 'pdfkit';
import { renderAgentCoachingReportPdf, type AgentCoachingReport } from '../agentCoachingReport';

/** Fabricated renderer input only: no Firestore, provider, transcript or historical feedback reads. */
function reportFixture(type: 'daily' | 'weekly', long = false): AgentCoachingReport {
  const startDate = '2026-09-21', endDate = type === 'weekly' ? '2026-09-27' : startDate;
  return {
    agent: { salesAgentId: 'demo_lucia_modelo', salesAgentName: 'Lucía Modelo (ficticia)' },
    reportType: type,
    dateRange: { startDate, endDate, label: type === 'weekly' ? '21 al 27 de septiembre de 2026' : '21 de septiembre de 2026',
      timezone: 'America/Mexico_City' },
    callsAnalyzed: type === 'weekly' ? 10 : 2,
    averageScore: 82.4,
    evolution: { label: type === 'weekly' ? 'Evolución vs semana anterior' : 'Evolución vs ayer',
      previousAverageScore: 77.2, delta: 5.2, displayText: '+5.2 puntos' },
    executiveSummary: ['Ejemplo ficticio para validar el diseño del reporte.', 'La escucha mejora cuando se confirma la necesidad antes de presentar opciones.'],
    strengths: ['Escucha y confirma la necesidad.', 'Explica sin prometer aprobación.', 'Respeta la decisión del cliente.'],
    coachingPriorities: [
      { title: 'Acordar un siguiente paso claro', impact: 'Reduce contactos ambiguos y expectativas incorrectas.',
        evidence: ['Cliente Alfa: prefiero saber cuándo volveremos a hablar.'],
        correctionSteps: ['Preguntar disponibilidad.', 'Confirmar fecha y propósito.'],
        examplePhrases: ['¿Le parece el jueves a las diez para aclarar sus dudas?'],
        phrasesToAvoid: ['Le llamo luego, cuando pueda.'],
        practiceExercise: 'Ensayar un cierre con fecha, objetivo y confirmación.',
        nextCallGoal: 'Confirmar el acuerdo antes de despedirse.',
        relatedRubricCriteria: ['rubric_analysis_A', 'CRITERION_INTERNAL_ONLY_A1'] },
      { title: 'Explorar antes de explicar', impact: 'Hace que la información responda a una necesidad real.',
        evidence: ['Cliente Beta: solo quiero entender el costo total.'],
        correctionSteps: ['Hacer una pregunta abierta.', 'Resumir la prioridad.'],
        examplePhrases: ['¿Qué necesita entender antes de decidir si continúa?'],
        phrasesToAvoid: ['Primero escuche todo lo que tengo que explicar.'],
        practiceExercise: 'Practicar una pregunta y un resumen sin interrumpir.',
        nextCallGoal: 'Confirmar la pregunta principal del cliente.',
        relatedRubricCriteria: ['rubric_analysis_B', 'CRITERION_INTERNAL_ONLY_B2'] },
      { title: 'Comparar condiciones completas', impact: 'Evita conclusiones basadas únicamente en el pago.',
        evidence: ['Cliente Gamma: me importa saber el plazo completo.'],
        correctionSteps: ['Separar datos confirmados y pendientes.', 'No garantizar condiciones.'],
        examplePhrases: ['Revisemos costo total, plazo y comisiones en información oficial.'],
        phrasesToAvoid: ['Seguro le conviene y queda aprobado.'],
        practiceExercise: 'Explicar qué dato falta antes de recomendar avanzar.',
        nextCallGoal: 'No confundir información con una oferta aprobada.',
        relatedRubricCriteria: ['severity_analysis_C', 'CRITERION_INTERNAL_ONLY_C3'] },
    ],
    suggestedCallFlow: [
      { step: 'Saludar', guidance: 'Presentarse y pedir permiso para conversar.', examplePhrase: '¿Dispone de unos minutos?' },
      { step: 'Escuchar', guidance: 'Explorar la duda principal sin interrumpir.', examplePhrase: '¿Qué necesita aclarar?' },
      { step: 'Explicar', guidance: 'Responder con información verificable.', examplePhrase: 'Comparemos plazo y costo total.' },
      { step: 'Confirmar', guidance: 'Comprobar que la explicación fue clara.', examplePhrase: '¿Resuelve su duda?' },
      { step: 'Cerrar', guidance: 'Acordar el siguiente paso sin presión.', examplePhrase: '¿Qué prefiere hacer después?' },
    ],
    objectionPlaybook: [
      { objection: 'Quiero comparar antes de decidir.', response: 'Podemos aclarar dudas sin iniciar una solicitud.', evidence: 'Cliente Alfa pidió tiempo.' },
      { objection: 'No deseo compartir datos.', response: 'No necesita compartir claves ni información de su cuenta.', evidence: 'Cliente Beta expresó cautela.' },
    ],
    followUpOpportunities: Array.from({ length: long ? 18 : 2 }, (_, i) => ({
      callId: 'demostracion-' + String(i + 1).padStart(2, '0'),
      customerName: 'Cliente ficticio ' + (i + 1),
      reason: 'Solicitó una explicación informativa.',
      suggestedAction: long
        ? 'Confirmar fecha y propósito; aclarar costo total y plazo sin iniciar una solicitud ni prometer condiciones.'
        : 'Confirmar la consulta del jueves.',
      evidence: long
        ? 'Ejemplo inventado ' + (i + 1) + ': el cliente solicita tiempo para comparar y no autoriza una contratación. ' +
          'La agente debe confirmar qué duda queda pendiente, respetar la decisión y evitar garantías de aprobación. ' +
          'La siguiente conversación será informativa, con fecha y objetivo acordados.'
        : 'Quiero revisar la información antes de continuar.',
    })),
    actionPlan: [
      'Meta 1: Confirmar fecha y propósito en cada cierre acordado.',
      'Meta 2: Hacer una pregunta abierta antes de presentar información.',
      'Meta 3: Distinguir condiciones verificadas y dudas pendientes.',
      'Meta 4: Respetar negativas sin registrar una aceptación.',
    ],
    selectedCalls: [
      { callId: 'demostracion-01', callName: 'Consulta ficticia de comparación', customerName: 'Cliente Alfa',
        callOccurredAtIso: '2026-09-21T16:00:00.000Z', bucketDay: startDate, overallScore: 82.4,
        summary: 'Ejemplo sintético, no análisis de una llamada procesada.',
        strengths: ['Escucha sin presión.'], weaknesses: ['Seguimiento ambiguo.'],
        nextBestAction: 'Confirmar objetivo y horario.', selected: true },
    ],
    generatedAt: '2026-10-01T12:00:00.000Z',
    options: { includeFollowUpOpportunities: true, includeTranscriptExcerpts: true, reportLength: long ? 'extensive' : 'detailed' },
  };
}

function saveArtifact(filename: string, bytes: Buffer): void {
  if (process.env.DEMO_PDF_WRITE_ARTIFACTS !== '1') return;
  const directory = resolve(__dirname, '../../../../artifacts/pdf-test');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, filename), bytes);
}

describe('synthetic daily/weekly PDF rendering without inference or cloud data', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each(['daily', 'weekly'] as const)('%s returns an asynchronous valid-looking PDF with Spanish visible copy', async reportType => {
    const text = jest.spyOn(PDFDocument.prototype, 'text');
    const pages = jest.spyOn(PDFDocument.prototype, 'addPage');
    const promise = renderAgentCoachingReportPdf(reportFixture(reportType));
    expect(promise).toBeInstanceOf(Promise);
    const bytes = await promise;
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.subarray(0, 8).toString()).toMatch(/^%PDF-1\.[3-7]/);
    expect(bytes.subarray(-30).toString()).toMatch(/%%EOF\s*$/);
    expect(bytes.length).toBeGreaterThan(10000);
    expect(pages.mock.calls.length).toBeGreaterThanOrEqual(2);
    const visible = text.mock.calls.map(args => String(args[0])).join('\n');
    expect(visible).toContain(reportType === 'daily' ? 'Reporte diario de coaching' : 'Reporte semanal de coaching');
    for (const label of ['Lucía Modelo (ficticia)', 'Fortalezas observadas', 'Principales áreas de oportunidad',
      'Manejo de objeciones', 'Agenda de pendientes', 'Plan de acción', 'Página 1 de', '+5.2 puntos']) expect(visible).toContain(label);
    expect(visible).not.toMatch(/rubric_analysis|severity_analysis|CRITERION_INTERNAL_ONLY|Executive summary|Strengths|Next steps/);
    saveArtifact('synthetic-' + reportType + '.pdf', bytes);
  });

  test.each(['daily', 'weekly'] as const)('%s long agenda paginates and retains every synthetic row and footer', async reportType => {
    const text = jest.spyOn(PDFDocument.prototype, 'text');
    const pages = jest.spyOn(PDFDocument.prototype, 'addPage');
    const bytes = await renderAgentCoachingReportPdf(reportFixture(reportType, true));
    const count = pages.mock.calls.length;
    expect(count).toBeGreaterThanOrEqual(4);
    expect(count).toBeLessThan(15);
    const visible = text.mock.calls.map(args => String(args[0])).join('\n');
    for (let i = 1; i <= 18; i++) expect(visible).toContain('demostracion-' + String(i).padStart(2, '0'));
    for (let i = 1; i <= count; i++) expect(visible).toContain('Página ' + i + ' de ' + count);
    expect(visible).toContain('Agenda de pendientes (continuación)');
    expect(visible).toContain('La mejora visible nace de repetir un cierre claro en cada llamada.');
    expect(bytes.subarray(-30).toString()).toMatch(/%%EOF\s*$/);
    saveArtifact('synthetic-' + reportType + '-long.pdf', bytes);
  });

  test('missing prior score and empty evidence use Spanish fallbacks', async () => {
    const text = jest.spyOn(PDFDocument.prototype, 'text');
    const report = reportFixture('weekly');
    report.averageScore = null;
    report.evolution = { label: 'Evolución vs semana anterior', previousAverageScore: null, delta: null, displayText: 'No disponible' };
    report.strengths = [];
    report.followUpOpportunities = [];
    report.coachingPriorities[0].evidence = [];
    const bytes = await renderAgentCoachingReportPdf(report);
    const visible = text.mock.calls.map(args => String(args[0])).join('\n');
    for (const label of ['No disponible', 'Sin puntaje', 'Sin pendientes', 'Sin evidencia textual suficiente.']) expect(visible).toContain(label);
    expect(visible).not.toMatch(/\bundefined\b|\bNaN\b/);
    saveArtifact('synthetic-weekly-no-prior.pdf', bytes);
  });

  test('long report closing banner stays inside the content area, above the footer', async () => {
    const panels = jest.spyOn(PDFDocument.prototype, 'roundedRect');
    await renderAgentCoachingReportPdf(reportFixture('weekly', true));
    const banner = panels.mock.calls.filter(args => args[2] === 728).at(-1);
    expect(banner).toBeDefined();
    // Existing renderer declares contentBottom=540 and footerTop=556; no panel may cover either.
    expect(Number(banner![1]) + Number(banner![3])).toBeLessThanOrEqual(540);
  });

  test('measured action text expands its cards and moves following sections without footer overlap', async () => {
    const panels = jest.spyOn(PDFDocument.prototype, 'roundedRect');
    const report = reportFixture('weekly', true);
    report.actionPlan[0] = 'Confirmar el objetivo antes de proponer un horario. '.repeat(18);
    const bytes = await renderAgentCoachingReportPdf(report);
    const cards = panels.mock.calls.filter(args => args[2] === 168);
    expect(cards.some(args => Number(args[3]) > 92)).toBe(true);
    for (const card of cards) expect(Number(card[1]) + Number(card[3])).toBeLessThanOrEqual(540);
    const banner = panels.mock.calls.filter(args => args[2] === 728).at(-1)!;
    expect(Number(banner[1]) + Number(banner[3])).toBeLessThanOrEqual(540);
    saveArtifact('synthetic-weekly-long-action.pdf', bytes);
  });
});
