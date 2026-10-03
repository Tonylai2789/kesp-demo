import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onPaidCall as onCall, type CallableRequest } from './demoHttps';
import { assertConsubancoAdmin, assertConsubancoSupervisorOrAdmin } from './cccAutomaticWorkflowMonitor';
import { buildConsubancoManualCallFields } from './callIdentity';
import { callOccurrenceCreatedAtFallbackFields } from './callOccurrence';
import { DEFAULT_ANALYZER_MODEL, getSubagent2Defaults, isSupportedAnalyzerModel, CALL_ACTIVITY_PROMPT_TASK_IDS, validateAnalyzerModelOverrides, type AnalyzerModelOverrides } from './promptConfig';
import { OPENAI_TRANSCRIPTION_MODEL, SCRIBE_TRANSCRIPTION_MODEL } from './transcriptionProvider';
import { assertDemoRuntime, assertDemoBucket, DEMO_PROJECT_ID, DEMO_STORAGE_BUCKET, DEMO_MAX_AUDIO_BYTES, validateDemoAudioFile, readDemoBudget, admitDemoReservation, DEMO_BUDGET_PATH } from './demoBudget';
import { cleanupTmpDir } from './ffmpeg';
import { DEMO_MODEL_RATES } from './demoPaidProviders';
import { bindDemoSeedPreparedUpload, resolveDemoSeedUpload } from './demoSeedAuthorization';
import { bindDemoReconstructionPreparedUpload, resolveDemoReconstructionUpload } from './demoReconstructionAuthorization';

export const PREPARED_UPLOAD_COLLECTION = 'manual_upload_requests';
/** Only deterministic input failures may be acknowledged by the storage trigger. */
export class PreparedUploadRejection extends Error {
  readonly code = 'demo_upload_rejected';
}

const PREPARED_UPLOAD_BUCKETS: Record<string, string> = {
  [DEMO_PROJECT_ID]: DEMO_STORAGE_BUCKET,
};
const MAX_BYTES = DEMO_MAX_AUDIO_BYTES;

/** Resolves the deployed project, never a client-provided environment. */
function projectId(): string {
  return admin.app().options.projectId || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '';
}

/** Rejects malformed optional identifiers before they reach routing or Firestore paths. */
function optionalString(value: unknown, field: string, max = 256): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[/\\]/.test(value) ||
      Array.from(value).some(/** Rejects control characters in identifiers without altering original names. */ (char) => char.charCodeAt(0) < 32)) {
    throw new HttpsError('invalid-argument', `Invalid ${field}`);
  }
  return value.trim();
}

