import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut, type User } from 'firebase/auth';
import { auth } from '@/services/firebaseAuth';
import { ensureConsubancoMembershipForCurrentUser } from '@/services/functions';
import { getDemoPasswordEmail, isDemoIdentity } from '@/lib/demoPolicy';
import { AuthContext } from './AuthContextValue';

/** Publish a session only after demo identity and backend membership both pass. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [signInLoading, setSignInLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let generation = 0;
    // Firebase Auth supplies the identity; the backend enforces DB-managed approval.
    const unsubscribe = onAuthStateChanged(auth, (candidate) => {
      const request = ++generation;
      setUser(null);
      setLoading(Boolean(candidate));
      if (!candidate) return;
      void (async () => {
        try {
          const token = await candidate.getIdTokenResult();
          if (!isDemoIdentity(candidate.uid, candidate.email, candidate.emailVerified, token.signInProvider)) {
            throw new Error('demo.loginFailed');
          }
          // The callable checks approval and validates the live demo membership.
          const membership = await ensureConsubancoMembershipForCurrentUser();
          if (!membership.success || membership.uid !== candidate.uid || membership.organizationId !== 'consubanco' ||
              (membership.role !== 'admin' && membership.role !== 'supervisor') ||
              (token.signInProvider === 'password' && membership.role !== 'supervisor')) {
            throw new Error('demo.loginFailed');
          }
          if (active && request === generation) { setUser(candidate); setError(null); }
        } catch {
          if (!active || request !== generation) return;
          setError('demo.loginFailed');
          try { await signOut(auth); } catch { /* Local authorization is already cleared. */ }
        } finally {
          if (active && request === generation) setLoading(false);
        }
      })();
    });
    return () => { active = false; generation += 1; unsubscribe(); };
  }, []);

  /** Keep the existing approved Google-account sign-in path. */
  const startGoogleAuth = useCallback(async () => {
    setError(null); setSignInLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
    } catch {
      setError('demo.loginFailed');
      throw new Error('demo.loginFailed');
    } finally { setSignInLoading(false); }
  }, []);

  const signInWithGoogle = useCallback(async () => {
    try { await startGoogleAuth(); } catch { /* Error is displayed on the login page. */ }
  }, [startGoogleAuth]);

  const signInWithPassword = useCallback(async (username: string, password: string) => {
    setError(null); setSignInLoading(true);
    try {
      const email = getDemoPasswordEmail(username);
      if (!email || !password) throw new Error('demo.loginFailed');
      await signInWithEmailAndPassword(auth, email, password);
    } catch {
      setError('demo.loginFailed');
    } finally { setSignInLoading(false); }
  }, []);

  /** Clearing local authorization precedes the remote sign-out. */
  const logout = useCallback(async () => {
    setUser(null);
    await signOut(auth);
  }, []);

  return <AuthContext.Provider value={{ user, loading: loading || signInLoading, error, isEmailAllowed: Boolean(user), signInWithGoogle, signInWithPassword, switchAccountWithGoogle: startGoogleAuth, logout }}>{children}</AuthContext.Provider>;
}
