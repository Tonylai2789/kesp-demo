import PDFDocument from 'pdfkit';
import { buildAgentCoachingReport, renderAgentCoachingReportPdf } from '../agentCoachingReport';
import { DEMO_BUCKET } from '../demoConfig';

interface Fixture {
  action?: string | null;
  legacyAction?: string;
  weaknesses?: string[];
  summary?: string;
  feedback?: Record<string, unknown>;
}

const profile = { agentAnalysisId: 'profile', uploadedBy: 'owner', salesAgentId: 'agent', salesAgentName: 'Agente ficticio', agentKey: 'owner__agent' };
const range = { startDate: '2026-09-21', endDate: '2026-09-27', label: 'Semana ficticia', timezone: 'America/Mexico_City' };

/** In-memory read-only Firestore surface: no admin initialization or cloud/provider calls. */
async function reportFor(fixtures: Fixture[], options: Record<string, unknown> = {}) {
  const docs = fixtures.map((fixture, index) => ({
    id: `call-${index}`,
    data: () => ({ sourceCallId: `call-${index}`, uploadedBy: 'owner', salesAgentId: 'agent', latestFeedbackId: 'feedback',
      customerName: `Cliente ficticio ${index}`, bucketDay: range.startDate, overallScore: 50,
      lastCallSummary: fixture.summary ?? 'El cliente menciona seguimiento pendiente y volver a llamar.',
      weaknessTitles: fixture.weaknesses ?? ['Seguimiento pendiente'], nextBestAction: fixture.action ?? null,
      whatAgentShouldSayNext: fixture.legacyAction, followUpAction: fixture.legacyAction }),
  }));
  const collection = (path: string): FirebaseFirestore.CollectionReference => ({
    where: () => collection(path), limit: () => collection(path),
    get: async () => ({ docs: path === 'calls' ? docs.map((doc) => ({ id: doc.id, data: () => ({
      uploadedBy: 'owner', salesAgentId: 'agent', organizationId: 'consubanco', visibilityScope: 'organization',
      callSource: 'manual_upload', preparedUploadRequestId: 'prepared', audioStorageBucket: DEMO_BUCKET,
      status: 'complete', duration: 180, latestFeedbackId: 'feedback',
    }) })) : path.endsWith('/call_snapshots') ? docs : [] }),
    doc: (id: string) => ({
      collection: (name: string) => collection(`${path}/${id}/${name}`),
      get: async () => {
        if (!/^calls\/call-\d+\/feedback$/.test(path)) throw new Error(`Unexpected read: ${path}/${id}`);
        return { exists: true, data: () => fixtures[Number(path.split('/')[1].replace('call-', ''))].feedback ?? {} };
      },
    }),
  } as unknown as FirebaseFirestore.CollectionReference);
  const report = await buildAgentCoachingReport({ collection } as unknown as FirebaseFirestore.Firestore, profile, range,
    { previousAverageScore: 50, reportLength: 'extensive', ...options });
  expect(report).not.toBeNull();
  return report!;
}

