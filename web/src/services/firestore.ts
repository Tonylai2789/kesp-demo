import {
  collection,
  doc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  Timestamp,
  type DocumentData,
  type QueryConstraint,
} from 'firebase/firestore';
import { db } from './firebaseFirestore';
import { isDemoFirebaseProject } from './firebaseApp';
import type { Call, CallCategory, CallStatus, Transcript, Feedback, ManualShortCallReview, ManualShortCallPatternSummary } from '@/types';
import { callBusinessDate, compareCallsByBusinessDateDesc } from '@/lib/callDates';
import {
  registerKespDemoCallTerms,
  registerKespDemoFeedbackTerms,
  registerKespDemoTranscriptTerms,
} from '@/lib/kespDemoRedaction';

// Collection references
const CALLS_COLLECTION = 'calls';
const CONSUBANCO_ORGANIZATION_ID = 'consubanco';

/** Documents the timestampToDate behavior. */
function timestampToDate(timestamp: Timestamp | undefined): Date | undefined {
  return timestamp?.toDate();
}

/** Documents the docToCall behavior. */
function docToCall(id: string, data: DocumentData, options: { registerDemoTerms?: boolean } = {}): Call {
  const rawCategory = typeof data.category === 'string' ? data.category : '';
  const isLegacyTestCategory = rawCategory === 'test';
  const normalizedCategory: CallCategory =
    rawCategory === 'good' || rawCategory === 'medium' || rawCategory === 'bad' || rawCategory === 'unknown'
      ? (rawCategory as CallCategory)
      : 'unknown';

  const call: Call = {
    id,
    name: data.name,
    displayName: data.displayName,
    displayNameBase: data.displayNameBase,
    displayNameSuffix: data.displayNameSuffix,
    displayNameScopeKey: data.displayNameScopeKey,
    uploadedBy: data.uploadedBy ?? '',
    uploadedByUserId: data.uploadedByUserId ?? null,
    uploadedBySystemId: data.uploadedBySystemId ?? null,
    organizationId: data.organizationId,
    organizationName: data.organizationName,
    visibilityScope: data.visibilityScope,
    callDocumentId: data.callDocumentId,
    originalFilename: data.originalFilename,
    aiAgentUpload: data.aiAgentUpload === true || isLegacyTestCategory ? true : undefined,
    callSource: data.callSource,
    environmentTarget: data.environmentTarget === 'test' || data.environmentTarget === 'prod' ? data.environmentTarget : undefined,
    analysisPipeline: data.analysisPipeline,
    shortCallReviewSource: data.shortCallReviewSource,
    shortCallReviewStatus: data.shortCallReviewStatus,
    shortCallThresholdSeconds: data.shortCallThresholdSeconds,
    uploadOwnerType: data.uploadOwnerType,
    accountNumber: data.accountNumber,
    cccUserId: data.cccUserId,
    cccCallId: data.cccCallId,
    cccCallTimestamp: data.cccCallTimestamp,
    callOccurredAt: timestampToDate(data.callOccurredAt),
    callOccurredAtSource: data.callOccurredAtSource === 'ccc_filename' || data.callOccurredAtSource === 'created_at_fallback' ? data.callOccurredAtSource : undefined,
    cccDestination: data.cccDestination,
    canonicalCallId: data.canonicalCallId,
    canonicalSalesAgentId: data.canonicalSalesAgentId,
    cccAgentMappingId: data.cccAgentMappingId,
    cccAgentMappingStatus: data.cccAgentMappingStatus,
    cccOriginalFilename: data.cccOriginalFilename,
    cccParseClassification: data.cccParseClassification,
    salesAgentId: data.salesAgentId,
    salesAgentName: data.salesAgentName,
    agentRoutingMode: data.agentRoutingMode,
    agentRoutingStatus: data.agentRoutingStatus,
    agentRoutingReason: data.agentRoutingReason,
    matchedBy: data.matchedBy,
    matchedAgentAnalysisId: data.matchedAgentAnalysisId,
    matchedAgentProfileKey: data.matchedAgentProfileKey,
    matchedAgentName: data.matchedAgentName,
    matchedAgentConfidence: data.matchedAgentConfidence,
    extractedAgentName: data.extractedAgentName ?? null,
    extractedAgentNameNormalized: data.extractedAgentNameNormalized ?? null,
    agentNameMatchMethod: data.agentNameMatchMethod,
    agentNameMatchScore: data.agentNameMatchScore,
    matchedAt: timestampToDate(data.matchedAt),
    assignedAt: timestampToDate(data.assignedAt),
    manualReminderInput: data.manualReminderInput ?? null,
    category: normalizedCategory,
    status: data.status as CallStatus,
    audioPath: data.audioPath,
    audioUrl: data.audioUrl,
    audioContentHash: data.audioContentHash,
    audioHashAlgorithm: data.audioHashAlgorithm,
    audioHashSource: data.audioHashSource,
    audioStorageMd5Hash: data.audioStorageMd5Hash,
    audioStorageMd5HashSource: data.audioStorageMd5HashSource,
    duration: data.duration,
    createdAt: timestampToDate(data.createdAt) ?? new Date(),
    updatedAt: timestampToDate(data.updatedAt) ?? new Date(),
    transcriptionStartedAt: timestampToDate(data.transcriptionStartedAt),
    transcriptionCompletedAt: timestampToDate(data.transcriptionCompletedAt),
    analysisStartedAt: timestampToDate(data.analysisStartedAt),
    analysisCompletedAt: timestampToDate(data.analysisCompletedAt),
    canceledAt: timestampToDate(data.canceledAt),
    canceledBy: data.canceledBy,
    latestFeedbackId: data.latestFeedbackId,
    latestFeedbackCacheKey: data.latestFeedbackCacheKey,
    agentProfileExcluded: data.agentProfileExcluded,
    agentProfileExclusionReason: data.agentProfileExclusionReason,
    duplicateOfCallId: data.duplicateOfCallId,
    duplicateCacheKey: data.duplicateCacheKey,
    duplicateAudioHash: data.duplicateAudioHash,
    duplicateFingerprintKey: data.duplicateFingerprintKey,
    duplicateFingerprintSource: data.duplicateFingerprintSource,
    duplicateDetectedAt: timestampToDate(data.duplicateDetectedAt),
    duplicateDetectedBy: data.duplicateDetectedBy,
    isChunked: data.isChunked,
    totalChunks: data.totalChunks,
    completedChunks: data.completedChunks,
    chunkingStartedAt: timestampToDate(data.chunkingStartedAt),
    error: data.error,
    errorSource: data.errorSource,
    errorCode: data.errorCode,
    errorType: data.errorType,
    errorRequestId: data.errorRequestId,
    retryable: data.retryable,
    statusReason: data.statusReason,
    promptOverrides: data.promptOverrides,
    analyzerModel: data.analyzerModel,
    activeAnalysisRunId: data.activeAnalysisRunId,
    activeShortCallReviewRunId: data.activeShortCallReviewRunId,
    latestShortCallReviewRunId: data.latestShortCallReviewRunId,
    lastTerminalRunId: data.lastTerminalRunId,
    lastRunStatus: data.lastRunStatus,
    processingGeneration: data.processingGeneration,
    transcriptionMode: data.transcriptionMode,
    transcriptionModel: data.transcriptionModel,
    transcriptionProvider: data.transcriptionProvider,
    transcriptionComparison: data.transcriptionComparison,
    probeDurationSec: data.probeDurationSec,
  };
  if (options.registerDemoTerms !== false) registerKespDemoCallTerms(call);
  return call;
}


