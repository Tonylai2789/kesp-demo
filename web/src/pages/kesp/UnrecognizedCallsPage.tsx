import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/useAuth';
import { subscribeToAgentAnalyses } from '@/services/agentAnalyses';
import { subscribeToCalls } from '@/services/firestore';
import { assignUnrecognizedCallToAgent } from '@/services/functions';
import { Icon } from '@/components/kesp/icons';
import { Button, Pill } from '@/components/kesp/primitives';
import type { AgentAnalysis, Call } from '@/types';
import { formatKespDate } from '@/lib/kespI18n';
import { maskKespDemoAgentDisplayName } from '@/lib/kespDemoRedaction';
import { appendReturnTo } from '@/lib/returnTo';

/** Documents the formatDate behavior. */
function formatDate(date: Date | undefined, language: string | undefined): string {
  return formatKespDate(date, language, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Documents the reasonLabel behavior. */
function reasonLabel(reason: string | undefined, t: TFunction): string {
  if (reason === 'no_agent_name_extracted') return t('kesp.unrecognized.reason.no_agent_name_extracted');
  if (reason === 'ambiguous_active_agent_match') return t('kesp.unrecognized.reason.ambiguous_active_agent_match');
  if (reason === 'low_confidence_agent_name_match') return t('kesp.unrecognized.reason.low_confidence_agent_name_match');
  if (reason === 'no_matching_active_agent') return t('kesp.unrecognized.reason.no_matching_active_agent');
  if (reason === 'selected_agent_missing_verified_ccc_mapping') return t('kesp.unrecognized.reason.pendingMapping');
  if (reason === 'manual_no_agent_selected') return t('kesp.unrecognized.reason.noAgent');
  if (reason === 'verified_ccc_mapping_required') return t('kesp.unrecognized.reason.pendingMapping');
  return t('kesp.unrecognized.reason.pending');
}

/** Renders the UnrecognizedCallsPage component. */
export function UnrecognizedCallsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [calls, setCalls] = useState<Call[]>([]);
  const [activeTab, setActiveTab] = useState<'unrecognized' | 'noAgent'>('unrecognized');
  const [agents, setAgents] = useState<AgentAnalysis[]>([]);
  const [selectedAgentByCall, setSelectedAgentByCall] = useState<Record<string, string>>({});
  const [assigningCallId, setAssigningCallId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return;
    return subscribeToAgentAnalyses(user.uid, setAgents);
  }, [t, user?.uid]);

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return;
    setLoading(true);
    const filters = activeTab === 'unrecognized'
      ? {
        userId: user.uid,
        agentRoutingMode: 'general' as const,
        agentRoutingStatus: 'unrecognized' as const,
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const,
        maxResults: 100,
      }
      : {
        userId: user.uid,
        agentRoutingStatuses: ['no_agent' as const, 'pending_mapping' as const],
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const,
        maxResults: 100,
      };
    return subscribeToCalls(
      filters,
      /** Handles the callback for this operation. */
      (next) => {
        setCalls(next);
        setLoading(false);
      }
    );
  }, [activeTab, user?.uid]);

  const selectableAgents = useMemo(
    /** Handles the callback for this operation. */
    () =>
      [...agents]
        .filter(/** Handles the callback for this operation. */(agent) => agent.salesAgentId && agent.salesAgentName)
        .sort(/** Handles the callback for this operation. */(a, b) => a.salesAgentName.localeCompare(b.salesAgentName, 'es')),
    [agents]
  );

  const assignCall = /** Documents the assignCall behavior. */ async (callId: string) => {
    const agentAnalysisId = selectedAgentByCall[callId];
    if (!agentAnalysisId) {
      toast.error(t('kesp.unrecognized.toasts.selectAgent'));
      return;
    }

    setAssigningCallId(callId);
    try {
      await assignUnrecognizedCallToAgent(callId, agentAnalysisId);
      toast.success(t('kesp.unrecognized.toasts.assignSuccess'));
    } catch (error) {
      console.error('Failed to assign unrecognized call:', error);
      toast.error(t('kesp.unrecognized.toasts.assignError'));
    } finally {
      setAssigningCallId(null);
    }
  };

  return (
    <main className="main">
      <div className="page-head">
        <div className="eyebrow">{t('kesp.unrecognized.eyebrow')}</div>
        <h1 className="page-title">
          {t('kesp.unrecognized.titlePrefix')} <span className="italic">{t('kesp.unrecognized.titleItalic')}</span>
        </h1>
        <p className="page-sub">
          {t('kesp.unrecognized.subtitle')}
        </p>
      </div>

      <div className="row row-between row-wrap" style={{ marginBottom: 16, gap: 12 }}>
        <div className="row row-wrap" style={{ gap: 8 }}>
          <Button
            kind={activeTab === 'unrecognized' ? 'primary' : 'soft'}
            size="sm"
            icon={<Icon name="flag" size={12} />}
            onClick={/** Handles the onClick interaction. */ () => setActiveTab('unrecognized')}
          >
            {t('kesp.unrecognized.tabs.unrecognized')}
          </Button>
          <Button
            kind={activeTab === 'noAgent' ? 'primary' : 'soft'}
            size="sm"
            icon={<Icon name="users" size={12} />}
            onClick={/** Handles the onClick interaction. */ () => setActiveTab('noAgent')}
          >
            {t('kesp.unrecognized.tabs.noAgent')}
          </Button>
          <Pill kind={calls.length > 0 ? 'warn' : 'good'} icon={<Icon name="flag" size={12} />}>
            {t('kesp.unrecognized.pending', { count: calls.length })}
          </Pill>
        </div>
        <Button kind="soft" size="sm" icon={<Icon name="arrow" size={14} />} onClick={/** Handles the onClick interaction. */ () => navigate('/kesp/analizador')}>
          {t('kesp.common.back')}
        </Button>
      </div>

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.unrecognized.loading')}</div>
        </div>
      ) : calls.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">{t('kesp.unrecognized.empty')}</div>
        </div>
      ) : (
        <div className="card">
          {calls.map(/** Handles the callback for this operation. */(call, index) => (
            <div
              key={call.id}
              className="row row-wrap"
              style={{
                alignItems: 'center',
                gap: 12,
                padding: '14px 0',
                borderBottom: index < calls.length - 1 ? '1px solid var(--line)' : '0',
              }}
            >
              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {call.displayName || call.name || call.id}
                </div>
                <div className="muted tiny" style={{ marginTop: 4 }}>
                  {activeTab === 'unrecognized'
                    ? t('kesp.unrecognized.detected', {
                      name: call.extractedAgentName || t('kesp.common.notAvailable'),
                    })
                    : t('kesp.unrecognized.noAgentStatus')}{' '}
                  · {formatDate(call.createdAt, i18n.resolvedLanguage)}
                </div>
              </div>
              <Pill kind="warn">{reasonLabel(call.agentRoutingReason, t)}</Pill>
              <select
                value={selectedAgentByCall[call.id] ?? ''}
                onChange={/** Handles the onChange interaction. */ (event) =>
                  setSelectedAgentByCall(/** Handles the callback for this operation. */(prev) => ({
                    ...prev,
                    [call.id]: event.target.value,
                  }))
                }
                disabled={assigningCallId === call.id}
                style={{ flex: '1 1 240px', minWidth: 220 }}
              >
                <option value="">{t('kesp.unrecognized.selectAgent')}</option>
                {selectableAgents.map(/** Handles the callback for this operation. */(agent) => (
                  <option key={agent.id} value={agent.id}>
                    {maskKespDemoAgentDisplayName(agent.salesAgentName, agent.salesAgentId)}
                  </option>
                ))}
              </select>
              <Button
                kind="primary"
                size="sm"
                icon={<Icon name="check" size={13} />}
                onClick={/** Handles the onClick interaction. */ () => assignCall(call.id)}
                disabled={assigningCallId === call.id || selectableAgents.length === 0}
              >
                {assigningCallId === call.id ? t('kesp.common.assigning') : t('kesp.common.assign')}
              </Button>
              <Button
                kind="ghost"
                size="sm"
                icon={<Icon name="eye" size={13} />}
                onClick={/** Handles the onClick interaction. */ () =>
                  navigate(appendReturnTo(`/kesp/call/${encodeURIComponent(call.id)}`, '/kesp/analizador/unrecognized'))
                }
              >
                {t('kesp.common.view')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
