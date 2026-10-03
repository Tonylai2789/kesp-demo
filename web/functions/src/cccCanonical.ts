import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { CONSUBANCO_ORGANIZATION_ID, CONSUBANCO_ORGANIZATION_NAME } from "./callIdentity";
import { isAllowlistedCccAgentMappingId } from "./cccAgentAllowlist";
import { callOccurrenceFieldsFromCccTimestamp } from "./callOccurrence";

/** Documents the getDb behavior. */
function getDb(): FirebaseFirestore.Firestore {
  /** Calls Firebase Admin to access Firestore after the default app is initialized. */
  return admin.firestore();
}

export const CCC_CANONICAL_PARSER_VERSION = "ccc-canonical-v1";
export const CCC_TEST_SYSTEM_UPLOADED_BY = "system_ccc_gcs_testing";
export const CCC_TEST_PROJECT_ID = "sales-feedback-agent";
export const CCC_PRODUCTION_PROJECT_IDS = new Set(["sales-banking-agent", "production"]);

export type CccFilenameParseClassification =
  | "strict"
  | "safe_embedded"
  | "risky_prefixed"
  | "unrecoverable";

export type CallSource = "ccc_gcs" | "manual_upload" | "legacy_manual";
export type UploadOwnerType = "automatic_system" | "manual_user";

export interface CccFilenameMetadata {
  accountNumber: string;
  cccUserId: string;
  cccCallTimestamp: string;
  cccDestination: string;
  cccCallId: string;
  canonicalSalesAgentId: string;
  canonicalCallId: string;
}

export interface CccFilenameParseResult {
  classification: CccFilenameParseClassification;
  parserVersion: typeof CCC_CANONICAL_PARSER_VERSION;
  originalFilename: string;
  normalizedFilename: string;
  metadata?: CccFilenameMetadata;
  errorCode?: string;
  errorDetail?: string;
}

export interface CccGcsObjectPathMetadata extends CccFilenameMetadata {
  sourcePrefix: string;
  sourceObjectPath: string;
  sourceFilename: string;
  sourceExtension: string;
  cccAccountNumber: string;
  cccCallMonthPath: string;
  cccCallDayPath: string;
  cccCallYear: string;
  cccCallMonth: string;
  cccCallDay: string;
  cccCallTime: string;
}

export interface CccGcsObjectPathParseResult {
  parserVersion: typeof CCC_CANONICAL_PARSER_VERSION;
  sourceObjectPath: string;
  sourcePrefixes: string[];
  metadata?: CccGcsObjectPathMetadata;
  errorCode?: string;
  errorDetail?: string;
}

export interface CccFilenameParseOptions {
  safeEmbeddedAccountWhitelist?: string[];
  enableLegacy1377SubstringRecovery?: boolean;
}

export interface CccGcsObjectPathParseOptions {
  sourcePrefixes: string[];
  allowedExtensions?: string[];
}

export const CCC_GCS_ALLOWED_AUDIO_EXTENSIONS = ["ogg", "wav", "mp3", "m4a"] as const;

export interface CccAgentMapping {
  id: string;
  accountNumber: string;
  cccUserId: string;
  cccUsername?: string;
  salesAgentId: string;
  agentAnalysisId: string;
  salesAgentName: string;
  supervisorName?: string;
  uploadedBy: string;
  verificationStatus: string;
  verifiedAt?: FirebaseFirestore.Timestamp;
  verifiedBy?: string;
  rawCccUserId?: string;
  temporaryId?: boolean;
  mappingNotes?: string[];
  legacySalesAgentId?: string;
  legacyAgentAnalysisId?: string;
  activeAgentProfileKey?: string;
  activeAgentDisplayName?: string;
}

export interface ManualAgentMappingLookupInput {
  uploadedBy: string;
  agentAnalysisId?: string;
  salesAgentId?: string;
  activeAgentProfileKey?: string;
}

/** Documents the basename behavior. */
function basename(value: string): string {
  const pathParts = value.split("/");
  return pathParts[pathParts.length - 1] ?? value;
}

/** Documents the stripExtension behavior. */
function stripExtension(value: string): string {
  return value.replace(/\.[^/.]+$/, "");
}

