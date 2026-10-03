import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type * as admin from 'firebase-admin';
import {
  DEMO_SEED_AGENT, DEMO_SEED_COLLECTION, DEMO_SEED_PROFILE_ID, validateDemoSeedManifest,
  authorizeDemoSeedManifest, resolveDemoSeedUpload, bindDemoSeedPreparedUpload, type DemoSeedManifest,
} from '../demoSeedAuthorization';
import { DEMO_PROJECT_ID, DEMO_STORAGE_BUCKET } from '../demoBudget';

jest.mock('../ffmpeg', () => ({ getAudioDuration: jest.fn() }));

const UID = 'google-admin-uid', EMAIL = 'tonylai2789@gmail.com';
const NOW = new Date('2026-10-01T12:00:00Z');
const PROFILE = 'agent_analyses/' + DEMO_SEED_PROFILE_ID;
const MEMBER = 'organizations/consubanco/members/' + UID;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const source = JSON.parse(readFileSync(resolve(__dirname, '../../../../synthetic/spanish-calls.v1.json'), 'utf8')) as {
  agent: typeof DEMO_SEED_AGENT;
  calls: Array<{ id: string; weekday: number; hour: number; title: string; performance: 'good' | 'mixed' | 'poor';
    turns: Array<{ speaker: string; text: string }> }>;
};

function fixture(): DemoSeedManifest {
  return {
    id: 'synthetic-v1-2026-09-21', version: 1, synthetic: true, projectId: DEMO_PROJECT_ID, agent: source.agent,
    scenarioSha256: sha(source), week: { start: '2026-09-21', end: '2026-09-27', timeZone: 'America/Mexico_City' },
    speechReservationMicros: 435000, entries: source.calls.map(call => ({
      id: call.id, originalFilename: 'synthetic-v1-2026-09-21-' + call.id + '.wav',
      sourceOccurredAt: new Date(Date.UTC(2026, 8, 21 + call.weekday, call.hour + 6)).toISOString(),
      scriptSha256: sha(call), wordCount: call.turns.map(turn => turn.text).join(' ').split(/\s+/u).length,
      title: call.title, performance: call.performance, sizeBytes: 120 * 48000 + 44, durationSeconds: 120,
      audioSha256: sha('synthetic-audio-' + call.id), contentType: 'audio/wav',
    })),
  };
}

/** Serial atomic transactions and read-after-write rejection model the invariants we rely on. */
function memoryDb() {
  type Data = FirebaseFirestore.DocumentData;
  interface Ref { path: string; id: string; get(): Promise<Snapshot>; collection(name: string): { doc(id: string): Ref } }
  interface Snapshot { exists: boolean; data(): Data | undefined }
  interface Tx { get(ref: Ref): Promise<Snapshot>; create(ref: Ref, data: Data): void; update(ref: Ref, data: Data): void }
  const values = new Map<string, Data>();
  let serial: Promise<unknown> = Promise.resolve(), writeCount = 0;
  let beforeTransaction: (() => void) | undefined;
  const snapshot = (path: string): Snapshot => ({ exists: values.has(path), data: () => values.get(path) });
  const doc = (path: string): Ref => ({ path, id: path.split('/').pop()!, get: async () => snapshot(path),
    collection: name => ({ doc: id => doc(path + '/' + name + '/' + id) }) });
  const db = {
    projectId: DEMO_PROJECT_ID, doc,
    runTransaction: (operation: (transaction: Tx) => Promise<unknown>) => {
      const result = serial.then(async () => {
        beforeTransaction?.();
        const writes: Array<() => void> = [];
        const transaction: Tx = {
          get: async ref => {
            if (writes.length) throw new Error('Read after write');
            return snapshot(ref.path);
          },
          create: (ref, fields) => {
            if (values.has(ref.path)) throw new Error('Already exists');
            writes.push(() => values.set(ref.path, fields));
          },
          update: (ref, fields) => {
            if (!values.has(ref.path)) throw new Error('Missing document');
            writes.push(() => values.set(ref.path, { ...values.get(ref.path), ...fields }));
          },
        };
        const result = await operation(transaction);
        writes.forEach(write => write());
        writeCount += writes.length;
        return result;
      });
      serial = result.catch(() => undefined);
      return result;
    },
  } as unknown as Firestore;
  const user = { uid: UID, email: EMAIL, emailVerified: true, disabled: false,
    providerData: [{ providerId: 'google.com', email: EMAIL }] };
  const auth = { getUser: jest.fn(async (uid: string) => {
    if (uid !== user.uid) throw new Error('Unknown auth UID');
    return user;
  }) } as unknown as admin.auth.Auth;
  values.set('config/allowedEmails', { emails: [EMAIL, 'logitech2789@gmail.com'] });
  values.set(MEMBER, { uid: UID, email: EMAIL, organizationId: 'consubanco', role: 'admin', accessEnabled: true });
  return { db, auth, user, values, writes: () => writeCount,
    setBeforeTransaction: (hook: () => void) => { beforeTransaction = hook; } };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  process.env.GCLOUD_PROJECT = DEMO_PROJECT_ID;
  for (const key of ['GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT', 'FIREBASE_CONFIG', 'CCC_INTERNAL_BUCKET', 'CCC_GCS_TRIGGER_BUCKET']) delete process.env[key];
});
afterEach(() => jest.useRealTimers());

