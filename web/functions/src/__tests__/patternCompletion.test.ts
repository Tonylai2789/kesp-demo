import type { ChatCompletion } from 'openai/resources/chat/completions';
import { parsePatternCompletion, patternCompletionMetadata } from '../patternCompletion';

const response = (content: string | null, finishReason = 'stop', refusal: string | null = null): ChatCompletion => ({
  choices: [{ finish_reason: finishReason, message: { content, refusal } }],
  usage: { prompt_tokens: 100, completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 0 } },
} as ChatCompletion);

test.each(['candidatePatterns', 'patterns'] as const)('accepts completed %s, including legitimate empty results', key => {
  expect(parsePatternCompletion(response(JSON.stringify({ [key]: [] })), key)).toEqual({ [key]: [] });
  const value = { [key]: [{ patternId: 'p1', patternName: 'Revisar seguimiento', supportingEvidence: [{ quote: 'Hola' }] }] };
  expect(parsePatternCompletion(response(JSON.stringify(value)), key)).toEqual(value);
});

test.each(['candidatePatterns', 'patterns'] as const)('rejects malformed %s entries instead of normalizing them away', key => {
  for (const pattern of [null, 42, {}, [], { patternId: 'p1' }, { patternId: '', patternName: 'Valid name' },
    { patternId: 'p1', patternName: 42 }]) {
    expect(() => parsePatternCompletion(response(JSON.stringify({ [key]: [pattern] })), key)).toThrow(
      expect.objectContaining({ code: 'pattern_output_invalid_shape' }));
  }
});

test.each(['{"patterns": [', '{"patterns": []}'])('rejects length-limited output even when syntactically valid', text => {
  expect(() => parsePatternCompletion(response(text, 'length'), 'patterns')).toThrow(
    expect.objectContaining({ code: 'pattern_output_truncated' }));
});

test.each([
  [response('{"patterns":['), 'pattern_output_invalid_json'],
  [response('null'), 'pattern_output_invalid_shape'],
  [response('{}'), 'pattern_output_invalid_shape'],
  [response('{"patterns":{}}'), 'pattern_output_invalid_shape'],
  [response('[]'), 'pattern_output_invalid_shape'],
  [response(null), 'pattern_output_incomplete'],
  [response(' '), 'pattern_output_incomplete'],
  [response('{}', 'tool_calls'), 'pattern_output_incomplete'],
  [response(null, 'content_filter'), 'pattern_output_refused'],
  [response(null, 'stop', 'private refusal details'), 'pattern_output_refused'],
  [{ choices: [] } as unknown as ChatCompletion, 'pattern_output_incomplete'],
])('classifies malformed or refused completions without inventing an empty report', (value, code) => {
  expect(() => parsePatternCompletion(value as ChatCompletion, 'patterns')).toThrow(expect.objectContaining({ code }));
});

test('diagnostics contain only finish reason and safe token counters', () => {
  expect(patternCompletionMetadata(response('private response body', 'length'))).toEqual({
    finishReason: 'length', promptTokens: 100, completionTokens: 8192, reasoningTokens: 0,
  });
  expect(patternCompletionMetadata({ choices: [] } as unknown as ChatCompletion)).toEqual({
    finishReason: null, promptTokens: null, completionTokens: null, reasoningTokens: null,
  });
});
