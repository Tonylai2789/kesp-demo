import * as admin from 'firebase-admin';
import { getFunctions } from 'firebase-admin/functions';
import { performTranscription } from '../transcribe';
import { handleDemoTranscriptionTask, nextDemoAdmissionWait, DEMO_MAX_ADMISSION_WAITS } from '../processingTaskWorkers';
import * as workers from '../processingTaskWorkers';

jest.mock('firebase-functions/v2/tasks', () => ({ onTaskDispatched: (_options: unknown, handler: unknown) => handler }));
jest.mock('firebase-admin', () => {
  const ref = { get: jest.fn() };
  const transaction = { get: ref.get, update: jest.fn() };
  const db = { collection: () => ({ doc: () => ref }), runTransaction: jest.fn(async (fn) => fn(transaction)) };
  return { firestore: () => db };
});
jest.mock('firebase-admin/functions', () => {
  const enqueue = jest.fn();
  return { getFunctions: () => ({ taskQueue: () => ({ enqueue }) }) };
});
jest.mock('../transcribe', () => ({ performTranscription: jest.fn(), transcribeChunk: jest.fn() }));
jest.mock('../callState', () => ({ getProcessingGeneration: (data: Record<string, unknown>) => data.processingGeneration ?? 0 }));
jest.mock('../analysisSubagents', () => ({ runSubagentTask: jest.fn() }));
jest.mock('../manualShortCallReview', () => ({ runManualShortCallReviewTask: jest.fn() }));
jest.mock('../agentAnalyses', () => ({ runAgentAnalysisTask: jest.fn() }));
jest.mock('../secrets', () => ({ OPENAI_API_KEY_SECRET: 'fake' }));
jest.mock('../transcriptionSecretBinding', () => ({ transcriptionWorkerSecrets: () => [] }));
jest.mock('../conversationMetricsAnalysis', () => ({ CONVERSATION_METRICS_TASK_OPTIONS: {}, runConversationMetricsAnalysisTask: jest.fn() }));

test('demo worker exports exclude Gemini and post-call processing', () => {
  expect(workers).not.toHaveProperty('processGeminiAudioReviewTask');
  expect(workers).not.toHaveProperty('processPostCallEventDetectionTask');
});

let data: FirebaseFirestore.DocumentData;
const db = admin.firestore();
const get = db.collection('calls').doc('c').get as jest.Mock;
const enqueue = getFunctions().taskQueue('processTranscriptionTask').enqueue as jest.Mock;
const updates: FirebaseFirestore.DocumentData[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  updates.length = 0;
  data = { status: 'uploaded', audioPath: 'prepared-uploads/u/c/file.mp3', processingGeneration: 2 };
  get.mockImplementation(async () => ({ data: () => data }));
  (db.runTransaction as jest.Mock).mockImplementation(async (fn) => fn({
    get, update: (_ref: unknown, fields: FirebaseFirestore.DocumentData) => {
      updates.push(fields);
      Object.assign(data, fields);
    },
  }));
  enqueue.mockResolvedValue(undefined);
  (performTranscription as jest.Mock).mockRejectedValue(Object.assign(new Error('capacity'), { code: 'demo_concurrency_limit' }));
});

test('capacity waits use delayed generation-bound task, not paid retries', async () => {
  await handleDemoTranscriptionTask({ callId: 'c' });
  expect(enqueue).toHaveBeenCalledWith({ callId: 'c', demoAdmissionWait: 1, demoAdmissionGeneration: 2 }, {
    id: 'demo-admit-c-2-1', scheduleDelaySeconds: 60, dispatchDeadlineSeconds: 1800,
  });
  expect(data.status).toBe('uploaded');
  expect(data.statusReason).toBe('demo_waiting_for_capacity');
  expect(data.automaticRetryCounts).toBeUndefined();
  expect(data.demoAdmissionWaitCount).toBe(1);
});

test('duplicate earlier deliveries and old generations cannot restart admission', async () => {
  data.demoAdmissionGeneration = 2;
  data.demoAdmissionWaitCount = 4;
  await handleDemoTranscriptionTask({ callId: 'c', demoAdmissionGeneration: 2, demoAdmissionWait: 3 });
  await handleDemoTranscriptionTask({ callId: 'c', demoAdmissionGeneration: 1, demoAdmissionWait: 9 });
  expect(performTranscription).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});

test('wait exhaustion and queue failure become visible terminal errors', async () => {
  await handleDemoTranscriptionTask({ callId: 'c', demoAdmissionWait: DEMO_MAX_ADMISSION_WAITS, demoAdmissionGeneration: 2 });
  expect(data.status).toBe('error');
  expect(data.errorCode).toBe('demo_admission_wait_exhausted');
  expect(data.error).toContain('Upload again');
  expect(data.retryable).toBe(false);
  expect(enqueue).not.toHaveBeenCalled();
  data.status = 'uploaded';
  enqueue.mockRejectedValue(new Error('queue unavailable'));
  await handleDemoTranscriptionTask({ callId: 'c' });
  expect(data.errorCode).toBe('demo_admission_enqueue_failed');
  expect(data.error).toContain('Ask the operator');
  expect(data.status).toBe('error');
});

test('already-created deterministic task is accepted without an invisible failure', async () => {
  enqueue.mockRejectedValue({ code: 'functions/task-already-exists' });
  await handleDemoTranscriptionTask({ callId: 'c' });
  expect(data.status).toBe('uploaded');
  expect(data.demoAdmissionWaitCount).toBe(1);
});

test('budget admission errors become visible and never enqueue paid retries', async () => {
  (performTranscription as jest.Mock).mockRejectedValue({ code: 'demo_budget_exhausted' });
  await handleDemoTranscriptionTask({ callId: 'c' });
  expect(data.status).toBe('error');
  expect(data.errorCode).toBe('demo_budget_exhausted');
  expect(enqueue).not.toHaveBeenCalled();
});

test('capacity counter is finite and malformed counters cannot schedule more work', () => {
  expect(nextDemoAdmissionWait(undefined)).toBe(1);
  expect(nextDemoAdmissionWait(59)).toBe(60);
  for (const value of [60, -1, '0', NaN, Infinity, 1.2]) expect(nextDemoAdmissionWait(value)).toBeNull();
});
