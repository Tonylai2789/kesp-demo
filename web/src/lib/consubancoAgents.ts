export interface ConsubancoAgent {
  displayName: string;
  profileKey: string;
  salesAgentId: string;
  normalizedName: string;
}

// Demo rosters come from shared synthetic profiles, never a bank recipient list.
export const CONSUBANCO_AGENT_NAMES: readonly string[] = [];

export function normalizeConsubancoAgentName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function buildConsubancoAgentProfileKey(displayName: string): string {
  return normalizeConsubancoAgentName(displayName).replace(/\s+/g, '-');
}

export function buildConsubancoSalesAgentId(profileKey: string): string {
  return `active_agent_${profileKey}`;
}

export function getAgentInitials(displayName: string): string {
  const words = displayName
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return '—';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

export const CONSUBANCO_AGENTS: ConsubancoAgent[] = CONSUBANCO_AGENT_NAMES.map(
  (displayName) => {
    const profileKey = buildConsubancoAgentProfileKey(displayName);
    return {
      displayName,
      profileKey,
      salesAgentId: buildConsubancoSalesAgentId(profileKey),
      normalizedName: normalizeConsubancoAgentName(displayName),
    };
  }
);

export const CONSUBANCO_AGENT_NAME_SET = new Set(
  CONSUBANCO_AGENTS.map((agent) => agent.normalizedName)
);

export function isConsubancoAgentName(value: unknown): boolean {
  return CONSUBANCO_AGENT_NAME_SET.has(normalizeConsubancoAgentName(value));
}
