import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { serializeCallError, type SerializedCallError } from './analysisErrors';

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

export const DEFAULT_PROCESSING_GENERATION = 0;
export const STUCK_ANALYZING_THRESHOLD_MS = 30 * 60 * 1000;

export const CALL_ERROR_FIELD_KEYS = [
  'error',
  'errorSource',
  'errorCode',
  'errorType',
  'errorRequestId',
  'retryable',
  'statusReason',
];

/** Documents the setOptionalValue behavior. */
function setOptionalValue(
  target: Record<string, any>,
  key: string,
  value: unknown
): void {
  if (value === undefined || value === null || value === '') {
    target[key] = FieldValue.delete();
    return;
  }
  target[key] = value;
}

/** Documents the getProcessingGeneration behavior. */
export function getProcessingGeneration(data: Record<string, any> | undefined): number {
  const rawValue = data?.processingGeneration;
  return Number.isInteger(rawValue) ? rawValue : DEFAULT_PROCESSING_GENERATION;
}

/** Documents the getStatusReason behavior. */
export function getStatusReason(error: SerializedCallError): string {
  if (error.errorCode === 'insufficient_quota') {
    return 'openai_insufficient_quota';
  }

  if (error.errorCode === 'missing_active_run') {
    return 'missing_active_run';
  }

  if (error.errorCode === 'missing_feedback') {
    return 'missing_feedback';
  }

  if (error.errorCode === 'stale_generation') {
    return 'stale_generation';
  }

  switch (error.errorSource) {
    case 'transcription':
      return 'transcription_failed';
    case 'analysis_dispatch':
      return 'analysis_dispatch_failed';
    case 'analysis_task':
      return 'analysis_task_failed';
    case 'analysis_finalizer':
      return 'analysis_finalizer_failed';
    case 'reconcile':
      return 'reconciled_error';
  }

  return 'processing_failed';
}

/** Documents the buildCallErrorUpdate behavior. */
export function buildCallErrorUpdate(error: SerializedCallError): Record<string, any> {
  const update: Record<string, any> = {
    error: error.message,
    retryable: error.retryable,
    statusReason: getStatusReason(error),
  };

  setOptionalValue(update, 'errorSource', error.errorSource);
  setOptionalValue(update, 'errorCode', error.errorCode);
  setOptionalValue(update, 'errorType', error.errorType);
  setOptionalValue(update, 'errorRequestId', error.errorRequestId);

  return update;
}

/** Documents the buildClearCallErrorUpdate behavior. */
export function buildClearCallErrorUpdate(): Record<string, any> {
  return {
    error: FieldValue.delete(),
    errorSource: FieldValue.delete(),
    errorCode: FieldValue.delete(),
    errorType: FieldValue.delete(),
    errorRequestId: FieldValue.delete(),
    errorStatus: FieldValue.delete(),
    retryable: FieldValue.delete(),
    statusReason: FieldValue.delete(),
  };
}

/** Documents the resolveActiveRunState behavior. */
export async function resolveActiveRunState(
  callRef: FirebaseFirestore.DocumentReference,
  runId: string
): Promise<'running' | 'terminal' | 'missing'> {
  /** Calls an external SDK or API dependency. */
  const runDoc = await callRef.collection('analysis_runs').doc(runId).get();
  if (!runDoc.exists) {
    return 'missing';
  }

  const runData = runDoc.data() ?? {};
  const status = runData.status;

  if (status === 'error' || status === 'complete' || runData.finalizedAt) {
    return 'terminal';
  }

  return 'running';
}

