import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('./audioPlayback.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const path = 'prepared-uploads/user/call/original.mp3';
const demoProject = 'kesp-demo-tonylai2789';
const demoBucket = `${demoProject}.firebasestorage.app`;
const demoLimit = 25 * 1024 * 1024;

/** Test real service code with only network, auth, blob URLs and time replaced. */
function fixture({ emulator = false, demo = false, bucket = demo ? demoBucket : 'test-bucket' } = {}) {
  let now = 0; let timerId = 0; let urlId = 0; let authChanged;
  const timers = new Map();
  const calls = { xhr: [], revoked: [], legacy: [], firestore: [] };
  const settings = { generation: '1', size: 5, status: 200, mediaStatus: 200, hold: '', type: 'audio/mpeg',
    callData: {}, callExists: true, firestoreError: null, readCall: null };
  const auth = { currentUser: { uid: 'user', getIdToken: async () => 'private-token' } };
  class FakeBlob {
    /** Avoid allocating large recordings for memory-budget tests. */
    constructor(size, type = 'audio/mpeg') { this.size = size; this.type = type; }
  }
  class XHR {
    /** Keep observable requests and cancellation independent from the live browser. */
    constructor() { this.headers = {}; this.aborted = false; }
    /** Capture the exact Firebase endpoint selected by the service. */
    open(method, url) { this.method = method; this.url = url; }
    /** Retain headers for tests, never logs or artifacts. */
    setRequestHeader(key, value) { this.headers[key] = value; }
    /** Simulate an asynchronous metadata or media response. */
    send() {
      calls.xhr.push(this);
      this.media = this.url.includes('alt=media');
      if (settings.hold === (this.media ? 'media' : 'metadata')) return;
      queueMicrotask(() => this.respond());
    }
    /** Deliver a controlled successful or rejected response. */
    respond() {
      if (this.aborted) return;
      this.status = this.media ? settings.mediaStatus : settings.status;
      this.response = this.media ? new FakeBlob(settings.size, settings.type)
        : { generation: settings.generation, size: String(settings.size) };
      this.onload?.();
    }
    /** Confirm real network abort is requested on deadlines/cancellation. */
    abort() { this.aborted = true; this.onabort?.(); }
  }
  const exports = {};
  const db = {};
  const modules = {
    'firebase/auth': { onAuthStateChanged: (_auth, callback) => { authChanged = callback; } },
    'firebase/firestore': {
      doc: (database, collection, callId) => { assert.equal(database, db); return { collection, callId }; },
      getDocFromServer: async (reference) => {
        calls.firestore.push(reference);
        if (settings.readCall) await settings.readCall();
        if (settings.firestoreError) throw settings.firestoreError;
        return { exists: () => settings.callExists, data: () => ({
          audioPath: `prepared-uploads/user/${reference.callId}/original.mp3`, uploadedBy: 'user',
          preparedUploadRequestId: reference.callId, audioStorageBucket: demoBucket,
          audioStorageGeneration: settings.generation, demoAudioValidated: true, ...settings.callData,
        }) };
      },
    },
    'firebase/storage': {
      ref: (_storage, fullPath) => ({ fullPath, bucket }),
      getDownloadURL: async (object) => { calls.legacy.push(object); return 'https://legacy.invalid/existing'; },
    },
    './firebaseAuth': { auth }, './firebaseStorage': { storage: {} }, './firebaseFirestore': { db },
    './firebaseApp': { firebaseProjectId: demo ? demoProject : 'sales-feedback-agent', isUsingEmulators: emulator,
      emulatorHosts: { storage: { host: 'localhost', port: 9199 } } },
  };
  runInNewContext(compiled, {
    exports, require: (name) => { assert.ok(name in modules, name); return modules[name]; },
    AbortController, Blob: FakeBlob, Date: { now: () => now },
    URL: { createObjectURL: () => `blob:audio-${++urlId}`, revokeObjectURL: (url) => calls.revoked.push(url) },
    XMLHttpRequest: XHR,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id), console,
  });
  /** Flush Promise continuations and fake network delivery. */
  async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
  /** Advance deterministic clocks without sleeping or touching real network. */
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  }
  return { api: exports, calls, settings, auth, flush, advance,
    changeUser: (uid) => { auth.currentUser = uid ? { uid, getIdToken: async () => 'next-token' } : null; authChanged(auth.currentUser); } };
}

