import { privatePolicyUnavailable } from "./privatePolicy";

export type ConversationRole = "agent" | "customer" | "unknown";

export interface ConversationWord {
  id: string; text: string; type: "word"; start: number; end: number;
  speakerId: string; speakerRole: ConversationRole; rawSpeakerId: string | null;
}

export interface ConversationEvidence {
  id: string; start: number; end: number; text: string; evidenceIds: string[];
  textTruncated?: boolean; evidenceIdsTruncated?: boolean;
}

export interface ConversationSegment extends ConversationEvidence {
  speaker: string; role: ConversationRole; wordCount: number;
  timingExcluded?: boolean;
  wpm: number | null; speedEligible: boolean; tooFast: boolean | null; exclusionReason: string | null;
}

export interface ConversationInterruption extends ConversationEvidence {
  fromSpeaker: string; toSpeaker: string; duration: number;
  category: "possible_interruption" | "brief_acknowledgment_candidate" | "uncertain_overlap";
  reason: "cross_speaker_word_overlap";
}

export interface ConversationGap extends ConversationEvidence { fromSpeaker: string; toSpeaker: string; seconds: number }

export interface ConversationFiller extends ConversationEvidence {
  kind: "lexical_filler_candidate" | "repetition_candidate"; speaker: string; role: ConversationRole;
}

export interface MetricAvailability { available: boolean; reason: string | null }

export interface ConversationMetricsReport {
  identity?: { generation: number; transcriptGeneration: number; transcriptHash: string; audioIdentity: string | null; transcriptId: string | null;
    provider: string | null; model: string | null; analysisRunId?: string;
    roleMapping?: ConversationRoleMapping; calculationVersion?: "openai_segment_timing_v1" };
  evidenceTruncated?: boolean;
  evidenceTotals?: { words: number; segments: number; interruptions: number; gaps: number; fillers: number };
  wordEvidenceLocation?: string;
  segmentEvidenceLocation?: string;
  timingSource?: "word" | "segment";
  schemaVersion: "1"; method: "timestamp_wpm_v1"; status: "available" | "partial" | "unavailable";
  calculationVersion?: "segment_timing_v2" | "openai_segment_timing_v1";
  parameters: { segmentGapSeconds: number; minimumSpeedSeconds: number; minimumSpeedWords: number; fastWpmThreshold: number };
  availability: Record<"speed" | "talkBalance" | "turns" | "gaps" | "interruptions" | "fillers", MetricAvailability>;
  coverage: { inputWordCount: number; validatedWordCount: number; excludedWordCount: number; unknownRoleWordCount: number;
    totalSegmentCount?: number; excludedSegmentCount?: number; analyzedWordCount?: number };
  words: ConversationWord[]; segments: ConversationSegment[];
  summary: {
    fastSegmentCount: number | null; fastestWpm: number | null; agentSpeechSeconds: number | null;
    customerSpeechSeconds: number | null; overlapSeconds: number | null; agentTalkPercent: number | null;
    longestAgentTurnSeconds: number | null; medianResponseGapSeconds: number | null;
    interruptionCandidateCount: number | null; fillerCandidateCount: number | null; fillerCandidatesPer100Words: number | null;
  };
  interruptions: ConversationInterruption[]; gaps: ConversationGap[]; fillers: ConversationFiller[]; limitations: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function countConversationWords(text: string): number {
  return (text.match(/\p{N}+(?:[.,]\p{N}+)*|\p{L}+(?:['\u2019-]\p{L}+)*/gu) ?? []).length;
}

export function unavailableConversationMetrics(reason: string): ConversationMetricsReport {
  void reason;
  return privatePolicyUnavailable();
}

export function calculateConversationMetrics(transcript: unknown): ConversationMetricsReport {
  void transcript;
  return privatePolicyUnavailable();
}

export interface ConversationRoleMapping { agent: string | null; customer: string | null }

export function conversationRoleMapping(coreFields: unknown): ConversationRoleMapping {
  const core = record(coreFields);
  /** Rejects missing, sentinel, and oversized speaker labels. */
  const label = (value: unknown): string | null => typeof value === "string" && value.trim() &&
    value.length <= 256 && !["unknown", "desconocido", "null"].includes(value.trim().toLowerCase()) ? value.trim() : null;
  const agent = label(core.agent_speaker); const customer = label(core.customer_speaker);
  return agent && customer && agent === customer ? { agent: null, customer: null } : { agent, customer };
}

export function isOpenAiSegmentTranscript(transcript: unknown): boolean {
  const source = record(transcript);
  return source.provider === "openai" && source.model === "gpt-4o-transcribe-diarize" &&
    (!Array.isArray(source.words) || source.words.length === 0);
}

export function calculateOpenAiSegmentConversationMetrics(transcript: unknown, coreFields: unknown): ConversationMetricsReport {
  void transcript;
  void coreFields;
  return privatePolicyUnavailable();
}