/** Documents the reconcileCallState behavior. */
export async function reconcileCallState(callId: string): Promise<{
  action: 'noop' | 'reconciled_error' | 'reconciled_complete';
  reason: string;
}> {
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection('calls').doc(callId);
  const callDoc = await callRef.get();

  if (!callDoc.exists) {
    return { action: 'noop', reason: 'call_missing' };
  }

  const callData = callDoc.data() ?? {};
  const activeRunId = typeof callData.activeAnalysisRunId === 'string' ? callData.activeAnalysisRunId : undefined;

  if (!activeRunId) {
    return { action: 'noop', reason: 'no_active_run' };
  }

  /** Calls an external SDK or API dependency. */
  const runRef = callRef.collection('analysis_runs').doc(activeRunId);
  const runDoc = await runRef.get();

  if (!runDoc.exists) {
    const missingRunError = serializeCallError(
      { message: `Active analysis run ${activeRunId} not found`, code: 'missing_active_run' },
      'reconcile'
    );

    /** Calls an external SDK or API dependency. */
    await callRef.update({
      status: 'error',
      activeAnalysisRunId: FieldValue.delete(),
      lastTerminalRunId: activeRunId,
      lastRunStatus: 'error',
      analysisCompletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...buildCallErrorUpdate(missingRunError),
    });

    return { action: 'reconciled_error', reason: 'missing_active_run' };
  }

  const runData = runDoc.data() ?? {};
  if (runData.status === 'running' && !runData.finalizedAt) {
    return { action: 'noop', reason: 'run_still_running' };
  }

  if (runData.status === 'complete') {
    /** Calls an external SDK or API dependency. */
    const feedbackDoc = await callRef.collection('feedback').doc(activeRunId).get();
    if (!feedbackDoc.exists) {
      const missingFeedbackError = serializeCallError(
        { message: `Completed analysis run ${activeRunId} has no feedback document`, code: 'missing_feedback' },
        'reconcile'
      );

      /** Calls an external SDK or API dependency. */
      await callRef.update({
        status: 'error',
        activeAnalysisRunId: FieldValue.delete(),
        lastTerminalRunId: activeRunId,
        lastRunStatus: 'error',
        analysisCompletedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        ...buildCallErrorUpdate(missingFeedbackError),
      });

      return { action: 'reconciled_error', reason: 'missing_feedback' };
    }

    /** Calls an external SDK or API dependency. */
    await callRef.update({
      status: 'complete',
      latestFeedbackId: activeRunId,
      activeAnalysisRunId: FieldValue.delete(),
      lastTerminalRunId: activeRunId,
      lastRunStatus: 'complete',
      analysisCompletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...buildClearCallErrorUpdate(),
    });

    return { action: 'reconciled_complete', reason: 'terminal_complete_run' };
  }

  const reconciledError = serializeCallError(
    {
      message: runData.error || `Analysis run ${activeRunId} failed`,
      code: runData.errorCode,
      type: runData.errorType,
      requestID: runData.errorRequestId,
    },
    'reconcile'
  );

  /** Calls an external SDK or API dependency. */
  await callRef.update({
    status: 'error',
    activeAnalysisRunId: FieldValue.delete(),
    lastTerminalRunId: activeRunId,
    lastRunStatus: 'error',
    analysisCompletedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...buildCallErrorUpdate(reconciledError),
  });

  return { action: 'reconciled_error', reason: 'terminal_error_run' };
}

/** Documents the reconcileStuckAnalyzingCalls behavior. */
export async function reconcileStuckAnalyzingCalls(): Promise<{
  scanned: number;
  reconciled: number;
}> {
  const cutoff = Date.now() - STUCK_ANALYZING_THRESHOLD_MS;
  /** Calls Firebase Firestore to read or write persisted application data. */
  const callsSnapshot = await db.collection('calls').where('status', '==', 'analyzing').get();

  let reconciled = 0;
  for (const doc of callsSnapshot.docs) {
    const data = doc.data();
    const updatedAtMillis =
      typeof data.updatedAt?.toMillis === 'function' ? data.updatedAt.toMillis() : Number.POSITIVE_INFINITY;

    if (updatedAtMillis > cutoff) {
      continue;
    }

    const result = await reconcileCallState(doc.id);
    if (result.action !== 'noop') {
      reconciled += 1;
    }
  }

  return {
    scanned: callsSnapshot.size,
    reconciled,
  };
}
