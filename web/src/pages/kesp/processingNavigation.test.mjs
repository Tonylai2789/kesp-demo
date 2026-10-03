import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const agentSource = read('./AgentPage.tsx');
const file = { name: 'demo.wav', size: 100 };
const agent = { id: 'shared-profile', salesAgentId: 'demo-agent', salesAgentName: 'Demo Agent', status: 'ready' };

function fixture(filename, { canStart = false, fresh = false, initialStates = [], modules: extra = {} } = {}) {
  const states = [...initialStates];
  const nodes = [];
  let index = 0;
  let uploads = 0;
  const processing = { canStart, checkCanStart: async () => fresh };
  const jsx = (type, props, key) => { const node = { type, props, key }; nodes.push(node); return node; };
  const modules = {
    react: {
      useState: (initial) => {
        const slot = index++;
        if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
        return [states[slot], (value) => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
      },
      useMemo: (fn) => fn(), useEffect: () => {}, useCallback: (fn) => fn, useRef: (value) => ({ current: value }),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-i18next': { useTranslation: () => ({ t: (key) => key, i18n: { resolvedLanguage: 'en' } }) },
    'react-router-dom': { useNavigate: () => () => {} },
    sonner: { toast: { error: () => {}, success: () => {} } },
    '@/contexts/useAuth': { useAuth: () => ({ user: { uid: 'viewer' } }) },
    '@/hooks/useDemoProcessingStatus': { useDemoProcessingStatus: () => processing },
    '@/hooks/useKespDemoRedactionEnabled': { useKespDemoRedactionEnabled: () => false },
    '@/hooks/useTranscriptionUploadSelection': { useTranscriptionUploadSelection: () => ({ loading: false, snapshot: () => ({}) }) },
    '@/lib/kespI18n': { getKespLocale: () => 'en', formatKespDate: () => 'date' },
    '@/lib/callDates': { callBusinessDate: (call) => call.createdAt },
    '@/lib/kespDemoRedaction': { maskKespDemoCallString: (value) => value, maskKespDemoAgentDisplayName: (_name, id) => `Agent ${id}` },
    '@/services/storage': { validateAudioFile: () => ({ valid: true }), uploadAudioFile: async () => { uploads++; return { callId: 'new-call' }; } },
    '@/services/functions': { notifyUploadBatchCompleted: async () => {} },
    '@/components/kesp/KespUploadDraftContext': { KESP_NO_AGENT: 'none', KESP_GENERAL_AGENTS: 'all', useKespUploadDraft: () => ({
      agentValue: 'none', queue: [{ id: 'queued', file, status: 'queued' }], enqueueFiles: () => {}, updateQueueItem: () => {},
    }) },
    ...extra,
  };
  const exports = {};
  const source = read(filename) + (filename === './AgentPage.tsx' ? '\nexport { AssociatedCallsPanel, CargaTab };' : '');
  runInNewContext(compile(source), { exports, console, require: (name) => modules[name] ?? {} });
  return { exports, processing, states, nodes, uploads: () => uploads,
    render: (name, props) => { index = 0; nodes.length = 0; return exports[name](props); } };
}

test('historical calls select All only after loading, retain a user choice and do not track later snapshots', () => {
  const harness = fixture('./AgentPage.tsx');
  const props = { agent, calls: [], callsLoaded: false, snapshots: [], canManageAgent: false };
  harness.render('AssociatedCallsPanel', props);
  assert.equal(harness.states[0], null);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  props.calls = [{ id: 'historic', createdAt: yesterday, status: 'complete' }];
  harness.render('AssociatedCallsPanel', props);
  assert.equal(harness.states[0], null);
  props.callsLoaded = true;
  harness.render('AssociatedCallsPanel', props);
  assert.equal(harness.states[0], 'all');
  harness.render('AssociatedCallsPanel', props);
  harness.nodes.find((node) => node.props?.role === 'tab' && node.key === 'today').props.onClick();
  harness.render('AssociatedCallsPanel', props);
  assert.equal(harness.states[0], 'today');

  const chosenWhileLoading = fixture('./AgentPage.tsx');
  chosenWhileLoading.render('AssociatedCallsPanel', { ...props, callsLoaded: false });
  chosenWhileLoading.nodes.find((node) => node.props?.role === 'tab' && node.key === 'week').props.onClick();
  chosenWhileLoading.render('AssociatedCallsPanel', props);
  assert.equal(chosenWhileLoading.states[0], 'week');
});

test('a profile with Today calls keeps Today after loading', () => {
  const harness = fixture('./AgentPage.tsx');
  harness.render('AssociatedCallsPanel', { agent, snapshots: [], callsLoaded: true,
    calls: [{ id: 'today', createdAt: new Date(), status: 'complete' }] });
  assert.equal(harness.states[0], 'today');
});

for (const canStart of [false, true]) {
  test(`upload page handler blocks paid upload when cached allowed=${canStart} but fresh status denies`, async () => {
    const harness = fixture('./SubirPage.tsx', { canStart });
    harness.render('SubirPage');
    const button = harness.nodes.find((node) => node.props?.children === 'kesp.upload.queue.button');
    assert.equal(button.props.disabled, !canStart);
    await button.props.onClick();
    assert.equal(harness.uploads(), 0);
  });

  test(`profile drop handler blocks paid upload when cached allowed=${canStart} but fresh status denies`, async () => {
    const harness = fixture('./AgentPage.tsx', { canStart });
    harness.render('CargaTab', { agent, calls: [], snapshots: [], callsLoaded: true,
      processing: harness.processing, canManageAgent: true });
    const input = harness.nodes.find((node) => node.type === 'input' && node.props.type === 'file');
    assert.equal(input.props.disabled, !canStart);
    // Invoke the actual async handler via the drop callback's captured return value.
    const drop = harness.nodes.find((node) => node.props?.className === 'upload-zone');
    drop.props.onDrop({ preventDefault() {}, dataTransfer: { files: [file] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.uploads(), 0);
    const generate = harness.nodes.find((node) => node.props?.children === 'kesp.agent.upload.generate');
    assert.equal(generate.props.disabled, true);
  });
}

test('upload page permits upload only after a fresh affirmative status', async () => {
  const harness = fixture('./SubirPage.tsx', { canStart: true, fresh: true });
  harness.render('SubirPage');
  await harness.nodes.find((node) => node.props?.children === 'kesp.upload.queue.button').props.onClick();
  assert.equal(harness.uploads(), 1);
});

function variableSource(source, name) {
  const ast = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration, name);
  return compile(`const ${declaration}; exports.handler = ${name};`);
}

test('report generation handler rejects paused status and stale allowed status before starting paid work', async () => {
  for (const canStart of [false, true]) {
    let paid = 0;
    const exports = {};
    runInNewContext(variableSource(agentSource, 'onTriggerReport'), {
      exports, agent: { ...agent, uploadedBy: 'viewer' }, user: { uid: 'viewer' }, triggering: false, reportInProgress: false,
      processing: { canStart, checkCanStart: async () => false }, setTriggering: () => {},
      triggerAgentAnalysisRun: () => { paid++; },
    });
    await exports.handler();
    assert.equal(paid, 0);
  }
});

test('assistant send handler does not call the paid endpoint while paused', async () => {
  let paid = 0;
  const exports = {};
  runInNewContext(variableSource(read('../../components/kesp/AgentProfileAssistant.tsx'), 'sendQuestion'), {
    exports, useCallback: (fn) => fn, canStart: false, checkCanStart: async () => false,
    agentAnalysisId: 'profile', assistantLanguage: 'en', chat: {}, draft: 'question', enabled: true,
    loading: false, t: (key) => key, user: { uid: 'viewer' }, sendingRef: { current: false },
    askAgentProfileAssistant: () => { paid++; },
  });
  await exports.handler();
  assert.equal(paid, 0);
});
