import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertDemoEmailEnabled, demoId, readDemoMember, validateDemoMember } from './demoAccess';
import { assertDemoRuntime, DEMO_PROJECT_ID, DEMO_STORAGE_BUCKET, DEMO_MAX_AUDIO_BYTES } from './demoBudget';

export const DEMO_SEED_COLLECTION = 'demo_seed_manifests';
export const DEMO_SEED_PROFILE_ID = 'demo_lucia_modelo';
export const DEMO_SEED_AGENT = { id: DEMO_SEED_PROFILE_ID, name: 'Lucía Modelo', organizationLabel: 'KESP Demo' } as const;
const ZONE = 'America/Mexico_City';
const SOURCE_SHA = 'f571f5760e533a0260c5f33245f2cf660fa6da9f8c65f3fd0dfc3af286f37814';
const SCRIPTS: Readonly<Record<string, string>> = {
  'lunes-01': 'e56a4ec054c7ca4fd4e3a79305358a9bf5651a4cb00d6cf495cf6d5ec46028d6',
  'lunes-02': '0487b576ce5184fda4b2144a76ce364e08c0dba0d84b4bc87428e185b0789b0f',
  'martes-01': 'a6dd4f528a8fcf38327e68f3635b24fe64a7eb554f5277cff1e013129f5b78bc',
  'martes-02': '78a59c566dd0717469a362c169443e6715d24899570979d405b22ad1090fb647',
  'miercoles-01': '6220cdac81a98b537b4131a5d60bb451db15e5ad1924ff08d02e215211329491',
  'miercoles-02': '46d888c20c80557f959af9a0a00cf9b95cbc8895ddd53bc1089826acbe5f43ea',
  'jueves-01': '9c8b9d3b9326f7ca61bc86452f7131a022d9a55db06866217f3f0e7984e0f35c',
  'jueves-02': '1a76d7c8b0b4d4443090b88edef679d82b3d615a932be7701311cf3816ca1d20',
  'viernes-01': 'd891e8044c519587456f41267e17fb06bc3eefe89de3e86b6df3975ae842a556',
  'viernes-02': 'a2b78d1871ddec797208eabec1c8d327c0113cc14e3b5f5f2eca985c972df09c',
};
const WEEKDAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];
const MANIFEST_KEYS = ['id', 'version', 'synthetic', 'projectId', 'agent', 'scenarioSha256', 'week', 'entries', 'speechReservationMicros'];
const ENTRY_KEYS = ['id', 'originalFilename', 'sourceOccurredAt', 'scriptSha256', 'wordCount', 'title', 'performance',
  'sizeBytes', 'durationSeconds', 'audioSha256', 'contentType'];

export interface DemoSeedEntry {
  id: string; originalFilename: string; sourceOccurredAt: string; scriptSha256: string;
  wordCount: number; title: string; performance: 'good' | 'mixed' | 'poor';
  sizeBytes: number; durationSeconds: number; audioSha256: string; contentType: 'audio/wav';
}
export interface DemoSeedManifest {
  id: string; version: 1; synthetic: true; projectId: string; agent: typeof DEMO_SEED_AGENT;
  scenarioSha256: string; week: { start: string; end: string; timeZone: string };
  entries: DemoSeedEntry[]; speechReservationMicros: number;
}
interface Dependencies { db?: Firestore; auth?: admin.auth.Auth }
export interface DemoSeedUpload {
  ownerUid: string; manifestId: string; entryId: string; manifestSha256: string;
  entry: DemoSeedEntry; generatedAt: Timestamp; callFields: Record<string, unknown>;
}

function check(condition: unknown, message: string, code: 'invalid-argument' | 'permission-denied' | 'failed-precondition' = 'invalid-argument'): asserts condition {
  if (!condition) throw new HttpsError(code, message);
}
function record(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected seed object');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  check(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), 'Unexpected or missing seed fields');
}
function calendarDate(value: unknown): Date {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Invalid seed calendar date');
  const parsed = new Date(value + 'T00:00:00Z');
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, 'Invalid seed calendar date');
  return parsed;
}
function localParts(value: Date) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(value)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value instanceof Timestamp) return canonical(value.toMillis());
  if (value && typeof value === 'object') {
    const data = value as Record<string, unknown>;
    return '{' + Object.keys(data).sort().map(key => JSON.stringify(key) + ':' + canonical(data[key])).join(',') + '}';
  }
  check(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'Invalid seed hash input');
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const pick = (value: FirebaseFirestore.DocumentData, keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, value[key]]));

