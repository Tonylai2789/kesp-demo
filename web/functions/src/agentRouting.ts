import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  ActiveCallAgentDefinition,
  AgentNameMatchResult,
  matchActiveAgentName,
  normalizeAgentNameForMatching,
} from "./activeCallAgents";
import { buildAgentKey, syncAgentActivityForCall } from "./agentActivity";
import { readDemoMember, demoId } from "./demoAccess";
import { assertDemoRuntime } from "./demoBudget";
import { DEMO_ORGANIZATION_ID, isDemoManualCall } from "./demoConfig";
import { buildDuplicateFingerprintKeys, reconcileAgentProfileDuplicates } from "./agentDuplicateCalls";

/** Calls Firebase Firestore to read or write persisted application data. */
const db = admin.firestore();

export type AgentRoutingMode = "none" | "specific" | "general";
export type AgentRoutingStatus =
  | "not_applicable"
  | "pending"
  | "matched"
  | "unrecognized"
  | "manually_assigned"
  | "no_agent"
  | "pending_mapping";

export interface ActiveAgentProfileSummary {
  agentAnalysisId: string;
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  activeAgentProfileKey: string;
  activeAgentDisplayName: string;
}

export interface SeedActiveAgentProfilesResult {
  success: true;
  createdCount: number;
  adoptedCount: number;
  unchangedCount: number;
  duplicateProfileIds: string[];
  profiles: ActiveAgentProfileSummary[];
}

export interface RouteGeneralAgentCallResult {
  routed: boolean;
  routingStatus?: AgentRoutingStatus;
  callUpdate: Record<string, unknown>;
  materializedCallFields: Record<string, unknown>;
}

export interface AgentProfileLinkExample {
  callId: string;
  salesAgentId?: string;
  salesAgentName?: string;
  matchedAgentAnalysisId?: string;
  matchedAgentProfileKey?: string;
  expectedAgentAnalysisId?: string;
  expectedSalesAgentId?: string;
  reason: string;
}

export interface AgentProfileLinkDiagnosticBucket {
  count: number;
  examples: AgentProfileLinkExample[];
}

export interface AgentProfileCallLinkDiagnosticResult {
  success: true;
  scannedCount: number;
  healthy: AgentProfileLinkDiagnosticBucket;
  missingSalesAgentId: AgentProfileLinkDiagnosticBucket;
  staleSalesAgentId: AgentProfileLinkDiagnosticBucket;
  missingMatchedAgentAnalysisId: AgentProfileLinkDiagnosticBucket;
  unknownTarget: AgentProfileLinkDiagnosticBucket;
  needsActivitySync: AgentProfileLinkDiagnosticBucket;
}

export interface AgentProfileCallLinkRepairResult {
  success: true;
  dryRun: boolean;
  scannedCount: number;
  repairedCount: number;
  activitySyncedCount: number;
  skippedCount: number;
  moreRemaining: boolean;
  examples: AgentProfileLinkExample[];
}

export interface OwnedAgentProfileSummary {
  agentAnalysisId: string;
  uploadedBy: string;
  salesAgentId: string;
  salesAgentName: string;
  activeAgentProfileKey?: string;
  activeAgentDisplayName?: string;
}

export interface AgentProfileLinkContext {
  profileById: Map<string, OwnedAgentProfileSummary>;
  profileBySalesAgentId: Map<string, OwnedAgentProfileSummary>;
  profileByActiveKey: Map<string, OwnedAgentProfileSummary>;
  profileByNormalizedName: Map<string, OwnedAgentProfileSummary>;
}

type AgentProfileLinkBucketName =
  | "healthy"
  | "missingSalesAgentId"
  | "staleSalesAgentId"
  | "missingMatchedAgentAnalysisId"
  | "unknownTarget";

interface AgentProfileCallLinkEvaluation {
  bucketName: AgentProfileLinkBucketName;
  callId: string;
  callData: FirebaseFirestore.DocumentData;
  expectedProfile?: OwnedAgentProfileSummary;
  reason: string;
}

/** Documents the normalizeOptionalString behavior. */
function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

