import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDemoMaskedValue, redactUnmaskedDemoText } from '../../functions/src/demoIdentity.ts';
import {
  maskKespDemoAgentDisplayName, maskKespDemoCallDisplayName, maskKespDemoCallString,
  maskKespDemoTranscriptText, maskKespDemoEvidenceText, maskKespDemoExcerptText,
  redactKespDemoText, registerKespDemoAgentAnalysisTerms, registerKespDemoCallTerms,
  registerKespDemoAgentReportTerms, registerKespDemoWorkflowRowTerms,
  resetKespDemoRedactionState,
} from './kespDemoRedaction.ts';

const label = id => `AGENTE-${createHash('sha256').update(id).digest('hex').slice(0, 12).toUpperCase()}`;
const profiles = [
  { id: 'profile-a', salesAgentId: 'canonical-agent-a', salesAgentName: 'Ana FictionalAlpha' },
  { id: 'profile-b', salesAgentId: 'canonical-agent-b', salesAgentName: 'Eva FictionalBeta' },
];
beforeEach(resetKespDemoRedactionState);

test('canonical labels survive reloads and reversed profile/call registration order', () => {
  for (const order of [profiles, [...profiles].reverse()]) {
    resetKespDemoRedactionState();
    for (const profile of order) registerKespDemoAgentAnalysisTerms(profile);
    for (const profile of profiles) {
      const before = structuredClone(profile);
      registerKespDemoCallTerms({ ...profile, id: 'call-a' });
      assert.equal(maskKespDemoAgentDisplayName(profile.salesAgentName), label(profile.salesAgentId));
      assert.equal(redactKespDemoText(profile.salesAgentName), label(profile.salesAgentId));
      assert.equal(redactKespDemoText(profile.salesAgentId), label(profile.salesAgentId));
      assert.deepEqual(profile, before);
    }
  }
});

test('same name with different IDs has distinct labels and ambiguous name-only calls fail closed', () => {
  for (const order of [profiles, [...profiles].reverse()]) {
    resetKespDemoRedactionState();
    for (const profile of order) registerKespDemoAgentAnalysisTerms({ ...profile, salesAgentName: 'Same FictionalName' });
    for (const profile of profiles) assert.equal(maskKespDemoAgentDisplayName('Same FictionalName', profile.salesAgentId), label(profile.salesAgentId));
    assert.equal(maskKespDemoAgentDisplayName('Same FictionalName'), '*AGENTE DEMO*');
    assert.equal(redactKespDemoText('Same FictionalName'), '*AGENTE DEMO*');
  }
});

test('unknown identities fail closed then bind to a canonical ID without storing display mutations', () => {
  assert.equal(maskKespDemoAgentDisplayName('PrivateName'), '*AGENTE DEMO*');
  assert.equal(maskKespDemoAgentDisplayName(null), '*AGENTE DEMO*');
  registerKespDemoCallTerms({ salesAgentName: 'PrivateName' });
  assert.equal(redactKespDemoText('PrivateName'), '*AGENTE DEMO*');
  registerKespDemoCallTerms({ salesAgentName: 'PrivateName', salesAgentId: 'id-b' });
  assert.equal(maskKespDemoAgentDisplayName('PrivateName'), label('id-b'));
  assert.equal(redactKespDemoText('PrivateName'), label('id-b'));
});

test('all registered accented aliases are masked and shared aliases remain order-independent', () => {
  for (const names of [['Jos\u00e9', 'Jose'], ['Jose', 'Jos\u00e9']]) {
    resetKespDemoRedactionState();
    for (const salesAgentName of names) registerKespDemoCallTerms({ salesAgentId: 'same-id', salesAgentName });
    for (const name of names) assert.equal(redactKespDemoText(name), label('same-id'));
    registerKespDemoCallTerms({ salesAgentId: 'other-id', salesAgentName: names[0] });
    for (const name of names) assert.equal(redactKespDemoText(name), '*AGENTE DEMO*');
  }
});

test('canonicalSalesAgentId wins over legacy aliases and all registered name fragments are masked', () => {
  registerKespDemoCallTerms({ canonicalSalesAgentId: 'canonical-id', salesAgentId: 'legacy-id', salesAgentName: 'Ana Fictional-Surname', matchedAgentName: 'Ana' });
  const expected = label('canonical-id');
  for (const value of ['canonical-id', 'legacy-id', 'Ana Fictional-Surname', 'Ana', 'Fictional', 'Surname']) {
    assert.equal(redactKespDemoText(value), expected, value);
  }
  assert.equal(redactKespDemoText('analizar el cierre'), 'analizar el cierre');
});

