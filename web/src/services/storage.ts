import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  getBlob,
  deleteObject,
  type UploadTaskSnapshot,
} from 'firebase/storage';
import { collection, doc } from 'firebase/firestore';
import { storage } from './firebaseStorage';
import { db } from './firebaseFirestore';
import type { CallCategory } from '@/types';
import type { ManualReminderInput } from '@/types';
import type { TranscriptionModel } from '@/types/call';
import { isDemoFirebaseProject } from './firebaseApp';
import { validateDemoAudioLimits, DEMO_MAX_UPLOAD_BYTES } from '@/lib/demoPolicy';
import { DEFAULT_TRANSCRIPTION_MODEL } from '@/lib/transcriptionUpload';
import { prepareConsubancoTranscriptionUpload } from './functions';

export interface UploadProgress {
  bytesTransferred: number;
  totalBytes: number;
  progress: number;
  state: 'running' | 'paused' | 'success' | 'canceled' | 'error';
}

export interface UploadResult {
  callId: string;
  path: string;
  downloadUrl: string;
}

export interface UploadAudioOptions {
  file: File;
  category?: CallCategory;
  onProgress?: (progress: UploadProgress) => void;
  promptVersions?: Record<string, string>;
  activityPromptVersions?: Record<string, string>;
  analyzerModel?: string;
  analyzerModelOverrides?: Record<string, string>;
  userId?: string;
  uploadBatchId?: string;
  salesAgentId?: string;
  salesAgentName?: string;
  agentAnalysisId?: string;
  agentRoutingMode?: 'none' | 'specific' | 'general';
  manualReminderInput?: ManualReminderInput | null;
  aiAgentUpload?: boolean;
  transcriptionModel?: TranscriptionModel;
  transcriptionComparison?: boolean;
}

/** Documents the arrayBufferToHex behavior. */
function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let output = '';
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, '0');
  }
  return output;
}

/** Documents the computeFileSha256Hex behavior. */
async function computeFileSha256Hex(file: File): Promise<string> {
  /** Uses the browser File API to load the exact bytes that will be uploaded for hashing. */
  const fileBytes = await file.arrayBuffer();
  /** Uses the Web Crypto API to compute a stable SHA-256 digest for duplicate detection. */
  const digest = await crypto.subtle.digest('SHA-256', fileBytes);
  return arrayBufferToHex(digest);
}

/** Documents the generateCallId behavior. */
export function generateCallId(): string {
  /** Calls Firebase Firestore to generate a client-side document id before Storage upload. */
  return doc(collection(db, 'calls')).id;
}