/** Documents the baseCccFilename behavior. */
function baseCccFilename(filename: string): string {
  return stripExtension(basename(filename).trim()).trim();
}

/** Documents the uniqueCandidates behavior. */
function uniqueCandidates(candidates: string[]): string[] {
  return Array.from(new Set(candidates.filter(/** Handles the callback for this operation. */(candidate) => candidate.length > 0)));
}

/** Documents the normalizeDecoratedCccFilename behavior. */
export function normalizeDecoratedCccFilename(filename: string): string {
  const original = baseCccFilename(filename);
  const withoutLeadingMarker = original.replace(/^__\d+__/, "");
  const candidates = uniqueCandidates([original, withoutLeadingMarker]);
  const suffixPatterns = [
    /_done__\d+___\d+__\d{13}$/i,
    /_done__\d+__\d{13}$/i,
    /_done_\d{13}$/i,
    /__\d+__\d{13}$/i,
    /_\d{13}$/,
    /__\d+__$/,
    /_done$/i,
  ];

  for (const candidate of candidates) {
    const strictMetadata = parseStrictCandidate(candidate);
    if (strictMetadata) return candidate;
    for (const suffixPattern of suffixPatterns) {
      const strippedCandidate = candidate.replace(suffixPattern, "");
      if (strippedCandidate === candidate) continue;
      if (parseStrictCandidate(strippedCandidate)) return strippedCandidate;
    }
  }

  return original;
}

/** Documents the buildCccSalesAgentId behavior. */
export function buildCccSalesAgentId(accountNumber: string, cccUserId: string): string {
  return `ccc_${accountNumber}_${cccUserId}`;
}

/** Documents the buildCccCanonicalCallId behavior. */
export function buildCccCanonicalCallId(accountNumber: string, cccCallId: string): string {
  return `ccc_${accountNumber}_${cccCallId}`;
}

/** Documents the buildCccAgentMappingId behavior. */
export function buildCccAgentMappingId(accountNumber: string, cccUserId: string): string {
  return `${accountNumber}_${cccUserId}`;
}

/** Documents the parseStrictCandidate behavior. */
function parseStrictCandidate(candidate: string): CccFilenameMetadata | null {
  const parts = candidate.split("-");
  if (parts.length !== 5) return null;
  const [accountNumber, cccUserId, cccCallTimestamp, cccDestination, cccCallId] = parts;
  if (!/^\d+$/.test(accountNumber)) return null;
  if (!/^[A-Za-z0-9]+$/.test(cccUserId)) return null;
  if (!/^[A-Za-z0-9T:._+Z]+$/.test(cccCallTimestamp)) return null;
  if (!/^[A-Za-z0-9+()._]+$/.test(cccDestination)) return null;
  if (!/^[A-Za-z0-9]+$/.test(cccCallId)) return null;

  return {
    accountNumber,
    cccUserId,
    cccCallTimestamp,
    cccDestination,
    cccCallId,
    canonicalSalesAgentId: buildCccSalesAgentId(accountNumber, cccUserId),
    canonicalCallId: buildCccCanonicalCallId(accountNumber, cccCallId),
  };
}


/** Documents the normalizeSourcePrefix behavior. */
function normalizeSourcePrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, "");
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** Documents the normalizeExtension behavior. */
function normalizeExtension(value: string): string {
  return value.trim().replace(/^\./, "").toLowerCase();
}

/** Documents the allowedCccGcsExtensions behavior. */
function allowedCccGcsExtensions(options: CccGcsObjectPathParseOptions): Set<string> {
  return new Set((options.allowedExtensions ?? [...CCC_GCS_ALLOWED_AUDIO_EXTENSIONS]).map(normalizeExtension));
}

/** Documents the parseStrictGcsFilename behavior. */
function parseStrictGcsFilename(filename: string): CccFilenameMetadata & { sourceExtension: string } | null {
  const match = filename.match(/^(\d+)-(\d+)-(\d{14})-(\d+)-(\d+)\.([A-Za-z0-9]+)$/);
  if (!match) return null;
  const [, accountNumber, cccUserId, cccCallTimestamp, cccDestination, cccCallId, rawExtension] = match;
  const sourceExtension = normalizeExtension(rawExtension);
  return {
    accountNumber,
    cccUserId,
    cccCallTimestamp,
    cccDestination,
    cccCallId,
    sourceExtension,
    canonicalSalesAgentId: buildCccSalesAgentId(accountNumber, cccUserId),
    canonicalCallId: buildCccCanonicalCallId(accountNumber, cccCallId),
  };
}