/** Strict reviewed-source authorization, not a general historical call import API. */
export function validateDemoSeedManifest(value: unknown, now = new Date()): DemoSeedManifest {
  const data = record(value);
  exactKeys(data, MANIFEST_KEYS);
  check(data.version === 1 && data.synthetic === true && data.projectId === DEMO_PROJECT_ID && data.scenarioSha256 === SOURCE_SHA,
    'Only the reviewed synthetic demo source is permitted');
  const agent = record(data.agent);
  exactKeys(agent, ['id', 'name', 'organizationLabel']);
  check(digest(agent) === digest(DEMO_SEED_AGENT), 'Unexpected fictional agent');
  const week = record(data.week);
  exactKeys(week, ['start', 'end', 'timeZone']);
  const start = calendarDate(week.start), end = calendarDate(week.end);
  const today = localParts(now);
  check(start.getUTCDay() === 1 && end.getTime() - start.getTime() === 6 * 86400000 &&
    end.getTime() < Date.UTC(today.year, today.month - 1, today.day) && week.timeZone === ZONE,
  'Seed week must be a completed Monday-Sunday Mexico City week');
  check(data.id === 'synthetic-v1-' + week.start && data.speechReservationMicros === 435000, 'Unexpected reviewed seed identifier or speech estimate');
  check(Array.isArray(data.entries) && data.entries.length >= 1 && data.entries.length <= 10, 'Seed needs one to ten entries');
  const ids = new Set<string>(), hashes = new Set<string>();
  const entries = data.entries.map(value => {
    const item = record(value);
    exactKeys(item, ENTRY_KEYS);
    check(typeof item.id === 'string' && Object.prototype.hasOwnProperty.call(SCRIPTS, item.id) && !ids.has(item.id), 'Unknown or duplicate synthetic script');
    ids.add(item.id);
    check(item.scriptSha256 === SCRIPTS[item.id] && item.originalFilename === data.id + '-' + item.id + '.wav', 'Unreviewed script hash or source filename');
    check(typeof item.title === 'string' && item.title.length >= 1 && item.title.length <= 120 &&
      !Array.from(item.title).some(char => char.charCodeAt(0) < 32) && !/https?:\/\/|@|\d{6,}/.test(item.title) &&
      Number.isInteger(item.wordCount) && Number(item.wordCount) >= 350 && Number(item.wordCount) <= 500 &&
      ['good', 'mixed', 'poor'].includes(String(item.performance)), 'Invalid synthetic scenario metadata');
    check(Number.isSafeInteger(item.sizeBytes) && Number(item.sizeBytes) > 44 && Number(item.sizeBytes) <= DEMO_MAX_AUDIO_BYTES &&
      typeof item.durationSeconds === 'number' && Number.isFinite(item.durationSeconds) && item.durationSeconds > 90 && item.durationSeconds <= 300 &&
      Math.abs((Number(item.sizeBytes) - 44) / 48000 - item.durationSeconds) < 0.02 && item.contentType === 'audio/wav',
    'Seed audio must be bounded 24kHz mono PCM WAV');
    check(typeof item.audioSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.audioSha256) && !hashes.has(item.audioSha256), 'Invalid or duplicate synthetic audio hash');
    hashes.add(item.audioSha256);
    check(typeof item.sourceOccurredAt === 'string', 'Missing synthetic scenario time');
    const occurred = new Date(item.sourceOccurredAt);
    check(Number.isFinite(occurred.getTime()) && occurred.toISOString() === item.sourceOccurredAt, 'Invalid synthetic scenario timestamp');
    const parts = localParts(occurred), [dayName, slot] = item.id.split('-');
    check(Date.UTC(parts.year, parts.month - 1, parts.day) === start.getTime() + WEEKDAYS.indexOf(dayName) * 86400000 &&
      parts.hour === (slot === '01' ? 10 : 15) && parts.minute === 0 && parts.second === 0 && occurred.getUTCMilliseconds() === 0,
    'Synthetic timestamp does not match the authorized weekday/time');
    return { ...item } as unknown as DemoSeedEntry;
  });
  return { id: data.id as string, version: 1, synthetic: true, projectId: DEMO_PROJECT_ID, agent: { ...DEMO_SEED_AGENT },
    scenarioSha256: SOURCE_SHA, week: { start: week.start as string, end: week.end as string, timeZone: ZONE }, entries, speechReservationMicros: 435000 };
}