test('short initials and Spanish connectors remain readable but whole names and meaningful fragments are hidden', () => {
  const name = 'Ana de la Fictional A.';
  registerKespDemoAgentAnalysisTerms({ salesAgentId: 'connector-agent', salesAgentName: name });
  const expected = label('connector-agent');
  assert.equal(redactKespDemoText(`${name}: Ana de la Fictional.`), `${expected}: ${expected} de la ${expected}.`);
  const ordinary = 'A. partir de la llamada, explicar el cierre y las condiciones.';
  assert.equal(redactKespDemoText(ordinary), ordinary);
});

test('arbitrary asterisk-wrapped sensitive strings are never accepted as generated masks', () => {
  for (const value of ['*PrivateName*', '*AGENTE PRIVATE*', '*CLIENTE SECRET*', 'AGENTE-1234', '*sensitive*']) {
    assert.equal(isDemoMaskedValue(value), false);
    assert.equal(maskKespDemoAgentDisplayName(value), '*AGENTE DEMO*');
    assert.equal(maskKespDemoAgentDisplayName(value, 'canonical-id'), label('canonical-id'));
  }
  registerKespDemoCallTerms({ salesAgentId: 'canonical-id', salesAgentName: '*PrivateName*' });
  assert.equal(redactKespDemoText('*PrivateName*'), label('canonical-id'));
});

test('existing placeholders and hashes survive display helpers, registration and repeated DOM-text passes', () => {
  const masks = ['*AGENTE 01*', '*ID AGENTE 03*', '*CLIENTE 02*', '*ID CLIENTE*',
    '*LLAMADA DEMO* 04', '1377-*LLAMADA DEMO*', 'AGENTE-123456789012',
    maskKespDemoTranscriptText(), maskKespDemoEvidenceText(), maskKespDemoExcerptText()];
  registerKespDemoAgentAnalysisTerms({ salesAgentId: '1234567', salesAgentName: 'AGENTE' });
  for (const mask of masks) {
    registerKespDemoAgentReportTerms({ salesAgentId: mask, salesAgentName: mask });
    assert.equal(maskKespDemoAgentDisplayName(mask, 'other-id'), mask);
    assert.equal(maskKespDemoCallDisplayName(mask), mask);
    assert.equal(maskKespDemoCallString(mask), mask);
    assert.equal(redactKespDemoText(mask), mask);
    assert.equal(redactKespDemoText(`Antes ${mask} despues`), `Antes ${mask} despues`);
  }
  const result = redactKespDemoText('AGENTE / 1234567');
  assert.equal(result, `${label('1234567')} / ${label('1234567')}`);
  assert.equal(redactKespDemoText(result), result);
});

test('call and evidence masks retain no partial filename or identifier prefix', () => {
  registerKespDemoCallTerms({ salesAgentId: '56789', salesAgentName: 'Ana Example' });
  assert.equal(redactKespDemoText('ccc_1377_56789_private'), '*ID DEMO*');
  assert.equal(redactKespDemoText('folder/1377-56789-private.wav'), '1377-*LLAMADA DEMO*');
  assert.equal(maskKespDemoCallString('private-name.wav'), '*LLAMADA DEMO*');
  assert.equal(maskKespDemoTranscriptText(), '*TRANSCRIPCION OCULTA PARA DEMO*');
  assert.equal(maskKespDemoEvidenceText(), '*EVIDENCIA OCULTA PARA DEMO*');
  assert.equal(maskKespDemoExcerptText(), '*FRAGMENTO OCULTO PARA DEMO*');
});

test('only bounded generated call counters are protected; arbitrary trailing digits stay redactable', () => {
  const sensitive = '5551234567';
  for (const mask of ['*AGENTE 01*', '*CLIENTE 02*', '*ID CLIENTE*', '*DATO DEMO*', '*ID DEMO*',
    '*LLAMADA DEMO*', '1377-*LLAMADA DEMO*', '*LLAMADA DEMO* 04',
    maskKespDemoTranscriptText(), maskKespDemoEvidenceText(), maskKespDemoExcerptText(), 'AGENTE-123456789012']) {
    const value = `${mask} ${sensitive}`;
    assert.equal(isDemoMaskedValue(value), false, value);
    assert.equal(redactUnmaskedDemoText(value, text => text.replaceAll(sensitive, '*ID CLIENTE*')), `${mask} *ID CLIENTE*`);
    assert.equal(redactKespDemoText(value), `${mask} *ID CLIENTE*`);
  }
  for (const counter of ['01', '99', '100', '249', '250']) {
    const value = `*LLAMADA DEMO* ${counter}`;
    assert.equal(isDemoMaskedValue(value), true, value);
    assert.equal(redactUnmaskedDemoText(value, () => ''), value);
  }
  for (const counter of ['1', '00', '001', '251', '999', '2500', sensitive]) {
    const value = `*LLAMADA DEMO* ${counter}`;
    assert.equal(isDemoMaskedValue(value), false, value);
    assert.equal(redactUnmaskedDemoText(value, text => text.replaceAll(counter, '*ID DEMO*')), '*LLAMADA DEMO* *ID DEMO*');
  }
  for (const value of ['*AGENTE 01* 04', '*CLIENTE 02* 04', `*CLIENTE ${sensitive}*`, `*AGENTE ${sensitive}*`]) {
    assert.equal(isDemoMaskedValue(value), false, value);
  }
});

