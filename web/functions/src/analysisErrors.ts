export type CallErrorSource =
  | 'transcription'
  | 'analysis_dispatch'
  | 'analysis_task'
  | 'analysis_finalizer'
  | 'reconcile';

export interface SerializedCallError {
  message: string;
  errorSource: CallErrorSource;
  errorCode?: string;
  errorType?: string;
  errorRequestId?: string;
  errorStatus?: number;
  retryable: boolean;
}

/** Documents the asRecord behavior. */
function asRecord(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object') {
    return value as Record<string, any>;
  }
  return null;
}

/** Documents the getString behavior. */
function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Documents the inferRetryable behavior. */
function inferRetryable(
  status: number | undefined,
  errorCode: string | undefined,
  errorType: string | undefined,
  message: string
): boolean {
  const normalizedMessage = message.toLowerCase();

  if (errorCode === 'insufficient_quota' || errorType === 'insufficient_quota') {
    return false;
  }

  if (status === 502 || status === 503 || status === 504) {
    return true;
  }

  if (status === 429) {
    return true;
  }

  if (
    errorCode === 'ECONNRESET' ||
    normalizedMessage.includes('timed out') ||
    normalizedMessage.includes('timeout') ||
    normalizedMessage.includes('connection error')
  ) {
    return true;
  }

  return false;
}

/** Documents the serializeCallError behavior. */
export function serializeCallError(
  error: unknown,
  errorSource: CallErrorSource
): SerializedCallError {
  let errorRecord = asRecord(error);
  // The OpenAI SDK wraps custom-fetch guard failures as APIConnectionError.
  // Preserve our local rejection instead of misclassifying it as transport failure.
  let cause = asRecord(errorRecord?.cause);
  for (let depth = 0; cause && depth < 5; depth += 1) {
    if (getString(cause.code)?.startsWith('demo_') || cause.code === 'stale_generation') {
      errorRecord = cause;
      break;
    }
    cause = asRecord(cause.cause);
  }
  const nestedError = asRecord(errorRecord?.error);
  const status =
    typeof errorRecord?.status === 'number'
      ? errorRecord.status
      : typeof nestedError?.status === 'number'
        ? nestedError.status
        : undefined;

  const message =
    getString(nestedError?.message) ||
    getString(errorRecord?.message) ||
    (error instanceof Error ? error.message : undefined) ||
    'Unknown error';
  const normalizedMessage = message.toLowerCase();

  const errorCode =
    getString(nestedError?.code) ||
    getString(errorRecord?.code) ||
    (status === 429 && normalizedMessage.includes('quota') ? 'insufficient_quota' : undefined);

  const errorType =
    getString(nestedError?.type) ||
    getString(errorRecord?.type);

  const errorRequestId =
    getString(errorRecord?.requestID) ||
    getString(errorRecord?.requestId) ||
    getString(nestedError?.requestID) ||
    getString(nestedError?.requestId);

  return {
    message,
    errorSource,
    errorCode,
    errorType,
    errorRequestId,
    errorStatus: status,
    retryable: inferRetryable(status, errorCode, errorType, message),
  };
}
