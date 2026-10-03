import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { finalizePreparedTranscriptionUpload, PreparedUploadRejection } from '../preparedTranscriptionUpload';
import { DEMO_STORAGE_BUCKET, validateDemoAudioFile } from '../demoBudget';
import { onAudioUpload } from '../triggers';

jest.mock('firebase-admin', () => ({
  app: () => ({ options: { projectId: 'kesp-demo-tonylai2789' } }), firestore: jest.fn(), storage: jest.fn(),
}));
jest.mock('fs', () => ({ ...jest.requireActual('fs'), mkdtempSync: () => '/mock/demo-audio' }));
jest.mock('../ffmpeg', () => ({ getAudioDuration: jest.fn(), cleanupTmpDir: jest.fn() }));
jest.mock('../demoBudget', () => ({ ...jest.requireActual('../demoBudget'), validateDemoAudioFile: jest.fn() }));
jest.mock('../demoHttps', () => ({
  onPaidCall: (_options: unknown, handler: unknown) => handler,
  HttpsError: jest.requireActual('firebase-functions/v2/https').HttpsError,
  onCall: (_options: unknown, handler: unknown) => handler,
}));
jest.mock('../cccAutomaticWorkflowMonitor', () => ({}));
jest.mock('../demoSeedAuthorization', () => ({}));
jest.mock('../demoReconstructionAuthorization', () => ({}));
jest.mock('firebase-functions/v2/storage', () => ({ onObjectFinalized: (options: unknown, run: unknown) => ({ options, run }) }));
jest.mock('firebase-functions/v2/firestore', () => ({ onDocumentCreated: jest.fn(), onDocumentUpdated: jest.fn() }));
jest.mock('../analysisSubagents', () => ({}));
jest.mock('../manualShortCallReview', () => ({}));
jest.mock('../agentAnalyses', () => ({}));
jest.mock('../runtimeRetry', () => ({}));
jest.mock('../callState', () => ({}));
jest.mock('../cccPipelinePause', () => ({}));

const bytes = Buffer.from('fictional-audio-fixture');
const name = 'prepared-uploads/owner/call/fictional.wav';
const event = { name, bucket: DEMO_STORAGE_BUCKET, size: bytes.length, contentType: 'audio/wav', generation: '123', timeCreated: '2026-10-01T00:00:00Z' };
let record: FirebaseFirestore.DocumentData | undefined;
const setMetadata = jest.fn();
const createReadStream = jest.fn();
const download = jest.fn();
const file = jest.fn();
const bucket = jest.fn();
const get = jest.fn();
const update = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GCLOUD_PROJECT = 'kesp-demo-tonylai2789';
  record = { ownerUid: 'owner', callId: 'call', originalFilename: 'fictional.wav', storagePath: name,
    bucket: DEMO_STORAGE_BUCKET, sizeBytes: bytes.length, contentType: 'audio/wav', status: 'prepared',
    expiresAt: { toMillis: () => Date.parse(event.timeCreated) + 60_000 },
    audioSha256: createHash('sha256').update(bytes).digest('hex') };
  setMetadata.mockResolvedValue(undefined);
  createReadStream.mockImplementation(() => Readable.from([bytes]));
  download.mockResolvedValue(undefined);
  file.mockReturnValue({ setMetadata, createReadStream, download });
  bucket.mockReturnValue({ file });
  get.mockImplementation(async () => ({ data: () => record }));
  update.mockResolvedValue(undefined);
  (admin.storage as unknown as jest.Mock).mockReturnValue({ bucket });
  (admin.firestore as unknown as jest.Mock).mockReturnValue({ collection: () => ({ doc: () => ({ get, update }) }) });
  jest.mocked(validateDemoAudioFile).mockRejectedValue(Object.assign(new Error('Invalid demo audio'), { code: 'demo_audio_limit' }));
});

