import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { DEMO_PROJECT_ID, DEMO_PASSWORD_USERNAME, DEMO_PASSWORD_EMAIL, DEMO_PASSWORD_UID, assertDemoFirebaseConfig, isDemoGoogleIdentity, isDemoIdentity, getDemoPasswordEmail, validateDemoAudioLimits } from './demoPolicy.ts';
import { previousDemoWeek } from './demoReportPeriod.ts';
import { isKespDemoRedactionEnabled, setKespDemoRedactionEnabled, resetKespDemoRedactionState, maskKespDemoAgentDisplayName, maskKespDemoCallString } from './kespDemoRedaction.ts';
import { prepareAccessUpdate, resolveAccessTarget } from './userPermissions.ts';
import { CONSUBANCO_AGENT_NAMES, CONSUBANCO_AGENTS } from './consubancoAgents.ts';

const DEMO_EMAILS = ['admin@example.com', 'supervisor@example.com', 'new-reviewer@example.com'];

test('demo source has no prototype roster fixture or legacy recipient defaults', () => {
  assert.equal(existsSync(new URL('../data/kespMock.ts', import.meta.url)), false);
  assert.deepEqual(CONSUBANCO_AGENT_NAMES, []);
  assert.deepEqual(CONSUBANCO_AGENTS, []);
  for (const locale of ['en', 'es']) {
    const messages = JSON.parse(readFileSync(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8'));
    assert.equal(messages.kesp.emailReports.confirmDemo, undefined);
    assert.equal(messages.kesp.emailReports.actions.demoIvan, undefined);
    assert.equal(messages.kesp.emailReports.actions.seedIvan, undefined);
    assert.doesNotMatch(JSON.stringify(messages), /ccc[_-]1377[_-][a-z0-9]+|1377-\d{4,}/i);
  }
});

const config = { projectId: DEMO_PROJECT_ID, authDomain: DEMO_PROJECT_ID + '.firebaseapp.com', storageBucket: DEMO_PROJECT_ID + '.firebasestorage.app', apiKey: 'public-client-key', appId: 'demo-app', messagingSenderId: '337829671131' };
test('exact isolated configuration passes; missing and foreign identity fields fail closed', () => {
  assert.doesNotThrow(() => assertDemoFirebaseConfig(config));
  for (const key of Object.keys(config)) assert.throws(() => assertDemoFirebaseConfig({ ...config, [key]: '' }));
  for (const key of ['projectId', 'authDomain', 'storageBucket']) assert.throws(() => assertDemoFirebaseConfig({ ...config, [key]: 'foreign-project' }));
});
test('Google identity checks provider and verification, not a frontend approval list', () => {
  for (const email of DEMO_EMAILS) assert.equal(isDemoGoogleIdentity(email.toUpperCase(), true, 'google.com'), true);
  for (const email of [null, undefined, '', ' ']) assert.equal(isDemoGoogleIdentity(email, true, 'google.com'), false);
  assert.equal(isDemoGoogleIdentity(DEMO_EMAILS[0], false, 'google.com'), false);
  assert.equal(isDemoGoogleIdentity(DEMO_EMAILS[0], true, 'password'), false);
  assert.equal(isDemoGoogleIdentity(DEMO_PASSWORD_EMAIL, true, 'google.com'), false);
  assert.equal(isDemoGoogleIdentity(DEMO_PASSWORD_EMAIL.toUpperCase(), true, 'google.com'), false);
});
test('only the exact public supervisor username maps to the internal password account', () => {
  assert.equal(DEMO_PASSWORD_USERNAME, 'demo-supervisor');
  assert.equal(DEMO_PASSWORD_EMAIL, 'demo-supervisor@kesp-demo.invalid');
  assert.equal(DEMO_PASSWORD_UID, 'kesp-demo-supervisor');
  assert.equal(getDemoPasswordEmail(DEMO_PASSWORD_USERNAME), DEMO_PASSWORD_EMAIL);
  for (const username of ['', 'supervisor', 'Demo-supervisor', ' demo-supervisor', 'demo-supervisor ', DEMO_PASSWORD_EMAIL, ...DEMO_EMAILS]) {
    assert.equal(getDemoPasswordEmail(username), null, username);
  }
});
test('password identity requires exact UID, email and provider without requiring email verification', () => {
  for (const verified of [false, true]) {
    assert.equal(isDemoIdentity(DEMO_PASSWORD_UID, DEMO_PASSWORD_EMAIL, verified, 'password'), true);
    for (const uid of [undefined, null, '', 'other', DEMO_PASSWORD_UID.toUpperCase(), ` ${DEMO_PASSWORD_UID}`]) {
      assert.equal(isDemoIdentity(uid, DEMO_PASSWORD_EMAIL, verified, 'password'), false);
    }
    for (const email of [undefined, null, '', 'other@example.com', ...DEMO_EMAILS, DEMO_PASSWORD_EMAIL.toUpperCase(), ` ${DEMO_PASSWORD_EMAIL}`, `${DEMO_PASSWORD_EMAIL} `]) {
      assert.equal(isDemoIdentity(DEMO_PASSWORD_UID, email, verified, 'password'), false);
    }
    for (const provider of [undefined, null, '', 'google.com', 'anonymous', 'custom', 'Password', { providerId: 'password' }]) {
      assert.equal(isDemoIdentity(DEMO_PASSWORD_UID, DEMO_PASSWORD_EMAIL, verified, provider), false);
    }
  }
});
test('new Google identities may reach backend approval without weakening reserved password checks', () => {
  for (const email of DEMO_EMAILS) {
    assert.equal(isDemoIdentity('google-user', email.toUpperCase(), true, 'google.com'), true);
    assert.equal(isDemoIdentity('google-user', email, false, 'google.com'), false);
    assert.equal(isDemoIdentity(DEMO_PASSWORD_UID, email, true, 'google.com'), false);
    assert.equal(isDemoIdentity(DEMO_PASSWORD_UID, email.toUpperCase(), true, 'google.com'), false);
    assert.equal(isDemoIdentity(DEMO_PASSWORD_UID, email, true, 'password'), false);
  }
  assert.equal(isDemoIdentity('google-user', 'third@example.com', true, 'google.com'), true);
  for (const provider of ['password', 'anonymous', 'custom', undefined]) {
    assert.equal(isDemoIdentity('google-user', 'third@example.com', true, provider), false);
  }
});
test('auth uses SDK password sign-in, UID-aware authorization and backend membership before publishing', () => {
  const source = readFileSync(new URL('../contexts/AuthContext.tsx', import.meta.url), 'utf8');
  assert.match(source, /getDemoPasswordEmail\(username\)/);
  assert.match(source, /signInWithEmailAndPassword\(auth, email, password\)/);
  assert.match(source, /isDemoIdentity\(candidate.uid, candidate.email, candidate.emailVerified, token.signInProvider\)/);
  assert.match(source, /membership.uid !== candidate.uid/);
  assert.match(source, /membership.organizationId !== 'consubanco'/);
  assert.match(source, /token.signInProvider === 'password' && membership.role !== 'supervisor'/);
  assert.ok(source.indexOf('await ensureConsubancoMembershipForCurrentUser()') < source.indexOf('setUser(candidate)'));
  assert.match(source, /await signOut\(auth\)/);
  assert.doesNotMatch(source, /fetchAllowedEmails|DEMO_EMAILS|DEMO_ADMIN_EMAIL/);
  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|createUserWithEmailAndPassword|sendPasswordResetEmail|failure\.message/);
  const errorSetters = [...source.matchAll(/setError\(([^)]+)\)/g)].map((match) => match[1]);
  assert.ok(errorSetters.every((value) => value === 'null' || value === "'demo.loginFailed'"));
});
test('login offers accessible password and Google controls with generic translated failures', () => {
  const source = readFileSync(new URL('../pages/LoginPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /htmlFor="demo-username"/);
  assert.match(source, /id="demo-username"[^>]*autoComplete="username"[^>]*required/);
  assert.match(source, /htmlFor="demo-password"/);
  assert.match(source, /id="demo-password"[^>]*type="password"[^>]*autoComplete="current-password"[^>]*required/);
  assert.match(source, /fieldset disabled=\{loading\}/);
  assert.match(source, /type="submit" disabled=\{loading\}/);
  assert.match(source, /disabled=\{loading\} onClick=\{signInWithGoogle\}/);
  assert.match(source, /role="alert"[^>]*>\{t\('demo.loginFailed'\)\}/);
  assert.match(source, /aria-describedby=\{error \? 'login-error' : undefined\}/);
  assert.match(source, /if \(loading\) return;/);
  assert.match(source, /setPassword\(''\);\s*await signInWithPassword\(username, password\)/);
  assert.doesNotMatch(source, /\.invalid|DEMO_PASSWORD_EMAIL|type="email"|localStorage|sessionStorage|console\.|signUp|resetPassword|\{error\}/);
  for (const language of ['en', 'es']) {
    const messages = JSON.parse(readFileSync(new URL(`../i18n/${language}.json`, import.meta.url), 'utf8')).demo;
    for (const key of ['supervisorLogin', 'username', 'password', 'loginFailed', 'googleLogin']) {
      assert.equal(typeof messages[key], 'string', `${language}:${key}`);
      assert.ok(messages[key].length > 0);
      assert.doesNotMatch(messages[key], /\.invalid|auth\//);
    }
  }
});
test('masking remains enabled after attempts to disable it or reset state', () => {
  setKespDemoRedactionEnabled(false); resetKespDemoRedactionState(); assert.equal(isKespDemoRedactionEnabled(), true);
});

test('AgentPage masks the seven display boundaries while preserving ordinary labels and raw inputs', () => {
  const source = readFileSync(new URL('../pages/kesp/AgentPage.tsx', import.meta.url), 'utf8');
  for (const boundary of [
    'className="associated-call-phone">{demoMode ? maskKespDemoCallString(phoneLabel) : phoneLabel}',
    'className="associated-call-id">{demoMode ? maskKespDemoCallString(call.id) : call.id}',
    "t('kesp.agent.upload.associatedDescription', { name: demoMode ? maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId) : agent.salesAgentName.split(' ')[0], })",
    "t('kesp.agent.upload.ofAgent', { name: demoMode ? maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId) : agent.salesAgentName.split(' ')[0] })",
    "t('kesp.upload.toasts.uploadError', { file: demoMode ? maskKespDemoCallString(file.name) : file.name, error: validation.error })",
    "t('kesp.agent.upload.uploadError', { file: demoMode ? maskKespDemoCallString(item.file.name) : item.file.name })",
    '{demoMode ? maskKespDemoCallString(f.file.name) : f.file.name}',
  ]) {
    assert.ok(source.replace(/\s+/g, ' ').includes(boundary), boundary);
  }
  assert.match(source, /navigate\(appendReturnTo\(`\/kesp\/call\/\$\{encodeURIComponent\(call.id\)\}`, returnTo\)\)/);
  assert.match(source, /uploadAudioFile\(\{\s*file: item.file,/);
  assert.match(source, /salesAgentId: agent.salesAgentId,\s*salesAgentName: agent.salesAgentName,/);
  resetKespDemoRedactionState();
  assert.equal(maskKespDemoAgentDisplayName('Fictional Advisor'), '*AGENTE DEMO*');
  assert.equal(maskKespDemoCallString('fictional-recording.wav'), '*LLAMADA DEMO*');
  assert.equal(maskKespDemoCallString('1377-fictional-recording.wav'), '1377-*LLAMADA DEMO*');
});

test('upload boundaries include 25 MiB and 300 seconds; fail on unknown or excess values', () => {
  assert.doesNotThrow(() => validateDemoAudioLimits(25 * 1024 * 1024, 300));
  for (const [bytes,seconds] of [[0,1],[25*1024*1024+1,1],[1,300.01],[1,NaN],[1,Infinity],[1,0]]) assert.throws(() => validateDemoAudioLimits(bytes,seconds));
});
test('last complete Mexico City week excludes the current Sunday and handles year boundaries', () => {
  assert.deepEqual(previousDemoWeek(new Date('2026-10-01T21:00:00Z')), { startDate: '2026-09-21', endDate: '2026-09-27', weekKey: '2026-W39' });
  assert.equal(previousDemoWeek(new Date('2026-09-28T02:00:00Z')).endDate, '2026-09-20');
  assert.equal(previousDemoWeek(new Date('2026-01-01T12:00:00Z')).startDate, '2025-12-22');
});
test('no automation or iteration entry routes and no send dependency in report page', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url),'utf8');
  assert.doesNotMatch(app,/AutomaticWorkflowPage|PostCallEventDetectionsPage|IterationReviewPage|IterationRequestsPage/);
  const page = readFileSync(new URL('../pages/kesp/EmailReportsPage.tsx', import.meta.url),'utf8');
  assert.doesNotMatch(page,/sendAgent|seedIvan|previewAgentEmail|listAgentEmailReportDeliveries/);
  assert.match(page,/generateAgentCoachingReport/); assert.match(page,/listAgentCoachingReportCalls/);
});
test('permission edits preserve backend version and require explicit approval for new emails', () => {
  const member = { organizationId: 'consubanco', role: 'supervisor', version: 'v1' };
  const user = { uid: 'other', email: DEMO_EMAILS[1], memberships: [member] };
  const directory = { profiles: [], users: [user], pending: [] };
  const input = { callerUid: 'admin', adminOrganizationIds: ['consubanco'], organizationId: 'consubanco', email: DEMO_EMAILS[1], role: 'supervisor', profileId: '', approveEmail: false };
  assert.equal(prepareAccessUpdate(directory, { user, membership: member }, input).request.expectedVersion, 'v1');
  assert.equal(prepareAccessUpdate(directory, {}, { ...input, email: 'third@example.com' }).error, 'precondition');
  assert.equal(prepareAccessUpdate(directory, { user }, { ...input, callerUid: 'other' }).error, 'selfDemotion');
  assert.equal(prepareAccessUpdate(directory, {}, input).error, 'precondition');
  assert.equal(prepareAccessUpdate(directory, { user, membership: member }, { ...input, accessEnabled: false }).request.accessEnabled, false);
  assert.equal(prepareAccessUpdate(directory, { user, membership: member }, { ...input, accessEnabled: true, approveEmail: true }).request.accessEnabled, true);
});

test('admin can manage and disable only the exact password supervisor by UID', () => {
  const member = { organizationId: 'consubanco', role: 'supervisor', version: 'password-v1' };
  const user = { uid: DEMO_PASSWORD_UID, email: DEMO_PASSWORD_EMAIL, memberships: [member] };
  const directory = { profiles: [], users: [user], pending: [] };
  const input = { callerUid: 'admin', adminOrganizationIds: ['consubanco'], organizationId: 'consubanco', email: DEMO_PASSWORD_EMAIL, role: 'supervisor', profileId: '', approveEmail: false };
  for (const accessEnabled of [false, true]) {
    assert.deepEqual(prepareAccessUpdate(directory, { user, membership: member }, { ...input, accessEnabled }), { request: {
      organizationId: 'consubanco', uid: DEMO_PASSWORD_UID, role: 'supervisor',
      expectedVersion: 'password-v1', approveEmail: false, accessEnabled,
    } });
  }
  assert.equal(prepareAccessUpdate(directory, { user, membership: member }, { ...input, approveEmail: true }).request.approveEmail, true);
  // A pending email must not redirect an edit away from the fixed password UID.
  const pending = { email: 'third@example.com', organizationId: 'consubanco', version: 'pending-v1' };
  const result = prepareAccessUpdate(directory, { user, membership: member, pending }, { ...input, email: pending.email, accessEnabled: false });
  assert.equal(result.request.uid, DEMO_PASSWORD_UID);
  assert.equal(result.request.email, undefined);
  assert.equal(result.request.expectedVersion, 'password-v1');
});

test('password permission edits cannot elevate roles, bypass admin scope or edit self', () => {
  const member = { organizationId: 'consubanco', role: 'supervisor', version: 'password-v1' };
  const user = { uid: DEMO_PASSWORD_UID, email: DEMO_PASSWORD_EMAIL, memberships: [member] };
  const directory = { profiles: [], users: [user], pending: [] };
  const target = { user, membership: member };
  const input = { callerUid: 'admin', adminOrganizationIds: ['consubanco'], organizationId: 'consubanco', email: DEMO_PASSWORD_EMAIL, role: 'supervisor', profileId: '', approveEmail: false, accessEnabled: false };
  for (const role of ['admin', 'agent', 'member', '', null, 'unknown']) {
    assert.deepEqual(prepareAccessUpdate(directory, target, { ...input, role }), { error: 'unsupportedRole' });
  }
  assert.deepEqual(prepareAccessUpdate(directory, target, { ...input, adminOrganizationIds: [] }), { error: 'denied' });
  assert.deepEqual(prepareAccessUpdate(directory, target, { ...input, organizationId: 'other', adminOrganizationIds: ['other'] }), { error: 'denied' });
  assert.deepEqual(prepareAccessUpdate(directory, target, { ...input, callerUid: DEMO_PASSWORD_UID }), { error: 'selfDemotion' });
});

test('permission edits reject mismatched or unprovisioned reserved password identity', () => {
  const member = { organizationId: 'consubanco', role: 'supervisor', version: 'password-v1' };
  const directory = { profiles: [], users: [], pending: [] };
  const input = { callerUid: 'admin', adminOrganizationIds: ['consubanco'], organizationId: 'consubanco', email: DEMO_PASSWORD_EMAIL, role: 'supervisor', profileId: '', approveEmail: true };
  const identities = [
    ['other', DEMO_PASSWORD_EMAIL], ['', DEMO_PASSWORD_EMAIL], [undefined, DEMO_PASSWORD_EMAIL],
    [DEMO_PASSWORD_UID, DEMO_PASSWORD_EMAIL.toUpperCase()],
    [DEMO_PASSWORD_UID, ` ${DEMO_PASSWORD_EMAIL}`], [DEMO_PASSWORD_UID, `${DEMO_PASSWORD_EMAIL} `],
    [DEMO_PASSWORD_UID, null], [DEMO_PASSWORD_UID, 'third@example.com'],
    ...DEMO_EMAILS.map((email) => [DEMO_PASSWORD_UID, email]),
  ];
  for (const [uid, email] of identities) {
    const user = { uid, email, memberships: [member] };
    assert.deepEqual(prepareAccessUpdate(directory, { user, membership: member }, input), { error: 'denied' }, `${uid}:${email}`);
  }
  assert.deepEqual(prepareAccessUpdate(directory, {}, input), { error: 'denied' });
  assert.deepEqual(prepareAccessUpdate(directory, { pending: { email: DEMO_PASSWORD_EMAIL } }, input), { error: 'denied' });
});

test('arbitrary Google directory identities support admin and supervisor edits', () => {
  for (const email of DEMO_EMAILS) {
    const member = { organizationId: 'consubanco', role: 'supervisor', version: 'google-v1' };
    const user = { uid: `google-${email}`, email, memberships: [member] };
    const directory = { profiles: [], users: [user], pending: [] };
    for (const role of ['admin', 'supervisor']) {
      const input = { callerUid: 'other-admin', adminOrganizationIds: ['consubanco'], organizationId: 'consubanco', email, role, profileId: '', approveEmail: false, accessEnabled: false };
      assert.deepEqual(prepareAccessUpdate(directory, { user, membership: member }, input), { request: {
        organizationId: 'consubanco', uid: user.uid, role, expectedVersion: 'google-v1', approveEmail: false, accessEnabled: false,
      } });
    }
  }
});

test('new and pending email grants use normalized email and config snapshot version', () => {
  const input = { callerUid: 'admin', adminOrganizationIds: ['consubanco'], organizationId: 'consubanco',
    email: ' New-Reviewer@Example.com ', role: 'supervisor', profileId: '', approveEmail: true, accessEnabled: true };
  for (const pending of [undefined,
    { email: 'new-reviewer@example.com', organizationId: 'consubanco', version: 'config-v2' },
    { email: 'new-reviewer@example.com', organizationId: null, version: 'config-v3' }]) {
    const directory = { profiles: [], users: [], pending: pending ? [pending] : [] };
    const target = resolveAccessTarget(directory, pending ? { pending } : null, input.email, input.organizationId);
    assert.deepEqual(prepareAccessUpdate(directory, target, input), { request: {
      organizationId: 'consubanco', email: 'new-reviewer@example.com', role: 'supervisor',
      expectedVersion: pending?.version ?? null, approveEmail: true, accessEnabled: true,
    } });
  }
});

test('new email grants validate syntax, admin scope and approval without granting reserved password access', () => {
  const directory = { profiles: [], users: [], pending: [] };
  const input = { callerUid: 'admin', adminOrganizationIds: ['consubanco'], organizationId: 'consubanco',
    email: 'reviewer@example.com', role: 'supervisor', profileId: '', approveEmail: true };
  for (const email of ['', ' ', 'missing-at.example.com', 'a@', 'a b@example.com', 'a@@example.com',
    'reviewer/name@example.com', 'reviewer@example.com/path', 'a'.repeat(243) + '@example.com']) {
    assert.equal(prepareAccessUpdate(directory, {}, { ...input, email }).error, 'invalidEmail');
  }
  for (const email of [DEMO_PASSWORD_EMAIL, DEMO_PASSWORD_EMAIL.toUpperCase(), ` ${DEMO_PASSWORD_EMAIL} `]) {
    assert.equal(prepareAccessUpdate(directory, {}, { ...input, email }).error, 'denied');
  }
  assert.equal(prepareAccessUpdate(directory, {}, { ...input, adminOrganizationIds: [] }).error, 'denied');
  assert.equal(prepareAccessUpdate(directory, {}, { ...input, organizationId: 'other' }).error, 'denied');
  assert.equal(prepareAccessUpdate(directory, {}, { ...input, approveEmail: false }).error, 'precondition');
  assert.equal(prepareAccessUpdate(directory, {}, { ...input, approveEmail: false, accessEnabled: true }).error, 'precondition');
  assert.equal(prepareAccessUpdate(directory, {}, { ...input, profileId: 'profile' }).error, 'precondition');
  assert.equal(prepareAccessUpdate(directory, {}, { ...input, role: 'agent' }).error, 'unsupportedRole');
});

test('pending revocation does not require approval and retains the config snapshot version', () => {
  const pending = { email: 'reviewer@example.com', organizationId: 'consubanco', version: 'config-v4' };
  const directory = { profiles: [], users: [], pending: [pending] };
  const input = { callerUid: 'admin', adminOrganizationIds: ['consubanco'], organizationId: 'consubanco',
    email: pending.email, role: 'supervisor', profileId: '', approveEmail: false, accessEnabled: false };
  assert.deepEqual(prepareAccessUpdate(directory, { pending }, input), { request: {
    organizationId: 'consubanco', email: pending.email, role: 'supervisor', expectedVersion: 'config-v4',
    approveEmail: false, accessEnabled: false,
  } });
  assert.equal(prepareAccessUpdate(directory, { pending }, { ...input, accessEnabled: true }).error, 'precondition');
});

test('existing Auth targets use UID and membership version even with a pending config entry', () => {
  const membership = { organizationId: 'consubanco', role: 'supervisor', version: 'member-v1' };
  const user = { uid: 'reviewer', email: 'reviewer@example.com', memberships: [membership] };
  const pending = { email: user.email, organizationId: 'consubanco', version: 'config-v2' };
  const directory = { profiles: [], users: [user], pending: [pending] };
  const input = { callerUid: 'admin', adminOrganizationIds: ['consubanco'], organizationId: 'consubanco',
    email: user.email, role: 'supervisor', profileId: '', approveEmail: true };
  for (const member of [membership, undefined]) {
    const result = prepareAccessUpdate(directory, { user, membership: member, pending }, input).request;
    assert.equal(result.uid, user.uid);
    assert.equal(result.email, undefined);
    assert.equal(result.expectedVersion, member?.version ?? null);
  }
});

test('admin routes and email editor use backend grants without exposing a hardcoded roster', () => {
  const page = readFileSync(new URL('../pages/kesp/UsersPage.tsx', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../components/kesp/KespLayout.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(page + layout, /DEMO_ADMIN_EMAIL|DEMO_EMAILS/);
  assert.match(layout, /useUserPermissionsAccess\(user\?\.uid\)/);
  assert.match(page, /!access.adminOrganizationIds.includes\('consubanco'\)/);
  assert.match(page, /target\?\.pending\?\.email \?\? ''/);
  assert.match(page, /input type="email" required disabled=\{Boolean\(target\)\}/);
  assert.match(page, /useState\(!target\?\.user\)/);
  assert.match(page, /select value=\{profileId\} disabled=\{!resolved.user\}/);
  assert.match(page, /<label className="kesp-users-checkbox"><input type="checkbox" checked=\{accessEnabled\}/);
});

test('call details expose recovery navigation only, not direct active/canceled/completed reruns', () => {
  for (const path of ['../pages/kesp/CallDetailPage.tsx', '../pages/CallDetailPage.tsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /reprocessCall|handleReanalyzeCanceledCall|handleReprocess/);
    assert.match(source, /call.status === 'error' &&/);
    assert.match(source, /navigate\('\/kesp\/runtime-errors'\)/);
  }
});

test('demo permission updates accept only explicit admin/supervisor roles, including legacy agent records', () => {
  const member = { organizationId: 'consubanco', role: 'agent', version: 'v-old' };
  const user = { uid: 'other', email: DEMO_EMAILS[1], memberships: [member] };
  const directory = { profiles: [], users: [user], pending: [] };
  const target = { user, membership: member };
  const input = { callerUid: 'admin', adminOrganizationIds: ['consubanco'], organizationId: 'consubanco', email: DEMO_EMAILS[1], profileId: '', approveEmail: false };
  for (const role of ['agent', 'member', '', null, 'unknown']) assert.equal(prepareAccessUpdate(directory, target, { ...input, role }).error, 'unsupportedRole');
  for (const role of ['supervisor', 'admin']) {
    const result = prepareAccessUpdate(directory, target, { ...input, role });
    assert.equal(result.request.role, role); assert.equal(result.request.expectedVersion, 'v-old');
  }
  const page = readFileSync(new URL('../pages/kesp/UsersPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /const ROLES: UserAccessRole\[\] = \['supervisor', 'admin'\]/);
  assert.match(page, /originalRole as UserAccessRole : ''/);
  assert.match(page, /option value="" disabled/);
});

test('excluded frontend implementations and their exclusive APIs are absent from release source', () => {
  for (const path of ['../pages/kesp/AutomaticWorkflowPage.tsx', '../pages/kesp/PostCallEventDetectionsPage.tsx',
    '../pages/kesp/IterationRequestsPage.tsx', '../pages/kesp/IterationReviewPage.tsx',
    '../components/kesp/PostCallEventRow.tsx', '../services/iterationRequests.ts', '../types/iterationRequest.ts']) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
  }
  const service = readFileSync(new URL('../services/functions.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(service, /CccPipeline|CccAutomaticWorkflow|CccPostCallEvent|sendAgentEmailReports|sendAgentCoachingReport|seedIvanEmailReportRecipient|seedActiveAgentProfiles/);
  assert.match(service, /generateAgentCoachingReport/);
  assert.match(service, /retryCccRuntimeFailures/);
  assert.match(service, /prepareConsubancoTranscriptionUpload/);
  const settings = readFileSync(new URL('../components/kesp/AnalyzerSettingsButton.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(settings, /PipelineAnalyzerSettingsButton|getCccPipelineConfig|updateCccPipelineConfig/);
  assert.match(settings, /UploadAnalyzerSettingsButton/);
  for (const language of ['es', 'en']) {
    const locale = JSON.parse(readFileSync(new URL('../i18n/' + language + '.json', import.meta.url), 'utf8'));
    assert.equal(locale.kesp.automaticWorkflow, undefined);
    assert.equal(locale.kesp.iterations, undefined);
    assert.equal(locale.kesp.iterationReview, undefined);
  }
});
