export interface TranscriptSegment {
  id: string;
  type?: string;
  start: number;
  end: number;
  text: string;
  speaker: string;
}

export interface TranscriptUsage {
  type: string;
  seconds: number;
}

export interface TranscriptWord {
  id: string;
  text: string;
  type: 'word' | 'spacing' | 'audio_event';
  start: number;
  end: number;
  speakerId: string | null;
  rawSpeakerId: string | null;
  speakerRole: 'agent' | 'customer' | 'unknown';
}

export interface Transcript {
  provider?: 'openai' | 'elevenlabs';
  model?: string;
  schemaVersion?: number;
  processingGeneration?: number;
  audioIdentity?: string;
  audioIdentityMethod?: 'sha256' | 'legacy_source_metadata_sha256';
  transcriptId?: string;
  words?: TranscriptWord[];
  wordPages?: { count: number; wordCount: number };
  task: string;
  duration: number;
  text: string;
  segments: TranscriptSegment[];
  usage?: TranscriptUsage;
}