/** Documents the serializeMatchCandidates behavior. */
function serializeMatchCandidates(match: AgentNameMatchResult) {
  return match.candidates.slice(0, 3).map(/** Handles the callback for this operation. */(candidate) => ({
    activeAgentProfileKey: candidate.profileKey,
    salesAgentName: candidate.displayName,
    score: candidate.score,
    method: match.method,
    ...(match.reason === "matched" ? {} : { reason: match.reason }),
    matchedTokenCount: candidate.matchedTokenCount,
    distinctiveTokenCount: candidate.distinctiveTokenCount,
  }));
}

/** Documents the createEmptyBucket behavior. */
function createEmptyBucket(): AgentProfileLinkDiagnosticBucket {
  return { count: 0, examples: [] };
}

/** Documents the addBucketExample behavior. */
function addBucketExample(
  bucket: AgentProfileLinkDiagnosticBucket,
  example: AgentProfileLinkExample
): void {
  bucket.count += 1;
  if (bucket.examples.length < 20) {
    bucket.examples.push(example);
  }
}

/** Documents the linkExampleFromEvaluation behavior. */
function linkExampleFromEvaluation(
  evaluation: AgentProfileCallLinkEvaluation
): AgentProfileLinkExample {
  return {
    callId: evaluation.callId,
    salesAgentId: normalizeOptionalString(evaluation.callData.salesAgentId),
    salesAgentName: normalizeOptionalString(evaluation.callData.salesAgentName),
    matchedAgentAnalysisId: normalizeOptionalString(evaluation.callData.matchedAgentAnalysisId),
    matchedAgentProfileKey: normalizeOptionalString(evaluation.callData.matchedAgentProfileKey),
    expectedAgentAnalysisId: evaluation.expectedProfile?.agentAnalysisId,
    expectedSalesAgentId: evaluation.expectedProfile?.salesAgentId,
    reason: evaluation.reason,
  };
}

/** Documents the createAgentProfileLinkContext behavior. */
export function createAgentProfileLinkContext(
  profiles: OwnedAgentProfileSummary[]
): AgentProfileLinkContext {
  const profileById = new Map<string, OwnedAgentProfileSummary>();
  const profileBySalesAgentId = new Map<string, OwnedAgentProfileSummary>();
  const profileByActiveKey = new Map<string, OwnedAgentProfileSummary>();
  const profileByNormalizedName = new Map<string, OwnedAgentProfileSummary>();

  for (const profile of profiles) {
    profileById.set(profile.agentAnalysisId, profile);
    profileBySalesAgentId.set(profile.salesAgentId, profile);
    if (profile.activeAgentProfileKey) {
      profileByActiveKey.set(profile.activeAgentProfileKey, profile);
    }
    const normalizedName = normalizeAgentNameForMatching(profile.salesAgentName);
    if (normalizedName && !profileByNormalizedName.has(normalizedName)) {
      profileByNormalizedName.set(normalizedName, profile);
    }
    if (profile.activeAgentDisplayName) {
      const normalizedActiveName = normalizeAgentNameForMatching(profile.activeAgentDisplayName);
      if (normalizedActiveName) {
        profileByNormalizedName.set(normalizedActiveName, profile);
      }
    }
  }

  return {
    profileById,
    profileBySalesAgentId,
    profileByActiveKey,
    profileByNormalizedName,
  };
}

/** Requires an enabled, allowlisted Google-authenticated demo staff member. */
async function assertDemoRoutingStaff(uid: string): Promise<void> {
  assertDemoRuntime(process.env, admin.apps.length ? admin.app().options.projectId : undefined);
  const member = await readDemoMember(uid, db);
  if (!member || !["admin", "supervisor"].includes(member.role)) {
    throw new HttpsError("permission-denied", "An active demo staff membership is required");
  }
}

function sharedDemoProfile(id: string, data: FirebaseFirestore.DocumentData): ActiveAgentProfileSummary | null {
  const uploadedBy = normalizeOptionalString(data.uploadedBy);
  const salesAgentId = normalizeOptionalString(data.salesAgentId);
  const salesAgentName = normalizeOptionalString(data.salesAgentName);
  if (data.organizationId !== DEMO_ORGANIZATION_ID || data.visibilityScope !== "organization" ||
      !uploadedBy || !salesAgentId || !salesAgentName || data.isActiveAgentProfile === false) {
    return null;
  }
  return {
    agentAnalysisId: id, uploadedBy, salesAgentId, salesAgentName,
    activeAgentProfileKey: normalizeOptionalString(data.activeAgentProfileKey) ?? id,
    activeAgentDisplayName: salesAgentName,
  };
}