test('private audio uses authenticated generation-pinned media; reopen checks metadata without downloading audio', async () => {
  const f = fixture();
  const first = await f.api.acquireAudioPlayback({ audioPath: path }); first.release(); first.release();
  const second = await f.api.acquireAudioPlayback({ audioPath: path });
  assert.equal(first.url, second.url);
  assert.equal(f.calls.xhr.filter(x => x.media).length, 1);
  assert.equal(f.calls.xhr.length, 3);
  assert.match(f.calls.xhr[1].url, /generation=1/);
  assert.equal(f.calls.xhr[1].headers.Authorization, 'Firebase private-token');
  assert.ok(f.calls.xhr.every(x => !x.url.includes('private-token')));
  assert.equal(f.calls.legacy.length, 0);
});

test('metadata and media permission denials carry a reason through complete cache invalidation', async () => {
  for (const stage of ['status', 'mediaStatus']) {
    const f = fixture(); const reasons = [];
    f.api.subscribeAudioPlaybackInvalidation(reason => reasons.push(reason));
    f.settings[stage] = 403;
    await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'unauthorized' });
    assert.deepEqual(reasons, ['unauthorized']);
    f.changeUser(null); assert.deepEqual(reasons, ['unauthorized', undefined]);
  }
});

test('concurrent requests share metadata and media and one canceled subscriber cannot cancel another', async () => {
  const f = fixture(); f.settings.hold = 'media';
  const abort = new AbortController();
  const canceled = f.api.acquireAudioPlayback({ audioPath: path, signal: abort.signal });
  const rejection = assert.rejects(canceled, { code: 'aborted' });
  const retained = f.api.acquireAudioPlayback({ audioPath: path });
  await f.flush(); abort.abort(); await rejection;
  assert.equal(f.calls.xhr.length, 2); assert.equal(f.calls.xhr[1].aborted, false);
  f.calls.xhr[1].respond(); assert.match((await retained).url, /^blob:/);
});

test('last consumer cancellation aborts the real XHR and a later retry can succeed', async () => {
  const f = fixture(); f.settings.hold = 'media'; const abort = new AbortController();
  const request = f.api.acquireAudioPlayback({ audioPath: path, signal: abort.signal });
  const rejected = assert.rejects(request, { code: 'aborted' });
  await f.flush(); abort.abort(); await rejected;
  assert.equal(f.calls.xhr[1].aborted, true);
  f.settings.hold = ''; assert.match((await f.api.acquireAudioPlayback({ audioPath: path })).url, /^blob:/);
});

test('failed transfers are not cached or retried invisibly', async () => {
  const f = fixture(); f.settings.mediaStatus = 503;
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'network' });
  assert.equal(f.calls.xhr.length, 2);
  f.settings.mediaStatus = 200;
  await f.api.acquireAudioPlayback({ audioPath: path });
  assert.equal(f.calls.xhr.filter(x => x.media).length, 2);
});

test('permission loss purges cached audio and notifies the player', async () => {
  const f = fixture(); const lease = await f.api.acquireAudioPlayback({ audioPath: path }); lease.release();
  let invalidated = 0; f.api.subscribeAudioPlaybackInvalidation(() => invalidated++);
  f.settings.status = 403;
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'unauthorized' });
  assert.deepEqual(f.calls.revoked, [lease.url]); assert.equal(invalidated, 1);
});

test('missing objects fail before media requests', async () => {
  const f = fixture(); f.settings.status = 404;
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'not-found' });
  assert.equal(f.calls.xhr.length, 1);
});

