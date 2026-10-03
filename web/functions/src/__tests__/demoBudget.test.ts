import type { Firestore } from 'firebase-admin/firestore';
import {
  DEMO_BUDGET_PATH, DEMO_PROJECT_ID, DEMO_STORAGE_BUCKET, DEMO_MAX_AUDIO_BYTES,
  assertDemoRuntime, assertDemoBucket, assertDemoAudioLimits, readDemoBudget, admitDemoReservation,
  reserveDemoSpend, reconcileDemoSpend, acquireDemoCallSlot, releaseDemoCallSlot, validateDemoAudioFile,
} from '../demoBudget';
import { stat } from 'fs/promises';
import { getAudioDuration } from '../ffmpeg';

jest.mock('../ffmpeg', () => ({ getAudioDuration: jest.fn() }));
jest.mock('fs/promises', () => ({ stat: jest.fn() }));

/** Serialize fake transactions and publish writes only on success, mirroring atomic admission. */
function memoryDb() {
  interface Ref { path: string; id: string | undefined; collection(name: string): { doc(id?: string): Ref } }
  interface Transaction {
    get(ref: Ref): Promise<{ exists: boolean; data(): FirebaseFirestore.DocumentData | undefined }>;
    update(ref: Ref, fields: FirebaseFirestore.DocumentData): number;
    create(ref: Ref, fields: FirebaseFirestore.DocumentData): number;
  }
  const values = new Map<string, FirebaseFirestore.DocumentData>();
  let serial: Promise<unknown> = Promise.resolve();
  let sequence = 0;
  const doc = (path: string): Ref => ({
    path, id: path.split('/').pop(),
    collection: (name: string) => ({ doc: (id = 'reservation-' + ++sequence) => doc(path + '/' + name + '/' + id) }),
  });
  const db = {
    projectId: DEMO_PROJECT_ID,
    doc,
    collection: (name: string) => ({ doc: (id: string) => doc(name + '/' + id) }),
    runTransaction: (operation: (transaction: Transaction) => Promise<unknown>) => {
      const result = serial.then(async () => {
        const writes: Array<() => void> = [];
        const transaction = {
          get: async (ref: Ref) => ({ exists: values.has(ref.path), data: () => values.get(ref.path) }),
          update: (ref: Ref, fields: FirebaseFirestore.DocumentData) => writes.push(() => values.set(ref.path, { ...values.get(ref.path), ...fields })),
          create: (ref: Ref, fields: FirebaseFirestore.DocumentData) => writes.push(() => values.set(ref.path, fields)),
        };
        const result = await operation(transaction);
        writes.forEach((write) => write());
        return result;
      });
      serial = result.catch(() => undefined);
      return result;
    },
  } as unknown as Firestore;
  values.set(DEMO_BUDGET_PATH, { enabled: true, limitMicros: 25_000_000, reservedMicros: 0, spentMicros: 0, activeCalls: {} });
  return { db, values, ledger: () => values.get(DEMO_BUDGET_PATH)! };
}

beforeEach(() => {
  process.env.GCLOUD_PROJECT = DEMO_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GCP_PROJECT;
  delete process.env.FIREBASE_CONFIG;
  jest.clearAllMocks();
});

describe('deployment and audio guards', () => {
  test('only consistent explicit demo identity and bucket pass', () => {
    expect(() => assertDemoRuntime({ GCLOUD_PROJECT: DEMO_PROJECT_ID })).not.toThrow();
    expect(() => assertDemoRuntime({})).toThrow();
    expect(() => assertDemoRuntime({ GCLOUD_PROJECT: DEMO_PROJECT_ID, GCP_PROJECT: 'sales-banking-agent' })).toThrow();
    expect(() => assertDemoRuntime({ GCLOUD_PROJECT: DEMO_PROJECT_ID, CCC_INTERNAL_BUCKET: 'kesp-arvo-internal-prod' })).toThrow();
    expect(() => assertDemoRuntime({ GCLOUD_PROJECT: DEMO_PROJECT_ID, FIREBASE_CONFIG: '{}' })).toThrow();
    expect(() => assertDemoBucket(DEMO_STORAGE_BUCKET)).not.toThrow();
    expect(() => assertDemoBucket('sales-feedback-agent.firebasestorage.app')).toThrow();
  });
  test('file limits include exact boundary and reject invalid/probe-derived excess', async () => {
    expect(() => assertDemoAudioLimits(DEMO_MAX_AUDIO_BYTES, 300)).not.toThrow();
    for (const seconds of [0, NaN, Infinity, 300.001]) expect(() => assertDemoAudioLimits(100, seconds)).toThrow();
    expect(() => assertDemoAudioLimits(DEMO_MAX_AUDIO_BYTES + 1, 120)).toThrow();
    (stat as jest.Mock).mockResolvedValue({ size: 100, isFile: () => true });
    (getAudioDuration as jest.Mock).mockResolvedValue(301);
    await expect(validateDemoAudioFile('/fake/audio')).rejects.toThrow();
    (getAudioDuration as jest.Mock).mockRejectedValue(new Error('corrupt audio'));
    await expect(validateDemoAudioFile('/fake/audio')).rejects.toThrow('corrupt audio');
  });
});

