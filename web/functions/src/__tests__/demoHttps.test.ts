const mockGuard = jest.fn();
const mockLimit = jest.fn();
const mockOnCall = jest.fn((_options: unknown, handler: unknown) => handler);
jest.mock('../demoAccess', () => ({ assertDemoCaller: (...args: unknown[]) => mockGuard(...args), assertDemoEnrollmentCaller: (...args: unknown[]) => mockGuard(...args) }));
jest.mock('../demoApiLimits', () => ({ enforceDemoApiLimit: (...args: unknown[]) => mockLimit(...args) }));
jest.mock('firebase-functions/v2/https', () => ({ ...jest.requireActual('firebase-functions/v2/https'), onCall: (...args: [unknown, unknown]) => mockOnCall(...args) }));
import { onCall, onPaidCall, onReportCall, onEnrollmentCall } from '../demoHttps';

beforeEach(() => { jest.clearAllMocks(); mockGuard.mockResolvedValue({}); mockLimit.mockResolvedValue(undefined); });
test.each([[onCall, 'general'], [onPaidCall, 'paid'], [onReportCall, 'report'], [onEnrollmentCall, 'general']] as const)(
  'guard and limit execute before the endpoint handler (%s)', async (factory, kind) => {
    const handler = jest.fn().mockResolvedValue('ok');
    const invoke = factory({ maxInstances: 50 }, handler) as unknown as (request: unknown) => Promise<unknown>;
    await expect(invoke({ auth: { uid: 'reviewer' }, data: { rateLimit: 'none' } })).resolves.toBe('ok');
    expect(mockLimit).toHaveBeenCalledWith('reviewer', kind);
    expect(mockOnCall.mock.calls[0][0]).toMatchObject({ maxInstances: 2, concurrency: 10 });
    expect(mockGuard.mock.invocationCallOrder[0]).toBeLessThan(mockLimit.mock.invocationCallOrder[0]);
    expect(mockLimit.mock.invocationCallOrder[0]).toBeLessThan(handler.mock.invocationCallOrder[0]);
  });
test('unauthorized or limited requests cannot run the handler', async () => {
  const handler = jest.fn();
  const invoke = onCall(handler) as unknown as (request: unknown) => Promise<unknown>;
  mockGuard.mockRejectedValueOnce(new Error('denied'));
  await expect(invoke({})).rejects.toThrow('denied');
  expect(mockLimit).not.toHaveBeenCalled();
  mockLimit.mockRejectedValueOnce(new Error('limited'));
  await expect(invoke({ auth: { uid: 'reviewer' } })).rejects.toThrow('limited');
  expect(handler).not.toHaveBeenCalled();
});
