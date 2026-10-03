import type { TFunction } from 'i18next';
import type { KespInboxMessage } from '@/types/kespInbox';

export interface KespInboxMessageDescription {
  title: string;
  body: string;
}

/** Documents the describeKespInboxMessage behavior. */
export function describeKespInboxMessage(
  message: KespInboxMessage,
  t: TFunction
): KespInboxMessageDescription {
  if (message.type === 'duplicate_call_excluded') {
    const callLabel = message.callName ?? message.callId ?? t('kesp.inbox.unknownCall');
    return {
      title: t('kesp.inbox.message.duplicateCallExcluded.title'),
      body: t('kesp.inbox.message.duplicateCallExcluded.body', { call: callLabel }),
    };
  }

  if (message.type === 'reanalyze_no_changes') {
    const agentLabel = message.salesAgentName ?? message.salesAgentId ?? t('kesp.inbox.unknownAgent');
    return {
      title: t('kesp.inbox.message.reanalyzeNoChanges.title'),
      body: t('kesp.inbox.message.reanalyzeNoChanges.body', { agent: agentLabel }),
    };
  }

  if (message.type === 'upload_batch_completed') {
    const count = message.callCount ?? message.callIds?.length ?? 0;
    const names = message.callNames?.slice(0, 3).join(', ') ?? '';
    return {
      title: t('kesp.inbox.message.uploadBatchCompleted.title', { count }),
      body: names
        ? t('kesp.inbox.message.uploadBatchCompleted.bodyWithNames', { count, names })
        : t('kesp.inbox.message.uploadBatchCompleted.body', { count }),
    };
  }

  if (message.type === 'call_unrecognized') {
    const callLabel = message.callName ?? message.callId ?? t('kesp.inbox.unknownCall');
    return {
      title: t('kesp.inbox.message.callUnrecognized.title'),
      body: t('kesp.inbox.message.callUnrecognized.body', { call: callLabel }),
    };
  }

  if (message.type === 'call_analysis_completed') {
    const callLabel = message.callName ?? message.callId ?? t('kesp.inbox.unknownCall');
    return {
      title: t('kesp.inbox.message.callAnalysisCompleted.title'),
      body: t('kesp.inbox.message.callAnalysisCompleted.body', { call: callLabel }),
    };
  }

  if (message.type === 'call_analysis_error') {
    const callLabel = message.callName ?? message.callId ?? t('kesp.inbox.unknownCall');
    return {
      title: t('kesp.inbox.message.callAnalysisError.title'),
      body: t('kesp.inbox.message.callAnalysisError.body', { call: callLabel }),
    };
  }

  if (message.type === 'agent_report_completed') {
    const agentLabel = message.salesAgentName ?? message.salesAgentId ?? t('kesp.inbox.unknownAgent');
    return {
      title: t('kesp.inbox.message.agentReportCompleted.title'),
      body: t('kesp.inbox.message.agentReportCompleted.body', { agent: agentLabel }),
    };
  }

  if (message.type === 'agent_report_error') {
    const agentLabel = message.salesAgentName ?? message.salesAgentId ?? t('kesp.inbox.unknownAgent');
    return {
      title: t('kesp.inbox.message.agentReportError.title'),
      body: t('kesp.inbox.message.agentReportError.body', { agent: agentLabel }),
    };
  }

  if (message.type === 'agent_check_in') {
    const agentLabel = message.salesAgentName ?? message.salesAgentId ?? t('kesp.inbox.unknownAgent');
    return {
      title: t('kesp.inbox.message.agentCheckIn.title'),
      body: t('kesp.inbox.message.agentCheckIn.body', { agent: agentLabel }),
    };
  }

  return {
    title: t('kesp.inbox.message.unknown.title'),
    body: t('kesp.inbox.message.unknown.body'),
  };
}

/** Documents the getKespInboxMessageHref behavior. */
export function getKespInboxMessageHref(message: KespInboxMessage): string | null {
  if (message.type === 'call_unrecognized') {
    return '/kesp/analizador/unrecognized';
  }

  if (
    message.type === 'call_analysis_completed' ||
    message.type === 'call_analysis_error' ||
    message.type === 'duplicate_call_excluded'
  ) {
    return message.callId ? `/kesp/call/${message.callId}` : null;
  }

  if (
    message.type === 'agent_report_completed' ||
    message.type === 'agent_report_error' ||
    message.type === 'agent_check_in' ||
    message.type === 'reanalyze_no_changes'
  ) {
    return message.agentAnalysisId ? `/kesp/agent/${message.agentAnalysisId}` : null;
  }

  return null;
}
