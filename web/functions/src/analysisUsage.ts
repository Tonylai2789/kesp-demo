import type OpenAI from 'openai';

export type AnalysisTokenUsage = OpenAI.CompletionUsage & {
  prompt_tokens_details?: OpenAI.CompletionUsage['prompt_tokens_details'] & { cache_write_tokens?: number };
};

/** Totals billed tokens across the primary response and criterion-repair requests. */
export function totalAnalysisUsage(usages: AnalysisTokenUsage[]): AnalysisTokenUsage | undefined {
  if (!usages.length) return undefined;
  return usages.reduce<AnalysisTokenUsage>((total, usage) => ({
    prompt_tokens: total.prompt_tokens + usage.prompt_tokens,
    completion_tokens: total.completion_tokens + usage.completion_tokens,
    total_tokens: total.total_tokens + usage.total_tokens,
    prompt_tokens_details: {
      cached_tokens: (total.prompt_tokens_details?.cached_tokens ?? 0) + (usage.prompt_tokens_details?.cached_tokens ?? 0),
      cache_write_tokens: (total.prompt_tokens_details?.cache_write_tokens ?? 0) + (usage.prompt_tokens_details?.cache_write_tokens ?? 0),
    },
    completion_tokens_details: {
      reasoning_tokens: (total.completion_tokens_details?.reasoning_tokens ?? 0) + (usage.completion_tokens_details?.reasoning_tokens ?? 0),
    },
  }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
}