function database(deps: Dependencies): Firestore {
  const db = deps.db ?? admin.firestore();
  assertDemoRuntime(process.env, admin.apps.length ? admin.app().options.projectId : undefined);
  return db;
}
async function ownerMember(ownerUid: string, db: Firestore, auth?: admin.auth.Auth) {
  demoId(ownerUid);
  const member = await readDemoMember(ownerUid, db, auth);
  check(member?.role === 'admin' && member.accessEnabled !== false, 'An active Google demo admin is required', 'permission-denied');
  return member;
}
async function transactionOwner(transaction: FirebaseFirestore.Transaction, db: Firestore, ownerUid: string, email: string): Promise<void> {
  const allowed = await transaction.get(db.doc('config/allowedEmails'));
  const member = await transaction.get(db.doc('organizations/consubanco/members/' + ownerUid));
  check(validateDemoMember(member.data(), ownerUid, email) === 'admin', 'Demo admin permission was revoked', 'permission-denied');
  assertDemoEmailEnabled(email as Parameters<typeof assertDemoEmailEnabled>[0], allowed.data());
}
function assertProfile(data: FirebaseFirestore.DocumentData | undefined, ownerUid: string): void {
  check(data?.uploadedBy === ownerUid && data.salesAgentId === DEMO_SEED_PROFILE_ID && data.salesAgentName === DEMO_SEED_AGENT.name &&
    data.organizationId === 'consubanco' && data.visibilityScope === 'organization' && data.activeAgentSource === 'synthetic_demo' &&
    data.demoSeedProfile?.synthetic === true && data.demoSeedProfile?.version === 1 && !data.cccAgentMappingId && !data.cccAccountNumber && !data.cccUserId,
  'Existing profile is unrelated; it will not be overwritten', 'failed-precondition');
}
function storedManifest(data: FirebaseFirestore.DocumentData | undefined): DemoSeedManifest {
  check(data, 'Seed manifest not authorized', 'failed-precondition');
  return validateDemoSeedManifest(pick(data, MANIFEST_KEYS));
}
function assertStoredManifest(data: FirebaseFirestore.DocumentData | undefined, manifest: DemoSeedManifest, ownerUid: string): void {
  check(data?.ownerUid === ownerUid && data.authorizationVersion === 1 && data.manifestSha256 === digest(manifest) &&
    data.generatedAt instanceof Timestamp && digest(storedManifest(data)) === digest(manifest),
  'Existing manifest conflicts with this authorization', 'failed-precondition');
}
function assertStoredEntry(data: FirebaseFirestore.DocumentData | undefined, manifest: DemoSeedManifest, entry: DemoSeedEntry, ownerUid: string): void {
  check(data?.ownerUid === ownerUid && data.manifestId === manifest.id && data.manifestSha256 === digest(manifest) &&
    data.agentAnalysisId === DEMO_SEED_PROFILE_ID && data.generatedAt instanceof Timestamp && digest(pick(data, ENTRY_KEYS)) === digest(entry),
  'Seed entry is missing or conflicts with its manifest', 'failed-precondition');
}

