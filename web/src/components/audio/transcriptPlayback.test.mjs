import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

/** Loads pure TypeScript helpers using the repository's existing frontend test convention. */
function load(name, modules = {}, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, AbortController, ...globals,
    require: /** Fails tests on unexpected external dependencies. */ (id) => { assert.ok(id in modules, id); return modules[id]; },
  });
  return exports;
}
const helpers = load('./transcriptPlayback.ts');
const { segmentPlaybackInterval: interval, transcriptEvidenceIndices: evidence } = helpers;
const segments = [{ start: 1.123, end: 6.789 }, { start: 8.234, end: 12 }, { start: 11, end: 15 }];

test('uses precise next start including silence, preserves overlap and final end', () => {
  assert.equal(interval(segments, 0).start, 1.123);
  assert.equal(interval(segments, 0).end, 8.234);
  assert.equal(interval(segments, 0).includesPause, true);
  assert.equal(interval(segments, 1).end, 12);
  assert.equal(interval(segments, 1).includesPause, false);
  assert.equal(interval(segments, 2).end, 15);
  assert.equal(interval(segments, 2, 14).end, 14);
  assert.equal(interval(segments, 2, 10), null);
});
test('invalid intervals are disabled without poisoning valid excluded-metric speech', () => {
  for (const segment of [{ start: NaN, end: 3 }, { start: 1, end: Infinity }, { start: 3, end: 2 },
    { start: 2, end: 2 }, { start: -1, end: 2 }, { end: 2 }]) assert.equal(interval([segment], 0), null);
  assert.equal(interval([{ start: 0, end: 5, timingExcluded: true }], 0).end, 5);
  assert.equal(interval([{ start: 0, end: 5 }, { start: NaN, end: 20 }], 0).end, 5);
});
test('evidence matches by overlap and highlights both sides of a pause without IDs', () => {
  assert.deepEqual([...evidence(segments, { start: 2, end: 4, id: 'unrelated' })], [0]);
  assert.deepEqual([...evidence(segments, { start: 6.789, end: 8.234 })], [0, 1]);
  assert.deepEqual([...evidence(segments, { start: 11.5, end: 11.8 })], [1, 2]);
  assert.deepEqual([...evidence(segments, { start: NaN, end: 1 })], []);
});

