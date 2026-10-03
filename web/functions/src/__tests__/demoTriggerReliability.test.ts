import * as admin from 'firebase-admin';
import { getFunctions } from 'firebase-admin/functions';
import { Timestamp } from 'firebase-admin/firestore';
import { onCallCreated, onStartAnalyzing } from '../triggers';
import { acquireDemoCallSlot, releaseDemoCallSlot } from '../demoBudget';
import { dispatchSubagentTasks } from '../analysisSubagents';
import { dispatchManualShortCallReview } from '../manualShortCallReview';
import { DEMO_BUCKET } from '../demoConfig';

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: (options: unknown, run: unknown) => ({ options, run }),
  onDocumentUpdated: (options: unknown, run: unknown) => ({ options, run }),
}));
jest.mock('firebase-functions/v2/storage', () => ({ onObjectFinalized: jest.fn() }));
jest.mock('firebase-admin/functions', () => ({ getFunctions: jest.fn() }));
jest.mock('../analysisSubagents', () => ({ dispatchSubagentTasks: jest.fn() }));
jest.mock('../manualShortCallReview', () => ({ MANUAL_SHORT_CALL_ANALYSIS_PIPELINE: 'short', dispatchManualShortCallReview: jest.fn() }));
jest.mock('../agentAnalyses', () => ({}));
jest.mock('../secrets', () => ({}));
jest.mock('../promptConfig', () => ({}));
jest.mock('../demoBudget', () => ({ acquireDemoCallSlot: jest.fn(), releaseDemoCallSlot: jest.fn() }));
jest.mock('../preparedTranscriptionUpload', () => ({}));
jest.mock('../callCategory', () => ({}));
jest.mock('../callState', () => ({
  getProcessingGeneration: (data?: FirebaseFirestore.DocumentData) => data?.processingGeneration ?? 0,
  buildCallErrorUpdate: (error: { message: string }) => ({ error: error.message }),
}));
jest.mock('../cccPipelinePause', () => ({ shouldHoldAutomaticCccCall: async () => false }));
jest.mock('../runtimeRetry', () => ({ markAutomaticRuntimeRetryComplete: jest.fn(), recordRuntimeFailureForDelayedRetry: jest.fn() }));

// Install the store before triggers.ts captures admin.firestore() at module load.
jest.mock('firebase-admin', () => {
  const ref = { get: jest.fn(), update: jest.fn() };
  const db = { collection: () => ({ doc: () => ref }), runTransaction: jest.fn() };
  return { firestore: () => db };
});

let current: FirebaseFirestore.DocumentData;
const db = admin.firestore();
const ref = db.collection('calls').doc('call');
const enqueue = jest.fn();
const accepted = new Set<string>();
const dispatched = jest.mocked(dispatchSubagentTasks);

function event(before: string, after: string, generation = 0) {
  const data = { ...current, status: after, processingGeneration: generation };
  return { params: { callId: 'call' }, data: { before: { data: () => ({ ...data, status: before }) }, after: { data: () => data } } };
}
async function updated(before: string, after: string, generation = 0) {
  return onStartAnalyzing.run(event(before, after, generation) as never);
}
async function created(generation = 0) {
  const data = { ...current, status: 'uploaded', processingGeneration: generation };
  return onCallCreated.run({ params: { callId: 'call' }, data: { data: () => data } } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  accepted.clear();
  current = { status: 'uploaded', processingGeneration: 0, audioPath: 'prepared-uploads/u/c/demo.wav',
    callSource: 'manual_upload', organizationId: 'consubanco', visibilityScope: 'organization',
    preparedUploadRequestId: 'call', audioStorageBucket: DEMO_BUCKET };
  (ref.get as jest.Mock).mockImplementation(async () => ({ data: () => ({ ...current }) }));
  // Serialize transactions like Firestore, including concurrent event deliveries.
  let tail = Promise.resolve();
  (db.runTransaction as jest.Mock).mockImplementation((fn) => {
    const result = tail.then(() => fn({ get: ref.get, update: (_ref: unknown, fields: FirebaseFirestore.DocumentData) => {
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'demoAnalysisDispatch.status') current.demoAnalysisDispatch.status = value;
        else current[key] = value;
      }
    } }));
    tail = result.then(() => undefined, () => undefined);
    return result;
  });
  (getFunctions as jest.Mock).mockReturnValue({ taskQueue: () => ({ enqueue }) });
  enqueue.mockImplementation(async (_payload, options) => {
    if (accepted.has(options.id)) throw { code: 'functions/task-already-exists' };
    accepted.add(options.id);
  });
  dispatched.mockResolvedValue(undefined);
  jest.mocked(dispatchManualShortCallReview).mockResolvedValue(undefined);
  jest.mocked(acquireDemoCallSlot).mockResolvedValue(undefined);
  jest.mocked(releaseDemoCallSlot).mockResolvedValue(undefined);
});

test('only guarded lifecycle triggers enable event retries', () => {
  expect(onCallCreated).toHaveProperty('options.retry', true);
  expect(onStartAnalyzing).toHaveProperty('options.retry', true);
});

test('enqueue failure retries the same generation-bound task', async () => {
  enqueue.mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(created()).rejects.toThrow('queue unavailable');
  await created();
  await created();
  expect(accepted.size).toBe(1);
  expect(enqueue).toHaveBeenLastCalledWith({ callId: 'call', demoAdmissionGeneration: 0 }, {
    id: 'demo-transcribe-call-0', dispatchDeadlineSeconds: 1800,
  });
});