/** Documents the normalizeShortCallReview behavior. */
function normalizeShortCallReview(data: DocumentData): ManualShortCallReview {
  return {
    ...(data as ManualShortCallReview),
    createdAt: timestampToDate(data.createdAt),
    updatedAt: timestampToDate(data.updatedAt),
  };
}

/** Documents the normalizeManualShortCallPattern behavior. */
function normalizeManualShortCallPattern(data: DocumentData): ManualShortCallPatternSummary {
  return {
    ...(data as ManualShortCallPatternSummary),
    lastGeneratedAt: timestampToDate(data.lastGeneratedAt),
  };
}

/** Documents the normalizeFeedbackDocument behavior. */
function normalizeFeedbackDocument(
  data: DocumentData,
  fallbackAgentName?: string | null
): Feedback {
  const normalizedAgentName =
    typeof data.agent_name === 'string' && data.agent_name.trim()
      ? data.agent_name.trim()
      : fallbackAgentName?.trim() || null;

  const feedback = {
    ...data,
    agent_name: normalizedAgentName,
    agent_strengths: data.agent_strengths ?? [],
    agent_weaknesses: data.agent_weaknesses ?? [],
    loan_completed: data.loan_completed ?? 'unclear',
    overall_score: data.overall_score ?? 0,
    performance_tier: data.performance_tier ?? 'needs_improvement',
  } as Feedback;
  registerKespDemoFeedbackTerms(feedback);
  return feedback;
}

