import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEMO_AGENT_PLACEHOLDER, demoAgentLabel, demoAgentNameFragments, isDemoMaskedValue, redactUnmaskedDemoText } from '../../functions/src/demoIdentity.ts';

type KespDemoTermKind =
  | 'agentName'
  | 'clientName'
  | 'agentId'
  | 'clientId'
  | 'clientPhone'
  | 'callString'
  | 'generic';

type Listener = () => void;

interface RedactionEntry {
  kind: KespDemoTermKind;
  source: string;
  replacement: string;
}

interface RedactionCacheEntry {
  value: string;
  version: number;
}

const listeners = new Set<Listener>();
const entries = new Map<string, RedactionEntry>();
const labelsByKind = new Map<KespDemoTermKind, Map<string, string>>();
const agentLabelsByTerm = new Map<string, Set<string>>();
let sortedEntriesCache: RedactionEntry[] = [];
let sortedEntriesVersion = -1;
let dictionaryVersion = 0;
const enabled = true;
let pendingDocumentRedaction = false;
let observer: MutationObserver | null = null;
let suppressObserver = false;

let textNodeCache = new WeakMap<Node, RedactionCacheEntry>();
let attributeCache = new WeakMap<Element, Map<string, RedactionCacheEntry>>();

const ATTRIBUTE_NAMES = ['title', 'aria-label', 'placeholder', 'alt'] as const;
const SKIP_TAG_NAMES = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
const MIN_STRUCTURED_TERM_LENGTH = 2;
const MIN_TEXT_TERM_LENGTH = 4;
const TRANSCRIPT_PLACEHOLDER = '*TRANSCRIPCION OCULTA PARA DEMO*';
const EVIDENCE_PLACEHOLDER = '*EVIDENCIA OCULTA PARA DEMO*';
const EXCERPT_PLACEHOLDER = '*FRAGMENTO OCULTO PARA DEMO*';

/** Normalizes a sensitive term into a stable lookup key. */
function normalizeTermKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** Escapes a literal term before creating a replacement RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns whether a kind should be matched as structured data rather than prose. */
function isStructuredTermKind(kind: KespDemoTermKind): boolean {
  return kind === 'agentId' || kind === 'clientId' || kind === 'clientPhone' || kind === 'callString';
}

/** Determines whether a raw Firestore value is useful enough to register as sensitive. */
function isEligibleSensitiveTerm(kind: KespDemoTermKind, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  const minLength = kind === 'agentName' || kind === 'agentId' ? 1 : isStructuredTermKind(kind) ? MIN_STRUCTURED_TERM_LENGTH : MIN_TEXT_TERM_LENGTH;
  if (trimmed.length < minLength) return false;
  if (isDemoMaskedValue(trimmed)) return false;
  const normalized = normalizeTermKey(trimmed);
  return !['unknown', 'unclear', 'none', 'null', 'undefined', 'consubanco', 'prod', 'test'].includes(normalized);
}

/** Formats deterministic demo labels for each sensitive entity class. */
function formatIndexedLabel(kind: KespDemoTermKind, index: number): string {
  const padded = String(index).padStart(2, '0');
  if (kind === 'clientName') return `*CLIENTE ${padded}*`;
  if (kind === 'clientPhone') return `*TELEFONO CLIENTE ${padded}*`;
  if (kind === 'clientId') return `*ID CLIENTE ${padded}*`;
  return '*DATO DEMO*';
}

/** Finds or creates the deterministic demo label for a source value. */
function labelForTerm(kind: KespDemoTermKind, source: string): string {
  if (isDemoMaskedValue(source)) return source;
  if (kind === 'callString') return maskKespDemoCallString(source);
  const termKey = normalizeTermKey(source);
  if (kind === 'agentName' || kind === 'agentId') {
    const labels = agentLabelsByTerm.get(`${kind}:${termKey}`) ?? agentLabelsByTerm.get(`agentId:${termKey}`);
    return labels?.size === 1 ? [...labels][0] : DEMO_AGENT_PLACEHOLDER;
  }
  const labels = labelsByKind.get(kind) ?? new Map<string, string>();
  if (!labelsByKind.has(kind)) labelsByKind.set(kind, labels);
  const existing = labels.get(termKey);
  if (existing) return existing;
  const label = formatIndexedLabel(kind, labels.size + 1);
  labels.set(termKey, label);
  return label;
}

