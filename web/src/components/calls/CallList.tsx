import { useTranslation } from 'react-i18next';
import { Phone } from 'lucide-react';
import { CallCard } from './CallCard';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import type { Call } from '@/types';

interface CallListProps {
  calls: Call[];
  loading?: boolean;
}

/** Renders the CallCardSkeleton component. */
function CallCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start space-x-4">
          <Skeleton className="w-10 h-10 rounded-full" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-[300px]" />
            <Skeleton className="h-3 w-[200px]" />
          </div>
          <div className="flex space-x-2">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-6 w-16" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Renders the CallList component. */
export function CallList({ calls, loading }: CallListProps) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(5)].map(/** Handles the callback for this operation. */(_, i) => (
          <CallCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (calls.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
          <Phone className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="font-medium text-lg">{t('calls.noCalls')}</h3>
        <p className="text-muted-foreground mt-1">
          {t('upload.description')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {calls.map(/** Handles the callback for this operation. */(call) => (
        <CallCard key={call.id} call={call} />
      ))}
    </div>
  );
}
