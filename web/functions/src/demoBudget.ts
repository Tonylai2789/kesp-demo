import * as admin from 'firebase-admin';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { stat } from 'fs/promises';
import { getAudioDuration } from './ffmpeg';
import { DEMO_PROJECT_ID, DEMO_BUCKET, assertDemoRuntime as assertDemoConfigRuntime } from './demoConfig';

export { DEMO_PROJECT_ID } from './demoConfig';
export const DEMO_STORAGE_BUCKET = DEMO_BUCKET;
export const DEMO_BUDGET_MICROS = 30_000_000;
export const DEMO_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const DEMO_MAX_AUDIO_SECONDS = 300;
export const DEMO_BUDGET_PATH = 'demo_usage/budget';
export const DEMO_MAX_ACTIVE_CALLS = 2;

export function demoGuardError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Deployment identity is never inferred from a browser field or bucket name. */
export function assertDemoRuntime(env: NodeJS.ProcessEnv = process.env, appProjectId?: string): void {
  assertDemoConfigRuntime(env);
  const projects = [env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT, env.GCP_PROJECT, appProjectId].filter(Boolean);
  if (env.FIREBASE_CONFIG) {
    let config: { projectId?: string; storageBucket?: string };
    try { config = JSON.parse(env.FIREBASE_CONFIG); } catch { throw demoGuardError('demo_project_mismatch', 'Invalid Firebase runtime configuration'); }
    projects.push(config.projectId);
    if (config.storageBucket) assertDemoBucket(config.storageBucket);
  }
  if (!projects.length || projects.some((project) => project !== DEMO_PROJECT_ID)) {
    throw demoGuardError('demo_project_mismatch', 'Paid work is restricted to the isolated demo project');
  }
  for (const key of ['CCC_INTERNAL_BUCKET', 'CCC_GCS_TRIGGER_BUCKET', 'CCC_LANDING_BUCKET', 'STORAGE_BUCKET']) {
    if (env[key]) assertDemoBucket(env[key]);
  }
}

export function assertDemoBucket(bucket: unknown): asserts bucket is string {
  if (bucket !== DEMO_STORAGE_BUCKET) throw demoGuardError('demo_bucket_mismatch', 'Only the dedicated demo bucket is permitted');
}

export function assertDemoAudioLimits(bytes: number, seconds: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > DEMO_MAX_AUDIO_BYTES ||
      !Number.isFinite(seconds) || seconds <= 0 || seconds > DEMO_MAX_AUDIO_SECONDS) {
    throw demoGuardError('demo_audio_limit', 'Demo audio must be at most 25 MiB and five minutes');
  }
}

/** Probe actual bytes; neither client duration nor provider-returned duration admits paid work. */
export async function validateDemoAudioFile(audioPath: string): Promise<number> {
  const metadata = await stat(audioPath);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > DEMO_MAX_AUDIO_BYTES) {
    throw demoGuardError('demo_audio_limit', 'Invalid demo audio size');
  }
  const duration = await getAudioDuration(audioPath);
  assertDemoAudioLimits(metadata.size, duration);
  return duration;
}

export interface DemoBudgetState {
  enabled: boolean;
  limitMicros: number;
  spentMicros: number;
  reservedMicros: number;
}

/** Missing/corrupt accounting never resets itself; the operator initializes the ledger. */
export function readDemoBudget(value: FirebaseFirestore.DocumentData | undefined): DemoBudgetState {
  if (!value || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.limitMicros) || value.limitMicros <= 0 || value.limitMicros > DEMO_BUDGET_MICROS ||
      !Number.isSafeInteger(value.spentMicros) || value.spentMicros < 0 ||
      !Number.isSafeInteger(value.reservedMicros) || value.reservedMicros < 0) {
    throw demoGuardError('demo_budget_uninitialized', 'Demo budget must be initialized and reviewed');
  }
  return value as DemoBudgetState;
}

export function admitDemoReservation(state: DemoBudgetState, upperBoundMicros: number): number {
  if (!state.enabled || !Number.isSafeInteger(upperBoundMicros) || upperBoundMicros <= 0 ||
      state.spentMicros + state.reservedMicros + upperBoundMicros > state.limitMicros) {
    throw demoGuardError('demo_budget_exhausted', 'Insufficient remaining demo processing budget');
  }
  return state.reservedMicros + upperBoundMicros;
}

export interface DemoSpendRequest {
  provider: 'openai' | 'elevenlabs';
  purpose: string;
  model: string;
  upperBoundMicros: number;
  callId?: string;
  processingGeneration?: number;
}

function demoDb(db?: Firestore): Firestore {
  const firestore = db ?? admin.firestore();
  assertDemoRuntime(process.env, admin.apps.length ? admin.app().options.projectId : undefined);
  return firestore;
}