/** Notifies active DOM observers that the dictionary or mode changed. */
function notifyRedactionListeners(): void {
  for (const listener of listeners) listener();
}

function shouldStoreDictionaryEntry(kind: KespDemoTermKind): boolean {
  return kind !== 'callString';
}

/** Registers one sensitive term for the lightweight fallback redactor. */
function registerTerm(kind: KespDemoTermKind, value: unknown): void {
  if (!isEligibleSensitiveTerm(kind, value)) return;
  const source = value.trim();
  labelForTerm(kind, source);
  if (!shouldStoreDictionaryEntry(kind)) return;
  const key = `${kind}:${source.toLowerCase()}`;
  const replacement = labelForTerm(kind, source);
  if (entries.get(key)?.replacement === replacement) return;
  entries.set(key, { kind, source, replacement });
  dictionaryVersion += 1;
  notifyRedactionListeners();
}

/** Bind aliases and name fragments to an ID; ambiguous aliases fail closed. */
function registerAgentIdentity(source: unknown, nameFields: string[], idFields: string[] = []): void {
  const id = stringField(source, 'canonicalSalesAgentId') || stringField(source, 'salesAgentId');
  const label = id?.trim() ? demoAgentLabel(id, value => bytesToHex(sha256(value))) : null;
  const bind = (kind: 'agentName' | 'agentId', value: string | undefined) => {
    if (!isEligibleSensitiveTerm(kind, value)) return;
    if (label) {
      const key = `${kind}:${normalizeTermKey(value)}`;
      const labels = agentLabelsByTerm.get(key) ?? new Set<string>();
      labels.add(label);
      agentLabelsByTerm.set(key, labels);
    }
    registerTerm(kind, value);
  };
  for (const field of ['canonicalSalesAgentId', 'salesAgentId', ...idFields]) bind('agentId', stringField(source, field));
  for (const field of nameFields) {
    const name = stringField(source, field);
    bind('agentName', name);
    if (name) {
      for (const fragment of demoAgentNameFragments(name)) bind('agentName', fragment);
    }
  }
}

/** Reads a string field from an untyped Firestore-derived object. */
function stringField(source: unknown, fieldName: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[fieldName];
  return typeof value === 'string' ? value : undefined;
}

/** Registers a single field from an untyped Firestore-derived object. */
function registerField(source: unknown, fieldName: string, kind: KespDemoTermKind): void {
  registerTerm(kind, stringField(source, fieldName));
}

/** Registers every string in a field array from an untyped Firestore-derived object. */
function registerStringArrayField(source: unknown, fieldName: string, kind: KespDemoTermKind): void {
  if (!source || typeof source !== 'object') return;
  const value = (source as Record<string, unknown>)[fieldName];
  if (!Array.isArray(value)) return;
  value.forEach((item) => registerTerm(kind, item));
}

/** Returns sorted dictionary entries, recomputing only when new terms are registered. */
function sortedEntries(): RedactionEntry[] {
  if (sortedEntriesVersion !== dictionaryVersion) {
    sortedEntriesCache = Array.from(entries.values(), entry => ({ ...entry, replacement: labelForTerm(entry.kind, entry.source) }))
      .sort((left, right) => right.source.length - left.source.length);
    sortedEntriesVersion = dictionaryVersion;
  }
  return sortedEntriesCache;
}

/** Replaces whole text terms without matching inside larger words. */
function replaceWholeTerm(value: string, entry: RedactionEntry): string {
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRegExp(entry.source)})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
  return value.replace(pattern, (_match, prefix: string) => `${prefix}${entry.replacement}`);
}

/** Replaces structured terms that are safe to match as literal substrings. */
function replaceStructuredTerm(value: string, entry: RedactionEntry): string {
  return value.replace(new RegExp(escapeRegExp(entry.source), 'gi'), entry.replacement);
}

/** Masks a CCC call filename, object path, or canonical id while preserving only account 1377. */
export function maskKespDemoCallString(value: string): string {
  if (isDemoMaskedValue(value)) return value;
  return value.includes('1377') ? '1377-*LLAMADA DEMO*' : '*LLAMADA DEMO*';
}

