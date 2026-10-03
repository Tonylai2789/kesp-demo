import { FieldValue } from 'firebase-admin/firestore';
import {
  DEFAULT_ANALYZER_MODEL,
  requireAnalyzerModel,
  validateAnalyzerModelOverrides,
  type AnalyzerModelOverrides,
  resolveAnalyzerModel,
  type AnalyzerModel,
} from './promptConfig';

export const CCC_PIPELINE_CONFIG_COLLECTION = 'ccc_pipeline_configs';
export const CCC_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe-diarize' as const;

export type CccPipelineConfigId = 'testing' | 'production';

export interface CccPipelineConfig {
  id: CccPipelineConfigId;
  analyzerModel: AnalyzerModel;
  analyzerModelOverrides?: AnalyzerModelOverrides;
  transcriptionModel: typeof CCC_TRANSCRIPTION_MODEL;
  promptOverrides: Record<string, string>;
  activityPromptOverrides: Record<string, string>;
  shortCallThresholdSeconds: number;
  updatedBy: string | null;
  updatedAt: FirebaseFirestore.Timestamp | FieldValue;
  createdAt?: FirebaseFirestore.Timestamp | FieldValue;
}

export interface CccPipelineConfigSnapshot {
  pipelineConfigId: CccPipelineConfigId;
  analyzerModel: AnalyzerModel;
  analyzerModelOverrides?: AnalyzerModelOverrides;
  transcriptionModel: typeof CCC_TRANSCRIPTION_MODEL;
  promptOverrides: Record<string, string>;
  activityPromptOverrides: Record<string, string>;
  shortCallThresholdSeconds: number;
  pipelineRunId?: string | null;
}

/** Documents the normalizePipelineConfigId behavior. */
export function normalizePipelineConfigId(value: unknown): CccPipelineConfigId {
  return value === 'production' || value === 'prod' ? 'production' : 'testing';
}

/** Documents the sanitizePromptOverrideMap behavior. */
export function sanitizePromptOverrideMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, rawVersion] of Object.entries(value as Record<string, unknown>)) {
    const taskId = key.trim();
    const version = typeof rawVersion === 'string' ? rawVersion.trim() : '';
    if (taskId && version) out[taskId] = version;
  }
  return out;
}

/** Documents the defaultCccPipelineConfig behavior. */
export function defaultCccPipelineConfig(id: CccPipelineConfigId, updatedBy: string | null = null): CccPipelineConfig {
  return {
    id,
    analyzerModel: DEFAULT_ANALYZER_MODEL,
    analyzerModelOverrides: {},
    transcriptionModel: CCC_TRANSCRIPTION_MODEL,
    promptOverrides: {},
    activityPromptOverrides: {},
    shortCallThresholdSeconds: 90,
    updatedBy,
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  };
}

/** Documents the configFromDoc behavior. */
function configFromDoc(id: CccPipelineConfigId, data: FirebaseFirestore.DocumentData | undefined): CccPipelineConfigSnapshot {
  return {
    pipelineConfigId: id,
    analyzerModel: resolveAnalyzerModel(data?.analyzerModel),
    analyzerModelOverrides: validateAnalyzerModelOverrides(data?.analyzerModelOverrides),
    transcriptionModel: CCC_TRANSCRIPTION_MODEL,
    promptOverrides: sanitizePromptOverrideMap(data?.promptOverrides),
    activityPromptOverrides: sanitizePromptOverrideMap(data?.activityPromptOverrides),
    shortCallThresholdSeconds: typeof data?.shortCallThresholdSeconds === 'number' && data.shortCallThresholdSeconds > 0
      ? data.shortCallThresholdSeconds
      : 90,
  };
}

/** Documents the readCccPipelineConfigSnapshot behavior. */
export async function readCccPipelineConfigSnapshot(
  db: FirebaseFirestore.Firestore,
  id: CccPipelineConfigId,
  pipelineRunId?: string | null
): Promise<CccPipelineConfigSnapshot> {
  const snapshot = await db.collection(CCC_PIPELINE_CONFIG_COLLECTION).doc(id).get();
  return {
    ...configFromDoc(id, snapshot.exists ? snapshot.data() : undefined),
    ...(pipelineRunId ? { pipelineRunId } : {}),
  };
}

/** Documents the pipelineConfigCallFields behavior. */
export function pipelineConfigCallFields(snapshot: CccPipelineConfigSnapshot): Record<string, unknown> {
  return {
    pipelineConfigId: snapshot.pipelineConfigId,
    ...(snapshot.pipelineRunId ? { pipelineRunId: snapshot.pipelineRunId } : {}),
    analyzerModel: snapshot.analyzerModel,
    analyzerModelOverrides: snapshot.analyzerModelOverrides ?? {},
    transcriptionModel: snapshot.transcriptionModel,
    promptOverrides: snapshot.promptOverrides,
    activityPromptOverrides: snapshot.activityPromptOverrides,
    pipelineConfigSnapshot: {
      pipelineConfigId: snapshot.pipelineConfigId,
      ...(snapshot.pipelineRunId ? { pipelineRunId: snapshot.pipelineRunId } : {}),
      analyzerModel: snapshot.analyzerModel,
      analyzerModelOverrides: snapshot.analyzerModelOverrides ?? {},
      transcriptionModel: snapshot.transcriptionModel,
      promptOverrides: snapshot.promptOverrides,
      activityPromptOverrides: snapshot.activityPromptOverrides,
      shortCallThresholdSeconds: snapshot.shortCallThresholdSeconds,
    },
  };
}

/** Documents the buildPipelineConfigUpdate behavior. */
export function buildPipelineConfigUpdate(input: Record<string, unknown>, id: CccPipelineConfigId, uid: string): Record<string, unknown> {
  return {
    id,
    ...(input.analyzerModel !== undefined ? { analyzerModel: requireAnalyzerModel(input.analyzerModel) } : {}),
    ...(input.analyzerModelOverrides !== undefined
      ? { analyzerModelOverrides: validateAnalyzerModelOverrides(input.analyzerModelOverrides) } : {}),
    ...('promptOverrides' in input || 'promptVersions' in input
      ? { promptOverrides: sanitizePromptOverrideMap(input.promptOverrides ?? input.promptVersions) } : {}),
    ...('activityPromptOverrides' in input
      ? { activityPromptOverrides: sanitizePromptOverrideMap(input.activityPromptOverrides) } : {}),
    ...('shortCallThresholdSeconds' in input ? {
      shortCallThresholdSeconds: typeof input.shortCallThresholdSeconds === 'number' && input.shortCallThresholdSeconds > 0
        ? input.shortCallThresholdSeconds : 90,
    } : {}),
    updatedBy: uid,
    updatedAt: FieldValue.serverTimestamp(),
  };
}
