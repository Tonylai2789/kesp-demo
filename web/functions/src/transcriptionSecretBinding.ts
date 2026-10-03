import { OPENAI_API_KEY_SECRET, ELEVENLABS_API_KEY_SECRET } from "./secrets";
import { DEMO_PROJECT_ID } from "./demoBudget";

/** Allow Scribe only in the isolated demo project. */
export function isScribeTranscriptionDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  const projects = [env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT, env.GCP_PROJECT].filter(
    /** Ignores absent aliases without accepting whitespace variants. */ (value): value is string => !!value);
  if (env.FIREBASE_CONFIG) {
    try {
      const config = JSON.parse(env.FIREBASE_CONFIG) as { projectId?: unknown };
      if (typeof config.projectId !== "string") return false;
      projects.push(config.projectId);
    } catch { return false; }
  }
  const supported = new Set([DEMO_PROJECT_ID]);
  return projects.length > 0 && supported.has(projects[0]) && projects.every(
    /** Fail closed for unknown or conflicting project identities. */ (project) => project === projects[0]);
}

/** Supported KESP projects declare both transcription keys; unknown projects remain OpenAI-only. */
export function transcriptionWorkerSecrets(env: NodeJS.ProcessEnv = process.env) {
  return isScribeTranscriptionDeployment(env)
    ? [OPENAI_API_KEY_SECRET, ELEVENLABS_API_KEY_SECRET] : [OPENAI_API_KEY_SECRET];
}
