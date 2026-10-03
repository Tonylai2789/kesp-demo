import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertDemoEmailEnabled, demoId, readDemoMember, validateDemoMember } from './demoAccess';
import { assertDemoRuntime, assertDemoAudioLimits, DEMO_PROJECT_ID, DEMO_STORAGE_BUCKET } from './demoBudget';
import { buildConsubancoManualCallFields } from './callIdentity';
import { DEMO_SEED_AGENT } from './demoSeedAuthorization';

export const DEMO_RECONSTRUCTION_COLLECTION = 'demo_reconstruction_manifests';
export const DEMO_RECONSTRUCTION_PROFILE_ID = 'demo_lucia_reconstructed';
export const DEMO_RECONSTRUCTION_AGENT = { ...DEMO_SEED_AGENT, id: DEMO_RECONSTRUCTION_PROFILE_ID } as const;
const KIND = 'sanitized_reconstruction';
const ZONE = 'America/Mexico_City';
const MANIFEST_KEYS = ['id', 'version', 'kind', 'projectId', 'agent', 'week', 'entries'];
const ENTRY_KEYS = ['id', 'originalFilename', 'demoOccurredAt', 'scriptSha256', 'audioSha256', 'sizeBytes', 'durationSeconds', 'contentType'];
const AUDIO_KEYS = ['originalFilename', 'audioSha256', 'sizeBytes', 'contentType'];
const PROCESSING_KEYS = ['transcriptionProvider', 'transcriptionModel', 'transcriptionProviderSnapshotVersion',
  'transcriptionManualSelectionVersion', 'transcriptionComparison', 'analyzerModel', 'analyzerModelOverrides', 'promptOverrides', 'activityPromptOverrides'];
const DAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const MANIFEST_ID = /^reconstructed-v1-\d{4}-\d{2}-\d{2}$/;
const ENTRY_ID = /^(lunes|martes|miercoles|jueves|viernes|sabado|domingo)-(0[1-9]|10)$/;

export interface DemoReconstructionEntry {
  id: string; originalFilename: string; demoOccurredAt: string; scriptSha256: string; audioSha256: string;
  sizeBytes: number; durationSeconds: number; contentType: 'audio/wav';
}
export interface DemoReconstructionManifest {
  id: string; version: 1; kind: 'sanitized_reconstruction'; projectId: string;
  agent: typeof DEMO_RECONSTRUCTION_AGENT; week: { start: string; end: string; timeZone: string };
  entries: DemoReconstructionEntry[];
}
export interface DemoReconstructionUpload {
  ownerUid: string; manifestId: string; entryId: string; manifestSha256: string;
  entry: DemoReconstructionEntry; approvedAt: Timestamp; callFields: Record<string, unknown>;
}
interface Dependencies { db?: Firestore; auth?: admin.auth.Auth }
type Data = FirebaseFirestore.DocumentData;

function check(condition: unknown, message: string, code: 'invalid-argument' | 'permission-denied' | 'failed-precondition' = 'invalid-argument'): asserts condition {
  if (!condition) throw new HttpsError(code, message);
}
function record(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected reconstruction object');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  check(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), 'Unexpected or missing reconstruction fields');
}
function canonical(value: unknown): string {
  if (value instanceof Timestamp) return canonical([value.seconds, value.nanoseconds]);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const data = record(value);
    return '{' + Object.keys(data).sort().map(key => JSON.stringify(key) + ':' + canonical(data[key])).join(',') + '}';
  }
  check(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'Invalid reconstruction hash input');
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const pick = (data: Data, keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, data[key]]));
function calendarDate(value: unknown): Date {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Invalid demo date');
  const date = new Date(value + 'T00:00:00Z');
  check(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, 'Invalid demo date');
  return date;
}
function localParts(date: Date) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

/** Closed demo-only metadata. Hashes refer to reviewed reconstructed assets, never source bank assets.
 * Structural validation cannot certify sanitization; the operator must review the actual scripts/audio.
 */
