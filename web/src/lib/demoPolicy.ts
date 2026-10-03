export const DEMO_PROJECT_ID = 'kesp-demo-tonylai2789';
export const DEMO_ADMIN_EMAIL = 'tonylai2789@gmail.com';
export const DEMO_SUPERVISOR_EMAIL = 'logitech2789@gmail.com';
export const DEMO_EMAILS = [DEMO_ADMIN_EMAIL, DEMO_SUPERVISOR_EMAIL] as const;
export const DEMO_PASSWORD_USERNAME = 'demo-supervisor';
export const DEMO_PASSWORD_EMAIL = 'demo-supervisor@kesp-demo.invalid';
export const DEMO_PASSWORD_UID = 'kesp-demo-supervisor';
export const DEMO_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const DEMO_MAX_AUDIO_SECONDS = 300;

/** Fixed allowlist independent of browser settings or writable configuration. */
export function isDemoEmail(email: string | null | undefined): boolean {
  return DEMO_EMAILS.some((allowed) => allowed === email?.trim().toLowerCase());
}

/** An allowed email is insufficient without verified Google authentication. */
export function isDemoGoogleIdentity(email: string | null | undefined, verified: boolean, provider: unknown): boolean {
  return isDemoEmail(email) && verified && provider === 'google.com';
}

/** The reserved password identity is exact; it does not expand the Google allowlist. */
export function isDemoIdentity(uid: string | null | undefined, email: string | null | undefined, verified: boolean, provider: unknown): boolean {
  return (uid !== DEMO_PASSWORD_UID && isDemoGoogleIdentity(email, verified, provider)) ||
    (uid === DEMO_PASSWORD_UID && email === DEMO_PASSWORD_EMAIL && provider === 'password');
}

/** Only the public username maps to the internal Firebase account. */
export function getDemoPasswordEmail(username: string): string | null {
  return username === DEMO_PASSWORD_USERNAME ? DEMO_PASSWORD_EMAIL : null;
}

/** Reject accidental production, testing, or foreign-bucket initialization. */
export function assertDemoFirebaseConfig(config: { projectId?: string; authDomain?: string; storageBucket?: string; apiKey?: string; appId?: string; messagingSenderId?: string }): void {
  if (config.projectId !== DEMO_PROJECT_ID || config.authDomain !== DEMO_PROJECT_ID + '.firebaseapp.com' ||
      ![DEMO_PROJECT_ID + '.firebasestorage.app', DEMO_PROJECT_ID + '.appspot.com'].includes(config.storageBucket ?? '') ||
      !config.apiKey || !config.appId || !config.messagingSenderId) {
    throw new Error('KESP Demo: invalid or missing isolated Firebase configuration.');
  }
}

/** Reject empty, oversized, unmeasurable, and overlength recordings before reservation. */
export function validateDemoAudioLimits(bytes: number, seconds: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > DEMO_MAX_UPLOAD_BYTES) throw new Error('El archivo debe tener contenido y no superar 25 MB.');
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > DEMO_MAX_AUDIO_SECONDS) throw new Error('La grabación debe durar entre 0 y 5 minutos.');
}