/** Documents the parseCccGcsObjectPath behavior. */
export function parseCccGcsObjectPath(
  sourceObjectPath: string,
  options: CccGcsObjectPathParseOptions
): CccGcsObjectPathParseResult {
  const normalizedPath = sourceObjectPath.trim().replace(/^\/+/, "");
  const sourcePrefixes = options.sourcePrefixes
    .map(normalizeSourcePrefix)
    .filter(/** Handles the callback for this operation. */(prefix) => prefix !== "/");
  const matchedPrefix = sourcePrefixes.find(
    /** Handles the callback for this operation. */(prefix) => normalizedPath.startsWith(prefix)
  );

  if (!matchedPrefix) {
    return {
      parserVersion: CCC_CANONICAL_PARSER_VERSION,
      sourceObjectPath,
      sourcePrefixes,
      errorCode: "INVALID_PREFIX",
      errorDetail: "CCC object path does not start with an allowed source prefix.",
    };
  }

  const pathParts = normalizedPath.slice(matchedPrefix.length).split("/");
  if (pathParts.length !== 4 || pathParts.some(/** Handles the callback for this operation. */(part) => !part)) {
    return {
      parserVersion: CCC_CANONICAL_PARSER_VERSION,
      sourceObjectPath,
      sourcePrefixes,
      errorCode: "INVALID_FILENAME_FORMAT",
      errorDetail: "CCC object path must be {prefix}/{accountNumber}/{yyyymm}/{dd}/{filename}.",
    };
  }

  const [pathAccountNumber, cccCallMonthPath, cccCallDayPath, sourceFilename] = pathParts;
  if (!/^\d+$/.test(pathAccountNumber) || !/^\d{6}$/.test(cccCallMonthPath) || !/^\d{2}$/.test(cccCallDayPath)) {
    return {
      parserVersion: CCC_CANONICAL_PARSER_VERSION,
      sourceObjectPath,
      sourcePrefixes,
      errorCode: "INVALID_FILENAME_FORMAT",
      errorDetail: "CCC object path account, month, and day folders must be numeric.",
    };
  }

  const filenameMetadata = parseStrictGcsFilename(sourceFilename);
  if (!filenameMetadata) {
    return {
      parserVersion: CCC_CANONICAL_PARSER_VERSION,
      sourceObjectPath,
      sourcePrefixes,
      errorCode: "INVALID_FILENAME_FORMAT",
      errorDetail: "CCC filename must be {accountNumber}-{cccUserId}-{YYYYMMDDHHMMSS}-{destination}-{cccCallId}.{extension}.",
    };
  }

  if (!allowedCccGcsExtensions(options).has(filenameMetadata.sourceExtension)) {
    return {
      parserVersion: CCC_CANONICAL_PARSER_VERSION,
      sourceObjectPath,
      sourcePrefixes,
      errorCode: "UNSUPPORTED_EXTENSION",
      errorDetail: "CCC filename extension is not in the configured audio allowlist.",
    };
  }

  const timestampMonthPath = filenameMetadata.cccCallTimestamp.slice(0, 6);
  const timestampDayPath = filenameMetadata.cccCallTimestamp.slice(6, 8);
  if (
    pathAccountNumber !== filenameMetadata.accountNumber ||
    cccCallMonthPath !== timestampMonthPath ||
    cccCallDayPath !== timestampDayPath
  ) {
    return {
      parserVersion: CCC_CANONICAL_PARSER_VERSION,
      sourceObjectPath,
      sourcePrefixes,
      errorCode: "PATH_METADATA_MISMATCH",
      errorDetail: "CCC object path account/month/day does not match filename timestamp metadata.",
    };
  }

  return {
    parserVersion: CCC_CANONICAL_PARSER_VERSION,
    sourceObjectPath,
    sourcePrefixes,
    metadata: {
      ...filenameMetadata,
      sourcePrefix: matchedPrefix.replace(/\/$/, ""),
      sourceObjectPath: normalizedPath,
      sourceFilename,
      sourceExtension: filenameMetadata.sourceExtension,
      cccAccountNumber: filenameMetadata.accountNumber,
      cccCallMonthPath,
      cccCallDayPath,
      cccCallYear: filenameMetadata.cccCallTimestamp.slice(0, 4),
      cccCallMonth: filenameMetadata.cccCallTimestamp.slice(4, 6),
      cccCallDay: filenameMetadata.cccCallTimestamp.slice(6, 8),
      cccCallTime: filenameMetadata.cccCallTimestamp.slice(8, 14),
    },
  };
}

