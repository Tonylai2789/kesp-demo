import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TranscriptionUploadSelection } from '@/lib/transcriptionUpload';
import {
  KESP_NO_AGENT,
  KespUploadDraftContext,
  type KespQueuedFile,
  type KespUploadDraftState,
} from './KespUploadDraftContext';

const UPLOAD_SUCCESS_HIDE_DELAY_MS = 1500;

/** Renders the KespUploadDraftProvider component. */
export function KespUploadDraftProvider({ children }: { children: ReactNode }) {
  const [agentValue, setAgentValue] = useState<string>(KESP_NO_AGENT);
  const [queue, setQueue] = useState<KespQueuedFile[]>([]);
  const isMountedRef = useRef(true);
  const removalTimeoutsRef = useRef<Map<string, number>>(new Map());

  const clearAllRemovalTimeouts = useCallback(/** Handles the callback for this operation. */() => {
    for (const timeoutId of removalTimeoutsRef.current.values()) {
      window.clearTimeout(timeoutId);
    }
    removalTimeoutsRef.current.clear();
  }, []);

  const enqueueFiles = useCallback(/** Snapshot selection when each file joins the queue. */(files: File[], selection: TranscriptionUploadSelection = {}) => {
    if (!isMountedRef.current) return;
    if (files.length === 0) return;
    const next: KespQueuedFile[] = files.map(/** Handles the callback for this operation. */(file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      file,
      ...selection,
      status: 'queued',
      progress: 0,
    }));
    setQueue(/** Handles the callback for this operation. */(prev) => [...prev, ...next]);
  }, []);

  const updateQueueItem = useCallback(/** Update progress without permitting transcription selection changes. */(id: string, patch: Partial<Pick<KespQueuedFile, 'status' | 'progress' | 'error'>>) => {
    if (!isMountedRef.current) return;
    setQueue(/** Handles the callback for this operation. */(prev) => {
      if (!prev.some(/** Handles the callback for this operation. */(q) => q.id === id)) return prev;
      return prev.map(/** Handles the callback for this operation. */(q) => (q.id === id ? { ...q, ...patch } : q));
    });
  }, []);

  const removeFromQueue = useCallback(/** Handles the callback for this operation. */(id: string) => {
    if (!isMountedRef.current) return;
    const timeoutId = removalTimeoutsRef.current.get(id);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      removalTimeoutsRef.current.delete(id);
    }
    setQueue(/** Handles the callback for this operation. */(prev) => prev.filter(/** Handles the callback for this operation. */(q) => q.id !== id));
  }, []);

  const scheduleSuccessRemoval = useCallback(
    /** Handles the callback for this operation. */
    (id: string) => {
      if (!isMountedRef.current) return;
      if (removalTimeoutsRef.current.has(id)) return;
      const timeoutId = window.setTimeout(/** Handles the callback for this operation. */() => {
        removalTimeoutsRef.current.delete(id);
        removeFromQueue(id);
      }, UPLOAD_SUCCESS_HIDE_DELAY_MS);
      removalTimeoutsRef.current.set(id, timeoutId);
    },
    [removeFromQueue]
  );

  useEffect(/** Handles the callback for this operation. */() => {
    isMountedRef.current = true;
    return /** Handles the callback for this operation. */ () => {
      isMountedRef.current = false;
      clearAllRemovalTimeouts();
    };
  }, [clearAllRemovalTimeouts]);

  useEffect(/** Handles the callback for this operation. */() => {
    for (const item of queue) {
      if (item.status !== 'uploaded') continue;
      scheduleSuccessRemoval(item.id);
    }
  }, [queue, scheduleSuccessRemoval]);

  const clearQueue = useCallback(/** Handles the callback for this operation. */() => {
    if (!isMountedRef.current) return;
    clearAllRemovalTimeouts();
    setQueue([]);
  }, [clearAllRemovalTimeouts]);

  const value = useMemo<KespUploadDraftState>(
    /** Handles the callback for this operation. */
    () => ({
      agentValue,
      setAgentValue,
      queue,
      enqueueFiles,
      updateQueueItem,
      removeFromQueue,
      clearQueue,
    }),
    [agentValue, queue, enqueueFiles, updateQueueItem, removeFromQueue, clearQueue]
  );

  return <KespUploadDraftContext.Provider value={value}>{children}</KespUploadDraftContext.Provider>;
}
