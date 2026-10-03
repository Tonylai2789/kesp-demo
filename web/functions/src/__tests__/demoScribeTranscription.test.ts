import { stat } from 'fs/promises';
import { getAudioDuration } from '../ffmpeg';
import { reserveDemoSpend, reconcileDemoSpend } from '../demoBudget';
import { transcribeScribe } from '../scribeTranscription';

jest.mock('fs/promises', () => ({ stat: jest.fn() }));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'), openAsBlob: jest.fn(async () => new Blob(['synthetic-audio'])),
}));
jest.mock('../ffmpeg', () => ({ getAudioDuration: jest.fn() }));
jest.mock('../demoBudget', () => ({
  ...jest.requireActual('../demoBudget'), reserveDemoSpend: jest.fn(), reconcileDemoSpend: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (stat as jest.Mock).mockResolvedValue({ size: 1500, isFile: () => true });
  (getAudioDuration as jest.Mock).mockResolvedValue(120);
  (reserveDemoSpend as jest.Mock).mockResolvedValue('scribe-attempt');
  (reconcileDemoSpend as jest.Mock).mockResolvedValue(undefined);
});

const input = {
  audioPath: '/synthetic/audio.mp3', duration: 120, apiKey: 'fake-key',
  callId: 'fictional-call', processingGeneration: 2, shouldContinue: async () => true,
};

test('reprobes actual bytes, reserves first, and preserves Scribe v2 request shape', async () => {
  const transport = jest.fn(async (_url: unknown, init?: RequestInit) => {
    const body = init?.body as FormData;
    expect(body.get('model_id')).toBe('scribe_v2');
    expect(body.get('diarize')).toBe('true');
    expect(init?.redirect).toBe('error');
    return new Response(JSON.stringify({
      text: 'Buenos dias.', words: [{ text: 'Buenos dias.', type: 'word', start: 0, end: 1, speaker_id: 'agent' }],
    }));
  });
  const transcript = await transcribeScribe({ ...input, fetchImpl: transport as typeof fetch });
  expect(transcript.duration).toBe(120);
  expect(reserveDemoSpend).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'elevenlabs', callId: 'fictional-call', processingGeneration: 2, upperBoundMicros: 33334,
  }));
  expect(transport.mock.invocationCallOrder[0]).toBeGreaterThan((reserveDemoSpend as jest.Mock).mock.invocationCallOrder[0]);
  expect(reconcileDemoSpend).toHaveBeenCalledWith('scribe-attempt', 33334);
});

test('corrupt, long and mismatched audio cannot reach either ledger or provider', async () => {
  const transport = jest.fn();
  (getAudioDuration as jest.Mock).mockResolvedValue(301);
  await expect(transcribeScribe({ ...input, fetchImpl: transport })).rejects.toThrow();
  (getAudioDuration as jest.Mock).mockResolvedValue(121);
  await expect(transcribeScribe({ ...input, fetchImpl: transport })).rejects.toThrow('duration changed');
  (getAudioDuration as jest.Mock).mockRejectedValue(new Error('corrupt'));
  await expect(transcribeScribe({ ...input, fetchImpl: transport })).rejects.toThrow('corrupt');
  expect(transport).not.toHaveBeenCalled();
  expect(reserveDemoSpend).not.toHaveBeenCalled();
});

test('transport failure retains charge and makes no hidden retry', async () => {
  const transport = jest.fn().mockRejectedValue(new TypeError('network'));
  await expect(transcribeScribe({ ...input, fetchImpl: transport })).rejects.toMatchObject({ code: 'ECONNRESET' });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(reconcileDemoSpend).toHaveBeenCalledWith('scribe-attempt', null);
});