/** Documents the isLegacyTestingArtifactFilename behavior. */
export function isLegacyTestingArtifactFilename(filename: string): boolean {
  const normalized = baseCccFilename(filename);
  return /^(?:codex|e2e)[A-Za-z0-9_-]*/i.test(normalized);
}

/** Documents the findLegacy1377SubstringCandidate behavior. */
function findLegacy1377SubstringCandidate(filename: string): string | null {
  if (isLegacyTestingArtifactFilename(filename)) return null;
  const normalized = normalizeDecoratedCccFilename(filename);
  const match = normalized.match(/(?:^|[^0-9])(1377-\d{5,7}-\d{14}-\d{10}-\d{11})(?![A-Za-z0-9-])/);
  return match?.[1] ?? null;
}

/** Documents the parseCccFilename behavior. */
export function parseCccFilename(
  filename: string,
  options: CccFilenameParseOptions = {}
): CccFilenameParseResult {
  const normalizedFilename = normalizeDecoratedCccFilename(filename);
  const legacy1377Candidate = options.enableLegacy1377SubstringRecovery
    ? findLegacy1377SubstringCandidate(filename)
    : null;
  const strictMetadata = parseStrictCandidate(normalizedFilename);
  if (strictMetadata) {
    return {
      classification: "strict",
      parserVersion: CCC_CANONICAL_PARSER_VERSION,
      originalFilename: filename,
      normalizedFilename,
      metadata: strictMetadata,
    };
  }

  if (legacy1377Candidate) {
    const legacyMetadata = parseStrictCandidate(legacy1377Candidate);
    if (legacyMetadata) {
      return {
        classification: "strict",
        parserVersion: CCC_CANONICAL_PARSER_VERSION,
        originalFilename: filename,
        normalizedFilename: legacy1377Candidate,
        metadata: legacyMetadata,
      };
    }
  }

  const safeEmbeddedMatch = normalizedFilename.match(
    /(?:^|[_\s])(\d+-[A-Za-z0-9]+-[A-Za-z0-9T:._+Z]+-[A-Za-z0-9+()._]+-[A-Za-z0-9]+)$/
  );
  if (safeEmbeddedMatch?.[1]) {
    const embeddedMetadata = parseStrictCandidate(safeEmbeddedMatch[1]);
    const whitelist = new Set(options.safeEmbeddedAccountWhitelist ?? []);
    if (embeddedMetadata && whitelist.has(embeddedMetadata.accountNumber)) {
      return {
        classification: "safe_embedded",
        parserVersion: CCC_CANONICAL_PARSER_VERSION,
        originalFilename: filename,
        normalizedFilename,
        metadata: embeddedMetadata,
      };
    }
  }

  const riskyMatch = normalizedFilename.match(
    /[A-Za-z]+(\d+-[A-Za-z0-9]+-[A-Za-z0-9T:._+Z]+-[A-Za-z0-9+()._]+-[A-Za-z0-9]+)$/
  );
  if (riskyMatch) {
    return {
      classification: "risky_prefixed",
      parserVersion: CCC_CANONICAL_PARSER_VERSION,
      originalFilename: filename,
      normalizedFilename,
      errorCode: "INVALID_FILENAME_FORMAT",
      errorDetail: "Filename appears to contain a glued text prefix before CCC metadata.",
    };
  }

  return {
    classification: "unrecoverable",
    parserVersion: CCC_CANONICAL_PARSER_VERSION,
    originalFilename: filename,
    normalizedFilename,
    errorCode: "INVALID_FILENAME_FORMAT",
    errorDetail: "Filename does not contain recoverable CCC metadata.",
  };
}

