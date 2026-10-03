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
const pageSource = readFileSync(new URL('../../pages/kesp/CallDetailPage.tsx', import.meta.url), 'utf8');
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX };
const helpers = {};
runInNewContext(ts.transpileModule(readFileSync(new URL('./transcriptPlayback.ts', import.meta.url), 'utf8'), { compilerOptions }).outputText,
  { exports: helpers });

/** Renders the actual transcript view with only lifecycle and remote-service boundaries mocked. */
function render(language, overrides = {}, props = {}) {
  const translations = JSON.parse(readFileSync(new URL(`../../i18n/${language}.json`, import.meta.url), 'utf8'));
  const instance = i18next.createInstance();
  instance.init({ lng: language, resources: { [language]: { translation: translations } }, initImmediate: false,
    interpolation: { escapeValue: false } });
  const modules = {
    react: { ...React, useEffect: () => {}, useRef: () => ({ current: null }) },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-i18next': { useTranslation: () => ({ t: instance.t.bind(instance) }) },
    'lucide-react': Object.fromEntries(['Loader2', 'Pause', 'Play', 'RotateCcw', 'Trash2', 'X'].map((name) => [name, () => null])),
    '@/hooks/useKespDemoRedactionEnabled': { useKespDemoRedactionEnabled: () => false },
    '@/components/audio/transcriptPlayback': helpers,
  };
  const exports = {};
  runInNewContext(ts.transpileModule(pageSource.replace('function TranscriptView(', 'export function TranscriptView('), { compilerOptions }).outputText,
    { exports, require: (name) => modules[name] ?? {} });
  return { html: renderToStaticMarkup(React.createElement(exports.TranscriptView, {
    transcript: { text: 'Original transcript', duration: 15, segments: [
      { id: 'one', start: 1, end: 5, text: 'Original agent words', speaker: 'agent' },
      { id: 'two', start: 8, end: 12, text: 'Original customer words', speaker: 'customer' },
      { id: 'invalid', start: 12, end: 12, text: 'Untimed words retained', speaker: 'agent' },
    ] }, loading: false, error: false, feedback: null, agentLabel: 'Agent', customerLabel: 'Customer',
    selectedEvidence: { start: 5, end: 8 }, audioPath: 'private-recording', ...props,
    playback: { selectedKey: null, playing: false, loading: false,
      elapsed: 0, duration: 0, error: null, progress: { loaded: 0, total: null },
      toggle: () => {}, cancel: () => {}, attachAudioHost: () => {}, ...overrides },
  })), labels: translations.kesp.callDetail.playback };
}

for (const language of ['en', 'es']) {
  test(`${language} shows inline full/segment controls, gap highlights and disabled invalid segment`, () => {
    const { html, labels } = render(language);
    assert.ok(html.includes(labels.fullRecording));
    assert.ok(html.includes(labels.playRecording));
    assert.ok(html.includes(labels.includesPause));
    assert.ok(html.includes(labels.invalidTiming));
    assert.equal((html.match(/data-metrics-evidence="true"/g) ?? []).length, 2);
    assert.equal((html.match(/disabled=""/g) ?? []).length, 1);
    assert.ok(html.includes('Original agent words')); assert.ok(html.includes('Untimed words retained'));
    assert.ok(!html.includes('role="dialog"'));
  });
  test(`${language} reports download progress and safe retry error inline`, () => {
    const loading = render(language, { loading: true, selectedKey: '0', progress: { loaded: 50, total: 100 } });
    assert.ok(loading.html.includes('50%')); assert.ok(loading.html.includes(loading.labels.cancel));
    assert.match(loading.html, /<article[^>]*data-segment-index="0"[\s\S]*?role="status"[\s\S]*?<\/article>/);
    assert.ok(!loading.html.slice(0, loading.html.indexOf('<article')).includes('role="status"'));
    const failed = render(language, { error: 'timeout', selectedKey: '0' });
    assert.ok(failed.html.includes(failed.labels.errors.timeout)); assert.ok(failed.html.includes(failed.labels.retry));
    assert.match(failed.html, /<article[^>]*data-segment-index="0"[\s\S]*?role="alert"[\s\S]*?<\/article>/);
  });
  test(`${language} retains full recording when transcript is unavailable`, () => {
    const { html, labels } = render(language, {}, { transcript: null, error: true });
    assert.ok(html.includes(labels.playRecording));
  });
  test(`${language} shows permission loss after selection cleanup without retrying segment zero`, () => {
    const { html, labels } = render(language, { error: 'unauthorized', selectedKey: null });
    assert.ok(html.includes(labels.errors.unauthorized));
    assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
    assert.ok(!html.includes(labels.retry));
  });
}