/** One reservation per HTTP attempt, not logical task: duplicate requests still consume budget. */
export async function reserveDemoSpend(input: DemoSpendRequest, db?: Firestore): Promise<string> {
  const firestore = demoDb(db);
  const ledger = firestore.doc(DEMO_BUDGET_PATH);
  const reservation = ledger.collection('reservations').doc();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.purpose) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(input.model)) {
    throw demoGuardError('demo_budget_metadata', 'Invalid budget attribution');
  }
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ledger);
    const state = readDemoBudget(snapshot.data());
    if (input.callId) {
      const call = await transaction.get(firestore.collection('calls').doc(input.callId));
      const data = call.data();
      const slot = snapshot.data()?.activeCalls?.[input.callId];
      // Scribe metrics may finish after the primary call. This exact auxiliary purpose keeps
      // generation/provenance checks but does not revive the terminal call or occupy its slot.
      const completedMetrics = input.purpose === 'conversation_metrics' && data?.status === 'complete' &&
        input.processingGeneration !== undefined;
      if (!data || (!['transcribing', 'analyzing'].includes(data.status) && !completedMetrics) ||
          data.callSource !== 'manual_upload' || data.demoAudioValidated !== true ||
          (!completedMetrics && slot !== (data.processingGeneration ?? 0)) ||
          (input.processingGeneration !== undefined && input.processingGeneration !== (data.processingGeneration ?? 0))) {
        throw demoGuardError('stale_generation', 'Call no longer owns an active demo processing slot');
      }
    }
    transaction.update(ledger, { reservedMicros: admitDemoReservation(state, input.upperBoundMicros), updatedAt: FieldValue.serverTimestamp() });
    transaction.create(reservation, {
      provider: input.provider, purpose: input.purpose, model: input.model,
      upperBoundMicros: input.upperBoundMicros, callId: input.callId ?? null,
      processingGeneration: input.processingGeneration ?? null,
      status: 'reserved', createdAt: FieldValue.serverTimestamp(),
    });
  });
  return reservation.id;
}

/** Unknown charge retains the full reservation indefinitely for operator reconciliation. */
export async function reconcileDemoSpend(reservationId: string, actualMicros: number | null, db?: Firestore): Promise<void> {
  const firestore = demoDb(db);
  const ledger = firestore.doc(DEMO_BUDGET_PATH);
  const reservation = ledger.collection('reservations').doc(reservationId);
  if (actualMicros !== null && (!Number.isSafeInteger(actualMicros) || actualMicros < 0)) {
    throw demoGuardError('demo_usage_invalid', 'Provider usage could not be reconciled');
  }
  await firestore.runTransaction(async (transaction) => {
    const budget = await transaction.get(ledger);
    const attempt = await transaction.get(reservation);
    const state = readDemoBudget(budget.data());
    const data = attempt.data();
    if (!data) throw demoGuardError('demo_usage_invalid', 'Missing paid reservation');
    if (data.status === 'settled') return;
    if (actualMicros === null) {
      transaction.update(reservation, { status: 'unknown_charge', updatedAt: FieldValue.serverTimestamp() });
      return;
    }
    if (!Number.isSafeInteger(data.upperBoundMicros) || data.upperBoundMicros <= 0 || data.upperBoundMicros > state.reservedMicros) {
      throw demoGuardError('demo_usage_invalid', 'Corrupt paid reservation');
    }
    // Record an overage truthfully and pause admissions, never clamp a charge to its estimate.
    transaction.update(ledger, {
      reservedMicros: state.reservedMicros - data.upperBoundMicros,
      spentMicros: state.spentMicros + actualMicros,
      ...(actualMicros > data.upperBoundMicros ? { enabled: false, pauseReason: 'provider_estimate_exceeded' } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(reservation, { status: 'settled', actualMicros, updatedAt: FieldValue.serverTimestamp() });
  });
}

/** Slots never expire by time: a slow worker must not silently overlap a third call. */
export async function acquireDemoCallSlot(callId: string, generation: number, db?: Firestore): Promise<void> {
  const firestore = demoDb(db);
  const ledger = firestore.doc(DEMO_BUDGET_PATH);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ledger);
    const call = await transaction.get(firestore.collection('calls').doc(callId));
    const state = readDemoBudget(snapshot.data());
    admitDemoReservation(state, 1);
    const data = call.data();
    if (!data || !['uploaded', 'transcribing', 'analyzing'].includes(data.status) ||
        data.callSource !== 'manual_upload' || (data.processingGeneration ?? 0) !== generation) {
      throw demoGuardError('stale_generation', 'Cannot acquire a slot for inactive call generation');
    }
    const slots: Record<string, number> = { ...(snapshot.data()?.activeCalls ?? {}) };
    if (slots[callId] === generation) return;
    if ((slots[callId] !== undefined && slots[callId] > generation) ||
        (slots[callId] === undefined && Object.keys(slots).length >= DEMO_MAX_ACTIVE_CALLS)) {
      throw demoGuardError('demo_concurrency_limit', 'Two demo calls are already processing');
    }
    slots[callId] = generation;
    transaction.update(ledger, { activeCalls: slots, updatedAt: FieldValue.serverTimestamp() });
  });
}

/** Main lifecycle integration calls this for terminal state; stale events cannot free a newer slot. */
export async function releaseDemoCallSlot(callId: string, generation: number, db?: Firestore): Promise<void> {
  const firestore = demoDb(db);
  const ledger = firestore.doc(DEMO_BUDGET_PATH);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ledger);
    const call = await transaction.get(firestore.collection('calls').doc(callId));
    readDemoBudget(snapshot.data());
    const slots: Record<string, number> = { ...(snapshot.data()?.activeCalls ?? {}) };
    if (slots[callId] !== generation) return;
    const data = call.data();
    if (data && !['complete', 'error', 'canceled', 'deleted'].includes(data.status)) return;
    delete slots[callId];
    transaction.update(ledger, { activeCalls: slots, updatedAt: FieldValue.serverTimestamp() });
  });
}
