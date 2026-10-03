import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAuth } from '@/contexts/useAuth';
import { subscribeToCalls } from '@/services/firestore';
import type { Call, CallCategory, CallStatus } from '@/types/call';
import { Icon } from '@/components/kesp/icons';
import { Button } from '@/components/kesp/primitives';
import { fmtDur } from '@/components/kesp/format';
import { formatKespDate } from '@/lib/kespI18n';
import {
  maskKespDemoAgentDisplayName,
  maskKespDemoCallDisplayName,
} from '@/lib/kespDemoRedaction';
import { useKespDemoRedactionEnabled } from '@/hooks/useKespDemoRedactionEnabled';

type QualityFilter = 'all' | 'good' | 'medium' | 'bad';

const ALL_CALL_CATEGORIES: CallCategory[] = ['good', 'medium', 'bad', 'unknown'];
const CALLS_PAGE_MAX_RESULTS_PER_CATEGORY = 200;

/** Documents the categoryToQualityKey behavior. */
function categoryToQualityKey(category: CallCategory): 'good' | 'warn' | 'bad' | undefined {
  if (category === 'good') return 'good';
  if (category === 'medium') return 'warn';
  if (category === 'bad') return 'bad';
  return undefined;
}

/** Documents the sortCallsByCreatedAtDesc behavior. */
function sortCallsByCreatedAtDesc(calls: Call[]): Call[] {
  return [...calls].sort(/** Handles the callback for this operation. */(left, right) => {
    const leftTime = left.createdAt?.getTime?.() ?? 0;
    const rightTime = right.createdAt?.getTime?.() ?? 0;
    return rightTime - leftTime;
  });
}

/** Documents the mergeCallGroups behavior. */
function mergeCallGroups(groups: Iterable<Call[]>): Call[] {
  const callsById = new Map<string, Call>();
  for (const group of groups) {
    for (const call of group) {
      callsById.set(call.id, call);
    }
  }
  return sortCallsByCreatedAtDesc(Array.from(callsById.values()));
}

/** Documents the categoryLabel behavior. */
function categoryLabel(category: Exclude<CallCategory, 'unknown'>, t: TFunction): string {
  return t(`kesp.category.${category}`);
}

/** Documents the statusLabel behavior. */
function statusLabel(status: CallStatus, t: TFunction): string {
  return t(`kesp.status.${status}`);
}

/** Documents the analyzedTimestampForCall behavior. */
function analyzedTimestampForCall(call: Call): Date | undefined {
  return call.analysisCompletedAt ?? call.analysisStartedAt ?? call.createdAt;
}

