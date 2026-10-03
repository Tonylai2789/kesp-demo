import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL('./ConversationMetricsPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const resources = Object.fromEntries(['en', 'es'].map(/** Uses the actual shipped translations. */ (language) => [
  language, { translation: JSON.parse(readFileSync(new URL(`../../i18n/${language}.json`, import.meta.url), 'utf8')) },
]));

/** Builds a historical response without any additive timing fields. */
function historicalReport() {
  return {
    schemaVersion: '1', method: 'timestamp_wpm_v1', status: 'available',
    coverage: { inputWordCount: 12, validatedWordCount: 12, excludedWordCount: 0, unknownRoleWordCount: 0 },
    availability: Object.fromEntries(['speed', 'talkBalance', 'turns', 'gaps', 'interruptions', 'fillers'].map(
      /** Keeps baseline measurements available. */ (key) => [key, { available: true, reason: null }])),
    summary: { fastSegmentCount: 0, fastestWpm: 120, agentSpeechSeconds: 6 },
    segments: [{ id: 'segment_0', speaker: 'agent', role: 'agent', start: 0, end: 6,
      text: 'Original evidence remains unchanged', wordCount: 12, wpm: 120,
      speedEligible: true, tooFast: false, exclusionReason: null }],
    interruptions: [], gaps: [], fillers: [], evidenceTruncated: true,
  };
}

/** Builds a complete saved Gemini review response for display tests. */
function completeGeminiReview() {
  return {
    enabled: true,
    privacyApproved: true,
    review: {
      status: 'complete',
      model: 'gemini-3.1-pro-preview',
      attempts: 1,
      observations: [{
        category: 'important_explanations',
        text: 'El agente explicó el pago mensual con claridad.',
        coaching: 'Mantener el mismo ritmo al explicar montos.',
        evidenceIds: ['gemini_e1'],
        uncertain: false,
      }],
      evidence: [{ id: 'gemini_e1', start: 5, end: 9, role: 'agent', text: 'Pago mensual de ejemplo' }],
    },
  };
}

/** Builds a Gemini turn-taking review that references a separate evidence namespace. */
function turnTakingGeminiReview() {
  return {
    enabled: true,
    privacyApproved: true,
    review: {
      status: 'complete',
      model: 'gemini-3.1-pro-preview',
      attempts: 1,
      observations: [{
        category: 'turn_taking',
        text: 'El agente interrumpió durante la explicación del cliente.',
        coaching: 'Esperar a que el cliente termine antes de responder.',
        evidenceIds: ['gemini_turn_1'],
        uncertain: false,
      }],
      evidence: [{ id: 'gemini_turn_1', start: 4.8, end: 6.2, role: 'agent', text: 'Evidencia Gemini independiente' }],
    },
  };
}

