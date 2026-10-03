import { Firestore } from 'firebase-admin/firestore';

const enabled = process.env.KESP_DEMO_AUTH_EMULATOR_TESTS === '1';
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = 'demo-kesp-auth';
if (enabled && !/^127\.0\.0\.1:\d+$/.test(host ?? '')) throw new Error('An explicit loopback emulator is required.');
const suite = enabled ? describe : describe.skip;
const emails: Record<string, string> = { tony: 'tonylai2789@gmail.com', logi: 'logitech2789@gmail.com', third: 'third@example.com' };

/** Generates emulator-only JWTs for exercising actual Firestore client rules. */
function token(uid: string, extra: Record<string, unknown> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({
    aud: projectId, iss: 'https://securetoken.google.com/' + projectId, sub: uid, user_id: uid,
    email: emails[uid], email_verified: true, firebase: { sign_in_provider: 'google.com' },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...extra,
  }) + '.';
}

suite('demo Firestore access rules', () => {
  let db: Firestore;
  /** Calls only this isolated loopback emulator. */
  async function rest(path: string, uid: string, method = 'GET', fields?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return fetch('http://' + host + '/v1/projects/' + projectId + '/databases/(default)/documents/' + path, {
      method, headers: { Authorization: 'Bearer ' + token(uid, extra), 'Content-Type': 'application/json' },
      ...(fields ? { body: JSON.stringify({ fields }) } : {}),
    });
  }
  beforeAll(async () => {
    db = new Firestore({ projectId, host, ssl: false });
    const batch = db.batch();
    batch.set(db.doc('config/allowedEmails'), { emails: Object.values(emails) });
    for (const uid of Object.keys(emails)) {
      batch.set(db.doc('organizations/consubanco/members/' + uid), { uid, email: emails[uid], organizationId: 'consubanco', role: uid === 'logi' ? 'supervisor' : 'admin' });
    }
    batch.set(db.doc('calls/call'), { uploadedBy: 'tony', organizationId: 'consubanco', visibilityScope: 'organization', salesAgentId: 'fictional', status: 'complete', name: 'Demo' });
    await batch.commit();
  }, 30000);
  afterAll(async () => { await db.terminate(); });
  it('admits a staff org-visible manual call and rejects a third email despite forged admin membership', async () => {
    expect((await rest('calls/call', 'logi')).status).toBe(200);
    expect((await rest('calls/call', 'third')).status).toBe(403);
  });
  it('admits shared manual activity and snapshots without CCC provenance', async () => {
    await db.doc('agent_activity/tony__fictional').set({uploadedBy:'tony',salesAgentId:'fictional',
      organizationId:'consubanco',visibilityScope:'organization',activitySource:'manual_upload'});
    await db.doc('agent_activity/tony__fictional/call_snapshots/call').set({sourceCallId:'call'});
    expect((await rest('agent_activity/tony__fictional','logi')).status).toBe(200);
    expect((await rest('agent_activity/tony__fictional/call_snapshots/call','logi')).status).toBe(200);
    expect((await rest('agent_activity/tony__fictional','third')).status).toBe(403);
  });
  it.each(['anonymous', 'password', 'custom'])('rejects %s auth', async (provider) => {
    expect((await rest('calls/call', 'tony', 'GET', undefined, { firebase: { sign_in_provider: provider } })).status).toBe(403);
  });
  it('rejects unverified tokens, direct call creation and direct membership writes', async () => {
    expect((await rest('calls/call', 'tony', 'GET', undefined, { email_verified: false })).status).toBe(403);
    expect((await rest('calls/new', 'tony', 'PATCH', { uploadedBy: { stringValue: 'tony' }, status: { stringValue: 'uploaded' } })).status).toBe(403);
    expect((await rest('organizations/consubanco/members/tony', 'tony', 'PATCH', { role: { stringValue: 'admin' } })).status).toBe(403);
  });
  it.each(['status', 'analyzerModel', 'transcriptionProvider', 'demoSeed', 'budgetReservationId', 'processingGeneration', 'audioPath', 'salesAgentId', 'uploadedBy'])('rejects mutation of %s', async (field) => {
    expect((await rest('calls/call?updateMask.fieldPaths=' + field, 'tony', 'PATCH', { [field]: { stringValue: 'forged' } })).status).toBe(403);
  });
  it('allows call naming and exact manual profile create; refuses injected server fields', async () => {
    expect((await rest('calls/call?updateMask.fieldPaths=name', 'tony', 'PATCH', { name: { stringValue: 'Renamed' } })).status).toBe(200);
    const fields = { uploadedBy: { stringValue: 'tony' }, salesAgentId: { stringValue: 'agent_new' },
      organizationId: { stringValue:'consubanco' }, visibilityScope: { stringValue:'organization' },
      salesAgentName: { stringValue: 'Fictional' }, status: { stringValue: 'ready' }, error: { nullValue: null },
      createdAt: { timestampValue: new Date().toISOString() }, updatedAt: { timestampValue: new Date().toISOString() } };
    expect((await rest('agent_analyses/new', 'tony', 'PATCH', fields)).status).toBe(200);
    expect((await rest('agent_analyses/new','logi')).status).toBe(200);
    for (const field of ['organizationId','visibilityScope','uploadedBy']) {
      expect((await rest('agent_analyses/new?updateMask.fieldPaths='+field,'tony','PATCH',{[field]:{stringValue:'forged'}})).status).toBe(403);
    }
    for (const extra of [
      {organizationId:{stringValue:'other'}}, {visibilityScope:{stringValue:'public'}}, {uploadedBy:{stringValue:'logi'}},
      {demoSeed:{booleanValue:true}}, {isCccCanonicalProfile:{booleanValue:true}}, {transcriptionProvider:{stringValue:'openai'}},
    ]) {
      expect((await rest('agent_analyses/rejected','tony','PATCH',{
        ...fields,salesAgentId:{stringValue:'agent_rejected'},...extra,
      })).status).toBe(403);
    }
    expect((await rest('agent_analyses/new?updateMask.fieldPaths=demoSeed', 'tony', 'PATCH', { demoSeed: { booleanValue: true } })).status).toBe(403);
    expect((await rest('agent_analyses/new?updateMask.fieldPaths=status', 'tony', 'PATCH', { status: { stringValue: 'analyzing' } })).status).toBe(403);
  });
  it('allows profile processing configuration but not budget metadata in that configuration', async () => {
    expect((await rest('agent_analyses/new?updateMask.fieldPaths=callProcessingConfig', 'tony', 'PATCH', {
      callProcessingConfig: { mapValue: { fields: { analyzerModel: { stringValue: 'gpt-5.4' } } } },
    })).status).toBe(200);
    expect((await rest('agent_analyses/new?updateMask.fieldPaths=callProcessingConfig', 'tony', 'PATCH', {
      callProcessingConfig: { mapValue: { fields: { budgetExempt: { booleanValue: true } } } },
    })).status).toBe(403);
  });
  it('rejects unsupported agent-role accounts without silently promoting them', async () => {
    await db.doc('organizations/consubanco/members/logi').update({ role: 'agent', salesAgentId: 'fictional' });
    expect((await rest('calls/call', 'logi')).status).toBe(403);
    await db.doc('calls/other').set({ uploadedBy: 'logi', organizationId: 'consubanco', visibilityScope: 'organization', salesAgentId: 'other' });
    expect((await rest('calls/other', 'logi')).status).toBe(403);
    await db.doc('organizations/consubanco/members/logi').update({ role: 'supervisor' });
  });
  it('denies backend audits, budget collections and automation reads', async () => {
    for (const path of ['organizations/consubanco/access_audit/x', 'demo_budget/x', 'ccc_ingest_events/x']) {
      await db.doc(path).set({ name: 'synthetic' });
      expect((await rest(path, 'tony')).status).toBe(403);
    }
  });
  it('revokes access when allowlist removal occurs without waiting for token expiry', async () => {
    await db.doc('config/allowedEmails').update({ emails: [emails.tony] });
    expect((await rest('calls/call', 'logi')).status).toBe(403);
  });
});
