import * as admin from 'firebase-admin';
import { createDemoOpenAI } from '../demoPaidProviders';
import { runAgentAnalysisTask } from '../agentAnalyses';

jest.mock('fs', () => ({ ...jest.requireActual('fs'), readFileSync: jest.fn(() => 'Synthetic test instructions.') }));
jest.mock('../demoPaidProviders', () => ({ createDemoOpenAI: jest.fn(), DEMO_PATTERN_COMPLETION_TOKENS: 16384 }));
jest.mock('../kespInbox', () => ({ createKespInboxMessageWithId: jest.fn() }));
jest.mock('../processingTaskQueue', () => ({ enqueueAgentAnalysisTask: jest.fn() }));
jest.mock('firebase-admin', () => {
  const actual = jest.requireActual('firebase-admin');
  const values = new Map<string, FirebaseFirestore.DocumentData>();
  const doc = (key: string): any => ({
    id: key.split('/').pop(),
    get: async () => ({ exists: values.has(key), data: () => values.get(key) }),
    update: async (value: object) => { Object.assign(values.get(key)!, value); },
    set: async (value: FirebaseFirestore.DocumentData) => { values.set(key, value); },
    collection: (name: string) => collection(key + '/' + name),
  });
  const collection = (path: string): any => ({
    doc: (id: string) => doc(path + '/' + id),
    get: async () => ({ docs: [...values.keys()]
      .filter(key => key.startsWith(path + '/') && key.split('/').length === path.split('/').length + 1)
      .map(key => ({ id: key.split('/').pop(), data: () => values.get(key) })) }),
  });
  return { ...actual, __values: values, firestore: Object.assign(() => ({ collection,
    runTransaction: async (callback: any) => callback({ get: (ref: any) => ref.get(), update: (ref: any, value: object) => ref.update(value) }),
  }), actual.firestore) };
});

const values = (admin as unknown as { __values: Map<string, any> }).__values;
const run = 'agent_analyses/demo/analysis_runs/run';
let completion: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  values.clear();
  values.set('agent_analyses/demo', { status: 'analyzing' });
  values.set(run, { status: 'running', analyzerModel: 'gpt-5.4', completedTaskCount: 0, sourceCallIds: ['call'], eligibleCallCount: 1 });
  completion = jest.fn();
  (createDemoOpenAI as jest.Mock).mockReturnValue({ chat: { completions: { create: completion } } });
});

test.each(['behavior_pattern_detector_001', 'behavior_pattern_consolidator'])('%s requests bounded aggregate output and records truncation before parsing', async taskId => {
  values.set(run + '/tasks/' + taskId, { status: 'pending', promptPath: 'synthetic.md', inputPayload: { behaviorSignals: [{ signalId: 's' }] } });
  if (taskId === 'behavior_pattern_consolidator') {
    values.set(run + '/tasks/behavior_pattern_detector_001', { status: 'complete', output: { candidatePatterns: [{ patternName: 'Synthetic' }] } });
  }
  completion.mockResolvedValue({ choices: [{ finish_reason: 'length', message: { content: '{"patterns":[' } }],
    usage: { prompt_tokens: 100, completion_tokens: 16384 } });
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  const warnLog = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await runAgentAnalysisTask('demo', 'run', taskId);
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0][0]).toMatchObject({ model: 'gpt-5.4', max_completion_tokens: 16384 });
    expect(values.get(run + '/tasks/' + taskId)).toMatchObject({ status: 'error', errorCode: 'pattern_output_truncated',
      completion: { finishReason: 'length', completionTokens: 16384 } });
    expect(values.get('agent_analyses/demo').status).toBe('error');
    expect(values.has('agent_analyses/demo/reports/run')).toBe(false);
  } finally { errorLog.mockRestore(); warnLog.mockRestore(); }
});

test('completed detector output is saved and finalized without a paid retry', async () => {
  values.set(run + '/tasks/behavior_pattern_detector_001', { status: 'pending', promptPath: 'synthetic.md', inputPayload: { behaviorSignals: [{ signalId: 's' }] } });
  completion.mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { content: '{"candidatePatterns":[]}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 100 } });
  const warnLog = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await runAgentAnalysisTask('demo', 'run', 'behavior_pattern_detector_001');
    expect(completion).toHaveBeenCalledTimes(1);
    expect(values.get(run + '/tasks/behavior_pattern_detector_001')).toMatchObject({ status: 'complete', output: { candidatePatterns: [] } });
    expect(values.get('agent_analyses/demo')).toMatchObject({ status: 'complete', latestReportId: 'run', error: null });
    expect(values.has('agent_analyses/demo/reports/run')).toBe(true);
  } finally { warnLog.mockRestore(); }
});