// Fetch all calls with optional filters
export interface CallFilters {
  userId?: string;
  uploadedBy?: string;
  organizationId?: string;
  visibilityScope?: Call['visibilityScope'];
  callSource?: Call['callSource'];
  environmentTarget?: Call['environmentTarget'];
  analysisPipeline?: Call['analysisPipeline'];
  includeOrganizationCalls?: boolean;
  salesAgentId?: string;
  matchedAgentAnalysisId?: string;
  agentRoutingMode?: Call['agentRoutingMode'];
  agentRoutingStatus?: Call['agentRoutingStatus'];
  agentRoutingStatuses?: Call['agentRoutingStatus'][];
  category?: CallCategory | 'all';
  status?: CallStatus | 'all';
  sortBy?: 'createdAt' | 'callOccurredAt' | 'duration' | 'category';
  sortOrder?: 'asc' | 'desc';
  maxResults?: number;
  skipDemoTermRegistration?: boolean;
}

/** Documents the shouldIncludeOrganizationCalls behavior. */
function shouldIncludeOrganizationCalls(filters: CallFilters): boolean {
  return Boolean(filters.userId && filters.includeOrganizationCalls !== false);
}

/** Documents the canRunConsubancoOrganizationQuery behavior. */
function canRunConsubancoOrganizationQuery(filters: CallFilters): boolean {
  if (filters.organizationId && filters.organizationId !== CONSUBANCO_ORGANIZATION_ID) return false;
  if (filters.visibilityScope && filters.visibilityScope !== 'organization') return false;
  if (!isDemoFirebaseProject && filters.callSource && filters.callSource !== 'ccc_gcs') return false;
  return true;
}

/** Documents the sortAndLimitCalls behavior. */
function sortAndLimitCalls(calls: Call[], filters: CallFilters): Call[] {
  const sortOrder = filters.sortOrder ?? 'desc';
  const sorted = [...calls].sort(/** Handles the callback for this operation. */(left, right) => {
    if ((filters.sortBy ?? 'createdAt') === 'duration') {
      return (left.duration ?? 0) - (right.duration ?? 0);
    }
    if ((filters.sortBy ?? 'createdAt') === 'category') {
      return left.category.localeCompare(right.category);
    }
    if ((filters.sortBy ?? 'createdAt') === 'callOccurredAt') {
      return callBusinessDate(left).getTime() - callBusinessDate(right).getTime();
    }
    return left.createdAt.getTime() - right.createdAt.getTime();
  });
  if (sortOrder === 'desc') sorted.reverse();
  return filters.maxResults ? sorted.slice(0, filters.maxResults) : sorted;
}

/** Documents the mergeVisibleCalls behavior. */
function mergeVisibleCalls(callGroups: Call[][], filters: CallFilters): Call[] {
  const merged = new Map<string, Call>();
  callGroups.flat().forEach(/** Handles the callback for this operation. */(call) => {
    merged.set(call.id, call);
  });
  return sortAndLimitCalls(Array.from(merged.values()), filters);
}