export function validateDemoReconstructionManifest(value: unknown, now = new Date()): DemoReconstructionManifest {
  const data = record(value);
  exactKeys(data, MANIFEST_KEYS);
  check(data.version === 1 && data.kind === KIND && data.projectId === DEMO_PROJECT_ID, 'Only sanitized demo reconstruction is permitted');
  const agent = record(data.agent);
  exactKeys(agent, ['id', 'name', 'organizationLabel']);
  check(digest(agent) === digest(DEMO_RECONSTRUCTION_AGENT), 'Unexpected fictional profile');
  const week = record(data.week);
  exactKeys(week, ['start', 'end', 'timeZone']);
  const start = calendarDate(week.start), end = calendarDate(week.end), today = localParts(now);
  check(start.getUTCDay() === 1 && end.getTime() - start.getTime() === 6 * 86400000 &&
    end.getTime() < Date.UTC(today.year, today.month - 1, today.day) && week.timeZone === ZONE,
  'Demo week must be a completed Monday-Sunday Mexico City week');
  check(data.id === 'reconstructed-v1-' + week.start, 'Unexpected demo manifest ID');
  check(Array.isArray(data.entries) && data.entries.length >= 1 && data.entries.length <= 10, 'One to ten reconstructed entries required');
  const ids = new Set<string>(), hashes = new Set<string>();
  const entries = data.entries.map(value => {
    const entry = record(value);
    exactKeys(entry, ENTRY_KEYS);
    check(typeof entry.id === 'string' && ENTRY_ID.test(entry.id) && !ids.has(entry.id), 'Invalid or duplicate demo entry ID');
    ids.add(entry.id);
    check(entry.originalFilename === data.id + '-' + entry.id + '.wav', 'Filename must be the generated demo basename');
    for (const key of ['scriptSha256', 'audioSha256']) check(typeof entry[key] === 'string' && /^[a-f0-9]{64}$/.test(entry[key]), 'Invalid reconstructed asset hash');
    check(!hashes.has(entry.audioSha256 as string), 'Duplicate reconstructed audio');
    hashes.add(entry.audioSha256 as string);
    check(typeof entry.sizeBytes === 'number' && typeof entry.durationSeconds === 'number', 'Invalid reconstructed audio limits');
    assertDemoAudioLimits(entry.sizeBytes, entry.durationSeconds);
    check(entry.durationSeconds > 90 && entry.contentType === 'audio/wav' &&
      Math.abs((entry.sizeBytes - 44) / 48000 - entry.durationSeconds) < 0.02, 'Expected >90s 24kHz mono PCM WAV');
    check(typeof entry.demoOccurredAt === 'string', 'Missing demo occurrence time');
    const occurred = new Date(entry.demoOccurredAt);
    check(Number.isFinite(occurred.getTime()) && occurred.toISOString() === entry.demoOccurredAt, 'Invalid demo occurrence time');
    const parts = localParts(occurred), [day, slot] = entry.id.split('-');
    const slotMinutes = 10 * 60 + (Number(slot) - 1) * 30;
    check(Date.UTC(parts.year, parts.month - 1, parts.day) === start.getTime() + DAYS.indexOf(day) * 86400000 &&
      parts.hour === Math.floor(slotMinutes / 60) && parts.minute === slotMinutes % 60 &&
      parts.second === 0 && occurred.getUTCMilliseconds() === 0,
    'Occurrence must match the fictional demo weekday/time');
    return { ...entry } as unknown as DemoReconstructionEntry;
  });
  return { id: data.id as string, version: 1, kind: KIND, projectId: DEMO_PROJECT_ID, agent: { ...DEMO_RECONSTRUCTION_AGENT },
    week: { start: week.start as string, end: week.end as string, timeZone: ZONE }, entries };
}