// Upload audio file to Firebase Storage
export function uploadAudioFile({
  file,
  category = 'unknown',
  onProgress,
  promptVersions,
  activityPromptVersions,
  analyzerModel,
  analyzerModelOverrides,
  userId,
  uploadBatchId,
  salesAgentId,
  salesAgentName,
  agentAnalysisId,
  agentRoutingMode,
  manualReminderInput,
  aiAgentUpload,
  transcriptionModel = DEFAULT_TRANSCRIPTION_MODEL,
  transcriptionComparison,
}: UploadAudioOptions): Promise<UploadResult> {
  return new Promise(/** Handles the callback for this operation. */(resolve, reject) => {
    void (/** Handles the callback for this operation. */ async () => {
      await validateDemoAudioFile(file);
      if (transcriptionComparison && !transcriptionModel) throw new Error('A transcription model is required for comparison.');
      if (transcriptionModel &&
          (!isDemoFirebaseProject || !userId)) {
        throw new Error('Prepared transcription uploads require an authenticated KESP session.');
      }
      let callId = transcriptionModel ? '' : generateCallId();
      let storagePath = `audio/${category}/${callId}${getFileExtension(file.name)}`;

      const metadata: { contentType: string; customMetadata?: Record<string, string> } = {
        contentType: file.type,
      };
      const customMeta: Record<string, string> = {};

      try {
        const audioContentHash = await computeFileSha256Hex(file);
        if (audioContentHash) {
          customMeta.audioContentHash = audioContentHash;
          customMeta.audioHashAlgorithm = 'sha256';
          customMeta.audioHashSource = 'client_file_bytes';
        }
      } catch (error) {
        if (transcriptionModel) throw error;
        console.warn('Failed to compute audio SHA-256 hash; continuing without client hash.', error);
      }

      if (transcriptionModel) {
        // Obtain a private upload reservation with server-owned model and comparison settings.
        const prepared = await prepareConsubancoTranscriptionUpload({
          originalFilename: file.name, sizeBytes: file.size, contentType: file.type,
          audioSha256: customMeta.audioContentHash, transcriptionModel, comparison: transcriptionComparison === true,
          ...(analyzerModel ? { analyzerModel } : {}),
          ...(analyzerModelOverrides ? { analyzerModelOverrides } : {}),
          ...(promptVersions ? { promptVersions } : {}),
          ...(activityPromptVersions ? { activityPromptVersions } : {}),
          ...(agentRoutingMode ? { agentRoutingMode } : {}),
          ...(salesAgentId ? { agentId: salesAgentId } : {}),
          ...(salesAgentName ? { agentName: salesAgentName } : {}),
          ...(agentAnalysisId ? { agentAnalysisId } : {}),
          ...(uploadBatchId ? { batchId: uploadBatchId } : {}),
          ...(manualReminderInput ? { manualReminderInput } : {}),
        });
        if (!prepared.callId || !prepared.storagePath?.startsWith(`prepared-uploads/${userId}/${prepared.callId}/`)) {
          throw new Error('The preparation service returned an invalid private upload path.');
        }
        callId = prepared.callId;
        storagePath = prepared.storagePath;
      }
      const storageRef = ref(storage, storagePath);

      if (promptVersions && Object.keys(promptVersions).length > 0) {
        customMeta.promptVersions = JSON.stringify(promptVersions);
      }
      if (activityPromptVersions && Object.keys(activityPromptVersions).length > 0) {
        customMeta.activityPromptVersions = JSON.stringify(activityPromptVersions);
      }
      if (analyzerModel) {
        customMeta.analyzerModel = analyzerModel;
      }
      if (analyzerModelOverrides && Object.keys(analyzerModelOverrides).length > 0) {
        customMeta.analyzerModelOverrides = JSON.stringify(analyzerModelOverrides);
      }
      customMeta.callDocumentId = callId;
      customMeta.originalFilename = file.name;
      customMeta.displayNameBase = file.name;
      if (userId) {
        customMeta.uploadedBy = userId;
      }
      if (uploadBatchId) {
        customMeta.uploadBatchId = uploadBatchId;
      }
      if (salesAgentId) {
        customMeta.salesAgentId = salesAgentId;
      }
      if (salesAgentName) {
        customMeta.salesAgentName = salesAgentName;
      }
      if (agentAnalysisId) {
        customMeta.agentAnalysisId = agentAnalysisId;
      }
      customMeta.callSource = 'manual_upload';
      customMeta.uploadOwnerType = 'manual_user';
      if (agentRoutingMode) {
        customMeta.agentRoutingMode = agentRoutingMode;
      }
      if (manualReminderInput) {
        customMeta.manualReminderInput = JSON.stringify(manualReminderInput);
      }
      if (aiAgentUpload) {
        customMeta.aiAgentUpload = 'true';
      }
      if (!transcriptionModel && Object.keys(customMeta).length > 0) {
        metadata.customMetadata = customMeta;
      }

      /** Calls an external SDK or API dependency. */
      const uploadTask = uploadBytesResumable(storageRef, file, metadata);

      uploadTask.on(
        'state_changed',
        /** Handles the callback for this operation. */
        (snapshot: UploadTaskSnapshot) => {
          const progress: UploadProgress = {
            bytesTransferred: snapshot.bytesTransferred,
            totalBytes: snapshot.totalBytes,
            progress: (snapshot.bytesTransferred / snapshot.totalBytes) * 100,
            state: snapshot.state as UploadProgress['state'],
          };
          onProgress?.(progress);
        },
        /** Handles the callback for this operation. */
        (error) => {
          reject(error);
        },
        /** Handles the callback for this operation. */
        async () => {
          try {
            if (transcriptionModel) {
              resolve({ callId, path: storagePath, downloadUrl: '' });
              return;
            }
            /** Calls an external SDK or API dependency. */
            const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
            resolve({
              callId,
              path: storagePath,
              downloadUrl,
            });
          } catch (error) {
            reject(error);
          }
        }
      );
    })().catch(/** Handles the callback for this operation. */(error) => reject(error));
  });
}