describe('stored-action follow-up correctness', () => {
  test('generic closing requires authorization without inventing a follow-up day or time', async () => {
    const report = await reportFor([{ action: 'Cerrar el caso sin seguimiento.' }]);
    const closing = report.suggestedCallFlow.find(step => step.step === '5. Cierre')!;
    expect(closing.guidance).toContain('Confirmar autorización y siguiente paso');
    expect(closing.examplePhrase).toContain('Si autoriza un siguiente paso');
    expect(closing.examplePhrase).toContain('confirmemos la acción y las condiciones acordadas');
    expect(closing.examplePhrase).toContain('si prefiere no continuar, lo respetamos');
    expect(`${closing.guidance} ${closing.examplePhrase}`).not.toMatch(/mañana|después de las 10|\d/);
    expect(report.followUpOpportunities).toEqual([]);
  });

  test.each([
    'No volver a llamar; registrar la decisión.',
    'No enviar información adicional.',
    'Enviar la información por correo; no enviar ningún correo al cliente.',
    'No compartir documentos del cliente.',
    'No enviar información adicional; enviar la información mañana.',
    'Enviar la información mañana, pero no compartir documentos.',
    'No compartir datos; enviar la documentación por correo.',
    'Enviar la ficha informativa prometida y no programar seguimiento sin nueva solicitud del cliente.',
    'Cerrar el caso sin seguimiento.',
    'Respetar la solicitud de no recibir más ofertas comerciales y no generar seguimiento de venta.',
    'No contactar al cliente mañana.',
    'Evitar cualquier seguimiento comercial.',
    'Registrar que el cliente rechazó el seguimiento.',
    'El cliente declinó una nueva llamada.',
    'Cerrar el caso; no hay seguimiento pendiente.',
    'Archivar el expediente y registrar el cierre.',
    'Caso cerrado; llamar mañana.',
    'Contactar mañana; el cliente no desea seguimiento.',
    'No está interesado; retomar mañana.',
    'Registrar el rechazo sin insistir.',
    'El cliente está interesado y tiene documentos pendientes.',
    'Evaluar si conviene llamar mañana.',
    'Quizás contactar mañana.',
    'Contactar posiblemente mañana.',
    'Mejorar el cierre y la claridad del seguimiento.',
    'Llamar mañana; seguimiento rechazado.',
    'Retomar', 'Dar seguimiento.', 'Contactar cuando corresponda.', 'Contactar mañana?',
    'Retomar si aplica.', 'Contactar si procede.', 'Dar seguimiento según corresponda.',
    '', null, undefined,
  ])('excludes negative, ambiguous or missing next action: %s', async action => {
    const report = await reportFor([{ action }]);
    expect(report.followUpOpportunities).toEqual([]);
    expect(report.executiveSummary[1]).toContain('No se incluyen oportunidades');
    expect(report.actionPlan.join(' ')).not.toContain('Seguimiento (');
  });

  test.each([
    'Llamar mañana a las 10 para confirmar la cita acordada.',
    'Contactar al cliente el jueves por el canal acordado.',
    'Agendar una llamada para revisar los documentos solicitados.',
    'Enviar la información solicitada por el cliente por correo.',
    'Dar seguimiento al expediente el lunes por el canal acordado.',
  ])('retains explicit follow-up action: %s', async action => {
    const report = await reportFor([{ action }]);
    expect(report.followUpOpportunities).toEqual([expect.objectContaining({ callId: 'call-0', suggestedAction: action, reason: action })]);
    expect(report.executiveSummary[1]).toContain('1 oportunidades');
    expect(report.actionPlan).toContain(`Seguimiento (Cliente ficticio 0): ${action}`);
  });

  test.each([
    'Solo retomar si el cliente autoriza un nuevo contacto.',
    'Dejar la información de muestra y contactar al cliente solo cuando haya resultado de la validación pendiente.',
    'Contactar únicamente después de verificar la autorización del cliente.',
    'Si el cliente confirma su interés, llamar el jueves.',
    'Cuando se valide la documentación, contactar por el canal autorizado.',
    'Retomar solo si el cliente lo solicita; esperar su confirmación.',
  ])('preserves the complete prerequisite in agenda and action plan: %s', async action => {
    const report = await reportFor([{ action }]);
    expect(report.followUpOpportunities[0]?.suggestedAction).toBe(action);
    expect(report.actionPlan.filter(item => item.startsWith('Seguimiento ('))).toEqual([`Seguimiento (Cliente ficticio 0): ${action}`]);
    expect(report.actionPlan.join(' ')).not.toContain('Retomar primero');
  });

  test('uses exactly the same classified rows for a mixed report and its count/plan', async () => {
    const report = await reportFor([
      { action: 'No volver a llamar.' }, { action: 'Llamar mañana a las 10.' },
      { action: 'Retomar solo si el cliente confirma su interés.' }, { action: null },
      { action: 'Cerrar el caso.' }, { action: 'Evaluar si llamar después.' },
    ]);
    expect(report.followUpOpportunities.map(item => item.callId)).toEqual(['call-1', 'call-2']);
    expect(report.executiveSummary[1]).toContain('2 oportunidades');
    expect(report.actionPlan.filter(item => item.startsWith('Seguimiento ('))).toEqual(
      report.followUpOpportunities.map(item => `Seguimiento (${item.customerName}): ${item.suggestedAction}`));
  });

  test('keeps the count and plan consistent with the 12-row agenda limit', async () => {
    const report = await reportFor(Array.from({ length: 15 }, () => ({ action: 'Llamar mañana a las 10.' })));
    expect(report.followUpOpportunities).toHaveLength(12);
    expect(report.executiveSummary[1]).toContain('12 oportunidades');
    expect(report.actionPlan.filter(item => item.startsWith('Seguimiento ('))).toHaveLength(12);
  });

  test('does not recommend hidden follow-ups when the option is disabled', async () => {
    const report = await reportFor([{ action: 'Llamar mañana a las 10.' }], { includeFollowUpOpportunities: false });
    expect(report.followUpOpportunities).toEqual([]);
    expect(report.executiveSummary[1]).toContain('No se incluyen oportunidades');
    expect(report.actionPlan.join(' ')).not.toContain('Seguimiento (');
  });

  test('does not substitute legacy scripts for a missing explicit nextBestAction', async () => {
    const report = await reportFor([{ legacyAction: 'Llamar mañana a las 10.' }]);
    expect(report.selectedCalls[0].nextBestAction).toBeNull();
    expect(report.followUpOpportunities).toEqual([]);
  });
});

