import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as demoPolicy from '../lib/demoPolicy.ts';

const source = ts.transpileModule(readFileSync(new URL('./storage.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** Exercise the actual frontend upload service with Firebase replaced by in-memory boundaries. */
function fixture(projectId = demoPolicy.DEMO_PROJECT_ID, preparationError, duration = 180) {
  const calls = { prepare: [], upload: [], download: [], blob: [] };
  const modules = {
    'firebase/storage': {
      ref: /** Keep private paths visible in assertions. */ (_storage, path) => ({ path }),
      uploadBytesResumable: /** Complete a fake upload without network or production writes. */ (ref, file, metadata) => {
        calls.upload.push({ ref, file, metadata });
        return { snapshot: { ref }, on: /** Deliver the completion event asynchronously. */ (_event, _progress, _error, complete) => queueMicrotask(complete) };
      },
      getDownloadURL: /** Track every token URL request. */ async (ref) => { calls.download.push(ref); return 'https://legacy.invalid/audio'; },
      getBlob: /** Simulate authenticated playback. */ async (ref, limit) => { calls.blob.push({ ref, limit }); return new Blob(['audio']); },
    },
    'firebase/firestore': {
      collection: /** Stub local call ID generation. */ () => ({}),
      doc: /** Generate the legacy-only client ID. */ () => ({ id: 'legacy-call' }),
    },
    './firebaseStorage': { storage: {} },
    './firebaseFirestore': { db: {} },
    './firebaseApp': { isDemoFirebaseProject: projectId === demoPolicy.DEMO_PROJECT_ID },
    '@/lib/demoPolicy': demoPolicy,
    '@/lib/transcriptionUpload': { DEFAULT_TRANSCRIPTION_MODEL: 'scribe_v2' },
    './functions': {
      prepareConsubancoTranscriptionUpload: /** Capture the exact backend contract before any upload. */ async (input) => {
        calls.prepare.push(input);
        if (preparationError) throw preparationError;
        return { callId: 'prepared-call', storagePath: 'prepared-uploads/user-1/prepared-call/sample.wav' };
      },
    },
  };
  const exports = {};
  runInNewContext(source, {
    exports, require: /** Resolve only explicitly mocked dependencies. */ (name) => {
      assert.ok(name in modules, `Unexpected dependency: ${name}`);
      return modules[name];
    },
    crypto: webcrypto, Uint8Array, console,
    window: { setTimeout, clearTimeout },
    document: { createElement: () => ({ duration, removeAttribute() {}, load() {}, set src(_url) { queueMicrotask(() => this.onloadedmetadata?.()); } }) },
    URL: { createObjectURL: /** Never create a public audio URL. */ () => 'blob:private-audio', revokeObjectURL: () => {} },
  });
  const file = { name: 'sample.wav', size: 5, type: 'audio/wav',
    arrayBuffer: /** Hash the exact synthetic bytes supplied to upload. */ async () => Uint8Array.from(Buffer.from('audio')).buffer };
  return { service: exports, calls, file };
}

for (const model of ['gpt-4o-transcribe-diarize', 'scribe_v2']) {
  test(`prepared ${model} upload uses private reservation and no metadata/token URL`, /** Verify both explicit TEST choices. */ async () => {
    const { service, calls, file } = fixture();
    const result = await service.uploadAudioFile({ file, userId: 'user-1', transcriptionModel: model,
      transcriptionComparison: true, analyzerModel: 'gpt-4o-mini', analyzerModelOverrides: { coaching: 'gpt-6-astra' }, promptVersions: { coaching: 'v2' },
      activityPromptVersions: { summary: 'v1' }, salesAgentId: 'demo_agent_1', salesAgentName: 'Agent',
      agentAnalysisId: 'demo_agent_1', agentRoutingMode: 'specific', uploadBatchId: 'batch-1' });
    assert.equal(calls.prepare.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.prepare[0])), {
      originalFilename: 'sample.wav', sizeBytes: 5, contentType: 'audio/wav',
      audioSha256: createHash('sha256').update('audio').digest('hex'), transcriptionModel: model, comparison: true,
      analyzerModel: 'gpt-4o-mini', analyzerModelOverrides: { coaching: 'gpt-6-astra' }, promptVersions: { coaching: 'v2' }, activityPromptVersions: { summary: 'v1' },
      agentId: 'demo_agent_1', agentName: 'Agent', agentAnalysisId: 'demo_agent_1', agentRoutingMode: 'specific', batchId: 'batch-1',
    });
    assert.equal(calls.upload.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.upload[0].metadata)), { contentType: 'audio/wav' });
    assert.equal(result.path, 'prepared-uploads/user-1/prepared-call/sample.wav');
    assert.equal(result.downloadUrl, '');
    assert.equal(calls.download.length, 0);
  });
}

