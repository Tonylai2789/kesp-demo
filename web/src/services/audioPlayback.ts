import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDocFromServer } from 'firebase/firestore';
import { getDownloadURL, ref } from 'firebase/storage';
import { auth } from './firebaseAuth';
import { db } from './firebaseFirestore';
import { storage } from './firebaseStorage';
import { emulatorHosts, firebaseProjectId, isUsingEmulators } from './firebaseApp';

export interface AudioDownloadProgress { loaded: number; total: number | null }
export interface AudioPlaybackLease { url: string; release: () => void }
interface AcquireOptions {
  audioPath: string;
  signal?: AbortSignal;
  onProgress?: (progress: AudioDownloadProgress) => void;
}
interface CacheEntry {
  key: string; base: string; url: string; bytes: number; refs: number; lastUsed: number;
  expiry?: ReturnType<typeof setTimeout>;
}
interface PendingDownload {
  controller: AbortController;
  listeners: Set<(progress: AudioDownloadProgress) => void>;
  users: number;
  promise: Promise<CacheEntry>;
  entry?: CacheEntry;
}

const FILE_LIMIT = 100 * 1024 * 1024;
const DEMO_FILE_LIMIT = 25 * 1024 * 1024;
const DEMO_PROJECT = 'kesp-demo-tonylai2789';
const DEMO_BUCKET = `${DEMO_PROJECT}.firebasestorage.app`;
const CACHE_LIMIT = 128 * 1024 * 1024;
const IDLE_MS = 10 * 60 * 1000;
const STALL_MS = 30 * 1000;
const DEADLINE_MS = 120 * 1000;
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, PendingDownload>();
const invalidationListeners = new Set<(reason?: 'unauthorized') => void>();
let currentUid = auth.currentUser?.uid ?? null;
let epoch = 0;
let reservedBytes = 0;

/** Stable error codes are translated by the player, without exposing storage paths or tokens. */
function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** Revoke only private blob URLs; legacy download URL permissions remain unchanged. */
function removeEntry(entry: CacheEntry): void {
  clearTimeout(entry.expiry);
  cache.delete(entry.key);
  if (entry.url.startsWith('blob:')) URL.revokeObjectURL(entry.url);
}

/** Release either a caller lease or the temporary download-to-player handoff lease. */
function releaseEntry(entry: CacheEntry): void {
  entry.refs -= 1;
  entry.lastUsed = Date.now();
  if (entry.refs === 0 && cache.get(entry.key) === entry) {
    entry.expiry = setTimeout(/** Remove a recording after ten idle minutes. */ () => {
      if (entry.refs === 0) removeEntry(entry);
    }, IDLE_MS);
    makeRoom(0);
  }
}

/** Clear session audio on logout or observed permission loss, including outstanding downloads. */
export function invalidateAudioPlaybackCache(reason?: 'unauthorized'): void {
  epoch += 1;
  for (const request of pending.values()) request.controller.abort();
  pending.clear();
  for (const entry of cache.values()) removeEntry(entry);
  for (const listener of invalidationListeners) listener(reason);
}

/** Players stop immediately when their authenticated audio session is invalidated. */
export function subscribeAudioPlaybackInvalidation(listener: (reason?: 'unauthorized') => void): () => void {
  invalidationListeners.add(listener);
  return /** Remove this player's subscription. */ () => { invalidationListeners.delete(listener); };
}

// Observe Firebase auth rather than retaining audio across different signed-in users.
onAuthStateChanged(auth, /** Invalidate only when the principal changes, not on token refresh. */ (user) => {
  const nextUid = user?.uid ?? null;
  if (nextUid !== currentUid) {
    currentUid = nextUid;
    invalidateAudioPlaybackCache();
  }
});