/** Reads existing shared demo profiles only; never creates or adopts a preset roster. */
async function loadPresetAgentProfiles(uploadedBy: string): Promise<ActiveAgentProfileSummary[]> {
  await assertDemoRoutingStaff(uploadedBy);
  const snapshot = await db.collection("agent_analyses")
    .where("organizationId", "==", DEMO_ORGANIZATION_ID)
    .where("visibilityScope", "==", "organization").get();
  return snapshot.docs.flatMap((doc) => {
    const profile = sharedDemoProfile(doc.id, doc.data());
    return profile ? [profile] : [];
  });
}

/** Documents the resolveExpectedAgentProfileForCall behavior. */
function resolveExpectedAgentProfileForCall(
  callData: FirebaseFirestore.DocumentData,
  context: AgentProfileLinkContext
): OwnedAgentProfileSummary | undefined {
  const matchedAgentProfileKey = normalizeOptionalString(callData.matchedAgentProfileKey);
  if (matchedAgentProfileKey) {
    const profile = context.profileByActiveKey.get(matchedAgentProfileKey);
    if (profile) {
      return profile;
    }
  }

  const matchedAgentAnalysisId = normalizeOptionalString(callData.matchedAgentAnalysisId);
  if (matchedAgentAnalysisId) {
    const profile = context.profileById.get(matchedAgentAnalysisId);
    if (profile) {
      return profile;
    }
  }

  const currentSalesAgentId = normalizeOptionalString(callData.salesAgentId);
  if (currentSalesAgentId) {
    const profile = context.profileBySalesAgentId.get(currentSalesAgentId);
    if (profile) {
      return profile;
    }
  }

  return undefined;
}

/** Documents the evaluateAgentProfileCallLink behavior. */
export function evaluateAgentProfileCallLink(
  callId: string,
  callData: FirebaseFirestore.DocumentData,
  context: AgentProfileLinkContext
): AgentProfileCallLinkEvaluation {
  const expectedProfile = resolveExpectedAgentProfileForCall(callData, context);
  if (!expectedProfile) {
    return {
      bucketName: "unknownTarget",
      callId,
      callData,
      reason: "No owned agent profile could be resolved for this routed general call.",
    };
  }

  const salesAgentId = normalizeOptionalString(callData.salesAgentId);
  if (!salesAgentId) {
    return {
      bucketName: "missingSalesAgentId",
      callId,
      callData,
      expectedProfile,
      reason: "Call has a matched agent name but no salesAgentId join key.",
    };
  }

  if (salesAgentId !== expectedProfile.salesAgentId) {
    return {
      bucketName: "staleSalesAgentId",
      callId,
      callData,
      expectedProfile,
      reason: "Call salesAgentId does not match the resolved agent profile.",
    };
  }

  const matchedAgentAnalysisId = normalizeOptionalString(callData.matchedAgentAnalysisId);
  if (matchedAgentAnalysisId !== expectedProfile.agentAnalysisId) {
    return {
      bucketName: "missingMatchedAgentAnalysisId",
      callId,
      callData,
      expectedProfile,
      reason: "Call salesAgentId is correct but matchedAgentAnalysisId is missing or stale.",
    };
  }

  return {
    bucketName: "healthy",
    callId,
    callData,
    expectedProfile,
    reason: "Call profile link matches the resolved agent profile.",
  };
}