test('logout aborts pending requests and revokes active audio', async () => {
  const f = fixture(); const lease = await f.api.acquireAudioPlayback({ audioPath: path });
  f.settings.hold = 'media'; const request = f.api.acquireAudioPlayback({ audioPath: `${path}-second` });
  const rejected = assert.rejects(request); await f.flush(); f.changeUser(null); await rejected;
  assert.ok(f.calls.revoked.includes(lease.url)); assert.equal(f.calls.xhr.at(-1).aborted, true);
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'unauthorized' });
});

test('account changes cannot reuse another users cache', async () => {
  const f = fixture(); const first = await f.api.acquireAudioPlayback({ audioPath: path }); first.release();
  f.changeUser('different-user'); const next = await f.api.acquireAudioPlayback({ audioPath: path });
  assert.notEqual(first.url, next.url); assert.equal(f.calls.xhr.filter(x => x.media).length, 2);
});

test('new object generation invalidates the old idle object', async () => {
  const f = fixture(); const first = await f.api.acquireAudioPlayback({ audioPath: path }); first.release();
  f.settings.generation = '2'; const next = await f.api.acquireAudioPlayback({ audioPath: path });
  assert.notEqual(first.url, next.url); assert.ok(f.calls.revoked.includes(first.url));
});

test('idle expiry does not revoke an actively leased recording', async () => {
  const f = fixture(); const lease = await f.api.acquireAudioPlayback({ audioPath: path });
  await f.advance(11 * 60 * 1000); assert.deepEqual(f.calls.revoked, []);
  lease.release(); await f.advance(10 * 60 * 1000); assert.deepEqual(f.calls.revoked, [lease.url]);
});

test('LRU evicts idle audio and refuses to evict active recordings beyond budget', async () => {
  const f = fixture(); f.settings.size = 70 * 1024 * 1024;
  const first = await f.api.acquireAudioPlayback({ audioPath: path });
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: `${path}-second` }), { code: 'cache-capacity' });
  assert.deepEqual(f.calls.revoked, []); first.release();
  await f.api.acquireAudioPlayback({ audioPath: `${path}-second` });
  assert.deepEqual(f.calls.revoked, [first.url]);
});

test('100 MiB limit and response content validation fail closed', async () => {
  const f = fixture(); f.settings.size = 100 * 1024 * 1024 + 1;
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'too-large' });
  assert.equal(f.calls.xhr.length, 1); f.settings.size = 5; f.settings.type = 'text/html';
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'invalid-audio' });
});

test('in-flight bytes are reserved and prevent concurrent transfers exceeding the budget', async () => {
  const f = fixture(); f.settings.size = 70 * 1024 * 1024; f.settings.hold = 'media';
  const first = f.api.acquireAudioPlayback({ audioPath: path }); await f.flush();
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: `${path}-second` }), { code: 'cache-capacity' });
  assert.equal(f.calls.xhr.filter(x => x.media).length, 1);
  f.calls.xhr.find(x => x.media).respond(); const lease = await first; lease.release();
  f.settings.hold = ''; await f.api.acquireAudioPlayback({ audioPath: `${path}-second` });
  assert.ok(f.calls.revoked.includes(lease.url));
});

test('same-tick completions retain provisional leases until both callers receive audio', async () => {
  const f = fixture(); f.settings.size = 60 * 1024 * 1024; f.settings.hold = 'media';
  const first = f.api.acquireAudioPlayback({ audioPath: path });
  const second = f.api.acquireAudioPlayback({ audioPath: `${path}-second` }); await f.flush();
  for (const xhr of f.calls.xhr.filter(x => x.media)) xhr.respond();
  const leases = await Promise.all([first, second]); assert.equal(leases.length, 2);
  assert.deepEqual(f.calls.revoked, []);
  for (const lease of leases) lease.release();
  await f.advance(10 * 60 * 1000); assert.equal(f.calls.revoked.length, 2);
});