/** Documents the cccCallMetadataFields behavior. */
export function cccCallMetadataFields(parse: CccFilenameParseResult): Record<string, unknown> {
  const metadata = parse.metadata;
  return {
    cccOriginalFilename: parse.originalFilename,
    cccNormalizedFilename: parse.normalizedFilename,
    cccFilenameParseVersion: parse.parserVersion,
    cccParseClassification: parse.classification,
    ...(metadata
      ? {
        accountNumber: metadata.accountNumber,
        cccAccountNumber: metadata.accountNumber,
        cccUserId: metadata.cccUserId,
        cccCallId: metadata.cccCallId,
        cccCallTimestamp: metadata.cccCallTimestamp,
        ...callOccurrenceFieldsFromCccTimestamp(metadata.cccCallTimestamp),
        cccDestination: metadata.cccDestination,
        canonicalCallId: metadata.canonicalCallId,
        canonicalSalesAgentId: metadata.canonicalSalesAgentId,
      }
      : {}),
  };
}

/** Documents the cccGcsCallMetadataFields behavior. */
export function cccGcsCallMetadataFields(parse: CccGcsObjectPathParseResult): Record<string, unknown> {
  const metadata = parse.metadata;
  return {
    cccFilenameParseVersion: parse.parserVersion,
    ...(metadata
      ? {
        sourceSystem: "ccc",
        sourceClient: "consubanco",
        sourcePrefix: metadata.sourcePrefix,
        sourceObjectPath: metadata.sourceObjectPath,
        sourceFilename: metadata.sourceFilename,
        sourceExtension: metadata.sourceExtension,
        accountNumber: metadata.accountNumber,
        cccAccountNumber: metadata.cccAccountNumber,
        cccUserId: metadata.cccUserId,
        cccCallId: metadata.cccCallId,
        cccCallTimestamp: metadata.cccCallTimestamp,
        ...callOccurrenceFieldsFromCccTimestamp(metadata.cccCallTimestamp),
        cccCallMonthPath: metadata.cccCallMonthPath,
        cccCallDayPath: metadata.cccCallDayPath,
        cccCallYear: metadata.cccCallYear,
        cccCallMonth: metadata.cccCallMonth,
        cccCallDay: metadata.cccCallDay,
        cccCallTime: metadata.cccCallTime,
        cccDestination: metadata.cccDestination,
        canonicalCallId: metadata.canonicalCallId,
        canonicalSalesAgentId: metadata.canonicalSalesAgentId,
      }
      : {}),
  };
}

/** Documents the normalizeCccAgentMapping behavior. */
function normalizeCccAgentMapping(
  id: string,
  data: FirebaseFirestore.DocumentData | undefined
): CccAgentMapping | null {
  if (!data) return null;
  const accountNumber = typeof data.accountNumber === "string" ? data.accountNumber.trim() : "";
  const cccUserId = typeof data.cccUserId === "string" ? data.cccUserId.trim() : "";
  const salesAgentId = typeof data.salesAgentId === "string" ? data.salesAgentId.trim() : "";
  const agentAnalysisId = typeof data.agentAnalysisId === "string" ? data.agentAnalysisId.trim() : "";
  const salesAgentName = typeof data.salesAgentName === "string" ? data.salesAgentName.trim() : "";
  const uploadedBy = typeof data.uploadedBy === "string" ? data.uploadedBy.trim() : "";
  const verificationStatus =
    typeof data.verificationStatus === "string" ? data.verificationStatus.trim() : "";
  if (!accountNumber || !cccUserId || !salesAgentId || !agentAnalysisId || !salesAgentName || !uploadedBy) {
    return null;
  }
  return {
    id,
    accountNumber,
    cccUserId,
    cccUsername:
      typeof data.cccUsername === "string" ? data.cccUsername : undefined,
    salesAgentId,
    agentAnalysisId,
    salesAgentName,
    supervisorName:
      typeof data.supervisorName === "string" ? data.supervisorName : undefined,
    uploadedBy,
    verificationStatus,
    verifiedAt: data.verifiedAt,
    verifiedBy: typeof data.verifiedBy === "string" ? data.verifiedBy : undefined,
    rawCccUserId:
      typeof data.rawCccUserId === "string" ? data.rawCccUserId : undefined,
    temporaryId: data.temporaryId === true,
    mappingNotes: Array.isArray(data.mappingNotes)
      ? data.mappingNotes.filter(
        /** Handles the callback for this operation. */(note): note is string => typeof note === "string"
      )
      : undefined,
    legacySalesAgentId:
      typeof data.legacySalesAgentId === "string" ? data.legacySalesAgentId : undefined,
    legacyAgentAnalysisId:
      typeof data.legacyAgentAnalysisId === "string" ? data.legacyAgentAnalysisId : undefined,
    activeAgentProfileKey:
      typeof data.activeAgentProfileKey === "string" ? data.activeAgentProfileKey : undefined,
    activeAgentDisplayName:
      typeof data.activeAgentDisplayName === "string" ? data.activeAgentDisplayName : undefined,
  };
}