/** Documents the formatDateTime behavior. */
function formatDateTime(date: Date | undefined, language: string | undefined): string {
  return formatKespDate(date, language, {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Renders the LlamadasPage component. */
export function LlamadasPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [qual, setQual] = useState<QualityFilter>('all');
  const demoMode = useKespDemoRedactionEnabled();

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return;

    if (qual !== 'all') {
      return subscribeToCalls(
        {
          userId: user.uid,
          category: qual,
          sortBy: 'createdAt',
          sortOrder: 'desc',
          maxResults: CALLS_PAGE_MAX_RESULTS_PER_CATEGORY,
          skipDemoTermRegistration: true,
        },
        /** Handles the callback for this operation. */
        (next) => {
          setCalls(next);
          setLoading(false);
        },
        /** Handles the callback for this operation. */
        () => {
          setCalls([]);
          setLoading(false);
        }
      );
    }

    let cancelled = false;
    const categoryCalls = new Map<CallCategory, Call[]>();
    const completedCategories = new Set<CallCategory>();
    const loadingFallbackId = window.setTimeout(
      /** Handles the callback for this operation. */
      () => {
        if (!cancelled) setLoading(false);
      },
      2500
    );

    /** Documents the publishMergedCalls behavior. */
    function publishMergedCalls(category: CallCategory, next: Call[]): void {
      if (cancelled) return;
      categoryCalls.set(category, next);
      completedCategories.add(category);
      const mergedCalls = mergeCallGroups(categoryCalls.values());
      setCalls(mergedCalls);
      if (mergedCalls.length > 0 || completedCategories.size === ALL_CALL_CATEGORIES.length) {
        setLoading(false);
      }
    }

    const unsubscribers = ALL_CALL_CATEGORIES.map(/** Handles the callback for this operation. */(category) =>
      subscribeToCalls(
      {
        userId: user.uid,
        category,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        maxResults: CALLS_PAGE_MAX_RESULTS_PER_CATEGORY,
        skipDemoTermRegistration: true,
      },
      /** Handles the callback for this operation. */
      (next) => {
        publishMergedCalls(category, next);
      },
      /** Handles the callback for this operation. */
      () => {
        publishMergedCalls(category, []);
      }
      )
    );

    return /** Handles the callback for this operation. */ () => {
      cancelled = true;
      window.clearTimeout(loadingFallbackId);
      unsubscribers.forEach(/** Handles the callback for this operation. */(unsubscribe) => unsubscribe());
    };
  }, [user?.uid, qual]);

  const list = useMemo(/** Handles the callback for this operation. */() => {
    if (!q.trim()) return calls;
    const needle = q.toLowerCase();
    return calls.filter(/** Handles the callback for this operation. */(c) => {
      const haystack = [c.id, c.displayName, c.name, c.salesAgentName].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [calls, q]);

  return (
    <main className="main">
      <div className="page-head">
        <div className="eyebrow">{t('kesp.calls.eyebrow')}</div>
        <h1 className="page-title">
          {t('kesp.calls.titlePrefix')} <span className="italic">{t('kesp.calls.titleItalic')}</span>
        </h1>
        <p className="page-sub">
          {t('kesp.calls.subtitle')}
        </p>
      </div>

      <div className="filters-row">
        <div className="search-input">
          <Icon name="search" size={14} />
          <input
            type="text"
            placeholder={t('kesp.calls.searchPlaceholder')}
            value={q}
            onChange={/** Handles the onChange interaction. */ (e) => setQ(e.target.value)}
          />
        </div>
        <select
          value={qual}
          onChange={/** Handles the onChange interaction. */ (e) => setQual(e.target.value as QualityFilter)}
        >
          <option value="all">{t('kesp.calls.allQualities')}</option>
          <option value="good">{t('kesp.category.good')}</option>
          <option value="medium">{t('kesp.category.medium')}</option>
          <option value="bad">{t('kesp.category.bad')}</option>
        </select>
        <Button kind="soft" size="sm" icon={<Icon name="download" size={13} />} disabled>
          {t('kesp.common.export')}
        </Button>
      </div>

      <div>
        {loading ? (
          <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <div className="muted">{t('kesp.calls.loading')}</div>
          </div>
        ) : list.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <div className="muted">{t('kesp.calls.empty')}</div>
          </div>
        ) : (
          list.map(/** Handles the callback for this operation. */(c) => {
            const qualityKey = categoryToQualityKey(c.category);
            const rawClientLabel = c.displayName || c.name || c.id;
            const clientLabel = demoMode ? maskKespDemoCallDisplayName(rawClientLabel) : rawClientLabel;
            const agentLabel = demoMode ? maskKespDemoAgentDisplayName(c.salesAgentName, c.canonicalSalesAgentId ?? c.salesAgentId) : c.salesAgentName;
            return (
              <div
                key={c.id}
                className="call-row"
                data-q={qualityKey}
                onClick={/** Handles the onClick interaction. */ () => navigate(`/kesp/call/${encodeURIComponent(c.id)}`)}
              >
                <div className="call-icon" data-q={qualityKey}>
                  <Icon name="phone" size={14} />
                </div>
                <div>
                  <div className="call-name">{clientLabel}</div>
                  <div className="meta">
                    {agentLabel && (
                      <>
                        <span>{agentLabel}</span>
                        <span className="muted-sep">·</span>
                      </>
                    )}
                    <span>{formatDateTime(analyzedTimestampForCall(c), i18n.resolvedLanguage)}</span>
                    {typeof c.duration === 'number' && c.duration > 0 && (
                      <>
                        <span className="muted-sep">·</span>
                        <span>{fmtDur(c.duration)}</span>
                      </>
                    )}
                    <span className="muted-sep">·</span>
                    <span>{statusLabel(c.status, t)}</span>
                    {c.aiAgentUpload === true && (
                      <>
                        <span className="muted-sep">·</span>
                        <span className="kesp-ai-test-chip">{t('kesp.calls.aiTest')}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                  {c.category !== 'unknown' && (
                    <div className="call-score" data-q={qualityKey}>
                      {categoryLabel(c.category, t)}
                    </div>
                  )}
                  <Icon name="arrow" size={14} />
                </div>
              </div>
            );
          })
        )}
      </div>
    </main>
  );
}
