import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { cleanupAgentActivityForExcludedCall } from "./agentActivity";
import { createKespInboxMessage } from "./kespInbox";
import { isTranscriptionComparisonCall } from "./callExclusions";

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

export type DuplicateDetectedBy = "on_link" | "reanalyze" | "backfill";
export type DuplicateFingerprintSource = "sha256" | "gcs_md5";

interface DuplicateFingerprint {
  key: string;
  source: DuplicateFingerprintSource;
  value: string;
}

interface ProfileCallState {
  callId: string;
  createdAtMs: number;
  latestFeedbackId: string | null;
  audioContentHash: string | null;
  audioStorageMd5Hash: string | null;
  duplicateFingerprints: DuplicateFingerprint[];
  agentProfileExcluded: boolean;
  agentProfileExclusionReason: string | null;
  duplicateOfCallId: string | null;
  duplicateCacheKey: string | null;
  duplicateAudioHash: string | null;
  duplicateFingerprintKey: string | null;
  duplicateFingerprintSource: DuplicateFingerprintSource | null;
}

interface DuplicateGroupDecision {
  primaryFingerprintKey: string;
  primaryFingerprintSource: DuplicateFingerprintSource;
  primaryFingerprintValue: string;
  fingerprintKeys: string[];
  fingerprintValues: string[];
  audioContentHash: string | null;
  audioStorageMd5Hash: string | null;
  canonicalCallId: string;
  duplicateCallIds: string[];
}

