import { createHash } from 'crypto';
import type * as admin from 'firebase-admin';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import {
  DEMO_RECONSTRUCTION_AGENT, DEMO_RECONSTRUCTION_COLLECTION, DEMO_RECONSTRUCTION_PROFILE_ID,
  validateDemoReconstructionManifest, hashDemoReconstructionManifest, authorizeDemoReconstructionManifest,
  resolveDemoReconstructionUpload, bindDemoReconstructionPreparedUpload, type DemoReconstructionManifest,
} from '../demoReconstructionAuthorization';
import { validateDemoSeedManifest } from '../demoSeedAuthorization';
import { DEMO_PROJECT_ID, DEMO_STORAGE_BUCKET } from '../demoBudget';

jest.mock('../ffmpeg', () => ({ getAudioDuration: jest.fn() }));

const UID = 'google-admin-uid', EMAIL = 'tonylai2789@gmail.com';
const NOW = new Date('2026-10-01T12:00:00Z');
const MEMBER = 'organizations/consubanco/members/' + UID;
const PROFILE = 'agent_analyses/' + DEMO_RECONSTRUCTION_PROFILE_ID;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
type Data = FirebaseFirestore.DocumentData;

function fixture(): DemoReconstructionManifest {
  const id = 'reconstructed-v1-2026-09-21';
  return { id, version: 1, kind: 'sanitized_reconstruction', projectId: DEMO_PROJECT_ID, agent: { ...DEMO_RECONSTRUCTION_AGENT },
    week: { start: '2026-09-21', end: '2026-09-27', timeZone: 'America/Mexico_City' },
    entries: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'].flatMap((day, weekday) => ['01', '02'].map((slot, index) => ({
      id: day + '-' + slot, originalFilename: id + '-' + day + '-' + slot + '.wav',
      demoOccurredAt: new Date(Date.UTC(2026, 8, 21 + weekday, 16, index * 30)).toISOString(),
      scriptSha256: sha('fictional script ' + day + slot), audioSha256: sha('new reconstructed audio ' + day + slot),
      sizeBytes: 120 * 48000 + 44, durationSeconds: 120, contentType: 'audio/wav' as const,
    }))) };
}
function distributedFixture(slots: Array<[number, number]>): DemoReconstructionManifest {
  const manifest = fixture(), template = manifest.entries[0];
  manifest.entries = slots.map(([day, slot]) => {
    const id = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'][day] + '-' + String(slot).padStart(2, '0');
    return { ...template, id, originalFilename: manifest.id + '-' + id + '.wav',
      demoOccurredAt: new Date(Date.UTC(2026, 8, 21 + day, 16, (slot - 1) * 30)).toISOString(),
      scriptSha256: sha('fictional script ' + id), audioSha256: sha('new reconstructed audio ' + id) };
  });
  return manifest;
}
function approval(manifest: unknown) {
  return { approved: true as const, manifestSha256: hashDemoReconstructionManifest(manifest) };
}
const manifestPath = (manifest: DemoReconstructionManifest) => DEMO_RECONSTRUCTION_COLLECTION + '/' + manifest.id;
const entryPath = (manifest: DemoReconstructionManifest) => manifestPath(manifest) + '/entries/' + manifest.entries[0].id;

