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
const source = ts.transpileModule(readFileSync(new URL('./ConversationMetricsHelp.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

/** Renders help copy with real translations; interactive Radix behavior is checked in Chrome. */
function render(language, props = {}) {
  const translation = JSON.parse(readFileSync(new URL(`../../i18n/${language}.json`, import.meta.url), 'utf8'));
  const instance = i18next.createInstance();
  instance.init({ lng: language, resources: { [language]: { translation } }, initImmediate: false, interpolation: { escapeValue: false } });
  /** Includes portal content for static content assertions only. */
  const childrenOnly = ({ children }) => React.createElement(React.Fragment, null, children);
  const modules = {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'),
    'react-i18next': { useTranslation: /** Uses actual locale keys. */ () => ({ t: instance.t.bind(instance) }) },
    'lucide-react': { Info: /** Decorative icon. */ () => null, X: /** Decorative icon. */ () => null },
    '@radix-ui/react-dialog': { Content: childrenOnly },
    '@/components/ui/dialog': { Dialog: childrenOnly, DialogClose: childrenOnly, DialogDescription: childrenOnly,
      DialogOverlay: /** Overlay contains no guide text. */ () => null, DialogPortal: childrenOnly,
      DialogTitle: childrenOnly, DialogTrigger: childrenOnly },
  };
  const exports = {};
  runInNewContext(source, { exports, require: /** Rejects unexpected runtime or network dependencies. */ (name) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`); return modules[name];
  } });
  return { html: renderToStaticMarkup(React.createElement(exports.ConversationMetricsHelp, props)), labels: translation.kesp.conversationMetrics };
}

for (const language of ['en', 'es']) {
  test(`guide includes all eleven metrics, status messages and speed examples in ${language}`, /** Keeps every visible feature documented. */ () => {
    const { html, labels } = render(language);
    assert.equal(Object.keys(labels.help.metrics).length, 11);
    for (const key of Object.keys(labels.summary)) {
      assert.ok(html.includes(labels.summary[key]));
      assert.ok(labels.help.metrics[key]?.length > 40);
      assert.ok(html.includes(renderToStaticMarkup(React.createElement(React.Fragment, null, labels.help.metrics[key]))));
    }
    for (const key of ['limitations', 'unavailable', 'truncated', 'speedRule']) assert.ok(html.includes(labels[key]));
    for (const key of ['fastExample', 'boundaryExample', 'shortExample', 'coverage', 'statuses', 'partialCoverage']) {
      assert.ok(labels.help[key]?.length > 30);
      assert.ok(html.includes(renderToStaticMarkup(React.createElement(React.Fragment, null, labels.help[key]))));
    }
    assert.ok(html.includes(`aria-label="${labels.help.open}"`));
    assert.ok(html.includes(`aria-label="${labels.help.close}"`));
    assert.ok(!html.includes('undefined'));
    assert.ok(!html.includes('381 of 382'));
  });
}

test('requested English paragraphs remain verbatim', /** Preserves user-supplied copy in its status context. */ () => {
  const { html } = render('en');
  for (const paragraph of [
    'Timestamp-derived estimates, not voice-activity measurements. Talk balance, gaps, turns, fillers and possible interruptions do not imply a grade or prove active listening.',
    'Conversation metrics are unavailable for this recording. Historical transcripts and feedback remain available.',
    'Only part of the evidence is shown, with bounded excerpts and source references. Summary measurements cover the full call, not just the displayed rows.',
  ]) assert.ok(html.includes(paragraph));
});


for (const language of ['en', 'es']) {
  test(`segment help in ${language} documents estimates without promising word precision or an interpreter`, /** Verifies source-specific help and preserved speed policy. */ () => {
    const { html, labels } = render(language, { timingSource: 'segment', deterministicOnly: true });
    assert.ok(html.includes(labels.timingSource.segment));
    assert.ok(!html.includes(labels.timingSource.word));
    for (const key of Object.keys(labels.help.segmentMetrics)) {
      assert.ok(html.includes(renderToStaticMarkup(React.createElement(React.Fragment, null, labels.help.segmentMetrics[key]))));
      assert.ok(!html.includes(renderToStaticMarkup(React.createElement(React.Fragment, null, labels.help.metrics[key]))));
    }
    for (const value of Object.values(labels.help.providerSegments)) {
      assert.ok(html.includes(renderToStaticMarkup(React.createElement(React.Fragment, null, value))));
    }
    assert.ok(html.includes(labels.deterministicOnly));
    assert.ok(!html.includes(labels.help.observations));
    assert.ok(html.includes(labels.speedRule));
    assert.ok(!html.includes('undefined'));
  });
}
