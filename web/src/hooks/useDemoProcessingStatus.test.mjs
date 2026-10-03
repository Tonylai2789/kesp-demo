import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('./useDemoProcessingStatus.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const ready = { enabled: true, remainingMicros: 10_033_729, activeSlots: 0, maxActiveSlots: 2, pauseReason: null, canStart: true };

function fixture(query = {}, uid = 'viewer') {
  let options;
  let reads = 0;
  const modules = {
    react: { useCallback: (fn) => fn },
    '@/contexts/useAuth': { useAuth: () => ({ user: uid ? { uid } : null }) },
    '@/services/functions': { getDemoProcessingStatus: async () => ready },
    '@tanstack/react-query': { useQuery: (input) => {
      options = input;
      return { data: ready, isError: false, isPending: false, isFetching: false,
        refetch: async () => { reads++; return { data: ready, isError: false }; }, ...query };
    } },
  };
  const exports = {};
  runInNewContext(source, { exports, require: (name) => modules[name] });
  return { result: exports.useDemoProcessingStatus(), options, reads: () => reads };
}

test('authenticated on-mount read and 30-second polling, with no retries or mutation', async () => {
  const { result, options, reads } = fixture();
  assert.equal(options.refetchOnMount, 'always');
  assert.equal(options.refetchInterval, 30_000);
  assert.equal(options.refetchIntervalInBackground, true);
  assert.equal(options.retry, false);
  assert.equal(options.staleTime, 0);
  assert.deepEqual(Array.from(options.queryKey), ['demo-processing-status', 'viewer']);
  assert.equal(result.canStart, true);
  assert.equal(await result.checkCanStart(), true);
  assert.equal(reads(), 1);
});

for (const pauseReason of ['paused', 'budget_exhausted', 'capacity', 'unavailable']) {
  test(pauseReason + ' never admits work, even with inconsistent canStart', () => {
    assert.equal(fixture({ data: { ...ready, pauseReason } }).result.canStart, false);
  });
}

test('initial loading, polling errors, stale data, malformed fields and signed-out state fail closed', async () => {
  for (const query of [
    { data: undefined, isPending: true }, { isError: true }, { isFetching: true },
    ...[{ enabled: false }, { canStart: false }, { remainingMicros: 0 }, { remainingMicros: NaN },
      { activeSlots: 2 }, { activeSlots: -1 }, { maxActiveSlots: 3 }].map((patch) => ({ data: { ...ready, ...patch } })),
  ]) assert.equal(fixture(query).result.canStart, false);
  const signedOut = fixture({}, null);
  assert.equal(signedOut.options.enabled, false);
  assert.equal(signedOut.result.canStart, false);
  assert.equal(await signedOut.result.checkCanStart(), false);
  assert.equal(signedOut.reads(), 0);
});

test('action preflight uses the fresh server answer and fails closed on errors', async () => {
  for (const refetch of [
    async () => ({ data: { ...ready, canStart: false }, isError: false }),
    async () => ({ data: ready, isError: true }),
    async () => { throw new Error('unavailable'); },
  ]) assert.equal(await fixture({ refetch }).result.checkCanStart(), false);
});
