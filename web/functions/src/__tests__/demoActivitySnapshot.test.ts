import { buildSnapshot } from '../agentActivity';

jest.mock('firebase-admin', () => {
  const actual = jest.requireActual('firebase-admin');
  return { ...actual, firestore: Object.assign(() => ({}), actual.firestore) };
});
jest.mock('../demoPaidProviders', () => ({ createDemoOpenAI: jest.fn() }));

describe('manual demo activity snapshots', () => {
  const snapshot = (environmentTarget?: string) => buildSnapshot({
    callId: 'synthetic-call',
    callData: { uploadedBy: 'demo-owner', salesAgentId: 'demo-agent',
      createdAt: new Date('2026-10-02T08:00:00Z'), environmentTarget },
    feedback: {}, latestFeedbackId: 'final', activityExtraction: null, manualReminderInput: null,
  });

  it('omits absent environment without inventing production provenance', () => {
    const value = snapshot();
    expect(value).not.toHaveProperty('environmentTarget');
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });
  it.each(['test', 'prod'])('preserves explicit supported environment %s', environment => {
    expect(snapshot(environment).environmentTarget).toBe(environment);
  });
});