describe('bounded paid ledger', () => {
  const spend = { provider: 'openai' as const, model: 'gpt-5.4', purpose: 'analysis', upperBoundMicros: 100_000 };
  test('accepts the authorized USD30 ceiling without resetting existing accounting', () => {
    const existing = { enabled: true, limitMicros: 30_000_000, spentMicros: 14_966_271, reservedMicros: 100_000 };
    expect(readDemoBudget(existing)).toEqual(existing);
    expect(admitDemoReservation(existing, 14_933_729)).toBe(15_033_729);
    expect(() => admitDemoReservation(existing, 14_933_730)).toThrow();
    expect(existing.spentMicros).toBe(14_966_271);
    expect(existing.reservedMicros).toBe(100_000);
    expect(() => readDemoBudget({ ...existing, limitMicros: 30_000_001 })).toThrow();
  });
  test('missing, corrupt and over-budget ledgers fail closed', () => {
    expect(() => readDemoBudget(undefined)).toThrow();
    expect(() => readDemoBudget({ limitMicros: 26_000_000, spentMicros: 0, reservedMicros: 0 })).toThrow();
    expect(() => admitDemoReservation({ enabled: true, limitMicros: 25, spentMicros: 20, reservedMicros: 4 }, 2)).toThrow();
    expect(() => admitDemoReservation({ enabled: false, limitMicros: 25, spentMicros: 0, reservedMicros: 0 }, 1)).toThrow();
  });
  test('simultaneous admissions cannot overspend', async () => {
    const fixture = memoryDb();
    fixture.ledger().spentMicros = 24_850_000;
    const outcomes = await Promise.allSettled([
      reserveDemoSpend(spend, fixture.db), reserveDemoSpend(spend, fixture.db),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(fixture.ledger().reservedMicros).toBe(100_000);
  });
  test('uncertain charges retain reservations and settlement is idempotent', async () => {
    const fixture = memoryDb();
    const id = await reserveDemoSpend(spend, fixture.db);
    await reconcileDemoSpend(id, null, fixture.db);
    expect(fixture.ledger().reservedMicros).toBe(100_000);
    expect(fixture.ledger().spentMicros).toBe(0);
    await reconcileDemoSpend(id, 25_000, fixture.db);
    await reconcileDemoSpend(id, 25_000, fixture.db);
    expect(fixture.ledger().reservedMicros).toBe(0);
    expect(fixture.ledger().spentMicros).toBe(25_000);
  });
  test('provider overage is recorded and disables further admissions', async () => {
    const fixture = memoryDb();
    const id = await reserveDemoSpend(spend, fixture.db);
    await reconcileDemoSpend(id, 200_000, fixture.db);
    expect(fixture.ledger().spentMicros).toBe(200_000);
    expect(fixture.ledger().enabled).toBe(false);
    await expect(reserveDemoSpend(spend, fixture.db)).rejects.toThrow();
  });
  test('two call slots survive duplicates and reject third/stale generation', async () => {
    const fixture = memoryDb();
    for (const id of ['a', 'b', 'c']) fixture.values.set('calls/' + id, {
      status: 'analyzing', callSource: 'manual_upload', processingGeneration: 0, demoAudioValidated: true,
    });
    await acquireDemoCallSlot('a', 0, fixture.db);
    await acquireDemoCallSlot('a', 0, fixture.db);
    await acquireDemoCallSlot('b', 0, fixture.db);
    await expect(acquireDemoCallSlot('c', 0, fixture.db)).rejects.toThrow('Two demo calls');
    await expect(reserveDemoSpend({ ...spend, callId: 'a', processingGeneration: 1 }, fixture.db)).rejects.toThrow();
    await releaseDemoCallSlot('a', 0, fixture.db);
    expect(Object.keys(fixture.ledger().activeCalls)).toHaveLength(2);
    fixture.values.get('calls/a')!.status = 'complete';
    await releaseDemoCallSlot('a', 1, fixture.db);
    expect(Object.keys(fixture.ledger().activeCalls)).toHaveLength(2);
    await releaseDemoCallSlot('a', 0, fixture.db);
    await acquireDemoCallSlot('c', 0, fixture.db);
    expect(Object.keys(fixture.ledger().activeCalls).sort()).toEqual(['b', 'c']);
  });
  test('a forged/unvalidated call cannot incur paid work even with a slot', async () => {
    const fixture = memoryDb();
    fixture.values.set('calls/a', { status: 'analyzing', callSource: 'manual_upload', processingGeneration: 0 });
    await acquireDemoCallSlot('a', 0, fixture.db);
    await expect(reserveDemoSpend({ ...spend, callId: 'a', processingGeneration: 0 }, fixture.db)).rejects.toThrow();
  });
  test('only current-generation auxiliary metrics may reserve for a completed call', async () => {
    const fixture = memoryDb();
    fixture.values.set('calls/a', { status: 'complete', callSource: 'manual_upload', processingGeneration: 2, demoAudioValidated: true });
    const metrics = { ...spend, callId: 'a', purpose: 'conversation_metrics', processingGeneration: 2 };
    await expect(reserveDemoSpend(metrics, fixture.db)).resolves.toBeDefined();
    await expect(reserveDemoSpend({ ...metrics, purpose: 'analysis_subagent' }, fixture.db)).rejects.toThrow();
    await expect(reserveDemoSpend({ ...metrics, processingGeneration: 1 }, fixture.db)).rejects.toThrow();
    await expect(reserveDemoSpend({ ...metrics, processingGeneration: undefined }, fixture.db)).rejects.toThrow();
  });
});
