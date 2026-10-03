import { createContext, useContext } from 'react';
import type { TranscriptionUploadSelection } from '@/lib/transcriptionUpload';

export interface KespQueuedFile extends TranscriptionUploadSelection {
  id: string;
  file: File;
  status: 'queued' | 'uploading' | 'uploaded' | 'error';
  progress: number;
  error?: string;
}

export const KESP_NO_AGENT = '__none__';
export const KESP_GENERAL_AGENTS = '__general_agents__';

export interface KespUploadDraftState {
  agentValue: string;
  setAgentValue: (value: string) => void;
  queue: KespQueuedFile[];
  enqueueFiles: (files: File[], selection?: TranscriptionUploadSelection) => void;
  updateQueueItem: (id: string, patch: Partial<Pick<KespQueuedFile, 'status' | 'progress' | 'error'>>) => void;
  removeFromQueue: (id: string) => void;
  clearQueue: () => void;
}

export const KespUploadDraftContext = createContext<KespUploadDraftState | null>(null);

/** Documents the useKespUploadDraft behavior. */
export function useKespUploadDraft(): KespUploadDraftState {
  const ctx = useContext(KespUploadDraftContext);
  if (!ctx) {
    throw new Error('useKespUploadDraft must be used within KespUploadDraftProvider');
  }
  return ctx;
}
