const mockGet = jest.fn();
const mockAuthorize = jest.fn();
jest.mock('../demoApiLimits', () => ({ enforceDemoApiLimit: jest.fn() }));
jest.mock('firebase-admin', () => ({ firestore: () => ({ doc: () => ({ get: mockGet }) }) }));
jest.mock('../demoAccess', () => ({ assertDemoCaller: (...args: unknown[]) => mockAuthorize(...args) }));
jest.mock('firebase-functions/v2/https', () => ({
  ...jest.requireActual('firebase-functions/v2/https'),
  onCall: (_options: unknown, handler: unknown) => handler,
}));

import { demoProcessingStatus, getDemoProcessingStatus } from '../demoProcessingStatus';

const ledger = { enabled: true, limitMicros: 25_000_000, spentMicros: 14_966_271, reservedMicros: 0, activeCalls: {} };
const invoke = getDemoProcessingStatus as unknown as (request: unknown) => Promise<unknown>;

beforeEach(() => { jest.clearAllMocks(); mockAuthorize.mockResolvedValue({ role: 'supervisor' }); });

test('returns only safe status fields, deducts reservations, and never echoes ledger metadata', () => {
  expect(demoProcessingStatus({ ...ledger, reservedMicros: 100_000, secret: 'private', pauseReason: 'sensitive internal error' })).toEqual({
    enabled: true, canStart: true, remainingMicros: 9_933_729, activeSlots: 0, maxActiveSlots: 2, pauseReason: null,
  });
});

test('paused, exhausted, and full capacity fail closed without changing accounting', () => {
  expect(demoProcessingStatus({ ...ledger, enabled: false })).toMatchObject({ canStart: false, pauseReason: 'paused', remainingMicros: 10_033_729 });
  expect(demoProcessingStatus({ ...ledger, spentMicros: 25_000_000 })).toMatchObject({ canStart: false, pauseReason: 'budget_exhausted' });
  expect(demoProcessingStatus({ ...ledger, activeCalls: { a: {}, b: {} } })).toMatchObject({ canStart: false, pauseReason: 'capacity', activeSlots: 2 });
  expect(ledger.spentMicros).toBe(14_966_271);
});

test.each([undefined, {}, { ...ledger, activeCalls: undefined }, { ...ledger, activeCalls: [] }, { ...ledger, spentMicros: NaN }])('missing or malformed accounting is unavailable', (data) => {
  expect(demoProcessingStatus(data)).toMatchObject({ enabled: false, canStart: false, pauseReason: 'unavailable' });
});

test('authenticated callable reads once and surfaces no private ledger fields', async () => {
  mockGet.mockResolvedValue({ data: () => ledger });
  await expect(invoke({ auth: { uid: 'supervisor' } })).resolves.toEqual(demoProcessingStatus(ledger));
  expect(mockAuthorize).toHaveBeenCalledTimes(1);
  expect(mockGet).toHaveBeenCalledTimes(1);
});

test.each(['unauthenticated', 'permission-denied'])('denied identity never reads the budget: %s', async (code) => {
  mockAuthorize.mockRejectedValue(Object.assign(new Error('denied'), { code }));
  await expect(invoke({})).rejects.toMatchObject({ code });
  expect(mockGet).not.toHaveBeenCalled();
});

test('backend read failure becomes safe unavailable status', async () => {
  mockGet.mockRejectedValue(new Error('private backend details'));
  await expect(invoke({ auth: { uid: 'supervisor' } })).resolves.toEqual(demoProcessingStatus(undefined));
});
