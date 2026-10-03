import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import OpenAI, { toFile } from 'openai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  assertDemoRuntime, assertDemoBucket, DEMO_STORAGE_BUCKET, DEMO_MAX_AUDIO_BYTES,
  validateDemoAudioFile, acquireDemoCallSlot,
} from './demoBudget';
import { createDemoOpenAI } from './demoPaidProviders';
import {
  normalizeAudio,
  segmentAudio,
  downloadToTmp,
  cleanupTmpDir,
  verifyChunkSizes,
  CHUNK_THRESHOLD_SEC,
  SEGMENT_TIME_SEC,
  OVERLAP_SEC,
} from './ffmpeg';
import { serializeCallError } from './analysisErrors';
import {
  buildCallErrorUpdate,
  buildClearCallErrorUpdate,
  getProcessingGeneration,
} from './callState';
import { buildManualShortCallAnalysisFields } from './manualShortCallReview';
import { recordRuntimeFailureForDelayedRetry } from './runtimeRetry';
import { transcribeScribe } from './scribeTranscription';
import {
  assertTranscriptDocumentSize,
  buildTranscriptIdentity,
  buildTranscriptStoragePlan,
  transcriptWordPageId,
  resolveTranscriptionProvider,
  type ProviderSelection,
  type TranscriptWord,
} from './transcriptionProvider';
import {
  buildTranscriptionCacheKey,
  canonicalTranscriptContentHash,
  loadCanonicalTranscript,
  recordCanonicalTranscript,
} from './transcriptionCache';

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();
/** Calls Firebase Firestore to read or write persisted application data. */
const storage = admin.storage();

/** Documents the getCallAudioBucket behavior. */
function getCallAudioBucket(callData: FirebaseFirestore.DocumentData): ReturnType<typeof storage.bucket> {
  assertDemoRuntime(process.env, admin.app().options.projectId);
  const audioStorageBucket = typeof callData.audioStorageBucket === 'string' ? callData.audioStorageBucket.trim() : '';
  const sourceBucket = typeof callData.sourceBucket === 'string' ? callData.sourceBucket.trim() : '';
  if (sourceBucket) assertDemoBucket(sourceBucket);
  assertDemoBucket(audioStorageBucket || DEMO_STORAGE_BUCKET);
  return storage.bucket(DEMO_STORAGE_BUCKET);
}

// Feature flag to disable chunking if needed
const ENABLE_CHUNKING = true;

// Types for chunked transcription
interface ChunkTranscript {
  chunkIndex: number;
  duration: number;
  text: string;
  segments: Array<{
    start: number;
    end: number;
    text: string;
    speaker?: string;
  }>;
}

interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker: string;
}

interface TranscriptData {
  words?: TranscriptWord[];
  audioIdentity?: string;
  audioIdentityMethod?: 'sha256' | 'legacy_source_metadata_sha256';
  task: string;
  duration: number;
  text: string;
  segments: TranscriptSegment[];
  usage: {
    type: string;
    seconds: number;
  };
}

/** Documents the isCurrentProcessingGeneration behavior. */
async function isCurrentProcessingGeneration(
  callRef: FirebaseFirestore.DocumentReference,
  processingGeneration: number
): Promise<boolean> {
  const callDoc = await callRef.get();
  const callData = callDoc.data() ?? {};
  return callDoc.exists && callData.status !== 'canceled' && getProcessingGeneration(callData) === processingGeneration;
}

/** Identify the actual recording bytes, including when a storage path is reused. */
async function hashAudioFile(audioPath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(audioPath)) hash.update(chunk);
  return hash.digest('hex');
}

/** Read deployment identity without inspecting secrets or consulting provider rollout flags. */
function transcriptionProjectId(): string {
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || admin.app().options.projectId || '';
}