// Get file extension from filename
function getFileExtension(filename: string): string {
  const match = filename.match(/\.[^/.]+$/);
  return match ? match[0] : '';
}

// Delete audio file from Firebase Storage
export async function deleteAudioFile(storagePath: string): Promise<void> {
  /** Calls an external SDK or API dependency. */
  const storageRef = ref(storage, storagePath);
  /** Calls an external SDK or API dependency. */
  await deleteObject(storageRef);
}

/** Returns an audio URL; callers own and must revoke authenticated private-audio blob URLs. */
export async function getAudioDownloadUrl(storagePath: string): Promise<string> {
  /** Calls an external SDK or API dependency. */
  const storageRef = ref(storage, storagePath);
  if (storagePath.startsWith('scribe-smoke/') || storagePath.startsWith('prepared-uploads/')) {
    /** Reads private audio through authenticated Storage rules, capped at 100 MiB. */
    const blob = await getBlob(storageRef, 100 * 1024 * 1024);
    return URL.createObjectURL(blob);
  }
  /** Calls an external SDK or API dependency. */
  return getDownloadURL(storageRef);
}

// Validate audio file
export interface FileValidation {
  valid: boolean;
  error?: string;
}

/** Documents the validateAudioFile behavior. */
export function validateAudioFile(file: File, maxSizeMB: number = 25): FileValidation {
  // Check file type
  const validTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/x-wav'];
  if (!validTypes.includes(file.type)) {
    return {
      valid: false,
      error: 'Invalid file type. Please upload a WAV or MP3 file.',
    };
  }

  // Check file size
  const maxSizeBytes = Math.min(maxSizeMB * 1024 * 1024, DEMO_MAX_UPLOAD_BYTES);
  if (file.size > maxSizeBytes) {
    return {
      valid: false,
      error: `File too large. Maximum size is ${Math.min(maxSizeMB, 25)}MB.`,
    };
  }

  return { valid: true };
}

/** Probe only local media and fail closed on unsupported or unmeasurable duration. */
export async function validateDemoAudioFile(file: File): Promise<void> {
  const validation = validateAudioFile(file);
  if (!validation.valid) throw new Error(validation.error);
  if (file.size <= 0) throw new Error('El archivo está vacío.');
  await new Promise<void>((resolve, reject) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const timer = window.setTimeout(() => finish(new Error('No se pudo verificar la duración de la grabación.')), 15000);
    /** Release browser resources on every terminal path. */
    function finish(error?: Error) {
      window.clearTimeout(timer); audio.onloadedmetadata = null; audio.onerror = null;
      audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url);
      if (error) reject(error); else resolve();
    }
    audio.onloadedmetadata = () => {
      try { validateDemoAudioLimits(file.size, audio.duration); finish(); }
      catch (error) { finish(error instanceof Error ? error : new Error('Audio no válido.')); }
    };
    audio.onerror = () => finish(new Error('No se pudo leer la grabación.'));
    audio.preload = 'metadata'; audio.src = url;
  });
}
