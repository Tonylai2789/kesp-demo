import type { ChatCompletion } from 'openai/resources/chat/completions';

/** Safe diagnostics only: never persist a raw response, prompt, or refusal text. */
export function patternCompletionMetadata(response: ChatCompletion) {
  const tokenCount = (value: unknown): number | null =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
  return {
    finishReason: response.choices[0]?.finish_reason ?? null,
    promptTokens: tokenCount(response.usage?.prompt_tokens),
    completionTokens: tokenCount(response.usage?.completion_tokens),
    reasoningTokens: tokenCount(response.usage?.completion_tokens_details?.reasoning_tokens),
  };
}

export function parsePatternCompletion(
  response: ChatCompletion,
  arrayKey: 'candidatePatterns' | 'patterns'
): Record<string, unknown> {
  const fail = (code: string, message: string): never => {
    throw Object.assign(new Error(message), { code });
  };
  const choice = response.choices[0];
  if (choice?.finish_reason === 'length') {
    fail('pattern_output_truncated', 'Pattern report output reached its token limit; incomplete JSON was not saved.');
  }
  if (choice?.message.refusal || choice?.finish_reason === 'content_filter') {
    fail('pattern_output_refused', 'Pattern report output was declined by the provider.');
  }
  if (choice?.finish_reason !== 'stop' || !choice.message.content?.trim()) {
    fail('pattern_output_incomplete', 'Pattern report provider did not return a completed text response.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(choice.message.content!);
  } catch {
    fail('pattern_output_invalid_json', 'Pattern report provider returned invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !Array.isArray((parsed as Record<string, unknown>)[arrayKey])) {
    fail('pattern_output_invalid_shape', `Pattern report output is missing the ${arrayKey} array.`);
  }
  const patterns = (parsed as Record<string, unknown>)[arrayKey] as unknown[];
  if (patterns.some(pattern => {
    if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) return true;
    const item = pattern as Record<string, unknown>;
    return !['patternId', 'patternName'].every(key => typeof item[key] === 'string' && item[key].trim().length > 0);
  })) {
    fail('pattern_output_invalid_shape', 'Pattern report output contains an invalid pattern entry.');
  }
  return parsed as Record<string, unknown>;
}
