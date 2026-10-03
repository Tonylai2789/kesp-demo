import OpenAI from 'openai';
import {
  assertDemoRuntime, demoGuardError, reserveDemoSpend, reconcileDemoSpend,
  DEMO_MAX_AUDIO_BYTES, DEMO_MAX_AUDIO_SECONDS, type DemoSpendRequest,
} from './demoBudget';

export const DEMO_MAX_COMPLETION_TOKENS = 8192;
// Scribe word timings accompany the transcript. Keep a bounded request below
// GPT-5.4's long-context pricing threshold even with byte-level token estimates.
export const DEMO_MAX_INPUT_BYTES = 256_000;
export const DEMO_OPENAI_PROJECT_ID = 'proj_7TSXeMAIXdK8E6mSZdfMh3w7';

// USD per million tokens is numerically equal to micro-USD per token.
// Reviewed 2026-10-01: https://developers.openai.com/api/docs/pricing .
// Unreviewed model prices fail closed; never invent a tariff for a newer model.
export const DEMO_MODEL_RATES: Readonly<Record<string, { input: number; output: number }>> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-5.1': { input: 1.25, output: 10 },
  'gpt-5.4': { input: 2.5, output: 15 },
};

export interface DemoProviderContext {
  purpose: string;
  callId?: string;
  processingGeneration?: number;
  /** Obtained from validateDemoAudioFile, never from request.data. */
  audioDurationSeconds?: number;
}

interface JsonRecord { [key: string]: unknown }

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw demoGuardError('demo_provider_request', 'Expected a JSON object');
  }
  return value as JsonRecord;
}

export function boundedDemoCompletion(input: unknown): { body: JsonRecord; model: string; upperBoundMicros: number } {
  const body = { ...asRecord(input) };
  const model = String(body.model);
  const rates = Object.hasOwn(DEMO_MODEL_RATES, model) ? DEMO_MODEL_RATES[model] : undefined;
  if (!rates) throw demoGuardError('demo_model_unpriced', 'Model has no reviewed demo price bound');
  if (body.stream || (body.n !== undefined && body.n !== 1) || body.audio || body.modalities ||
      body.prediction || body.web_search_options || body.service_tier && body.service_tier !== 'default') {
    throw demoGuardError('demo_provider_request', 'Only single non-streaming text completions are enabled');
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100) {
    throw demoGuardError('demo_provider_request', 'Invalid bounded text messages');
  }
  for (const value of body.messages) {
    const message = asRecord(value);
    const content = message.content;
    if (content !== null && typeof content !== 'string' &&
        !(Array.isArray(content) && content.every((part) => {
          const item = asRecord(part);
          return item.type === 'text' && typeof item.text === 'string';
        }))) {
      throw demoGuardError('demo_provider_request', 'Multimodal paid input is not enabled');
    }
  }
  const requested = body.max_completion_tokens ?? body.max_tokens ?? DEMO_MAX_COMPLETION_TOKENS;
  if (!Number.isSafeInteger(requested) || Number(requested) <= 0) {
    throw demoGuardError('demo_provider_request', 'Invalid completion token bound');
  }
  delete body.max_tokens;
  body.max_completion_tokens = Math.min(Number(requested), DEMO_MAX_COMPLETION_TOKENS);
  body.service_tier = 'default';
  body.store = false;
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (bytes > DEMO_MAX_INPUT_BYTES) throw demoGuardError('demo_input_limit', 'Input exceeds the demo processing bound');
  // A byte-level upper bound plus generous per-message framing avoids optimistic char/4 estimates.
  const inputTokensBound = bytes + body.messages.length * 128 + 1024;
  if (['gpt-4o', 'gpt-4o-mini'].includes(model) && inputTokensBound + Number(body.max_completion_tokens) > 128_000) {
    throw demoGuardError('demo_context_limit', 'Request exceeds the selected model demo context bound');
  }
  return { body, model, upperBoundMicros: Math.ceil(inputTokensBound * rates.input + Number(body.max_completion_tokens) * rates.output) };
}

export function completionUsageMicros(model: string, usage: unknown): number | null {
  const rates = Object.hasOwn(DEMO_MODEL_RATES, model) ? DEMO_MODEL_RATES[model] : undefined;
  if (!rates || !usage || typeof usage !== 'object') return null;
  const data = usage as JsonRecord;
  if (!Number.isSafeInteger(data.prompt_tokens) || Number(data.prompt_tokens) < 0 ||
      !Number.isSafeInteger(data.completion_tokens) || Number(data.completion_tokens) < 0) return null;
  // No cache discounts are assumed; completion_tokens includes billable reasoning tokens.
  return Math.ceil(Number(data.prompt_tokens) * rates.input + Number(data.completion_tokens) * rates.output);
}