test('preparation rejection never falls back to legacy upload', /** Preserve backend authorization failures. */ async () => {
  const { service, calls, file } = fixture(demoPolicy.DEMO_PROJECT_ID, new Error('permission-denied'));
  await assert.rejects(service.uploadAudioFile({ file, userId: 'user-1', transcriptionModel: 'scribe_v2' }), /permission-denied/);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.download.length, 0);
});

test('hash failure aborts preparation and upload', /** Fail closed instead of omitting the required integrity field. */ async () => {
  const { service, calls, file } = fixture();
  file.arrayBuffer = /** Simulate unreadable file bytes. */ async () => { throw new Error('file-read-failed'); };
  await assert.rejects(service.uploadAudioFile({ file, userId: 'user-1', transcriptionModel: 'scribe_v2' }), /file-read-failed/);
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.upload.length, 0);
});

test('production identities cannot reserve or upload in this demo client', async () => {
  const { service, calls, file } = fixture('sales-banking-agent');
  await assert.rejects(service.uploadAudioFile({ file, userId: 'user-1', transcriptionModel: 'scribe_v2' }), /KESP session/);
  assert.equal(calls.prepare.length, 0); assert.equal(calls.upload.length, 0);
});

test('unknown projects reject selected uploads before preparation', /** Fail closed outside supported KESP projects. */ async () => {
  const { service, calls, file } = fixture('unknown-project');
  await assert.rejects(service.uploadAudioFile({ file, userId: 'user-1', transcriptionModel: 'scribe_v2' }), /KESP session/);
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.upload.length, 0);
});

test('default uploads use a private Scribe reservation, never the legacy path', async () => {
  const { service, calls, file } = fixture();
  const result = await service.uploadAudioFile({ file, userId: 'user-1' });
  assert.equal(calls.prepare.length, 1); assert.equal(calls.prepare[0].transcriptionModel, 'scribe_v2');
  assert.equal(calls.upload.length, 1); assert.equal(calls.download.length, 0); assert.equal(result.downloadUrl, '');
});

for (const duration of [300.01, NaN, Infinity, 0]) {
  test('invalid duration ' + duration + ' rejects before reservation', async () => {
    const { service, calls, file } = fixture(demoPolicy.DEMO_PROJECT_ID, undefined, duration);
    await assert.rejects(service.uploadAudioFile({ file, userId: 'user-1' }));
    assert.equal(calls.prepare.length, 0); assert.equal(calls.upload.length, 0);
  });
}
test('oversize and empty files reject before reservation', async () => {
  for (const size of [0, 25*1024*1024+1]) {
    const { service, calls, file } = fixture(); file.size = size;
    await assert.rejects(service.uploadAudioFile({ file, userId: 'user-1' }));
    assert.equal(calls.prepare.length, 0); assert.equal(calls.upload.length, 0);
  }
});

test('private prepared playback uses authenticated blobs, never token URLs', /** Preserve the scribe-smoke playback contract. */ async () => {
  const { service, calls } = fixture();
  assert.equal(await service.getAudioDownloadUrl('prepared-uploads/user-1/prepared-call/sample.wav'), 'blob:private-audio');
  assert.equal(calls.blob[0].limit, 100 * 1024 * 1024);
  assert.equal(calls.download.length, 0);
});
