import { openAsBlob } from 'fs';
import { stat } from 'fs/promises';
import { basename } from 'path';
import { SCRIBE_TRANSCRIPTION_MODEL, type TranscriptWord } from './transcriptionProvider';
import { DEMO_MAX_AUDIO_BYTES, DEMO_MAX_AUDIO_SECONDS, validateDemoAudioFile } from './demoBudget';
import { withDemoPaidOperation } from './demoPaidProviders';

export const SCRIBE_REQUEST_TIMEOUT_MS = 7 * 60 * 1000;
export const SCRIBE_MAX_AUDIO_BYTES = DEMO_MAX_AUDIO_BYTES;
export const SCRIBE_MAX_DURATION_SECONDS = DEMO_MAX_AUDIO_SECONDS;

export interface ScribeTranscript {
  task: string;
  duration: number;
  text: string;
  segments: Array<{ id: string; start: number; end: number; text: string; speaker: string }>;
  words: TranscriptWord[];
  usage: { type: string; seconds: number };
}

/** Make safe errors without retaining response bodies, credentials, or customer audio. */
function scribeError(message: string, code: string, status?: number): Error & { code: string; status?: number } {
  return Object.assign(new Error(message), { code, ...(status === undefined ? {} : { status }) });
}

/** Validate vendor JSON without coercing missing/null timestamps into invented evidence. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw scribeError('Invalid Scribe response object', 'invalid_scribe_response');
  }
  return value as Record<string, unknown>;
}

/** Preserve raw labels, overlaps and zero-width tokens; metrics independently gate timing evidence. */
export function normalizeScribeTranscript(response: unknown, duration: number): ScribeTranscript {
  const data = record(response);
  if (!Number.isFinite(duration) || duration < 0.1 || typeof data.text !== 'string' || !Array.isArray(data.words)) {
    throw scribeError('Scribe response lacks a valid text/word timeline', 'invalid_scribe_response');
  }
  const words: TranscriptWord[] = data.words.map(/** Validate each timestamped vendor token. */ (entry, index) => {
    const word = record(entry);
    const { text, type, start, end } = word;
    if (typeof text !== 'string' || (type !== 'word' && type !== 'spacing' && type !== 'audio_event') ||
        typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) ||
        start < 0 || end < start || end > duration ||
        (type === 'word' && !text.trim()) ||
        (word.speaker_id != null && typeof word.speaker_id !== 'string')) {
      throw scribeError(`Invalid Scribe timeline token at index ${index}`, 'invalid_scribe_response');
    }
    const speakerId = typeof word.speaker_id === 'string' && word.speaker_id ? word.speaker_id : null;
    return {
      id: `word_${index}`, text, type, start, end, speakerId, rawSpeakerId: speakerId,
      speakerRole: speakerId === 'agent' || speakerId === 'customer' ? speakerId : 'unknown',
    };
  });
  words.sort(/** Order by onset only, retaining cross-speaker overlap and stable equal-onset order. */ (a, b) => a.start - b.start);
  if (data.text.trim() && !words.some(/** Require timing for nonempty speech. */ (word) => word.type !== 'spacing')) {
    throw scribeError('Scribe returned text without a word timeline', 'invalid_scribe_response');
  }
  const segments: ScribeTranscript['segments'] = [];
  for (const word of words) {
    if (word.type === 'spacing') continue;
    const speaker = word.speakerId ?? 'unknown';
    const previous = segments[segments.length - 1];
    if (previous && previous.speaker === speaker && word.start - previous.end <= 1) {
      previous.text += ` ${word.text}`;
      previous.end = Math.max(previous.end, word.end);
    } else {
      segments.push({ id: `seg_${segments.length}`, start: word.start, end: word.end, text: word.text, speaker });
    }
  }
  return { task: 'transcribe', duration, text: data.text, segments, words, usage: { type: 'duration', seconds: Math.ceil(duration) } };
}

