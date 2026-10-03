import * as admin from 'firebase-admin';
import { onCall } from './demoHttps';
import { DEMO_BUDGET_PATH, DEMO_MAX_ACTIVE_CALLS, readDemoBudget } from './demoBudget';

export interface DemoProcessingStatus {
  enabled: boolean;
  canStart: boolean;
  remainingMicros: number;
  activeSlots: number;
  maxActiveSlots: number;
  pauseReason: 'paused' | 'budget_exhausted' | 'capacity' | 'unavailable' | null;
}

/** Exposes admission availability, never ledger records, identities or raw error text. */
export function demoProcessingStatus(data: FirebaseFirestore.DocumentData | undefined): DemoProcessingStatus {
  const unavailable: DemoProcessingStatus = {
    enabled: false, canStart: false, remainingMicros: 0, activeSlots: 0,
    maxActiveSlots: DEMO_MAX_ACTIVE_CALLS, pauseReason: 'unavailable',
  };
  try {
    const budget = readDemoBudget(data);
    if (!data?.activeCalls || typeof data.activeCalls !== 'object' || Array.isArray(data.activeCalls)) return unavailable;
    const activeSlots = Object.keys(data.activeCalls).length;
    const remainingMicros = Math.max(0, budget.limitMicros - budget.spentMicros - budget.reservedMicros);
    const pauseReason = !budget.enabled ? 'paused' : remainingMicros === 0 ? 'budget_exhausted' :
      activeSlots >= DEMO_MAX_ACTIVE_CALLS ? 'capacity' : null;
    return { enabled: budget.enabled, canStart: pauseReason === null, remainingMicros, activeSlots,
      maxActiveSlots: DEMO_MAX_ACTIVE_CALLS, pauseReason };
  } catch {
    return unavailable;
  }
}

// demoHttps enforces the fixed allowlist and current supervisor/admin membership.
export const getDemoProcessingStatus = onCall({ invoker: 'public' }, async () => {
  try {
    const snapshot = await admin.firestore().doc(DEMO_BUDGET_PATH).get();
    return demoProcessingStatus(snapshot.data());
  } catch {
    return demoProcessingStatus(undefined);
  }
});