/** Masks a client-facing call row label without growing the global text dictionary. */
export function maskKespDemoCallDisplayName(value: string | null | undefined): string {
  if (!enabled || !value) return value ?? '';
  if (isDemoMaskedValue(value)) return value;
  return /1377|ccc_1377_|\d{7,}/i.test(value) ? maskKespDemoCallString(value) : labelForTerm('clientName', value);
}

/** Masks an agent display name without growing the global text dictionary. */
export function maskKespDemoAgentDisplayName(value: string | null | undefined, salesAgentId?: string | null): string {
  if (value && isDemoMaskedValue(value)) return value;
  if (salesAgentId?.trim()) return demoAgentLabel(salesAgentId, id => bytesToHex(sha256(id)));
  return value ? labelForTerm('agentName', value) : DEMO_AGENT_PLACEHOLDER;
}

/** Returns the demo transcript placeholder. */
export function maskKespDemoTranscriptText(): string {
  return TRANSCRIPT_PLACEHOLDER;
}

/** Returns the demo evidence placeholder. */
export function maskKespDemoEvidenceText(): string {
  return EVIDENCE_PLACEHOLDER;
}

/** Returns the demo excerpt placeholder. */
export function maskKespDemoExcerptText(): string {
  return EXCERPT_PLACEHOLDER;
}

/** Enables or disables demo redaction for the current browser session. */
export function setKespDemoRedactionEnabled(nextEnabled: boolean): void {
  // Demo masking cannot be switched off by membership tags or browser state.
  void nextEnabled;
  notifyRedactionListeners();
}

/** Returns whether demo redaction is active for the current user. */
export function isKespDemoRedactionEnabled(): boolean {
  return enabled;
}

/** Clears per-session demo labels and fallback DOM redaction caches. */
export function resetKespDemoRedactionState(): void {
  entries.clear();
  labelsByKind.clear();
  agentLabelsByTerm.clear();
  sortedEntriesCache = [];
  sortedEntriesVersion = -1;
  dictionaryVersion = 0;
  pendingDocumentRedaction = false;
  suppressObserver = false;
  textNodeCache = new WeakMap<Node, RedactionCacheEntry>();
  attributeCache = new WeakMap<Element, Map<string, RedactionCacheEntry>>();
}

