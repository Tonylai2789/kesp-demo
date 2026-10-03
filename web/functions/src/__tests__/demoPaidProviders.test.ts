import { reserveDemoSpend, reconcileDemoSpend, DEMO_PROJECT_ID } from '../demoBudget';
import {
  boundedDemoCompletion, completionUsageMicros, createDemoOpenAIFetch, createDemoOpenAI, withDemoPaidOperation, DEMO_OPENAI_PROJECT_ID, DEMO_MAX_INPUT_BYTES,
} from '../demoPaidProviders';

jest.mock('../ffmpeg', () => ({ getAudioDuration: jest.fn() }));
jest.mock('../demoBudget', () => ({
  ...jest.requireActual('../demoBudget'),
  reserveDemoSpend: jest.fn(),
  reconcileDemoSpend: jest.fn(),
}));

beforeEach(() => {
  process.env.GCLOUD_PROJECT = DEMO_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GCP_PROJECT;
  delete process.env.FIREBASE_CONFIG;
  process.env.OPENAI_API_KEY = 'not-a-real-key';
  jest.clearAllMocks();
  (reserveDemoSpend as jest.Mock).mockResolvedValue('attempt-1');
  (reconcileDemoSpend as jest.Mock).mockResolvedValue(undefined);
});

const requestBody = { model: 'gpt-5.4', messages: [{ role: 'user', content: 'Una llamada ficticia.' }] };

test('caps output and bounds inputs without modifying source request', () => {
  const prepared = boundedDemoCompletion({ ...requestBody, max_tokens: 50_000 });
  expect(prepared.body.max_completion_tokens).toBe(8192);
  expect(prepared.body.max_tokens).toBeUndefined();
  expect(prepared.body.store).toBe(false);
  expect(prepared.upperBoundMicros).toBeGreaterThan(8192 * 15);
  expect(() => boundedDemoCompletion({ ...requestBody, stream: true })).toThrow();
  expect(() => boundedDemoCompletion({ ...requestBody, n: 2 })).toThrow();
  expect(() => boundedDemoCompletion({ ...requestBody, service_tier: 'priority' })).toThrow();
  expect(() => boundedDemoCompletion({ ...requestBody, model: 'unpriced' })).toThrow();
  for (const model of ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra']) {
    expect(() => boundedDemoCompletion({ ...requestBody, model })).toThrow('reviewed demo price');
  }
  expect(() => boundedDemoCompletion({ ...requestBody, messages: [{ role: 'user', content: 'x'.repeat(DEMO_MAX_INPUT_BYTES + 1) }] })).toThrow();
  expect(() => boundedDemoCompletion({ ...requestBody, messages: [{ role: 'user', content: [{ type: 'image_url' }] }] })).toThrow();
});

test('admits bounded Scribe word timings without dropping transcript data', () => {
  const transcript = { text: 'Una demostracion ficticia.', words: Array.from({ length: 1400 }, (_, i) => ({
    text: 'demostracion', start: i / 5, end: (i + 1) / 5, type: 'word', speaker_id: 'speaker_0', logprob: -0.01,
  })) };
  const prepared = boundedDemoCompletion({ ...requestBody, messages: [
    { role: 'system', content: 'Instrucciones '.repeat(1500) },
    { role: 'user', content: JSON.stringify(transcript) },
  ] });
  expect(Buffer.byteLength(JSON.stringify(prepared.body))).toBeGreaterThan(120_000);
  expect(Buffer.byteLength(JSON.stringify(prepared.body))).toBeLessThan(DEMO_MAX_INPUT_BYTES);
  expect((prepared.body.messages as Array<{ content: string }>)[1].content).toBe(JSON.stringify(transcript));
  expect(prepared.upperBoundMicros).toBeLessThan(800_000);
});

test('usage includes full completion/reasoning tokens and rejects missing usage', () => {
  expect(completionUsageMicros('gpt-5.4', { prompt_tokens: 100, completion_tokens: 200 })).toBe(3250);
  expect(completionUsageMicros('gpt-5.4', {})).toBeNull();
  expect(completionUsageMicros('gpt-5.4', { prompt_tokens: -1, completion_tokens: 2 })).toBeNull();
});

test('smaller models reject conservatively oversized contexts before reserving or sending', async () => {
  const transport = jest.fn();
  const guarded = createDemoOpenAIFetch({ purpose: 'analysis' }, transport);
  for (const model of ['gpt-4o-mini', 'gpt-4o']) {
    await expect(guarded('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({
      model, messages: [{ role: 'user', content: 'x'.repeat(120_000) }],
    }) })).rejects.toMatchObject({ code: 'demo_context_limit' });
  }
  expect(reserveDemoSpend).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

