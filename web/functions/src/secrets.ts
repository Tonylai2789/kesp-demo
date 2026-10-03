/** Dedicated demo-only Secret Manager bindings; never copy production values. */
import { defineSecret } from 'firebase-functions/params';

// Shared secret reference reused by any callable needing the OpenAI API key.
export const OPENAI_API_KEY_SECRET = defineSecret('OPENAI_API_KEY');

// Only the explicitly authorized demo transcription worker receives this binding.
export const ELEVENLABS_API_KEY_SECRET = 'ELEVENLABS_API_KEY';