test('30-second no-progress deadline aborts a stalled transfer', async () => {
  const f = fixture(); f.settings.hold = 'media';
  const request = f.api.acquireAudioPlayback({ audioPath: path }); const rejected = assert.rejects(request, { code: 'timeout' });
  await f.flush(); await f.advance(30000); await rejected; assert.equal(f.calls.xhr[1].aborted, true);
});

test('progress resets stall deadline and is shared without restarting downloads', async () => {
  const f = fixture(); f.settings.hold = 'media'; const seen = [];
  const request = f.api.acquireAudioPlayback({ audioPath: path, onProgress: p => seen.push(p.loaded) });
  const rejected = assert.rejects(request, { code: 'timeout' }); await f.flush();
  await f.advance(20000); f.calls.xhr[1].onprogress({ loaded: 2, lengthComputable: true, total: 5 });
  await f.advance(20000); assert.equal(f.calls.xhr[1].aborted, false); assert.deepEqual(seen, [2]);
  await f.advance(10000); await rejected;
});

test('overall deadline also bounds a stalled token lookup', async () => {
  const f = fixture(); f.auth.currentUser.getIdToken = () => new Promise(() => {});
  const request = f.api.acquireAudioPlayback({ audioPath: path }); const rejected = assert.rejects(request, { code: 'timeout' });
  await f.advance(120000); await rejected; assert.equal(f.calls.xhr.length, 0);
});

test('emulator uses local configured Storage endpoint and legacy audio keeps URL path', async () => {
  const f = fixture({ emulator: true }); await f.api.acquireAudioPlayback({ audioPath: path });
  assert.match(f.calls.xhr[0].url, /^http:\/\/localhost:9199\/v0\/b\//);
  const lease = await f.api.acquireAudioPlayback({ audioPath: 'audio/unknown/legacy.mp3' });
  assert.equal(lease.url, 'https://legacy.invalid/existing'); assert.equal(f.calls.legacy.length, 1);
});

test('demo reopens validate calls from server without Storage metadata, including cross-owner readers', async () => {
  const f = fixture({ demo: true }); f.changeUser('supervisor');
  const first = await f.api.acquireAudioPlayback({ audioPath: path }); first.release();
  const second = await f.api.acquireAudioPlayback({ audioPath: path });
  assert.equal(first.url, second.url);
  assert.equal(f.calls.firestore.length, 2);
  assert.ok(f.calls.firestore.every(r => r.collection === 'calls' && r.callId === 'call'));
  assert.equal(f.calls.xhr.length, 1);
  assert.equal(f.calls.xhr[0].url, `https://firebasestorage.googleapis.com/v0/b/${demoBucket}/o/${encodeURIComponent(path)}?alt=media&generation=1`);
  assert.equal(f.calls.xhr[0].headers.Authorization, 'Firebase next-token');
  assert.ok(!f.calls.xhr[0].url.includes('next-token'));
  assert.equal(f.calls.legacy.length, 0);
});

test('demo server permission denial invalidates active cached audio and emits only sanitized errors', async () => {
  for (const code of ['permission-denied', 'unauthenticated']) {
    const f = fixture({ demo: true }); const reasons = [];
    const lease = await f.api.acquireAudioPlayback({ audioPath: path });
    f.api.subscribeAudioPlaybackInvalidation(reason => reasons.push(reason));
    f.settings.firestoreError = { code, message: 'private-token must not escape' };
    await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'unauthorized', message: 'unauthorized' });
    assert.deepEqual(f.calls.revoked, [lease.url]); assert.deepEqual(reasons, ['unauthorized']);
    assert.equal(f.calls.xhr.length, 1);
    f.settings.firestoreError = null;
    const next = await f.api.acquireAudioPlayback({ audioPath: path });
    assert.notEqual(next.url, lease.url);
  }
});