/** Also used by local seed TTS: call only with backend-computed price bounds, never browser amounts. */
export async function withDemoPaidOperation<T>(
  spend: DemoSpendRequest,
  operation: () => Promise<T>,
  meteredCost: (result: T) => number | null = () => null
): Promise<T> {
  const reservation = await reserveDemoSpend(spend);
  try {
    const result = await operation();
    await reconcileDemoSpend(reservation, meteredCost(result));
    return result;
  } catch (error) {
    // Timeout, malformed response and cancellation can all occur after the provider charged.
    await reconcileDemoSpend(reservation, null);
    throw error;
  }
}

/** Exported separately so tests can inject an HTTP transport without ever making paid requests. */
export function createDemoOpenAIFetch(context: DemoProviderContext, transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    assertDemoRuntime();
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== 'https://api.openai.com' || url.search || request.method !== 'POST') {
      throw demoGuardError('demo_provider_endpoint', 'Unexpected OpenAI endpoint');
    }
    let model: string;
    let upperBoundMicros: number;
    let body: BodyInit;
    const headers = new Headers(request.headers);
    headers.set('OpenAI-Project', DEMO_OPENAI_PROJECT_ID);
    headers.delete('OpenAI-Organization');
    let cost: (response: Response) => Promise<number | null>;
    if (url.pathname === '/v1/chat/completions') {
      const prepared = boundedDemoCompletion(await request.json());
      ({ model, upperBoundMicros } = prepared);
      body = JSON.stringify(prepared.body);
      cost = async (response) => {
        if (!response.ok) return null;
        try { return completionUsageMicros(model, (await response.clone().json()).usage); } catch { return null; }
      };
    } else if (url.pathname === '/v1/audio/transcriptions') {
      const form = await request.formData();
      const file = form.get('file');
      model = String(form.get('model'));
      const duration = context.audioDurationSeconds;
      if (model !== 'gpt-4o-transcribe-diarize' || !file || typeof file === 'string' ||
          file.size <= 0 || file.size > DEMO_MAX_AUDIO_BYTES || !duration ||
          !Number.isFinite(duration) || duration > DEMO_MAX_AUDIO_SECONDS ||
          form.get('stream') === 'true') {
        throw demoGuardError('demo_audio_limit', 'Transcription requires validated bounded audio');
      }
      // $0.10/minute is a conservative ceiling, not an invoice claim. Unknown billing retains it.
      upperBoundMicros = Math.ceil(duration / 60 * 100_000);
      body = form;
      headers.delete('content-type');
      cost = async () => null;
    } else if (url.pathname === '/v1/audio/speech') {
      const speech = asRecord(await request.json());
      model = String(speech.model);
      if (model !== 'tts-1' || typeof speech.input !== 'string' || !speech.input.length ||
          speech.input.length > 4096 || !['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(String(speech.voice))) {
        throw demoGuardError('demo_provider_request', 'Seed speech requires bounded stock-voice tts-1 input');
      }
      // Stock TTS-1 is $15/million characters; use UTF-8 bytes as a conservative character bound.
      upperBoundMicros = Buffer.byteLength(speech.input) * 15;
      body = JSON.stringify(speech);
      cost = async (response) => response.ok ? upperBoundMicros : null;
    } else {
      throw demoGuardError('demo_provider_endpoint', 'OpenAI endpoint is not enabled in the demo');
    }
    const reservation = await reserveDemoSpend({ provider: 'openai', purpose: context.purpose, model, upperBoundMicros,
      ...(context.callId ? { callId: context.callId } : {}),
      ...(context.processingGeneration !== undefined ? { processingGeneration: context.processingGeneration } : {}) });
    try {
      // Redirects must not bypass the endpoint allowlist or forward credentials to another host.
      const response = await transport(url.toString(), {
        method: 'POST', headers, body, signal: request.signal, redirect: 'error',
      });
      await reconcileDemoSpend(reservation, await cost(response));
      return response;
    } catch (error) {
      await reconcileDemoSpend(reservation, null);
      throw error;
    }
  };
}

/** Replace every retained new OpenAI(...) with this factory, including profile/report helpers. */
export function createDemoOpenAI(context: DemoProviderContext): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    organization: null,
    project: DEMO_OPENAI_PROJECT_ID,
    baseURL: 'https://api.openai.com/v1',
    maxRetries: 0,
    timeout: 420_000,
    fetch: createDemoOpenAIFetch(context),
  });
}