/** Documents the buildAgentProfileCallLinkRepairUpdate behavior. */
export function buildAgentProfileCallLinkRepairUpdate(
  evaluation: AgentProfileCallLinkEvaluation
): {
  changed: boolean;
  update: Record<string, unknown>;
  materializedFields: Record<string, unknown>;
} {
  const expectedProfile = evaluation.expectedProfile;
  if (!expectedProfile || evaluation.bucketName === "healthy") {
    return { changed: false, update: {}, materializedFields: {} };
  }

  const desiredStatus =
    evaluation.callData.agentRoutingStatus === "manually_assigned" ||
      evaluation.callData.matchedBy === "manual"
      ? "manually_assigned"
      : "matched";
  const desiredFields: Record<string, unknown> = {
    salesAgentId: expectedProfile.salesAgentId,
    salesAgentName: expectedProfile.salesAgentName,
    matchedAgentAnalysisId: expectedProfile.agentAnalysisId,
    matchedAgentName: expectedProfile.salesAgentName,
    agentRoutingStatus: desiredStatus,
  };

  if (expectedProfile.activeAgentProfileKey) {
    desiredFields.matchedAgentProfileKey = expectedProfile.activeAgentProfileKey;
  }

  const update: Record<string, unknown> = {};
  const materializedFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(desiredFields)) {
    if (evaluation.callData[key] !== value) {
      update[key] = value;
      materializedFields[key] = value;
    }
  }

  if (!expectedProfile.activeAgentProfileKey && evaluation.callData.matchedAgentProfileKey) {
    update.matchedAgentProfileKey = FieldValue.delete();
  }

  if (Object.keys(update).length === 0) {
    return { changed: false, update: {}, materializedFields: {} };
  }

  /** Calls an external SDK or API dependency. */
  update.updatedAt = FieldValue.serverTimestamp();
  return { changed: true, update, materializedFields };
}

/** Documents the buildCallRoutingFieldsFromMatch behavior. */
export function buildCallRoutingFieldsFromMatch(params: {
  match: AgentNameMatchResult;
  profileByKey: Map<string, OwnedAgentProfileSummary>;
}): RouteGeneralAgentCallResult {
  const base = {
    agentRoutingMode: "general",
    matchedBy: "auto_feedback_agent_name",
    extractedAgentName: params.match.extractedName,
    extractedAgentNameNormalized: params.match.normalizedName,
    agentNameMatchMethod: params.match.method,
    agentNameMatchScore: params.match.confidence,
    agentNameMatchCandidates: serializeMatchCandidates(params.match),
  };

  if (params.match.status === "matched" && params.match.matchedAgent) {
    const profile = params.profileByKey.get(params.match.matchedAgent.profileKey);
    if (!profile) {
      const missingProfileFields = {
        ...base,
        agentRoutingStatus: "unrecognized",
        agentRoutingReason: "demo_profile_unavailable",
        requestedActiveAgentProfileKey: params.match.matchedAgent.profileKey,
        requestedSalesAgentName: params.match.matchedAgent.displayName,
        matchedAgentConfidence: params.match.confidence,
      };

      /** Calls an external SDK or API dependency. */
      return {
        routed: true,
        routingStatus: "unrecognized",
        callUpdate: {
          ...missingProfileFields,
          salesAgentId: FieldValue.delete(),
          salesAgentName: FieldValue.delete(),
          matchedAgentAnalysisId: FieldValue.delete(),
          matchedAgentProfileKey: FieldValue.delete(),
          matchedAgentName: FieldValue.delete(),
          matchedAt: FieldValue.serverTimestamp(),
        },
        materializedCallFields: missingProfileFields,
      };
    }

    {
      const matchedFields = {
        ...base,
        agentRoutingStatus: "matched",
        agentRoutingReason: "auto_match",
        salesAgentId: profile.salesAgentId,
        salesAgentName: profile.salesAgentName,
        matchedAgentAnalysisId: profile.agentAnalysisId,
        matchedAgentProfileKey: profile.activeAgentProfileKey ?? params.match.matchedAgent.profileKey,
        matchedAgentName: profile.salesAgentName,
        matchedAgentConfidence: params.match.confidence,
      };

      /** Calls an external SDK or API dependency. */
      return {
        routed: true,
        routingStatus: "matched",
        callUpdate: {
          ...matchedFields,
          matchedAt: FieldValue.serverTimestamp(),
        },
        materializedCallFields: matchedFields,
      };
    }
  }

  const unrecognizedFields = {
    ...base,
    agentRoutingStatus: "unrecognized",
    agentRoutingReason: params.match.reason,
    matchedAgentConfidence: params.match.confidence,
  };

  /** Calls an external SDK or API dependency. */
  return {
    routed: true,
    routingStatus: "unrecognized",
    callUpdate: {
      ...unrecognizedFields,
      salesAgentId: FieldValue.delete(),
      salesAgentName: FieldValue.delete(),
      matchedAgentAnalysisId: FieldValue.delete(),
      matchedAgentProfileKey: FieldValue.delete(),
      matchedAgentName: FieldValue.delete(),
      matchedAt: FieldValue.serverTimestamp(),
    },
    materializedCallFields: unrecognizedFields,
  };
}

