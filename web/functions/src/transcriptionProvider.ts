import { createHash } from 'crypto';
import type { DocumentData, DocumentReference } from 'firebase-admin/firestore';
import { DEMO_PROJECT_ID, assertDemoRuntime } from './demoBudget';

export type TranscriptionProvider = 'openai' | 'elevenlabs';
export const OPENAI_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe-diarize';
export const SCRIBE_TRANSCRIPTION_MODEL = 'scribe_v2';
export const TRANSCRIPT_SCHEMA_VERSION = 2;
export const MAX_TRANSCRIPT_DOCUMENT_BYTES = 900 * 1024;

export interface ProviderSelection {
  transcriptionProvider: TranscriptionProvider;
  transcriptionModel: string;
}

export interface TranscriptWord {
  id: string;
  text: string;
  type: 'word' | 'spacing' | 'audio_event';
  start: number;
  end: number;
  speakerId: string | null;
  rawSpeakerId: string | null;
  speakerRole: 'agent' | 'customer' | 'unknown';
}

export interface VersionedTranscript {
  task: string;
  duration: number;
  text: string;
  segments: Array<{ id: string; start: number; end: number; text: string; speaker: string }>;
  usage?: { type: string; seconds: number };
  provider: TranscriptionProvider;
  model: string;
  schemaVersion: number;
  processingGeneration: number;
  audioIdentity: string;
  audioIdentityMethod?: 'sha256' | 'legacy_source_metadata_sha256';
  transcriptId: string;
  words?: TranscriptWord[];
  wordPages?: { count: number; wordCount: number };
}

/** Only the backend creating a NEW job may consult the production opt-in. Never use on retries. */
export function buildTranscriptionProviderSnapshot(
  callData: DocumentData,
  projectId: string,
  configuredProvider = process.env.CCC_TRANSCRIPTION_PROVIDER
): ProviderSelection & { transcriptionProviderSnapshotVersion: number } {
  // This standalone demo never enables CCC ingestion or its provider rollout.
  void callData;
  void configuredProvider;
  assertDemoRuntime({ GCLOUD_PROJECT: projectId });
  const enabled = false;
  return {
    transcriptionProvider: enabled ? 'elevenlabs' : 'openai',
    transcriptionModel: enabled ? SCRIBE_TRANSCRIPTION_MODEL : OPENAI_TRANSCRIPTION_MODEL,
    transcriptionProviderSnapshotVersion: 1,
  };
}

/** Resolve persisted backend-owned fields; unsnapshotted legacy jobs always remain OpenAI. */
export function resolveTranscriptionProvider(callData: DocumentData, projectId: string): ProviderSelection {
  assertDemoRuntime({ GCLOUD_PROJECT: projectId });
  if (callData.callSource !== 'manual_upload' || callData.organizationId !== 'consubanco' ||
      callData.transcriptionManualSelectionVersion !== 1 || callData.transcriptionTestOverride === true) {
    throw Object.assign(new Error('Demo transcription requires a backend-owned manual-upload snapshot'), { code: 'invalid_transcription_provider' });
  }
  const provider = callData.transcriptionProvider ?? 'openai';
  const model = callData.transcriptionModel ?? OPENAI_TRANSCRIPTION_MODEL;
  if (provider === 'openai' && model === OPENAI_TRANSCRIPTION_MODEL) {
    return { transcriptionProvider: provider, transcriptionModel: model };
  }
  // These fields must be denied on client create/update, including additions via affectedKeys().
  const manualSnapshot = projectId === DEMO_PROJECT_ID &&
    callData.callSource === 'manual_upload' && callData.organizationId === 'consubanco' &&
    callData.transcriptionManualSelectionVersion === 1;
  if (provider === 'elevenlabs' && model === SCRIBE_TRANSCRIPTION_MODEL &&
      manualSnapshot) {
    return { transcriptionProvider: provider, transcriptionModel: model };
  }
  throw Object.assign(new Error('Invalid or unauthorized transcription provider snapshot'), { code: 'invalid_transcription_provider' });
}

/** Derive an opaque source identity without changing the call's source/bucket fields. */
export function buildTranscriptIdentity(
  selection: ProviderSelection,
  processingGeneration: number,
  audioIdentity: string,
  content: unknown
): Pick<VersionedTranscript, 'provider' | 'model' | 'schemaVersion' | 'processingGeneration' | 'audioIdentity' | 'transcriptId'> {
  const provider = selection.transcriptionProvider;
  const model = selection.transcriptionModel;
  const transcriptId = createHash('sha256').update(JSON.stringify({
    provider, model, schemaVersion: TRANSCRIPT_SCHEMA_VERSION, processingGeneration, audioIdentity, content,
  })).digest('hex');
  return { provider, model, schemaVersion: TRANSCRIPT_SCHEMA_VERSION, processingGeneration, audioIdentity, transcriptId };
}

/** Conservatively overestimate Firestore map/array storage, including numeric and map overhead. */
function estimateStoredBytes(value: unknown): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') + 1;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 1;
  if (Array.isArray(value)) return value.reduce(/** Add each nested value's storage. */ (sum, entry) => sum + estimateStoredBytes(entry), 32);
  if (typeof value === 'object') {
    return Object.entries(value).reduce(/** Include map keys and nested values. */ (sum, [key, entry]) =>
      sum + Buffer.byteLength(key, 'utf8') + 1 + estimateStoredBytes(entry), 32);
  }
  throw new Error('Unsupported transcript value');
}