describe('reviewed synthetic manifest', () => {
  test('accepts the complete actual source and a bounded subset', () => {
    const full = fixture();
    expect(validateDemoSeedManifest(full, NOW)).toEqual(full);
    expect(validateDemoSeedManifest({ ...full, entries: full.entries.slice(0, 1) }, NOW).entries).toHaveLength(1);
  });
  test('requires local completion rather than UTC Sunday rollover', () => {
    expect(() => validateDemoSeedManifest(fixture(), new Date('2026-09-28T05:59:59Z'))).toThrow('completed');
    expect(() => validateDemoSeedManifest(fixture(), new Date('2026-09-28T06:00:00Z'))).not.toThrow();
  });
  test.each([
    ['empty entries', (value: DemoSeedManifest) => { value.entries = []; }],
    ['too many entries', (value: DemoSeedManifest) => { value.entries.push(value.entries[0]); }],
    ['duplicate script', (value: DemoSeedManifest) => { value.entries[1] = value.entries[0]; }],
    ['unknown script', (value: DemoSeedManifest) => { value.entries[0].id = '../anything'; }],
    ['source hash', (value: DemoSeedManifest) => { value.scenarioSha256 = 'f'.repeat(64); }],
    ['script hash', (value: DemoSeedManifest) => { value.entries[0].scriptSha256 = 'f'.repeat(64); }],
    ['audio hash', (value: DemoSeedManifest) => { value.entries[0].audioSha256 = 'not-a-hash'; }],
    ['duplicate audio', (value: DemoSeedManifest) => { value.entries[1].audioSha256 = value.entries[0].audioSha256; }],
    ['off-date', (value: DemoSeedManifest) => { value.entries[0].sourceOccurredAt = '2026-09-22T16:00:00.000Z'; }],
    ['off-hour', (value: DemoSeedManifest) => { value.entries[0].sourceOccurredAt = '2026-09-21T17:00:00.000Z'; }],
    ['short call', (value: DemoSeedManifest) => { value.entries[0].durationSeconds = 90; }],
    ['oversized call', (value: DemoSeedManifest) => { value.entries[0].sizeBytes = 26 * 1024 * 1024; }],
    ['overlong call', (value: DemoSeedManifest) => { value.entries[0].durationSeconds = 301; }],
    ['PCM shape mismatch', (value: DemoSeedManifest) => { value.entries[0].sizeBytes += 48000; }],
    ['path traversal', (value: DemoSeedManifest) => { value.entries[0].originalFilename = '../unsafe.wav'; }],
    ['wrong project', (value: DemoSeedManifest) => { value.projectId = 'unrelated-project'; }],
    ['wrong timezone', (value: DemoSeedManifest) => { value.week.timeZone = 'UTC'; }],
    ['wrong week end', (value: DemoSeedManifest) => { value.week.end = '2026-09-28'; }],
  ])('rejects %s', (_name, mutate) => {
    const value = fixture(); mutate(value);
    expect(() => validateDemoSeedManifest(value, NOW)).toThrow();
  });
  test('rejects unrecognized fields, wrong agent and incomplete calendar week', () => {
    expect(() => validateDemoSeedManifest({ ...fixture(), callSource: 'other' }, NOW)).toThrow();
    expect(() => validateDemoSeedManifest({ ...fixture(), agent: { ...DEMO_SEED_AGENT, name: 'Unrelated Person' } }, NOW)).toThrow();
    expect(() => validateDemoSeedManifest(fixture(), new Date('2026-09-23T12:00:00Z'))).toThrow('completed');
  });
});