/** Documents the normalizeOptionalString behavior. */
function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Documents the normalizeAudioContentHash behavior. */
function normalizeAudioContentHash(value: unknown): string | null {
  const normalized = normalizeOptionalString(value)?.toLowerCase() ?? null;
  if (!normalized) return null;
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

/** Documents the normalizeAudioStorageMd5Hash behavior. */
function normalizeAudioStorageMd5Hash(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ? normalized : null;
}

/** Documents the normalizeDuplicateFingerprintSource behavior. */
function normalizeDuplicateFingerprintSource(value: unknown): DuplicateFingerprintSource | null {
  return value === "sha256" || value === "gcs_md5" ? value : null;
}

/** Documents the createDuplicateFingerprint behavior. */
function createDuplicateFingerprint(
  source: DuplicateFingerprintSource,
  value: string
): DuplicateFingerprint {
  return {
    key: `${source}:${value}`,
    source,
    value,
  };
}

/** Documents the buildDuplicateFingerprints behavior. */
function buildDuplicateFingerprints(input: {
  audioContentHash?: unknown;
  audioStorageMd5Hash?: unknown;
}): DuplicateFingerprint[] {
  const fingerprints: DuplicateFingerprint[] = [];
  const audioContentHash = normalizeAudioContentHash(input.audioContentHash);
  const audioStorageMd5Hash = normalizeAudioStorageMd5Hash(input.audioStorageMd5Hash);

  if (audioContentHash) {
    fingerprints.push(createDuplicateFingerprint("sha256", audioContentHash));
  }
  if (audioStorageMd5Hash) {
    fingerprints.push(createDuplicateFingerprint("gcs_md5", audioStorageMd5Hash));
  }

  return fingerprints;
}

/** Documents the buildDuplicateFingerprintKeys behavior. */
export function buildDuplicateFingerprintKeys(input: {
  audioContentHash?: unknown;
  audioStorageMd5Hash?: unknown;
}): string[] {
  return buildDuplicateFingerprints(input).map(
    /** Handles the callback for this operation. */ (fingerprint) => fingerprint.key
  );
}

/** Documents the timestampMillis behavior. */
function timestampMillis(value: unknown): number {
  if (value instanceof admin.firestore.Timestamp) {
    return value.toMillis();
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return 0;
}

/** Documents the buildProfileCallState behavior. */
function buildProfileCallState(callId: string, callData: FirebaseFirestore.DocumentData): ProfileCallState {
  const audioContentHash = normalizeAudioContentHash(callData.audioContentHash);
  const audioStorageMd5Hash = normalizeAudioStorageMd5Hash(callData.audioStorageMd5Hash);
  return {
    callId,
    createdAtMs: timestampMillis(callData.createdAt),
    latestFeedbackId: normalizeOptionalString(callData.latestFeedbackId),
    audioContentHash,
    audioStorageMd5Hash,
    duplicateFingerprints: buildDuplicateFingerprints({ audioContentHash, audioStorageMd5Hash }),
    agentProfileExcluded: callData.agentProfileExcluded === true,
    agentProfileExclusionReason: normalizeOptionalString(callData.agentProfileExclusionReason),
    duplicateOfCallId: normalizeOptionalString(callData.duplicateOfCallId),
    duplicateCacheKey: normalizeOptionalString(callData.duplicateCacheKey),
    duplicateAudioHash: normalizeOptionalString(callData.duplicateAudioHash),
    duplicateFingerprintKey: normalizeOptionalString(callData.duplicateFingerprintKey),
    duplicateFingerprintSource: normalizeDuplicateFingerprintSource(callData.duplicateFingerprintSource),
  };
}

/** Documents the selectCanonicalCallId behavior. */
export function selectCanonicalCallId(calls: ProfileCallState[]): string {
  if (calls.length === 0) {
    throw new Error("selectCanonicalCallId requires at least one call");
  }

  const sorted = [...calls].sort(/** Handles the callback for this operation. */ (left, right) => {
    const leftCreated = left.createdAtMs || Number.MAX_SAFE_INTEGER;
    const rightCreated = right.createdAtMs || Number.MAX_SAFE_INTEGER;
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return left.callId.localeCompare(right.callId);
  });

  return sorted[0]?.callId ?? calls[0].callId;
}

/** Documents the uniqueSorted behavior. */
function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

/** Documents the sourceRank behavior. */
function sourceRank(source: DuplicateFingerprintSource): number {
  return source === "sha256" ? 0 : 1;
}

/** Documents the selectPrimaryFingerprint behavior. */
function selectPrimaryFingerprint(
  calls: ProfileCallState[],
  fingerprintKeys: string[]
): DuplicateFingerprint {
  const fingerprintByKey = new Map<string, DuplicateFingerprint>();
  for (const call of calls) {
    for (const fingerprint of call.duplicateFingerprints) {
      fingerprintByKey.set(fingerprint.key, fingerprint);
    }
  }

  const commonKeys = fingerprintKeys.filter(
    /** Handles the callback for this operation. */ (key) =>
      calls.every(
        /** Handles the callback for this operation. */ (call) =>
          call.duplicateFingerprints.some(
            /** Handles the callback for this operation. */ (fingerprint) => fingerprint.key === key
          )
      )
  );
  const candidateKeys = commonKeys.length > 0 ? commonKeys : fingerprintKeys;
  const candidates = candidateKeys
    .map(/** Handles the callback for this operation. */ (key) => fingerprintByKey.get(key))
    .filter(
      /** Handles the callback for this operation. */
      (fingerprint): fingerprint is DuplicateFingerprint => Boolean(fingerprint)
    )
    .sort(/** Handles the callback for this operation. */ (left, right) => {
      const sourceDelta = sourceRank(left.source) - sourceRank(right.source);
      if (sourceDelta !== 0) return sourceDelta;
      return left.key.localeCompare(right.key);
    });

  const selected = candidates[0];
  if (!selected) {
    throw new Error("selectPrimaryFingerprint requires at least one fingerprint");
  }
  return selected;
}

/** Documents the buildDuplicateDecisions behavior. */
export function buildDuplicateDecisions(profileCalls: ProfileCallState[]): DuplicateGroupDecision[] {
  const callById = new Map<string, ProfileCallState>();
  const callIdsByFingerprintKey = new Map<string, Set<string>>();

  for (const call of profileCalls) {
    callById.set(call.callId, call);
    for (const fingerprint of call.duplicateFingerprints) {
      const callIds = callIdsByFingerprintKey.get(fingerprint.key) ?? new Set<string>();
      callIds.add(call.callId);
      callIdsByFingerprintKey.set(fingerprint.key, callIds);
    }
  }

  const decisions: DuplicateGroupDecision[] = [];
  const visitedCallIds = new Set<string>();
  const callsWithFingerprints = profileCalls
    .filter(/** Handles the callback for this operation. */ (call) => call.duplicateFingerprints.length > 0)
    .sort(/** Handles the callback for this operation. */ (left, right) => left.callId.localeCompare(right.callId));

  for (const rootCall of callsWithFingerprints) {
    if (visitedCallIds.has(rootCall.callId)) continue;

    const componentCallIds = new Set<string>();
    const componentFingerprintKeys = new Set<string>();
    const pendingCallIds = [rootCall.callId];
    visitedCallIds.add(rootCall.callId);

    while (pendingCallIds.length > 0) {
      const currentCallId = pendingCallIds.shift();
      if (!currentCallId) continue;
      const currentCall = callById.get(currentCallId);
      if (!currentCall) continue;
      componentCallIds.add(currentCallId);

      for (const fingerprint of currentCall.duplicateFingerprints) {
        componentFingerprintKeys.add(fingerprint.key);
        const relatedCallIds = Array.from(callIdsByFingerprintKey.get(fingerprint.key) ?? []).sort();
        for (const relatedCallId of relatedCallIds) {
          if (visitedCallIds.has(relatedCallId)) continue;
          visitedCallIds.add(relatedCallId);
          pendingCallIds.push(relatedCallId);
        }
      }
    }

    const calls = Array.from(componentCallIds.values())
      .map(/** Handles the callback for this operation. */ (callId) => callById.get(callId))
      .filter(
        /** Handles the callback for this operation. */
        (call): call is ProfileCallState => Boolean(call)
      );
    if (calls.length <= 1) continue;

    const fingerprintKeys = Array.from(componentFingerprintKeys.values()).sort();
    const primaryFingerprint = selectPrimaryFingerprint(calls, fingerprintKeys);
    const fingerprintValues = uniqueSorted(
      calls.flatMap(
        /** Handles the callback for this operation. */ (call) =>
          call.duplicateFingerprints.map(
            /** Handles the callback for this operation. */ (fingerprint) => fingerprint.value
          )
      )
    );
    const audioContentHash =
      uniqueSorted(
        calls
          .map(/** Handles the callback for this operation. */ (call) => call.audioContentHash)
          .filter(
            /** Handles the callback for this operation. */
            (value): value is string => Boolean(value)
          )
      )[0] ?? null;
    const audioStorageMd5Hash =
      uniqueSorted(
        calls
          .map(/** Handles the callback for this operation. */ (call) => call.audioStorageMd5Hash)
          .filter(
            /** Handles the callback for this operation. */
            (value): value is string => Boolean(value)
          )
      )[0] ?? null;
    const canonicalCallId = selectCanonicalCallId(calls);
    const duplicateCallIds = calls
      .map(/** Handles the callback for this operation. */ (call) => call.callId)
      .filter(/** Handles the callback for this operation. */ (callId) => callId !== canonicalCallId)
      .sort();
    decisions.push({
      primaryFingerprintKey: primaryFingerprint.key,
      primaryFingerprintSource: primaryFingerprint.source,
      primaryFingerprintValue: primaryFingerprint.value,
      fingerprintKeys,
      fingerprintValues,
      audioContentHash,
      audioStorageMd5Hash,
      canonicalCallId,
      duplicateCallIds,
    });
  }

  return decisions.sort(
    /** Handles the callback for this operation. */ (left, right) =>
      left.primaryFingerprintKey.localeCompare(right.primaryFingerprintKey)
  );
}

export interface ReconcileAgentProfileDuplicatesParams {
  uploadedBy: string;
  salesAgentId: string;
  detectedBy: DuplicateDetectedBy;
  actorUserId: string;
  agentAnalysisId?: string;
  salesAgentName?: string;
  onlyAudioContentHash?: string;
  onlyAudioStorageMd5Hash?: string;
}

export interface ReconcileAgentProfileDuplicatesResult {
  scannedCallCount: number;
  duplicateGroupCount: number;
  canonicalByAudioHash: Record<string, string>;
  canonicalByDuplicateFingerprint: Record<string, string>;
  canonicalCallIds: string[];
  newlyExcludedCallIds: string[];
  inboxMessageCount: number;
}

/** Documents the emptyReconcileResult behavior. */
function emptyReconcileResult(): ReconcileAgentProfileDuplicatesResult {
  return {
    scannedCallCount: 0,
    duplicateGroupCount: 0,
    canonicalByAudioHash: {},
    canonicalByDuplicateFingerprint: {},
    canonicalCallIds: [],
    newlyExcludedCallIds: [],
    inboxMessageCount: 0,
  };
}

/** Documents the decisionMatchesStoredDuplicate behavior. */
function decisionMatchesStoredDuplicate(
  entry: ProfileCallState,
  decision: DuplicateGroupDecision
): boolean {
  const storedKeys = [entry.duplicateFingerprintKey, entry.duplicateCacheKey].filter(
    /** Handles the callback for this operation. */
    (value): value is string => Boolean(value)
  );
  const storedValues = [entry.duplicateAudioHash, entry.duplicateCacheKey].filter(
    /** Handles the callback for this operation. */
    (value): value is string => Boolean(value)
  );

  return (
    storedKeys.some(
      /** Handles the callback for this operation. */ (value) => decision.fingerprintKeys.includes(value)
    ) ||
    storedValues.some(
      /** Handles the callback for this operation. */ (value) => decision.fingerprintValues.includes(value)
    )
  );
}

/** Documents the reconcileAgentProfileDuplicates behavior. */
export async function reconcileAgentProfileDuplicates(
  params: ReconcileAgentProfileDuplicatesParams
): Promise<ReconcileAgentProfileDuplicatesResult> {
  const uploadedBy = params.uploadedBy.trim();
  const salesAgentId = params.salesAgentId.trim();
  if (!uploadedBy || !salesAgentId) {
    return emptyReconcileResult();
  }

  let callQuery: FirebaseFirestore.Query = db
    .collection("calls")
    .where("uploadedBy", "==", uploadedBy)
    .where("salesAgentId", "==", salesAgentId)
    .where("status", "==", "complete");

  const onlyAudioContentHash = normalizeAudioContentHash(params.onlyAudioContentHash);
  const onlyAudioStorageMd5Hash = normalizeAudioStorageMd5Hash(params.onlyAudioStorageMd5Hash);
  if (onlyAudioStorageMd5Hash) {
    callQuery = callQuery.where("audioStorageMd5Hash", "==", onlyAudioStorageMd5Hash);
  } else if (onlyAudioContentHash) {
    callQuery = callQuery.where("audioContentHash", "==", onlyAudioContentHash);
  }

  /** Calls Firebase Firestore to read calls for duplicate reconciliation. */
  const callsSnapshot = await callQuery.get();
  const profileCalls: Array<{ ref: FirebaseFirestore.DocumentReference; state: ProfileCallState }> =
    callsSnapshot.docs.filter(
      /** Comparisons cannot become canonical, exclude real calls, or receive duplicate repairs. */
      (doc) => !isTranscriptionComparisonCall(doc.data())
    ).map(/** Handles the callback for this operation. */ (doc) => ({
      ref: doc.ref,
      state: buildProfileCallState(doc.id, doc.data()),
    }));

  const decisions = buildDuplicateDecisions(profileCalls.map(/** Handles the callback for this operation. */ (entry) => entry.state));
  const canonicalCallIds = new Set<string>();
  const canonicalByAudioHash: Record<string, string> = {};
  const canonicalByDuplicateFingerprint: Record<string, string> = {};
  const newlyExcludedCallIds: string[] = [];

  for (const decision of decisions) {
    canonicalCallIds.add(decision.canonicalCallId);
    for (const fingerprintKey of decision.fingerprintKeys) {
      canonicalByDuplicateFingerprint[fingerprintKey] = decision.canonicalCallId;
      if (fingerprintKey.startsWith("sha256:")) {
        canonicalByAudioHash[fingerprintKey.slice("sha256:".length)] = decision.canonicalCallId;
      }
    }

    for (const duplicateCallId of decision.duplicateCallIds) {
      const entry = profileCalls.find(/** Handles the callback for this operation. */ (candidate) => candidate.state.callId === duplicateCallId);
      if (!entry) continue;

      const alreadyExcludedCorrectly =
        entry.state.agentProfileExcluded === true &&
        entry.state.agentProfileExclusionReason === "duplicate_call" &&
        entry.state.duplicateOfCallId === decision.canonicalCallId &&
        decisionMatchesStoredDuplicate(entry.state, decision);

      if (alreadyExcludedCorrectly) {
        continue;
      }

      /** Calls Firebase Firestore to soft-exclude duplicate calls from agent-profile surfaces. */
      await entry.ref.update({
        agentProfileExcluded: true,
        agentProfileExclusionReason: "duplicate_call",
        duplicateOfCallId: decision.canonicalCallId,
        duplicateAudioHash: decision.primaryFingerprintValue,
        duplicateCacheKey: decision.primaryFingerprintKey,
        duplicateFingerprintKey: decision.primaryFingerprintKey,
        duplicateFingerprintSource: decision.primaryFingerprintSource,
        duplicateDetectedAt: FieldValue.serverTimestamp(),
        duplicateDetectedBy: params.detectedBy,
        updatedAt: FieldValue.serverTimestamp(),
      });
      newlyExcludedCallIds.push(duplicateCallId);

      /** Calls Firebase Firestore to remove duplicate calls from agent activity surfaces. */
      await cleanupAgentActivityForExcludedCall({
        uploadedBy,
        salesAgentId,
        callId: duplicateCallId,
      });

      /** Calls Firebase Firestore to notify the user that a duplicate call was excluded. */
      await createKespInboxMessage({
        userId: uploadedBy,
        type: "duplicate_call_excluded",
        agentAnalysisId: params.agentAnalysisId,
        salesAgentId,
        salesAgentName: params.salesAgentName,
        callId: duplicateCallId,
        duplicateOfCallId: decision.canonicalCallId,
        duplicateCacheKey: decision.primaryFingerprintKey,
        duplicateAudioHash: decision.primaryFingerprintValue,
        duplicateFingerprintKey: decision.primaryFingerprintKey,
        duplicateFingerprintSource: decision.primaryFingerprintSource,
        source: params.detectedBy,
      });
    }

    const canonicalEntry = profileCalls.find(
      /** Handles the callback for this operation. */ (candidate) => candidate.state.callId === decision.canonicalCallId
    );
    if (
      canonicalEntry &&
      canonicalEntry.state.agentProfileExcluded === true &&
      canonicalEntry.state.agentProfileExclusionReason === "duplicate_call"
    ) {
      /** Calls Firebase Firestore to restore canonical calls that were previously excluded as duplicates. */
      await canonicalEntry.ref.update({
        agentProfileExcluded: FieldValue.delete(),
        agentProfileExclusionReason: FieldValue.delete(),
        duplicateOfCallId: FieldValue.delete(),
        duplicateCacheKey: FieldValue.delete(),
        duplicateAudioHash: FieldValue.delete(),
        duplicateFingerprintKey: FieldValue.delete(),
        duplicateFingerprintSource: FieldValue.delete(),
        duplicateDetectedAt: FieldValue.delete(),
        duplicateDetectedBy: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }

  return {
    scannedCallCount: profileCalls.length,
    duplicateGroupCount: decisions.length,
    canonicalByAudioHash,
    canonicalByDuplicateFingerprint,
    canonicalCallIds: Array.from(canonicalCallIds.values()).sort(),
    newlyExcludedCallIds,
    inboxMessageCount: newlyExcludedCallIds.length,
  };
}
