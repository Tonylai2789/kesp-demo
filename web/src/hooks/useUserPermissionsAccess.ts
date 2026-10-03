import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/services/firebaseFirestore';
import { getUserAccessContext } from '@/services/userPermissions';

export interface UserPermissionsAccess {
  adminOrganizationIds: string[];
  loading: boolean;
  error: boolean;
  refresh: () => void;
}

/** Watches only the caller's memberships; backend authority remains authoritative. */
export function useUserPermissionsAccess(uid: string | undefined): UserPermissionsAccess {
  const [state, setState] = useState<{ uid?: string; ids: string[]; error: boolean }>({ ids: [], error: false });
  const refreshRef = useRef<() => void>(/** No request exists before mount. */ () => undefined);

  useEffect(/** Tracks access for this signed-in identity only. */ () => {
    if (!uid) return;
    const userId = uid;
    let active = true;
    let generation = 0;
    const subscriptions = new Map<string, () => void>();

    /** Drops a revoked grant immediately, including while a callable is in flight. */
    function revoke(organizationId: string) {
      generation += 1;
      setState(/** Retains only grants not revoked by the live membership. */ (current) => ({
        uid, error: current.error, ids: current.uid === uid ? current.ids.filter(/** Excludes the revoked organization. */ (id) => id !== organizationId) : [],
      }));
    }

    /** Refreshes all admin grants and attaches listeners to newly discovered grants. */
    async function refresh() {
      const request = ++generation;
      try {
        // Firebase callable discovers administration in any organization, without broadening Consubanco roles.
        const result = await getUserAccessContext();
        if (!active || request !== generation) return;
        setState({ uid, ids: result.adminOrganizationIds, error: false });
        for (const [id, unsubscribe] of subscriptions) {
          if (!result.adminOrganizationIds.includes(id)) { unsubscribe(); subscriptions.delete(id); }
        }
        for (const id of result.adminOrganizationIds) {
          if (subscriptions.has(id)) continue;
          // Firestore permits the caller to watch their own membership, including role revocation.
          subscriptions.set(id, onSnapshot(doc(db, 'organizations', id, 'members', userId),
            /** Removes admin UI as soon as a live role is revoked. */ (snapshot) => {
              if (active && (!snapshot.exists() || snapshot.data().role !== 'admin')) revoke(id);
            },
            /** Fails closed when a membership can no longer be verified. */ () => { if (active) revoke(id); }
          ));
        }
      } catch {
        if (active && request === generation) setState({ uid, ids: [], error: true });
      }
    }

    /** Refreshes only visible sessions on focus or periodic checks. */
    function refreshVisible() { if (document.visibilityState === 'visible') void refresh(); }
    refreshRef.current = refreshVisible;
    void refresh();
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    const timer = window.setInterval(refreshVisible, 60_000);
    return /** Cancels stale identity results and releases every live listener. */ () => {
      active = false;
      generation += 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
      subscriptions.forEach(/** Releases a membership listener. */ (unsubscribe) => unsubscribe());
    };
  }, [uid]);

  const refresh = useCallback(/** Requests a current access check. */ () => refreshRef.current(), []);
  return {
    adminOrganizationIds: state.uid === uid ? state.ids : [],
    loading: Boolean(uid) && state.uid !== uid,
    error: state.uid === uid && state.error,
    refresh,
  };
}
