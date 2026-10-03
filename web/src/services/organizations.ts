import { doc, onSnapshot, type DocumentData } from 'firebase/firestore';
import { db } from './firebaseFirestore';

export const CONSUBANCO_ORGANIZATION_ID = 'consubanco';

export type ConsubancoMemberRole = 'agent' | 'supervisor' | 'admin' | 'member';

export interface OrganizationMember {
  uid: string;
  email: string | null;
  organizationId: string;
  organizationName: string | null;
  role: ConsubancoMemberRole | null;
  salesAgentId: string | null;
  agentAnalysisId: string | null;
  salesAgentName: string | null;
  tags: string[];
}

/** Normalizes persisted Consubanco membership roles. */
export function normalizeConsubancoMemberRole(value: unknown): ConsubancoMemberRole | null {
  return value === 'agent' || value === 'supervisor' || value === 'admin' || value === 'member' ? value : null;
}

/** Normalizes optional string fields from organization membership docs. */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Documents the docToOrganizationMember behavior. */
function docToOrganizationMember(id: string, data: DocumentData): OrganizationMember {
  return {
    uid: typeof data.uid === 'string' ? data.uid : id,
    email: typeof data.email === 'string' ? data.email : null,
    organizationId: typeof data.organizationId === 'string' ? data.organizationId : CONSUBANCO_ORGANIZATION_ID,
    organizationName: typeof data.organizationName === 'string' ? data.organizationName : null,
    role: normalizeConsubancoMemberRole(data.role),
    salesAgentId: optionalString(data.salesAgentId),
    agentAnalysisId: optionalString(data.agentAnalysisId),
    salesAgentName: optionalString(data.salesAgentName),
    tags: Array.isArray(data.tags)
      ? data.tags.filter(
        /** Handles the callback for this operation. */
        (tag): tag is string => typeof tag === 'string' && tag.length > 0
      )
      : [],
  };
}

/** Documents the isConsubancoAdminMember behavior. */
export function isConsubancoAdminMember(member: OrganizationMember | null): boolean {
  return member?.organizationId === CONSUBANCO_ORGANIZATION_ID && member.role === 'admin';
}

/** Documents the isConsubancoSupervisorOrAdminMember behavior. */
export function isConsubancoSupervisorOrAdminMember(member: OrganizationMember | null): boolean {
  return member?.organizationId === CONSUBANCO_ORGANIZATION_ID && (member.role === 'supervisor' || member.role === 'admin');
}

/** Documents the isConsubancoAgentMember behavior. */
export function isConsubancoAgentMember(member: OrganizationMember | null): boolean {
  return member?.organizationId === CONSUBANCO_ORGANIZATION_ID && member.role === 'agent' && Boolean(member.salesAgentId);
}

/** Documents the isConsubancoDemoMember behavior. */
export function isConsubancoDemoMember(member: OrganizationMember | null): boolean {
  return member?.organizationId === CONSUBANCO_ORGANIZATION_ID && member.tags.includes('demo');
}

/** Documents the isConsubancoMember behavior. */
export function isConsubancoMember(member: OrganizationMember | null): boolean {
  return member?.organizationId === CONSUBANCO_ORGANIZATION_ID;
}

/** Documents the subscribeToConsubancoMembership behavior. */
export function subscribeToConsubancoMembership(
  userId: string,
  callback: (member: OrganizationMember | null) => void,
  onError?: (error: Error) => void
): () => void {
  const memberRef = doc(db, 'organizations', CONSUBANCO_ORGANIZATION_ID, 'members', userId);
  /** Calls Firebase Firestore to subscribe to the signed-in user's Consubanco membership role. */
  return onSnapshot(
    memberRef,
    /** Handles the callback for this operation. */(snapshot) => {
      callback(snapshot.exists() ? docToOrganizationMember(snapshot.id, snapshot.data()) : null);
    },
    /** Handles the callback for this operation. */(error) => {
      if (onError) onError(error);
      else callback(null);
    }
  );
}