/** Compatibility API: demo profiles are provisioned explicitly, never auto-seeded. */
export async function ensureActiveAgentProfilesForOwner(
  uploadedBy: string
): Promise<SeedActiveAgentProfilesResult> {
  const profiles = await loadPresetAgentProfiles(uploadedBy);
  return {
    success: true, createdCount: 0, adoptedCount: 0,
    unchangedCount: profiles.length, duplicateProfileIds: [], profiles,
  };
}

/** Documents the loadGeneralRoutedCalls behavior. */
async function loadGeneralRoutedCalls(
  uploadedBy: string,
  maxCalls?: number
): Promise<{
  docs: FirebaseFirestore.QueryDocumentSnapshot[];
  moreRemaining: boolean;
}> {
  const statuses: AgentRoutingStatus[] = ["matched", "manually_assigned"];
  const perStatusLimit = maxCalls ? maxCalls + 1 : undefined;
  const snapshots = await Promise.all(
    statuses.map(/** Handles the callback for this operation. */(status) => {
      /** Calls Firebase Firestore to read or write persisted application data. */
      let query = db
        .collection("calls")
        .where("uploadedBy", "==", uploadedBy)
        .where("agentRoutingMode", "==", "general")
        .where("agentRoutingStatus", "==", status)
        .orderBy("createdAt", "desc");

      if (perStatusLimit) {
        /** Calls an external SDK or API dependency. */
        query = query.limit(perStatusLimit);
      }

      return query.get();
    })
  );

  const mergedDocs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) {
      mergedDocs.set(doc.id, doc);
    }
  }

  const sortedDocs = Array.from(mergedDocs.values()).sort(/** Handles the callback for this operation. */(left, right) => {
    const leftMillis = timestampMillis(left.data().createdAt) || left.createTime.toMillis();
    const rightMillis = timestampMillis(right.data().createdAt) || right.createTime.toMillis();
    return rightMillis - leftMillis || left.id.localeCompare(right.id);
  });

  if (!maxCalls) {
    return { docs: sortedDocs, moreRemaining: false };
  }

  return {
    docs: sortedDocs.slice(0, maxCalls),
    moreRemaining: sortedDocs.length > maxCalls,
  };
}

/** Documents the activitySnapshotNeedsSync behavior. */
async function activitySnapshotNeedsSync(
  callId: string,
  callData: FirebaseFirestore.DocumentData,
  expectedProfile: OwnedAgentProfileSummary
): Promise<boolean> {
  const latestFeedbackId = normalizeOptionalString(callData.latestFeedbackId);
  if (callData.status !== "complete" || !latestFeedbackId) {
    return false;
  }

  const agentKey = buildAgentKey(expectedProfile.uploadedBy, expectedProfile.salesAgentId);
  /** Calls Firebase Firestore to read or write persisted application data. */
  const snapshotDoc = await db
    .collection("agent_activity")
    .doc(agentKey)
    .collection("call_snapshots")
    .doc(callId)
    .get();

  if (!snapshotDoc.exists) {
    return true;
  }

  const snapshotData = snapshotDoc.data() ?? {};
  return snapshotData.latestFeedbackId !== latestFeedbackId;
}

