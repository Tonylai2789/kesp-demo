import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function fixture(filename, { deferred = false, isDemoFirebaseProject = true } = {}) {
  const queries = [];
  const writes = [];
  const listeners = [];
  const firestore = {
    collection: (_db, name) => name,
    doc: (collection) => ({ id: 'new-profile', collection }),
    Timestamp: { now: () => 'test-timestamp' },
    setDoc: async (ref, data) => { writes.push({ ref, data }); },
    where: (field, op, value) => ({ field, op, value }),
    orderBy: (field, order) => ({ field, order }),
    query: (collection, ...constraints) => ({ collection, constraints }),
    onSnapshot: (query, callback, error) => {
      queries.push(query);
      const listener = { callback, error, stopped: false };
      listeners.push(listener);
      if (!deferred) callback({ docs: [] });
      return () => { listener.stopped = true; };
    },
  };
  const modules = {
    'firebase/firestore': firestore,
    'firebase/functions': { httpsCallable: () => () => {} },
    './firebase': { db: {} }, './firebaseFirestore': { db: {} }, './firebaseFunctions': { functions: {} },
    './firebaseApp': { isDemoFirebaseProject },
    '@/lib/kespDemoRedaction': { registerKespDemoAgentAnalysisTerms: () => {} }, '@/lib/callDates': {},
  };
  const source = ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(source, { exports, console, require: (name) => { assert.ok(name in modules, name); return modules[name]; } });
  return { service: exports, queries, writes, listeners };
}

function profile(id, salesAgentId, shared = false) {
  return { id, data: () => ({
    salesAgentId, salesAgentName: 'Same display name', uploadedBy: 'viewer',
    createdAt: { toDate: () => new Date(0) },
    ...(shared ? { organizationId: 'consubanco', visibilityScope: 'organization' } : {}),
  }) };
}

test('demo canonical identity deduplicates different documents and prefers shared profile without collapsing names', () => {
  const { service, listeners } = fixture('./agentAnalyses.ts', { deferred: true });
  let rows;
  service.subscribeToManualAgentProfiles('viewer', (next) => { rows = next; });
  listeners[0].callback({ docs: [profile('owned-copy', 'agent-a'), profile('distinct-agent', 'agent-b')] });
  listeners[1].callback({ docs: [profile('shared-canonical', 'agent-a', true)] });
  assert.deepEqual(Array.from(rows, (row) => row.id), ['shared-canonical', 'distinct-agent']);
  // Later owned snapshots still cannot replace the shared navigation target.
  listeners[0].callback({ docs: [profile('new-owned-copy', 'agent-a'), profile('distinct-agent', 'agent-b')] });
  assert.deepEqual(Array.from(rows, (row) => row.id), ['shared-canonical', 'distinct-agent']);
});

test('shared demo profile wins even when encountered before a private duplicate', () => {
  const { service, listeners } = fixture('./agentAnalyses.ts', { deferred: true });
  let rows;
  service.subscribeToManualAgentProfiles('viewer', (next) => { rows = next; });
  listeners[0].callback({ docs: [profile('shared-first', 'agent-a', true), profile('private-last', 'agent-a')] });
  listeners[1].callback({ docs: [] });
  assert.deepEqual(Array.from(rows, (row) => row.id), ['shared-first']);
});

test('demo uses exact canonical IDs and missing IDs fall back to a separate document identity', () => {
  const { service, listeners } = fixture('./agentAnalyses.ts', { deferred: true });
  let rows;
  service.subscribeToManualAgentProfiles('viewer', (next) => { rows = next; });
  listeners[0].callback({ docs: [
    profile('fallback', undefined), profile('other-fallback', ''),
    profile('canonical', 'fallback'), profile('uppercase', 'AGENT'), profile('lowercase', 'agent'),
  ] });
  listeners[1].callback({ docs: [profile('fallback', undefined, true)] });
  assert.deepEqual(Array.from(rows, (row) => row.id), ['fallback', 'other-fallback', 'canonical', 'uppercase', 'lowercase']);
  assert.equal(rows[0].visibilityScope, 'organization');
});

test('non-demo merging still deduplicates document IDs only', () => {
  const { service, listeners } = fixture('./agentAnalyses.ts', { deferred: true, isDemoFirebaseProject: false });
  let rows;
  service.subscribeToAgentAnalyses('viewer', (next) => { rows = next; });
  listeners[0].callback({ docs: [profile('owned-copy', 'agent-a'), profile('overlap', 'agent-a')] });
  listeners[1].callback({ docs: [profile('shared-copy', 'agent-a', true), profile('overlap', 'agent-a', true)] });
  assert.deepEqual(Array.from(rows, (row) => row.id), ['owned-copy', 'overlap', 'shared-copy']);
});