/** Documents the isVerifiedCccMapping behavior. */
export function isVerifiedCccMapping(mapping: CccAgentMapping | null): mapping is CccAgentMapping {
  return Boolean(mapping && mapping.verificationStatus === "verified" && isAllowlistedCccAgentMappingId(mapping.id));
}

/** Documents the cccVerifiedAgentCallFields behavior. */
export function cccVerifiedAgentCallFields(mapping: CccAgentMapping): Record<string, unknown> {
  return {
    salesAgentId: mapping.salesAgentId,
    salesAgentName: mapping.salesAgentName,
    matchedAgentAnalysisId: mapping.agentAnalysisId,
    matchedAgentProfileKey: mapping.activeAgentProfileKey ?? null,
    cccAgentMappingId: mapping.id,
    cccAgentMappingStatus: "mapped",
    agentRoutingMode: "specific",
    agentRoutingStatus: "matched",
    agentRoutingReason: "ccc_gcs_verified_mapping",
    matchedBy: "ccc_filename_mapping",
    matchedAgentName: mapping.salesAgentName,
    matchedAgentConfidence: 1,
  };
}

/** Documents the getVerifiedCccMappingForAgent behavior. */
export async function getVerifiedCccMappingForAgent(
  accountNumber: string,
  cccUserId: string
): Promise<CccAgentMapping | null> {
  /** Calls Firebase Firestore to read verified CCC agent mapping data. */
  const doc = await getDb().collection("ccc_agent_mappings").doc(buildCccAgentMappingId(accountNumber, cccUserId)).get();
  const mapping = normalizeCccAgentMapping(doc.id, doc.data());
  return isVerifiedCccMapping(mapping) ? mapping : null;
}

/** Documents the getFirstVerifiedMappingQueryResult behavior. */
async function getFirstVerifiedMappingQueryResult(
  field: string,
  value: string,
  uploadedBy: string
): Promise<CccAgentMapping | null> {
  if (!value) return null;
  /** Calls Firebase Firestore to query verified CCC agent mappings for a selected agent. */
  const snapshot = await getDb()
    .collection("ccc_agent_mappings")
    .where(field, "==", value)
    .where("uploadedBy", "==", uploadedBy)
    .where("verificationStatus", "==", "verified")
    .limit(1)
    .get();
  const doc = snapshot.docs[0];
  if (!doc) return null;
  return normalizeCccAgentMapping(doc.id, doc.data());
}

/** Documents the getVerifiedCccMappingForManualAgent behavior. */
export async function getVerifiedCccMappingForManualAgent(
  input: ManualAgentMappingLookupInput
): Promise<CccAgentMapping | null> {
  const agentAnalysisMatch = await getFirstVerifiedMappingQueryResult(
    "agentAnalysisId",
    input.agentAnalysisId ?? "",
    input.uploadedBy
  );
  if (agentAnalysisMatch) return agentAnalysisMatch;
  const legacyAnalysisMatch = await getFirstVerifiedMappingQueryResult(
    "legacyAgentAnalysisId",
    input.agentAnalysisId ?? "",
    input.uploadedBy
  );
  if (legacyAnalysisMatch) return legacyAnalysisMatch;
  const salesAgentMatch = await getFirstVerifiedMappingQueryResult(
    "salesAgentId",
    input.salesAgentId ?? "",
    input.uploadedBy
  );
  if (salesAgentMatch) return salesAgentMatch;
  const legacySalesAgentMatch = await getFirstVerifiedMappingQueryResult(
    "legacySalesAgentId",
    input.salesAgentId ?? "",
    input.uploadedBy
  );
  if (legacySalesAgentMatch) return legacySalesAgentMatch;
  return getFirstVerifiedMappingQueryResult(
    "activeAgentProfileKey",
    input.activeAgentProfileKey ?? "",
    input.uploadedBy
  );
}