describe('operator authorization and normal shared profile', () => {
  test('creates only profile/manifest/authorizations, with actual admin ownership and no CCC flags', async () => {
    const state = memoryDb(), manifest = fixture();
    await authorizeDemoSeedManifest({ manifest, ownerUid: UID }, state);
    expect(state.values.get(PROFILE)).toMatchObject({ uploadedBy: UID, salesAgentId: DEMO_SEED_PROFILE_ID,
      salesAgentName: DEMO_SEED_AGENT.name, visibilityScope: 'organization', organizationId: 'consubanco',
      status: 'ready', activeAgentSource: 'synthetic_demo' });
    expect(state.values.get(PROFILE)?.createdAt).toBeInstanceOf(Timestamp);
    expect(Object.keys(state.values.get(PROFILE)!).some(key => key.startsWith('ccc'))).toBe(false);
    expect([...state.values.keys()].filter(key => key.startsWith('calls/') || key.includes('/feedback/'))).toEqual([]);
    expect(state.writes()).toBe(12);
  });
  test('repeated authorization is a no-op and preserves generated timestamps and profile progress', async () => {
    const state = memoryDb(), manifest = fixture();
    await authorizeDemoSeedManifest({ manifest, ownerUid: UID }, state);
    state.values.set(PROFILE, { ...state.values.get(PROFILE), status: 'complete', totalCalls: 8 });
    const timestamp = state.values.get(DEMO_SEED_COLLECTION + '/' + manifest.id)?.generatedAt;
    jest.setSystemTime(new Date('2026-10-01T13:00:00Z'));
    await authorizeDemoSeedManifest({ manifest, ownerUid: UID }, state);
    expect(state.writes()).toBe(12);
    expect(state.values.get(PROFILE)?.totalCalls).toBe(8);
    expect(state.values.get(DEMO_SEED_COLLECTION + '/' + manifest.id)?.generatedAt).toEqual(timestamp);
  });
  test.each(['disabled-user', 'unverified-email', 'non-google', 'supervisor', 'disabled-member', 'revoked-allowlist', 'wrong-project'])(
    'rejects %s before writes', async scenario => {
      const state = memoryDb();
      if (scenario === 'disabled-user') state.user.disabled = true;
      if (scenario === 'unverified-email') state.user.emailVerified = false;
      if (scenario === 'non-google') state.user.providerData[0].providerId = 'password';
      if (scenario === 'supervisor') state.values.get(MEMBER)!.role = 'supervisor';
      if (scenario === 'disabled-member') state.values.get(MEMBER)!.accessEnabled = false;
      if (scenario === 'revoked-allowlist') state.values.set('config/allowedEmails', { emails: [] });
      if (scenario === 'wrong-project') process.env.GCP_PROJECT = 'unrelated-project';
      await expect(authorizeDemoSeedManifest({ manifest: fixture(), ownerUid: UID }, state)).rejects.toThrow();
      expect(state.writes()).toBe(0);
    });
  test('rechecks membership within the write transaction', async () => {
    const state = memoryDb();
    state.setBeforeTransaction(() => { state.values.get(MEMBER)!.role = 'supervisor'; });
    await expect(authorizeDemoSeedManifest({ manifest: fixture(), ownerUid: UID }, state)).rejects.toThrow('revoked');
    expect(state.writes()).toBe(0);
  });
  test('rejects unrelated profile collision without overwriting', async () => {
    const state = memoryDb();
    const unrelated = { uploadedBy: 'another-user', salesAgentId: DEMO_SEED_PROFILE_ID };
    state.values.set(PROFILE, unrelated);
    await expect(authorizeDemoSeedManifest({ manifest: fixture(), ownerUid: UID }, state)).rejects.toThrow('unrelated');
    expect(state.values.get(PROFILE)).toBe(unrelated);
    expect(state.writes()).toBe(0);
  });
  test('changed audio authorization and missing/orphan entries are not silently repaired', async () => {
    const state = memoryDb(), manifest = fixture();
    await authorizeDemoSeedManifest({ manifest, ownerUid: UID }, state);
    const changed = fixture(); changed.entries[0].audioSha256 = 'f'.repeat(64);
    await expect(authorizeDemoSeedManifest({ manifest: changed, ownerUid: UID }, state)).rejects.toThrow('conflicts');
    state.values.delete(DEMO_SEED_COLLECTION + '/' + manifest.id + '/entries/lunes-01');
    await expect(authorizeDemoSeedManifest({ manifest, ownerUid: UID }, state)).rejects.toThrow('missing');
    expect(state.writes()).toBe(12);
    const orphan = memoryDb();
    orphan.values.set(DEMO_SEED_COLLECTION + '/' + manifest.id + '/entries/lunes-01', { anything: true });
    await expect(authorizeDemoSeedManifest({ manifest, ownerUid: UID }, orphan)).rejects.toThrow('Orphan');
    expect(orphan.writes()).toBe(0);
  });
});

