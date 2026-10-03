import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/useAuth';
import { fetchCalls } from '@/services/firestore';
import { Button } from '@/components/kesp/primitives';
import { Icon } from '@/components/kesp/icons';
import { ShortCallReviewPanel } from '@/components/kesp/ShortCallReviewPanel';
import { isShortCallReviewCall } from '@/lib/shortCallReview';
import { compareCallsByBusinessDateDesc } from '@/lib/callDates';
import type { Call } from '@/types';

async function fetchShortCallReviewCalls(userId: string): Promise<Call[]> {
  const [manualCalls, visibleCalls] = await Promise.all([
    fetchCalls({
      userId,
      includeOrganizationCalls: false,
      analysisPipeline: 'manual_short_call_review',
      sortBy: 'createdAt',
      sortOrder: 'desc',
      maxResults: 100,
    }),
    fetchCalls({
      userId,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      maxResults: 500,
    }),
  ]);
  const merged = new Map<string, Call>();
  [...manualCalls, ...visibleCalls.filter(isShortCallReviewCall)].forEach((call) => merged.set(call.id, call));
  return Array.from(merged.values())
    .sort(compareCallsByBusinessDateDesc)
    .slice(0, 100);
}

/** Renders the ShortCallsPage component. */
export function ShortCallsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const { user } = useAuth();
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!user?.uid) {
      setCalls([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    fetchShortCallReviewCalls(user.uid)
      .then((nextCalls) => {
        if (cancelled) return;
        setCalls(nextCalls);
      })
      .catch((error) => {
        console.error('Failed to load short-call review calls:', error);
        if (!cancelled) toast.error(t('kesp.shortCalls.toasts.loadError'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.uid, t]);

  const currentPath = `${location.pathname}${location.search}`;

  const handleRefresh = async () => {
    if (!user?.uid || refreshing) return;
    setRefreshing(true);
    try {
      const nextCalls = await fetchShortCallReviewCalls(user.uid);
      setCalls(nextCalls);
      toast.success(t('kesp.shortCalls.toasts.refreshSuccess'));
    } catch (error) {
      console.error('Failed to reload short-call review calls:', error);
      toast.error(t('kesp.shortCalls.toasts.loadError'));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <main className="main main-wide">
      <ShortCallReviewPanel
        calls={calls}
        loading={loading}
        currentPath={currentPath}
        eyebrow={t('kesp.shortCalls.eyebrow')}
        title={t('kesp.shortCalls.title')}
        description={t('kesp.shortCalls.description')}
        action={(
          <Button kind="primary" icon={<Icon name="refresh" size={14} />} onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? t('kesp.shortCalls.refreshing') : t('kesp.shortCalls.refresh')}
          </Button>
        )}
      />
    </main>
  );
}