/** Isolated serial atomic transactions; forbid reads after writes and commit nothing on rejection. */
function memoryDb() {
  interface Ref { path: string; get(): Promise<Snapshot>; collection(name: string): { doc(id: string): Ref } }
  interface Snapshot { exists: boolean; data(): Data | undefined }
  interface Tx { get(ref: Ref): Promise<Snapshot>; create(ref: Ref, data: Data): void; update(ref: Ref, data: Data): void }
  const values = new Map<string, Data>();
  let serial: Promise<unknown> = Promise.resolve(), writes = 0, beforeTransaction: (() => void) | undefined;
  const snapshot = (path: string): Snapshot => ({ exists: values.has(path), data: () => values.get(path) });
  const doc = (path: string): Ref => ({ path, get: async () => snapshot(path),
    collection: name => ({ doc: id => doc(path + '/' + name + '/' + id) }) });
  const db = { projectId: DEMO_PROJECT_ID, doc, runTransaction: (operation: (tx: Tx) => Promise<unknown>) => {
    const result = serial.then(async () => {
      beforeTransaction?.();
      const pending: Array<() => void> = [];
      const value = await operation({
        get: async ref => { if (pending.length) throw new Error('Read after write'); return snapshot(ref.path); },
        create: (ref, data) => {
          if (values.has(ref.path)) throw new Error('Already exists');
          pending.push(() => { values.set(ref.path, data); });
        },
        update: (ref, data) => {
          if (!values.has(ref.path)) throw new Error('Missing document');
          pending.push(() => { values.set(ref.path, { ...values.get(ref.path), ...data }); });
        },
      });
      pending.forEach(write => write()); writes += pending.length;
      return value;
    });
    serial = result.catch(() => undefined);
    return result;
  } } as unknown as Firestore;
  const user = { uid: UID, email: EMAIL, emailVerified: true, disabled: false, providerData: [{ providerId: 'google.com', email: EMAIL }] };
  const auth = { getUser: jest.fn(async (uid: string) => {
    if (uid !== user.uid) throw new Error('Unknown UID');
    return user;
  }) } as unknown as admin.auth.Auth;
  values.set('config/allowedEmails', { emails: [EMAIL, 'logitech2789@gmail.com'] });
  values.set(MEMBER, { uid: UID, email: EMAIL, organizationId: 'consubanco', role: 'admin', accessEnabled: true });
  return { db, auth, user, values, writes: () => writes, setBeforeTransaction: (hook: () => void) => { beforeTransaction = hook; } };
}
const originalEnv = { ...process.env };
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }); jest.setSystemTime(NOW);
  process.env.GCLOUD_PROJECT = DEMO_PROJECT_ID;
  for (const key of ['GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT', 'FIREBASE_CONFIG', 'CCC_INTERNAL_BUCKET', 'CCC_GCS_TRIGGER_BUCKET', 'CCC_LANDING_BUCKET', 'STORAGE_BUCKET']) delete process.env[key];
});
afterEach(() => { jest.useRealTimers(); process.env = { ...originalEnv }; });

