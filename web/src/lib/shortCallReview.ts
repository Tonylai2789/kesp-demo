import type { Call } from '@/types';

const DEFAULT_SHORT_CALL_THRESHOLD_SECONDS = 90;

export function isShortCallReviewCall(call: Call): boolean {
  if (call.analysisPipeline === 'manual_short_call_review' || call.shortCallReviewSource === 'automatic_ccc_gcs') {
    return true;
  }

  if (typeof call.shortCallReviewStatus === 'string' && call.shortCallReviewStatus.length > 0) {
    return true;
  }

  const threshold = typeof call.shortCallThresholdSeconds === 'number' && Number.isFinite(call.shortCallThresholdSeconds)
    ? call.shortCallThresholdSeconds
    : DEFAULT_SHORT_CALL_THRESHOLD_SECONDS;

  return typeof call.duration === 'number' && Number.isFinite(call.duration) && call.duration >= 0 && call.duration < threshold;
}

export function isRegularAgentProfileCall(call: Call): boolean {
  return !isShortCallReviewCall(call);
}
