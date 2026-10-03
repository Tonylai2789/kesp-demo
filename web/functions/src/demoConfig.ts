export const DEMO_PROJECT_ID = 'kesp-demo-tonylai2789';
export const DEMO_BUCKET = `${DEMO_PROJECT_ID}.firebasestorage.app`;
export const DEMO_ORGANIZATION_ID = 'consubanco';

/** Rejects any accidental discovery or deployment using bank configuration. */
export function assertDemoRuntime(env: NodeJS.ProcessEnv = process.env): void {
  const identities = [env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT, env.GCP_PROJECT];
  if (env.FIREBASE_CONFIG) {
    const config = JSON.parse(env.FIREBASE_CONFIG) as { projectId?: string; storageBucket?: string };
    identities.push(config.projectId);
    if (config.storageBucket && config.storageBucket !== DEMO_BUCKET) throw new Error('Demo storage bucket mismatch');
  }
  if (identities.some(value => value && value !== DEMO_PROJECT_ID)) throw new Error('Demo project mismatch');
  if (env.K_SERVICE && !identities.some(value => value === DEMO_PROJECT_ID)) throw new Error('Missing demo runtime identity');
  if (env.K_SERVICE && env.SUBAGENT_ANALYSIS_MODE !== 'subagent_2_0') throw new Error('Demo requires the pinned Subagent 2.0 pipeline');
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (/BUCKET|PROJECT/.test(key) && /sales-banking-agent|sales-feedback-agent|kesp-arvo/.test(value)) {
      throw new Error(`Forbidden bank reference in ${key}`);
    }
    if (/CCC_.*(ENABLED|SCHEDULE)/.test(key) && /^(true|1)$/i.test(value)) throw new Error(`Forbidden automation setting ${key}`);
  }
}

/** Only backend-prepared manual calls are eligible for the demo's reports. */
export function isDemoManualCall(data: Record<string, unknown> | undefined): boolean {
  return Boolean(data && data.organizationId === DEMO_ORGANIZATION_ID &&
    data.visibilityScope === 'organization' && data.callSource === 'manual_upload' &&
    typeof data.preparedUploadRequestId === 'string' && data.audioStorageBucket === DEMO_BUCKET);
}

/** Never grant report eligibility to short, excluded, unfinished or synthetic CCC calls. */
export function isDemoReportCall(data: Record<string, unknown> | undefined): boolean {
  return isDemoManualCall(data) && data?.status === 'complete' &&
    typeof data.duration === 'number' && Number.isFinite(data.duration) && data.duration >= 90 &&
    data.agentProfileExcluded !== true && data.transcriptionComparison !== true &&
    data.analysisPipeline !== 'manual_short_call_review' && !data.shortCallReviewSource &&
    typeof data.latestFeedbackId === 'string' && data.latestFeedbackId.length > 0;
}