/** Give this exact hash to the human reviewer; approval of another packet never authorizes this one. */
export function hashDemoReconstructionManifest(manifest: unknown): string {
  return digest(validateDemoReconstructionManifest(manifest));
}
function database(deps: Dependencies): Firestore {
  assertDemoRuntime(process.env, admin.apps.length ? admin.app().options.projectId : undefined);
  return deps.db ?? admin.firestore();
}
async function ownerMember(ownerUid: string, db: Firestore, auth?: admin.auth.Auth) {
  demoId(ownerUid);
  const member = await readDemoMember(ownerUid, db, auth);
  check(member?.role === 'admin', 'An active Google demo admin is required', 'permission-denied');
  return member;
}
async function transactionOwner(tx: FirebaseFirestore.Transaction, db: Firestore, uid: string, email: string) {
  const allowed = await tx.get(db.doc('config/allowedEmails'));
  const member = await tx.get(db.doc('organizations/consubanco/members/' + uid));
  check(validateDemoMember(member.data(), uid, email) === 'admin', 'Demo admin permission was revoked', 'permission-denied');
  assertDemoEmailEnabled(email as Parameters<typeof assertDemoEmailEnabled>[0], allowed.data());
}
function profileFields(ownerUid: string) {
  return { uploadedBy: ownerUid, salesAgentId: DEMO_RECONSTRUCTION_PROFILE_ID, salesAgentName: DEMO_RECONSTRUCTION_AGENT.name,
    organizationId: 'consubanco', visibilityScope: 'organization', isActiveAgentProfile: true,
    activeAgentProfileKey: DEMO_RECONSTRUCTION_PROFILE_ID, activeAgentSource: 'reconstructed_demo',
    activeAgentDisplayName: DEMO_RECONSTRUCTION_AGENT.name, demoReconstructionProfile: { version: 1, kind: KIND } };
}
function assertProfile(data: Data | undefined, ownerUid: string): void {
  const expected = profileFields(ownerUid);
  check(data && digest(pick(data, Object.keys(expected))) === digest(expected) &&
    !Object.keys(data).some(key => key.startsWith('ccc') || key === 'demoSeedProfile' || key === 'synthetic'),
  'Existing fictional profile is missing or unrelated', 'failed-precondition');
}
function storedManifest(data: Data | undefined, ownerUid: string): DemoReconstructionManifest {
  check(data, 'Reconstruction manifest not authorized', 'failed-precondition');
  exactKeys(data, [...MANIFEST_KEYS, 'ownerUid', 'authorizationVersion', 'manifestSha256', 'approval']);
  const manifest = validateDemoReconstructionManifest(pick(data, MANIFEST_KEYS)), approval = record(data.approval);
  exactKeys(approval, ['approvedByUid', 'approvedAt', 'manifestSha256', 'kind']);
  check(data.ownerUid === ownerUid && data.authorizationVersion === 1 && data.manifestSha256 === digest(manifest) &&
    approval.approvedByUid === ownerUid && approval.kind === 'human_review' && approval.manifestSha256 === data.manifestSha256 &&
    approval.approvedAt instanceof Timestamp, 'Stored reconstruction approval conflicts', 'failed-precondition');
  return manifest;
}
function entryFields(manifest: DemoReconstructionManifest, entry: DemoReconstructionEntry, ownerUid: string) {
  return { ...entry, ownerUid, manifestId: manifest.id, manifestSha256: digest(manifest), agentAnalysisId: DEMO_RECONSTRUCTION_PROFILE_ID };
}
function assertEntry(data: Data | undefined, manifest: DemoReconstructionManifest, entry: DemoReconstructionEntry, ownerUid: string): void {
  const expected = entryFields(manifest, entry, ownerUid);
  check(data && digest(pick(data, Object.keys(expected))) === digest(expected), 'Reconstruction entry is missing or conflicts', 'failed-precondition');
}

/** ADC/operator only; never export through index.ts or a callable. approved:true attests human review
 * of the actual sanitized reconstructed scripts/audio identified by the manifest, not just its schema.
 */