test('browser SHA-256 exactly matches the Node crypto PDF label contract', () => {
  for (const id of ['canonical-agent-a', 'canonical-agent-b', 'abc', 'agentPrivateId', 'CaseSensitive', 'casesensitive', ' ID with spaces ', '\u00e1gente']) {
    assert.equal(maskKespDemoAgentDisplayName('Private Name', id), label(id));
  }
  assert.equal(maskKespDemoAgentDisplayName('Private Name', 'abc'), 'AGENTE-BA7816BF8F01');
});

test('workflow names share the profile label; EmailReports supplies canonical selector and preview context', () => {
  registerKespDemoWorkflowRowTerms(profiles[0]);
  assert.equal(maskKespDemoAgentDisplayName(profiles[0].salesAgentName), label(profiles[0].salesAgentId));
  const page = readFileSync(new URL('../pages/kesp/EmailReportsPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /maskKespDemoAgentDisplayName\(row.salesAgentName, row.salesAgentId\)/);
  assert.match(page, /maskKespDemoAgentDisplayName\(report.agent.salesAgentName, salesAgentId\)/);
  assert.match(page, /CoachingReportPreview report=\{report\} salesAgentId=\{agentId\}/);
  assert.match(page, /value=\{row.salesAgentId\}/);
});

test('call and runtime displays supply canonical IDs instead of ambiguous name-only lookup', () => {
  const pages = [
    ['LlamadasPage', 'maskKespDemoAgentDisplayName(c.salesAgentName, c.canonicalSalesAgentId ?? c.salesAgentId)'],
    ['ShortCallDetailPage', 'maskKespDemoAgentDisplayName(call.salesAgentName, call.canonicalSalesAgentId ?? call.salesAgentId)'],
    ['RuntimeErrorsPage', 'maskKespDemoAgentDisplayName(name, id)'],
    ['RuntimeErrorsPage', 'maskKespDemoAgentDisplayName(row.salesAgentName ?? row.salesAgentId, row.salesAgentId)'],
    ['RuntimeErrorsPage', 'maskKespDemoAgentDisplayName(agents.find(([id]) => id === agentFilter)?.[1] ?? agentFilter, agentFilter)'],
  ];
  for (const [page, boundary] of pages) {
    const source = readFileSync(new URL(`../pages/kesp/${page}.tsx`, import.meta.url), 'utf8');
    assert.ok(source.includes(boundary), `${page}: ${boundary}`);
  }
});

test('assignment selectors mask names by canonical ID without changing profile keys or option values', () => {
  for (const page of ['CallDetailPage', 'UnrecognizedCallsPage']) {
    const source = readFileSync(new URL(`../pages/kesp/${page}.tsx`, import.meta.url), 'utf8');
    assert.match(source, /<option key=\{agent.id\} value=\{agent.id\}>\s*\{maskKespDemoAgentDisplayName\(agent.salesAgentName, agent.salesAgentId\)\}/);
  }
  const runtime = readFileSync(new URL('../pages/kesp/RuntimeErrorsPage.tsx', import.meta.url), 'utf8');
  assert.match(runtime, /<option key=\{id\} value=\{id\}>\{maskKespDemoAgentDisplayName\(name, id\)\}/);
  const users = readFileSync(new URL('../pages/kesp/UsersPage.tsx', import.meta.url), 'utf8');
  assert.match(users, /<option key=\{profile.id\} value=\{profile.id\}>\{maskKespDemoAgentDisplayName\(profile.name, profile.salesAgentId\)\}/);
  assert.match(users, /maskKespDemoAgentDisplayName\(chosenProfile.name, chosenProfile.salesAgentId\)/);
  assert.match(users, /maskKespDemoAgentDisplayName\(beforeProfile, beforeProfileSalesAgentId\)/);
});
