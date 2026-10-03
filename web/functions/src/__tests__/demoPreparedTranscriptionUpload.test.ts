import * as admin from 'firebase-admin';
import { prepareConsubancoTranscriptionUploadHandler, resolvePreparedUploadRouting, validatePreparedUploadInput, validatePreparedObject } from '../preparedTranscriptionUpload';
import { bindDemoSeedPreparedUpload, resolveDemoSeedUpload } from '../demoSeedAuthorization';
import { bindDemoReconstructionPreparedUpload, resolveDemoReconstructionUpload } from '../demoReconstructionAuthorization';
import type { CallableRequest } from '../demoHttps';
import { DEMO_MAX_AUDIO_BYTES, DEMO_STORAGE_BUCKET } from '../demoBudget';
import { resolveTranscriptionProvider } from '../transcriptionProvider';
import { isScribeTranscriptionDeployment } from '../transcriptionSecretBinding';

jest.mock('../ffmpeg', () => ({ getAudioDuration: jest.fn(), cleanupTmpDir: jest.fn() }));
jest.mock('firebase-admin', () => ({
  app: () => ({ options: { projectId: 'kesp-demo-tonylai2789' } }), firestore: jest.fn(),
}));
jest.mock('../demoSeedAuthorization', () => ({ resolveDemoSeedUpload: jest.fn(), bindDemoSeedPreparedUpload: jest.fn() }));
jest.mock('../demoReconstructionAuthorization', () => ({ resolveDemoReconstructionUpload: jest.fn(), bindDemoReconstructionPreparedUpload: jest.fn() }));
jest.mock('../demoHttps', () => ({
  onPaidCall: (_options: unknown, handler: unknown) => handler,
  HttpsError: jest.requireActual('firebase-functions/v2/https').HttpsError,
  onCall: (_options: unknown, handler: unknown) => handler,
}));
jest.mock('../cccAutomaticWorkflowMonitor', () => ({
  assertConsubancoAdmin: jest.fn(), assertConsubancoSupervisorOrAdmin: jest.fn(),
}));

const metadata = {
  originalFilename: 'ficcion-lunes.mp3', sizeBytes: 1200, contentType: 'audio/mpeg',
  audioSha256: 'a'.repeat(64), agentRoutingMode: 'none',
};

beforeEach(() => {
  jest.mocked(resolveDemoSeedUpload).mockResolvedValue(null);
  jest.mocked(resolveDemoReconstructionUpload).mockResolvedValue(null);
});

test('approved reconstruction uses the immutable binding, never creates an ordinary duplicate reservation', async () => {
  const create = jest.fn();
  jest.mocked(admin.firestore).mockReturnValue({
    doc: () => ({ get: async () => ({ data: () => ({ enabled: true, limitMicros: 25000000, spentMicros: 0, reservedMicros: 0 }) }) }),
    collection: () => ({ doc: () => ({ id: 'unused-candidate', create }) }),
  } as unknown as ReturnType<typeof admin.firestore>);
  const reconstruction = { callFields: { salesAgentId: 'demo_lucia_reconstructed',
    demoReconstruction: { kind: 'sanitized_reconstruction' } } } as unknown as NonNullable<Awaited<ReturnType<typeof resolveDemoReconstructionUpload>>>;
  jest.mocked(resolveDemoReconstructionUpload).mockResolvedValue(reconstruction);
  jest.mocked(bindDemoReconstructionPreparedUpload).mockResolvedValue({ callId: 'bound-reconstruction', storagePath: 'bound-path' });
  const raw = { ...metadata, demoReconstructionManifestId: 'reconstructed-v1-2026-09-21', demoReconstructionEntryId: 'lunes-01' };
  await expect(prepareConsubancoTranscriptionUploadHandler({ auth: { uid: 'real-owner' }, data: raw } as unknown as CallableRequest))
    .resolves.toEqual({ callId: 'bound-reconstruction', storagePath: 'bound-path' });
  expect(bindDemoReconstructionPreparedUpload).toHaveBeenLastCalledWith({ reconstruction, requestRecord: expect.objectContaining({
    callFields: expect.objectContaining(reconstruction.callFields),
  }) });
  expect(create).not.toHaveBeenCalled();
});