/** One bounded whole-recording request; only the existing delayed worker policy owns retries. */
export async function transcribeScribe(input: {
  audioPath: string;
  duration: number;
  apiKey: string | undefined;
  callId: string;
  processingGeneration: number;
  shouldContinue: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}): Promise<ScribeTranscript> {
  if (!input.apiKey?.trim()) throw scribeError('ELEVENLABS_API_KEY is not configured', 'missing_elevenlabs_api_key');
  if (!Number.isFinite(input.duration) || input.duration < 0.1 || input.duration > SCRIBE_MAX_DURATION_SECONDS) {
    throw scribeError('Recording exceeds the demo Scribe duration (0.1 seconds to 5 minutes)', 'scribe_audio_limit');
  }
  const metadata = await stat(input.audioPath);
  if (metadata.size === 0 || metadata.size > SCRIBE_MAX_AUDIO_BYTES) {
    throw scribeError('Recording exceeds the bounded Scribe upload size (25 MiB)', 'scribe_audio_limit');
  }
  const measuredDuration = await validateDemoAudioFile(input.audioPath);
  if (Math.abs(measuredDuration - input.duration) > 0.1) throw scribeError('Audio duration changed before provider dispatch', 'scribe_audio_limit');
  if (!(await input.shouldContinue())) throw scribeError('Transcription was canceled or superseded', 'stale_generation');
  const body = new FormData();
  body.set('file', await openAsBlob(input.audioPath), basename(input.audioPath));
  for (const [key, value] of Object.entries({
    model_id: SCRIBE_TRANSCRIPTION_MODEL, language_code: 'es', diarize: 'true', detect_speaker_roles: 'true',
    use_multi_channel: 'false', timestamps_granularity: 'word', tag_audio_events: 'true', no_verbatim: 'false',
  })) body.set(key, value);
  const controller = new AbortController();
  const timeout = setTimeout(/** Bound the request including upload and response body. */ () =>
    controller.abort(scribeError('Scribe request timed out', 'ETIMEDOUT')), SCRIBE_REQUEST_TIMEOUT_MS);
  let checking = false;
  const cancellation = setInterval(/** Poll generation while the long-running remote request is in flight. */ async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      if (!(await input.shouldContinue())) controller.abort(scribeError('Transcription was canceled or superseded', 'stale_generation'));
    } catch {
      controller.abort(scribeError('Connection error checking transcription generation', 'ECONNRESET'));
    } finally {
      checking = false;
    }
  }, 5000);
  try {
    // ElevenLabs batch STT receives the complete mixed-speaker recording; no OpenAI chunk seams.
    // $1/hour safely exceeds the reviewed public Scribe v2 rate; reserve every actual attempt.
    const upperBoundMicros = Math.ceil(measuredDuration / 3600 * 1_000_000);
    const data = await withDemoPaidOperation({
      provider: 'elevenlabs', purpose: 'transcription', model: SCRIBE_TRANSCRIPTION_MODEL, upperBoundMicros,
      callId: input.callId, processingGeneration: input.processingGeneration,
    }, async () => {
      if (!(await input.shouldContinue())) throw scribeError('Transcription was canceled or superseded', 'stale_generation');
      const response = await (input.fetchImpl ?? fetch)('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST', headers: { 'xi-api-key': input.apiKey! }, body, signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) {
        // A 429 is terminal for transcription, including both exhausted quota and throttling.
        const code = response.status === 429 ? 'insufficient_quota' : 'scribe_http_error';
        throw scribeError(`ElevenLabs transcription request failed (HTTP ${response.status})`, code, response.status);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof SyntaxError || (error as { name?: string })?.name === 'SyntaxError') {
          throw scribeError('Scribe returned invalid JSON', 'invalid_scribe_response');
        }
        throw error;
      }
      return payload;
    }, () => upperBoundMicros);
    if (!(await input.shouldContinue())) throw scribeError('Transcription was canceled or superseded', 'stale_generation');
    return normalizeScribeTranscript(data, input.duration);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof TypeError) throw scribeError('Connection error during Scribe transcription', 'ECONNRESET');
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(cancellation);
  }
}
