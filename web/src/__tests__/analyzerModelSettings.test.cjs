const { ANALYZER_TASK_IDS, analyzerModelSettings, validateAnalyzerModelOverrides } = require('../lib/analyzerModelSettings');
const { KESP_UPLOAD_PROMPT_SETTINGS_KEY, loadKespUploadPromptSettings, saveKespUploadPromptSettings, validateKespUploadPromptSettings } = require('../lib/kespUploadPromptSettings');

const catalog = {
  analyzerModels: { default: 'gpt-5.4', available: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-5.1', 'gpt-5.4', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra'] },
  defaults: { coaching: '1' }, availableVersions: { coaching: ['1', '2'] },
  agentAnalysisDefaults: { behavior_pattern_detector: '1' }, agentAnalysisVersions: { behavior_pattern_detector: ['1', '2'] },
  activityDefaults: { call_activity_extractor: '1' }, activityVersions: { call_activity_extractor: ['1', '2'] },
};

beforeEach(/** Creates isolated browser storage without Firebase or paid calls. */ () => {
  const values = new Map();
  global.window = { localStorage: {
    getItem: jest.fn(/** Reads a saved browser preference. */ (key) => values.get(key) ?? null),
    setItem: jest.fn(/** Stores a browser preference. */ (key, value) => values.set(key, value)),
    removeItem: jest.fn(/** Clears a browser preference. */ (key) => values.delete(key)),
  } };
});

afterEach(/** Removes the browser stub between tests. */ () => { delete global.window; });

test('legacy storage without overrides keeps prompts and uses gpt-5.4', /** Checks backwards compatibility. */ () => {
  window.localStorage.setItem(KESP_UPLOAD_PROMPT_SETTINGS_KEY, JSON.stringify({ promptVersions: { coaching: '2' } }));
  const saved = loadKespUploadPromptSettings();
  expect(saved).toEqual({ promptVersions: { coaching: '2' } });
  expect(validateKespUploadPromptSettings(saved, catalog).analyzerModel).toBeUndefined();
  expect(analyzerModelSettings(saved, catalog)).toEqual({ analyzerModel: 'gpt-5.4', analyzerModelOverrides: {} });
});

test('all eight catalog models are accepted for all ten call tasks only', /** Checks the task/model boundary. */ () => {
  expect(ANALYZER_TASK_IDS).toHaveLength(10);
  for (const model of catalog.analyzerModels.available) {
    const overrides = Object.fromEntries(ANALYZER_TASK_IDS.map(/** Assigns a test model to each allowed task. */ (task) => [task, model]));
    expect(validateAnalyzerModelOverrides(overrides, catalog)).toEqual(overrides);
  }
  expect(validateAnalyzerModelOverrides({ coaching: 'unknown', core_fields: 123, behavior_pattern_detector: 'gpt-6-astra', call_activity_extractor: 'gpt-6-astra', post_call_event_detector: 'gpt-6-astra' }, catalog)).toEqual({});
  expect(validateAnalyzerModelOverrides([], catalog)).toEqual({});
});

test('override-only settings round-trip and an explicit default remains pinned', /** Checks sparse persistence. */ () => {
  const saved = { analyzerModelOverrides: { coaching: 'gpt-5.4', severity_analysis_D: 'gpt-6-astra' } };
  expect(saveKespUploadPromptSettings(saved)).toBe(true);
  expect(validateKespUploadPromptSettings(loadKespUploadPromptSettings(), catalog)).toEqual(saved);
  expect(analyzerModelSettings({ ...saved, analyzerModel: 'gpt-5.6-sol' }, catalog).analyzerModelOverrides.coaching).toBe('gpt-5.4');
});

test('updating model settings preserves all existing prompt families', /** Checks prompt-selector coexistence. */ () => {
  const saved = { promptVersions: { coaching: '2' }, reportPromptVersions: { behavior_pattern_detector: '2' }, activityPromptVersions: { call_activity_extractor: '2' } };
  const next = validateKespUploadPromptSettings({ ...saved, analyzerModel: 'gpt-5.6-terra', analyzerModelOverrides: { core_fields: 'gpt-6-astra' } }, catalog);
  expect(saveKespUploadPromptSettings(next)).toBe(true);
  expect(loadKespUploadPromptSettings()).toEqual({ ...saved, analyzerModel: 'gpt-5.6-terra', analyzerModelOverrides: { core_fields: 'gpt-6-astra' } });
});

