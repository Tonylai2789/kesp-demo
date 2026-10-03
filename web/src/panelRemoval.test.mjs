import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as router from 'react-router-dom';
import i18next from 'i18next';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const resources = Object.fromEntries(['en', 'es'].map((language) => [
  language, { translation: JSON.parse(read(`./i18n/${language}.json`)) },
]));

function load(path, { language = 'en', role = 'supervisor', suffix = '' } = {}) {
  const instance = i18next.createInstance();
  instance.init({ lng: language, resources, initImmediate: false });
  const member = { role, salesAgentId: 'demo-agent' };
  const modules = {
    react: {
      ...React,
      lazy: (loader) => Object.assign(() => null, { loader: loader.toString() }),
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useState: (initial) => [initial === null ? member : typeof initial === 'function' ? initial() : initial, () => {}],
    },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-router-dom': { ...router, useNavigate: () => () => {}, useLocation: () => ({ pathname: '/kesp/analizador' }) },
    'react-i18next': { useTranslation: () => ({ t: instance.t.bind(instance), i18n: instance }) },
    '@/contexts/useAuth': { useAuth: () => ({ user: { uid: 'viewer', email: 'admin@example.invalid' }, isEmailAllowed: true }) },
    '@/hooks/useKespTheme': { useKespTheme: () => ({ theme: 'light', toggleTheme: () => {} }) },
    '@/hooks/useUserPermissionsAccess': { useUserPermissionsAccess: () => ({ adminOrganizationIds: ['consubanco'] }) },
    '@/lib/demoPolicy': { DEMO_ADMIN_EMAIL: 'admin@example.invalid' },
    '@/services/organizations': {
      isConsubancoAdminMember: (value) => value.role === 'admin',
      isConsubancoAgentMember: (value) => value.role === 'agent',
      isConsubancoSupervisorOrAdminMember: (value) => ['admin', 'supervisor'].includes(value.role),
    },
    './HomePage.module.css': { default: {} },
    '@tanstack/react-query': { QueryClient: class {}, QueryClientProvider: 'query-provider' },
  };
  const exports = {};
  const source = ts.transpileModule(read(path) + suffix, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  // Unrendered UI wrappers and effect-only services need no browser or Firebase.
  runInNewContext(source, { exports, require: (name) => modules[name] ?? {} });
  return exports;
}

function nodes(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(nodes)];
}

for (const language of ['en', 'es']) {
  test(`${language}: home offers only Call analyzer and no Panel subscription`, () => {
    const tree = load('./pages/HomePage.tsx', { language }).HomePage();
    const elements = nodes(tree);
    assert.deepEqual(elements.filter((node) => node.type === router.Link).map((node) => node.props.to), ['/kesp/analizador']);
    assert.ok(elements.some((node) => node.props.children === resources[language].translation.kesp.home.analyzer.title));
    assert.doesNotMatch(read('./pages/HomePage.tsx'), /subscribeToAgentAnalyses|kesp\.home\.panel/);
  });

  for (const role of ['admin', 'supervisor', 'agent']) {
    test(`${language}: ${role} header and menus expose no Panel link`, () => {
      const elements = nodes(load('./components/kesp/KespLayout.tsx', { language, role }).KespLayout());
      const panelLabel = resources[language].translation.kesp.nav.panel;
      assert.ok(!elements.some((node) => node.props.title === panelLabel || node.props['aria-label'] === panelLabel));
      assert.ok(!elements.some((node) => node.props.to?.startsWith('/kesp/panel')));
      assert.doesNotMatch(read('./components/kesp/KespLayout.tsx'), /\/kesp\/panel/);
      if (role !== 'agent') {
        const links = elements.filter((node) => node.type === router.NavLink).map((node) => node.props.to);
        for (const path of ['/kesp/analizador', '/kesp/manual-profiles', '/kesp/llamadas', '/kesp/subir', '/kesp/email-reports']) {
          assert.ok(links.includes(path), path);
        }
      }
    });
  }
}

function appRoutes() {
  const { ProtectedApp } = load('./App.tsx', { suffix: '\nexport { ProtectedApp };' });
  const routes = nodes(ProtectedApp()).find((node) => node.type === router.Routes);
  assert.ok(routes);
  return router.createRoutesFromElements(routes.props.children);
}

test('direct Panel URLs redirect to Call analyzer without importing PanelPage', () => {
  const routes = appRoutes();
  for (const path of ['/kesp/panel', '/kesp/panel/', '/kesp/panel?period=week']) {
    const element = router.matchRoutes(routes, path).at(-1).route.element;
    assert.equal(element.type, router.Navigate, path);
    assert.equal(element.props.to, '/kesp/analizador', path);
    assert.equal(element.props.replace, true, path);
  }
  assert.doesNotMatch(read('./App.tsx'), /PanelPage/);
});

test('analyzer profiles, uploads, reports and detail routes remain reachable', () => {
  const routes = appRoutes();
  const cases = {
    '/kesp': 'AnalizadorPage',
    '/kesp/analizador': 'AnalizadorPage',
    '/kesp/analizador/unrecognized': 'UnrecognizedCallsPage',
    '/kesp/manual-profiles': 'ManualProfilesPage',
    '/kesp/llamadas': 'LlamadasPage',
    '/kesp/subir': 'SubirPage',
    '/kesp/subir/prompts': 'SubirPromptSettingsPage',
    '/kesp/email-reports': 'EmailReportsPage',
    '/kesp/agent/demo-agent': 'AgentPage',
    '/kesp/agent/demo-agent/rubric/s/g/c': 'AggregateRubricCriterionPage',
    '/kesp/call/demo-call': 'CallDetailPage',
    '/kesp/call/demo-call/prompts': 'CallPromptsPage',
    '/kesp/call/demo-call/rubric/s/g/c': 'RubricCriterionPage',
    '/kesp/short-calls': 'ShortCallsPage',
    '/kesp/short-calls/demo-call': 'ShortCallDetailPage',
    '/calls/demo-call/scorecard': 'ScorecardPage',
  };
  for (const [path, page] of Object.entries(cases)) {
    const element = router.matchRoutes(routes, path).at(-1).route.element;
    assert.ok(element.type.loader?.includes(`/${page}`), `${path} must render ${page}`);
  }
});