/** Subscribes to redaction dictionary and mode changes. */
export function subscribeToKespDemoRedaction(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Registers call document fields that can expose Consubanco identities. */
export function registerKespDemoCallTerms(call: unknown): void {
  registerAgentIdentity(call, ['salesAgentName', 'matchedAgentName', 'extractedAgentName'], ['cccUserId', 'cccAgentMappingId', 'matchedAgentAnalysisId', 'matchedAgentProfileKey']);
  registerField(call, 'id', 'callString');
  registerField(call, 'name', 'callString');
  registerField(call, 'displayName', 'callString');
  registerField(call, 'displayNameBase', 'callString');
  registerField(call, 'callDocumentId', 'callString');
  registerField(call, 'originalFilename', 'callString');
  registerField(call, 'audioPath', 'callString');
  registerField(call, 'accountNumber', 'callString');
  registerField(call, 'cccUserId', 'agentId');
  registerField(call, 'cccCallId', 'callString');
  registerField(call, 'cccDestination', 'clientPhone');
  registerField(call, 'canonicalCallId', 'callString');
  registerField(call, 'canonicalSalesAgentId', 'agentId');
  registerField(call, 'cccAgentMappingId', 'agentId');
  registerField(call, 'cccOriginalFilename', 'callString');
  registerField(call, 'salesAgentId', 'agentId');
  registerField(call, 'salesAgentName', 'agentName');
  registerField(call, 'matchedAgentAnalysisId', 'agentId');
  registerField(call, 'matchedAgentProfileKey', 'agentId');
  registerField(call, 'matchedAgentName', 'agentName');
  registerField(call, 'extractedAgentName', 'agentName');
}

/** Registers feedback fields that can expose agent or client identities. */
export function registerKespDemoFeedbackTerms(feedback: unknown): void {
  registerAgentIdentity(feedback, ['agent_name']);
  registerField(feedback, 'call_id', 'callString');
  registerField(feedback, 'agent_name', 'agentName');
  registerField(feedback, 'customer_name', 'clientName');
  registerField(feedback, 'agent_speaker', 'agentName');
  registerField(feedback, 'customer_speaker', 'clientName');
}

/** Registers transcript speaker labels that may contain names. */
export function registerKespDemoTranscriptTerms(transcript: unknown): void {
  if (!transcript || typeof transcript !== 'object') return;
  const segments = (transcript as Record<string, unknown>).segments;
  if (!Array.isArray(segments)) return;
  segments.forEach((segment) => registerField(segment, 'speaker', 'generic'));
}

/** Registers canonical and manual agent profile fields that can expose agent identities. */
export function registerKespDemoAgentAnalysisTerms(agentAnalysis: unknown): void {
  registerAgentIdentity(agentAnalysis, ['salesAgentName', 'cccUsername', 'activeAgentDisplayName'], ['id', 'cccAgentMappingId', 'cccUserId', 'activeAgentProfileKey']);
  registerField(agentAnalysis, 'id', 'agentId');
  registerField(agentAnalysis, 'salesAgentId', 'agentId');
  registerField(agentAnalysis, 'salesAgentName', 'agentName');
  registerField(agentAnalysis, 'cccAgentMappingId', 'agentId');
  registerField(agentAnalysis, 'cccUserId', 'agentId');
  registerField(agentAnalysis, 'cccUsername', 'agentName');
  registerField(agentAnalysis, 'activeAgentProfileKey', 'agentId');
  registerField(agentAnalysis, 'activeAgentDisplayName', 'agentName');
  registerField(agentAnalysis, 'supervisorName', 'agentName');
}

/** Registers agent report fields that can expose call ids, names, or quoted sensitive terms. */
export function registerKespDemoAgentReportTerms(report: unknown): void {
  registerAgentIdentity(report, ['salesAgentName']);
  registerField(report, 'reportId', 'generic');
  registerField(report, 'salesAgentId', 'agentId');
  registerField(report, 'salesAgentName', 'agentName');
  registerStringArrayField(report, 'sourceCallIds', 'callString');
}

/** Registers activity snapshot, reminder, and loan case fields that can expose client identities. */
export function registerKespDemoActivityTerms(activity: unknown): void {
  registerAgentIdentity(activity, ['salesAgentName', 'agentName'], ['agentKey']);
  registerField(activity, 'id', 'callString');
  registerField(activity, 'sourceCallId', 'callString');
  registerField(activity, 'salesAgentId', 'agentId');
  registerField(activity, 'salesAgentName', 'agentName');
  registerField(activity, 'agentKey', 'agentId');
  registerField(activity, 'agentName', 'agentName');
  registerField(activity, 'customerName', 'clientName');
  registerField(activity, 'clientKey', 'clientId');
  registerField(activity, 'caseId', 'clientId');
  registerField(activity, 'reminderId', 'clientId');
  registerField(activity, 'latestCallId', 'callString');
  registerField(activity, 'saleReachedCallId', 'callString');
  registerStringArrayField(activity, 'linkedCallIds', 'callString');
  registerStringArrayField(activity, 'sourceCallIds', 'callString');
  registerStringArrayField(activity, 'activeReminderIds', 'clientId');
}

/** Registers workflow and runtime rows that can expose source filenames, paths, ids, and names. */
export function registerKespDemoWorkflowRowTerms(row: unknown): void {
  registerAgentIdentity(row, ['salesAgentName']);
  registerField(row, 'id', 'callString');
  registerField(row, 'callId', 'callString');
  registerField(row, 'canonicalCallId', 'callString');
  registerField(row, 'pipelineRunId', 'generic');
  registerField(row, 'salesAgentId', 'agentId');
  registerField(row, 'salesAgentName', 'agentName');
  registerField(row, 'sourceObjectPath', 'callString');
  registerField(row, 'destinationObjectPath', 'callString');
  registerField(row, 'sourceFilename', 'callString');
}

/** Applies dictionary and generic CCC masking rules to one visible string. */
export function redactKespDemoText(value: string): string {
  if (!enabled || !value) return value;
  let redacted = redactUnmaskedDemoText(value, text => text
    .replace(/\bccc_1377_[A-Za-z0-9_-]+\b/g, '*ID DEMO*')
    .replace(/(?:[A-Za-z0-9_.-]+\/)*1377(?:[/_-][A-Za-z0-9_.-]+)+/g, maskKespDemoCallString));
  for (const entry of sortedEntries()) {
    redacted = redactUnmaskedDemoText(redacted, text => isStructuredTermKind(entry.kind) ? replaceStructuredTerm(text, entry) : replaceWholeTerm(text, entry));
  }
  return redactUnmaskedDemoText(redacted, text => text.replace(/\b\d{7,}\b/g, '*ID CLIENTE*'));
}

/** Returns whether a DOM text node belongs to a subtree that should not be rewritten. */
function shouldSkipNode(node: Node): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  if (SKIP_TAG_NAMES.has(parent.tagName)) return true;
  return Boolean(parent.closest('[data-kesp-demo-redaction-skip="true"]'));
}