/** Operator-only helper: no call/analysis/feedback creation and no public endpoint. */
export async function authorizeDemoSeedManifest(input: { manifest: unknown; ownerUid: string }, deps: Dependencies = {}): Promise<void> {
  const db = database(deps), owner = await ownerMember(input.ownerUid, db, deps.auth);
  const manifest = validateDemoSeedManifest(input.manifest), generatedAt = Timestamp.now();
  const manifestRef = db.doc(DEMO_SEED_COLLECTION + '/' + manifest.id), profileRef = db.doc('agent_analyses/' + DEMO_SEED_PROFILE_ID);
  await db.runTransaction(async transaction => {
    await transactionOwner(transaction, db, input.ownerUid, owner.email);
    const stored = await transaction.get(manifestRef), profile = await transaction.get(profileRef);
    const entries: FirebaseFirestore.DocumentSnapshot[] = [];
    for (const entry of manifest.entries) entries.push(await transaction.get(manifestRef.collection('entries').doc(entry.id)));
    if (profile.exists) assertProfile(profile.data(), input.ownerUid);
    if (stored.exists) {
      check(profile.exists, 'Authorized seed profile is missing', 'failed-precondition');
      assertStoredManifest(stored.data(), manifest, input.ownerUid);
      entries.forEach((entry, index) => assertStoredEntry(entry.data(), manifest, manifest.entries[index], input.ownerUid));
      return;
    }
    check(entries.every(entry => !entry.exists), 'Orphan seed entries must be reviewed, not overwritten', 'failed-precondition');
    if (!profile.exists) transaction.create(profileRef, {
      uploadedBy: input.ownerUid, salesAgentId: DEMO_SEED_PROFILE_ID, salesAgentName: DEMO_SEED_AGENT.name,
      organizationId: 'consubanco', visibilityScope: 'organization', status: 'ready', error: null,
      isActiveAgentProfile: true, activeAgentProfileKey: DEMO_SEED_PROFILE_ID, activeAgentSource: 'synthetic_demo',
      activeAgentDisplayName: DEMO_SEED_AGENT.name, demoSeedProfile: { version: 1, synthetic: true },
      seededAt: generatedAt, createdAt: generatedAt, updatedAt: generatedAt,
    });
    transaction.create(manifestRef, { ...manifest, ownerUid: input.ownerUid, authorizationVersion: 1, manifestSha256: digest(manifest), generatedAt });
    manifest.entries.forEach(entry => transaction.create(manifestRef.collection('entries').doc(entry.id), {
      ...entry, ownerUid: input.ownerUid, manifestId: manifest.id, manifestSha256: digest(manifest),
      agentAnalysisId: DEMO_SEED_PROFILE_ID, generatedAt, status: 'authorized',
    }));
  });
}

function seedCallFields(manifest: DemoSeedManifest, entry: DemoSeedEntry, ownerUid: string, generatedAt: Timestamp): Record<string, unknown> {
  return {
    uploadedBy: ownerUid, callSource: 'manual_upload', organizationId: 'consubanco', visibilityScope: 'organization',
    salesAgentId: DEMO_SEED_PROFILE_ID, salesAgentName: DEMO_SEED_AGENT.name,
    matchedAgentAnalysisId: DEMO_SEED_PROFILE_ID, matchedAgentProfileKey: DEMO_SEED_PROFILE_ID,
    matchedAgentName: DEMO_SEED_AGENT.name, matchedAgentConfidence: 1,
    agentRoutingMode: 'specific', agentRoutingStatus: 'matched', agentRoutingReason: 'authorized_synthetic_seed',
    matchedBy: 'authorized_seed_manifest', matchedAt: generatedAt,
    // No CCC source enum: this timestamp belongs to an explicitly fictional scenario.
    callOccurredAt: Timestamp.fromDate(new Date(entry.sourceOccurredAt)),
    demoSeed: { synthetic: true, version: 1, manifestId: manifest.id, entryId: entry.id, generatedAt,
      sourceTimeZone: ZONE, scriptSha256: entry.scriptSha256, scenarioSha256: manifest.scenarioSha256 },
  };
}