export async function authorizeDemoReconstructionManifest(input: {
  manifest: unknown; ownerUid: string; approval: { approved: true; manifestSha256: string };
}, deps: Dependencies = {}): Promise<void> {
  const manifest = validateDemoReconstructionManifest(input.manifest), approval = record(input.approval), manifestSha256 = digest(manifest);
  exactKeys(approval, ['approved', 'manifestSha256']);
  check(approval.approved === true && approval.manifestSha256 === manifestSha256, 'Explicit human approval of this exact packet is required', 'permission-denied');
  const db = database(deps), owner = await ownerMember(input.ownerUid, db, deps.auth), approvedAt = Timestamp.now();
  const ref = db.doc(DEMO_RECONSTRUCTION_COLLECTION + '/' + manifest.id), profileRef = db.doc('agent_analyses/' + DEMO_RECONSTRUCTION_PROFILE_ID);
  await db.runTransaction(async tx => {
    await transactionOwner(tx, db, input.ownerUid, owner.email);
    const stored = await tx.get(ref), profile = await tx.get(profileRef), entries: FirebaseFirestore.DocumentSnapshot[] = [];
    for (const entry of manifest.entries) entries.push(await tx.get(ref.collection('entries').doc(entry.id)));
    if (profile.exists) assertProfile(profile.data(), input.ownerUid);
    if (stored.exists) {
      check(profile.exists && digest(storedManifest(stored.data(), input.ownerUid)) === manifestSha256, 'Immutable reconstruction manifest conflicts', 'failed-precondition');
      entries.forEach((entry, index) => assertEntry(entry.data(), manifest, manifest.entries[index], input.ownerUid));
      return;
    }
    check(entries.every(entry => !entry.exists), 'Orphan reconstruction entries require review', 'failed-precondition');
    if (!profile.exists) tx.create(profileRef, { ...profileFields(input.ownerUid), status: 'ready', error: null, createdAt: approvedAt, updatedAt: approvedAt });
    tx.create(ref, { ...manifest, ownerUid: input.ownerUid, authorizationVersion: 1, manifestSha256,
      approval: { kind: 'human_review', approvedByUid: input.ownerUid, approvedAt, manifestSha256 } });
    manifest.entries.forEach(entry => tx.create(ref.collection('entries').doc(entry.id), { ...entryFields(manifest, entry, input.ownerUid), status: 'authorized' }));
  });
}

function callFields(manifest: DemoReconstructionManifest, entry: DemoReconstructionEntry, ownerUid: string, approvedAt: Timestamp) {
  return { ...buildConsubancoManualCallFields(ownerUid), organizationName: 'KESP Demo', visibilityScope: 'organization',
    salesAgentId: DEMO_RECONSTRUCTION_PROFILE_ID, salesAgentName: DEMO_RECONSTRUCTION_AGENT.name,
    matchedAgentAnalysisId: DEMO_RECONSTRUCTION_PROFILE_ID, matchedAgentProfileKey: DEMO_RECONSTRUCTION_PROFILE_ID,
    matchedAgentName: DEMO_RECONSTRUCTION_AGENT.name, matchedAgentConfidence: 1,
    agentRoutingMode: 'specific', agentRoutingStatus: 'matched', agentRoutingReason: 'authorized_reconstruction',
    matchedBy: 'approved_reconstruction_manifest', matchedAt: approvedAt,
    callOccurredAt: Timestamp.fromDate(new Date(entry.demoOccurredAt)),
    demoReconstruction: { version: 1, kind: KIND, manifestId: manifest.id, entryId: entry.id, manifestSha256: digest(manifest),
      scriptSha256: entry.scriptSha256, audioSha256: entry.audioSha256, week: { ...manifest.week },
      approvedByUid: ownerUid, approvedAt } };
}