/** Documents the diagnoseAgentProfileCallLinksForOwner behavior. */
export async function diagnoseAgentProfileCallLinksForOwner(
  uploadedBy: string
): Promise<AgentProfileCallLinkDiagnosticResult> {
  if (!uploadedBy) {
    throw new HttpsError("invalid-argument", "uploadedBy is required");
  }

  const profiles = await loadPresetAgentProfiles(uploadedBy);
  const context = createAgentProfileLinkContext(profiles);
  const { docs } = await loadGeneralRoutedCalls(uploadedBy);
  const result: AgentProfileCallLinkDiagnosticResult = {
    success: true,
    scannedCount: docs.length,
    healthy: createEmptyBucket(),
    missingSalesAgentId: createEmptyBucket(),
    staleSalesAgentId: createEmptyBucket(),
    missingMatchedAgentAnalysisId: createEmptyBucket(),
    unknownTarget: createEmptyBucket(),
    needsActivitySync: createEmptyBucket(),
  };

  for (const doc of docs) {
    const evaluation = evaluateAgentProfileCallLink(doc.id, doc.data(), context);
    addBucketExample(result[evaluation.bucketName], linkExampleFromEvaluation(evaluation));
    if (
      evaluation.expectedProfile &&
      (await activitySnapshotNeedsSync(doc.id, evaluation.callData, evaluation.expectedProfile))
    ) {
      addBucketExample(result.needsActivitySync, {
        ...linkExampleFromEvaluation(evaluation),
        reason: "Completed call is missing an activity snapshot or has a stale latestFeedbackId.",
      });
    }
  }

  return result;
}

/** Documents the repairAgentProfileCallLinksForOwner behavior. */
export async function repairAgentProfileCallLinksForOwner(
  uploadedBy: string,
  options: { dryRun?: boolean; maxCalls?: number } = {}
): Promise<AgentProfileCallLinkRepairResult> {
  if (!uploadedBy) {
    throw new HttpsError("invalid-argument", "uploadedBy is required");
  }

  const dryRun = options.dryRun === true;
  const maxCalls =
    typeof options.maxCalls === "number" && Number.isFinite(options.maxCalls)
      ? Math.max(1, Math.min(Math.floor(options.maxCalls), 500))
      : 200;
  const profiles = await loadPresetAgentProfiles(uploadedBy);
  const context = createAgentProfileLinkContext(profiles);
  const { docs, moreRemaining } = await loadGeneralRoutedCalls(uploadedBy, maxCalls);

  let repairedCount = 0;
  let activitySyncedCount = 0;
  let skippedCount = 0;
  const examples: AgentProfileLinkExample[] = [];

  for (const doc of docs) {
    const callData = doc.data();
    const evaluation = evaluateAgentProfileCallLink(doc.id, callData, context);
    const repair = buildAgentProfileCallLinkRepairUpdate(evaluation);

    if (!repair.changed || !evaluation.expectedProfile) {
      if (
        evaluation.expectedProfile &&
        !dryRun &&
        (await activitySnapshotNeedsSync(doc.id, callData, evaluation.expectedProfile))
      ) {
        try {
          const syncResult = await syncAgentActivityForCall({
            callId: doc.id,
            callData,
          });
          if (syncResult.updated) {
            activitySyncedCount += 1;
          }
        } catch (error) {
          console.error(`Agent profile link repair activity sync failed for ${doc.id}:`, error);
        }
      }
      skippedCount += 1;
      continue;
    }

    repairedCount += 1;
    if (examples.length < 20) {
      examples.push(linkExampleFromEvaluation(evaluation));
    }

    if (dryRun) {
      continue;
    }

    await doc.ref.update(repair.update);
    const updatedCallData = {
      ...callData,
      ...repair.materializedFields,
    };
    if (updatedCallData.status === "complete" && normalizeOptionalString(updatedCallData.latestFeedbackId)) {
      try {
        const syncResult = await syncAgentActivityForCall({
          callId: doc.id,
          callData: updatedCallData,
        });
        if (syncResult.updated) {
          activitySyncedCount += 1;
        }
      } catch (error) {
        console.error(`Agent profile link repair activity sync failed for ${doc.id}:`, error);
      }
    }
  }

  return {
    success: true,
    dryRun,
    scannedCount: docs.length,
    repairedCount,
    activitySyncedCount,
    skippedCount,
    moreRemaining,
    examples,
  };
}

