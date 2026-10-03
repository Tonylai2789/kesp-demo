import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ROOT, PROJECT, BUCKET, parseOptions, lastCompletedWeek, localOccurrence, validateSource,
  buildPlan, wordCount, turnKey, generateTurn, pcmToWav, validateAudio, waitForFeedback,
} from './demo-seed.mjs';

const source = JSON.parse(await readFile(join(ROOT, 'synthetic/spanish-calls.v1.json'), 'utf8'));
const reference = '2026-10-01T12:00:00Z';

test('the approved seed contains exactly ten original bounded Spanish scripts', () => {
  assert.equal(validateSource(source), source);
  assert.equal(source.calls.length, 10);
  assert.deepEqual(new Set(source.calls.map(call => call.performance)), new Set(['good', 'poor', 'mixed']));
  for (const call of source.calls) {
    assert.ok(wordCount(call) >= 350 && wordCount(call) <= 500);
    assert.equal(call.turns.filter(turn => turn.speaker === 'agent').length, 4);
    assert.equal(call.turns.filter(turn => turn.speaker === 'customer').length, 4);
  }
});

test('October 1 resolves to the prior completed Mexico City calendar week', () => {
  assert.deepEqual(lastCompletedWeek(reference), {
    start: '2026-09-21', end: '2026-09-27', timeZone: 'America/Mexico_City',
  });
});

test('local Sunday is not prematurely treated as a completed week', () => {
  assert.equal(lastCompletedWeek('2026-09-28T05:59:59Z').start, '2026-09-14');
  assert.equal(lastCompletedWeek('2026-09-28T06:00:00Z').start, '2026-09-21');
});

test('reference dates cross year/month boundaries correctly', () => {
  assert.equal(lastCompletedWeek('2027-01-01T12:00:00Z').start, '2026-12-21');
  assert.equal(lastCompletedWeek('2027-01-04T12:00:00Z').start, '2026-12-28');
  assert.throws(() => lastCompletedWeek('not-a-date'), /Invalid reference/);
});

test('local scenario times are converted to UTC, not machine timezone', () => {
  assert.equal(localOccurrence('2026-09-21', 10), '2026-09-21T16:00:00.000Z');
  assert.equal(localOccurrence('2026-09-21', 15), '2026-09-21T21:00:00.000Z');
});

test('plan IDs and hashes are deterministic within a week', () => {
  const first = buildPlan(source, reference);
  const second = buildPlan(source, '2026-10-02T12:00:00Z');
  assert.deepEqual(first, second);
  assert.equal(first.id, 'synthetic-v1-2026-09-21');
  assert.equal(new Set(first.entries.map(entry => entry.id)).size, 10);
  assert.equal(first.entries.filter(entry => entry.sourceOccurredAt.startsWith('2026-09-21')).length, 2);
  assert.equal(first.entries.filter(entry => entry.sourceOccurredAt.startsWith('2026-09-25')).length, 2);
  assert.ok(first.speechReservationMicros > 0 && first.speechReservationMicros < 1000000);
  const changed = structuredClone(source);
  changed.calls[0].turns[1].text += ' Gracias.';
  assert.notEqual(buildPlan(changed, reference).scenarioSha256, first.scenarioSha256);
  assert.notEqual(buildPlan(changed, reference).entries[0].scriptSha256, first.entries[0].scriptSha256);
});

test('source rejects duplicated slots, identities and contact details', () => {
  const duplicate = structuredClone(source);
  duplicate.calls[1].hour = 10;
  assert.throws(() => validateSource(duplicate), /Duplicate weekday/);
  const identity = structuredClone(source);
  identity.agent.name = 'An unrelated agent';
  assert.throws(() => validateSource(identity), /Unexpected fictional agent/);
  const contact = structuredClone(source);
  contact.calls[0].turns[0].text += ' cliente@example.org';
  assert.throws(() => validateSource(contact), /contact\/account/);
});

test('CLI requires exact demo project and explicit execution flag', () => {
  const options = parseOptions(['--project', PROJECT, '--as-of', reference]);
  assert.equal(options.execute, false);
  assert.throws(() => parseOptions([]), /exact demo/);
  assert.throws(() => parseOptions(['--project', 'another-project']), /exact demo/);
  assert.throws(() => parseOptions(['--project', PROJECT, '--execute']), /id-token-file/);
  assert.throws(() => parseOptions(['--project', PROJECT, '--as-of', '2026-10-01']), /timezone/);
  assert.throws(() => parseOptions(['--project', PROJECT, '--force']), /Unknown/);
  assert.throws(() => parseOptions(['--project', PROJECT, '--project', PROJECT]), /Duplicate/);
});

test('dry run succeeds without credentials or backend build and creates no cloud calls', () => {
  const output = execFileSync(process.execPath, [join(ROOT, 'scripts/demo-seed.mjs'),
    '--project', PROJECT, '--as-of', reference], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir() },
  });
  const report = JSON.parse(output);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.entries.length, 10);
});