/** Runs a mutation while ignoring observer callbacks caused by our own redaction writes. */
function withObserverSuppressed(callback: () => void): void {
  const wasSuppressed = suppressObserver;
  suppressObserver = true;
  try {
    callback();
  } finally {
    suppressObserver = wasSuppressed;
  }
}

/** Redacts a single text node in place for the demo recording view. */
function redactTextNode(node: Node): void {
  if (!node.nodeValue || shouldSkipNode(node)) return;
  const cached = textNodeCache.get(node);
  if (cached?.version === dictionaryVersion && cached.value === node.nodeValue) return;
  const nextValue = redactKespDemoText(node.nodeValue);
  if (nextValue !== node.nodeValue) {
    withObserverSuppressed(() => {
      node.nodeValue = nextValue;
    });
  }
  textNodeCache.set(node, { value: nextValue, version: dictionaryVersion });
}

/** Redacts supported visible string attributes on one element. */
function redactElementAttributes(element: Element): void {
  let elementCache = attributeCache.get(element);
  if (!elementCache) {
    elementCache = new Map<string, RedactionCacheEntry>();
    attributeCache.set(element, elementCache);
  }
  for (const attributeName of ATTRIBUTE_NAMES) {
    const currentValue = element.getAttribute(attributeName);
    if (!currentValue) continue;
    const cached = elementCache.get(attributeName);
    if (cached?.version === dictionaryVersion && cached.value === currentValue) continue;
    const nextValue = redactKespDemoText(currentValue);
    if (nextValue !== currentValue) {
      withObserverSuppressed(() => {
        element.setAttribute(attributeName, nextValue);
      });
    }
    elementCache.set(attributeName, { value: nextValue, version: dictionaryVersion });
  }
}

/** Redacts one node and its current descendants. */
function redactSubtree(root: Node): void {
  if (!enabled) return;
  if (root.nodeType === Node.TEXT_NODE) {
    redactTextNode(root);
    return;
  }
  if (!(root instanceof Element)) return;
  redactElementAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    redactTextNode(node);
    node = walker.nextNode();
  }
  root.querySelectorAll('*').forEach(redactElementAttributes);
}

/** Redacts all currently rendered text and supported attributes in the document body. */
function redactCurrentDocument(): void {
  if (!enabled || typeof document === 'undefined' || !document.body) return;
  redactSubtree(document.body);
}

/** Schedules one full redaction pass after React has flushed current DOM changes. */
function scheduleDocumentRedaction(): void {
  if (!enabled || pendingDocumentRedaction || typeof window === 'undefined') return;
  pendingDocumentRedaction = true;
  window.requestAnimationFrame(() => {
    pendingDocumentRedaction = false;
    redactCurrentDocument();
  });
}

/** Starts the DOM observer used to keep demo pages masked as React renders new content. */
export function startKespDemoRedactionObserver(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => undefined;
  }
  if (!observer) {
    observer = new MutationObserver((mutations) => {
      if (suppressObserver || !enabled) return;
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') redactTextNode(mutation.target);
        if (mutation.type === 'attributes' && mutation.target instanceof Element) redactElementAttributes(mutation.target);
        if (mutation.type === 'childList') mutation.addedNodes.forEach(redactSubtree);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRIBUTE_NAMES],
    });
  }
  const unsubscribe = subscribeToKespDemoRedaction(scheduleDocumentRedaction);
  scheduleDocumentRedaction();
  return () => {
    unsubscribe();
  };
}