function expectStripped(): void {
  expect(bucket).toHaveBeenCalledWith(DEMO_STORAGE_BUCKET);
  expect(file).toHaveBeenCalledWith(name, { generation: '123' });
  expect(setMetadata).toHaveBeenCalledWith({ metadata: { firebaseStorageDownloadTokens: null } });
  expect(setMetadata.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
}

test.each(['hash', 'probe'])('removes tokens before %s rejection', async (failure) => {
  if (failure === 'hash') record!.audioSha256 = '0'.repeat(64);
  await expect(finalizePreparedTranscriptionUpload(event)).rejects.toBeInstanceOf(PreparedUploadRejection);
  expectStripped();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
});

test.each(['rejected', 'expired', 'missing', 'wrong-owner', 'size', 'malformed-expiry'])('strips tokens for %s authorization', async (failure) => {
  if (failure === 'rejected') record!.status = 'rejected';
  if (failure === 'expired') record!.expiresAt = { toMillis: () => 0 };
  if (failure === 'missing') record = undefined;
  if (failure === 'wrong-owner') record!.ownerUid = 'another-owner';
  if (failure === 'size') record!.sizeBytes = 1;
  if (failure === 'malformed-expiry') record!.expiresAt = null;
  await expect(finalizePreparedTranscriptionUpload(event)).rejects.toBeInstanceOf(PreparedUploadRejection);
  expectStripped();
  expect(createReadStream).not.toHaveBeenCalled();
});

test('consumed redelivery still strips tokens without consuming or probing again', async () => {
  record!.status = 'consumed';
  await finalizePreparedTranscriptionUpload(event);
  expectStripped();
  expect(createReadStream).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

test('valid upload retains the existing consume/create transaction after token removal', async () => {
  record!.callFields = {};
  jest.mocked(validateDemoAudioFile).mockResolvedValue(30);
  const requestRef = { get, update };
  const callRef = {};
  const create = jest.fn();
  (admin.firestore as unknown as jest.Mock).mockReturnValue({
    collection: (collection: string) => ({ doc: () => collection === 'calls' ? callRef : requestRef }),
    runTransaction: async (fn: (transaction: unknown) => Promise<void>) => fn({
      get: async (ref: unknown) => ref === requestRef ? { data: () => record } : { exists: false },
      create, update,
    }),
  });
  await finalizePreparedTranscriptionUpload(event);
  expectStripped();
  expect(create).toHaveBeenCalledWith(callRef, expect.objectContaining({ status: 'uploaded', audioStorageGeneration: '123', demoAudioValidated: true }));
  expect(update).toHaveBeenCalledWith(requestRef, expect.objectContaining({ status: 'consumed' }));
});

test.each(['prepared-uploads/incomplete', 'prepared-uploads//call/fictional.wav'])('strips exact malformed object %s before path rejection', async (malformed) => {
  await expect(finalizePreparedTranscriptionUpload({ ...event, name: malformed })).rejects.toThrow('Invalid prepared upload path');
  expect(file).toHaveBeenCalledWith(malformed, { generation: '123' });
  expect(setMetadata).toHaveBeenCalledTimes(1);
  expect(get).not.toHaveBeenCalled();
});

test('cleanup failure aborts before authorization reads or processing', async () => {
  setMetadata.mockRejectedValueOnce(new Error('metadata unavailable'));
  await expect(finalizePreparedTranscriptionUpload(event)).rejects.toThrow('metadata unavailable');
  expect(get).not.toHaveBeenCalled();
  expect(createReadStream).not.toHaveBeenCalled();
});

test('never targets a foreign bucket, unrelated prefix or unpinned generation', async () => {
  await expect(finalizePreparedTranscriptionUpload({ ...event, bucket: 'unrelated-bucket' })).rejects.toThrow();
  await expect(finalizePreparedTranscriptionUpload({ ...event, name: 'unrelated/fictional.wav' })).rejects.toBeInstanceOf(PreparedUploadRejection);
  for (const generation of [undefined, '', 0, '0', '001', '9007199254740993', 'not-a-generation']) {
    await expect(finalizePreparedTranscriptionUpload({ ...event, generation })).rejects.toThrow('immutable upload generation');
  }
  expect(bucket).not.toHaveBeenCalled();
});

/** In-memory call creation and reservation consumption; no provider or cloud access. */
function finalizationStore() {
  record!.callFields = {};
  const requestRef = { get, update };
  const callRef = {};
  const create = jest.fn();
  const runTransaction = jest.fn(async (fn) => fn({
    get: async (ref: unknown) => ref === requestRef ? { data: () => record } : { exists: create.mock.calls.length > 0 },
    create,
    update: (_ref: unknown, fields: FirebaseFirestore.DocumentData) => { Object.assign(record!, fields); },
  }));
  update.mockImplementation(async (fields) => { Object.assign(record!, fields); });
  (admin.firestore as unknown as jest.Mock).mockReturnValue({
    collection: (collection: string) => ({ doc: () => collection === 'calls' ? callRef : requestRef }), runTransaction,
  });
  return { create, runTransaction };
}

function deliver(data: Partial<typeof event> = {}) {
  return onAudioUpload.run({ data: { ...event, ...data } } as never);
}

test('storage trigger enables retry and cleanup failure redelivers before any call creation', async () => {
  expect(onAudioUpload).toHaveProperty('options.retry', true);
  const store = finalizationStore();
  jest.mocked(validateDemoAudioFile).mockResolvedValue(30);
  setMetadata.mockRejectedValueOnce(new Error('temporary metadata failure'));
  await expect(deliver()).rejects.toThrow('temporary metadata failure');
  expect(get).not.toHaveBeenCalled();
  expect(store.create).not.toHaveBeenCalled();
  await deliver();
  await deliver();
  expect(store.create).toHaveBeenCalledTimes(1);
  expect(record!.status).toBe('consumed');
  expect(setMetadata).toHaveBeenCalledTimes(3);
});

test.each(['missing-generation', 'malformed-path', 'missing-auth', 'rejected', 'expired', 'malformed-expiry', 'hash', 'probe'])('acks permanent %s without creating a processing call', async (failure) => {
  const store = finalizationStore();
  if (failure === 'missing-auth') record = undefined;
  if (failure === 'rejected') record!.status = 'rejected';
  if (failure === 'expired') record!.expiresAt = { toMillis: () => 0 };
  if (failure === 'malformed-expiry') record!.expiresAt = null;
  if (failure === 'hash') record!.audioSha256 = '0'.repeat(64);
  const data = failure === 'missing-generation' ? { generation: undefined } : failure === 'malformed-path' ? { name: 'prepared-uploads/invalid' } : {};
  await expect(deliver(data)).resolves.toBeUndefined();
  expect(store.create).not.toHaveBeenCalled();
  expect(store.runTransaction).not.toHaveBeenCalled();
});

test('missing path is a typed rejection and the trigger ignores unrelated events', async () => {
  await expect(finalizePreparedTranscriptionUpload({ ...event, name: undefined })).rejects.toBeInstanceOf(PreparedUploadRejection);
  await deliver({ name: undefined });
  await deliver({ name: 'unrelated/audio.wav' });
  await deliver({ bucket: 'unrelated-bucket' });
  expect(setMetadata).not.toHaveBeenCalled();
});

test('download failure remains prepared and redelivery may complete', async () => {
  const store = finalizationStore();
  jest.mocked(validateDemoAudioFile).mockResolvedValue(30);
  download.mockRejectedValueOnce(new Error('network reset'));
  await expect(deliver()).rejects.toThrow('network reset');
  expect(record!.status).toBe('prepared');
  expect(update).not.toHaveBeenCalled();
  expect(validateDemoAudioFile).not.toHaveBeenCalled();
  expect(store.create).not.toHaveBeenCalled();
  await deliver();
  expect(store.create).toHaveBeenCalledTimes(1);
});

test.each(['ffprobe failed: Invalid data', 'Invalid duration from ffprobe: NaN'])('acks deterministic probe failure: %s', async (message) => {
  const store = finalizationStore();
  jest.mocked(validateDemoAudioFile).mockRejectedValueOnce(new Error(message));
  await deliver();
  expect(record!.status).toBe('rejected');
  expect(store.create).not.toHaveBeenCalled();
});

test('unexpected probe failure propagates without permanently rejecting audio', async () => {
  const store = finalizationStore();
  jest.mocked(validateDemoAudioFile).mockRejectedValueOnce(new Error('FFprobe timeout after 30000ms'));
  await expect(deliver()).rejects.toThrow('FFprobe timeout');
  expect(record!.status).toBe('prepared');
  expect(update).not.toHaveBeenCalled();
  expect(store.create).not.toHaveBeenCalled();
});

test('authorization read and final transaction failures propagate for retry', async () => {
  const store = finalizationStore();
  jest.mocked(validateDemoAudioFile).mockResolvedValue(30);
  get.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(deliver()).rejects.toThrow('database unavailable');
  store.runTransaction.mockRejectedValueOnce(new Error('transaction unavailable'));
  await expect(deliver()).rejects.toThrow('transaction unavailable');
  expect(store.create).not.toHaveBeenCalled();
  expect(record!.status).toBe('prepared');
  await deliver();
  expect(store.create).toHaveBeenCalledTimes(1);
});

test('permanent rejection waits for successful token cleanup, even for an expired request', async () => {
  const store = finalizationStore();
  record!.expiresAt = { toMillis: () => 0 };
  setMetadata.mockRejectedValueOnce(new Error('metadata temporarily unavailable'));
  await expect(deliver()).rejects.toThrow('metadata temporarily unavailable');
  await expect(deliver()).resolves.toBeUndefined();
  expect(setMetadata).toHaveBeenCalledTimes(2);
  expect(store.create).not.toHaveBeenCalled();
});
