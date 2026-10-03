import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/useAuth';
import { isDemoFirebaseProject } from '@/services/firebaseApp';
import {
  isConsubancoAdminMember,
  isConsubancoSupervisorOrAdminMember,
  subscribeToConsubancoMembership,
  type OrganizationMember,
} from '@/services/organizations';
import { DEFAULT_TRANSCRIPTION_MODEL, type TranscriptionUploadSelection } from '@/lib/transcriptionUpload';
import type { TranscriptionModel } from '@/types/call';

/** Gate KESP upload model selection by current membership; the preparation callable remains authoritative. */
export function useTranscriptionUploadSelection() {
  const { user } = useAuth();
  const uid = user?.uid;
  const supportsSelection = isDemoFirebaseProject;
  const [membership, setMembership] = useState<{ uid: string; member: OrganizationMember | null } | null>(null);
  const [choice, setChoice] = useState<{ uid?: string; model: TranscriptionModel; comparison: boolean }>({
    model: DEFAULT_TRANSCRIPTION_MODEL, comparison: false,
  });
  useEffect(/** Subscribe only in supported KESP projects and keep role results tied to the authenticated user. */ () => {
    if (!supportsSelection || !uid) return;
    // Firebase membership reads determine selector visibility, not backend authorization.
    return subscribeToConsubancoMembership(uid,
      /** Apply the current user's membership snapshot. */ (member) => setMembership({ uid, member }),
      /** Fail closed for selector privileges when membership cannot be read. */ () => setMembership({ uid, member: null }));
  }, [supportsSelection, uid]);

  const member = membership?.uid === uid ? membership?.member ?? null : null;
  const canSelect = supportsSelection && Boolean(uid) && isConsubancoSupervisorOrAdminMember(member);
  const canCompare = canSelect && isConsubancoAdminMember(member);
  const model = choice.uid === uid ? choice.model : DEFAULT_TRANSCRIPTION_MODEL;
  const comparison = canCompare && choice.uid === uid && choice.comparison;

  /** Copy primitive selections onto a file once; retries reuse the file's stored values. */
  function snapshot(): TranscriptionUploadSelection {
    return canSelect ? { transcriptionModel: model, transcriptionComparison: comparison } : {};
  }
  /** Scope form selections to one signed-in user and discard disallowed comparison flags. */
  function onChange(next: { model: TranscriptionModel; comparison: boolean }): void {
    setChoice({ uid, model: next.model, comparison: canCompare && next.comparison });
  }
  return { canSelect, canCompare, loading: supportsSelection && Boolean(uid) && membership?.uid !== uid, model, comparison, snapshot, onChange };
}