test('Manual Profiles merges owned and permitted shared profiles, waits for both, and deduplicates canonical IDs', () => {
  const { service, queries, listeners } = fixture('./agentAnalyses.ts', { deferred: true });
  const emissions = [];
  const unsubscribe = service.subscribeToManualAgentProfiles('viewer', (rows) => emissions.push(rows));
  assert.equal(queries.length, 2);
  assert.ok(queries[0].constraints.some((c) => c.field === 'uploadedBy' && c.value === 'viewer'));
  assert.ok(queries[1].constraints.some((c) => c.field === 'organizationId' && c.value === 'consubanco'));
  assert.ok(queries[1].constraints.some((c) => c.field === 'visibilityScope' && c.value === 'organization'));
  const profile = (id, data = {}) => ({ id, data: () => ({ salesAgentId: id, createdAt: { toDate: () => new Date(0) }, ...data }) });
  listeners[0].callback({ docs: [profile('owned'), profile('shared')] });
  assert.equal(emissions.length, 0);
  listeners[1].callback({ docs: [profile('shared', { uploadedBy: 'other-owner' }), profile('reconstructed')] });
  assert.deepEqual(Array.from(emissions.at(-1), (row) => row.id), ['owned', 'shared', 'reconstructed']);
  listeners[1].error(new Error('permission-denied'));
  assert.deepEqual(Array.from(emissions.at(-1), (row) => row.id), ['owned', 'shared']);
  listeners[0].error(new Error('permission-denied'));
  assert.equal(emissions.at(-1).length, 0);
  unsubscribe();
  assert.ok(listeners.every((listener) => listener.stopped));
});

test('new manual profiles use fixed shared demo scope without accepting privileged input fields', async () => {
  const { service, writes } = fixture('./agentAnalyses.ts');
  const id = await service.createAgentAnalysis({ uploadedBy: 'signed-in-viewer', salesAgentName: 'Agente de ejemplo',
    organizationId: 'foreign', visibilityScope: 'user', demoProvenance: { forged: true }, isCccCanonicalProfile: true,
    profileSource: 'ccc_mapping', salesAgentId: 'forged-agent', status: 'complete' });
  assert.equal(id, 'new-profile');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].data)), {
    uploadedBy: 'signed-in-viewer', organizationId: 'consubanco', visibilityScope: 'organization',
    salesAgentId: 'agent_new-profile', salesAgentName: 'Agente de ejemplo', status: 'ready', error: null,
    createdAt: 'test-timestamp', updatedAt: 'test-timestamp',
  });
});

test('shared manual demo profiles are queried by organization without CCC canonical provenance', () => {
  const { service, queries } = fixture('./agentAnalyses.ts');
  service.subscribeToAutomaticAgentProfiles(() => {});
  assert.equal(queries.length, 1);
  const constraints = queries[0].constraints;
  assert.ok(constraints.some((c) => c.field === 'organizationId' && c.value === 'consubanco'));
  assert.ok(constraints.some((c) => c.field === 'visibilityScope' && c.value === 'organization'));
  assert.ok(!constraints.some((c) => c.field === 'isCccCanonicalProfile'));
  const manual = { organizationId: 'consubanco', visibilityScope: 'organization', profileSource: 'manual' };
  assert.equal(service.isSharedDemoAgentProfile(manual), true);
  assert.equal(service.isCanonicalAutomaticAgentProfile(manual), false);
  assert.equal(service.isSharedDemoAgentProfile({ ...manual, visibilityScope: 'user' }), false);
  assert.equal(service.isSharedDemoAgentProfile({ ...manual, organizationId: 'foreign' }), false);
});

test('agent linked calls merge owned and shared manual queries without CCC source constraint', () => {
  const { service, queries } = fixture('./firestore.ts');
  service.subscribeToAgentLinkedCalls({ userId: 'viewer', agentAnalysisId: 'demo-profile', salesAgentId: 'demo-agent' }, () => {});
  assert.equal(queries.length, 4);
  const shared = queries.filter((q) => q.constraints.some((c) => c.field === 'visibilityScope'));
  assert.equal(shared.length, 2);
  for (const { constraints } of shared) {
    assert.ok(constraints.some((c) => c.field === 'organizationId' && c.value === 'consubanco'));
    assert.ok(!constraints.some((c) => c.field === 'callSource' || c.field === 'uploadedBy'));
  }
  assert.ok(shared.some((q) => q.constraints.some((c) => c.field === 'salesAgentId' && c.value === 'demo-agent')));
  assert.ok(shared.some((q) => q.constraints.some((c) => c.field === 'matchedAgentAnalysisId' && c.value === 'demo-profile')));
});