/** Documents the fetchCalls behavior. */
export async function fetchCalls(filters: CallFilters = {}): Promise<Call[]> {
  if (shouldIncludeOrganizationCalls(filters)) {
    const manualFilters: CallFilters = { ...filters, includeOrganizationCalls: false };
    const orgFilters: CallFilters | null = canRunConsubancoOrganizationQuery(filters)
      ? {
        ...filters,
        userId: undefined,
        uploadedBy: undefined,
        organizationId: CONSUBANCO_ORGANIZATION_ID,
        visibilityScope: 'organization',
        callSource: isDemoFirebaseProject ? filters.callSource : 'ccc_gcs',
        includeOrganizationCalls: false,
      }
      : null;
    const [manualCalls, organizationCalls] = await Promise.all([
      fetchCalls(manualFilters),
      orgFilters ? fetchCalls(orgFilters) : Promise.resolve([]),
    ]);
    return mergeVisibleCalls([manualCalls, organizationCalls], filters);
  }

  const constraints: QueryConstraint[] = [];

  const uploadedByFilter = filters.uploadedBy ?? filters.userId;
  if (uploadedByFilter) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('uploadedBy', '==', uploadedByFilter));
  }

  if (filters.organizationId) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('organizationId', '==', filters.organizationId));
  }

  if (filters.visibilityScope) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('visibilityScope', '==', filters.visibilityScope));
  }

  if (filters.callSource) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('callSource', '==', filters.callSource));
  }

  if (filters.environmentTarget) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('environmentTarget', '==', filters.environmentTarget));
  }

  if (filters.analysisPipeline) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('analysisPipeline', '==', filters.analysisPipeline));
  }

  if (filters.salesAgentId) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('salesAgentId', '==', filters.salesAgentId));
  }

  if (filters.matchedAgentAnalysisId) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('matchedAgentAnalysisId', '==', filters.matchedAgentAnalysisId));
  }

  if (filters.agentRoutingMode) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('agentRoutingMode', '==', filters.agentRoutingMode));
  }

  if (filters.agentRoutingStatus) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('agentRoutingStatus', '==', filters.agentRoutingStatus));
  } else if (filters.agentRoutingStatuses?.length) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('agentRoutingStatus', 'in', filters.agentRoutingStatuses));
  }

  if (filters.category && filters.category !== 'all') {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('category', '==', filters.category));
  }

  if (filters.status && filters.status !== 'all') {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('status', '==', filters.status));
  }

  /** Calls an external SDK or API dependency. */
  constraints.push(orderBy(filters.sortBy ?? 'createdAt', filters.sortOrder ?? 'desc'));

  if (filters.maxResults) {
    /** Calls an external SDK or API dependency. */
    constraints.push(limit(filters.maxResults));
  }

  /** Calls an external SDK or API dependency. */
  const q = query(collection(db, CALLS_COLLECTION), ...constraints);
  /** Calls an external SDK or API dependency. */
  const snapshot = await getDocs(q);

  return snapshot.docs.map(/** Handles the callback for this operation. */(doc) => docToCall(doc.id, doc.data()));
}

// Fetch a single call by ID
export async function fetchCall(callId: string): Promise<Call | null> {
  /** Calls an external SDK or API dependency. */
  const docRef = doc(db, CALLS_COLLECTION, callId);
  /** Calls an external SDK or API dependency. */
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  return docToCall(snapshot.id, snapshot.data());
}

// Delete a call
export async function deleteCall(callId: string): Promise<void> {
  /** Calls an external SDK or API dependency. */
  const docRef = doc(db, CALLS_COLLECTION, callId);
  /** Calls an external SDK or API dependency. */
  await deleteDoc(docRef);
}

// Update call name
export async function updateCallName(callId: string, name: string): Promise<void> {
  /** Calls an external SDK or API dependency. */
  const docRef = doc(db, CALLS_COLLECTION, callId);
  /** Calls an external SDK or API dependency. */
  await updateDoc(docRef, {
    name,
    displayName: name,
    displayNameBase: name,
    displayNameSuffix: 0,
    updatedAt: Timestamp.now(),
  });
}