/** Bound auth/legacy SDK waits without allowing a late result to become playable. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>(/** Reject immediately on cancellation and detach listeners after settlement. */ (resolve, reject) => {
    const abort = /** Preserve the request's timeout or cancellation reason. */ () => reject(signal.reason ?? failure('aborted'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(/** Remove the waiter even if the SDK settles late. */ () => signal.removeEventListener('abort', abort));
  });
}

/** Fetch through Firebase Storage rules with cancellable XHR, never a bearer token in a URL. */
function request(url: string, token: string, signal: AbortSignal, media: boolean,
  onProgress: (progress: AudioDownloadProgress) => void, mediaLimit = FILE_LIMIT): Promise<Blob | Record<string, unknown>> {
  return new Promise(/** Track actual transfer progress and stop stalled network requests. */ (resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let stall: ReturnType<typeof setTimeout>;
    const cleanup = /** Detach network and cancellation listeners on every terminal path. */ () => {
      clearTimeout(stall);
      signal.removeEventListener('abort', abort);
      xhr.onload = xhr.onerror = xhr.onabort = xhr.onprogress = null;
    };
    const fail = /** Abort the real request, not only its surrounding Promise. */ (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      xhr.abort();
      reject(error);
    };
    const abort = /** Cancel on logout, supersession or the overall request deadline. */ () => fail(signal.reason ?? failure('aborted'));
    const resetStall = /** Restart the no-progress deadline after bytes arrive. */ () => {
      clearTimeout(stall);
      stall = setTimeout(/** A stalled transfer must become a retryable error. */ () => fail(failure('timeout')), STALL_MS);
    };
    if (signal.aborted) { reject(signal.reason ?? failure('aborted')); return; }
    signal.addEventListener('abort', abort, { once: true });
    xhr.open('GET', url);
    xhr.responseType = media ? 'blob' : 'json';
    xhr.setRequestHeader('Authorization', `Firebase ${token}`);
    xhr.onerror = /** CORS and transport errors are not retried invisibly. */ () => fail(failure('network'));
    xhr.onabort = /** Surface external cancellation without a stale success. */ () => fail(failure('aborted'));
    xhr.onprogress = /** Enforce the existing size limit while displaying bytes received. */ (event) => {
      if (event.loaded > (media ? mediaLimit : 1024 * 1024)) { fail(failure('too-large')); return; }
      resetStall();
      if (media) onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : null });
    };
    xhr.onload = /** Classify permission and object failures before accepting response bytes. */ () => {
      if (xhr.status === 401 || xhr.status === 403) { fail(failure('unauthorized')); return; }
      if (xhr.status === 404) { fail(failure('not-found')); return; }
      if (xhr.status !== 200 && xhr.status !== 206) { fail(failure('network')); return; }
      if (!xhr.response) { fail(failure('invalid-audio')); return; }
      settled = true;
      cleanup();
      resolve(xhr.response);
    };
    resetStall();
    // Send the authenticated request to the existing Firebase Storage endpoint.
    xhr.send();
  });
}

/** Evict least-recently-used idle recordings without revoking an active player's URL. */
function makeRoom(bytes: number): void {
  let used = reservedBytes + [...cache.values()].reduce(/** Include in-flight reservations in the memory budget. */ (sum, entry) => sum + entry.bytes, 0);
  const idle = [...cache.values()].filter(/** Leased recordings cannot be evicted. */ (entry) => entry.refs === 0)
    .sort(/** Oldest idle entries leave first. */ (a, b) => a.lastUsed - b.lastUsed);
  for (const entry of idle) {
    if (used + bytes <= CACHE_LIMIT && Date.now() - entry.lastUsed < IDLE_MS) continue;
    used -= entry.bytes;
    removeEntry(entry);
  }
  if (used + bytes > CACHE_LIMIT) throw failure('cache-capacity');
}