/** Documents the routeGeneralAgentCallAfterFeedback behavior. */
export async function routeGeneralAgentCallAfterFeedback(params: {
  callId: string;
  callData: FirebaseFirestore.DocumentData;
  feedback: Record<string, unknown>;
}): Promise<RouteGeneralAgentCallResult> {
  if (params.callData.agentRoutingMode !== "general") {
    return {
      routed: false,
      callUpdate: {},
      materializedCallFields: {},
    };
  }

  const uploadedBy = normalizeOptionalString(params.callData.uploadedBy);
  if (!uploadedBy) {
    return {
      routed: false,
      callUpdate: {},
      materializedCallFields: {},
    };
  }

  if (!isDemoManualCall(params.callData)) {
    throw new HttpsError("failed-precondition", "Only prepared demo manual calls can be routed");
  }
  const profiles = await loadPresetAgentProfiles(uploadedBy);
  const context = createAgentProfileLinkContext(profiles);

  if (normalizeOptionalString(params.callData.salesAgentId)) {
    const evaluation = evaluateAgentProfileCallLink(params.callId, params.callData, context);
    const repair = buildAgentProfileCallLinkRepairUpdate(evaluation);
    if (repair.changed) {
      return {
        routed: true,
        routingStatus:
          repair.materializedFields.agentRoutingStatus === "manually_assigned"
            ? "manually_assigned"
            : "matched",
        callUpdate: repair.update,
        materializedCallFields: repair.materializedFields,
      };
    }
    if (evaluation.bucketName === "healthy") {
      return {
        routed: false,
        routingStatus: "matched",
        callUpdate: {},
        materializedCallFields: {},
      };
    }
    return {
      routed: false,
      routingStatus:
        params.callData.agentRoutingStatus === "manually_assigned"
          ? "manually_assigned"
          : undefined,
      callUpdate: {},
      materializedCallFields: {},
    };
  }

  const profileByKey = new Map(
    profiles
      .filter(/** Handles the callback for this operation. */(profile) => Boolean(profile.activeAgentProfileKey))
      .map(/** Handles the callback for this operation. */(profile) => [profile.activeAgentProfileKey as string, profile])
  );
  const definitions: ActiveCallAgentDefinition[] = profiles.map((profile) => {
    const normalizedName = normalizeAgentNameForMatching(profile.salesAgentName);
    return {
      displayName: profile.salesAgentName, salesAgentId: profile.salesAgentId,
      profileKey: profile.activeAgentProfileKey, normalizedName,
      tokens: normalizedName.split(" ").filter(Boolean),
      aliases: [], normalizedAliases: [], aliasTokens: [],
    };
  });
  const match = matchActiveAgentName(params.feedback.agent_name, definitions);
  return buildCallRoutingFieldsFromMatch({ match, profileByKey });
}