export async function resolveDemoReconstructionUpload(input: {
  raw: Record<string, unknown>; ownerUid: string;
}, deps: Dependencies = {}): Promise<DemoReconstructionUpload | null> {
  const { raw, ownerUid } = input;
  if (raw.demoReconstructionManifestId === undefined && raw.demoReconstructionEntryId === undefined) return null;
  check(typeof raw.demoReconstructionManifestId === 'string' && MANIFEST_ID.test(raw.demoReconstructionManifestId) &&
    typeof raw.demoReconstructionEntryId === 'string' && ENTRY_ID.test(raw.demoReconstructionEntryId), 'Both valid reconstruction references are required');
  const allowed = [...AUDIO_KEYS, 'demoReconstructionManifestId', 'demoReconstructionEntryId', 'agentId', 'agentName', 'agentRoutingMode',
    'transcriptionModel', 'analyzerModel', 'comparison'];
  check(Object.keys(raw).every(key => allowed.includes(key)), 'Reconstruction upload cannot override provenance or processing');
  const db = database(deps);
  await ownerMember(ownerUid, db, deps.auth);
  const ref = db.doc(DEMO_RECONSTRUCTION_COLLECTION + '/' + raw.demoReconstructionManifestId), stored = (await ref.get()).data();
  const manifest = storedManifest(stored, ownerUid), entry = manifest.entries.find(value => value.id === raw.demoReconstructionEntryId);
  check(entry, 'Entry is not part of the approved packet', 'permission-denied');
  assertEntry((await ref.collection('entries').doc(entry.id).get()).data(), manifest, entry, ownerUid);
  assertProfile((await db.doc('agent_analyses/' + DEMO_RECONSTRUCTION_PROFILE_ID).get()).data(), ownerUid);
  check(digest(pick(raw, AUDIO_KEYS)) === digest(pick(entry, AUDIO_KEYS)), 'Upload differs from approved reconstructed audio');
  check(raw.agentId === DEMO_RECONSTRUCTION_PROFILE_ID && raw.agentRoutingMode === 'specific' &&
    (raw.agentName === undefined || raw.agentName === DEMO_RECONSTRUCTION_AGENT.name) &&
    (raw.transcriptionModel === undefined || raw.transcriptionModel === 'scribe_v2') &&
    (raw.analyzerModel === undefined || raw.analyzerModel === 'gpt-5.4') &&
    (raw.comparison === undefined || raw.comparison === false), 'Reconstruction routing/model cannot be changed');
  const approvedAt = stored!.approval.approvedAt as Timestamp;
  return { ownerUid, manifestId: manifest.id, entryId: entry.id, manifestSha256: digest(manifest), entry, approvedAt,
    callFields: callFields(manifest, entry, ownerUid, approvedAt) };
}