/** Documents the cccCanonicalAgentProfileFields behavior. */
export function cccCanonicalAgentProfileFields(mapping: CccAgentMapping): Record<string, unknown> {
  return {
    uploadedBy: mapping.uploadedBy,
    salesAgentId: mapping.salesAgentId,
    salesAgentName: mapping.salesAgentName,
    status: "ready",
    organizationId: CONSUBANCO_ORGANIZATION_ID,
    organizationName: CONSUBANCO_ORGANIZATION_NAME,
    visibilityScope: "organization",
    profileSource: "ccc_mapping",
    isCccCanonicalProfile: true,
    cccAgentMappingId: mapping.id,
    accountNumber: mapping.accountNumber,
    cccUserId: mapping.cccUserId,
    cccUsername: mapping.cccUsername ?? null,
    supervisorName: mapping.supervisorName ?? null,
    rawCccUserId: mapping.rawCccUserId ?? mapping.cccUserId,
    temporaryId: mapping.temporaryId === true,
    mappingNotes: mapping.mappingNotes ?? [],
    activeAgentProfileKey: mapping.activeAgentProfileKey ?? null,
    activeAgentDisplayName: mapping.activeAgentDisplayName ?? mapping.salesAgentName,
    legacySalesAgentId: mapping.legacySalesAgentId ?? null,
    legacyAgentAnalysisId: mapping.legacyAgentAnalysisId ?? null,
  };
}

/** Documents the ensureCanonicalAgentProfileForMapping behavior. */
export async function ensureCanonicalAgentProfileForMapping(
  mapping: CccAgentMapping
): Promise<void> {
  /** Calls Firebase Firestore to create or update the canonical CCC agent profile document. */
  await getDb().collection("agent_analyses").doc(mapping.agentAnalysisId).set(
    {
      ...cccCanonicalAgentProfileFields(mapping),
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Documents the resolveCccScriptProjectId behavior. */
export function resolveCccScriptProjectId(env: NodeJS.ProcessEnv = process.env): string {
  const values = [env.GCLOUD_PROJECT, env.GCP_PROJECT, env.GOOGLE_CLOUD_PROJECT]
    .map(/** Handles the callback for this operation. */ (value) => (value ?? "").trim())
    .filter(/** Handles the callback for this operation. */ (value) => value.length > 0);
  const uniqueValues = Array.from(new Set(values));
  if (uniqueValues.length > 1) {
    throw new Error(
      `CCC scripts require consistent Firebase project env vars; found '${uniqueValues.join("', '")}'.`
    );
  }
  return uniqueValues[0] ?? "";
}

/** Documents the assertExactCccTestingProject behavior. */
export function assertExactCccTestingProject(projectId: string | undefined): void {
  const normalized = projectId?.trim() ?? "";
  if (normalized !== CCC_TEST_PROJECT_ID) {
    throw new Error(
      `CCC audit and rebuild scripts are test-only and require project '${CCC_TEST_PROJECT_ID}', not '${normalized || "unknown"}'.`
    );
  }
}

/** Documents the assertTestingProjectForCccDestructiveOperation behavior. */
export function assertTestingProjectForCccDestructiveOperation(projectId: string | undefined): void {
  const normalized = projectId?.trim() ?? "";
  if (!normalized || CCC_PRODUCTION_PROJECT_IDS.has(normalized)) {
    throw new Error(
      `CCC destructive rebuild is testing-only and refused project '${normalized || "unknown"}'.`
    );
  }
  assertExactCccTestingProject(normalized);
}