test('demo rejects missing, offline, malformed and mismatched call bindings without requesting Storage', async () => {
  const invalid = [
    { audioPath: `${path}-other` }, { audioStorageBucket: 'other-bucket' },
    { uploadedBy: 'other-owner' }, { preparedUploadRequestId: 'other-call' },
    { uploadedBy: undefined }, { preparedUploadRequestId: undefined },
    { demoAudioValidated: false }, { demoAudioValidated: 'true' },
    ...[undefined, null, 1, '', '0', '-1', '1.2', '1e3', ' 1', '01', '1&token=secret', 'NaN']
      .map(audioStorageGeneration => ({ audioStorageGeneration })),
  ];
  for (const callData of invalid) {
    const f = fixture({ demo: true }); f.settings.callData = callData;
    await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'invalid-audio' });
    assert.equal(f.calls.xhr.length, 0); assert.equal(f.calls.legacy.length, 0);
  }
  const f = fixture({ demo: true }); f.settings.callExists = false;
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'not-found' });
  f.settings.firestoreError = { code: 'unavailable', message: 'private-token' };
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'network', message: 'network' });
  assert.equal(f.calls.xhr.length, 0);
  const wrongBucket = fixture({ demo: true, bucket: 'other-bucket' });
  await assert.rejects(wrongBucket.api.acquireAudioPlayback({ audioPath: path }), { code: 'invalid-audio' });
  assert.equal(wrongBucket.calls.xhr.length, 0); assert.equal(wrongBucket.calls.firestore.length, 0);
  for (const audioPath of ['prepared-uploads/user/call', `${path}/extra`, 'prepared-uploads//call/original.mp3']) {
    await assert.rejects(f.api.acquireAudioPlayback({ audioPath }), { code: 'invalid-audio' });
  }
  assert.equal(f.calls.xhr.length, 0);
});

test('demo cached audio still requires valid server bindings and a changed generation downloads again', async () => {
  const f = fixture({ demo: true }); const first = await f.api.acquireAudioPlayback({ audioPath: path }); first.release();
  f.settings.callData = { audioPath: 'other' };
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'invalid-audio' });
  assert.equal(f.calls.xhr.length, 1);
  f.settings.callData = {}; f.settings.generation = '17280000000000001';
  const second = await f.api.acquireAudioPlayback({ audioPath: path });
  assert.notEqual(first.url, second.url); assert.deepEqual(f.calls.revoked, [first.url]);
  assert.match(f.calls.xhr[1].url, /generation=17280000000000001$/);
});

test('demo oversize, empty and non-audio responses release reservations and never cache a Blob', async () => {
  const f = fixture({ demo: true });
  for (let i = 0; i < 6; i++) {
    f.settings.size = demoLimit + 1;
    await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'too-large' });
  }
  f.settings.size = 0;
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'invalid-audio' });
  f.settings.size = 5; f.settings.type = 'text/html';
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'invalid-audio' });
  f.settings.type = 'audio/mpeg'; f.settings.size = demoLimit;
  const lease = await f.api.acquireAudioPlayback({ audioPath: path });
  assert.equal(lease.url, 'blob:audio-1'); assert.equal(f.calls.xhr.length, 9);
});

test('demo media errors and progress oversize release reservations and permission loss purges cache', async () => {
  const f = fixture({ demo: true }); const lease = await f.api.acquireAudioPlayback({ audioPath: path });
  const nextPath = 'prepared-uploads/user/next/original.mp3';
  f.settings.mediaStatus = 403;
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: nextPath }), { code: 'unauthorized' });
  assert.deepEqual(f.calls.revoked, [lease.url]); f.settings.mediaStatus = 200;
  f.settings.hold = 'media';
  for (let i = 0; i < 6; i++) {
    const request = f.api.acquireAudioPlayback({ audioPath: nextPath });
    const rejected = assert.rejects(request, { code: 'too-large' }); await f.flush();
    const xhr = f.calls.xhr.at(-1);
    xhr.onprogress({ loaded: demoLimit + 1, lengthComputable: false }); await rejected;
    assert.equal(xhr.aborted, true);
  }
  f.settings.hold = ''; await f.api.acquireAudioPlayback({ audioPath: nextPath });
});

