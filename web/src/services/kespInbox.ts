import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  Timestamp,
  updateDoc,
  where,
  limit,
  writeBatch,
  type DocumentData,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from './firebaseFirestore';
import type { KespInboxMessage, KnownKespInboxMessageType } from '@/types/kespInbox';

export const KESP_INBOX_COLLECTION = 'kesp_inbox';
export const KESP_INBOX_MESSAGES_SUBCOLLECTION = 'messages';

/** Documents the timestampToDate behavior. */
function timestampToDate(value: unknown): Date | null {
  if (value instanceof Timestamp) {
    return value.toDate();
  }
  if (value && typeof value === 'object' && 'toDate' in value) {
    const maybe = value as { toDate?: () => Date };
    if (typeof maybe.toDate === 'function') {
      return maybe.toDate();
    }
  }
  return null;
}

/** Documents the normalizeKnownMessageType behavior. */
function normalizeKnownMessageType(value: unknown): KnownKespInboxMessageType | null {
  if (value === 'duplicate_call_excluded') return value;
  if (value === 'reanalyze_no_changes') return value;
  if (value === 'upload_batch_completed') return value;
  if (value === 'call_unrecognized') return value;
  if (value === 'call_analysis_completed') return value;
  if (value === 'call_analysis_error') return value;
  if (value === 'agent_report_completed') return value;
  if (value === 'agent_report_error') return value;
  return null;
}

/** Documents the normalizeDuplicateFingerprintSource behavior. */
function normalizeDuplicateFingerprintSource(value: unknown): "sha256" | "gcs_md5" | null {
  return value === 'sha256' || value === 'gcs_md5' ? value : null;
}

/** Documents the normalizeString behavior. */
function normalizeString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Documents the normalizeNumber behavior. */
function normalizeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Documents the normalizeStringArray behavior. */
function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter(/** Handles the callback for this operation. */(item): item is string => typeof item === 'string');
  return strings.length === value.length ? strings : null;
}

/** Documents the docToKespInboxMessage behavior. */
export function docToKespInboxMessage(id: string, data: DocumentData): KespInboxMessage | null {
  const userId = typeof data.userId === 'string' ? data.userId : '';
  const rawType = typeof data.type === 'string' ? data.type : null;
  const knownType = normalizeKnownMessageType(rawType);
  const createdAt = timestampToDate(data.createdAt);
  if (!userId || !createdAt) {
    return null;
  }

  const message: KespInboxMessage = {
    id,
    userId,
    type: knownType ?? 'unknown',
    agentAnalysisId: normalizeString(data.agentAnalysisId),
    salesAgentId: normalizeString(data.salesAgentId),
    salesAgentName: normalizeString(data.salesAgentName),
    callId: normalizeString(data.callId),
    callName: normalizeString(data.callName),
    duplicateOfCallId: normalizeString(data.duplicateOfCallId),
    duplicateCacheKey: normalizeString(data.duplicateCacheKey),
    duplicateAudioHash: normalizeString(data.duplicateAudioHash),
    duplicateFingerprintKey: normalizeString(data.duplicateFingerprintKey),
    duplicateFingerprintSource: normalizeDuplicateFingerprintSource(data.duplicateFingerprintSource),
    uploadBatchId: normalizeString(data.uploadBatchId),
    callIds: normalizeStringArray(data.callIds),
    callNames: normalizeStringArray(data.callNames),
    callCount: normalizeNumber(data.callCount),
    terminalRunId: normalizeString(data.terminalRunId),
    agentRoutingReason: normalizeString(data.agentRoutingReason),
    analysisRunId: normalizeString(data.analysisRunId),
    runId: normalizeString(data.runId),
    errorStage: normalizeString(data.errorStage),
    errorCode: normalizeString(data.errorCode),
    originalType: knownType ? null : rawType,
    source: normalizeString(data.source),
    readAt: timestampToDate(data.readAt),
    dismissedAt: timestampToDate(data.dismissedAt),
    createdAt,
    updatedAt: timestampToDate(data.updatedAt),
  };

  if (!knownType) {
    return message;
  }

  if (knownType === 'upload_batch_completed') {
    if (!message.uploadBatchId || !message.callIds || message.callCount === null) {
      return { ...message, type: 'unknown', originalType: rawType };
    }
  }

  if (knownType === 'call_unrecognized') {
    if (!message.callId || !message.terminalRunId) {
      return { ...message, type: 'unknown', originalType: rawType };
    }
  }

  if (knownType === 'call_analysis_completed' || knownType === 'call_analysis_error') {
    if (!message.callId || !message.analysisRunId) {
      return { ...message, type: 'unknown', originalType: rawType };
    }
  }

  if (knownType === 'agent_report_completed' || knownType === 'agent_report_error') {
    if (!message.agentAnalysisId || !message.runId) {
      return { ...message, type: 'unknown', originalType: rawType };
    }
  }

  return message;
}

