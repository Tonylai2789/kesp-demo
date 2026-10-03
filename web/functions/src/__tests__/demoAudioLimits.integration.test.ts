import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runFFmpeg } from '../ffmpeg';
import { validateDemoAudioFile } from '../demoBudget';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'kesp-demo-audio-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test('real file duration admits a two-minute synthetic waveform', async () => {
  const file = join(directory, 'synthetic.wav');
  const result = await runFFmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
    '-t', '120', '-c:a', 'pcm_s16le', '-y', file], 30_000);
  expect(result.exitCode).toBe(0);
  await expect(validateDemoAudioFile(file)).resolves.toBeCloseTo(120);
}, 40_000);

test('real over-five-minute recording is rejected before any paid request', async () => {
  const file = join(directory, 'too-long.wav');
  const result = await runFFmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
    '-t', '301', '-c:a', 'pcm_s16le', '-y', file], 30_000);
  expect(result.exitCode).toBe(0);
  await expect(validateDemoAudioFile(file)).rejects.toMatchObject({ code: 'demo_audio_limit' });
}, 40_000);

test('actual corrupt audio fails closed', async () => {
  const file = join(directory, 'corrupt.wav');
  await writeFile(file, 'not an audio recording');
  await expect(validateDemoAudioFile(file)).rejects.toThrow('ffprobe failed');
}, 40_000);