/** Publish transcript and analysis transition atomically against cancellation, generation, and duplicate delivery. */
export async function publishTranscript(
  callRef: FirebaseFirestore.DocumentReference,
  processingGeneration: number,
  transcript: TranscriptData,
  selection: ProviderSelection,
  mode: 'direct' | 'chunked',
  auditFields: Record<string, unknown> = {}
): Promise<boolean> {
  if (!transcript.audioIdentity) {
    throw Object.assign(new Error('Transcript is missing its recording identity'), { code: 'missing_audio_identity' });
  }
  const stored = {
    audioIdentityMethod: transcript.audioIdentityMethod ?? 'sha256',
    ...transcript,
    ...buildTranscriptIdentity(selection, processingGeneration, transcript.audioIdentity, transcript),
  };
  const plan = buildTranscriptStoragePlan(stored);
  for (const page of plan.pages) {
    // Write small identity-addressed pages first; the canonical manifest is published only after every page succeeds.
    const written = await db.runTransaction(/** Stop page writes after cancellation or supersession. */ async (txn) => {
      const callDoc = await txn.get(callRef);
      const data = callDoc.data() ?? {};
      if (!callDoc.exists || getProcessingGeneration(data) !== processingGeneration || data.status !== 'transcribing') return false;
      txn.set(callRef.collection('transcript').doc(transcriptWordPageId(stored.transcriptId, page.pageIndex)), page);
      return true;
    });
    if (!written) return false;
  }
  // Firestore retries the transaction if cancellation or a new generation changes the call.
  return db.runTransaction(/** Check current identity before publishing any transcript evidence. */ async (txn) => {
    const callDoc = await txn.get(callRef);
    const data = callDoc.data() ?? {};
    if (!callDoc.exists || getProcessingGeneration(data) !== processingGeneration ||
        (data.status !== 'transcribing' && data.status !== 'uploaded')) return false;
    const current = resolveTranscriptionProvider(data, transcriptionProjectId());
    if (current.transcriptionProvider !== selection.transcriptionProvider || current.transcriptionModel !== selection.transcriptionModel) return false;
    txn.set(callRef.collection('transcript').doc('data'), plan.transcript);
    txn.update(callRef, {
      status: 'analyzing', duration: transcript.duration,
      ...buildManualShortCallAnalysisFields(data, transcript.duration),
      transcriptionMode: mode,
      transcriptionProvider: selection.transcriptionProvider,
      transcriptionModel: selection.transcriptionModel,
      transcriptionAudioIdentity: stored.audioIdentity,
      transcriptionTranscriptId: stored.transcriptId,
      ...auditFields,
      transcriptionCompletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      ...buildClearCallErrorUpdate(),
    });
    return true;
  });
}

/** Apply progress/error updates only to the still-current generation. */
async function updateCurrentCall(
  callRef: FirebaseFirestore.DocumentReference,
  processingGeneration: number,
  update: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>
): Promise<boolean> {
  // Guard writes with the same call document that cancellation updates.
  return db.runTransaction(/** Avoid reviving canceled, completed, or superseded work. */ async (txn) => {
    const snapshot = await txn.get(callRef);
    const data = snapshot.data() ?? {};
    if (!snapshot.exists || getProcessingGeneration(data) !== processingGeneration ||
        (data.status !== 'uploaded' && data.status !== 'transcribing')) return false;
    txn.update(callRef, update);
    return true;
  });
}

/**
 * Transcribe a single chunk with retry logic for transient errors.
 */
