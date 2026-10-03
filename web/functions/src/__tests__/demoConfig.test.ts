import { assertDemoRuntime, DEMO_BUCKET, DEMO_PROJECT_ID, isDemoReportCall } from '../demoConfig';

describe('isolated demo project boundary', () => {
  it('accepts only matching runtime identities and its own bucket', () => {
    expect(() => assertDemoRuntime({GCLOUD_PROJECT:DEMO_PROJECT_ID,FIREBASE_CONFIG:JSON.stringify({projectId:DEMO_PROJECT_ID,storageBucket:DEMO_BUCKET})})).not.toThrow();
    expect(() => assertDemoRuntime({GCLOUD_PROJECT:'sales-banking-agent'})).toThrow('project mismatch');
    expect(() => assertDemoRuntime({GCLOUD_PROJECT:DEMO_PROJECT_ID,GCP_PROJECT:'sales-feedback-agent'})).toThrow('project mismatch');
    expect(() => assertDemoRuntime({GCLOUD_PROJECT:DEMO_PROJECT_ID,CCC_INTERNAL_BUCKET:'kesp-arvo-internal-prod'})).toThrow('Forbidden bank reference');
    expect(() => assertDemoRuntime({K_SERVICE:'worker'})).toThrow('Missing demo runtime identity');
    expect(() => assertDemoRuntime({GCLOUD_PROJECT:DEMO_PROJECT_ID,CCC_PRODUCTION_LANDING_INGEST_ENABLED:'true'})).toThrow('Forbidden automation');
  });
  const call = {organizationId:'consubanco',visibilityScope:'organization',callSource:'manual_upload',preparedUploadRequestId:'request',audioStorageBucket:DEMO_BUCKET,status:'complete',duration:120,latestFeedbackId:'final'};
  it('supports real manual provenance without impersonating CCC', () => {
    expect(isDemoReportCall(call)).toBe(true);
    expect(isDemoReportCall({...call,callSource:'ccc_gcs',environmentTarget:'prod'})).toBe(false);
  });
  it.each([{status:'analyzing'},{latestFeedbackId:''},{preparedUploadRequestId:null},{audioStorageBucket:'bank'},{agentProfileExcluded:true},{transcriptionComparison:true},{analysisPipeline:'manual_short_call_review'},{shortCallReviewSource:'automatic_ccc_gcs'}])('excludes unsafe or ineligible report input %j', override => {
    expect(isDemoReportCall({...call,...override})).toBe(false);
  });
  it.each([undefined, null, NaN, Infinity, -1, 15, 45, 89.99])('excludes missing/invalid/short duration %s even with final feedback', duration => {
    expect(isDemoReportCall({...call,duration})).toBe(false);
  });
  it('includes the non-short duration boundary', () => {
    expect(isDemoReportCall({...call,duration:90})).toBe(true);
  });
});
