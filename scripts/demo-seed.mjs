#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, rename, mkdir, stat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT = 'kesp-demo-tonylai2789';
export const BUCKET = PROJECT + '.firebasestorage.app';
export const TIME_ZONE = 'America/Mexico_City';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'tts-1';
const VOICES = { agent: 'nova', customer: 'echo' };
const SAMPLE_RATE = 24000;
const MAX_BYTES = 25 * 1024 * 1024;
const OWNER = 'tonylai2789@gmail.com';
const TERMINAL_FAILURE = new Set(['error', 'canceled', 'deleted']);

export class SeedError extends Error {}
function requireThat(condition, message) { if (!condition) throw new SeedError(message); }
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
const hashJson = value => sha256(JSON.stringify(value));

export function parseOptions(args) {
  const options = { execute: false, asOf: new Date().toISOString() };
  const valued = new Map([['--project', 'project'], ['--as-of', 'asOf'], ['--id-token-file', 'tokenFile']]);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    requireThat(!seen.has(arg), 'Duplicate argument: ' + arg);
    seen.add(arg);
    if (arg === '--execute') options.execute = true;
    else {
      requireThat(valued.has(arg), 'Unknown argument: ' + arg);
      requireThat(args[i + 1] && !args[i + 1].startsWith('--'), 'Missing value: ' + arg);
      options[valued.get(arg)] = args[++i];
    }
  }
  requireThat(options.project === PROJECT, 'Explicit exact demo --project is required');
  requireThat(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(options.asOf) &&
    Number.isFinite(Date.parse(options.asOf)), '--as-of must be an ISO timestamp with timezone');
  if (options.execute) requireThat(options.tokenFile && isAbsolute(options.tokenFile), '--execute requires an absolute --id-token-file');
  return options;
}