test('demo reserves 25 MiB per transfer and accounts for actual cached bytes on completion', async () => {
  const f = fixture({ demo: true }); f.settings.hold = 'media';
  const requests = Array.from({ length: 5 }, (_, i) => f.api.acquireAudioPlayback({ audioPath: `prepared-uploads/user/call${i}/original.mp3` }));
  await f.flush();
  await assert.rejects(f.api.acquireAudioPlayback({ audioPath: path }), { code: 'cache-capacity' });
  assert.equal(f.calls.xhr.length, 5);
  for (const xhr of f.calls.xhr) xhr.respond();
  await Promise.all(requests);
  f.settings.hold = '';
  await f.api.acquireAudioPlayback({ audioPath: path });
  assert.equal(f.calls.xhr.length, 6); assert.deepEqual(f.calls.revoked, []);
});

test('demo concurrent callers share a server read and media while preserving independent cancellation', async () => {
  const f = fixture({ demo: true }); f.settings.hold = 'media'; const abort = new AbortController();
  const first = f.api.acquireAudioPlayback({ audioPath: path, signal: abort.signal });
  const rejected = assert.rejects(first, { code: 'aborted' });
  const second = f.api.acquireAudioPlayback({ audioPath: path }); await f.flush();
  abort.abort(); await rejected;
  assert.equal(f.calls.firestore.length, 1); assert.equal(f.calls.xhr.length, 1);
  assert.equal(f.calls.xhr[0].aborted, false);
  f.calls.xhr[0].respond(); assert.match((await second).url, /^blob:/);
});

test('demo last-subscriber cancellation and deadlines bound server reads and reject late results', async () => {
  for (const cancel of [true, false]) {
    const f = fixture({ demo: true }); let finish;
    f.settings.readCall = () => new Promise(resolve => { finish = resolve; });
    const abort = new AbortController();
    const request = f.api.acquireAudioPlayback({ audioPath: path, signal: abort.signal });
    const rejected = assert.rejects(request, { code: cancel ? 'aborted' : 'timeout' });
    await f.flush();
    if (cancel) abort.abort(); else await f.advance(120000);
    await rejected; finish(); await f.flush();
    assert.equal(f.calls.xhr.length, 0);
    f.settings.readCall = null; await f.api.acquireAudioPlayback({ audioPath: path });
  }
});

test('demo stale auth during token, call read or media retrieval never returns playable audio', async () => {
  for (const stage of ['token', 'call', 'media']) {
    for (const observed of [true, false]) {
      const f = fixture({ demo: true }); let finish;
      if (stage === 'token') f.auth.currentUser.getIdToken = () => new Promise(resolve => { finish = () => resolve('private-token'); });
      if (stage === 'call') f.settings.readCall = () => new Promise(resolve => { finish = resolve; });
      if (stage === 'media') f.settings.hold = 'media';
      const request = f.api.acquireAudioPlayback({ audioPath: path });
      const rejected = assert.rejects(request, observed ? { name: 'AbortError' } : { code: 'aborted' }); await f.flush();
      if (observed) f.changeUser(null); else f.auth.currentUser = null;
      if (stage === 'media') f.calls.xhr[0].respond(); else finish();
      await rejected; await f.flush();
      assert.equal(f.calls.xhr.length, stage === 'media' ? 1 : 0);
    }
  }
});

test('demo emulator media uses the configured endpoint and non-prepared legacy paths remain unchanged', async () => {
  const f = fixture({ demo: true, emulator: true });
  await f.api.acquireAudioPlayback({ audioPath: path });
  assert.match(f.calls.xhr[0].url, /^http:\/\/localhost:9199\/v0\/b\//); assert.equal(f.calls.xhr[0].media, true);
  const legacy = await f.api.acquireAudioPlayback({ audioPath: 'audio/unknown/legacy.mp3' });
  assert.equal(legacy.url, 'https://legacy.invalid/existing'); assert.equal(f.calls.xhr[1].media, false);
  assert.equal(f.calls.firestore.length, 1);
});