function scorecard(criteria: Record<string, unknown>[]) {
  return { rubric_scorecard_v2: { sections: [{ groups: [{ criteria }] }] } };
}

describe('priority-specific stored corrections', () => {
  test('uses criterion and critique tips without applying another priority correction', async () => {
    const report = await reportFor([{ feedback: { output: scorecard([
      { id: 'privacy', title: 'Privacidad', status: 'No cumple', criterion_improvement_tip: 'No solicitar contraseñas.' },
      { id: 'cost', title: 'Costo total', earned_points: 1, max_points: 5,
        bad_critiques: [{ weakness_improvement_tip: 'Explicar las comisiones con información verificada.' }] },
      { id: 'na', title: 'No aplicable', status: 'No aplica', earned_points: 0, max_points: 5, criterion_improvement_tip: 'No usar.' },
    ]) } }]);
    expect(report.coachingPriorities.map(item => [item.title, item.correctionSteps])).toEqual([
      ['Privacidad', ['No solicitar contraseñas.']],
      ['Costo total', ['Explicar las comisiones con información verificada.']],
    ]);
    expect(report.coachingPriorities[0].relatedRubricCriteria).toEqual(['privacy']);
  });

  test('matches legacy tips by criterion id or exact normalized title and rejects conflicting ids', async () => {
    const report = await reportFor([{ feedback: {
      ...scorecard([{ id: 'privacy', title: 'Privacidad', status: 'No cumple' },
        { id: 'clarity', title: 'Claridad', status: 'No cumple' }]),
      agent_weaknesses: [
        { criterion_id: 'privacy', title: 'Otro título', improvement_tip: 'Solicitar solo datos autorizados.' },
        { title: ' CLARIDAD ', weakness_improvement_tip: 'Explicar un concepto a la vez.' },
        { criterion_id: 'other', title: 'Privacidad', improvement_tip: 'Consejo ajeno.' },
        { title: 'Claridad de cierre', improvement_tip: 'Consejo no coincidente.' },
      ],
    } }]);
    expect(report.coachingPriorities.map(item => item.correctionSteps)).toEqual([
      ['Solicitar solo datos autorizados.'], ['Explicar un concepto a la vez.'],
    ]);
  });

  test('matches snapshot weakness titles to stored legacy corrections; others get neutral review', async () => {
    const report = await reportFor([{ weaknesses: ['Empatía', 'Privacidad'], feedback: { agent_weaknesses: [
      { title: 'EMPATIA', improvement_tip: 'Reconocer la preocupación expresada antes de responder.' },
      { title: 'Cierre', improvement_tip: 'Pedir una fecha de contacto.' },
    ] } }]);
    expect(report.coachingPriorities[0].correctionSteps).toEqual(['Reconocer la preocupación expresada antes de responder.']);
    const fallback = report.coachingPriorities[1];
    expect(fallback.correctionSteps[0]).toContain('Revisar la evidencia de «Privacidad» con el supervisor');
    expect(fallback.examplePhrases).toEqual([]);
    expect(fallback.phrasesToAvoid).toEqual([]);
    expect(JSON.stringify(fallback)).not.toMatch(/beneficio|le marco|fecha de seguimiento|Pedir una fecha/);
  });

  test('uses neutral review when the criterion contains only a diagnosis, not a correction', async () => {
    const report = await reportFor([{ feedback: scorecard([
      { title: 'Privacidad', earned: 0, max: 5, justification: 'Pidió una contraseña.' },
    ]) }]);
    expect(report.coachingPriorities[0].correctionSteps[0]).toContain('Revisar la evidencia');
    expect(report.coachingPriorities[0].correctionSteps).not.toContain('Pidió una contraseña.');
  });

  test('PDF fallback does not turn missing priority phrases into sales-advancement advice', async () => {
    const report = await reportFor([{ weaknesses: ['Privacidad'] }]);
    const text = jest.spyOn(PDFDocument.prototype, 'text');
    try {
      await renderAgentCoachingReportPdf(report);
      const rendered = text.mock.calls.map(call => call[0]).join(' ');
      expect(rendered).toContain('Sin frase específica registrada; revisar con el supervisor.');
      expect(rendered).not.toContain('Usar una frase de avance clara.');
      expect(rendered).not.toContain('le contacto mañana después de las 10');
    } finally {
      text.mockRestore();
    }
  });

  test('only the agent KPI value shrinks to fit its cell, with a readable minimum', async () => {
    const report = await reportFor([{ weaknesses: [] }]);
    report.agent.salesAgentName = 'AGENTE-8E49DD1C0667';
    const text = jest.spyOn(PDFDocument.prototype, 'text');
    const fontSize = jest.spyOn(PDFDocument.prototype, 'fontSize');
    try {
      await renderAgentCoachingReportPdf(report);
      const valueCalls = text.mock.calls.map((args, index) => ({ args, index }))
        .filter(({ args }) => args[2] === 115 && (args[3] as PDFKit.Mixins.TextOptions | undefined)?.width === 728 / 6 - 20);
      const sizes = valueCalls.map(({ index }) => {
        const preceding = fontSize.mock.invocationCallOrder.filter(order => order < text.mock.invocationCallOrder[index]).length;
        return Number(fontSize.mock.calls[preceding - 1][0]);
      });
      expect(valueCalls).toHaveLength(6);
      expect(valueCalls[0].args[0]).toBe(report.agent.salesAgentName);
      expect(sizes[0]).toBeGreaterThanOrEqual(8);
      expect(sizes[0]).toBeLessThan(10);
      expect(sizes.slice(1)).toEqual([10, 14, 14, 14, 14]);
      const measure = new PDFDocument({ autoFirstPage: false });
      measure.font('Helvetica-Bold').fontSize(sizes[0]);
      expect(measure.widthOfString(report.agent.salesAgentName)).toBeLessThanOrEqual(728 / 6 - 20 + 0.001);
      measure.end();
    } finally {
      text.mockRestore();
      fontSize.mockRestore();
    }
  });

  test('deduplicates corrections across calls and does not invent a sales priority with missing evidence', async () => {
    const fixture = { feedback: scorecard([{ title: 'Claridad', earned: 0, max: 5, improvementTip: 'Usar frases cortas.' }]) };
    const report = await reportFor([fixture, fixture]);
    expect(report.coachingPriorities).toHaveLength(1);
    expect(report.coachingPriorities[0].correctionSteps).toEqual(['Usar frases cortas.']);
    const missing = await reportFor([{ weaknesses: [] }]);
    expect(missing.coachingPriorities[0].title).toBe('Revisar la evidencia disponible');
    expect(missing.coachingPriorities[0].correctionSteps[0]).toContain('con el supervisor');
  });
});