/** Validate current object access/version before reusing or downloading a recording. */
async function loadEntry(audioPath: string, base: string, uid: string, requestEpoch: number,
  signal: AbortSignal, onProgress: (progress: AudioDownloadProgress) => void): Promise<CacheEntry> {
  const user = auth.currentUser;
  if (!user || user.uid !== uid) throw failure('unauthorized');
  // Firebase supplies a current ID token; it stays in memory and request headers only.
  const token = await abortable(user.getIdToken(), signal);
  if (signal.aborted || requestEpoch !== epoch || auth.currentUser?.uid !== uid) throw failure('aborted');
  const object = ref(storage, audioPath);
  const host = isUsingEmulators ? `http://${emulatorHosts.storage.host}:${emulatorHosts.storage.port}` : 'https://firebasestorage.googleapis.com';
  const endpoint = `${host}/v0/b/${encodeURIComponent(object.bucket)}/o/${encodeURIComponent(object.fullPath)}`;
  const demoPrepared = firebaseProjectId === DEMO_PROJECT && object.fullPath.startsWith('prepared-uploads/');
  let generation: string;
  let size: number;
  if (demoPrepared) {
    const parts = object.fullPath.split('/');
    if (object.bucket !== DEMO_BUCKET || parts.length !== 4 || parts.some(part => !part)) throw failure('invalid-audio');
    // A Storage metadata GET can mint a permanent token. Revalidate the backend-owned call instead.
    const snapshot = await abortable(getDocFromServer(doc(db, 'calls', parts[2])).catch((error: unknown) => {
      const code = (error as { code?: string })?.code;
      throw failure(code === 'permission-denied' || code === 'unauthenticated' ? 'unauthorized' : 'network');
    }), signal);
    if (!snapshot.exists()) throw failure('not-found');
    const call = snapshot.data();
    if (call.audioPath !== object.fullPath || call.uploadedBy !== parts[1] || call.preparedUploadRequestId !== parts[2] ||
        call.demoAudioValidated !== true || call.audioStorageBucket !== DEMO_BUCKET ||
        typeof call.audioStorageGeneration !== 'string' || !/^[1-9]\d*$/.test(call.audioStorageGeneration)) throw failure('invalid-audio');
    generation = call.audioStorageGeneration;
    // The call has no file size; reserve the upload ceiling until actual bytes are validated.
    size = DEMO_FILE_LIMIT;
  } else {
    const metadata = await request(endpoint, token, signal, false, onProgress) as Record<string, unknown>;
    size = Number(metadata.size);
    if (!metadata.generation || !Number.isFinite(size) || size <= 0 || size > FILE_LIMIT) throw failure('too-large');
    generation = String(metadata.generation);
  }
  const key = `${base}|${generation}`;
  if (signal.aborted || requestEpoch !== epoch || auth.currentUser?.uid !== uid) throw failure('aborted');
  for (const entry of cache.values()) {
    if (entry.base === base && entry.key !== key && entry.refs === 0) removeEntry(entry);
  }
  makeRoom(0);
  const existing = cache.get(key);
  if (existing) { existing.refs += 1; clearTimeout(existing.expiry); return existing; }
  const privateAudio = object.fullPath.startsWith('prepared-uploads/') || object.fullPath.startsWith('scribe-smoke/');
  let url: string;
  if (privateAudio) {
    makeRoom(size);
    reservedBytes += size;
    let blob: Blob;
    try {
      blob = await request(`${endpoint}?alt=media&generation=${encodeURIComponent(generation)}`, token, signal, true, onProgress,
        demoPrepared ? DEMO_FILE_LIMIT : FILE_LIMIT) as Blob;
    } finally {
      reservedBytes -= size;
    }
    if (!(blob instanceof Blob)) throw failure('invalid-audio');
    if (demoPrepared && blob.size > DEMO_FILE_LIMIT) throw failure('too-large');
    if ((demoPrepared ? blob.size <= 0 : blob.size !== size) || !blob.type.startsWith('audio/')) throw failure('invalid-audio');
    size = blob.size;
    makeRoom(blob.size);
    url = URL.createObjectURL(blob);
  } else {
    // Preserve the existing Firebase URL behavior for ordinary/legacy audio paths.
    url = await abortable(getDownloadURL(object), signal);
  }
  if (signal.aborted || requestEpoch !== epoch || auth.currentUser?.uid !== uid) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    throw failure('aborted');
  }
  const entry: CacheEntry = { key, base, url, bytes: privateAudio ? size : 0, refs: 1, lastUsed: Date.now() };
  cache.set(key, entry);
  return entry;
}

