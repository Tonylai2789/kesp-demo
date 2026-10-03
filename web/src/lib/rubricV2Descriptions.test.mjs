import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RUBRIC_REFERENCE_AVAILABLE, SECTION_DESCRIPTIONS, GROUP_DESCRIPTIONS,
  CRITERION_DESCRIPTIONS, SECTION_SUBAGENT, buildCriterionPath } from './rubricV2Descriptions.ts';

test('public frontend contains no static rubric policy and retains safe ID navigation', () => {
  assert.equal(RUBRIC_REFERENCE_AVAILABLE, false);
  for (const metadata of [SECTION_DESCRIPTIONS, GROUP_DESCRIPTIONS, CRITERION_DESCRIPTIONS]) {
    assert.deepEqual(metadata, {});
  }
  assert.equal(buildCriterionPath('Z', 'Z9.7'), 'Z > Z9 > Z9.7');
  assert.equal(SECTION_SUBAGENT.A, 'rubric_analysis_A');
});

test('reference panels expose unavailable state without replacing feedback scores', () => {
  for (const name of ['ScorecardPage', 'CriterionDetailPage']) {
    const source = readFileSync(new URL('../pages/' + name + '.tsx', import.meta.url), 'utf8');
    assert.match(source, /!RUBRIC_REFERENCE_AVAILABLE/);
    assert.match(source, /scorecard.referenceUnavailable/);
    assert.match(source, /criterion\.earned_points/);
  }
  for (const language of ['en', 'es']) {
    const messages = JSON.parse(readFileSync(new URL('../i18n/' + language + '.json', import.meta.url), 'utf8'));
    assert.equal(messages.scorecard.referenceUnavailable, language === 'en'
      ? 'Reference policy unavailable' : 'Política de referencia no disponible');
    const help = messages.kesp.conversationMetrics.help;
    for (const key of ['fastExample', 'boundaryExample', 'shortExample', 'exclusions']) {
      assert.doesNotMatch(help[key], /\d/);
    }
    assert.doesNotMatch(help.metrics.fastSegmentCount, /\d/);
    assert.match(help.boundaryExample, language === 'en' ? /unavailable/ : /no están disponibles/);
    assert.match(help.shortExample, language === 'en' ? /unavailable/ : /no están disponibles/);
    assert.match(help.exclusions, language === 'en' ? /actual deduction/ : /deducción real/);
  }
});