/** Documents the subscribeToKespInboxMessages behavior. */
export function subscribeToKespInboxMessages(
  params: { userId: string; maxResults?: number; unreadOnly?: boolean },
  callback: (messages: KespInboxMessage[]) => void
): () => void {
  const maxResults = typeof params.maxResults === 'number' && params.maxResults > 0 ? params.maxResults : 25;
  const constraints: QueryConstraint[] = [where('dismissedAt', '==', null)];
  if (params.unreadOnly) {
    constraints.push(where('readAt', '==', null));
  }
  constraints.push(orderBy('createdAt', 'desc'), limit(maxResults));

  /** Calls Firebase Firestore to subscribe to user-scoped KESP inbox messages. */
  const messagesQuery = query(
    collection(db, KESP_INBOX_COLLECTION, params.userId, KESP_INBOX_MESSAGES_SUBCOLLECTION),
    ...constraints
  );

  return onSnapshot(
    messagesQuery,
    /** Handles the callback for this operation. */
    (snapshot) => {
      const messages = snapshot.docs
        .map(/** Handles the callback for this operation. */(docSnap) => docToKespInboxMessage(docSnap.id, docSnap.data()))
        .filter(/** Handles the callback for this operation. */(message): message is KespInboxMessage => Boolean(message));
      callback(messages);
    },
    /** Handles the callback for this operation. */
    (error) => {
      console.error('KESP inbox subscription error:', error);
      callback([]);
    }
  );
}

/** Documents the markKespInboxMessageRead behavior. */
export async function markKespInboxMessageRead(params: {
  userId: string;
  messageId: string;
}): Promise<void> {
  /** Calls Firebase Firestore to persist KESP inbox read state for a single message. */
  await updateDoc(
    doc(db, KESP_INBOX_COLLECTION, params.userId, KESP_INBOX_MESSAGES_SUBCOLLECTION, params.messageId),
    {
      readAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    }
  );
}

/** Documents the dismissKespInboxMessage behavior. */
export async function dismissKespInboxMessage(params: {
  userId: string;
  messageId: string;
}): Promise<void> {
  const now = Timestamp.now();
  /** Calls Firebase Firestore to persist KESP inbox dismissed state for a single message. */
  await updateDoc(
    doc(db, KESP_INBOX_COLLECTION, params.userId, KESP_INBOX_MESSAGES_SUBCOLLECTION, params.messageId),
    {
      dismissedAt: now,
      updatedAt: now,
    }
  );
}

/** Documents the markAllKespInboxMessagesRead behavior. */
export async function markAllKespInboxMessagesRead(params: { userId: string }): Promise<void> {
  let lastDoc: QueryDocumentSnapshot<DocumentData> | null = null;

  for (;;) {
    const constraints: QueryConstraint[] = [
      where('dismissedAt', '==', null),
      where('readAt', '==', null),
      orderBy('createdAt', 'desc'),
      limit(500),
    ];
    if (lastDoc) {
      constraints.push(startAfter(lastDoc));
    }

    /** Calls Firebase Firestore to page through active unread inbox messages for bulk read updates. */
    const unreadQuery = query(
      collection(db, KESP_INBOX_COLLECTION, params.userId, KESP_INBOX_MESSAGES_SUBCOLLECTION),
      ...constraints
    );

    /** Calls Firebase Firestore to fetch a page of inbox messages for bulk read updates. */
    const page = await getDocs(unreadQuery);
    if (page.empty) return;

    const now = Timestamp.now();
    /** Calls Firebase Firestore to persist bulk read updates for inbox messages in a batched write. */
    const batch = writeBatch(db);
    page.docs.forEach(/** Handles the callback for this operation. */(docSnap) => {
      batch.update(docSnap.ref, { readAt: now, updatedAt: now });
    });
    /** Calls Firebase Firestore to commit bulk inbox updates. */
    await batch.commit();

    lastDoc = page.docs[page.docs.length - 1] ?? null;
    if (!lastDoc || page.size < 500) return;
  }
}

/** Documents the dismissReadKespInboxMessages behavior. */
export async function dismissReadKespInboxMessages(params: { userId: string }): Promise<void> {
  let lastDoc: QueryDocumentSnapshot<DocumentData> | null = null;

  for (;;) {
    const constraints: QueryConstraint[] = [
      where('dismissedAt', '==', null),
      orderBy('createdAt', 'desc'),
      limit(500),
    ];
    if (lastDoc) {
      constraints.push(startAfter(lastDoc));
    }

    /** Calls Firebase Firestore to page through active inbox messages for bulk read-message dismissal. */
    const activeQuery = query(
      collection(db, KESP_INBOX_COLLECTION, params.userId, KESP_INBOX_MESSAGES_SUBCOLLECTION),
      ...constraints
    );

    /** Calls Firebase Firestore to fetch a page of inbox messages for bulk read-message dismissal. */
    const page = await getDocs(activeQuery);
    if (page.empty) return;

    const now = Timestamp.now();
    /** Calls Firebase Firestore to persist bulk dismissed updates for read inbox messages. */
    const batch = writeBatch(db);
    let updateCount = 0;
    page.docs.forEach(/** Handles the callback for this operation. */(docSnap) => {
      if (timestampToDate(docSnap.data().readAt)) {
        batch.update(docSnap.ref, { dismissedAt: now, updatedAt: now });
        updateCount += 1;
      }
    });
    if (updateCount > 0) {
      /** Calls Firebase Firestore to commit bulk inbox dismissed updates. */
      await batch.commit();
    }

    lastDoc = page.docs[page.docs.length - 1] ?? null;
    if (!lastDoc || page.size < 500) return;
  }
}
