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
const source = ts.transpileModule(readFileSync(new URL('./DemoProcessingStatus.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

for (const language of ['en', 'es']) {
  test(language + ': status and budget are localized, read-only, and existing records stay available', () => {
    const translations = JSON.parse(readFileSync(new URL('../../i18n/' + language + '.json', import.meta.url), 'utf8'));
    const i18n = i18next.createInstance();
    i18n.init({ lng: language, resources: { [language]: { translation: translations } }, initImmediate: false });
    for (const reason of ['loading', 'ready', 'paused', 'budget_exhausted', 'capacity', 'unavailable']) {
      const modules = {
        'react/jsx-runtime': require('react/jsx-runtime'),
        'react-i18next': { useTranslation: () => ({ t: i18n.t.bind(i18n), i18n }) },
        '@/hooks/useDemoProcessingStatus': { useDemoProcessingStatus: () => ({
          status: reason === 'loading' ? undefined : { remainingMicros: 10_033_729, pauseReason: reason === 'ready' ? null : reason },
          canStart: reason === 'ready', loading: reason === 'loading',
        }) },
        '@/components/kesp/primitives': { Pill: ({ children }) => React.createElement('span', null, children) },
      };
      const exports = {};
      runInNewContext(source, { exports, Intl, require: (name) => modules[name] });
      const html = renderToStaticMarkup(React.createElement(exports.DemoProcessingStatus));
      assert.ok(html.includes(translations.kesp.processing[reason]));
      assert.doesNotMatch(html, /button|input|switch|kesp\.processing\./);
      if (reason !== 'ready') assert.ok(html.includes(translations.kesp.processing.readOnly));
      if (reason !== 'loading') assert.match(html, /10[.,]03/);
    }
  });
}