test('lost enqueue acknowledgement cannot create a second task', async () => {
  enqueue.mockImplementationOnce(async (_payload, options) => { accepted.add(options.id); throw new Error('lost ack'); });
  await expect(created()).rejects.toThrow('lost ack');
  await created();
  expect(accepted.size).toBe(1);
});

test('concurrent create/update deliveries enqueue one task; new generations get new IDs', async () => {
  await Promise.all([created(), updated('error', 'uploaded')]);
  expect(accepted.size).toBe(1);
  current.processingGeneration = 1;
  await updated('error', 'uploaded', 1);
  expect(accepted.size).toBe(2);
});

test('stale and terminal transcription events cannot enqueue work', async () => {
  current.processingGeneration = 1;
  await created(0);
  current.status = 'complete';
  await updated('error', 'uploaded', 1);
  expect(enqueue).not.toHaveBeenCalled();
});

test('terminal slot release failures escape for redelivery without paid dispatch', async () => {
  current.status = 'complete';
  jest.mocked(releaseDemoCallSlot).mockRejectedValueOnce(new Error('ledger unavailable'));
  await expect(updated('analyzing', 'complete')).rejects.toThrow('ledger unavailable');
  await updated('analyzing', 'complete');
  expect(releaseDemoCallSlot).toHaveBeenCalledTimes(2);
  expect(dispatched).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});

test('cancellation releases both event generations using the existing safe release helper', async () => {
  const canceled = event('analyzing', 'canceled', 1);
  canceled.data.before.data = () => ({ ...current, status: 'analyzing', processingGeneration: 0 });
  await onStartAnalyzing.run(canceled as never);
  expect(releaseDemoCallSlot).toHaveBeenNthCalledWith(1, 'call', 1, db);
  expect(releaseDemoCallSlot).toHaveBeenNthCalledWith(2, 'call', 0, db);
});

test.each(['standard', 'short'])('duplicate %s analysis events dispatch only once', async (pipeline) => {
  current.status = 'analyzing';
  current.analysisPipeline = pipeline;
  await updated('transcribing', 'analyzing');
  await updated('transcribing', 'analyzing');
  expect(pipeline === 'short' ? dispatchManualShortCallReview : dispatched).toHaveBeenCalledTimes(1);
  expect(current.demoAnalysisDispatch.status).toBe('complete');
});

test('concurrent delivery retries while dispatch is running, then skips the completed claim', async () => {
  current.status = 'analyzing';
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  dispatched.mockImplementationOnce(async () => { started(); await new Promise<void>((resolve) => { finish = resolve; }); });
  const first = updated('transcribing', 'analyzing');
  await entered;
  try {
    await expect(updated('transcribing', 'analyzing')).rejects.toMatchObject({ code: 'demo_analysis_dispatch_busy' });
  } finally {
    finish();
  }
  await first;
  await updated('transcribing', 'analyzing');
  expect(dispatched).toHaveBeenCalledTimes(1);
});

test('stale analysis event cannot claim or dispatch a newer generation', async () => {
  current.status = 'analyzing';
  current.processingGeneration = 2;
  await updated('transcribing', 'analyzing', 1);
  expect(dispatched).not.toHaveBeenCalled();
  expect(acquireDemoCallSlot).not.toHaveBeenCalled();
});

test('explicit generation advance permits a new dispatch without reusing the old claim', async () => {
  current.status = 'analyzing';
  await updated('transcribing', 'analyzing');
  current.processingGeneration = 1;
  await updated('error', 'analyzing', 1);
  expect(dispatched).toHaveBeenCalledTimes(2);
  expect(current.demoAnalysisDispatch).toMatchObject({ generation: 1, status: 'complete' });
});

test('dispatch failure cannot overwrite a concurrently advanced generation', async () => {
  current.status = 'analyzing';
  dispatched.mockImplementationOnce(async () => {
    current.processingGeneration = 1;
    throw new Error('old dispatch failed');
  });
  await updated('transcribing', 'analyzing');
  expect(current.status).toBe('analyzing');
  expect(current.error).toBeUndefined();
});

test('an expired ambiguous claim becomes a visible failure, never a second dispatch', async () => {
  current.status = 'analyzing';
  current.demoAnalysisDispatch = { generation: 0, status: 'running', claimedAt: Timestamp.fromMillis(Date.now() - 601_000) };
  await updated('transcribing', 'analyzing');
  expect(current.status).toBe('error');
  expect(current.error).toContain('interrupted');
  expect(dispatched).not.toHaveBeenCalled();
});

test('failure recording errors propagate, and redelivery cannot repeat the claimed dispatch', async () => {
  current.status = 'analyzing';
  const transaction = (db.runTransaction as jest.Mock).getMockImplementation()!;
  let count = 0;
  (db.runTransaction as jest.Mock).mockImplementation((...args) => {
    count++;
    if (count === 2) return Promise.reject(new Error('failed to persist error'));
    return transaction(...args);
  });
  dispatched.mockRejectedValueOnce(new Error('dispatch failed'));
  await expect(updated('transcribing', 'analyzing')).rejects.toThrow('failed to persist error');
  await expect(updated('transcribing', 'analyzing')).rejects.toMatchObject({ code: 'demo_analysis_dispatch_busy' });
  expect(dispatched).toHaveBeenCalledTimes(1);
});