// Subscribe to real-time updates for a single call
export function subscribeToCall(
  callId: string,
  callback: (call: Call | null) => void
): () => void {
  /** Calls an external SDK or API dependency. */
  const docRef = doc(db, CALLS_COLLECTION, callId);

  return onSnapshot(
    docRef,
    /** Handles the callback for this operation. */
    (snapshot) => {
      if (snapshot.exists()) {
        callback(docToCall(snapshot.id, snapshot.data()));
      } else {
        callback(null);
      }
    },
    /** Handles the callback for this operation. */
    (error) => {
      console.error('Call subscription error (permission denied or not found):', error);
      callback(null);
    }
  );
}

// Subscribe to real-time updates for all calls
export function subscribeToCalls(
  filters: CallFilters,
  callback: (calls: Call[]) => void,
  errorCallback?: (error: Error) => void
): () => void {
  if (shouldIncludeOrganizationCalls(filters)) {
    const latestManualCalls: { value: Call[]; loaded: boolean } = { value: [], loaded: false };
    const latestOrganizationCalls: { value: Call[]; loaded: boolean } = { value: [], loaded: !canRunConsubancoOrganizationQuery(filters) };
    const emit = /** Documents the emit behavior. */ () => {
      if (!latestManualCalls.loaded || !latestOrganizationCalls.loaded) return;
      callback(mergeVisibleCalls([latestManualCalls.value, latestOrganizationCalls.value], filters));
    };
    const unsubscribeManual = subscribeToCalls(
      { ...filters, includeOrganizationCalls: false },
      /** Handles the callback for this operation. */(calls) => {
        latestManualCalls.value = calls;
        latestManualCalls.loaded = true;
        emit();
      },
      errorCallback
    );
    const unsubscribeOrganization = canRunConsubancoOrganizationQuery(filters)
      ? subscribeToCalls(
        {
          ...filters,
          userId: undefined,
          uploadedBy: undefined,
          organizationId: CONSUBANCO_ORGANIZATION_ID,
          visibilityScope: 'organization',
          callSource: isDemoFirebaseProject ? filters.callSource : 'ccc_gcs',
          includeOrganizationCalls: false,
        },
        /** Handles the callback for this operation. */(calls) => {
          latestOrganizationCalls.value = calls;
          latestOrganizationCalls.loaded = true;
          emit();
        },
        errorCallback
      )
      : /** Handles the callback for this operation. */() => undefined;
    return /** Handles the callback for this operation. */() => {
      unsubscribeManual();
      unsubscribeOrganization();
    };
  }

  const constraints: QueryConstraint[] = [];

  const uploadedByFilter = filters.uploadedBy ?? filters.userId;
  if (uploadedByFilter) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('uploadedBy', '==', uploadedByFilter));
  }

  if (filters.organizationId) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('organizationId', '==', filters.organizationId));
  }

  if (filters.visibilityScope) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('visibilityScope', '==', filters.visibilityScope));
  }

  if (filters.callSource) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('callSource', '==', filters.callSource));
  }

  if (filters.environmentTarget) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('environmentTarget', '==', filters.environmentTarget));
  }

  if (filters.analysisPipeline) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('analysisPipeline', '==', filters.analysisPipeline));
  }

  if (filters.salesAgentId) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('salesAgentId', '==', filters.salesAgentId));
  }

  if (filters.matchedAgentAnalysisId) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('matchedAgentAnalysisId', '==', filters.matchedAgentAnalysisId));
  }

  if (filters.agentRoutingMode) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('agentRoutingMode', '==', filters.agentRoutingMode));
  }

  if (filters.agentRoutingStatus) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('agentRoutingStatus', '==', filters.agentRoutingStatus));
  } else if (filters.agentRoutingStatuses?.length) {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('agentRoutingStatus', 'in', filters.agentRoutingStatuses));
  }

  if (filters.category && filters.category !== 'all') {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('category', '==', filters.category));
  }

  if (filters.status && filters.status !== 'all') {
    /** Calls an external SDK or API dependency. */
    constraints.push(where('status', '==', filters.status));
  }

  /** Calls an external SDK or API dependency. */
  constraints.push(orderBy(filters.sortBy ?? 'createdAt', filters.sortOrder ?? 'desc'));

  if (filters.maxResults) {
    /** Calls an external SDK or API dependency. */
    constraints.push(limit(filters.maxResults));
  }

  /** Calls an external SDK or API dependency. */
  const q = query(collection(db, CALLS_COLLECTION), ...constraints);

  return onSnapshot(
    q,
    /** Handles the callback for this operation. */
    (snapshot) => {
      const calls = snapshot.docs.map(/** Handles the callback for this operation. */(doc) =>
        docToCall(doc.id, doc.data(), { registerDemoTerms: filters.skipDemoTermRegistration !== true })
      );
      callback(calls);
    },
    /** Handles the callback for this operation. */
    (error) => {
      console.error('Calls subscription error:', error);
      errorCallback?.(error);
    }
  );
}