/** Validates the immutable provider/file selection independently of client metadata. */
export function validatePreparedUploadInput(input: Record<string, unknown>): {
  originalFilename: string; sizeBytes: number; contentType: string; audioSha256: string;
  transcriptionModel: string; comparison: boolean; analyzerModel: string; analyzerModelOverrides: AnalyzerModelOverrides;
  agentRoutingMode: 'none' | 'general' | 'specific'; agentId?: string; agentName?: string; agentAnalysisId?: string; batchId?: string;
} {
  const clientFields = new Set(['originalFilename', 'sizeBytes', 'contentType', 'audioSha256', 'transcriptionModel',
    'comparison', 'analyzerModel', 'analyzerModelOverrides', 'agentRoutingMode', 'agentId', 'agentName',
    'agentAnalysisId', 'batchId', 'promptVersions', 'activityPromptVersions', 'manualReminderInput',
    'demoSeedManifestId', 'demoSeedEntryId', 'demoReconstructionManifestId', 'demoReconstructionEntryId']);
  if (Object.keys(input).some((key) => !clientFields.has(key))) {
    throw new HttpsError('invalid-argument', 'Unexpected upload fields; provenance and runtime metadata are server-owned');
  }
  const originalFilename = optionalString(input.originalFilename, 'originalFilename', 240);
  if (!originalFilename || originalFilename === '.' || originalFilename === '..' ||
      originalFilename !== input.originalFilename || !/\.(mp3|wav|ogg|m4a|aac|flac|webm|mp4)$/i.test(originalFilename)) {
    throw new HttpsError('invalid-argument', 'An original audio basename is required');
  }
  const sizeBytes = input.sizeBytes;
  const contentType = input.contentType;
  if (!Number.isInteger(sizeBytes) || (sizeBytes as number) <= 0 || (sizeBytes as number) > MAX_BYTES ||
      typeof contentType !== 'string' || !/^audio\/[a-zA-Z0-9.+-]+$/.test(contentType)) {
    throw new HttpsError('invalid-argument', 'Invalid audio size or content type');
  }
  if (typeof input.audioSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.audioSha256)) {
    throw new HttpsError('invalid-argument', 'A SHA-256 file hash is required');
  }
  const transcriptionModel = input.transcriptionModel ?? SCRIBE_TRANSCRIPTION_MODEL;
  if (![OPENAI_TRANSCRIPTION_MODEL, SCRIBE_TRANSCRIPTION_MODEL].includes(transcriptionModel as string)) {
    throw new HttpsError('invalid-argument', 'Unsupported transcription model');
  }
  if (input.comparison !== undefined && typeof input.comparison !== 'boolean') {
    throw new HttpsError('invalid-argument', 'Invalid comparison flag');
  }
  const analyzerModel = input.analyzerModel ?? DEFAULT_ANALYZER_MODEL;
  if (!isSupportedAnalyzerModel(analyzerModel)) throw new HttpsError('invalid-argument', 'Unsupported analyzer model');
  if (!Object.hasOwn(DEMO_MODEL_RATES, analyzerModel)) throw new HttpsError('invalid-argument', 'Unpriced demo analyzer model');
  let analyzerModelOverrides: AnalyzerModelOverrides;
  try {
    analyzerModelOverrides = validateAnalyzerModelOverrides(input.analyzerModelOverrides);
    if (Object.values(analyzerModelOverrides).some((model) => !Object.hasOwn(DEMO_MODEL_RATES, model))) throw new Error('Unpriced override');
  } catch {
    throw new HttpsError('invalid-argument', 'Unsupported analyzer model overrides');
  }
  const agentRoutingMode = input.agentRoutingMode ?? 'none';
  if (!['none', 'general', 'specific'].includes(agentRoutingMode as string)) throw new HttpsError('invalid-argument', 'Invalid routing mode');
  const agentId = optionalString(input.agentId, 'agentId');
  if ((agentRoutingMode === 'specific') !== !!agentId) throw new HttpsError('invalid-argument', 'Agent selection conflicts with routing mode');
  return { originalFilename, sizeBytes: sizeBytes as number, contentType, audioSha256: input.audioSha256,
    transcriptionModel: transcriptionModel as string, comparison: input.comparison === true, analyzerModel, analyzerModelOverrides,
    agentRoutingMode: agentRoutingMode as 'none' | 'general' | 'specific',
    ...(agentId ? { agentId } : {}),
    ...(input.agentName ? { agentName: optionalString(input.agentName, 'agentName') } : {}),
    ...(input.agentAnalysisId ? { agentAnalysisId: optionalString(input.agentAnalysisId, 'agentAnalysisId') } : {}),
    ...(input.batchId ? { batchId: optionalString(input.batchId, 'batchId') } : {}),
  };
}