async function transcribeChunkWithRetry(
  openai: OpenAI,
  chunkPath: string,
  chunkIndex: number,
  maxRetries: number = 1
): Promise<ChunkTranscript> {
  const delays = [5000, 15000, 30000]; // 5s, 15s, 30s backoff

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`Transcribing chunk ${chunkIndex} (attempt ${attempt + 1}/${maxRetries})`);

      const buffer = fs.readFileSync(chunkPath);
      const audioFile = await toFile(buffer, `chunk_${chunkIndex}.m4a`, { type: 'audio/mp4' });

      /** Calls the OpenAI API for model inference or transcription. */
      const transcription = (await openai.audio.transcriptions.create({
        model: 'gpt-4o-transcribe-diarize',
        file: audioFile,
        response_format: 'diarized_json' as any,
        chunking_strategy: 'auto',
      } as any)) as any;

      // Calculate duration: use OpenAI's value, or fall back to last segment's end time
      // (same logic as transcribeDirect — diarized_json may not include a duration field)
      const segments = transcription.segments || [];
      const lastSegment = segments[segments.length - 1];
      const calculatedDuration = lastSegment?.end || 0;
      const duration = transcription.duration || calculatedDuration;

      console.log(`Chunk ${chunkIndex} transcribed: ${duration}s`);

      return {
        chunkIndex,
        duration,
        text: transcription.text || '',
        segments,
      };
    } catch (error: any) {
      const isRetryable =
        error.status === 502 ||
        error.code === 'ECONNRESET' ||
        error.message?.includes('timed out') ||
        error.message?.includes('timeout');

      if (isRetryable && attempt < maxRetries - 1) {
        console.log(
          `Chunk ${chunkIndex} retry ${attempt + 1}/${maxRetries} after error: ${error.message}`
        );
        await new Promise(/** Handles the callback for this operation. */(r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Max retries exceeded for chunk ${chunkIndex}`);
}

/**
 * Merge multiple chunk transcripts into a single transcript.
 * Handles timestamp offsetting and overlap deduplication.
 */
function mergeTranscripts(
  chunks: ChunkTranscript[],
  segmentTimeSec: number = SEGMENT_TIME_SEC,
  overlapSec: number = OVERLAP_SEC
): TranscriptData {
  // Sort by chunk index to ensure correct order
  const sortedChunks = [...chunks].sort(/** Handles the callback for this operation. */(a, b) => a.chunkIndex - b.chunkIndex);

  const allSegments: TranscriptSegment[] = [];
  let totalDuration = 0;
  const textParts: string[] = [];

  for (let i = 0; i < sortedChunks.length; i++) {
    const chunk = sortedChunks[i];
    const timeOffset = i * segmentTimeSec;

    for (const seg of chunk.segments) {
      const adjustedStart = seg.start + timeOffset;
      const adjustedEnd = seg.end + timeOffset;

      // Skip duplicates in overlap zone (first overlapSec of each chunk except the first)
      if (i > 0 && adjustedStart < timeOffset + overlapSec) {
        const isDuplicate = allSegments.some(
          /** Handles the callback for this operation. */
          (existing) =>
            Math.abs(existing.start - adjustedStart) <= overlapSec &&
            existing.text.toLowerCase().trim() === seg.text.toLowerCase().trim()
        );
        if (isDuplicate) {
          continue;
        }
      }

      allSegments.push({
        id: `seg_${allSegments.length}`,
        start: adjustedStart,
        end: adjustedEnd,
        text: seg.text,
        speaker: seg.speaker || 'A',
      });
    }

    textParts.push(chunk.text);
    totalDuration = Math.max(totalDuration, timeOffset + chunk.duration);
  }

  return {
    task: 'transcribe',
    duration: totalDuration,
    text: textParts.join(' '),
    segments: allSegments,
    usage: { type: 'duration', seconds: Math.ceil(totalDuration) },
  };
}

// ---------------------------------------------------------------------------
// Distributed chunking pipeline
// ---------------------------------------------------------------------------

/** Zero-pad a chunk index to 3 digits (e.g., 0 → "000", 5 → "005") */
function padChunkIndex(index: number): string {
  return index.toString().padStart(3, '0');
}

/**
 * Prepare audio for chunked transcription and dispatch chunk documents.
 * Downloads, normalizes, segments, uploads chunks to Storage, then creates
 * Firestore chunk documents that trigger onChunkReady.
 */
async function prepareAndDispatchChunks(
  callId: string,
  processingGeneration: number
): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection('calls').doc(callId);
  const callDoc = await callRef.get();
  const callData = callDoc.data()!;
  const selection = resolveTranscriptionProvider(callData, transcriptionProjectId());
  if (selection.transcriptionProvider !== 'openai') {
    throw Object.assign(new Error('Scribe cannot use OpenAI chunk dispatch'), { code: 'invalid_transcription_provider' });
  }
  const audioPath = callData.audioPath;
  /** Calls Firebase Storage to read or write call media. */
  const sourceBucket = getCallAudioBucket(callData);
  /** Calls Firebase Storage to write normalized chunks into the app default bucket. */
  const chunkBucket = storage.bucket();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-chunks-'));
  const originalPath = path.join(tmpDir, 'original.wav');
  const normalizedPath = path.join(tmpDir, 'normalized.m4a');

  try {
    if (!(await isCurrentProcessingGeneration(callRef, processingGeneration))) {
      console.log(`[DISPATCH] Skipping chunk dispatch for ${callId}; processing was canceled or superseded`);
      return;
    }

    // 1. Download original audio
    console.log(`[DISPATCH] Downloading audio for chunking: ${audioPath}`);
    await downloadToTmp(sourceBucket, audioPath, originalPath);
    const audioIdentity = await hashAudioFile(originalPath);

    // 2. Normalize to consistent format
    await normalizeAudio(originalPath, normalizedPath);

    // 3. Segment into chunks
    const chunkPaths = await segmentAudio(normalizedPath, tmpDir, SEGMENT_TIME_SEC);

    if (!(await isCurrentProcessingGeneration(callRef, processingGeneration))) {
      console.log(`[DISPATCH] Skipping chunk upload for ${callId}; processing was canceled or superseded`);
      return;
    }

    // 4. Verify chunk sizes
    verifyChunkSizes(chunkPaths);

    console.log(`[DISPATCH] Uploading ${chunkPaths.length} chunks to Storage`);

    // 5. Upload ALL chunk files to Storage BEFORE creating any Firestore docs
    //    (prevents onChunkReady from firing before the file exists)
    const storagePaths: string[] = [];
    for (let i = 0; i < chunkPaths.length; i++) {
      const storagePath = `chunks/${callId}/generation_${processingGeneration}/chunk_${padChunkIndex(i)}.m4a`;
      const fileBuffer = fs.readFileSync(chunkPaths[i]);
      await chunkBucket.file(storagePath).save(fileBuffer, {
        contentType: 'audio/mp4',
      });
      storagePaths.push(storagePath);
      console.log(`[DISPATCH] Uploaded chunk ${i} → ${storagePath}`);
    }

    if (!(await isCurrentProcessingGeneration(callRef, processingGeneration))) {
      console.log(`[DISPATCH] Skipping chunk doc creation for ${callId}; processing was canceled or superseded`);
      return;
    }

    // 6. Update parent call with chunking metadata
    if (!(await updateCurrentCall(callRef, processingGeneration, {
      isChunked: true,
      transcriptionAudioIdentity: audioIdentity,
      ...selection,
      totalChunks: chunkPaths.length,
      completedChunks: 0,
      transcriptionMode: 'chunked',
      chunkingStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }))) return;

    // 7. Create chunk documents (triggers onChunkReady for each)
    for (let i = 0; i < chunkPaths.length; i++) {
      /** Calls an external SDK or API dependency. */
      const dispatched = await db.runTransaction(/** Do not recreate chunk jobs after cancellation. */ async (txn) => {
        const current = await txn.get(callRef);
        const data = current.data() ?? {};
        if (!current.exists || data.status !== 'transcribing' || getProcessingGeneration(data) !== processingGeneration) return false;
        txn.set(callRef.collection('chunks').doc(padChunkIndex(i)), {
          status: 'pending', chunkPath: storagePaths[i], chunkIndex: i, processingGeneration,
          ...selection, audioIdentity, createdAt: FieldValue.serverTimestamp(),
        });
        return true;
      });
      if (!dispatched) return;
      console.log(`[DISPATCH] Created chunk doc ${padChunkIndex(i)}`);
    }

    console.log(`[DISPATCH] Dispatched ${chunkPaths.length} chunks for ${callId}`);
  } finally {
    cleanupTmpDir(tmpDir);
  }
}

/**
 * Transcribe a single chunk. Called by the onChunkReady trigger.
 * Each chunk runs in its own Firebase Function instance with dedicated memory/timeout.
 * The last chunk to complete triggers the merge and finalization.
 */
export async function transcribeChunk(callId: string, chunkIndex: number): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection('calls').doc(callId);
  const chunkDocId = padChunkIndex(chunkIndex);
  /** Calls an external SDK or API dependency. */
  const chunkRef = callRef.collection('chunks').doc(chunkDocId);

  // Read chunk document
  const chunkDoc = await chunkRef.get();
  if (!chunkDoc.exists) {
    throw new Error(`Chunk doc ${chunkDocId} not found for call ${callId}`);
  }

  const chunkData = chunkDoc.data()!;
  const processingGeneration = getProcessingGeneration(chunkData);
  if ((chunkData.transcriptionProvider ?? 'openai') !== 'openai') {
    throw Object.assign(new Error('Scribe recordings cannot run in OpenAI chunk workers'), { code: 'invalid_transcription_provider' });
  }

  // Idempotency guard: skip if already processed (at-least-once delivery)
  if (chunkData.status !== 'pending') {
    console.log(`[CHUNK ${chunkIndex}] Skipping — status is '${chunkData.status}', not 'pending'`);
    return;
  }

  if (!(await isCurrentProcessingGeneration(callRef, processingGeneration))) {
    // Chunk IDs are reused across generations; an old worker must never mutate the new job.
    return;
  }

  const parent = await callRef.get();
  if (resolveTranscriptionProvider(parent.data() ?? {}, transcriptionProjectId()).transcriptionProvider !== 'openai') return;

  // Atomically claim the matching chunk; duplicate queue deliveries must not transcribe it twice.
  const claimed = await db.runTransaction(/** Guard the chunk claim with its current parent generation. */ async (txn) => {
    const call = await txn.get(callRef);
    const chunk = await txn.get(chunkRef);
    if (!call.exists || !chunk.exists || call.data()?.status !== 'transcribing' ||
        getProcessingGeneration(call.data()) !== processingGeneration ||
        getProcessingGeneration(chunk.data()) !== processingGeneration || chunk.data()?.status !== 'pending') return false;
    txn.update(chunkRef, { status: 'transcribing', updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
  if (!claimed) return;

  /** Calls Firebase Storage to read or write call media. */
  const bucket = getCallAudioBucket(parent.data() ?? {});
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-chunk-'));
  const localChunkPath = path.join(tmpDir, `chunk_${chunkIndex}.m4a`);

  try {
    // Download chunk from Storage
    console.log(`[CHUNK ${chunkIndex}] Downloading ${chunkData.chunkPath}`);
    await downloadToTmp(bucket, chunkData.chunkPath, localChunkPath);
    const audioDurationSeconds = await validateDemoAudioFile(localChunkPath);
    const openai = createDemoOpenAI({ purpose: 'transcription_chunk', callId, processingGeneration, audioDurationSeconds });

    // Transcribe with retry
    const result = await transcribeChunkWithRetry(openai, localChunkPath, chunkIndex);

    if (!(await isCurrentProcessingGeneration(callRef, processingGeneration))) {
      console.log(`[CHUNK ${chunkIndex}] Superseded after transcription; skipping chunk result write`);
      return;
    }

    assertTranscriptDocumentSize(result);
    // Publish each result and increment completion exactly once within the matching generation.
    const allDone = await db.runTransaction(/** Handles the callback for this operation. */ async (txn) => {
      const callDoc = await txn.get(callRef);
      const currentChunk = await txn.get(chunkRef);
      const data = callDoc.data() ?? {};
      if (!callDoc.exists || !currentChunk.exists || data.status !== 'transcribing' ||
          getProcessingGeneration(data) !== processingGeneration ||
          getProcessingGeneration(currentChunk.data()) !== processingGeneration || currentChunk.data()?.status !== 'transcribing') {
        return false;
      }
      txn.update(chunkRef, {
        status: 'complete', text: result.text, segments: result.segments, duration: result.duration,
        completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      const newCompleted = (data.completedChunks || 0) + 1;
      /** Calls an external SDK or API dependency. */
      txn.update(callRef, {
        completedChunks: newCompleted,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return newCompleted === data.totalChunks;
    });

    if (allDone) {
      console.log(`[CHUNK ${chunkIndex}] Last chunk — starting merge for ${callId}`);
      await mergeAndFinalizeChunks(callId, processingGeneration);
    }
  } catch (error: any) {
    console.error(`[CHUNK ${chunkIndex}] Error:`, error);
    const serializedError = serializeCallError(error, 'transcription');

    if (!(await isCurrentProcessingGeneration(callRef, processingGeneration))) {
      console.log(`[CHUNK ${chunkIndex}] Error after cancellation/supersession; preserving canceled state`);
      return;
    }

    // Mark only the original chunk generation; another worker may already have replaced this ID.
    await db.runTransaction(/** Keep stale errors out of newer chunk documents. */ async (txn) => {
      const parent = await txn.get(callRef);
      const chunk = await txn.get(chunkRef);
      if (!parent.exists || !chunk.exists || parent.data()?.status !== 'transcribing' ||
          getProcessingGeneration(parent.data()) !== processingGeneration || getProcessingGeneration(chunk.data()) !== processingGeneration) return;
      txn.update(chunkRef, { status: 'error', updatedAt: FieldValue.serverTimestamp(), ...buildCallErrorUpdate(serializedError) });
    });

    // Mark parent call as error and let the bounded runtime retry helper decide whether to requeue it.
    if (await isCurrentProcessingGeneration(callRef, processingGeneration)) {
      const parentError = serializeCallError(
        {
          message: `Chunk ${chunkIndex} failed: ${serializedError.message}`,
          code: serializedError.errorCode,
          type: serializedError.errorType,
          status: serializedError.errorStatus,
          requestID: serializedError.errorRequestId,
        },
        'transcription'
      );
      /** Calls an external SDK or API dependency. */
      const recorded = await updateCurrentCall(callRef, processingGeneration, {
        status: 'error',
        updatedAt: FieldValue.serverTimestamp(),
        ...buildCallErrorUpdate(parentError),
      });
      if (recorded && await isCurrentProcessingGeneration(callRef, processingGeneration)) {
        await recordRuntimeFailureForDelayedRetry({ callRef, stage: 'transcription', error: parentError });
      }
    }

    throw error;
  } finally {
    cleanupTmpDir(tmpDir);
  }
}

/**
 * Merge all completed chunk transcripts and finalize the call.
 * Called by the last chunk's transcribeChunk when completedChunks === totalChunks.
 */
async function mergeAndFinalizeChunks(
  callId: string,
  processingGeneration: number
): Promise<void> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection('calls').doc(callId);

  if (!(await isCurrentProcessingGeneration(callRef, processingGeneration))) {
    console.log(`[MERGE] Skipping ${callId} because a newer processing generation is active`);
    return;
  }

  // Read all chunk documents ordered by chunkIndex
  const chunksSnapshot = await callRef.collection('chunks')
    .orderBy('chunkIndex', 'asc')
    .get();

  const currentChunkDocs = chunksSnapshot.docs.filter(/** Exclude leftovers when a reprocess creates fewer chunks. */ (doc) =>
    getProcessingGeneration(doc.data()) === processingGeneration);
  const chunks: ChunkTranscript[] = currentChunkDocs.map(/** Handles the callback for this operation. */(doc) => {
    const data = doc.data();
    return {
      chunkIndex: data.chunkIndex,
      duration: data.duration || 0,
      text: data.text || '',
      segments: data.segments || [],
    };
  });

  console.log(`[MERGE] Merging ${chunks.length} chunks for ${callId}`);

  // Merge using existing proven logic
  const merged = mergeTranscripts(chunks, SEGMENT_TIME_SEC, OVERLAP_SEC);

  console.log(`[MERGE] Complete — ${merged.duration}s total, ${merged.segments.length} segments`);

  const callDoc = await callRef.get();
  const callData = callDoc.data() ?? {};
  const selection = resolveTranscriptionProvider(callData, transcriptionProjectId());
  if (selection.transcriptionProvider !== 'openai') return;
  if (!currentChunkDocs.length ||
      (typeof callData.totalChunks === 'number' && currentChunkDocs.length !== callData.totalChunks) ||
      currentChunkDocs.some(/** Reject incomplete or non-OpenAI chunks before merging. */ (doc) =>
        doc.data().status !== 'complete' || (doc.data().transcriptionProvider ?? 'openai') !== 'openai')) return;
  // Legacy in-flight chunks lack a byte hash; their source identity still includes storage generation.
  merged.audioIdentity = callData.transcriptionAudioIdentity ?? createHash('sha256').update(JSON.stringify({
    bucket: getCallAudioBucket(callData).name, path: callData.audioPath,
    generation: callData.sourceObjectGeneration ?? null,
  })).digest('hex');
  merged.audioIdentityMethod = callData.transcriptionAudioIdentity ? 'sha256' : 'legacy_source_metadata_sha256';
  if (!(await publishTranscript(callRef, processingGeneration, merged, selection, 'chunked'))) return;

  // Cleanup chunk files from Storage (non-blocking, best-effort)
  try {
    /** Calls Firebase Storage to read or write call media. */
    const bucket = storage.bucket();
    for (const doc of currentChunkDocs) {
      const chunkPath = doc.data().chunkPath;
      if (chunkPath) {
        await bucket.file(chunkPath).delete().catch(/** Handles the callback for this operation. */() => { });
      }
    }
    console.log(`[MERGE] Cleaned up ${currentChunkDocs.length} chunk files from Storage`);
  } catch (cleanupError) {
    console.warn(`[MERGE] Chunk file cleanup failed (non-fatal):`, cleanupError);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Transcribes using the call's backend-owned provider snapshot (legacy calls remain OpenAI).
 * Called by Firestore triggers when a new call is created or reprocessed.
 *
 * OpenAI files > 10 minutes dispatch chunks; Scribe keeps the whole recording together.
 */
export async function performTranscription(callId: string): Promise<{ success: boolean; callId: string }> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection('calls').doc(callId);
  const callDoc = await callRef.get();

  if (!callDoc.exists) {
    throw new Error('Call not found');
  }

  const callData = callDoc.data()!;
  const audioPath = callData.audioPath;
  const processingGeneration = getProcessingGeneration(callData);

  if (!audioPath) {
    throw new Error('No audio path specified');
  }
  assertDemoRuntime(process.env, admin.app().options.projectId);
  await acquireDemoCallSlot(callId, processingGeneration);
  try {
    const bucket = getCallAudioBucket(callData);
    const [sourceMetadata] = await bucket.file(audioPath).getMetadata();
    if (Number(sourceMetadata.size) <= 0 || Number(sourceMetadata.size) > DEMO_MAX_AUDIO_BYTES ||
        String(sourceMetadata.generation) !== String(callData.audioStorageGeneration)) {
      throw Object.assign(new Error('Demo audio object is oversized or replaced'), { code: 'demo_audio_limit' });
    }
    const selection = resolveTranscriptionProvider(callData, transcriptionProjectId());
    // Update status to transcribing
    if (!(await updateCurrentCall(callRef, processingGeneration, {
      status: 'transcribing',
      ...selection,
      transcriptionStartedAt: FieldValue.serverTimestamp(),
      processingGeneration,
      updatedAt: FieldValue.serverTimestamp(),
      ...buildClearCallErrorUpdate(),
    }))) return { success: true, callId };

    if (selection.transcriptionProvider === 'elevenlabs') {
      // Reject missing configuration before downloading customer audio; never fall back to OpenAI.
      if (!process.env.ELEVENLABS_API_KEY?.trim()) {
        throw Object.assign(new Error('ELEVENLABS_API_KEY is not configured'), { code: 'missing_elevenlabs_api_key' });
      }
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-'));
      const localAudioPath = path.join(tmpDir, path.basename(audioPath));
      try {
        await downloadToTmp(getCallAudioBucket(callData), audioPath, localAudioPath);
        const duration = await validateDemoAudioFile(localAudioPath);
        const audioIdentity = await hashAudioFile(localAudioPath);
        if (audioIdentity !== callData.audioContentHash) throw new Error('Demo audio bytes changed');
        const cacheKey = buildTranscriptionCacheKey(audioIdentity, selection);
        const cached = await loadCanonicalTranscript({ firestore: db, audioIdentity, selection });
        if (cached) {
          const cachedTranscript: TranscriptData = {
            task: typeof cached.transcript.task === 'string' ? cached.transcript.task : 'transcribe',
            duration: cached.transcript.duration!, text: cached.transcript.text!,
            segments: cached.transcript.segments!, words: cached.transcript.words,
            usage: cached.transcript.usage ?? { type: 'duration', seconds: Math.ceil(cached.transcript.duration!) },
            audioIdentity,
          };
          await publishTranscript(callRef, processingGeneration, cachedTranscript, selection, 'direct', {
            transcriptionCacheHit: true, transcriptionCacheKey: cached.cacheKey,
            transcriptionCacheSourceCallId: cached.sourceCallId,
            transcriptionCacheSourceTranscriptId: cached.sourceTranscriptId,
            transcriptionCanonicalContentHash: cached.contentHash,
          });
          return { success: true, callId };
        }
        const transcript = await transcribeScribe({
          audioPath: localAudioPath, duration, apiKey: process.env.ELEVENLABS_API_KEY,
          callId, processingGeneration,
          /** Check call generation during the batch request as well as before publication. */
          shouldContinue: () => isCurrentProcessingGeneration(callRef, processingGeneration),
        });
        const contentHash = canonicalTranscriptContentHash({ ...transcript, audioIdentity });
        const published = await publishTranscript(callRef, processingGeneration, { ...transcript, audioIdentity }, selection, 'direct', {
          transcriptionCacheHit: false, transcriptionCacheKey: cacheKey,
          transcriptionCanonicalContentHash: contentHash,
        });
        if (published) {
          const publishedTranscript = await callRef.collection('transcript').doc('data').get();
          const data = publishedTranscript.data();
          if (data) {
            const recorded = await recordCanonicalTranscript({ firestore: db, callId, audioIdentity, selection, transcript: data });
            if (!recorded.created) {
              console.log(`Transcription cache already established for ${callId}; preserving first canonical source`);
            }
          }
        }
        return { success: true, callId };
      } finally {
        cleanupTmpDir(tmpDir);
      }
    }

    let demoAudioDurationSeconds: number | undefined;
    // Check if chunking is needed
    if (ENABLE_CHUNKING) {
      /** Calls Firebase Storage to read or write call media. */
      const bucket = getCallAudioBucket(callData);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-probe-'));
      const probePath = path.join(tmpDir, 'probe.wav');

      try {
        await downloadToTmp(bucket, audioPath, probePath);
        const duration = await validateDemoAudioFile(probePath);
        if (await hashAudioFile(probePath) !== callData.audioContentHash) throw new Error('Demo audio bytes changed');
        demoAudioDurationSeconds = duration;
        console.log(`Audio duration: ${duration}s (threshold: ${CHUNK_THRESHOLD_SEC}s)`);
        cleanupTmpDir(tmpDir);

        /** Calls an external SDK or API dependency. */
        await updateCurrentCall(callRef, processingGeneration, {
          probeDurationSec: duration,
          updatedAt: FieldValue.serverTimestamp(),
        });

        if (!(await isCurrentProcessingGeneration(callRef, processingGeneration))) {
          console.log(`Skipping transcription continuation for ${callId}; processing was canceled or superseded`);
          return { success: true, callId };
        }

        if (duration > CHUNK_THRESHOLD_SEC) {
          // Dispatch chunks — each gets its own Firebase instance
          console.log(`Using distributed chunking for ${callId} (${duration}s > ${CHUNK_THRESHOLD_SEC}s)`);
          await prepareAndDispatchChunks(callId, processingGeneration);
          // Return immediately — mergeAndFinalizeChunks will set status to 'analyzing'
          return { success: true, callId };
        } else {
          console.log(`Using direct transcription for ${callId} (${duration}s <= ${CHUNK_THRESHOLD_SEC}s)`);
          /** Calls an external SDK or API dependency. */
          await updateCurrentCall(callRef, processingGeneration, {
            transcriptionMode: 'direct',
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      } catch (probeError) {
        cleanupTmpDir(tmpDir);
        throw probeError;
      }
    }

    // Direct transcription path (small files or probe failure)
    const openai = createDemoOpenAI({ purpose: 'transcription', callId, processingGeneration,
      audioDurationSeconds: demoAudioDurationSeconds });

    if (!(await isCurrentProcessingGeneration(callRef, processingGeneration))) {
      console.log(`Skipping direct transcription for ${callId}; processing was canceled or superseded`);
      return { success: true, callId };
    }

    const transcriptData = await transcribeDirect(
      openai,
      getCallAudioBucket(callData),
      audioPath,
      /** Handles the callback for this operation. */
      () => isCurrentProcessingGeneration(callRef, processingGeneration),
      callData.audioContentHash,
      String(callData.audioStorageGeneration)
    );

    if (!(await isCurrentProcessingGeneration(callRef, processingGeneration))) {
      console.log(`Skipping transcript write for ${callId}; a newer processing generation is active`);
      return { success: true, callId };
    }

    await publishTranscript(callRef, processingGeneration, transcriptData, selection, 'direct');

    return { success: true, callId };
  } catch (error: any) {
    console.error('Transcription error:', error);
    const serializedError = serializeCallError(error, 'transcription');

    if (!(await isCurrentProcessingGeneration(callRef, processingGeneration))) {
      console.log(`Skipping transcription error write for ${callId}; processing was canceled or superseded`);
      return { success: true, callId };
    }

    /** Calls an external SDK or API dependency. */
    const recorded = await updateCurrentCall(callRef, processingGeneration, {
      status: 'error',
      updatedAt: FieldValue.serverTimestamp(),
      ...buildCallErrorUpdate(serializedError),
      ...(serializedError.errorCode === 'insufficient_quota' && callData.transcriptionProvider === 'elevenlabs'
        ? { statusReason: 'elevenlabs_insufficient_quota' } : {}),
    });
    if (recorded && await isCurrentProcessingGeneration(callRef, processingGeneration)) {
      await recordRuntimeFailureForDelayedRetry({ callRef, stage: 'transcription', error: serializedError });
    }

    throw error;
  }
}

/**
 * Direct transcription for small files (original implementation).
 */
async function transcribeDirect(
  openai: OpenAI,
  bucketOrAudioPath: ReturnType<typeof storage.bucket> | string,
  audioPathOrShouldContinue?: string | (() => Promise<boolean>),
  shouldContinueInput?: () => Promise<boolean>,
  expectedAudioHash?: string,
  expectedAudioGeneration?: string
): Promise<TranscriptData> {
  const bucket = typeof bucketOrAudioPath === 'string' ? storage.bucket() : bucketOrAudioPath;
  const audioPath = typeof bucketOrAudioPath === 'string' ? bucketOrAudioPath : String(audioPathOrShouldContinue ?? '');
  const defaultShouldContinue = /** Documents the defaultShouldContinue behavior. */ async () => true;
  const shouldContinue =
    typeof bucketOrAudioPath === 'string'
      ? (typeof audioPathOrShouldContinue === 'function'
        ? audioPathOrShouldContinue
        : defaultShouldContinue)
      : (shouldContinueInput ?? defaultShouldContinue);
  assertDemoBucket(bucket.name);
  if (!expectedAudioHash || !/^[a-f0-9]{64}$/.test(expectedAudioHash) ||
      !expectedAudioGeneration || !/^\d+$/.test(expectedAudioGeneration)) {
    throw new Error('Demo transcription requires an immutable prepared audio identity');
  }
  const file = bucket.file(audioPath, { generation: expectedAudioGeneration });
  const [audioBuffer] = await file.download();
  if (audioBuffer.length > DEMO_MAX_AUDIO_BYTES ||
      createHash('sha256').update(audioBuffer).digest('hex') !== expectedAudioHash) {
    throw new Error('Demo audio bytes changed before paid transcription');
  }

  if (!(await shouldContinue())) {
    throw { message: 'Direct transcription was canceled before the OpenAI request', code: 'stale_generation' };
  }

  const filename = audioPath.split('/').pop() || 'audio.wav';
  const audioFile = await toFile(audioBuffer, filename, { type: 'audio/wav' });

  /** Calls the OpenAI API for model inference or transcription. */
  const transcription = (await openai.audio.transcriptions.create({
    model: 'gpt-4o-transcribe-diarize',
    file: audioFile,
    response_format: 'diarized_json' as any,
    chunking_strategy: 'auto',
  } as any)) as any;

  const segments = transcription.segments || [];
  const lastSegment = segments[segments.length - 1];
  const calculatedDuration = lastSegment?.end || 0;
  const duration = transcription.duration || calculatedDuration;

  return {
    task: 'transcribe',
    audioIdentity: createHash('sha256').update(audioBuffer).digest('hex'),
    duration: duration,
    text: transcription.text,
    segments:
      segments.map(/** Handles the callback for this operation. */(seg: any, index: number) => ({
        id: `seg_${index}`,
        start: seg.start,
        end: seg.end,
        text: seg.text,
        speaker: seg.speaker || 'A',
      })) || [],
    usage: {
      type: 'duration',
      seconds: Math.ceil(duration),
    },
  };
}

// Export for testing and trigger usage
export { transcribeChunkWithRetry, mergeTranscripts, transcribeDirect, prepareAndDispatchChunks, mergeAndFinalizeChunks };