/** Documents the assignGeneralAgentCallToAgent behavior. */
export async function assignGeneralAgentCallToAgent(params: {
  userId: string;
  callId: string;
  agentAnalysisId: string;
}): Promise<{
  success: true;
  changed: boolean;
  activitySynced: boolean;
  agentKey?: string;
  callId: string;
  agentAnalysisId: string;
}> {
  const callId = demoId(params.callId);
  const agentAnalysisId = demoId(params.agentAnalysisId);
  await assertDemoRoutingStaff(params.userId);
  if (!params.userId || !callId || !agentAnalysisId) {
    throw new HttpsError("invalid-argument", "callId and agentAnalysisId are required");
  }

  /** Calls Firebase Firestore to read or write persisted application data. */
  const callRef = db.collection("calls").doc(callId);
  /** Calls Firebase Firestore to read or write persisted application data. */
  const agentRef = db.collection("agent_analyses").doc(agentAnalysisId);
  const [callDoc, agentDoc] = await Promise.all([callRef.get(), agentRef.get()]);

  if (!callDoc.exists) {
    throw new HttpsError("not-found", "Call not found");
  }
  if (!agentDoc.exists) {
    throw new HttpsError("not-found", "Agent analysis not found");
  }

  const callData = callDoc.data() ?? {};
  const agentData = agentDoc.data() ?? {};
  if (!isDemoManualCall(callData)) {
    throw new HttpsError("permission-denied", "Only prepared shared demo manual calls can be assigned");
  }
  const targetProfile = sharedDemoProfile(agentAnalysisId, agentData);
  if (!targetProfile) {
    throw new HttpsError("permission-denied", "Target must be an existing shared demo profile");
  }
  const assignableStatuses = new Set(["unrecognized", "no_agent", "pending_mapping"]);
  if (!assignableStatuses.has(callData.agentRoutingStatus)) {
    throw new HttpsError(
      "failed-precondition",
      "Only unrecognized, no-agent, or pending-mapping calls can be assigned"
    );
  }

  const targetSalesAgentId = targetProfile.salesAgentId;
  const targetSalesAgentName = targetProfile.salesAgentName;
  const targetAgentAnalysisId = targetProfile.agentAnalysisId;

  const existingSalesAgentId = normalizeOptionalString(callData.salesAgentId);
  if (existingSalesAgentId) {
    if (existingSalesAgentId === targetSalesAgentId) {
      return {
        success: true,
        changed: false,
        activitySynced: false,
        callId,
        agentAnalysisId: targetAgentAnalysisId,
      };
    }
    throw new HttpsError("failed-precondition", "Call is already assigned to another agent");
  }

  /** Calls an external SDK or API dependency. */
  await callRef.update({
    salesAgentId: targetSalesAgentId,
    salesAgentName: targetSalesAgentName,
    agentRoutingStatus: "manually_assigned",
    agentRoutingReason: "manual_assignment",
    matchedBy: "manual",
    agentNameMatchMethod: "manual",
    matchedAgentAnalysisId: targetAgentAnalysisId,
    matchedAgentProfileKey: targetProfile.activeAgentProfileKey,
    matchedAgentName: targetSalesAgentName,
    matchedAgentConfidence: 1,
    assignedBy: params.userId,
    assignedAt: FieldValue.serverTimestamp(),
    matchedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  let activitySynced = false;
  let agentKey: string | undefined;
  const updatedDoc = await callRef.get();
  const updatedCallData = updatedDoc.data() ?? {};
  if (normalizeOptionalString(updatedCallData.latestFeedbackId)) {
    try {
      const uploadedBy = normalizeOptionalString(updatedCallData.uploadedBy);
      const salesAgentId = normalizeOptionalString(updatedCallData.salesAgentId);
      const audioContentHash = normalizeOptionalString(updatedCallData.audioContentHash);
      const audioStorageMd5Hash = normalizeOptionalString(updatedCallData.audioStorageMd5Hash);
      const duplicateFingerprintKeys = buildDuplicateFingerprintKeys({
        audioContentHash,
        audioStorageMd5Hash,
      });
      if (uploadedBy && salesAgentId && duplicateFingerprintKeys.length > 0) {
        /** Calls Firebase Firestore to reconcile duplicate calls as they are manually linked into an agent profile. */
        const reconciliation = await reconcileAgentProfileDuplicates({
          uploadedBy,
          salesAgentId,
          detectedBy: "on_link",
          actorUserId: uploadedBy,
          agentAnalysisId: targetAgentAnalysisId,
          salesAgentName: targetSalesAgentName,
          onlyAudioContentHash: audioContentHash,
          onlyAudioStorageMd5Hash: audioStorageMd5Hash,
        });
        const canonicalCallId = duplicateFingerprintKeys
          .map(
            /** Handles the callback for this operation. */
            (fingerprintKey) => reconciliation.canonicalByDuplicateFingerprint[fingerprintKey]
          )
          .find(/** Handles the callback for this operation. */ (candidate) => Boolean(candidate));
        if (canonicalCallId && canonicalCallId !== callId) {
          return {
            success: true,
            changed: true,
            activitySynced: false,
            callId,
            agentAnalysisId: targetAgentAnalysisId,
          };
        }
      }

      const syncResult = await syncAgentActivityForCall({
        callId,
        callData: updatedCallData,
      });
      activitySynced = syncResult.updated;
      agentKey = syncResult.agentKey;
    } catch (error) {
      console.error(`Manual assignment activity sync failed for ${callId}:`, error);
    }
  }

  return {
    success: true,
    changed: true,
    activitySynced,
    agentKey,
    callId,
    agentAnalysisId: targetAgentAnalysisId,
  };
}