/** Documents the subscribeToAgentLinkedCalls behavior. */
export function subscribeToAgentLinkedCalls(
  input: { userId: string; agentAnalysisId: string; salesAgentId: string; environmentTarget?: Call['environmentTarget'] },
  callback: (calls: Call[]) => void
): () => void {
  const callsBySalesAgentId = new Map<string, Call>();
  const callsByMatchedAgentAnalysisId = new Map<string, Call>();
  const baseFilters: CallFilters = input.environmentTarget
    ? {
      organizationId: CONSUBANCO_ORGANIZATION_ID,
      visibilityScope: 'organization',
      callSource: 'ccc_gcs',
      environmentTarget: input.environmentTarget,
      includeOrganizationCalls: false,
    }
    : { userId: input.userId };
  let salesAgentIdLoaded = false;
  let matchedAgentAnalysisIdLoaded = false;

  const emit = /** Documents the emit behavior. */ () => {
    if (!salesAgentIdLoaded || !matchedAgentAnalysisIdLoaded) return;
    const merged = new Map<string, Call>();
    for (const call of callsByMatchedAgentAnalysisId.values()) {
      merged.set(call.id, call);
    }
    for (const call of callsBySalesAgentId.values()) {
      merged.set(call.id, call);
    }
    callback(
      Array.from(merged.values())
        .filter(/** Handles the callback for this operation. */(call) => call.agentProfileExcluded !== true)
        .sort(
        /** Handles the callback for this operation. */
        (left, right) => compareCallsByBusinessDateDesc(left, right)
      )
    );
  };

  const unsubscribeBySalesAgentId = subscribeToCalls(
    {
      ...baseFilters,
      salesAgentId: input.salesAgentId,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    },
    /** Handles the callback for this operation. */(calls) => {
      callsBySalesAgentId.clear();
      calls.forEach(/** Handles the callback for this operation. */(call) => {
        callsBySalesAgentId.set(call.id, call);
      });
      salesAgentIdLoaded = true;
      emit();
    },
    /** Handles the callback for this operation. */(error) => {
      console.error('Agent linked calls salesAgentId subscription error:', error);
      salesAgentIdLoaded = true;
      emit();
    }
  );

  const unsubscribeByMatchedAgentAnalysisId = subscribeToCalls(
    {
      ...baseFilters,
      matchedAgentAnalysisId: input.agentAnalysisId,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    },
    /** Handles the callback for this operation. */(calls) => {
      callsByMatchedAgentAnalysisId.clear();
      calls.forEach(/** Handles the callback for this operation. */(call) => {
        callsByMatchedAgentAnalysisId.set(call.id, call);
      });
      matchedAgentAnalysisIdLoaded = true;
      emit();
    },
    /** Handles the callback for this operation. */(error) => {
      console.error('Agent linked calls matchedAgentAnalysisId subscription error:', error);
      matchedAgentAnalysisIdLoaded = true;
      emit();
    }
  );

  return /** Handles the callback for this operation. */ () => {
    unsubscribeBySalesAgentId();
    unsubscribeByMatchedAgentAnalysisId();
  };
}

// Fetch transcript for a call
export async function fetchTranscript(callId: string): Promise<Transcript | null> {
  /** Calls an external SDK or API dependency. */
  const docRef = doc(db, CALLS_COLLECTION, callId, 'transcript', 'data');
  /** Calls an external SDK or API dependency. */
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  const transcript = snapshot.data() as Transcript;
  registerKespDemoTranscriptTerms(transcript);
  return transcript;
}

