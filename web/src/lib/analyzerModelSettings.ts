import type { AvailablePromptsResponse } from '@/services/functions';

export const ANALYZER_TASK_IDS = [
  'core_fields', 'coaching',
  'rubric_analysis_A', 'rubric_analysis_B', 'rubric_analysis_C', 'rubric_analysis_D',
  'severity_analysis_A', 'severity_analysis_B', 'severity_analysis_C', 'severity_analysis_D',
] as const;

export type AnalyzerModelSettings = {
  analyzerModel: string;
  analyzerModelOverrides: Record<string, string>;
};

/** Accepts only call-analysis tasks and models advertised by the backend catalog. */
export function validateAnalyzerModelOverrides(
  value: unknown,
  catalog: AvailablePromptsResponse
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const map = value as Record<string, unknown>;
  for (const taskId of ANALYZER_TASK_IDS) {
    const model = map[taskId];
    if (typeof model === 'string' && catalog.analyzerModels?.available.includes(model)) {
      result[taskId] = model;
    }
  }
  return result;
}

/** Builds an editable copy without deriving backend-owned effective models. */
export function analyzerModelSettings(
  saved: { analyzerModel?: string | null; analyzerModelOverrides?: Record<string, string> },
  catalog: AvailablePromptsResponse
): AnalyzerModelSettings {
  return {
    analyzerModel: saved.analyzerModel && catalog.analyzerModels?.available.includes(saved.analyzerModel)
      ? saved.analyzerModel : catalog.analyzerModels?.default || 'gpt-5.4',
    analyzerModelOverrides: validateAnalyzerModelOverrides(saved.analyzerModelOverrides, catalog),
  };
}
