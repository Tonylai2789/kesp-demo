import { consumeDemoApiState, enforceDemoApiLimit } from '../demoApiLimits';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const NOW = Date.UTC(2026, 9, 3, 12);

test('shared login gets six paid attempts per hour across endpoints', () => {
  let state: ReturnType<typeof consumeDemoApiState> | undefined;
  for (let i = 0; i < 6; i++) state = consumeDemoApiState(state, NOW, 'paid', 'user');
  expect(() => consumeDemoApiState(state, NOW, 'paid', 'user')).toThrow(expect.objectContaining({ code: 'resource-exhausted' }));
  expect(() => consumeDemoApiState(state, NOW, 'general', 'user')).not.toThrow();
  expect(() => consumeDemoApiState(state, NOW + 3600000, 'paid', 'user')).not.toThrow();
});

test('paid daily cap survives hourly rollover', () => {
  let state: ReturnType<typeof consumeDemoApiState> | undefined;
  for (let i = 0; i < 20; i++) state = consumeDemoApiState(state, NOW + Math.floor(i / 6) * 3600000, 'paid', 'user');
  expect(() => consumeDemoApiState(state, NOW + 4 * 3600000, 'paid', 'user')).toThrow(expect.objectContaining({ code: 'resource-exhausted' }));
  expect(() => consumeDemoApiState(state, NOW + 86400000, 'paid', 'user')).not.toThrow();
});

test.each(['general', 'report'] as const)('%s minute window has an exact boundary and safe retry duration', kind => {
  let state: ReturnType<typeof consumeDemoApiState> | undefined;
  const limit = kind === 'general' ? 60 : 6;
  for (let i = 0; i < limit; i++) state = consumeDemoApiState(state, NOW, kind, 'user');
  expect(() => consumeDemoApiState(state, NOW + 1000, kind, 'user')).toThrow(expect.objectContaining({ code: 'resource-exhausted', details: { retryAfterSeconds: 59 } }));
  expect(() => consumeDemoApiState(state, NOW + 60000, kind, 'user')).not.toThrow();
});

test('global caps accumulate across users and categories share the general quota', () => {
  let state: ReturnType<typeof consumeDemoApiState> | undefined;
  for (let i = 0; i < 12; i++) state = consumeDemoApiState(state, NOW, 'paid', 'global');
  expect(() => consumeDemoApiState(state, NOW, 'paid', 'global')).toThrow(expect.objectContaining({ code: 'resource-exhausted' }));
  expect(state?.counters.general_60000.count).toBe(12);
});

test.each(['general', 'report'] as const)('%s daily cap survives minute rollover', kind => {
  let state: ReturnType<typeof consumeDemoApiState> | undefined;
  const dailyLimit = kind === 'general' ? 5000 : 60;
  const minuteLimit = kind === 'general' ? 60 : 6;
  for (let i = 0; i < dailyLimit; i++) state = consumeDemoApiState(state, NOW + Math.floor(i / minuteLimit) * 60000, kind, 'user');
  expect(() => consumeDemoApiState(state, NOW + 3 * 3600000, kind, 'user')).toThrow(expect.objectContaining({ code: 'resource-exhausted' }));
});

test.each([
  ['preparedTranscriptionUpload', 'prepareConsubancoTranscriptionUpload', 'onPaidCall'],
  ['reprocess', 'reprocessCall', 'onPaidCall'],
  ['startAgentAnalysis', 'startAgentAnalysis', 'onPaidCall'],
  ['agentProfileAssistant', 'askAgentProfileAssistant', 'onPaidCall'],
  ['manualShortCallReview', 'refreshManualShortCallPatterns', 'onPaidCall'],
  ['cccRuntimeErrors', 'retryCccRuntimeFailures', 'onPaidCall'],
  ['refreshAgentActivity', 'refreshAgentActivity', 'onPaidCall'],
  ['assignUnrecognizedCallToAgent', 'assignUnrecognizedCallToAgent', 'onPaidCall'],
  ['repairAgentProfileCallLinks', 'repairAgentProfileCallLinks', 'onPaidCall'],
  ['demoReports', 'generateAgentCoachingReport', 'onReportCall'],
])('%s exports %s through its server-owned limit class', (file, endpoint, expected) => {
  const source = ts.createSourceFile(file + '.ts', readFileSync(join(__dirname, '..', file + '.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = new Map<string, string>();
  let factory: string | undefined;
  source.forEachChild(node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './demoHttps') {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) bindings.elements.forEach(item => imports.set(item.name.text, item.propertyName?.text ?? item.name.text));
    }
    if (ts.isVariableStatement(node)) node.declarationList.declarations.forEach(item => {
      if (ts.isIdentifier(item.name) && item.name.text === endpoint && item.initializer && ts.isCallExpression(item.initializer) && ts.isIdentifier(item.initializer.expression)) factory = item.initializer.expression.text;
    });
  });
  expect(imports.get(factory ?? '')).toBe(expected);
});

test.each([null, {}, { counters: [] }, { counters: { general_60000: { start: NOW, count: -1 } } },
  { counters: { general_60000: { start: NOW, count: NaN } } },
  { counters: { general_60000: { start: NOW + 60000, count: 0 } } }])('corrupt or future state never resets the limit', state => {
  expect(() => consumeDemoApiState(state, NOW, 'general', 'user')).toThrow(expect.objectContaining({ code: 'unavailable' }));
});

test('a rejected transaction never changes counters; database failures fail closed', async () => {
  let state: ReturnType<typeof consumeDemoApiState> | undefined;
  for (let i = 0; i < 6; i++) state = consumeDemoApiState(state, NOW, 'paid', 'user');
  const set = jest.fn();
  const db = { doc: (path: string) => path, runTransaction: async (fn: (tx: unknown) => unknown) => fn({
    get: async (path: string) => ({ exists: path.includes('user_'), data: () => state }), set,
  }) } as unknown as FirebaseFirestore.Firestore;
  await expect(enforceDemoApiLimit('reviewer', 'paid', db, NOW)).rejects.toMatchObject({ code: 'resource-exhausted' });
  expect(set).not.toHaveBeenCalled();
  db.runTransaction = jest.fn().mockRejectedValue(new Error('private database detail'));
  await expect(enforceDemoApiLimit('reviewer', 'general', db, NOW)).rejects.toMatchObject({ code: 'unavailable' });
});
