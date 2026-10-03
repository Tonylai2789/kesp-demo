import { onCall as firebaseOnCall, type CallableRequest, type CallableResponse, type CallableOptions } from 'firebase-functions/v2/https';
import { assertDemoCaller, assertDemoEnrollmentCaller } from './demoAccess';
import { enforceDemoApiLimit, type DemoApiClass } from './demoApiLimits';
export { HttpsError } from 'firebase-functions/v2/https';
export type { CallableRequest, CallableResponse, CallableOptions } from 'firebase-functions/v2/https';

/** Applies the immutable demo access ceiling even to legacy owner-only endpoints. */
function guardedCall(guard: (request:CallableRequest)=>Promise<unknown>, kind: DemoApiClass = 'general'): typeof firebaseOnCall {
  return ((optionsOrHandler: CallableOptions | ((request: CallableRequest) => unknown), suppliedHandler?: (request: CallableRequest, response?: CallableResponse) => unknown) => {
  const options = typeof optionsOrHandler === 'function' ? {} : optionsOrHandler;
  const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : suppliedHandler;
  if (!handler) throw new Error('Callable handler required');
  return firebaseOnCall({ ...options, maxInstances: 2, concurrency: 10 }, async (request, response) => {
    await guard(request);
    await enforceDemoApiLimit(request.auth!.uid, kind);
    return handler(request, response);
  });
  }) as typeof firebaseOnCall;
}

export const onCall = guardedCall(assertDemoCaller);
export const onPaidCall = guardedCall(assertDemoCaller, 'paid');
export const onReportCall = guardedCall(assertDemoCaller, 'report');
// Only the fixed-account membership bootstrap may run before a member exists.
export const onEnrollmentCall = guardedCall(assertDemoEnrollmentCaller);
