import { createHash } from "crypto";
import type { Firestore } from "firebase-admin/firestore";
import { loadTranscriptTimeline, type ProviderSelection, type VersionedTranscript } from "./transcriptionProvider";

export const TRANSCRIPTION_CACHE_COLLECTION = "transcription_cache";
export const SCRIBE_REQUEST_CONFIG_VERSION = "scribe_v2_es_diarized_roles_word_v1";

export interface TranscriptionCacheHit {
  cacheKey: string;
  sourceCallId: string;
  sourceTranscriptId: string;
  contentHash: string;
  transcript: Partial<VersionedTranscript>;
}

/** Serializes JSON-compatible evidence with stable object-key ordering. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/** Keys one immutable provider request contract and one exact recording identity. */
export function buildTranscriptionCacheKey(audioIdentity: string, selection: ProviderSelection): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    schemaVersion: 1,
    audioIdentity,
    provider: selection.transcriptionProvider,
    model: selection.transcriptionModel,
    requestConfigVersion: SCRIBE_REQUEST_CONFIG_VERSION,
  }))).digest("hex");
}

/** Hashes only canonical provider output, excluding per-call processing identity. */
export function canonicalTranscriptContentHash(transcript: Partial<VersionedTranscript>): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    duration: transcript.duration,
    text: transcript.text,
    segments: transcript.segments,
    words: transcript.words,
    usage: transcript.usage,
  }))).digest("hex");
}

/** Rejects stale, mismatched, or malformed cache pointers before evidence reuse. */
export function validateCachedTranscript(params: {
  cache: Record<string, unknown>;
  transcript: Partial<VersionedTranscript> | null;
  audioIdentity: string;
  selection: ProviderSelection;
}): TranscriptionCacheHit | null {
  const { cache, transcript, audioIdentity, selection } = params;
  const sourceCallId = typeof cache.sourceCallId === "string" ? cache.sourceCallId : "";
  const sourceTranscriptId = typeof cache.sourceTranscriptId === "string" ? cache.sourceTranscriptId : "";
  const cacheKey = typeof cache.cacheKey === "string" ? cache.cacheKey : "";
  if (cache.status !== "complete" || !/^[a-f0-9]{64}$/.test(cacheKey) || !sourceCallId || sourceCallId.includes("/") ||
      !/^[a-f0-9]{64}$/.test(sourceTranscriptId) || cache.audioIdentity !== audioIdentity ||
      cache.provider !== selection.transcriptionProvider || cache.model !== selection.transcriptionModel ||
      cache.requestConfigVersion !== SCRIBE_REQUEST_CONFIG_VERSION || !transcript ||
      transcript.audioIdentity !== audioIdentity || transcript.provider !== selection.transcriptionProvider ||
      transcript.model !== selection.transcriptionModel || transcript.transcriptId !== sourceTranscriptId ||
      typeof transcript.duration !== "number" || !Number.isFinite(transcript.duration) || transcript.duration < 0.1 ||
      typeof transcript.text !== "string" || !Array.isArray(transcript.segments) || !Array.isArray(transcript.words)) return null;
  const contentHash = canonicalTranscriptContentHash(transcript);
  if (cache.contentHash !== contentHash) return null;
  return { cacheKey, sourceCallId, sourceTranscriptId, contentHash, transcript };
}

/** Loads a complete canonical transcript through its backend-only cache pointer. */
export async function loadCanonicalTranscript(params: {
  firestore: Firestore;
  audioIdentity: string;
  selection: ProviderSelection;
}): Promise<TranscriptionCacheHit | null> {
  const cacheKey = buildTranscriptionCacheKey(params.audioIdentity, params.selection);
  const cacheSnapshot = await params.firestore.collection(TRANSCRIPTION_CACHE_COLLECTION).doc(cacheKey).get();
  const cache = cacheSnapshot.data();
  if (!cacheSnapshot.exists || !cache) return null;
  const sourceCallId = typeof cache.sourceCallId === "string" ? cache.sourceCallId : "";
  if (!sourceCallId || sourceCallId.includes("/")) return null;
  const transcript = await loadTranscriptTimeline(params.firestore.collection("calls").doc(sourceCallId));
  return validateCachedTranscript({ cache: { ...cache, cacheKey }, transcript, audioIdentity: params.audioIdentity,
    selection: params.selection });
}

/** Records the first successfully published transcript as the canonical reusable source. */
export async function recordCanonicalTranscript(params: {
  firestore: Firestore;
  callId: string;
  audioIdentity: string;
  selection: ProviderSelection;
  transcript: Partial<VersionedTranscript>;
}): Promise<{ cacheKey: string; contentHash: string; created: boolean }> {
  const cacheKey = buildTranscriptionCacheKey(params.audioIdentity, params.selection);
  const contentHash = canonicalTranscriptContentHash(params.transcript);
  const sourceTranscriptId = params.transcript.transcriptId;
  if (!params.callId || params.callId.includes("/") || typeof sourceTranscriptId !== "string" || !/^[a-f0-9]{64}$/.test(sourceTranscriptId)) {
    throw new Error("Cannot cache transcript without valid immutable source identity");
  }
  const ref = params.firestore.collection(TRANSCRIPTION_CACHE_COLLECTION).doc(cacheKey);
  const created = await params.firestore.runTransaction(/** Preserves the first completed provider result for this exact request identity. */ async (txn) => {
    const existing = await txn.get(ref);
    if (existing.exists) return false;
    txn.create(ref, { schemaVersion: 1, status: "complete", cacheKey, audioIdentity: params.audioIdentity,
      provider: params.selection.transcriptionProvider, model: params.selection.transcriptionModel,
      requestConfigVersion: SCRIBE_REQUEST_CONFIG_VERSION, sourceCallId: params.callId, sourceTranscriptId,
      contentHash, createdAt: new Date() });
    return true;
  });
  return { cacheKey, contentHash, created };
}