function rawUpload(manifest: DemoSeedManifest) {
  const entry = manifest.entries[0];
  return { demoSeedManifestId: manifest.id, demoSeedEntryId: entry.id, agentId: DEMO_SEED_PROFILE_ID,
    agentRoutingMode: 'specific', originalFilename: entry.originalFilename, audioSha256: entry.audioSha256,
    sizeBytes: entry.sizeBytes, contentType: entry.contentType, transcriptionModel: 'scribe_v2' };
}
async function authorized() {
  const state = memoryDb(), manifest = fixture();
  await authorizeDemoSeedManifest({ manifest, ownerUid: UID }, state);
  const seed = (await resolveDemoSeedUpload({ raw: rawUpload(manifest), ownerUid: UID }, state))!;
  return { ...state, manifest, seed };
}
function reservation(state: Awaited<ReturnType<typeof authorized>>, callId: string) {
  const entry = state.seed.entry;
  return { ownerUid: UID, callId, storagePath: 'prepared-uploads/' + UID + '/' + callId + '/' + entry.originalFilename,
    bucket: DEMO_STORAGE_BUCKET, originalFilename: entry.originalFilename, audioSha256: entry.audioSha256,
    sizeBytes: entry.sizeBytes, contentType: entry.contentType, status: 'prepared',
    createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 3600000),
    callFields: { ...state.seed.callFields, callSource: 'manual_upload', transcriptionModel: 'scribe_v2', analyzerModel: 'gpt-5.4',
      transcriptionComparison: false, analyzerModelOverrides: {}, promptOverrides: { core_fields: '1' }, activityPromptOverrides: {} } };
}