/** Fail clearly before a Firestore write instead of silently truncating word evidence or text. */
export function assertTranscriptDocumentSize(transcript: unknown): void {
  const bytes = Math.max(estimateStoredBytes(transcript), Buffer.byteLength(JSON.stringify(transcript), 'utf8'));
  if (bytes > MAX_TRANSCRIPT_DOCUMENT_BYTES) {
    throw Object.assign(new Error('Transcript exceeds the safe inline Firestore limit; paginated timeline storage is required'), {
      code: 'transcript_too_large',
    });
  }
}

export interface TranscriptWordPage {
  transcriptId: string;
  audioIdentity: string;
  processingGeneration: number;
  pageIndex: number;
  words: TranscriptWord[];
}

export interface TranscriptStoragePlan {
  transcript: VersionedTranscript;
  pages: TranscriptWordPage[];
}

/** Page words only; legacy text/segments must still fit the canonical document. */
export function buildTranscriptStoragePlan(transcript: VersionedTranscript): TranscriptStoragePlan {
  try {
    assertTranscriptDocumentSize(transcript);
    return { transcript, pages: [] };
  } catch (error) {
    if (!transcript.words?.length) throw error;
  }
  const { words, ...legacy } = transcript;
  const pages: TranscriptWordPage[] = [];
  let pending: TranscriptWord[] = [];
  let pendingBytes = 1024;
  for (const word of words!) {
    const bytes = Math.max(estimateStoredBytes(word), Buffer.byteLength(JSON.stringify(word))) + 8;
    if (bytes > 250 * 1024) {
      throw Object.assign(new Error('A transcript word exceeds the safe page size'), { code: 'transcript_too_large' });
    }
    if (pending.length && pendingBytes + bytes > 250 * 1024) {
      pages.push({ transcriptId: transcript.transcriptId, audioIdentity: transcript.audioIdentity,
        processingGeneration: transcript.processingGeneration, pageIndex: pages.length, words: pending });
      pending = [];
      pendingBytes = 1024;
    }
    pending.push(word);
    pendingBytes += bytes;
  }
  if (pending.length) pages.push({ transcriptId: transcript.transcriptId, audioIdentity: transcript.audioIdentity,
    processingGeneration: transcript.processingGeneration, pageIndex: pages.length, words: pending });
  if (pages.length > 100) {
    throw Object.assign(new Error('Transcript exceeds the bounded word-page count (100)'), { code: 'transcript_too_large' });
  }
  const canonical = { ...legacy, wordPages: { count: pages.length, wordCount: words!.length } };
  assertTranscriptDocumentSize(canonical);
  for (const page of pages) assertTranscriptDocumentSize(page);
  return { transcript: canonical, pages };
}

/** Identity-scoped immutable page names prevent newer generations from overwriting older evidence. */
export function transcriptWordPageId(transcriptId: string, pageIndex: number): string {
  return `words_${transcriptId}_${pageIndex}`;
}

/** Load inline or paged words; never return partial, mixed-generation, or duplicate evidence. */
export async function loadTranscriptTimeline(callRef: DocumentReference): Promise<Partial<VersionedTranscript> | null> {
  // Use a read-only transaction so the canonical document and all page reads share one snapshot.
  return callRef.firestore.runTransaction(/** Assemble exactly the timeline named by the canonical manifest. */ async (txn) => {
    const snapshot = await txn.get(callRef.collection('transcript').doc('data'));
    if (!snapshot.exists) return null;
    const transcript = snapshot.data() as Partial<VersionedTranscript>;
    if (!transcript.wordPages) return transcript;
    const { count, wordCount } = transcript.wordPages;
    if (!Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(wordCount) || wordCount < 1 ||
        typeof transcript.transcriptId !== 'string' || !/^[a-f0-9]{64}$/.test(transcript.transcriptId) ||
        !Number.isInteger(transcript.processingGeneration) || typeof transcript.audioIdentity !== 'string') {
      throw Object.assign(new Error('Invalid transcript word-page manifest'), { code: 'invalid_transcript_pages' });
    }
    const words: TranscriptWord[] = [];
    const seen = new Set<string>();
    let previousStart = -Infinity;
    for (let pageIndex = 0; pageIndex < count; pageIndex++) {
      // Fetch only the identity-addressed page in this manifest, never an unbounded collection query.
      const pageDoc = await txn.get(callRef.collection('transcript').doc(transcriptWordPageId(transcript.transcriptId, pageIndex)));
      const page = pageDoc.data() as TranscriptWordPage | undefined;
      if (!pageDoc.exists || !page || page.transcriptId !== transcript.transcriptId ||
          page.processingGeneration !== transcript.processingGeneration || page.audioIdentity !== transcript.audioIdentity ||
          page.pageIndex !== pageIndex || !Array.isArray(page.words)) {
        throw Object.assign(new Error('Missing or mismatched transcript word page'), { code: 'invalid_transcript_pages' });
      }
      for (const word of page.words) {
        if (!word || typeof word.id !== 'string' || seen.has(word.id) || !Number.isFinite(word.start) || word.start < previousStart) {
          throw Object.assign(new Error('Invalid or duplicate paged transcript word'), { code: 'invalid_transcript_pages' });
        }
        seen.add(word.id);
        previousStart = word.start;
        words.push(word);
      }
    }
    if (words.length !== wordCount) throw Object.assign(new Error('Incomplete transcript word timeline'), { code: 'invalid_transcript_pages' });
    return { ...transcript, words };
  }, { readOnly: true });
}
