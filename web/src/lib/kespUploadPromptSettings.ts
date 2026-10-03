import type { AvailablePromptsResponse } from '@/services/functions';
import { validateAnalyzerModelOverrides } from './analyzerModelSettings';

export const KESP_UPLOAD_PROMPT_SETTINGS_KEY = 'kespUploadPromptSettings:v1';

export type KespUploadPromptSettingsV1 = {
  analyzerModel?: string;
  analyzerModelOverrides?: Record<string, string>;
  promptVersions?: Record<string, string>;
  reportPromptVersions?: Record<string, string>;
  activityPromptVersions?: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function loadKespUploadPromptSettings(): KespUploadPromptSettingsV1 {
  if (!canUseLocalStorage()) return {};

  try {
    const raw = window.localStorage.getItem(KESP_UPLOAD_PROMPT_SETTINGS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const analyzerModel =
      typeof parsed.analyzerModel === 'string' ? parsed.analyzerModel : undefined;

    const promptVersions = parseStringMap(parsed.promptVersions);
    const analyzerModelOverrides = parseStringMap(parsed.analyzerModelOverrides);
    const reportPromptVersions = parseStringMap(parsed.reportPromptVersions);
    const activityPromptVersions = parseStringMap(parsed.activityPromptVersions);

    const result: KespUploadPromptSettingsV1 = {};
    if (analyzerModel) result.analyzerModel = analyzerModel;
    if (Object.keys(analyzerModelOverrides).length > 0) result.analyzerModelOverrides = analyzerModelOverrides;
    if (Object.keys(promptVersions).length > 0) result.promptVersions = promptVersions;
    if (Object.keys(reportPromptVersions).length > 0) {
      result.reportPromptVersions = reportPromptVersions;
    }
    if (Object.keys(activityPromptVersions).length > 0) {
      result.activityPromptVersions = activityPromptVersions;
    }
    return result;
  } catch {
    return {};
  }
}

/** Reports storage failures so settings dialogs can preserve unsaved drafts. */
export function saveKespUploadPromptSettings(next: KespUploadPromptSettingsV1): boolean {
  try {
    if (!canUseLocalStorage()) return false;
    if (!hasStoredSettings(next)) {
      window.localStorage.removeItem(KESP_UPLOAD_PROMPT_SETTINGS_KEY);
      return true;
    }
    window.localStorage.setItem(KESP_UPLOAD_PROMPT_SETTINGS_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function clearKespUploadPromptSettings(): void {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.removeItem(KESP_UPLOAD_PROMPT_SETTINGS_KEY);
  } catch {
    // Ignore localStorage removal errors.
  }
}

export function validateKespUploadPromptSettings(
  saved: KespUploadPromptSettingsV1,
  availablePrompts: AvailablePromptsResponse
): KespUploadPromptSettingsV1 {
  const validated: KespUploadPromptSettingsV1 = {};
  const analyzerModelOverrides = validateAnalyzerModelOverrides(saved.analyzerModelOverrides, availablePrompts);
  if (Object.keys(analyzerModelOverrides).length > 0) validated.analyzerModelOverrides = analyzerModelOverrides;

  if (
    typeof saved.analyzerModel === 'string' &&
    availablePrompts.analyzerModels &&
    Array.isArray(availablePrompts.analyzerModels.available) &&
    availablePrompts.analyzerModels.available.includes(saved.analyzerModel)
  ) {
    // Presence records an explicit browser choice, including the catalog default.
    validated.analyzerModel = saved.analyzerModel;
  }

  if (saved.promptVersions && isRecord(saved.promptVersions)) {
    const promptVersions = validatePromptVersionMap(
      saved.promptVersions,
      availablePrompts.availableVersions,
      availablePrompts.defaults
    );
    if (Object.keys(promptVersions).length > 0) {
      validated.promptVersions = promptVersions;
    }
  }

  if (saved.reportPromptVersions && isRecord(saved.reportPromptVersions)) {
    const reportPromptVersions = validatePromptVersionMap(
      saved.reportPromptVersions,
      availablePrompts.agentAnalysisVersions,
      availablePrompts.agentAnalysisDefaults
    );
    if (Object.keys(reportPromptVersions).length > 0) {
      validated.reportPromptVersions = reportPromptVersions;
    }
  }

  if (saved.activityPromptVersions && isRecord(saved.activityPromptVersions)) {
    const activityPromptVersions = validatePromptVersionMap(
      saved.activityPromptVersions,
      availablePrompts.activityVersions,
      availablePrompts.activityDefaults
    );
    if (Object.keys(activityPromptVersions).length > 0) {
      validated.activityPromptVersions = activityPromptVersions;
    }
  }

  return validated;
}

function parseStringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(value)) return result;

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.length > 0) {
      result[key] = item;
    }
  }
  return result;
}

function hasStoredSettings(settings: KespUploadPromptSettingsV1): boolean {
  return Boolean(
    settings.analyzerModel ||
      (settings.analyzerModelOverrides && Object.keys(settings.analyzerModelOverrides).length > 0) ||
      (settings.promptVersions && Object.keys(settings.promptVersions).length > 0) ||
      (settings.reportPromptVersions &&
        Object.keys(settings.reportPromptVersions).length > 0) ||
      (settings.activityPromptVersions &&
        Object.keys(settings.activityPromptVersions).length > 0)
  );
}

function validatePromptVersionMap(
  savedVersions: Record<string, string>,
  availableVersions: Record<string, string[]> | undefined,
  defaults: Record<string, string> | undefined
): Record<string, string> {
  const validated: Record<string, string> = {};

  for (const [taskId, version] of Object.entries(savedVersions)) {
    const allowedVersions = availableVersions?.[taskId];
    const backendDefault = defaults?.[taskId];
    if (!Array.isArray(allowedVersions) || typeof backendDefault !== 'string') continue;
    if (typeof version !== 'string') continue;
    if (!allowedVersions.includes(version)) continue;
    if (version === backendDefault) continue;
    validated[taskId] = version;
  }

  return validated;
}