describe('closed reconstructed manifest, separate from strict synthetic validation', () => {
  test('accepts a bounded fictional packet without claiming it is synthetic', () => {
    const manifest = fixture();
    expect(validateDemoReconstructionManifest(manifest)).toEqual(manifest);
    expect(validateDemoReconstructionManifest({ ...manifest, entries: manifest.entries.slice(0, 1) }).entries).toHaveLength(1);
    expect(manifest).not.toHaveProperty('synthetic');
    expect(() => validateDemoSeedManifest(manifest)).toThrow();
    expect(() => validateDemoSeedManifest({ ...manifest, synthetic: true })).toThrow();
  });
  test('stable hash ignores object key order but binds week, scripts and audio', () => {
    const manifest = fixture(), hash = hashDemoReconstructionManifest(manifest);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashDemoReconstructionManifest(Object.fromEntries(Object.entries(manifest).reverse()))).toBe(hash);
    manifest.entries[0].audioSha256 = sha('different audio');
    expect(hashDemoReconstructionManifest(manifest)).not.toBe(hash);
    const script = fixture(); script.entries[0].scriptSha256 = sha('different script');
    expect(hashDemoReconstructionManifest(script)).not.toBe(hash);
  });
  test('week completion follows Mexico City, not UTC', () => {
    expect(() => validateDemoReconstructionManifest(fixture(), new Date('2026-09-28T05:59:59Z'))).toThrow('completed');
    expect(() => validateDemoReconstructionManifest(fixture(), new Date('2026-09-28T06:00:00Z'))).not.toThrow();
  });
  test.each([0, 1, 2, 3, 4, 5, 6])('allows all ten slots on available weekday %i, including weekends', day => {
    const manifest = distributedFixture(Array.from({ length: 10 }, (_, index) => [day, index + 1]));
    expect(validateDemoReconstructionManifest(manifest)).toEqual(manifest);
    expect(manifest.entries[0].demoOccurredAt).toContain('T16:00:00.000Z');
    expect(manifest.entries[9].demoOccurredAt).toContain('T20:30:00.000Z');
  });
  test('allows uneven available-day distribution without requiring absent days or preceding slots', () => {
    const manifest = distributedFixture([[0, 1], [0, 2], [0, 3], [3, 1], [5, 5], [6, 10]]);
    expect(validateDemoReconstructionManifest(manifest)).toEqual(manifest);
    manifest.entries.push(...distributedFixture([[1, 1], [1, 2], [2, 1], [2, 2], [4, 1]]).entries);
    expect(() => validateDemoReconstructionManifest(manifest)).toThrow('One to ten');
  });
  test.each(['lunes-00', 'lunes-11', 'lunes-1', 'lunes-010', 'sabado-99', 'sunday-01', '../domingo-01', 'domingo-01/extra'])(
    'rejects unsafe or out-of-range entry %s', id => {
      const manifest = distributedFixture([[6, 1]]);
      manifest.entries[0].id = id;
      manifest.entries[0].originalFilename = manifest.id + '-' + id + '.wav';
      expect(() => validateDemoReconstructionManifest(manifest)).toThrow('entry ID');
    });
  test.each(['2026-09-26T20:30:00.000Z', '2026-09-28T20:30:00.000Z', '2026-09-27T20:00:00.000Z', '2026-09-27T20:30:00.001Z'])(
    'rejects Sunday slot10 with a mismatched day/slot time %s', time => {
      const manifest = distributedFixture([[6, 10]]);
      manifest.entries[0].demoOccurredAt = time;
      expect(() => validateDemoReconstructionManifest(manifest)).toThrow('weekday/time');
    });
  test.each([
    'sourceBankId', 'sourceBucket', 'sourceName', 'sourceOccurredAt', 'sourceDate', 'sourceCallId', 'sourceAudioSha256',
    'synthetic', 'cccAgentMappingId', 'notes', 'title',
  ])('rejects source/freeform field %s at every manifest level', field => {
    const manifest = fixture();
    expect(() => validateDemoReconstructionManifest({ ...manifest, [field]: 'forbidden' })).toThrow();
    expect(() => validateDemoReconstructionManifest({ ...manifest, agent: { ...manifest.agent, [field]: 'forbidden' } })).toThrow();
    expect(() => validateDemoReconstructionManifest({ ...manifest, week: { ...manifest.week, [field]: 'forbidden' } })).toThrow();
    manifest.entries[0] = { ...manifest.entries[0], [field]: 'forbidden' };
    expect(() => validateDemoReconstructionManifest(manifest)).toThrow();
  });
  test.each<[string, (value: Data) => void]>([
    ['synthetic kind', value => { value.kind = 'synthetic'; }],
    ['wrong project', value => { value.projectId = 'other-project'; }],
    ['source profile ID', value => { value.agent.id = 'unapproved-profile'; }],
    ['source name', value => { value.agent.name = 'Unapproved Name'; }],
    ['source organization', value => { value.agent.organizationLabel = 'Unapproved Organization'; }],
    ['source manifest ID', value => { value.id = 'unapproved-source'; }],
    ['source basename', value => { value.entries[0].originalFilename = 'source.wav'; }],
    ['unknown entry ID', value => { value.entries[0].id = 'source-01'; }],
    ['empty packet', value => { value.entries = []; }],
    ['too many entries', value => { value.entries.push(value.entries[0]); }],
    ['duplicate entry', value => { value.entries[1] = value.entries[0]; }],
    ['duplicate audio', value => { value.entries[1].audioSha256 = value.entries[0].audioSha256; }],
    ['bad script hash', value => { value.entries[0].scriptSha256 = 'unreviewed'; }],
    ['bad audio hash', value => { value.entries[0].audioSha256 = 'unreviewed'; }],
    ['short audio', value => { value.entries[0].durationSeconds = 90; }],
    ['overlong audio', value => { value.entries[0].durationSeconds = 301; }],
    ['oversized audio', value => { value.entries[0].sizeBytes = 26 * 1024 * 1024; }],
    ['invalid audio size', value => { value.entries[0].sizeBytes = 0; }],
    ['wrong PCM shape', value => { value.entries[0].sizeBytes += 48000; }],
    ['wrong content type', value => { value.entries[0].contentType = 'audio/mpeg'; }],
    ['wrong date', value => { value.entries[0].demoOccurredAt = '2026-09-22T16:00:00.000Z'; }],
    ['wrong time', value => { value.entries[0].demoOccurredAt = '2026-09-21T17:00:00.000Z'; }],
    ['invalid timestamp', value => { value.entries[0].demoOccurredAt = 'invalid'; }],
    ['invalid calendar date', value => { value.week.start = '2026-02-30'; }],
    ['wrong timezone', value => { value.week.timeZone = 'UTC'; }],
    ['wrong week end', value => { value.week.end = '2026-09-28'; }],
    ['missing field', value => { delete value.entries[0].scriptSha256; }],
  ])('rejects %s', (_name, mutate) => {
    const value = fixture(); mutate(value);
    expect(() => validateDemoReconstructionManifest(value)).toThrow();
  });
});