test('evidence handler navigates only and the page does not import the playback dialog', () => {
  const handler = pageSource.slice(pageSource.indexOf('function handlePlayConversationEvidence'), pageSource.indexOf('function handlePlayConversationEvidence') + 330);
  assert.ok(handler.includes("setTab('transcript')"));
  assert.ok(!handler.includes('toggle(')); assert.ok(!pageSource.includes('AudioPlayerDialog'));
});

/** Executes the production header JSX and handler against a shared playback controller. */
function renderHeader(playback, navigate) {
  const ast = ts.createSourceFile('page.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const snippets = [];
  let button;
  /** Selects the real handler, state expressions and audio-box button without copying their behavior. */
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleFullRecordingPlayback') snippets.push(node.getText(ast));
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(
      /** Selects the two expressions used to display shared full-recording state. */
      declaration => ['fullRecordingSelected', 'fullRecordingAction'].includes(declaration.name.getText(ast)),
    )) snippets.push(node.getText(ast));
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(
      /** Finds the production header control by its stable CSS class. */
      attribute => ts.isJsxAttribute(attribute) && attribute.name.text === 'className' && attribute.initializer?.text === 'audio-box',
    )) button = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(button);
  const exports = {};
  runInNewContext(ts.transpileModule(`export function render(playback, setTab, setEvidenceSelection) {
    const call = { audioPath: 'private-recording' };
    const t = key => key;
    ${snippets.join('\n')}
    return (${button});
  }`, { compilerOptions }).outputText, {
    exports, require: name => name === 'react/jsx-runtime' ? require(name) : {}, Play: 'play', Pause: 'pause', Loader2: 'loading',
  });
  return exports.render(playback, navigate, () => {});
}

for (const initialTab of ['retro', 'transcript']) {
  test(`header starts full playback from ${initialTab} using the shared controller`, () => {
    let tab = initialTab;
    const commands = [];
    const controller = { selectedKey: null, playing: false, loading: false,
      toggle: (...args) => commands.push(args) };
    const button = renderHeader(controller, next => { tab = next; });
    button.props.onClick();
    assert.equal(tab, 'transcript');
    assert.deepEqual(commands, [['full', null]]);
  });
}

test('header mirrors full-recording pause/cancel state and switches a segment to full recording', () => {
  for (const [selectedKey, playing, loading, action] of [
    ['full', true, false, 'pause'], ['full', false, true, 'cancel'],
    ['full', false, false, 'playRecording'], ['0', true, false, 'playRecording'],
  ]) {
    const commands = [];
    const button = renderHeader({ selectedKey, playing, loading, toggle: (...args) => commands.push(args) }, () => {});
    assert.equal(button.props['aria-label'], `kesp.callDetail.playback.${action}`);
    button.props.onClick();
    assert.deepEqual(commands, [['full', null]]);
  }
});

/** Executes the page's actual navigation effect, which owns tab-exit cancellation. */
function playbackNavigationEffect(tab, callId, cancelPlayback) {
  const ast = ts.createSourceFile('page.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  /** Locates the production effect by the cancellation callback it returns. */
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('return cancelPlayback')) effect = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(effect, 'page registers a navigation cancellation effect');
  const exports = {};
  runInNewContext(ts.transpileModule(`export function run(tab, callId, cancelPlayback) {
    let result;
    const useEffect = (callback, dependencies) => { result = { cleanup: callback(), dependencies }; };
    ${effect};
    return result;
  }`, { compilerOptions }).outputText, { exports });
  return exports.run(tab, callId, cancelPlayback);
}

test('page navigation cancels on transcript exit or call change, without canceling header entry', () => {
  let cancellations = 0;
  const cancel = () => { cancellations++; };
  const retro = playbackNavigationEffect('retro', 'call-one', cancel);
  assert.equal(retro.cleanup, undefined);
  const transcript = playbackNavigationEffect('transcript', 'call-one', cancel);
  assert.equal(cancellations, 0, 'entering transcript must preserve playback started by the header');
  assert.equal(transcript.cleanup, cancel);
  assert.equal(transcript.dependencies[0], 'transcript');
  assert.equal(transcript.dependencies[1], 'call-one');
  assert.equal(transcript.dependencies[2], cancel);
  transcript.cleanup();
  playbackNavigationEffect('retro', 'call-one', cancel);
  assert.equal(cancellations, 1, 'leaving transcript stops the shared player');
  const firstCall = playbackNavigationEffect('transcript', 'call-one', cancel);
  firstCall.cleanup();
  const secondCall = playbackNavigationEffect('transcript', 'call-two', cancel);
  assert.equal(cancellations, 2, 'changing calls cancels the previous call');
  assert.equal(secondCall.dependencies[1], 'call-two');
});