/** Acquire a shared, user-bound audio lease; releasing it retains idle audio for ten minutes. */
export function acquireAudioPlayback({ audioPath, signal, onProgress }: AcquireOptions): Promise<AudioPlaybackLease> {
  const uid = auth.currentUser?.uid;
  if (!uid) return Promise.reject(failure('unauthorized'));
  if (signal?.aborted) return Promise.reject(failure('aborted'));
  if (currentUid !== uid) { currentUid = uid; invalidateAudioPlaybackCache(); }
  const object = ref(storage, audioPath);
  const base = JSON.stringify([firebaseProjectId, uid, object.bucket, object.fullPath]);
  let work = pending.get(base);
  if (!work) {
    const controller = new AbortController();
    const listeners = new Set<(progress: AudioDownloadProgress) => void>();
    const timer = setTimeout(/** Bound token, metadata and audio retrieval together. */ () => controller.abort(failure('timeout')), DEADLINE_MS);
    const promise = loadEntry(audioPath, base, uid, epoch, controller.signal,
      /** Fan progress out to all callers sharing this download. */ (progress) => { for (const listener of listeners) listener(progress); })
      .then(/** Hold a provisional lease until all waiting consumers have received theirs. */ (entry) => {
        created.entry = entry;
        if (created.users === 0) { releaseEntry(entry); created.entry = undefined; }
        return entry;
      })
      .catch(/** Purge retained audio if current access has been revoked. */ (error: unknown) => {
        if ((error as { code?: string })?.code === 'unauthorized') invalidateAudioPlaybackCache('unauthorized');
        throw error;
      }).finally(/** Remove only this request; a later retry may already occupy its key. */ () => {
        clearTimeout(timer);
        if (pending.get(base) === created) pending.delete(base);
      });
    const created: PendingDownload = { controller, listeners, users: 0, promise };
    pending.set(base, created);
    work = created;
  }
  const shared = work;
  shared.users += 1;
  if (onProgress) shared.listeners.add(onProgress);
  return new Promise<AudioPlaybackLease>(/** Each subscriber may cancel without interrupting other subscribers. */ (resolve, reject) => {
    let done = false;
    const detach = /** Remove this consumer's progress and abort listeners. */ () => {
      if (onProgress) shared.listeners.delete(onProgress);
      signal?.removeEventListener('abort', abort);
      shared.users -= 1;
      if (shared.users === 0 && shared.entry) {
        releaseEntry(shared.entry);
        shared.entry = undefined;
      }
    };
    const abort = /** Abort the underlying request only when nobody still needs it. */ () => {
      if (done) return;
      done = true;
      detach();
      if (shared.users === 0) {
        shared.controller.abort(failure('aborted'));
        if (pending.get(base) === shared) pending.delete(base);
      }
      reject(failure('aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    shared.promise.then(/** Pin this cache entry until the player releases its lease. */ (entry) => {
      if (done) return;
      done = true;
      if (cache.get(entry.key) !== entry) { detach(); reject(failure('aborted')); return; }
      entry.refs += 1;
      clearTimeout(entry.expiry);
      detach();
      let released = false;
      resolve({ url: entry.url, release: /** Release once and schedule bounded idle retention. */ () => {
        if (released) return;
        released = true;
        releaseEntry(entry);
      } });
    }, /** Failed requests never populate reusable audio state. */ (error) => {
      if (done) return;
      done = true;
      detach();
      reject(error);
    });
  });
}