/** Atomically bind exactly one ordinary prepared upload; replay may return the consumed reservation. */
export async function bindDemoReconstructionPreparedUpload(input: {
  reconstruction: DemoReconstructionUpload; requestRecord: Data;
}, deps: Dependencies = {}): Promise<{ callId: string; storagePath: string }> {
  const { reconstruction: context, requestRecord: request } = input, db = database(deps);
  const owner = await ownerMember(context.ownerUid, db, deps.auth);
  check(MANIFEST_ID.test(context.manifestId) && ENTRY_ID.test(context.entryId), 'Invalid reconstruction context');
  const callId = demoId(request.callId);
  check(/^[a-zA-Z0-9_-]+$/.test(callId), 'Invalid prepared call ID');
  const processing = pick(record(request.callFields), PROCESSING_KEYS);
  check(processing.transcriptionProvider === 'elevenlabs' && processing.transcriptionModel === 'scribe_v2' &&
    processing.transcriptionProviderSnapshotVersion === 1 && processing.transcriptionManualSelectionVersion === 1 &&
    processing.transcriptionComparison === false && processing.analyzerModel === 'gpt-5.4' &&
    Object.keys(record(processing.analyzerModelOverrides)).length === 0, 'Invalid reconstruction processing configuration');
  const configSha256 = digest(processing);
  return db.runTransaction(async tx => {
    await transactionOwner(tx, db, context.ownerUid, owner.email);
    const ref = db.doc(DEMO_RECONSTRUCTION_COLLECTION + '/' + context.manifestId), stored = (await tx.get(ref)).data();
    const manifest = storedManifest(stored, context.ownerUid), entry = manifest.entries.find(value => value.id === context.entryId);
    check(digest(manifest) === context.manifestSha256 && entry && digest(entry) === digest(context.entry), 'Stale reconstruction authorization', 'failed-precondition');
    const entryRef = ref.collection('entries').doc(entry.id), binding = (await tx.get(entryRef)).data();
    assertEntry(binding, manifest, entry, context.ownerUid);
    assertProfile((await tx.get(db.doc('agent_analyses/' + DEMO_RECONSTRUCTION_PROFILE_ID))).data(), context.ownerUid);
    const storagePath = 'prepared-uploads/' + context.ownerUid + '/' + callId + '/' + entry.originalFilename;
    check(request.ownerUid === context.ownerUid && request.bucket === DEMO_STORAGE_BUCKET && request.storagePath === storagePath &&
      request.status === 'prepared' && request.createdAt instanceof Timestamp && request.expiresAt instanceof Timestamp &&
      request.expiresAt.toMillis() > Date.now() && digest(pick(request, AUDIO_KEYS)) === digest(pick(entry, AUDIO_KEYS)),
    'Invalid reconstructed upload reservation');
    // Discard caller-owned identity/provenance and extra fields; rebuild solely from persisted approval.
    const fields = { ...processing, ...callFields(manifest, entry, context.ownerUid, stored!.approval.approvedAt) };
    if (binding!.callId !== undefined) {
      check(typeof binding!.callId === 'string' && /^[a-zA-Z0-9_-]+$/.test(binding!.callId) &&
        binding!.status === 'prepared' && binding!.configSha256 === configSha256, 'Bound reconstruction processing snapshot changed', 'failed-precondition');
      const old = (await tx.get(db.doc('manual_upload_requests/' + binding!.callId))).data();
      check(old && old.callId === binding!.callId && old.ownerUid === context.ownerUid && old.bucket === DEMO_STORAGE_BUCKET &&
        old.storagePath === binding!.storagePath && old.storagePath === 'prepared-uploads/' + context.ownerUid + '/' + binding!.callId + '/' + entry.originalFilename &&
        digest(pick(old, AUDIO_KEYS)) === digest(pick(entry, AUDIO_KEYS)) && ['prepared', 'consumed'].includes(old.status),
      'Bound reconstruction reservation is missing or rejected', 'failed-precondition');
      const oldFields = record(old.callFields), provenance = record(oldFields.demoReconstruction);
      check(oldFields.callOccurredAt instanceof Timestamp && oldFields.matchedAt instanceof Timestamp &&
        provenance.approvedAt instanceof Timestamp && digest(oldFields) === digest(fields),
      'Bound reconstruction provenance or configuration changed', 'failed-precondition');
      check(old.status === 'consumed' || (old.expiresAt instanceof Timestamp && old.expiresAt.toMillis() > Date.now()),
        'Bound reconstruction reservation expired; explicit recovery required', 'failed-precondition');
      return { callId: binding!.callId, storagePath: binding!.storagePath };
    }
    check(binding!.status === 'authorized' && binding!.storagePath === undefined && binding!.configSha256 === undefined &&
      binding!.boundAt === undefined, 'Damaged reconstruction binding requires review', 'failed-precondition');
    const requestRef = db.doc('manual_upload_requests/' + callId);
    check(!(await tx.get(requestRef)).exists, 'Prepared call ID already reserved', 'failed-precondition');
    tx.create(requestRef, { ownerUid: context.ownerUid, callId, storagePath, bucket: DEMO_STORAGE_BUCKET,
      ...pick(entry, AUDIO_KEYS), callFields: fields, status: 'prepared', createdAt: request.createdAt, expiresAt: request.expiresAt });
    tx.update(entryRef, { callId, storagePath, configSha256, status: 'prepared', boundAt: Timestamp.now() });
    return { callId, storagePath };
  });
}