describe('operator-only exact-packet human approval', () => {
  test.each([undefined, null, {}, { approved: false }, { approved: true, manifestSha256: '0'.repeat(64) }])(
    'does not authorize absent or mismatched approval %j', async badApproval => {
      const state = memoryDb();
      await expect(authorizeDemoReconstructionManifest({
        manifest: fixture(), ownerUid: UID, approval: badApproval as ReturnType<typeof approval>,
      }, state)).rejects.toThrow();
      expect(state.writes()).toBe(0);
    });
  test('does not accept approval of a packet before its audio changed', async () => {
    const state = memoryDb(), manifest = fixture(), reviewed = approval(manifest);
    manifest.entries[0].audioSha256 = sha('changed after review');
    await expect(authorizeDemoReconstructionManifest({ manifest, ownerUid: UID, approval: reviewed }, state)).rejects.toThrow('exact packet');
    expect(state.writes()).toBe(0);
  });
  test('creates only fictional shared profile and authorization, then preserves approval and profile progress on replay', async () => {
    const state = memoryDb(), manifest = fixture();
    await authorizeDemoReconstructionManifest({ manifest, ownerUid: UID, approval: approval(manifest) }, state);
    expect(state.writes()).toBe(12);
    const stored = state.values.get(manifestPath(manifest))!;
    expect(stored.approval).toEqual({ kind: 'human_review', approvedByUid: UID, approvedAt: Timestamp.now(), manifestSha256: approval(manifest).manifestSha256 });
    expect(state.values.get(PROFILE)).toMatchObject({ uploadedBy: UID, visibilityScope: 'organization', activeAgentSource: 'reconstructed_demo' });
    expect(JSON.stringify([...state.values.values()])).not.toContain('"synthetic":true');
    expect([...state.values.keys()].some(path => /^(calls|manual_upload_requests|demo_seed_manifests)\//.test(path))).toBe(false);
    state.values.get(PROFILE)!.totalCalls = 8; state.values.get(PROFILE)!.status = 'complete';
    jest.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    await authorizeDemoReconstructionManifest({ manifest, ownerUid: UID, approval: approval(manifest) }, state);
    expect(state.writes()).toBe(12);
    expect(state.values.get(PROFILE)?.totalCalls).toBe(8);
    expect(state.values.get(manifestPath(manifest))?.approval.approvedAt.toDate()).toEqual(NOW);
  });
  test.each(['disabled-user', 'unverified-email', 'non-google', 'supervisor', 'disabled-member', 'revoked-allowlist', 'wrong-project'])(
    'rejects %s without writes', async scenario => {
      const state = memoryDb(), manifest = fixture();
      if (scenario === 'disabled-user') state.user.disabled = true;
      if (scenario === 'unverified-email') state.user.emailVerified = false;
      if (scenario === 'non-google') state.user.providerData[0].providerId = 'password';
      if (scenario === 'supervisor') state.values.get(MEMBER)!.role = 'supervisor';
      if (scenario === 'disabled-member') state.values.get(MEMBER)!.accessEnabled = false;
      if (scenario === 'revoked-allowlist') state.values.set('config/allowedEmails', { emails: [] });
      if (scenario === 'wrong-project') process.env.GCP_PROJECT = 'other-project';
      await expect(authorizeDemoReconstructionManifest({ manifest, ownerUid: UID, approval: approval(manifest) }, state)).rejects.toThrow();
      expect(state.writes()).toBe(0);
    });
  test.each(['role', 'allowlist'])('rechecks %s inside the transaction', async scenario => {
    const state = memoryDb(), manifest = fixture();
    state.setBeforeTransaction(() => {
      if (scenario === 'role') state.values.get(MEMBER)!.role = 'supervisor';
      else state.values.set('config/allowedEmails', { emails: [] });
    });
    await expect(authorizeDemoReconstructionManifest({ manifest, ownerUid: UID, approval: approval(manifest) }, state)).rejects.toThrow('revoked');
    expect(state.writes()).toBe(0);
  });
  test('refuses profile collision, orphan entries and altered/missing authorization', async () => {
    const state = memoryDb(), manifest = fixture(), input = { manifest, ownerUid: UID, approval: approval(manifest) };
    state.values.set(PROFILE, { uploadedBy: 'unrelated' });
    await expect(authorizeDemoReconstructionManifest(input, state)).rejects.toThrow();
    expect(state.values.get(PROFILE)).toEqual({ uploadedBy: 'unrelated' });
    state.values.delete(PROFILE);
    state.values.set(entryPath(manifest), { ownerUid: UID });
    await expect(authorizeDemoReconstructionManifest(input, state)).rejects.toThrow('Orphan');
    expect(state.writes()).toBe(0);
    state.values.delete(entryPath(manifest));
    await authorizeDemoReconstructionManifest(input, state);
    const changed = fixture(); changed.entries[0].scriptSha256 = sha('new reviewed script');
    await expect(authorizeDemoReconstructionManifest({ manifest: changed, ownerUid: UID, approval: approval(changed) }, state)).rejects.toThrow('conflicts');
    state.values.delete(entryPath(manifest));
    await expect(authorizeDemoReconstructionManifest(input, state)).rejects.toThrow('missing');
    expect(state.writes()).toBe(12);
  });
});

function rawUpload(manifest: DemoReconstructionManifest): Data {
  const entry = manifest.entries[0];
  return { demoReconstructionManifestId: manifest.id, demoReconstructionEntryId: entry.id,
    agentId: DEMO_RECONSTRUCTION_PROFILE_ID, agentRoutingMode: 'specific', originalFilename: entry.originalFilename,
    audioSha256: entry.audioSha256, sizeBytes: entry.sizeBytes, contentType: entry.contentType };
}
async function authorized(manifest = fixture()) {
  const state = memoryDb();
  await authorizeDemoReconstructionManifest({ manifest, ownerUid: UID, approval: approval(manifest) }, state);
  const reconstruction = (await resolveDemoReconstructionUpload({ raw: rawUpload(manifest), ownerUid: UID }, state))!;
  return { ...state, manifest, reconstruction };
}
function reservation(state: Awaited<ReturnType<typeof authorized>>, callId = 'call-A'): Data {
  const entry = state.reconstruction.entry;
  return { ownerUid: UID, callId, storagePath: 'prepared-uploads/' + UID + '/' + callId + '/' + entry.originalFilename,
    bucket: DEMO_STORAGE_BUCKET, originalFilename: entry.originalFilename, audioSha256: entry.audioSha256,
    sizeBytes: entry.sizeBytes, contentType: entry.contentType, status: 'prepared',
    createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 3600000),
    callFields: { ...state.reconstruction.callFields, transcriptionProvider: 'elevenlabs', transcriptionModel: 'scribe_v2',
      transcriptionProviderSnapshotVersion: 1, transcriptionManualSelectionVersion: 1, transcriptionComparison: false,
      analyzerModel: 'gpt-5.4', analyzerModelOverrides: {}, promptOverrides: { core_fields: '1' }, activityPromptOverrides: {} } };
}
async function bind(state: Awaited<ReturnType<typeof authorized>>, requestRecord = reservation(state)) {
  return bindDemoReconstructionPreparedUpload({ reconstruction: state.reconstruction, requestRecord }, state);
}

describe('backend provenance resolution and one prepared-upload binding', () => {
  test('weekend slot10 resolves and binds idempotently under exact-packet approval', async () => {
    const state = await authorized(distributedFixture([[6, 10]]));
    const first = await bind(state);
    expect(await bind(state, reservation(state, 'call-B'))).toEqual(first);
    const stored = state.values.get('manual_upload_requests/call-A')!;
    expect(stored.callFields.demoReconstruction).toMatchObject({ entryId: 'domingo-10', manifestSha256: approval(state.manifest).manifestSha256 });
    expect(stored.callFields.callOccurredAt.toDate().toISOString()).toBe('2026-09-27T20:30:00.000Z');
    expect(state.writes()).toBe(5);
    const changed = distributedFixture([[5, 10]]);
    await expect(authorizeDemoReconstructionManifest({ manifest: changed, ownerUid: UID, approval: approval(state.manifest) }, state)).rejects.toThrow('exact packet');
  });
  test('ordinary upload remains ordinary; reconstructed fields contain only demo occurrence/provenance', async () => {
    await expect(resolveDemoReconstructionUpload({ raw: {}, ownerUid: UID })).resolves.toBeNull();
    const state = await authorized(), fields = state.reconstruction.callFields;
    expect(fields).toMatchObject({ uploadedBy: UID, uploadedByUserId: UID, callSource: 'manual_upload', visibilityScope: 'organization',
      salesAgentId: DEMO_RECONSTRUCTION_PROFILE_ID, matchedAgentAnalysisId: DEMO_RECONSTRUCTION_PROFILE_ID,
      demoReconstruction: { kind: 'sanitized_reconstruction', manifestSha256: approval(state.manifest).manifestSha256, week: state.manifest.week } });
    expect((fields.callOccurredAt as Timestamp).toDate().toISOString()).toBe(state.manifest.entries[0].demoOccurredAt);
    expect(fields.demoSeed).toBeUndefined(); expect(fields.synthetic).toBeUndefined(); expect(fields.callOccurredAtSource).toBeUndefined();
    expect(Object.keys(fields).some(key => key.startsWith('ccc'))).toBe(false);
  });
  test.each(['audioSha256', 'sizeBytes', 'contentType', 'originalFilename', 'agentId', 'agentName', 'agentRoutingMode',
    'transcriptionModel', 'analyzerModel', 'comparison', 'demoReconstructionEntryId', 'demoReconstructionManifestId',
    'demoSeedManifestId', 'demoSeedEntryId', 'sourceBucket', 'callOccurredAt', 'demoReconstruction', 'synthetic',
    'promptVersions', 'activityPromptVersions', 'analyzerModelOverrides', 'manualReminderInput', 'agentAnalysisId', 'batchId'])(
    'rejects forged upload field %s', async field => {
      const state = await authorized();
      await expect(resolveDemoReconstructionUpload({ raw: { ...rawUpload(state.manifest), [field]: 'forged' }, ownerUid: UID }, state)).rejects.toThrow();
    });
  test('partial/unapproved references are not ordinary uploads', async () => {
    const state = memoryDb(), manifest = fixture();
    await expect(resolveDemoReconstructionUpload({ raw: { demoReconstructionEntryId: 'lunes-01' }, ownerUid: UID }, state)).rejects.toThrow('references');
    await expect(resolveDemoReconstructionUpload({ raw: rawUpload(manifest), ownerUid: UID }, state)).rejects.toThrow('not authorized');
  });
  test('concurrent requests and consumed retries return the same reservation without creating calls', async () => {
    const state = await authorized();
    const [first, second] = await Promise.all([bind(state), bind(state, reservation(state, 'call-B'))]);
    expect(second).toEqual(first);
    const old = state.values.get('manual_upload_requests/call-A')!;
    old.status = 'consumed';
    jest.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    expect(await bind(state, reservation(state, 'call-C'))).toEqual(first);
    expect([...state.values.keys()].filter(path => path.startsWith('manual_upload_requests/'))).toEqual(['manual_upload_requests/call-A']);
    expect([...state.values.keys()].some(path => path.startsWith('calls/'))).toBe(false);
  });
  test('ignores forged in-memory provenance and drops source metadata before persistence', async () => {
    const state = await authorized();
    state.reconstruction.callFields = { uploadedBy: 'forged', callOccurredAt: Timestamp.now(), synthetic: true,
      demoSeed: { synthetic: true }, sourceBucket: 'forbidden' };
    state.reconstruction.approvedAt = Timestamp.fromMillis(0);
    const request = reservation(state);
    request.sourceBucket = 'forbidden'; request.callFields.cccAgentMappingId = 'forbidden';
    await bind(state, request);
    const stored = state.values.get('manual_upload_requests/call-A')!;
    expect(stored.callFields).toMatchObject({ uploadedBy: UID, callSource: 'manual_upload',
      demoReconstruction: { approvedAt: Timestamp.fromDate(NOW), kind: 'sanitized_reconstruction' } });
    expect(stored.callFields.callOccurredAt.toDate().toISOString()).toBe(state.manifest.entries[0].demoOccurredAt);
    expect(stored).not.toHaveProperty('sourceBucket');
    for (const key of ['cccAgentMappingId', 'sourceBucket', 'synthetic', 'demoSeed']) expect(stored.callFields).not.toHaveProperty(key);
  });
  test.each(['ownerUid', 'bucket', 'storagePath', 'originalFilename', 'audioSha256', 'sizeBytes', 'contentType', 'status', 'callId'])(
    'rejects prepared reservation mismatch %s', async field => {
      const state = await authorized(), request = reservation(state); request[field] = '../forged';
      await expect(bind(state, request)).rejects.toThrow();
      expect(state.writes()).toBe(12);
    });
  test.each(['transcriptionProvider', 'transcriptionModel', 'transcriptionComparison', 'analyzerModel', 'transcriptionProviderSnapshotVersion'])(
    'rejects processing change %s', async field => {
      const state = await authorized(), request = reservation(state); request.callFields[field] = 'forged';
      await expect(bind(state, request)).rejects.toThrow('processing');
      expect(state.writes()).toBe(12);
    });
  test.each(['missing', 'rejected', 'expired', 'changed-prompts', 'changed-date', 'changed-hash', 'changed-week', 'synthetic', 'lost-binding',
    'timestamp-type', 'approval-time-type', 'match-time-type'])(
    'does not replace %s bound reservation', async scenario => {
      const state = await authorized(); await bind(state);
      const old = state.values.get('manual_upload_requests/call-A')!, next = reservation(state, 'call-B');
      if (scenario === 'missing') state.values.delete('manual_upload_requests/call-A');
      if (scenario === 'rejected') old.status = 'rejected';
      if (scenario === 'expired') old.expiresAt = Timestamp.fromMillis(Date.now() - 1);
      if (scenario === 'changed-prompts') next.callFields.promptOverrides.core_fields = '2';
      if (scenario === 'changed-date') old.callFields.callOccurredAt = Timestamp.now();
      if (scenario === 'changed-hash') old.callFields.demoReconstruction.manifestSha256 = sha('changed');
      if (scenario === 'changed-week') old.callFields.demoReconstruction.week.start = '2026-09-14';
      if (scenario === 'synthetic') old.callFields.demoSeed = { synthetic: true };
      if (scenario === 'lost-binding') delete state.values.get(entryPath(state.manifest))!.callId;
      if (scenario === 'timestamp-type') {
        const time = old.callFields.callOccurredAt as Timestamp;
        old.callFields.callOccurredAt = [time.seconds, time.nanoseconds];
      }
      if (scenario === 'approval-time-type') {
        const time = old.callFields.demoReconstruction.approvedAt as Timestamp;
        old.callFields.demoReconstruction.approvedAt = [time.seconds, time.nanoseconds];
      }
      if (scenario === 'match-time-type') {
        const time = old.callFields.matchedAt as Timestamp;
        old.callFields.matchedAt = [time.seconds, time.nanoseconds];
      }
      await expect(bind(state, next)).rejects.toThrow();
      expect(state.values.has('manual_upload_requests/call-B')).toBe(false);
      expect(state.writes()).toBe(14);
    });
  test.each(['role', 'allowlist', 'approval', 'manifest', 'entry', 'profile', 'stale-context'])(
    'revalidates %s between resolution and binding', async scenario => {
      const state = await authorized();
      state.setBeforeTransaction(() => {
        if (scenario === 'role') state.values.get(MEMBER)!.role = 'supervisor';
        if (scenario === 'allowlist') state.values.set('config/allowedEmails', { emails: [] });
        if (scenario === 'approval') state.values.get(manifestPath(state.manifest))!.approval.manifestSha256 = sha('changed');
        if (scenario === 'manifest') state.values.get(manifestPath(state.manifest))!.entries[0].audioSha256 = sha('changed');
        if (scenario === 'entry') state.values.get(entryPath(state.manifest))!.scriptSha256 = sha('changed');
        if (scenario === 'profile') state.values.get(PROFILE)!.salesAgentName = 'Unapproved';
        if (scenario === 'stale-context') state.reconstruction.manifestSha256 = sha('changed');
      });
      await expect(bind(state)).rejects.toThrow();
      expect(state.writes()).toBe(12);
    });
  test('never overwrites another prepared request', async () => {
    const state = await authorized();
    state.values.set('manual_upload_requests/call-A', { ownerUid: 'unrelated' });
    await expect(bind(state)).rejects.toThrow('already reserved');
    expect(state.values.get('manual_upload_requests/call-A')).toEqual({ ownerUid: 'unrelated' });
    expect(state.writes()).toBe(12);
  });
});