test('transport cannot execute until reservation succeeds, then actual usage reconciles', async () => {
  const transport = jest.fn().mockResolvedValue(new Response(JSON.stringify({
    usage: { prompt_tokens: 100, completion_tokens: 200 },
  }), { status: 200 }));
  const guarded = createDemoOpenAIFetch({ purpose: 'analysis', callId: 'call-a', processingGeneration: 3 }, transport);
  await guarded('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(requestBody) });
  expect(reserveDemoSpend).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-a', processingGeneration: 3 }));
  expect(reconcileDemoSpend).toHaveBeenCalledWith('attempt-1', 3250);
  expect(transport.mock.invocationCallOrder[0]).toBeGreaterThan((reserveDemoSpend as jest.Mock).mock.invocationCallOrder[0]);
  expect(transport.mock.calls[0][1].redirect).toBe('error');
  expect(transport.mock.calls[0][1].headers.get('OpenAI-Project')).toBe(DEMO_OPENAI_PROJECT_ID);
  const submitted = JSON.parse(transport.mock.calls[0][1].body);
  expect(submitted.max_completion_tokens).toBe(8192);
});

test('budget rejection and invalid endpoints never reach the provider', async () => {
  const transport = jest.fn();
  const guarded = createDemoOpenAIFetch({ purpose: 'analysis' }, transport);
  (reserveDemoSpend as jest.Mock).mockRejectedValue(new Error('budget exhausted'));
  await expect(guarded('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(requestBody) })).rejects.toThrow('budget exhausted');
  await expect(guarded('https://other.example/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toThrow();
  await expect(guarded('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

test('unknown or failed provider responses retain the reservation', async () => {
  const transport = jest.fn().mockRejectedValue(new Error('connection reset'));
  const guarded = createDemoOpenAIFetch({ purpose: 'analysis' }, transport);
  await expect(guarded('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(requestBody) })).rejects.toThrow();
  expect(reconcileDemoSpend).toHaveBeenLastCalledWith('attempt-1', null);
  transport.mockResolvedValue(new Response('gateway failure', { status: 502 }));
  await guarded('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(requestBody) });
  expect(reconcileDemoSpend).toHaveBeenLastCalledWith('attempt-1', null);
});

test('seed TTS is stock voice only and shares the paid ledger', async () => {
  const transport = jest.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200 }));
  const guarded = createDemoOpenAIFetch({ purpose: 'synthetic_seed_tts' }, transport);
  const body = { model: 'tts-1', voice: 'alloy', input: 'Hola mundo.' };
  await guarded('https://api.openai.com/v1/audio/speech', { method: 'POST', body: JSON.stringify(body) });
  expect(reserveDemoSpend).toHaveBeenCalledWith(expect.objectContaining({ upperBoundMicros: 165, model: 'tts-1' }));
  await expect(guarded('https://api.openai.com/v1/audio/speech', { method: 'POST', body: JSON.stringify({ ...body, voice: 'cloned-voice' }) })).rejects.toThrow();
});

test('audio provider requires file limit plus server-measured duration', async () => {
  const transport = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  const body = new FormData();
  body.set('file', new Blob(['audio']), 'fictional.wav');
  body.set('model', 'gpt-4o-transcribe-diarize');
  await expect(createDemoOpenAIFetch({ purpose: 'transcription' }, transport)(
    'https://api.openai.com/v1/audio/transcriptions', { method: 'POST', body })).rejects.toThrow();
  await createDemoOpenAIFetch({ purpose: 'transcription', audioDurationSeconds: 120 }, transport)(
    'https://api.openai.com/v1/audio/transcriptions', { method: 'POST', body });
  expect(reserveDemoSpend).toHaveBeenCalledWith(expect.objectContaining({ upperBoundMicros: 200_000 }));
});

test('SDK retry is zero and generic seed operation retains unknown charge', async () => {
  expect(createDemoOpenAI({ purpose: 'analysis' }).maxRetries).toBe(0);
  expect(createDemoOpenAI({ purpose: 'analysis' }).project).toBe(DEMO_OPENAI_PROJECT_ID);
  await expect(withDemoPaidOperation({ provider: 'elevenlabs', purpose: 'synthetic_seed_tts', model: 'stock-voice', upperBoundMicros: 10 },
    async () => { throw new Error('timeout'); })).rejects.toThrow('timeout');
  expect(reconcileDemoSpend).toHaveBeenLastCalledWith('attempt-1', null);
});

test('real SDK request shaping still traverses the guarded fetch and never retries a 503', async () => {
  const transport = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    id: 'synthetic-completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  }), { headers: { 'content-type': 'application/json' } }));
  try {
    const client = createDemoOpenAI({ purpose: 'analysis' });
    const response = await client.chat.completions.create({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'Ficticio' }] });
    expect(response.id).toBe('synthetic-completion');
    expect(reconcileDemoSpend).toHaveBeenLastCalledWith('attempt-1', 325);
    transport.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
      status: 503, headers: { 'content-type': 'application/json' },
    }));
    await expect(client.chat.completions.create({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'Ficticio' }] })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(reconcileDemoSpend).toHaveBeenLastCalledWith('attempt-1', null);
  } finally {
    transport.mockRestore();
  }
});

test('real SDK multipart transcription preserves bounded audio through the guarded transport', async () => {
  const transport = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ text: 'Ficticio' }), {
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const client = createDemoOpenAI({ purpose: 'transcription', audioDurationSeconds: 120 });
    await client.audio.transcriptions.create({ model: 'gpt-4o-transcribe-diarize', file: new File(['synthetic'], 'fictional.wav') });
    expect(reserveDemoSpend).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o-transcribe-diarize', upperBoundMicros: 200000 }));
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    transport.mockRestore();
  }
});
