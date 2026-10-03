jest.mock('../services/firebaseStorage', /** Prevents Firebase initialization. */ () => ({ storage: {} }));
jest.mock('../services/firebaseFirestore', /** Prevents Firestore initialization. */ () => ({ db: {} }));
jest.mock('../services/firebaseApp', () => ({ firebaseProjectId: 'kesp-demo-tonylai2789', isDemoFirebaseProject: true }));
jest.mock('../services/functions', () => ({ prepareConsubancoTranscriptionUpload: jest.fn(async () => ({
  callId: 'test-call', storagePath: 'prepared-uploads/user/test-call/call.mp3',
})) }));
jest.mock('firebase/firestore', /** Provides client-side document IDs without network access. */ () => ({
  collection: jest.fn(), doc: jest.fn(/** Returns a deterministic upload ID. */ () => ({ id: 'test-call' })),
}));
jest.mock('firebase/storage', /** Captures Storage metadata without uploading audio. */ () => ({
  ref: jest.fn(), deleteObject: jest.fn(), getDownloadURL: jest.fn(/** Resolves the mock upload. */ async () => 'https://example.invalid/audio'),
  uploadBytesResumable: jest.fn(/** Completes the fake Storage task. */ () => ({
    snapshot: { ref: {} }, on: /** Invokes only the completion callback. */ (_event, _progress, _error, complete) => complete(),
  })),
}));

const { uploadAudioFile } = require('../services/storage');
const { uploadBytesResumable } = require('firebase/storage');
const { prepareConsubancoTranscriptionUpload } = require('../services/functions');

beforeEach(() => {
  global.crypto = require('node:crypto').webcrypto;
  global.window = { setTimeout, clearTimeout };
  global.document = { createElement: () => ({ duration: 120, removeAttribute() {}, load() {},
    set src(_value) { queueMicrotask(() => this.onloadedmetadata?.()); },
  }) };
  jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-test');
  jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { delete global.window; delete global.document; jest.restoreAllMocks(); });

test.each([undefined, {}, { coaching: 'gpt-4o-mini', core_fields: 'gpt-5.4' }])('reserves only explicit upload overrides: %p', async (analyzerModelOverrides) => {
  const file = { name: 'call.mp3', size: 4, type: 'audio/mpeg', arrayBuffer: async () => new ArrayBuffer(4) };
  await uploadAudioFile({ file, userId: 'user', analyzerModel: 'gpt-5.4', analyzerModelOverrides, promptVersions: { coaching: '2' } });
  const metadata = prepareConsubancoTranscriptionUpload.mock.calls.at(-1)[0];
  expect(metadata.analyzerModel).toBe('gpt-5.4');
  expect(metadata.promptVersions).toEqual({ coaching: '2' });
  expect(metadata.analyzerModelOverrides).toEqual(analyzerModelOverrides);
  expect(metadata.transcriptionModel).toBe('scribe_v2');
  expect(uploadBytesResumable.mock.calls.at(-1)[2].customMetadata).toBeUndefined();
  expect(metadata.analyzerModelsByTaskId).toBeUndefined();
});
