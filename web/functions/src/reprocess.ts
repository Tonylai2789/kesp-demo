import { onPaidCall as onCall, HttpsError, type CallableRequest } from './demoHttps';
import { handleRetryCccRuntimeFailures } from './cccRuntimeErrors';

/** Keeps the call-detail retry API while sharing bounded, budget-aware recovery. */
export const reprocessCall = onCall(async (request:CallableRequest<{callId:string;stage:'transcribe'|'analyze'}>) => {
  const { callId, stage } = request.data || {};
  if (typeof callId !== 'string' || !callId || callId.includes('/') || !['transcribe','analyze'].includes(stage)) {
    throw new HttpsError('invalid-argument','A valid call and processing stage are required');
  }
  const result = await handleRetryCccRuntimeFailures({...request,data:{mode:'selected',callIds:[callId],stage:stage === 'transcribe' ? 'transcription' : 'analysis',limit:1}});
  if (result.queued !== 1) {
    throw new HttpsError('failed-precondition',result.results[0]?.skippedReason || 'Call is not eligible for bounded retry');
  }
  return {success:true,callId,newStatus:stage === 'transcribe' ? 'uploaded' : 'analyzing'};
});