test('normal preparation retains real owner but makes the demo call organization-visible', async () => {
  const create = jest.fn().mockResolvedValue(undefined);
  jest.mocked(admin.firestore).mockReturnValue({
    doc: () => ({ get: async () => ({ data: () => ({ enabled: true, limitMicros: 25000000, spentMicros: 0, reservedMicros: 0 }) }) }),
    collection: () => ({ doc: () => ({ id: 'new-call', create }) }),
  } as unknown as ReturnType<typeof admin.firestore>);
  jest.mocked(resolveDemoSeedUpload).mockResolvedValue(null);
  await prepareConsubancoTranscriptionUploadHandler({ auth: { uid: 'real-owner' }, data: metadata } as unknown as CallableRequest);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ ownerUid: 'real-owner', callFields: expect.objectContaining({
    uploadedBy: 'real-owner', uploadedByUserId: 'real-owner', uploadedBySystemId: null,
    visibilityScope: 'organization', organizationName: 'KESP Demo', callSource: 'manual_upload',
  }) }));
});

test('seed preparation bypasses filename routing and returns the bound reservation on replay', async () => {
  const create = jest.fn();
  jest.mocked(admin.firestore).mockReturnValue({
    doc: () => ({ get: async () => ({ data: () => ({ enabled: true, limitMicros: 25000000, spentMicros: 0, reservedMicros: 0 }) }) }),
    collection: () => ({ doc: () => ({ id: 'unused-candidate', create }) }),
  } as unknown as ReturnType<typeof admin.firestore>);
  const seed = { callFields: { uploadedBy: 'real-owner', salesAgentId: 'demo_lucia_modelo',
    demoSeed: { synthetic: true }, callOccurredAt: 'trusted-test-date' } } as unknown as NonNullable<Awaited<ReturnType<typeof resolveDemoSeedUpload>>>;
  jest.mocked(resolveDemoSeedUpload).mockResolvedValue(seed);
  jest.mocked(bindDemoSeedPreparedUpload).mockResolvedValue({ callId: 'bound-call', storagePath: 'bound-path' });
  const raw = { ...metadata, demoSeedManifestId: 'synthetic-v1-2026-09-21', demoSeedEntryId: 'lunes-01' };
  await expect(prepareConsubancoTranscriptionUploadHandler({ auth: { uid: 'real-owner' }, data: raw } as unknown as CallableRequest))
    .resolves.toEqual({ callId: 'bound-call', storagePath: 'bound-path' });
  expect(resolveDemoSeedUpload).toHaveBeenLastCalledWith({ raw, ownerUid: 'real-owner' });
  expect(create).not.toHaveBeenCalled();
  expect(bindDemoSeedPreparedUpload).toHaveBeenLastCalledWith({ seed, requestRecord: expect.objectContaining({
    callFields: expect.objectContaining({ ...seed.callFields, visibilityScope: 'organization', organizationName: 'KESP Demo' }),
  }) });
});

test('either uploader selects the same real demo profile without CCC mappings', async () => {
  const profile: Record<string, unknown> = { organizationId: 'consubanco', visibilityScope: 'organization',
    salesAgentId: 'demo_agent', salesAgentName: 'Agente ficticio', uploadedBy: 'admin-owner' };
  const doc = jest.fn(() => ({ get: async () => ({ data: () => profile }) }));
  jest.mocked(admin.firestore).mockReturnValue({ collection: () => ({ doc }) } as unknown as ReturnType<typeof admin.firestore>);
  const selected = validatePreparedUploadInput({ ...metadata, agentRoutingMode: 'specific', agentId: 'demo_agent',
    agentAnalysisId: 'profile-123', agentName: 'Untrusted client label' });
  for (const uploader of ['admin-owner', 'supervisor-owner']) {
    const routing = await resolvePreparedUploadRouting(selected, uploader);
    expect(routing).toMatchObject({ salesAgentId: 'demo_agent', salesAgentName: 'Agente ficticio',
      matchedAgentAnalysisId: 'profile-123', agentRoutingStatus: 'matched' });
    expect(routing).not.toHaveProperty('cccAgentMappingId');
    expect(routing).not.toHaveProperty('cccAgentMappingStatus');
  }
  expect(doc).toHaveBeenCalledWith('profile-123');
  profile.salesAgentId = 'another-agent';
  await expect(resolvePreparedUploadRouting(selected, 'supervisor-owner')).rejects.toThrow('unavailable');
  profile.salesAgentId = 'demo_agent';
  profile.visibilityScope = 'user';
  await expect(resolvePreparedUploadRouting(selected, 'supervisor-owner')).rejects.toThrow('unavailable');
});