function processingConfigHash(fields: Record<string, unknown>): string {
  return digest({ analyzerModel: fields.analyzerModel, transcriptionModel: fields.transcriptionModel,
    analyzerModelOverrides: fields.analyzerModelOverrides ?? {}, promptOverrides: fields.promptOverrides ?? {},
    activityPromptOverrides: fields.activityPromptOverrides ?? {} });
}

/** Call before ordinary routing: the references select backend-owned dates/profile, never client fields. */
export async function resolveDemoSeedUpload(input: { raw: Record<string, unknown>; ownerUid: string }, deps: Dependencies = {}): Promise<DemoSeedUpload | null> {
  const raw = input.raw;
  if (raw.demoSeedManifestId === undefined && raw.demoSeedEntryId === undefined) return null;
  const db = database(deps);
  await ownerMember(input.ownerUid, db, deps.auth);
  check(typeof raw.demoSeedManifestId === 'string' && /^synthetic-v1-\d{4}-\d{2}-\d{2}$/.test(raw.demoSeedManifestId) &&
    typeof raw.demoSeedEntryId === 'string' && Object.prototype.hasOwnProperty.call(SCRIPTS, raw.demoSeedEntryId), 'Both valid seed references are required');
  const ref = db.doc(DEMO_SEED_COLLECTION + '/' + raw.demoSeedManifestId), stored = (await ref.get()).data();
  const manifest = storedManifest(stored);
  assertStoredManifest(stored, manifest, input.ownerUid);
  const entry = manifest.entries.find(candidate => candidate.id === raw.demoSeedEntryId);
  check(entry, 'Entry is not part of this authorized manifest', 'permission-denied');
  assertStoredEntry((await ref.collection('entries').doc(entry.id).get()).data(), manifest, entry, input.ownerUid);
  assertProfile((await db.doc('agent_analyses/' + DEMO_SEED_PROFILE_ID).get()).data(), input.ownerUid);
  for (const field of ['originalFilename', 'sizeBytes', 'contentType', 'audioSha256'] as const) check(raw[field] === entry[field], 'Upload differs from authorized seed audio');
  check(raw.agentId === DEMO_SEED_PROFILE_ID && raw.agentRoutingMode === 'specific' &&
    (raw.transcriptionModel === undefined || raw.transcriptionModel === 'scribe_v2') &&
    (raw.analyzerModel === undefined || raw.analyzerModel === 'gpt-5.4') &&
    (raw.comparison === undefined || raw.comparison === false), 'Seed routing/model cannot be changed');
  for (const field of ['analyzerModelOverrides', 'promptVersions', 'activityPromptVersions', 'manualReminderInput', 'agentAnalysisId', 'batchId']) {
    check(raw[field] === undefined, 'Seed upload cannot override ' + field);
  }
  const generatedAt = stored!.generatedAt as Timestamp;
  return { ownerUid: input.ownerUid, manifestId: manifest.id, entryId: entry.id, manifestSha256: digest(manifest), entry, generatedAt,
    callFields: seedCallFields(manifest, entry, input.ownerUid, generatedAt) };
}