/** Runs the real hook with deterministic media and React lifecycle boundaries. */
function harness(acquireOverride) {
  let state;
  let cleanup;
  let invalidation;
  let released = 0;
  let acquired = 0;
  const timers = new Map();
  const instances = [];
  class FakeAudio {
    currentTime = 0; duration = 20; readyState = 0; paused = true; playbackRate = 1; listeners = new Map(); plays = 0;
    constructor() { instances.push(this); }
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    emit(name) { for (const fn of this.listeners.get(name) ?? []) fn(); }
    load() { this.readyState = this.src ? 1 : 0; if (this.src) this.emit('loadedmetadata'); }
    removeAttribute() { this.src = ''; }
    remove() { this.removed = true; }
    pause() { this.paused = true; this.emit('pause'); }
    async play() { this.paused = false; this.plays++; this.emit('play'); }
  }
  const lease = { url: 'blob:private-test', release: () => { released++; } };
  const service = {
    acquireAudioPlayback: (options) => { acquired++; return acquireOverride ? acquireOverride(options, lease) : Promise.resolve(lease); },
    subscribeAudioPlaybackInvalidation: (fn) => { invalidation = fn; return () => { invalidation = undefined; }; },
  };
  const { useCallAudioPlayback } = load('./useCallAudioPlayback.ts', {
    react: {
      useRef: (initial) => ({ current: initial }),
      useState: (initial) => { state ??= initial; return [state, (value) => { state = typeof value === 'function' ? value(state) : value; }]; },
      useCallback: (callback) => callback,
      useEffect: (effect) => { cleanup = effect(); },
    },
    '@/services/audioPlayback': service,
  }, { Audio: FakeAudio,
    setTimeout: (fn) => { const id = Symbol(); timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id),
  });
  const controls = useCallAudioPlayback('prepared-uploads/test/sample.mp3');
  return { controls, audio: instances[0], state: () => state, acquired: () => acquired, released: () => released,
    cleanup: () => cleanup(), invalidate: () => invalidation(), timers };
}
/** Flushes nested acquisition, metadata, and media-play promises. */
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('one player downloads once, resumes, stops at endpoint and replays after completion', async () => {
  const h = harness();
  h.controls.toggle('0', interval(segments, 0)); await settle();
  assert.equal(h.acquired(), 1); assert.equal(h.audio.currentTime, 1.123); assert.equal(h.audio.paused, false);
  h.audio.currentTime = 3; h.controls.toggle('0', interval(segments, 0)); assert.equal(h.audio.paused, true);
  h.controls.toggle('0', interval(segments, 0)); await settle(); assert.equal(h.audio.currentTime, 3);
  h.audio.currentTime = 8.3; h.audio.emit('timeupdate');
  assert.equal(h.audio.paused, true); assert.equal(h.audio.currentTime, 8.234);
  h.controls.toggle('0', interval(segments, 0)); await settle(); assert.equal(h.audio.currentTime, 1.123);
  h.controls.toggle('1', interval(segments, 1)); await settle(); assert.equal(h.audio.currentTime, 8.234);
  assert.equal(h.acquired(), 1); h.cleanup(); assert.equal(h.released(), 1); assert.equal(h.audio.paused, true);
});
test('rapid selection shares acquisition and cannot autoplay a stale segment', async () => {
  let resolve;
  const h = harness((_options, lease) => new Promise((done) => { resolve = () => done(lease); }));
  h.controls.toggle('0', interval(segments, 0));
  h.controls.toggle('1', interval(segments, 1));
  assert.equal(h.acquired(), 1); resolve(); await settle();
  assert.equal(h.audio.plays, 1); assert.equal(h.audio.currentTime, 8.234);
  h.cleanup();
});
test('cancel and tab exit abort pending work and suppress late completion', async () => {
  let resolve; let signal;
  const h = harness((options, lease) => { signal = options.signal; return new Promise((done) => { resolve = () => done(lease); }); });
  h.controls.toggle('0', interval(segments, 0)); h.cleanup();
  assert.equal(signal.aborted, true); resolve(); await settle();
  assert.equal(h.audio.plays, 0); assert.equal(h.released(), 1);
});
test('access invalidation immediately stops, resets, and releases cached audio', async () => {
  const h = harness(); h.controls.toggle('full', null); await settle();
  assert.equal(h.audio.currentTime, 0); assert.equal(h.state().duration, 20);
  h.invalidate(); assert.equal(h.audio.paused, true); assert.equal(h.audio.src, '');
  assert.equal(h.released(), 1); assert.equal(h.state().selectedKey, null); h.cleanup();
});
test('attaches exactly the shared hidden media element to each current transcript host', () => {
  const h = harness();
  const first = []; const second = [];
  h.controls.attachAudioHost({ appendChild: (element) => first.push(element) });
  assert.equal(first[0], h.audio); assert.equal(h.audio.hidden, true);
  h.controls.attachAudioHost(null);
  h.controls.attachAudioHost({ appendChild: (element) => second.push(element) });
  assert.equal(second[0], h.audio);
  h.cleanup(); assert.equal(h.audio.removed, true);
});
test('download errors display safe codes and explicit retry succeeds', async () => {
  let attempts = 0;
  const h = harness((_options, lease) => ++attempts === 1 ? Promise.reject({ code: 'timeout', message: 'secret url' }) : Promise.resolve(lease));
  h.controls.toggle('0', interval(segments, 0)); await settle();
  assert.equal(h.state().error, 'timeout'); assert.equal(h.state().loading, false);
  h.controls.toggle('0', interval(segments, 0)); await settle();
  assert.equal(h.audio.paused, false); assert.equal(h.acquired(), 2); assert.equal(h.state().error, null);
  assert.equal(h.audio.currentTime, 1.123); h.cleanup();
});