test('inherited entries are omitted and empty settings remove the stored key', /** Checks clearing overrides. */ () => {
  expect(validateKespUploadPromptSettings({ analyzerModelOverrides: { coaching: '' } }, catalog)).toEqual({});
  expect(saveKespUploadPromptSettings({})).toBe(true);
  expect(window.localStorage.removeItem).toHaveBeenCalledWith(KESP_UPLOAD_PROMPT_SETTINGS_KEY);
});

test('an explicitly saved GPT-5.4 survives validation and reload rather than becoming absent', /** Distinguishes popup Save from an untouched browser preference. */ () => {
  const next = validateKespUploadPromptSettings({ analyzerModel: 'gpt-5.4', analyzerModelOverrides: {}, promptVersions: { coaching: '2' } }, catalog);
  expect(next).toEqual({ analyzerModel: 'gpt-5.4', promptVersions: { coaching: '2' } });
  expect(saveKespUploadPromptSettings(next)).toBe(true);
  const reloaded = validateKespUploadPromptSettings(loadKespUploadPromptSettings(), catalog);
  expect(reloaded.analyzerModel).toBe('gpt-5.4');
  expect(reloaded.promptVersions).toEqual({ coaching: '2' });
  expect(saveKespUploadPromptSettings({})).toBe(true);
  expect(validateKespUploadPromptSettings(loadKespUploadPromptSettings(), catalog).analyzerModel).toBeUndefined();
});

test('malformed storage is ignored and failed writes are reported', /** Checks recoverable browser failures. */ () => {
  window.localStorage.setItem(KESP_UPLOAD_PROMPT_SETTINGS_KEY, '{');
  expect(loadKespUploadPromptSettings()).toEqual({});
  window.localStorage.setItem.mockImplementation(/** Simulates disabled or full browser storage. */ () => { throw new Error('Quota exceeded'); });
  expect(saveKespUploadPromptSettings({ analyzerModel: 'gpt-6-astra' })).toBe(false);
});

test('new drafts do not mutate a source snapshot or share maps across environments', /** Checks draft isolation. */ () => {
  const source = { analyzerModel: 'gpt-5.6-sol', analyzerModelOverrides: { coaching: 'gpt-6-astra' } };
  const testing = analyzerModelSettings(source, catalog);
  const production = analyzerModelSettings({}, catalog);
  delete testing.analyzerModelOverrides.coaching;
  expect(source.analyzerModelOverrides.coaching).toBe('gpt-6-astra');
  expect(production).toEqual({ analyzerModel: 'gpt-5.4', analyzerModelOverrides: {} });
});

test('the real shared fields render eleven labeled selectors with inherited models in ES and EN', /** Verifies the actual component, not a synthetic popup. */ async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const i18next = require('i18next');
  const { I18nextProvider } = require('react-i18next');
  const { AnalyzerModelFields } = require('../components/kesp/AnalyzerModelFields');
  for (const language of ['es', 'en']) {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: language, resources: { [language]: { translation: require(`../i18n/${language}.json`) } }, interpolation: { escapeValue: false } });
    const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(AnalyzerModelFields, {
      value: analyzerModelSettings({}, catalog), catalog, onChange: jest.fn(),
    })));
    expect((html.match(/<select/g) || [])).toHaveLength(11);
    expect((html.match(/<label/g) || [])).toHaveLength(11);
    expect((html.match(/<option/g) || [])).toHaveLength(98);
    expect(html).toContain(language === 'es' ? 'Usar predeterminado (gpt-5.4)' : 'Use default (gpt-5.4)');
    expect(html).toContain('gpt-6-astra');
    expect(html).not.toContain('call_activity_extractor');
  }
});
