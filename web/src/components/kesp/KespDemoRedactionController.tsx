import { Fragment, useLayoutEffect, type ReactNode } from 'react';
import { useAuth } from '@/contexts/useAuth';
import { resetKespDemoRedactionState, startKespDemoRedactionObserver } from '@/lib/kespDemoRedaction';

/** Mask both roles before paint; failures in membership cannot disable redaction. */
export function KespDemoRedactionController({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  useLayoutEffect(() => {
    resetKespDemoRedactionState();
    return startKespDemoRedactionObserver();
  }, [user?.uid]);
  return <Fragment key={user?.uid ?? 'signed-out'}>{children}</Fragment>;
}
