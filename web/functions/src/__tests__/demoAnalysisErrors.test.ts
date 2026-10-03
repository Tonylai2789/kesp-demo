import { serializeCallError } from '../analysisErrors';
import { shouldRetryRuntimeError } from '../runtimeRetry';

jest.mock('../callState', () => ({ buildClearCallErrorUpdate: jest.fn(), getProcessingGeneration: jest.fn() }));
jest.mock('../ffmpeg', () => ({ getAudioDuration: jest.fn() }));

test('SDK-wrapped demo guards remain local non-retryable failures', () => {
  const cause = Object.assign(new Error('Input exceeds the demo processing bound'), { code: 'demo_input_limit' });
  const wrapped = Object.assign(new Error('Connection error.'), { cause });
  const result = serializeCallError(wrapped, 'analysis_task');
  expect(result).toMatchObject({ message: cause.message, errorCode: 'demo_input_limit', retryable: false });
  expect(shouldRetryRuntimeError('analysis', result)).toBe(false);
});

test('real connection failures retain transport classification', () => {
  const result = serializeCallError(Object.assign(new Error('Connection error.'), {
    cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
  }), 'transcription');
  expect(result.message).toBe('Connection error.');
  expect(result.retryable).toBe(true);
});
