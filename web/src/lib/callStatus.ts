import type { Call } from '@/types';

export function getCallStatusLabelKey(call: Call): string {
  if (call.status === 'error' && call.statusReason === 'openai_insufficient_quota') {
    return 'calls.blockedByQuota';
  }

  return `calls.${call.status}`;
}

export function getCallErrorMessageKey(call: Call): string | null {
  if (call.errorCode === 'insufficient_quota') {
    return 'calls.errorDetails.openai_insufficient_quota';
  }

  if (call.errorCode === 'missing_active_run') {
    return 'calls.errorDetails.missing_active_run';
  }

  if (call.errorCode === 'missing_feedback') {
    return 'calls.errorDetails.missing_feedback';
  }

  return null;
}