describe('trusted resolution and idempotent prepared uploads', () => {
  test('ordinary uploads are not seeded, while seed fields preserve truthful provenance', async () => {
    await expect(resolveDemoSeedUpload({ raw: {}, ownerUid: UID })).resolves.toBeNull();
    const state = await authorized(), fields = state.seed.callFields;
    expect(fields).toMatchObject({ uploadedBy: UID, callSource: 'manual_upload', organizationId: 'consubanco',
      visibilityScope: 'organization', matchedAgentAnalysisId: DEMO_SEED_PROFILE_ID, salesAgentId: DEMO_SEED_PROFILE_ID });
    expect((fields.callOccurredAt as Timestamp).toDate().toISOString()).toBe(state.seed.entry.sourceOccurredAt);
    expect(fields.demoSeed).toMatchObject({ synthetic: true, generatedAt: Timestamp.now() });
    expect(fields.callOccurredAtSource).toBeUndefined();
    expect(Object.keys(fields).some(key => key.startsWith('ccc'))).toBe(false);
  });
  test.each(['audioSha256', 'sizeBytes', 'agentId', 'transcriptionModel', 'analyzerModel', 'comparison', 'demoSeedEntryId'])(
    'rejects forged upload %s', async field => {
      const state = await authorized();
      await expect(resolveDemoSeedUpload({ raw: { ...rawUpload(state.manifest), [field]: 'forged' }, ownerUid: UID }, state)).rejects.toThrow();
    });
  test('concurrent reservations bind exactly one prepared request, then consumed replay reuses it', async () => {
    const state = await authorized(), first = reservation(state, 'call-A'), second = reservation(state, 'call-B');
    const a = bindDemoSeedPreparedUpload({ seed: state.seed, requestRecord: first }, state);
    const b = bindDemoSeedPreparedUpload({ seed: state.seed, requestRecord: second }, state);
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultB).toEqual(resultA);
    expect([...state.values.keys()].filter(key => key.startsWith('manual_upload_requests/'))).toEqual(['manual_upload_requests/call-A']);
    expect([...state.values.keys()].some(key => key.startsWith('calls/'))).toBe(false);
    const request = state.values.get('manual_upload_requests/call-A')!;
    expect(request.callFields.uploadedBy).toBe(state.values.get(PROFILE)?.uploadedBy);
    request.status = 'consumed';
    jest.setSystemTime(new Date('2026-10-01T15:00:00Z'));
    await expect(bindDemoSeedPreparedUpload({ seed: state.seed, requestRecord: reservation(state, 'call-C') }, state)).resolves.toEqual(resultA);
    expect(state.values.has('manual_upload_requests/call-C')).toBe(false);
  });
  test('mutating an in-memory seed context cannot change persisted owner, profile, occurrence or provenance', async () => {
    const state = await authorized();
    state.seed.callFields = { uploadedBy: 'forged', salesAgentId: 'forged', callOccurredAt: Timestamp.now() };
    const request = reservation(state, 'call-A');
    request.callFields.callSource = 'manual_upload';
    await bindDemoSeedPreparedUpload({ seed: state.seed, requestRecord: request }, state);
    expect(state.values.get('manual_upload_requests/call-A')?.callFields).toMatchObject({
      uploadedBy: UID, salesAgentId: DEMO_SEED_PROFILE_ID, matchedAgentAnalysisId: DEMO_SEED_PROFILE_ID,
      demoSeed: { manifestId: state.manifest.id, entryId: 'lunes-01', synthetic: true },
    });
  });
  test('expired/rejected bound request is not replaced and changed processing snapshot is rejected', async () => {
    const state = await authorized();
    await bindDemoSeedPreparedUpload({ seed: state.seed, requestRecord: reservation(state, 'call-A') }, state);
    const changed = reservation(state, 'call-B');
    changed.callFields.promptOverrides.core_fields = '2';
    await expect(bindDemoSeedPreparedUpload({ seed: state.seed, requestRecord: changed }, state)).rejects.toThrow('snapshot changed');
    state.values.get('manual_upload_requests/call-A')!.expiresAt = Timestamp.fromMillis(Date.now() - 1);
    await expect(bindDemoSeedPreparedUpload({ seed: state.seed, requestRecord: reservation(state, 'call-B') }, state)).rejects.toThrow('expired');
    state.values.get('manual_upload_requests/call-A')!.status = 'rejected';
    await expect(bindDemoSeedPreparedUpload({ seed: state.seed, requestRecord: reservation(state, 'call-B') }, state)).rejects.toThrow('rejected');
    expect(state.values.has('manual_upload_requests/call-B')).toBe(false);
  });
  test('role downgrade between resolution and binding prevents reservation creation', async () => {
    const state = await authorized();
    state.values.get(MEMBER)!.role = 'supervisor';
    await expect(bindDemoSeedPreparedUpload({ seed: state.seed, requestRecord: reservation(state, 'call-A') }, state)).rejects.toThrow('admin');
    expect(state.values.has('manual_upload_requests/call-A')).toBe(false);
  });
  test('damaged bound provenance cannot be reused as an unrelated manual reservation', async () => {
    const state = await authorized();
    await bindDemoSeedPreparedUpload({ seed: state.seed, requestRecord: reservation(state, 'call-A') }, state);
    state.values.get('manual_upload_requests/call-A')!.callFields.demoSeed.entryId = 'lunes-02';
    await expect(bindDemoSeedPreparedUpload({ seed: state.seed, requestRecord: reservation(state, 'call-B') }, state)).rejects.toThrow('provenance');
    expect(state.values.has('manual_upload_requests/call-B')).toBe(false);
  });
});