/** Renders the actual component while replacing only hooks, Firebase and app-context boundaries. */
function render(report, language = 'en', { loading = false, error = false, adjustment, geminiResponse = null,
  geminiLoading = false, geminiError = null, geminiRequesting = false, geminiPollReads = 0,
  geminiReviewAvailable = true, canRequestGeminiReview = false, metricsObservations = [], effectsEnabled = false,
  interpretationStatus = 'complete', observations = metricsObservations, evidenceButtons = [],
  onPlayEvidence = /** Default rendering does not request playback. */ () => {} } = {}) {
  const instance = i18next.createInstance();
  instance.init({ lng: language, resources, initImmediate: false, interpolation: { escapeValue: false } });
  const states = [
    { metrics: report, interpretationStatus, observations, speedAdjustment: adjustment },
    geminiResponse,
    loading,
    geminiLoading,
    error,
    geminiError,
    geminiRequesting,
    0,
    0,
    geminiPollReads,
  ];
  let index = 0;
  const effects = [];
  const timers = new Map();
  const buttons = [];
  const serviceCalls = { getGeminiAudioReview: 0, requestGeminiAudioReview: 0 };
  const jsxRuntime = require('react/jsx-runtime');
  /** Captures actual UI callbacks without contacting a browser. */
  function captureElement(factory, type, props, key) {
    if (type === 'button') buttons.push(props);
    if (type === 'button' && props.className === 'cm-play' && props.onClick) {
      evidenceButtons.push({ label: props['aria-label'], click: props.onClick, disabled: props.disabled });
    }
    return factory(type, props, key);
  }
  const modules = {
    react: { ...React, useEffect: /** Defers effects until the test explicitly mounts them. */ (effect) => effects.push(effect),
      useState: /** Supplies loaded state in the component's hook order. */ () => [states[index++], () => {}] },
    'react/jsx-runtime': { ...jsxRuntime,
      jsx: /** Captures single-child controls. */ (...args) => captureElement(jsxRuntime.jsx, ...args),
      jsxs: /** Captures multiple-child controls. */ (...args) => captureElement(jsxRuntime.jsxs, ...args) },
    'lucide-react': { Play: /** Icons do not affect coverage copy. */ () => null,
      RefreshCw: /** Icons do not affect coverage copy. */ () => null,
      Wand2: /** Icons do not affect action copy. */ () => null },
    'react-i18next': { useTranslation: /** Uses real locale interpolation. */ () => ({ t: instance.t.bind(instance), i18n: instance }) },
    '@/lib/kespI18n': { getKespLocale: /** Keeps deterministic numeric formatting. */ () => language },
    '@/lib/kespDemoRedaction': { maskKespDemoTranscriptText: /** Redaction is disabled in this fixture. */ () => 'redacted' },
    '@/hooks/useKespDemoRedactionEnabled': { useKespDemoRedactionEnabled: /** Retains synthetic evidence. */ () => false },
    '@/services/functions': {
      getConversationMetrics: /** Replaces the read callable only in explicit effect tests. */ () => {
        if (!effectsEnabled) throw Error('Unexpected metrics callable');
        return Promise.resolve(states[0]);
      },
      getGeminiAudioReview: /** Records read effects without contacting Firebase. */ () => {
        serviceCalls.getGeminiAudioReview += 1;
        if (!effectsEnabled) throw Error('Unexpected Gemini read');
        return geminiError ? Promise.reject(Error('Synthetic read failure')) : Promise.resolve(geminiResponse);
      },
      requestGeminiAudioReview: /** Tracks accidental generation effects in render-only tests. */ () => { serviceCalls.requestGeminiAudioReview += 1; throw Error('Unexpected Gemini request'); },
    },
    './ConversationMetricsPanel.css': {},
    './ConversationMetricsHelp': { ConversationMetricsHelp: /** Help content has its own rendering tests. */ () =>
      React.createElement('button', { 'aria-label': instance.t('kesp.conversationMetrics.help.open') }, 'info') },
  };
  const exports = {};
  runInNewContext(source, { exports, Intl, window: {
    setTimeout: /** Captures pending-review polls without wall-clock waits. */ (callback, delay) => {
      assert.equal(delay, 30000);
      timers.set(callback, callback);
      return callback;
    },
    clearTimeout: /** Allows effect cleanup to cancel polls. */ (id) => timers.delete(id),
  }, require: /** Resolves only controlled dependencies. */ (name) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const html = renderToStaticMarkup(React.createElement(exports.ConversationMetricsPanel, {
    callId: 'synthetic-call', audioAvailable: true, geminiReviewAvailable, canRequestGeminiReview, onPlayEvidence,
  }));
  /** Executes actual component effects and settles their mocked read promises. */
  async function runEffects() {
    assert.ok(effectsEnabled);
    const cleanups = effects.map(/** Runs mount or refreshed read effects. */ (effect) => effect());
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return /** Runs the same cleanup callbacks React invokes on unmount. */ () => {
      for (const cleanup of cleanups) cleanup?.();
    };
  }
  return { html, serviceCalls, runEffects, timers, buttons };
}

for (const language of ['en', 'es']) {
  test(`historical ${language} reports keep live coverage while moving explanations to help`, /** Protects additive compatibility. */ () => {
    const html = render(historicalReport(), language).html;
    const labels = resources[language].translation.kesp.conversationMetrics;
    assert.ok(!html.includes(labels.truncated));
    assert.ok(!html.includes(labels.limitations));
    assert.ok(!html.includes(labels.speedRule));
    assert.ok(html.includes(labels.help.status.available));
    assert.ok(html.includes(labels.help.open));
    assert.ok(html.includes(labels.coverage.replace('{{validated}}', '12').replace('{{total}}', '12')
      .replace('{{excluded}}', '0').replace('{{unknown}}', '0')));
    assert.ok(!html.includes(labels.retainedSummary));
    assert.ok(html.includes('Original evidence remains unchanged'));
  });

  test(`partial ${language} timing reports distinguish individual words from analyzed segments`, /** Keeps excluded evidence without full-call claims. */ () => {
    const report = historicalReport();
    report.calculationVersion = 'segment_timing_v2';
    report.status = 'partial';
    Object.assign(report.coverage, { validatedWordCount: 11, excludedWordCount: 1,
      totalSegmentCount: 4, excludedSegmentCount: 2, analyzedWordCount: 5 });
    Object.assign(report.segments[0], { timingExcluded: true, exclusionReason: 'zero_duration_word', wpm: null,
      speedEligible: false, tooFast: null });
    const html = render(report, language).html;
    const labels = resources[language].translation.kesp.conversationMetrics;
    assert.ok(!html.includes(labels.truncatedRetained));
    assert.ok(html.includes(labels.help.status.partial));
    assert.ok(!html.includes(labels.truncated));
    assert.ok(html.includes(labels.retainedSummary));
    assert.ok(html.includes(labels.segmentCoverage.replace('{{excluded}}', '2').replace('{{total}}', '4').replace('{{analyzed}}', '5')));
    assert.ok(html.includes(labels.wordTimingCoverage.replace('{{validated}}', '11').replace('{{total}}', '12')
      .replace('{{excluded}}', '1').replace('{{unknown}}', '0')));
    assert.ok(html.includes(labels.exclusions.zero_duration_word));
    assert.ok(html.includes(labels.noRetainedCandidates));
    assert.ok(html.includes('Original evidence remains unchanged'));
  });
}

for (const excludedSegmentCount of [0, undefined]) {
  test(`word exclusions respect segment coverage ${excludedSegmentCount}`, /** Deduplicated tokens do not imply excluded segments when an explicit zero is supplied. */ () => {
    const report = historicalReport();
    report.calculationVersion = 'segment_timing_v2';
    Object.assign(report.coverage, { excludedWordCount: 1, validatedWordCount: 11, excludedSegmentCount });
    const html = render(report).html;
    const labels = resources.en.translation.kesp.conversationMetrics;
    const fallback = excludedSegmentCount === undefined;
    assert.equal(html.includes(labels.retainedSummary), fallback);
    assert.ok(!html.includes(labels.truncatedRetained));
    assert.equal(html.includes(labels.noRetainedCandidates), fallback);
    assert.ok(!html.includes(labels.truncated));
    assert.equal(html.includes(labels.noCandidates), !fallback);
  });
}

for (const language of ['en', 'es']) {
  for (const state of [{ loading: true }, { error: true }, {}]) {
    test(`help stays accessible without metrics in ${language}: ${JSON.stringify(state)}`, /** Does not hide help with unavailable calls. */ () => {
      const html = render(null, language, state).html;
      const labels = resources[language].translation.kesp.conversationMetrics;
      assert.ok(html.includes(labels.help.open));
      if (state.loading) assert.ok(html.includes(labels.loading));
      if (state.error) assert.ok(html.includes(labels.error));
    });
  }
}

test('stored scoring audit and current word coverage remain visible', /** Keeps scoring transparency outside the guide. */ () => {
  const report = historicalReport();
  Object.assign(report.coverage, { inputWordCount: 382, validatedWordCount: 381, excludedWordCount: 1 });
  const html = render(report, 'en', { adjustment: { baseCredit: 1, deduction: 0, finalCredit: 1, reason: 'unavailable' } }).html;
  assert.ok(html.includes('Word coverage: 381 of 382 validated; 1 excluded; 0 with unknown speaker role.'));
  assert.ok(html.includes('Stored A2.2 credit: 1 base; 0 deduction applied once; 1 final.'));
  assert.ok(html.includes(resources.en.translation.kesp.conversationMetrics.adjustmentReason.unavailable));
});

test('all timing-excluded segments retain evidence and do not render measured zeros or speed passes', /** Treats zero coverage as meaningful, not absent. */ () => {
  const report = historicalReport();
  report.calculationVersion = 'segment_timing_v2';
  report.status = 'unavailable';
  Object.assign(report.coverage, { totalSegmentCount: 1, excludedSegmentCount: 1, analyzedWordCount: 0 });
  Object.assign(report.segments[0], { timingExcluded: true, exclusionReason: 'zero_duration_word', wpm: 900, tooFast: true });
  for (const feature of Object.values(report.availability)) feature.available = false;
  report.fillers = [{ id: 'filler_0', start: 0, end: 0, text: 'Retained zero-duration evidence' }];
  const html = render(report).html;
  const labels = resources.en.translation.kesp.conversationMetrics;
  assert.ok(html.includes('1 of 1 segments excluded; 0 words in analyzed segments.'));
  assert.ok(html.includes('Original evidence remains unchanged'));
  assert.ok(html.includes('Retained zero-duration evidence'));
  assert.ok(!html.includes('900'));
  assert.ok(!html.includes('cm-fast'));
  assert.ok(!html.includes(labels.noCandidates));
  assert.ok(!html.includes(labels.noSegments));
  assert.ok(!html.includes(labels.eligible));
  assert.ok(!html.includes('<dd>0</dd>'));
});

test('missing optional totals are unavailable, not guessed from truncated rows', /** Supports partially populated additive reports. */ () => {
  const report = historicalReport();
  report.segments[0].timingExcluded = true;
  report.coverage.analyzedWordCount = 0;
  const html = render(report).html;
  assert.ok(html.includes('0 words in analyzed segments.'));
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('NaN'));
  assert.ok(html.includes(resources.en.translation.kesp.conversationMetrics.timingExcluded));
  assert.ok(!html.includes(resources.en.translation.kesp.conversationMetrics.truncated));
});

test('empty bounded views do not imply there was no evidence', /** Distinguishes omitted rows from absent measurements. */ () => {
  const report = historicalReport();
  report.calculationVersion = 'segment_timing_v2';
  report.segments = [];
  report.evidenceTotals = { segments: 4, interruptions: 3, gaps: 2, fillers: 1, words: 12 };
  const html = render(report).html;
  assert.ok(html.includes(resources.en.translation.kesp.conversationMetrics.noSegmentsShown));
  assert.ok(html.includes(resources.en.translation.kesp.conversationMetrics.noEventsShown));
  assert.ok(!html.includes(resources.en.translation.kesp.conversationMetrics.noCandidates));
});


for (const language of ['en', 'es']) {
  test(`OpenAI segment estimates in ${language} distinguish pauses, coverage and unavailable interruptions`, /** Protects honest timing semantics without simulated word timing. */ () => {
    const report = historicalReport();
    report.timingSource = 'segment';
    report.calculationVersion = 'openai_segment_timing_v1';
    report.status = 'partial';
    Object.assign(report.coverage, { inputWordCount: 0, validatedWordCount: 0, excludedWordCount: 0,
      totalSegmentCount: 4, excludedSegmentCount: 1, analyzedWordCount: 37 });
    report.availability.interruptions = { available: false, reason: 'word_timestamps_required' };
    Object.assign(report.summary, { customerSpeechSeconds: 4, agentTalkPercent: 60,
      overlapSeconds: null, interruptionCandidateCount: null });
    const html = render(report, language, { interpretationStatus: 'not_requested',
      observations: [{ text: 'Stale model observation must not display', evidenceIds: [] }],
      adjustment: { baseCredit: 1, deduction: 0.1, finalCredit: 0.9, reason: 'adjusted' } }).html;
    const labels = resources[language].translation.kesp.conversationMetrics;
    assert.ok(html.includes(labels.timingSource.segment));
    assert.ok(!html.includes(labels.timingSource.word));
    assert.ok(html.includes(labels.providerSegmentCoverage.replace('{{excluded}}', '1').replace('{{total}}', '4').replace('{{analyzed}}', '37')));
    assert.ok(html.includes(labels.segmentSummary.agentSpeechSeconds));
    assert.ok(html.includes(labels.segmentSummary.agentTalkPercent));
    assert.ok(html.includes(labels.segmentInterruptionsUnavailable));
    assert.ok(html.includes(labels.retainedSummary));
    assert.ok(html.includes(labels.deterministicOnly));
    assert.ok(html.includes(labels.adjustmentReason.adjusted));
    for (const key of ['observations', 'noObservations', 'pendingInterpretation', 'failedInterpretation']) assert.ok(!html.includes(labels[key]));
    assert.ok(!html.includes('Stale model observation must not display'));
    assert.ok(!html.includes(labels.coverage.split('{{')[0]));
    assert.ok(!html.includes(labels.wordTimingCoverage.split('{{')[0]));
    assert.ok(!html.includes('undefined'));
    assert.ok(!html.includes('NaN'));
  });

  test(`segment lexical evidence in ${language} selects the full original interval for transcript playback`, /** Ensures exact word boundaries are never synthesized by the panel. */ () => {
    const report = historicalReport();
    report.timingSource = 'segment';
    const filler = { id: 'filler_1', start: 26.4, end: 42.1,
      text: 'Pues una evidencia original del segmento completo',
      kind: 'lexical_filler_candidate', role: 'agent', evidenceIds: ['provider_segment_2'] };
    report.fillers = [filler];
    const evidenceButtons = [];
    const played = [];
    const html = render(report, language, { interpretationStatus: 'not_requested', evidenceButtons,
      onPlayEvidence: /** Records exactly what the panel sends to the existing player. */ (event) => played.push(event) }).html;
    const labels = resources[language].translation.kesp.conversationMetrics;
    assert.ok(html.includes(labels.segmentLexicalEvidence));
    const fullSegment = evidenceButtons.find(/** Finds the lexical evidence action rather than speed-segment actions. */ (button) =>
      button.label === labels.playSegmentEvidence.replace('{{time}}', '0:26'));
    assert.ok(fullSegment);
    assert.equal(fullSegment.disabled, false);
    fullSegment.click();
    assert.deepEqual(played, [filler]);
    assert.equal(played[0].start, 26.4);
    assert.equal(played[0].end, 42.1);
  });
}

test('segment calculation version enables honest labels when additive timingSource is absent', /** Supports backend additive-field compatibility. */ () => {
  const report = historicalReport();
  report.calculationVersion = 'openai_segment_timing_v1';
  const html = render(report, 'en', { interpretationStatus: 'not_requested' }).html;
  assert.ok(html.includes(resources.en.translation.kesp.conversationMetrics.timingSource.segment));
  assert.ok(!html.includes('undefined'));
});


for (const language of ['en', 'es']) {
  test(`cache-source fallback in ${language} localizes the limitation without hiding supported gaps`, /** Keeps preserved feedback distinct from a fresh speed audit. */ () => {
    const report = historicalReport();
    report.timingSource = 'segment';
    report.status = 'partial';
    report.limitations = [
      'Cached source lacks authoritative speaker-role and unadjusted score evidence; cached feedback is preserved and no new speed deduction is applied.',
      'Arbitrary backend diagnostic must stay hidden',
    ];
    report.availability.speed = { available: false, reason: 'no_known_agent' };
    report.summary.medianResponseGapSeconds = 1.5;
    report.gaps = [{ id: 'gap_1', start: 6, end: 7.5, seconds: 1.5, text: 'Synthetic retained gap' }];
    report.segments[0].role = 'unknown';
    const html = render(report, language, { interpretationStatus: 'not_requested' }).html;
    const labels = resources[language].translation.kesp.conversationMetrics;
    assert.ok(html.includes(labels.cachedSourceUnavailable));
    assert.ok(html.includes('Synthetic retained gap'));
    assert.ok(html.includes(labels.noAdjustment));
    assert.ok(html.includes(labels.deterministicOnly));
    for (const diagnostic of report.limitations) assert.ok(!html.includes(diagnostic));
    const unrelated = render({ ...report, limitations: ['Arbitrary backend diagnostic must stay hidden'] }, language).html;
    assert.ok(!unrelated.includes(labels.cachedSourceUnavailable));
    assert.ok(!unrelated.includes('Arbitrary backend diagnostic must stay hidden'));
  });
}
test('admin can see explicit Analyze audio action without auto-requesting Gemini', /** Viewing the panel must not invoke paid review generation. */ () => {
  const { html, serviceCalls } = render(historicalReport(), 'en', {
    geminiResponse: { enabled: true, privacyApproved: true, review: null },
    canRequestGeminiReview: true,
  });
  assert.ok(html.includes(resources.en.translation.kesp.conversationMetrics.gemini.analyze));
  assert.equal(serviceCalls.getGeminiAudioReview, 0);
  assert.equal(serviceCalls.requestGeminiAudioReview, 0);
});

test('supervisor can view saved Gemini review but not mutation controls', /** Supervisors receive read-only review content. */ () => {
  const { html } = render(historicalReport(), 'en', {
    geminiResponse: completeGeminiReview(),
    canRequestGeminiReview: false,
  });
  const labels = resources.en.translation.kesp.conversationMetrics.gemini;
  assert.ok(html.includes(labels.title));
  assert.ok(html.includes('gemini-3.1-pro-preview'));
  assert.ok(html.includes('El agente explicó el pago mensual con claridad.'));
  assert.ok(html.includes('Mantener el mismo ritmo al explicar montos.'));
  assert.ok(html.includes('View transcript evidence at 0:05'));
  assert.ok(!html.includes(labels.regenerate));
  assert.ok(!html.includes(labels.analyze));
});

test('disabled and privacy states block frontend generation controls', /** Setup and privacy gates are surfaced before any admin action. */ () => {
  const labels = resources.en.translation.kesp.conversationMetrics.gemini;
  const disabled = render(historicalReport(), 'en', {
    geminiResponse: { enabled: false, privacyApproved: false, review: null },
    canRequestGeminiReview: true,
  }).html;
  const privacy = render(historicalReport(), 'en', {
    geminiResponse: { enabled: true, privacyApproved: false, review: null },
    canRequestGeminiReview: true,
  }).html;
  assert.ok(disabled.includes(labels.disabled));
  assert.ok(privacy.includes(labels.privacy));
  assert.ok(!disabled.includes(labels.analyze));
  assert.ok(!privacy.includes(labels.analyze));
});

test('completed admin review shows regeneration copy and keeps deterministic metrics visible', /** Qualitative review does not replace timing evidence. */ () => {
  const { html } = render(historicalReport(), 'en', {
    geminiResponse: completeGeminiReview(),
    canRequestGeminiReview: true,
  });
  const labels = resources.en.translation.kesp.conversationMetrics.gemini;
  assert.ok(html.includes(labels.regenerate));
  assert.ok(resources.en.translation.kesp.conversationMetrics.gemini.generateConfirm.includes('paid model request'));
  assert.ok(resources.en.translation.kesp.conversationMetrics.gemini.regenerateConfirm.includes('paid model request'));
  assert.ok(html.includes('Original evidence remains unchanged'));
});

test('production-gated calls do not render or read Gemini review state', /** Reused production code must not touch Gemini review callables. */ () => {
  const { html, serviceCalls } = render(historicalReport(), 'en', {
    geminiReviewAvailable: false,
    geminiResponse: { enabled: true, privacyApproved: true, review: null },
    canRequestGeminiReview: true,
  });
  assert.ok(!html.includes(resources.en.translation.kesp.conversationMetrics.gemini.title));
  assert.equal(serviceCalls.getGeminiAudioReview, 0);
  assert.equal(serviceCalls.requestGeminiAudioReview, 0);
});

test('terminal failed review retries through the regeneration affordance', /** Failed or unavailable prior attempts are paid re-execution paths. */ () => {
  const { html } = render(historicalReport(), 'en', {
    geminiResponse: {
      enabled: true,
      privacyApproved: true,
      review: { status: 'failed', reason: 'worker_failed', model: 'gemini-3.1-pro-preview', observations: [], evidence: [], attempts: 1 },
    },
    canRequestGeminiReview: true,
  });
  const labels = resources.en.translation.kesp.conversationMetrics.gemini;
  assert.ok(html.includes(labels.retry));
  assert.ok(!html.includes(labels.analyze));
});

test('legacy interruption interpretation is suppressed only by overlapping Gemini turn-taking review', /** Avoids broad ID-based or WPM observation deduplication. */ () => {
  const report = historicalReport();
  report.interruptions = [{ id: 'legacy_interruption_1', start: 5, end: 6, text: 'Legacy overlap candidate', category: 'possible_interruption', role: 'agent' }];
  const html = render(report, 'en', {
    geminiResponse: turnTakingGeminiReview(),
    metricsObservations: [
      { category: 'interruption_candidate', text: 'Legacy interruption interpretation should be hidden', evidenceIds: ['legacy_interruption_1'] },
      { category: 'speed', text: 'Legacy WPM interpretation should remain visible', evidenceIds: ['segment_0'] },
    ],
  }).html;
  assert.ok(!html.includes('Legacy interruption interpretation should be hidden'));
  assert.ok(html.includes('Legacy WPM interpretation should remain visible'));
  assert.ok(html.includes('Legacy overlap candidate'));
});

test('frontend request source sends authCostConfirmed after confirmation', /** Keeps the client request aligned with backend paid-work rejection rules. */ () => {
  assert.ok(source.includes('authCostConfirmed: true'));
  assert.ok(source.includes('requestId'));
  assert.ok(source.includes('crypto.randomUUID()'));
  assert.ok(readFileSync(new URL('../../services/functions.ts', import.meta.url), 'utf8').includes('authCostConfirmed: boolean'));
  assert.ok(readFileSync(new URL('../../services/functions.ts', import.meta.url), 'utf8').includes('requestId: string'));
});

test('pending Gemini polling has a bounded stop message', /** Pending reads are bounded and do not imply failure. */ () => {
  const { html } = render(historicalReport(), 'en', {
    geminiResponse: { enabled: true, privacyApproved: true, review: { status: 'running', model: 'gemini-3.1-pro-preview', observations: [], evidence: [], attempts: 2 } },
    geminiPollReads: 18,
    canRequestGeminiReview: true,
  });
  const labels = resources.en.translation.kesp.conversationMetrics.gemini;
  assert.ok(html.includes(labels.status.running));
  assert.ok(html.includes(labels.pollEnded));
});

test('Gemini chrome is localized while generated review text remains Spanish', /** UI labels translate, stored model output is not rewritten. */ () => {
  const { html } = render(historicalReport(), 'es', { geminiResponse: completeGeminiReview() });
  const labels = resources.es.translation.kesp.conversationMetrics.gemini;
  assert.ok(html.includes(labels.title));
  assert.ok(html.includes(labels.category.important_explanations));
  assert.ok(html.includes('El agente explicó el pago mensual con claridad.'));
});

for (const language of ['en', 'es']) {
  for (const state of [
    { geminiLoading: true },
    { geminiError: 'Synthetic read failure' },
    { geminiResponse: { enabled: false, privacyApproved: false, review: null } },
    { geminiResponse: { enabled: true, privacyApproved: false, review: null } },
    { geminiResponse: { enabled: true, privacyApproved: true, review: null } },
  ]) {
    test(`Gemini heading survives unavailable metrics and gate/read states in ${language}: ${JSON.stringify(state)}`,
      /** Disabled enrollment and missing metrics must not silently hide the section. */ () => {
        const { html } = render(null, language, state);
        const labels = resources[language].translation.kesp.conversationMetrics.gemini;
        assert.ok(html.includes(labels.title));
        assert.ok(!html.includes(labels.analyze));
        if (state.geminiLoading) assert.ok(html.includes(labels.loading));
        if (state.geminiError) assert.ok(html.includes(state.geminiError));
        if (state.geminiResponse?.privacyApproved) assert.ok(html.includes(labels.adminOnly));
      });
  }
}

for (const status of ['queued', 'running', 'complete', 'failed', 'unavailable']) {
  test(`saved ${status} review mount, refresh and pending polling never generate inference`,
    /** Executes real effects and refresh callbacks against mocked services, not just SSR. */ async () => {
      const response = completeGeminiReview();
      response.review.status = status;
      const fixture = render(historicalReport(), 'en', {
        geminiResponse: response, canRequestGeminiReview: true, effectsEnabled: true,
      });
      const cleanup = await fixture.runEffects();
      assert.equal(fixture.serviceCalls.getGeminiAudioReview, 1);
      assert.equal(fixture.serviceCalls.requestGeminiAudioReview, 0);
      const pending = status === 'queued' || status === 'running';
      assert.equal(fixture.timers.size, pending ? 1 : 0);
      if (pending) {
        assert.ok(!fixture.html.includes(resources.en.translation.kesp.conversationMetrics.gemini.regenerate));
        for (const poll of fixture.timers.values()) poll();
      }
      const refresh = fixture.buttons.find(/** Selects the real saved-state refresh control. */
        (button) => button['aria-label'] === resources.en.translation.kesp.conversationMetrics.gemini.refresh);
      assert.ok(refresh);
      refresh.onClick();
      cleanup();
      const cleanupRefresh = await fixture.runEffects();
      assert.equal(fixture.serviceCalls.getGeminiAudioReview, 2);
      assert.equal(fixture.serviceCalls.requestGeminiAudioReview, 0);
      cleanupRefresh();
      assert.equal(fixture.timers.size, 0);
    });
}

test('disabled, unreadable and missing saved reviews perform reads only; non-TEST skips the read',
  /** Neither a missing review nor a failed read may trigger generation as a fallback. */ async () => {
    for (const options of [
      { geminiResponse: { enabled: false, privacyApproved: false, review: null } },
      { geminiResponse: { enabled: true, privacyApproved: false, review: null } },
      { geminiResponse: { enabled: true, privacyApproved: true, review: null } },
      { geminiError: 'Synthetic read failure' },
      { geminiReviewAvailable: false },
    ]) {
      const fixture = render(null, 'en', { ...options, canRequestGeminiReview: true, effectsEnabled: true });
      const cleanup = await fixture.runEffects();
      assert.equal(fixture.serviceCalls.getGeminiAudioReview, options.geminiReviewAvailable === false ? 0 : 1);
      assert.equal(fixture.serviceCalls.requestGeminiAudioReview, 0);
      cleanup();
    }
  });

test('pending read polling stops at the configured bound without inference',
  /** Exhausting the read budget must not initiate a retry or regeneration. */ async () => {
    const response = completeGeminiReview();
    response.review.status = 'running';
    const fixture = render(null, 'en', { geminiResponse: response, geminiPollReads: 18, effectsEnabled: true });
    const cleanup = await fixture.runEffects();
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.serviceCalls.requestGeminiAudioReview, 0);
    cleanup();
  });
