import type { Call } from '@/types';

/** Returns the business date for KESP Arvo call workflows. */
export function callBusinessDate(call: Pick<Call, 'callOccurredAt' | 'createdAt'>): Date {
  return call.callOccurredAt ?? call.createdAt;
}

/** Sorts newest first by business call date, then by processing date for stable ties. */
export function compareCallsByBusinessDateDesc(left: Call, right: Call): number {
  const primary = callBusinessDate(right).getTime() - callBusinessDate(left).getTime();
  if (primary !== 0) return primary;
  return right.createdAt.getTime() - left.createdAt.getTime();
}