/** Atomic normal reservation + seed binding; no duplicate calls on replay or concurrent requests. */
export async function bindDemoSeedPreparedUpload(input: {
  seed: DemoSeedUpload; requestRecord: FirebaseFirestore.DocumentData;
}, deps: Dependencies = {}): Promise<{ callId: string; storagePath: string }> {
  const db = database(deps), { seed, requestRecord } = input, owner = await ownerMember(seed.ownerUid, db, deps.auth);
  const proposedCallId = demoId(requestRecord.callId);
  check(/^[a-zA-Z0-9_-]+$/.test(proposedCallId), 'Invalid prepared call ID');
  const path = 'prepared-uploads/' + seed.ownerUid + '/' + proposedCallId + '/' + seed.entry.originalFilename;
  check(requestRecord.ownerUid === seed.ownerUid && requestRecord.bucket === DEMO_STORAGE_BUCKET && requestRecord.storagePath === path &&
    requestRecord.status === 'prepared' && requestRecord.createdAt instanceof Timestamp && requestRecord.expiresAt instanceof Timestamp &&
    requestRecord.expiresAt.toMillis() > Date.now(), 'Invalid seed upload reservation');
  for (const field of ['originalFilename', 'sizeBytes', 'contentType', 'audioSha256'] as const) check(requestRecord[field] === seed.entry[field], 'Prepared request differs from authorized audio');
  const proposed = record(requestRecord.callFields);
  check(proposed.callSource === 'manual_upload' && proposed.transcriptionModel === 'scribe_v2' &&
    proposed.analyzerModel === 'gpt-5.4' && proposed.transcriptionComparison === false, 'Invalid seed processing configuration');
  const configSha256 = processingConfigHash(proposed);
  return db.runTransaction(async transaction => {
    await transactionOwner(transaction, db, seed.ownerUid, owner.email);
    const manifestRef = db.doc(DEMO_SEED_COLLECTION + '/' + seed.manifestId), stored = (await transaction.get(manifestRef)).data();
    const manifest = storedManifest(stored);
    assertStoredManifest(stored, manifest, seed.ownerUid);
    check(digest(manifest) === seed.manifestSha256, 'Stale seed authorization', 'failed-precondition');
    const entry = manifest.entries.find(value => value.id === seed.entryId);
    check(entry && digest(entry) === digest(seed.entry), 'Stale seed entry', 'failed-precondition');
    const entryRef = manifestRef.collection('entries').doc(seed.entryId), binding = (await transaction.get(entryRef)).data();
    assertStoredEntry(binding, manifest, entry, seed.ownerUid);
    assertProfile((await transaction.get(db.doc('agent_analyses/' + DEMO_SEED_PROFILE_ID))).data(), seed.ownerUid);
    if (binding!.callId) {
      check(binding!.configSha256 === configSha256, 'Seed processing snapshot changed; reuse requires original configuration', 'failed-precondition');
      const old = (await transaction.get(db.doc('manual_upload_requests/' + demoId(binding!.callId)))).data();
      check(old?.ownerUid === seed.ownerUid && old.bucket === DEMO_STORAGE_BUCKET && old.storagePath === binding!.storagePath &&
        old.storagePath === 'prepared-uploads/' + seed.ownerUid + '/' + binding!.callId + '/' + entry.originalFilename &&
        old.audioSha256 === entry.audioSha256 && old.sizeBytes === entry.sizeBytes && old.originalFilename === entry.originalFilename &&
        ['prepared', 'consumed'].includes(old.status), 'Bound seed reservation is missing or rejected', 'failed-precondition');
      const oldFields = record(old.callFields), oldSeed = record(oldFields.demoSeed);
      check(oldFields.uploadedBy === seed.ownerUid && oldFields.salesAgentId === DEMO_SEED_PROFILE_ID &&
        oldFields.matchedAgentAnalysisId === DEMO_SEED_PROFILE_ID && oldFields.callSource === 'manual_upload' &&
        oldSeed.synthetic === true && oldSeed.manifestId === manifest.id && oldSeed.entryId === entry.id &&
        processingConfigHash(oldFields) === configSha256, 'Bound seed reservation provenance was altered', 'failed-precondition');
      check(old.status === 'consumed' || (old.expiresAt instanceof Timestamp && old.expiresAt.toMillis() > Date.now()),
        'Seed reservation expired; explicit recovery is required, not a duplicate call', 'failed-precondition');
      return { callId: binding!.callId, storagePath: binding!.storagePath };
    }
    const requestRef = db.doc('manual_upload_requests/' + proposedCallId);
    check(!(await transaction.get(requestRef)).exists, 'Prepared call ID is already reserved', 'failed-precondition');
    // Reconstruct identity/provenance from persisted authorization, not the context supplied by a caller.
    transaction.create(requestRef, { ...requestRecord, callFields: {
      ...proposed, ...seedCallFields(manifest, entry, seed.ownerUid, stored!.generatedAt as Timestamp),
    } });
    transaction.update(entryRef, { callId: proposedCallId, storagePath: path, configSha256, status: 'prepared', boundAt: Timestamp.now() });
    return { callId: proposedCallId, storagePath: path };
  });
}