// Fetch feedback for a call (supports versioned feedback with backwards compatibility)
export async function fetchFeedback(callId: string): Promise<Feedback | null> {
  // First, try to get the latestFeedbackId from the call document
  const callDocRef = doc(db, CALLS_COLLECTION, callId);
  /** Calls an external SDK or API dependency. */
  const callSnapshot = await getDoc(callDocRef);

  if (!callSnapshot.exists()) {
    return null;
  }

  const callData = callSnapshot.data();
  const feedbackDocId = callData?.latestFeedbackId || 'data'; // Fallback to 'data' for old calls

  const feedbackDocRef = doc(db, CALLS_COLLECTION, callId, 'feedback', feedbackDocId);
  /** Calls an external SDK or API dependency. */
  const feedbackSnapshot = await getDoc(feedbackDocRef);

  if (!feedbackSnapshot.exists()) {
    // If latestFeedbackId doesn't exist, try falling back to 'data'
    if (feedbackDocId !== 'data') {
      /** Calls an external SDK or API dependency. */
      const fallbackDocRef = doc(db, CALLS_COLLECTION, callId, 'feedback', 'data');
      /** Calls an external SDK or API dependency. */
      const fallbackSnapshot = await getDoc(fallbackDocRef);
      if (fallbackSnapshot.exists()) {
        return normalizeFeedbackDocument(
          fallbackSnapshot.data(),
          typeof callData?.salesAgentName === 'string' ? callData.salesAgentName : null
        );
      }
    }
    return null;
  }

  return normalizeFeedbackDocument(
    feedbackSnapshot.data(),
    typeof callData?.salesAgentName === 'string' ? callData.salesAgentName : null
  );
}

// Internal: fetch feedback when we already know the feedbackDocId (avoids re-reading call doc)
async function fetchFeedbackDirect(
  callId: string,
  latestFeedbackId?: string,
  fallbackAgentName?: string | null
): Promise<Feedback | null> {
  const feedbackDocId = latestFeedbackId || 'data';

  /** Calls an external SDK or API dependency. */
  const feedbackDocRef = doc(db, CALLS_COLLECTION, callId, 'feedback', feedbackDocId);
  /** Calls an external SDK or API dependency. */
  const feedbackSnapshot = await getDoc(feedbackDocRef);

  if (!feedbackSnapshot.exists()) {
    if (feedbackDocId !== 'data') {
      /** Calls an external SDK or API dependency. */
      const fallbackDocRef = doc(db, CALLS_COLLECTION, callId, 'feedback', 'data');
      /** Calls an external SDK or API dependency. */
      const fallbackSnapshot = await getDoc(fallbackDocRef);
      if (fallbackSnapshot.exists()) {
        return normalizeFeedbackDocument(fallbackSnapshot.data(), fallbackAgentName);
      }
    }
    return null;
  }

  return normalizeFeedbackDocument(feedbackSnapshot.data(), fallbackAgentName);
}

// Get call statistics
export interface CallStats {
  total: number;
  good: number;
  medium: number;
  bad: number;
  unknown: number;
  processing: number;
  complete: number;
  errors: number;
  loansCompleted: number;
  loansNotCompleted: number;
  loansUnclear: number;
}

/** Documents the fetchCallStats behavior. */
export async function fetchCallStats(userId?: string): Promise<CallStats> {
  const calls = await fetchCalls({ userId });

  const stats: CallStats = {
    total: calls.length,
    good: 0,
    medium: 0,
    bad: 0,
    unknown: 0,
    processing: 0,
    complete: 0,
    errors: 0,
    loansCompleted: 0,
    loansNotCompleted: 0,
    loansUnclear: 0,
  };

  for (const call of calls) {
    // Count by category
    if (call.category === 'good') stats.good++;
    else if (call.category === 'medium') stats.medium++;
    else if (call.category === 'bad') stats.bad++;
    else if (call.category === 'unknown') stats.unknown++;

    // Count by status
    if (call.status === 'complete') stats.complete++;
    else if (call.status === 'error') stats.errors++;
    else if (call.status !== 'uploaded' && call.status !== 'canceled') stats.processing++;
  }

  // For loan stats, fetch feedback for completed calls in parallel
  const completedCalls = calls.filter(/** Handles the callback for this operation. */(c) => c.status === 'complete');
  const feedbackResults = await Promise.all(
    completedCalls.map(/** Handles the callback for this operation. */(call) =>
      fetchFeedbackDirect(call.id, call.latestFeedbackId, call.salesAgentName ?? null)
    )
  );
  for (const feedback of feedbackResults) {
    if (feedback) {
      if (feedback.loan_completed === 'yes') stats.loansCompleted++;
      else if (feedback.loan_completed === 'no') stats.loansNotCompleted++;
      else stats.loansUnclear++;
    }
  }

  return stats;
}

