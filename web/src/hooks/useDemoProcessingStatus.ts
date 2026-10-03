import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { getDemoProcessingStatus, type DemoProcessingStatus } from '@/services/functions';

function permitsProcessing(status: DemoProcessingStatus | undefined): boolean {
  return status?.canStart === true && status.enabled === true &&
    status.pauseReason === null && Number.isFinite(status.remainingMicros) &&
    status.remainingMicros > 0 && status.maxActiveSlots === 2 &&
    Number.isInteger(status.activeSlots) && status.activeSlots >= 0 &&
    status.activeSlots < status.maxActiveSlots;
}

export function useDemoProcessingStatus() {
  const { user } = useAuth();
  const { data, isError, isPending, isFetching, refetch } = useQuery({
    queryKey: ['demo-processing-status', user?.uid],
    queryFn: getDemoProcessingStatus,
    enabled: Boolean(user?.uid),
    retry: false,
    networkMode: 'always',
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });
  const status = user?.uid && !isError ? data : undefined;
  const canStart = !isFetching && permitsProcessing(status);
  const checkCanStart = useCallback(async () => {
    if (!user?.uid) return false;
    // A fresh read improves the UI gate; the paid callable still owns admission.
    try {
      const result = await refetch();
      return !result.isError && permitsProcessing(result.data);
    } catch {
      return false;
    }
  }, [refetch, user?.uid]);

  return { status, canStart, checkCanStart, loading: Boolean(user?.uid) && (isPending || isFetching) };
}
