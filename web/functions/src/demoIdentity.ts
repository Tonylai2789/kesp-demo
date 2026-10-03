export const DEMO_AGENT_PLACEHOLDER = '*AGENTE DEMO*';
const NAME_CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'da', 'das', 'do', 'dos']);

// Only call masks have suffixes; reports contain at most 250 calls. Never
// consume adjacent identifiers or the leading digits of an invalid counter.
const INDEX_PATTERN = '(?:0[1-9]|[1-9]\\d{1,2})';
const CALL_INDEX_PATTERN = '(?:0[1-9]|[1-9]\\d|1\\d{2}|2[0-4]\\d|250)';
const MASK_PATTERN = new RegExp([
  `\\*(?:AGENTE(?: DEMO| ${INDEX_PATTERN})?|(?:ID )?CLIENTE(?: ${INDEX_PATTERN})?|ID AGENTE(?: ${INDEX_PATTERN})?|TELEFONO CLIENTE(?: ${INDEX_PATTERN})?|DATO DEMO|ID DEMO|TRANSCRIPCION OCULTA PARA DEMO|EVIDENCIA OCULTA PARA DEMO|FRAGMENTO OCULTO PARA DEMO)\\*`,
  `(?:1377-)?\\*LLAMADA DEMO\\*(?: ${CALL_INDEX_PATTERN}(?![\\p{L}\\p{N}_]))?`,
  '\\bAGENTE-[A-F0-9]{12}\\b',
].join('|'), 'gu');

export function isDemoMaskedValue(value: string): boolean {
  const matches = value.match(MASK_PATTERN);
  return matches?.length === 1 && matches[0] === value;
}

/** Initials/connectors stay in the whole-name match, not the prose dictionary. */
export function demoAgentNameFragments(value: string): string[] {
  if (isDemoMaskedValue(value)) return [];
  return value.split(/[\s-]+/).filter(fragment =>
    fragment.replace(/[^\p{L}\p{N}]/gu, '').length > 1 && !NAME_CONNECTORS.has(fragment.toLowerCase()),
  );
}

/** Hash the exact canonical ID, never a display name or a profile document key. */
export function demoAgentLabel(
  salesAgentId: string | null | undefined,
  sha256Hex: (value: string) => string,
): string {
  if (!salesAgentId?.trim()) return DEMO_AGENT_PLACEHOLDER;
  if (isDemoMaskedValue(salesAgentId)) return salesAgentId;
  return `AGENTE-${sha256Hex(salesAgentId).slice(0, 12).toUpperCase()}`;
}

/** Keep generated placeholders opaque to subsequent dictionary/DOM passes. */
export function redactUnmaskedDemoText(value: string, redact: (text: string) => string): string {
  let end = 0;
  let result = '';
  for (const match of value.matchAll(MASK_PATTERN)) {
    result += redact(value.slice(end, match.index)) + match[0];
    end = match.index + match[0].length;
  }
  return result + redact(value.slice(end));
}
