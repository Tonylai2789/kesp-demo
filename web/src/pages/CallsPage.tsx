import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CallList, CallFilters, CallUpload } from '@/components/calls';
import { subscribeToCalls } from '@/services/firestore';
import type { Call, CallCategory, CallStatus } from '@/types';
import { useAuth } from '@/contexts/useAuth';

/** Renders the CallsPage component. */
export function CallsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Filter state
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<CallCategory | 'all'>('all');
  const [status, setStatus] = useState<CallStatus | 'all'>('all');

  const handleCategoryChange = /** Handles the handleCategoryChange interaction. */ (value: CallCategory | 'all') => {
    setCategory(value);
    setLoading(true);
  };

  const handleStatusChange = /** Handles the handleStatusChange interaction. */ (value: CallStatus | 'all') => {
    setStatus(value);
    setLoading(true);
  };

  // Subscribe to real-time updates
  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return;

    const unsubscribe = subscribeToCalls(
      {
        userId: user.uid,
        category: category === 'all' ? undefined : category,
        status: status === 'all' ? undefined : status,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      },
      /** Handles the callback for this operation. */
      (updatedCalls) => {
        setCalls(updatedCalls);
        setLoading(false);
      }
    );

    return /** Handles the callback for this operation. */ () => unsubscribe();
  }, [category, status, user?.uid]);

  // Filter calls by search term (client-side)
  const filteredCalls = useMemo(/** Handles the callback for this operation. */() => {
    if (!search.trim()) return calls;

    const searchLower = search.toLowerCase();
    return calls.filter(/** Handles the callback for this operation. */(call) => call.id.toLowerCase().includes(searchLower));
  }, [calls, search]);

  const handleUploadComplete = /** Handles the handleUploadComplete interaction. */ () => {
    // Real-time subscription will automatically update the list
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t('calls.title')}</h1>
        <Button onClick={/** Handles the onClick interaction. */ () => setUploadOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          {t('upload.uploadButton')}
        </Button>
      </div>

      <CallFilters
        search={search}
        onSearchChange={setSearch}
        category={category}
        onCategoryChange={handleCategoryChange}
        status={status}
        onStatusChange={handleStatusChange}
      />

      <CallList calls={filteredCalls} loading={loading} />

      <CallUpload
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploadComplete={handleUploadComplete}
      />
    </div>
  );
}
