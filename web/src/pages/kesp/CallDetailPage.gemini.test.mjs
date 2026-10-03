import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { assertDemoFirebaseConfig, DEMO_PROJECT_ID } from '../../lib/demoPolicy.ts';

const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
const firebaseSource = ts.transpileModule(
  readFileSync(new URL('../../services/firebaseApp.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.env', 'env'), { compilerOptions },
).outputText;
const organizationsSource = ts.transpileModule(
  readFileSync(new URL('../../services/organizations.ts', import.meta.url), 'utf8'), { compilerOptions },
).outputText;
const pageSource = ts.createSourceFile('CallDetailPage.tsx',
  readFileSync(new URL('./CallDetailPage.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
let panel;

/** Collects actual role expressions and the panel boundary rather than duplicating their logic. */
function visit(node) {
  if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(pageSource), node.initializer);
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(pageSource) === 'ConversationMetricsPanel') panel = node;
  ts.forEachChild(node, visit);
}
visit(pageSource);

/** Evaluates the shipped Firebase identity gate without starting Firebase services. */
function projectGate(projectId) {
  const exports = {};
  runInNewContext(firebaseSource, {
    exports, env: { VITE_FIREBASE_PROJECT_ID: projectId, VITE_FIREBASE_AUTH_DOMAIN: DEMO_PROJECT_ID+'.firebaseapp.com', VITE_FIREBASE_STORAGE_BUCKET: DEMO_PROJECT_ID+'.firebasestorage.app', VITE_FIREBASE_API_KEY: 'client-key', VITE_FIREBASE_MESSAGING_SENDER_ID: '337829671131', VITE_FIREBASE_APP_ID: 'demo-app' },
    require: /** Only Firebase app initialization may cross this module boundary. */ (name) => {
      if (name === '@/lib/demoPolicy') return { assertDemoFirebaseConfig };
      assert.equal(name, 'firebase/app');
      return { getApps: /** No preexisting app in the fixture. */ () => [],
        initializeApp: /** Captures configuration without SDK calls. */ (config) => ({ options: config }) };
    },
  });
  return exports.isTestingFirebaseProject;
}

const organizations = {};
runInNewContext(organizationsSource, {
  exports: organizations,
  require: /** No Firestore function is executed while evaluating role helpers. */ (name) => {
    assert.ok(['firebase/firestore', './firebaseFirestore'].includes(name));
    return {};
  },
});

/** Evaluates the page's unchanged authenticated-user and organization-role expressions. */
function roleGate(name, user, metricsMember) {
  const expression = declarations.get(name);
  assert.ok(expression, name);
  return runInNewContext(expression.getText(pageSource), { user, metricsMember, ...organizations });
}

test('demo identity disables TEST-only metrics and foreign configurations fail closed', () => {
  assert.equal(projectGate(DEMO_PROJECT_ID), false);
  for (const projectId of ['sales-feedback-agent', 'sales-banking-agent', 'other-test', '', undefined]) {
    assert.throws(() => projectGate(projectId));
  }
});

test('call-detail wiring retains the reviewer boundary and the exact project gate',
  /** Prevents a future JSX edit from bypassing either gate or exposing generation to supervisors. */ () => {
    assert.ok(panel);
    const boundary = panel.parent;
    assert.ok(ts.isParenthesizedExpression(boundary));
    assert.ok(ts.isBinaryExpression(boundary.parent));
    assert.equal(boundary.parent.operatorToken.kind, ts.SyntaxKind.AmpersandAmpersandToken);
    assert.equal(boundary.parent.left.getText(pageSource), 'canViewConversationMetrics');
    const props = new Map(panel.attributes.properties.map(
      /** Reads each actual JSX attribute value. */ (attribute) => [attribute.name.getText(pageSource), attribute.initializer.expression.getText(pageSource)]));
    assert.equal(props.get('geminiReviewAvailable'), 'isTestingFirebaseProject');
    assert.equal(props.get('canRequestGeminiReview'), 'canRequestGeminiReview');
  });

test('only authenticated matching Consubanco supervisor/admin memberships may view; only admins may request',
  /** Uses real organization helpers and page expressions for every access combination. */ () => {
    for (const role of ['admin', 'supervisor', 'agent', 'member', null]) {
      for (const organizationId of ['consubanco', 'another-org']) {
        for (const uid of ['viewer', 'previous-viewer']) {
          const member = { uid, organizationId, role };
          const expectedView = uid === 'viewer' && organizationId === 'consubanco' && ['admin', 'supervisor'].includes(role);
          const expectedRequest = expectedView && role === 'admin';
          assert.equal(roleGate('canViewConversationMetrics', { uid: 'viewer' }, member), expectedView);
          assert.equal(roleGate('canRequestGeminiReview', { uid: 'viewer' }, member), expectedRequest);
          assert.equal(roleGate('canViewConversationMetrics', null, member), false);
          assert.equal(roleGate('canRequestGeminiReview', null, member), false);
        }
      }
    }
    assert.equal(roleGate('canViewConversationMetrics', { uid: 'viewer' }, null), false);
    assert.equal(roleGate('canRequestGeminiReview', { uid: 'viewer' }, null), false);
  });