// Fetch analysis run with its task docs (for prompt version display)
export interface AnalysisRunInfo {
  runId: string;
  analysisMode: string;
  promptPaths: Record<string, string>;
  analyzerModel?: string;
  status: string;
  totalTasks: number;
  completedTasks: number;
  createdAt?: Date;
  finalizedAt?: Date;
}

export interface TaskInfo {
  taskId: string;
  prompt: string;
  model: string;
  status: string;
  completedAt?: Date;
}

/** Documents the fetchAnalysisRunWithTasks behavior. */
export async function fetchAnalysisRunWithTasks(
  callId: string,
  runId: string
): Promise<{ run: AnalysisRunInfo; tasks: TaskInfo[] } | null> {
  /** Calls an external SDK or API dependency. */
  const runRef = doc(db, CALLS_COLLECTION, callId, 'analysis_runs', runId);
  const tasksRef = collection(db, CALLS_COLLECTION, callId, 'analysis_runs', runId, 'tasks');

  /** Calls an external SDK or API dependency. */
  const [runSnap, tasksSnap] = await Promise.all([getDoc(runRef), getDocs(tasksRef)]);

  if (!runSnap.exists()) {
    return null;
  }

  const runData = runSnap.data();
  const run: AnalysisRunInfo = {
    runId,
    analysisMode: runData.analysisMode ?? 'unknown',
    promptPaths: runData.promptPaths ?? {},
    analyzerModel: typeof runData.analyzerModel === 'string' ? runData.analyzerModel : undefined,
    status: runData.status ?? 'unknown',
    totalTasks: runData.totalTasks ?? 0,
    completedTasks: runData.completedTasks ?? 0,
    createdAt: timestampToDate(runData.createdAt),
    finalizedAt: timestampToDate(runData.finalizedAt),
  };

  const tasks: TaskInfo[] = tasksSnap.docs.map(/** Handles the callback for this operation. */(d) => {
    const td = d.data();
    return {
      taskId: d.id,
      prompt: td.prompt ?? '',
      model: td.model ?? '',
      status: td.status ?? 'unknown',
      completedAt: timestampToDate(td.completedAt),
    };
  });

  return { run, tasks };
}

// Fetch allowed emails from config collection
export async function fetchAllowedEmails(): Promise<string[]> {
  try {
    /** Calls an external SDK or API dependency. */
    const docRef = doc(db, 'config', 'allowedEmails');
    /** Calls an external SDK or API dependency. */
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      const data = docSnap.data();
      return Array.isArray(data.emails) ? data.emails : [];
    }
    return [];
  } catch (error) {
    console.error('Error fetching allowed emails:', error);
    return [];
  }
}


export async function fetchShortCallReview(callId: string): Promise<ManualShortCallReview | null> {
  /** Calls an external SDK or API dependency. */
  const docRef = doc(db, CALLS_COLLECTION, callId, 'short_call_review', 'data');
  /** Calls an external SDK or API dependency. */
  const snapshot = await getDoc(docRef);
  return snapshot.exists() ? normalizeShortCallReview(snapshot.data()) : null;
}

export async function fetchManualShortCallPattern(userId: string): Promise<ManualShortCallPatternSummary | null> {
  /** Calls an external SDK or API dependency. */
  const docRef = doc(db, 'manual_short_call_patterns', userId);
  /** Calls an external SDK or API dependency. */
  const snapshot = await getDoc(docRef);
  return snapshot.exists() ? normalizeManualShortCallPattern(snapshot.data()) : null;
}
