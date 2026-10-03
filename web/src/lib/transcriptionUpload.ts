import type { TranscriptionModel } from '@/types/call';

export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModel = 'scribe_v2';

export interface TranscriptionUploadSelection {
  readonly transcriptionModel?: TranscriptionModel;
  readonly transcriptionComparison?: boolean;
}

/** Display provider/model names without translating stored model identifiers. */
export function transcriptionModelLabel(model: TranscriptionModel): string {
  return model === 'scribe_v2' ? 'ElevenLabs / Scribe v2' : 'OpenAI / GPT-4o Transcribe Diarize';
}
