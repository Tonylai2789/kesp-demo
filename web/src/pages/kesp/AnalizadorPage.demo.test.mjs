import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import ts from 'typescript';
import * as redaction from '../../lib/kespDemoRedaction.ts';

const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL('./AnalizadorPage.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const resources = Object.fromEntries(['en', 'es'].map((language) => [
  language, { translation: JSON.parse(readFileSync(new URL('../../i18n/' + language + '.json', import.meta.url), 'utf8')) },
]));
const profiles = [
  { id: 'demo-manual', salesAgentId: 'canonical-manual', salesAgentName: 'Demo Manual', status: 'ready', profileSource: 'manual' },
  { id: 'demo-seeded', salesAgentId: 'canonical-seeded', salesAgentName: 'Demo Seeded', status: 'ready', profileSource: 'manual' },
];

// Render the real page and locales without mounting Firebase or any paid actions.
function render(language, { agents = profiles, loading = false, query = '' } = {}) {
  const instance = i18next.createInstance();
  instance.init({ lng: language, resources, initImmediate: false, interpolation: { escapeValue: false } });
  const states = [agents, loading, 0, query];
  let index = 0;
  const cards = [];
  const routes = [];
  const jsxRuntime = require('react/jsx-runtime');
  const capture = (factory, type, props, key) => {
    if (props?.className === 'agent-card') cards.push(props);
    return factory(type, props, key);
  };
  const modules = {
    react: { ...React, useState: () => [states[index++], () => {}], useEffect: () => {}, useMemo: (fn) => fn() },
    'react/jsx-runtime': {
      ...jsxRuntime,
      jsx: (...args) => capture(jsxRuntime.jsx, ...args),
      jsxs: (...args) => capture(jsxRuntime.jsxs, ...args),
    },
    'react-router-dom': { useNavigate: () => (route) => routes.push(route) },
    'react-i18next': { useTranslation: () => ({ t: instance.t.bind(instance), i18n: instance }) },
    '@/contexts/useAuth': { useAuth: () => ({ user: { uid: 'demo-viewer' } }) },
    '@/services/agentAnalyses': {},
    '@/services/firestore': {},
    '@/components/kesp/icons': { Icon: () => null },
    '@/components/kesp/primitives': {
      Button: ({ children }) => React.createElement('button', null, children),
      Pill: ({ children }) => React.createElement('span', null, children),
    },
    '@/lib/kespI18n': { formatKespDate: () => '10/3/2026', getKespLocale: () => language },
    '@/lib/kespDemoRedaction': redaction,
    '@/hooks/useConsubancoTeamMetrics': { useConsubancoTeamMetrics: () => ({
      officialAgentCount: agents.length, activeAgentCount: agents.length,
      totalAnalyzedCalls: 11, averageScore: null,
    }) },
  };
  const exports = {};
  runInNewContext(source, { exports, require: (name) => {
    assert.ok(name in modules, 'Unexpected dependency: ' + name);
    return modules[name];
  } });
  return { html: renderToStaticMarkup(React.createElement(exports.AnalizadorPage)), cards, routes };
}

for (const language of ['en', 'es']) {
  const copy = resources[language].translation.kesp.analyzer;
  test(language + ': completed calls do not imply a portfolio aggregate or PDF', () => {
    const { html, cards, routes } = render(language);
    assert.equal(cards.length, 2);
    assert.ok(html.includes(copy.eyebrow));
    assert.ok(html.includes(copy.agents.noAggregateYet));
    assert.ok(html.includes('>11<'));
    assert.doesNotMatch(html, /CCC|verified mappings|mapeos verificados|No report yet|Sin reporte|PDF/);
    assert.equal(copy.agents.noAggregateYet, language === 'en'
      ? 'Portfolio summary not generated' : 'Resumen del agente no generado');
    assert.equal(copy.agents.aggregateAvailable, language === 'en'
      ? 'Portfolio summary available' : 'Resumen del agente disponible');
    assert.equal(copy.agents.subtitle, language === 'en'
      ? 'Uploaded and reconstructed call profiles' : 'Perfiles de llamadas cargadas y reconstruidas');
    cards.forEach((card) => card.onClick());
    assert.deepEqual(routes, ['/kesp/agent/demo-manual?tab=carga', '/kesp/agent/demo-seeded?tab=carga']);
  });

  test(language + ': an existing aggregate retains the report entry route', () => {
    const { html, cards, routes } = render(language, {
      agents: [{ ...profiles[0], status: 'complete', latestReportId: 'saved-aggregate' }],
    });
    assert.ok(html.includes(copy.agents.aggregateAvailable));
    assert.ok(!html.includes(copy.agents.noAggregateYet));
    cards[0].onClick();
    assert.deepEqual(routes, ['/kesp/agent/demo-manual']);
  });

  test(language + ': same-named profiles render distinct canonical labels and can be found by those labels', () => {
    const agents = profiles.map(profile => ({ ...profile, salesAgentName: 'Same Private Name' }));
    const expected = agents.map(agent => redaction.maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId));
    assert.notEqual(expected[0], expected[1]);
    for (const order of [agents, [...agents].reverse()]) {
      redaction.resetKespDemoRedactionState();
      order.forEach(redaction.registerKespDemoAgentAnalysisTerms);
      const { html, cards, routes } = render(language, { agents: order });
      for (const label of expected) assert.ok(html.includes(label));
      assert.doesNotMatch(html, /Same Private Name|canonical-manual|canonical-seeded/);
      cards.forEach(card => card.onClick());
      assert.deepEqual(routes, order.map(agent => `/kesp/agent/${agent.id}?tab=carga`));
      const found = render(language, { agents: order, query: expected[1] });
      assert.equal(found.cards.length, 1);
      assert.ok(found.html.includes(expected[1]));
    }
  });

  test(language + ': loading, empty and search states use demo rather than CCC labels', () => {
    for (const options of [{ loading: true }, { agents: [] }, { query: 'missing' }]) {
      const { html } = render(language, options);
      assert.doesNotMatch(html, /CCC|canonical|canónico|automatic|automático/);
      assert.doesNotMatch(html, /kesp\.analyzer\./);
    }
    assert.doesNotMatch(JSON.stringify(copy), /CCC|canonical|canónico|verified mappings|mapeos verificados/);
  });
}