/** Snapshots only known, bundled prompt versions; unknown keys never become paths. */
export function validatedPromptSnapshot(input: unknown, defaults: Record<string, string>, allowed: readonly string[]): Record<string, string> {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new HttpsError('invalid-argument', 'Invalid prompt versions');
  const result = { ...defaults };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!allowed.includes(key) || typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) ||
        !existsSync(join(__dirname, 'prompts', `promptsubagent2.0-subagent-${key}-v${value}.md`))) {
      throw new HttpsError('invalid-argument', `Unavailable prompt version: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

/** Resolves an exact organization-shared demo profile without bank mappings or client display names. */
export async function resolvePreparedUploadRouting(input: ReturnType<typeof validatePreparedUploadInput>, uid: string): Promise<Record<string, unknown>> {
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  if (input.agentRoutingMode === 'specific') {
    const profileId = input.agentAnalysisId || input.agentId!;
    const profile = (await admin.firestore().collection('agent_analyses').doc(profileId).get()).data();
    if (!profile || profile.organizationId !== 'consubanco' || profile.visibilityScope !== 'organization' ||
        profile.salesAgentId !== input.agentId || typeof profile.salesAgentName !== 'string' || !profile.salesAgentName.trim() ||
        profile.isActiveAgentProfile === false || profile.cccAgentMappingId || profile.cccAccountNumber || profile.cccUserId) {
      throw new HttpsError('failed-precondition', 'Selected demo agent profile is unavailable');
    }
    return { salesAgentId: profile.salesAgentId, salesAgentName: profile.salesAgentName,
      matchedAgentAnalysisId: profileId, matchedAgentProfileKey: profile.activeAgentProfileKey || profileId,
      agentRoutingMode: 'specific', agentRoutingStatus: 'matched', matchedBy: 'demo_selected_profile',
      agentRoutingReason: 'verified_demo_profile', matchedAgentConfidence: 1,
      matchedAgentName: profile.salesAgentName, matchedAt: FieldValue.serverTimestamp() };
  }
  return input.agentRoutingMode === 'general'
    ? { agentRoutingMode: 'general', agentRoutingStatus: 'pending', agentRoutingReason: 'awaiting_feedback_agent_name' }
    : { agentRoutingMode: 'none', agentRoutingStatus: 'no_agent', agentRoutingReason: 'manual_no_agent_selected' };
}

/** Authenticates and authorizes preparation before reserving any upload or model snapshot. */
export async function prepareConsubancoTranscriptionUploadHandler(request: CallableRequest): Promise<{callId: string; storagePath: string}> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const activeProjectId = projectId();
  assertDemoRuntime(process.env, activeProjectId);
  const preparedUploadBucket = PREPARED_UPLOAD_BUCKETS[activeProjectId];
  if (!preparedUploadBucket) throw new HttpsError('permission-denied', 'Transcription selection is unavailable for this project');
  const db = admin.firestore();
  // Check live Consubanco role rather than client role claims.
  await assertConsubancoSupervisorOrAdmin(request.auth.uid, db);
  admitDemoReservation(readDemoBudget((await db.doc(DEMO_BUDGET_PATH).get()).data()), 1);
  const raw = request.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpsError('invalid-argument', 'Upload metadata required');
  const input = validatePreparedUploadInput(raw);
  if (input.comparison) await assertConsubancoAdmin(request.auth.uid, db);
  const promptDefaults = getSubagent2Defaults();
  const promptOverrides = validatedPromptSnapshot(raw.promptVersions, promptDefaults, Object.keys(promptDefaults));
  const activityPromptOverrides = validatedPromptSnapshot(raw.activityPromptVersions, {}, CALL_ACTIVITY_PROMPT_TASK_IDS);
  const seed = await resolveDemoSeedUpload({ raw, ownerUid: request.auth.uid });
  const reconstruction = await resolveDemoReconstructionUpload({ raw, ownerUid: request.auth.uid });
  const routing = seed?.callFields ?? reconstruction?.callFields ?? await resolvePreparedUploadRouting(input, request.auth.uid);
  const callRef = db.collection('calls').doc();
  const storagePath = `prepared-uploads/${request.auth.uid}/${callRef.id}/${input.originalFilename}`;
  const callFields: Record<string, unknown> = {
    ...buildConsubancoManualCallFields(request.auth.uid), ...routing,
    visibilityScope: 'organization', organizationName: 'KESP Demo',
    transcriptionProvider: input.transcriptionModel === SCRIBE_TRANSCRIPTION_MODEL ? 'elevenlabs' : 'openai',
    transcriptionModel: input.transcriptionModel, transcriptionProviderSnapshotVersion: 1,
    transcriptionManualSelectionVersion: 1,
    transcriptionComparison: input.comparison,
    ...(input.comparison ? { agentProfileExcluded: true, agentProfileExclusionReason: 'transcription_comparison' } : {}),
    analyzerModel: input.analyzerModel, analyzerModelOverrides: input.analyzerModelOverrides, promptOverrides, activityPromptOverrides,
    ...(input.batchId ? { uploadBatchId: input.batchId } : {}),
  };
  if (raw.manualReminderInput !== undefined) {
    if (!raw.manualReminderInput || typeof raw.manualReminderInput !== 'object' || Array.isArray(raw.manualReminderInput) ||
        Buffer.byteLength(JSON.stringify(raw.manualReminderInput)) > 8000) throw new HttpsError('invalid-argument', 'Invalid reminder input');
    callFields.manualReminderInput = raw.manualReminderInput;
  }
  // Backend-only request binds one original filename and one immutable configuration to the owner.
  const requestRecord = {
    ownerUid: request.auth.uid, callId: callRef.id, storagePath, bucket: preparedUploadBucket,
    originalFilename: input.originalFilename, sizeBytes: input.sizeBytes, contentType: input.contentType,
    audioSha256: input.audioSha256, callFields, status: 'prepared', createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
  };
  if (seed) return bindDemoSeedPreparedUpload({ seed, requestRecord });
  if (reconstruction) return bindDemoReconstructionPreparedUpload({ reconstruction, requestRecord });
  await db.collection(PREPARED_UPLOAD_COLLECTION).doc(callRef.id).create(requestRecord);
  return { callId: callRef.id, storagePath };
}

export const prepareConsubancoTranscriptionUpload = onCall({ timeoutSeconds: 60 }, prepareConsubancoTranscriptionUploadHandler);

/** Validates the exact immutable object against its preparation record. */
export function validatePreparedObject(record: FirebaseFirestore.DocumentData, object: {name?: string; bucket: string; size?: number | string; contentType?: string}): void {
  assertDemoBucket(object.bucket);
  if (record.storagePath !== object.name || record.bucket !== object.bucket || Number(object.size) !== record.sizeBytes ||
      Number(object.size) <= 0 || Number(object.size) > DEMO_MAX_AUDIO_BYTES ||
      object.contentType !== record.contentType || !Object.values(PREPARED_UPLOAD_BUCKETS).includes(object.bucket)) {
    throw new PreparedUploadRejection('Prepared upload object does not match authorized metadata');
  }
}

/** Finalizes the owner-bound object once; provider metadata on the object is intentionally ignored. */
export async function finalizePreparedTranscriptionUpload(object: {name?: string; bucket: string; size?: number | string; contentType?: string; generation?: string | number; timeCreated?: string | Date}): Promise<void> {
  assertDemoRuntime(process.env, projectId());
  assertDemoBucket(object.bucket);
  if (!PREPARED_UPLOAD_BUCKETS[projectId()]) return;
  if (!object.name?.startsWith('prepared-uploads/')) throw new PreparedUploadRejection('Invalid prepared upload path');
  // Strip tokens even for malformed, expired, rejected or already-consumed uploads.
  // Never fall back to the latest generation or touch objects outside this prefix.
  if (!/^[1-9][0-9]*$/.test(String(object.generation)) || !Number.isSafeInteger(Number(object.generation))) {
    throw new PreparedUploadRejection('Missing immutable upload generation');
  }
  const file = admin.storage().bucket(object.bucket).file(object.name, { generation: String(object.generation) });
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: null } });
  const parts = object.name.split('/');
  if (parts.length !== 4 || parts.some((part) => !part)) throw new PreparedUploadRejection('Invalid prepared upload path');
  const [, uid, callId, filename] = parts;
  const db = admin.firestore();
  const requestRef = db.collection(PREPARED_UPLOAD_COLLECTION).doc(callId);
  // Read backend-owned authorization; object custom metadata is never used.
  const snapshot = await requestRef.get();
  const record = snapshot.data();
  if (!record || record.ownerUid !== uid || record.callId !== callId || record.originalFilename !== filename) throw new PreparedUploadRejection('Missing prepared upload authorization');
  validatePreparedObject(record, object);
  if (record.status === 'consumed') return;
  const createdAtMs = new Date(object.timeCreated ?? '').getTime();
  const expiresAtMs = typeof record.expiresAt?.toMillis === 'function' ? record.expiresAt.toMillis() : NaN;
  if (record.status !== 'prepared' || !Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) ||
      createdAtMs > expiresAtMs) throw new PreparedUploadRejection('Expired prepared upload');
  // Read the finalized generation only, preventing replacement races during hash verification.
  const hash = createHash('sha256');
  for await (const bytes of file.createReadStream()) hash.update(bytes);
  if (hash.digest('hex') !== record.audioSha256) {
    await requestRef.update({ status: 'rejected', rejectionReason: 'audio_hash_mismatch', updatedAt: FieldValue.serverTimestamp() });
    throw new PreparedUploadRejection('Prepared upload SHA-256 mismatch');
  }
  const probeDir = mkdtempSync(join(tmpdir(), 'demo-upload-probe-'));
  let demoAudioDurationSeconds: number;
  try {
    const localPath = join(probeDir, 'audio');
    // Download this exact finalized generation, never a later replacement.
    await file.download({ destination: localPath });
    try {
      demoAudioDurationSeconds = await validateDemoAudioFile(localPath);
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      // These are the existing validator/ffprobe's deterministic invalid-audio signals.
      // Filesystem, process startup and probe timeout failures remain retryable.
      if (failure?.code !== 'demo_audio_limit' && !failure?.message?.startsWith('ffprobe failed:') &&
          !failure?.message?.startsWith('Invalid duration from ffprobe:')) throw error;
      await requestRef.update({ status: 'rejected', rejectionReason: 'invalid_demo_audio', updatedAt: FieldValue.serverTimestamp() });
      throw new PreparedUploadRejection('Invalid demo audio');
    }
  } finally {
    cleanupTmpDir(probeDir);
  }
  const callRef = db.collection('calls').doc(callId);
  // One transaction consumes the reservation and creates one call even when events are redelivered.
  await db.runTransaction(/** Commits one call from a trusted prepared request. */ async (transaction) => {
    const current = await transaction.get(requestRef);
    const existing = await transaction.get(callRef);
    if (current.data()?.status === 'consumed') return;
    if (current.data()?.status !== 'prepared' || existing.exists) throw new PreparedUploadRejection('Prepared upload reservation conflict');
    transaction.create(callRef, {
      ...((record.callFields.demoSeed?.synthetic === true || record.callFields.demoReconstruction?.kind === 'sanitized_reconstruction') && record.callFields.callOccurredAt instanceof Timestamp
        ? {} : callOccurrenceCreatedAtFallbackFields()), ...record.callFields,
      category: 'unknown', status: 'uploaded', audioPath: object.name, audioStorageBucket: object.bucket,
      audioStorageGeneration: object.generation, audioContentHash: record.audioSha256,
      audioHashAlgorithm: 'sha256', audioHashSource: 'server_file_bytes',
      demoAudioValidated: true, demoAudioDurationSeconds,
      callDocumentId: callId, preparedUploadRequestId: callId,
      originalFilename: filename, displayName: filename, displayNameBase: filename, displayNameSuffix: 0,
      processingGeneration: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(requestRef, { status: 'consumed', objectGeneration: object.generation, consumedAt: FieldValue.serverTimestamp() });
  });
}