test('manual demo defaults preserve Scribe v2 and GPT-5.4; OpenAI remains selectable', () => {
  expect(validatePreparedUploadInput(metadata)).toMatchObject({
    transcriptionModel: 'scribe_v2', analyzerModel: 'gpt-5.4',
  });
  expect(validatePreparedUploadInput({ ...metadata, transcriptionModel: 'gpt-4o-transcribe-diarize' }).transcriptionModel)
    .toBe('gpt-4o-transcribe-diarize');
});

test('upload metadata rejects forged provenance, eligibility, budget and provider snapshots', () => {
  for (const field of ['demoSeed', 'demoSeedId', 'demoReconstruction', 'manifestSha256', 'approvedAt', 'demoAudioValidated', 'demoAudioDurationSeconds', 'callSource',
    'audioStorageBucket', 'sourceBucket', 'transcriptionProvider', 'processingGeneration', 'demoBudgetReservation',
    'callOccurredAt', 'organizationId', 'role']) {
    expect(() => validatePreparedUploadInput({ ...metadata, [field]: 'forged' })).toThrow();
  }
  expect(() => validatePreparedUploadInput({ ...metadata, sizeBytes: DEMO_MAX_AUDIO_BYTES })).not.toThrow();
  expect(() => validatePreparedUploadInput({ ...metadata, sizeBytes: DEMO_MAX_AUDIO_BYTES + 1 })).toThrow();
});

test('finalized object is bound to dedicated bucket and authorized size/path', () => {
  const record = { storagePath: 'prepared-uploads/user/call/ficcion.mp3', bucket: DEMO_STORAGE_BUCKET,
    sizeBytes: 100, contentType: 'audio/mpeg' };
  expect(() => validatePreparedObject(record, { name: record.storagePath, bucket: DEMO_STORAGE_BUCKET, size: 100, contentType: 'audio/mpeg' })).not.toThrow();
  expect(() => validatePreparedObject(record, { name: record.storagePath, bucket: 'kesp-arvo-internal-prod', size: 100, contentType: 'audio/mpeg' })).toThrow();
  expect(() => validatePreparedObject(record, { name: record.storagePath, bucket: DEMO_STORAGE_BUCKET, size: 101, contentType: 'audio/mpeg' })).toThrow();
});

test('provider selection accepts only demo-owned manual snapshots', () => {
  const snapshot = { callSource: 'manual_upload', organizationId: 'consubanco', transcriptionManualSelectionVersion: 1,
    transcriptionProvider: 'elevenlabs', transcriptionModel: 'scribe_v2' };
  expect(resolveTranscriptionProvider(snapshot, 'kesp-demo-tonylai2789').transcriptionProvider).toBe('elevenlabs');
  expect(() => resolveTranscriptionProvider(snapshot, 'sales-banking-agent')).toThrow();
  expect(() => resolveTranscriptionProvider({ ...snapshot, callSource: 'ccc_gcs' }, 'kesp-demo-tonylai2789')).toThrow();
  expect(() => resolveTranscriptionProvider({ ...snapshot, transcriptionTestOverride: true }, 'kesp-demo-tonylai2789')).toThrow();
  expect(() => resolveTranscriptionProvider({ ...snapshot, transcriptionManualSelectionVersion: 0 }, 'kesp-demo-tonylai2789')).toThrow();
});

test('only demo worker secret bindings are accepted', () => {
  expect(isScribeTranscriptionDeployment({ GCLOUD_PROJECT: 'kesp-demo-tonylai2789' })).toBe(true);
  expect(isScribeTranscriptionDeployment({ GCLOUD_PROJECT: 'sales-banking-agent' })).toBe(false);
  expect(isScribeTranscriptionDeployment({ GCLOUD_PROJECT: 'kesp-demo-tonylai2789', GCP_PROJECT: 'sales-feedback-agent' })).toBe(false);
  expect(isScribeTranscriptionDeployment({})).toBe(false);
});