test('voice request cache identity changes with speaker or dialogue', () => {
  const turn = source.calls[0].turns[0];
  assert.equal(turnKey(turn), turnKey(structuredClone(turn)));
  assert.notEqual(turnKey(turn), turnKey({ ...turn, speaker: 'customer' }));
  assert.notEqual(turnKey(turn), turnKey({ ...turn, text: turn.text + ' Gracias.' }));
});

test('a completed TTS checkpoint reuses verified audio without provider calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-seed-cache-'));
  try {
    let calls = 0;
    const speech = { create: async () => { calls++; return new Response(Buffer.alloc(4800, 1)); } };
    const first = await generateTurn(source.calls[0].turns[0], dir, speech);
    const second = await generateTurn(source.calls[0].turns[0], dir, speech);
    assert.deepEqual(first, second);
    assert.equal(calls, 1);
    await writeFile(join(dir, turnKey(source.calls[0].turns[0]) + '.pcm'), Buffer.alloc(4800, 2));
    await assert.rejects(generateTurn(source.calls[0].turns[0], dir, speech), /hash mismatch/);
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ambiguous provider failure cannot silently create another charge on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-seed-uncertain-'));
  try {
    let calls = 0;
    const speech = { create: async () => { calls++; throw new Error('simulated transport failure'); } };
    await assert.rejects(generateTurn(source.calls[0].turns[0], dir, speech), /simulated/);
    await assert.rejects(generateTurn(source.calls[0].turns[0], dir, speech), /Uncertain prior TTS/);
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PCM assembly retains exact samples and produces a valid WAV', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-seed-wav-'));
  try {
    const parts = [Buffer.alloc(24000, 1), Buffer.alloc(24000, 2)];
    const wav = pcmToWav(parts);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.readUInt32LE(40), 48000);
    assert.deepEqual(wav.subarray(44), Buffer.concat(parts));
    const path = join(dir, 'test.wav');
    await writeFile(path, wav);
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', path], { encoding: 'utf8' }).trim());
    assert.equal(duration, 1);
    assert.throws(() => pcmToWav([Buffer.alloc(3)]), /16-bit/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('duration validation is strict at short-call threshold and upload ceiling', () => {
  assert.throws(() => validateAudio(1000, 90), /Synthetic audio/);
  assert.throws(() => validateAudio(1000, 300.01), /Synthetic audio/);
  assert.throws(() => validateAudio(26 * 1024 * 1024, 120), /Synthetic audio/);
  assert.throws(() => validateAudio(1000, NaN), /Synthetic audio/);
  assert.doesNotThrow(() => validateAudio(1000, 90.01));
  assert.doesNotThrow(() => validateAudio(25 * 1024 * 1024, 300));
});

const completed = { status: 'complete', callSource: 'manual_upload', salesAgentId: 'demo_lucia_modelo',
  audioStorageBucket: BUCKET, demoSeed: { synthetic: true }, latestFeedbackId: 'feedback-1' };

test('restart waits on the existing call and verifies final feedback, not a fake completed status', async () => {
  const states = [undefined, { status: 'uploaded' }, { status: 'analyzing' }, completed];
  let reads = 0, sleeps = 0;
  const result = await waitForFeedback('call-1', async () => states[reads++],
    async (callId, id) => callId === 'call-1' && id === 'feedback-1', async () => { sleeps++; });
  assert.deepEqual(result, completed);
  assert.equal(reads, 4);
  assert.equal(sleeps, 3);
});

test('errors, short calls, missing feedback and timeout stop instead of queueing replacements', async () => {
  const noSleep = async () => {};
  await assert.rejects(waitForFeedback('c', async () => ({ status: 'error' }), async () => true, noSleep), /failed/);
  await assert.rejects(waitForFeedback('c', async () => ({ ...completed, shortCallReviewSource: 'synthetic' }),
    async () => true, noSleep), /eligibility/);
  await assert.rejects(waitForFeedback('c', async () => completed, async () => false, noSleep), /final feedback/);
  await assert.rejects(waitForFeedback('c', async () => ({ status: 'analyzing' }), async () => false, noSleep, 2), /wait expired/);
});

test('completed calls must preserve exact backend-owned scenario date and manifest binding', async () => {
  const seed = { manifestId: 'synthetic-v1-2026-09-21', entryId: 'lunes-01',
    sourceOccurredAt: '2026-09-21T16:00:00.000Z', audioSha256: 'a'.repeat(64) };
  const call = { ...completed, demoSeed: { synthetic: true, manifestId: seed.manifestId, entryId: seed.entryId },
    audioContentHash: seed.audioSha256, callOccurredAt: { toDate: () => new Date(seed.sourceOccurredAt) } };
  assert.equal(await waitForFeedback('c', async () => call, async () => true, async () => {}, 1, seed), call);
  await assert.rejects(waitForFeedback('c', async () => ({ ...call, audioContentHash: 'b'.repeat(64) }),
    async () => true, async () => {}, 1, seed), /incorrect seed binding/);
});