function calendarParts(date, includeTime = false) {
  const settings = { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' } : {}) };
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', settings).formatToParts(date)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
const dateString = date => date.toISOString().slice(0, 10);
export function lastCompletedWeek(asOf) {
  const date = new Date(asOf);
  requireThat(Number.isFinite(date.getTime()), 'Invalid reference date');
  const parts = calendarParts(date);
  const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const daysSinceMonday = (localDate.getUTCDay() + 6) % 7;
  const monday = new Date(localDate.getTime() - (daysSinceMonday + 7) * 86400000);
  return { start: dateString(monday), end: dateString(new Date(monday.getTime() + 6 * 86400000)), timeZone: TIME_ZONE };
}

export function localOccurrence(date, hour) {
  const [year, month, day] = date.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, hour);
  let utc = target;
  for (let i = 0; i < 4; i++) {
    const p = calendarParts(new Date(utc), true);
    utc += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  const p = calendarParts(new Date(utc), true);
  requireThat(p.year === year && p.month === month && p.day === day && p.hour === hour, 'Unable to resolve local scenario time');
  return new Date(utc).toISOString();
}

export function validateSource(source) {
  requireThat(source.version === 1 && source.synthetic === true && source.language === 'es-MX', 'Invalid synthetic source version');
  requireThat(source.agent?.id === 'demo_lucia_modelo' && source.agent.name === 'Lucía Modelo' &&
    source.agent.organizationLabel === 'KESP Demo', 'Unexpected fictional agent identity');
  requireThat(Array.isArray(source.calls) && source.calls.length === 10, 'Exactly ten scripts are required');
  const ids = new Set(), slots = new Set();
  for (const call of source.calls) {
    requireThat(/^[a-z]+-0[12]$/.test(call.id) && !ids.has(call.id), 'Invalid or duplicate script ID');
    ids.add(call.id);
    requireThat(Number.isInteger(call.weekday) && call.weekday >= 0 && call.weekday <= 4 &&
      [10, 15].includes(call.hour), 'Scripts must be Monday-Friday at 10:00 and 15:00');
    const slot = call.weekday + ':' + call.hour;
    requireThat(!slots.has(slot), 'Duplicate weekday/time slot');
    slots.add(slot);
    requireThat(['good', 'mixed', 'poor'].includes(call.performance) && Array.isArray(call.turns) && call.turns.length >= 6,
      'Missing scenario variation or dialogue');
    for (let i = 0; i < call.turns.length; i++) {
      const turn = call.turns[i];
      requireThat(turn.speaker === (i % 2 ? 'customer' : 'agent') && typeof turn.text === 'string' &&
        turn.text.length > 0 && turn.text.length <= 4096, 'Invalid alternating speech turn');
      requireThat(!/[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|\d{6,}/i.test(turn.text), 'Unexpected contact/account content in synthetic script');
    }
    requireThat(call.turns[0].text.startsWith('Esta es una conversación ficticia de demostración, con voces generadas.'),
      'Every recording must disclose fictional content and generated voices');
    const words = wordCount(call);
    requireThat(words >= 350 && words <= 500, call.id + ' must contain 350-500 spoken words; got ' + words);
  }
  return source;
}
export const wordCount = call => call.turns.map(turn => turn.text).join(' ').trim().split(/\s+/u).length;
export const turnRequest = turn => ({ model: MODEL, voice: VOICES[turn.speaker], input: turn.text, response_format: 'pcm', speed: 1 });
export const turnKey = turn => hashJson(turnRequest(turn));

export function buildPlan(source, asOf) {
  validateSource(source);
  const week = lastCompletedWeek(asOf);
  const scenarioSha256 = hashJson(source);
  const id = 'synthetic-v1-' + week.start;
  const entries = source.calls.map(call => {
    const day = dateString(new Date(Date.parse(week.start + 'T00:00:00Z') + call.weekday * 86400000));
    return { id: call.id, originalFilename: id + '-' + call.id + '.wav',
      sourceOccurredAt: localOccurrence(day, call.hour), scriptSha256: hashJson(call),
      wordCount: wordCount(call), title: call.title, performance: call.performance };
  });
  const speechReservationMicros = source.calls.flatMap(call => call.turns)
    .reduce((sum, turn) => sum + Buffer.byteLength(turn.text) * 15, 0);
  return { id, version: 1, synthetic: true, projectId: PROJECT, agent: source.agent,
    scenarioSha256, week, entries, speechReservationMicros };
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writePrivate(path, data) {
  const temporary = path + '.tmp-' + process.pid;
  await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
async function writeJson(path, value) { await writePrivate(path, JSON.stringify(value, null, 2) + '\n'); }

/** No implicit repeat of a request whose charging/result status is unknown. */
export async function generateTurn(turn, cacheDir, speech) {
  const key = turnKey(turn);
  const stateFile = join(cacheDir, key + '.json');
  const pcmFile = join(cacheDir, key + '.pcm');
  const state = await readJson(stateFile);
  if (state) {
    requireThat(state.status === 'complete', 'Uncertain prior TTS attempt: reconcile checkpoint ' + key);
    const bytes = await readFile(pcmFile);
    requireThat(sha256(bytes) === state.sha256 && bytes.length > 0 && bytes.length % 2 === 0, 'Cached speech hash mismatch');
    return bytes;
  }
  // A crash after this write remains visible and never silently generates a second charge.
  await writeJson(stateFile, { status: 'requesting', key, requestedAt: new Date().toISOString() });
  const response = await speech.create(turnRequest(turn));
  const bytes = Buffer.from(await response.arrayBuffer());
  requireThat(bytes.length > 0 && bytes.length % 2 === 0 && bytes.length <= 10 * 1024 * 1024, 'Invalid PCM speech response');
  await writePrivate(pcmFile, bytes);
  await writeJson(stateFile, { status: 'complete', key, sha256: sha256(bytes), bytes: bytes.length });
  return bytes;
}

/** PCM parts share a fixed stock-TTS format; concatenate samples without artificial silence. */
export function pcmToWav(parts) {
  requireThat(parts.length > 0 && parts.every(part => Buffer.isBuffer(part) && part.length > 0 && part.length % 2 === 0),
    'PCM parts must be nonempty signed 16-bit sample buffers');
  const bytes = parts.reduce((sum, part) => sum + part.length, 0);
  requireThat(bytes + 44 <= MAX_BYTES, 'Generated audio exceeds 25 MiB');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + bytes, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, ...parts]);
}

export function validateAudio(bytes, duration) {
  requireThat(Number.isInteger(bytes) && bytes > 44 && bytes <= MAX_BYTES &&
    Number.isFinite(duration) && duration > 90 && duration <= 300,
  'Synthetic audio must be >90 and <=300 seconds, at most 25 MiB');
}

async function buildAudio(source, plan, workDir, speech) {
  const cacheDir = join(workDir, 'turns');
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const entries = [];
  for (let i = 0; i < source.calls.length; i++) {
    const parts = [];
    for (const turn of source.calls[i].turns) parts.push(await generateTurn(turn, cacheDir, speech));
    const bytes = pcmToWav(parts);
    const outputPath = join(workDir, plan.entries[i].originalFilename);
    await writePrivate(outputPath, bytes);
    const durationSeconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', outputPath], { encoding: 'utf8' }).trim());
    validateAudio(bytes.length, durationSeconds);
    entries.push({ ...plan.entries[i], sizeBytes: bytes.length, durationSeconds, audioSha256: sha256(bytes), contentType: 'audio/wav' });
    process.stdout.write(JSON.stringify({ generated: plan.entries[i].id, durationSeconds, sizeBytes: bytes.length }) + '\n');
  }
  return { ...plan, entries };
}

async function readOwnerToken(path, auth) {
  const actualPath = await realpath(path);
  requireThat(!actualPath.startsWith(ROOT + '/'), 'ID token file must be outside the repository');
  const metadata = await stat(actualPath);
  requireThat(metadata.isFile() && metadata.size < 20000 && (metadata.mode & 0o077) === 0, 'Token file must be a private regular file');
  const token = (await readFile(actualPath, 'utf8')).trim();
  const claims = await auth.verifyIdToken(token, true);
  requireThat(claims.aud === PROJECT && claims.email === OWNER && claims.email_verified === true &&
    claims.firebase?.sign_in_provider === 'google.com', 'A current approved Google-admin Firebase ID token is required');
  return { token, uid: claims.uid };
}

function assertRuntimeProject(env) {
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT', 'CLOUDSDK_CORE_PROJECT']) {
    requireThat(!env[key] || env[key] === PROJECT, 'Conflicting project environment: ' + key);
  }
  requireThat(!env.FIRESTORE_EMULATOR_HOST && !env.FIREBASE_AUTH_EMULATOR_HOST && !env.STORAGE_EMULATOR_HOST,
    'Live seed cannot mix emulator and hosted services');
}

export async function waitForFeedback(callId, getCall, getFeedback, sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  maxPolls = 120, expectedSeed) {
  for (let i = 0; i < maxPolls; i++) {
    const call = await getCall(callId);
    if (call) {
      requireThat(!TERMINAL_FAILURE.has(call.status), 'Call failed; seed stopped at ' + callId);
      if (call.status === 'complete') {
        requireThat(call.callSource === 'manual_upload' && call.salesAgentId === 'demo_lucia_modelo' &&
          call.audioStorageBucket === BUCKET && call.demoSeed?.synthetic === true &&
          call.analysisPipeline !== 'manual_short_call_review' && !call.shortCallReviewSource &&
          call.agentProfileExcluded !== true, 'Completed call failed seed eligibility/provenance checks');
        requireThat(typeof call.latestFeedbackId === 'string' && await getFeedback(callId, call.latestFeedbackId),
          'Completed call has no final feedback');
        if (expectedSeed) {
          const occurredAt = typeof call.callOccurredAt?.toDate === 'function'
            ? call.callOccurredAt.toDate().toISOString() : call.callOccurredAt;
          requireThat(call.demoSeed.manifestId === expectedSeed.manifestId &&
            call.demoSeed.entryId === expectedSeed.entryId && occurredAt === expectedSeed.sourceOccurredAt &&
            call.audioContentHash === expectedSeed.audioSha256,
          'Completed call has incorrect seed binding, date or audio hash');
        }
        return call;
      }
    }
    await sleep(10000);
  }
  throw new SeedError('Analysis wait expired; resume this manifest, never create a replacement call');
}

async function execute(source, plan, options) {
  assertRuntimeProject(process.env);
  process.env.GCLOUD_PROJECT = PROJECT;
  requireThat(process.env.OPENAI_API_KEY, 'Dedicated demo OPENAI_API_KEY must be provisioned before execution');
  const require = createRequire(join(ROOT, 'web/functions/package.json'));
  const admin = require('firebase-admin');
  admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET, credential: admin.credential.applicationDefault() });
  const { assertDemoRuntime } = require('./lib/demoBudget.js');
  assertDemoRuntime(process.env, PROJECT);
  const { authorizeDemoSeedManifest } = require('./lib/demoSeedAuthorization.js');
  requireThat(typeof authorizeDemoSeedManifest === 'function', 'Backend seed authorization integration is missing');
  const { createDemoOpenAI } = require('./lib/demoPaidProviders.js');
  const { readDemoMember } = require('./lib/demoAccess.js');
  const db = admin.firestore(), auth = admin.auth();
  const owner = await readOwnerToken(options.tokenFile, auth);
  requireThat((await readDemoMember(owner.uid, db, auth))?.role === 'admin', 'Live demo admin membership is required');
  // Single local process owns the cache. Cloud reservations still enforce cross-host idempotence.
  const workDir = join(ROOT, 'seed-audio', plan.id);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const lock = join(workDir, 'execution.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  try {
    const existing = await db.doc('demo_seed_manifests/' + plan.id).get();
    let manifest;
    if (existing.exists) {
      const stored = existing.data();
      requireThat(stored.scenarioSha256 === plan.scenarioSha256 && stored.projectId === PROJECT &&
        hashJson(stored.week) === hashJson(plan.week) && stored.entries?.length === 10,
      'Existing cloud manifest differs; no regeneration or overwrite allowed');
      // Only immutable source and audio fields reenter authorization, never Firestore metadata.
      manifest = { ...plan, entries: plan.entries.map((entry, i) => {
        const audio = stored.entries[i];
        for (const [key, value] of Object.entries(entry)) {
          requireThat(audio[key] === value, 'Stored seed entry differs from reviewed script');
        }
        validateAudio(audio.sizeBytes, audio.durationSeconds);
        requireThat(/^[a-f0-9]{64}$/.test(audio.audioSha256) && audio.contentType === 'audio/wav', 'Invalid stored audio authorization');
        return { ...entry, sizeBytes: audio.sizeBytes, durationSeconds: audio.durationSeconds,
          audioSha256: audio.audioSha256, contentType: audio.contentType };
      }) };
    } else {
      manifest = await buildAudio(source, plan, workDir, createDemoOpenAI({ purpose: 'synthetic_seed_tts' }).audio.speech);
    }
    await writeJson(join(workDir, 'manifest.json'), manifest);
    await authorizeDemoSeedManifest({ manifest, ownerUid: owner.uid });
    const bucket = admin.storage().bucket(BUCKET);
    for (const entry of manifest.entries) {
      const currentOwner = await readOwnerToken(options.tokenFile, auth);
      requireThat(currentOwner.uid === owner.uid, 'Seed owner changed');
      const response = await fetch('https://us-central1-' + PROJECT + '.cloudfunctions.net/prepareConsubancoTranscriptionUpload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + currentOwner.token },
        body: JSON.stringify({ data: {
          originalFilename: entry.originalFilename, sizeBytes: entry.sizeBytes, contentType: entry.contentType,
          audioSha256: entry.audioSha256, agentRoutingMode: 'specific', agentId: plan.agent.id,
          transcriptionModel: 'scribe_v2', demoSeedManifestId: plan.id, demoSeedEntryId: entry.id,
        } }), signal: AbortSignal.timeout(60000), redirect: 'error',
      });
      requireThat(response.ok, 'Prepared upload request failed (HTTP ' + response.status + '); no replacement queued');
      const result = (await response.json()).result;
      requireThat(result && /^[a-zA-Z0-9_-]+$/.test(result.callId) &&
        result.storagePath === 'prepared-uploads/' + owner.uid + '/' + result.callId + '/' + entry.originalFilename,
      'Unexpected upload reservation response');
      const binding = await db.doc('demo_seed_manifests/' + plan.id + '/entries/' + entry.id).get();
      requireThat(binding.data()?.callId === result.callId && binding.data()?.storagePath === result.storagePath,
        'Backend did not atomically bind seed entry to the reservation');
      const object = bucket.file(result.storagePath);
      const [exists] = await object.exists();
      if (exists) {
        const hash = createHash('sha256');
        for await (const chunk of object.createReadStream()) hash.update(chunk);
        requireThat(hash.digest('hex') === entry.audioSha256, 'Existing reserved object hash mismatch');
      } else {
        const path = join(workDir, entry.originalFilename);
        const bytes = await readFile(path);
        requireThat(bytes.length === entry.sizeBytes && sha256(bytes) === entry.audioSha256, 'Local audio differs from immutable manifest');
        await bucket.upload(path, { destination: result.storagePath, resumable: false, validation: 'crc32c',
          preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: 'audio/wav',
            metadata: { synthetic: 'true', generatedVoiceDisclosure: 'OpenAI stock voices; fictional dialogue' } } });
      }
      process.stdout.write(JSON.stringify({ entry: entry.id, callId: result.callId, status: 'uploaded-or-resumed' }) + '\n');
      await waitForFeedback(result.callId, async id => (await db.doc('calls/' + id).get()).data(),
        async (id, feedbackId) => (await db.doc('calls/' + id + '/feedback/' + feedbackId).get()).exists,
        undefined, 120, { manifestId: plan.id, entryId: entry.id,
          sourceOccurredAt: entry.sourceOccurredAt, audioSha256: entry.audioSha256 });
      process.stdout.write(JSON.stringify({ entry: entry.id, callId: result.callId, status: 'complete-with-feedback' }) + '\n');
    }
  } finally {
    const { unlink } = await import('node:fs/promises');
    await unlink(lock);
    await admin.app().delete();
  }
}

export async function main(args) {
  const options = parseOptions(args);
  const source = JSON.parse(await readFile(join(ROOT, 'synthetic/spanish-calls.v1.json'), 'utf8'));
  const plan = buildPlan(source, options.asOf);
  process.stdout.write(JSON.stringify({ mode: options.execute ? 'execute' : 'dry-run', ...plan,
    note: 'Speech estimate only; transcription and analysis draw from the same shared processing budget.' }, null, 2) + '\n');
  if (options.execute) await execute(source, plan, options);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Provider and auth errors may contain request headers or token fragments; never dump them.
    process.stderr.write((error instanceof SeedError ? error.message : 'Seed stopped safely; inspect private checkpoints and cloud logs (no automatic retry).') + '\n');
    process.exitCode = 1;
  });
}
