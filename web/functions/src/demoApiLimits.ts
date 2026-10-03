import * as admin from 'firebase-admin';
import { createHash } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';

export type DemoApiClass = 'general' | 'paid' | 'report';
type Scope = 'user' | 'global';
type Counter = { start: number; count: number };
type State = { counters: Record<string, Counter> };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// All reviewers share one UID, so these limits apply to that shared login together.
export const DEMO_API_LIMITS = {
  user: { general: [60, 5000], paid: [6, 20], report: [6, 60] },
  global: { general: [180, 10000], paid: [12, 40], report: [12, 120] },
} as const;

/** Fixed UTC windows; invalid persisted counters fail closed rather than resetting. */
export function consumeDemoApiState(data: unknown, now: number, kind: DemoApiClass, scope: Scope): State {
  const state = data as State | undefined;
  if (!Number.isSafeInteger(now) || now < 0 || (state !== undefined &&
      (!state || !state.counters || typeof state.counters !== 'object' || Array.isArray(state.counters)))) {
    throw new HttpsError('unavailable', 'Demo request limits are temporarily unavailable.');
  }
  const counters = { ...state?.counters };
  const classes: DemoApiClass[] = kind === 'general' ? ['general'] : ['general', kind];
  for (const category of classes) {
    const windows = [category === 'paid' ? HOUR : MINUTE, DAY];
    for (const [index, duration] of windows.entries()) {
      const key = `${category}_${duration}`;
      const start = Math.floor(now / duration) * duration;
      const previous = counters[key];
      if (previous !== undefined && (!Number.isSafeInteger(previous?.start) || previous.start < 0 ||
          previous.start % duration !== 0 || previous.start > start ||
          !Number.isSafeInteger(previous.count) || previous.count < 0)) {
        throw new HttpsError('unavailable', 'Demo request limits are temporarily unavailable.');
      }
      const count = previous?.start === start ? previous.count : 0;
      if (count >= DEMO_API_LIMITS[scope][category][index]) {
        throw new HttpsError('resource-exhausted', 'Demo request limit reached. Please try again later.',
          { retryAfterSeconds: Math.ceil((start + duration - now) / 1000) });
      }
      counters[key] = { start, count: count + 1 };
    }
  }
  return { counters };
}

/** Transactions enforce limits across instances and endpoints before handlers run. */
export async function enforceDemoApiLimit(uid: string, kind: DemoApiClass,
  db: FirebaseFirestore.Firestore = admin.firestore(), now = Date.now()): Promise<void> {
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const globalRef = db.doc('_demo_api_limits/global');
  const userRef = db.doc('_demo_api_limits/user_' + createHash('sha256').update(uid).digest('hex'));
  try {
    await db.runTransaction(async transaction => {
      const global = await transaction.get(globalRef);
      const user = await transaction.get(userRef);
      const nextGlobal = consumeDemoApiState(global.exists ? global.data() : undefined, now, kind, 'global');
      const nextUser = consumeDemoApiState(user.exists ? user.data() : undefined, now, kind, 'user');
      transaction.set(globalRef, nextGlobal);
      transaction.set(userRef, nextUser);
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('unavailable', 'Demo request limits are temporarily unavailable.');
  }
}
