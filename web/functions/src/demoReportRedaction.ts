import { createHash } from 'node:crypto';
import type { AgentCoachingReport } from './agentCoachingReport';
import { demoAgentLabel, demoAgentNameFragments, isDemoMaskedValue, redactUnmaskedDemoText } from './demoIdentity';

const HIDDEN_EVIDENCE = '*EVIDENCIA OCULTA PARA DEMO*';

/** Presentation masking only: source data must already be safe for the demo. */
export function redactDemoReport(report: AgentCoachingReport): AgentCoachingReport {
  const replacements = new Map<string, string>();
  const clients = new Map<string, string>();
  const calls = new Map<string, string>();
  const key = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const add = (value: string | null, label: string) => {
    if (value?.trim() && !isDemoMaskedValue(value)) replacements.set(key(value), label);
  };
  const indexed = (value: string, labels: Map<string, string>, prefix: string) => {
    const id = key(value);
    if (!labels.has(id)) labels.set(id, `${prefix}${String(labels.size + 1).padStart(2, '0')}`);
    return labels.get(id)!;
  };
  const agentLabel = demoAgentLabel(report.agent.salesAgentId, value => createHash('sha256').update(value).digest('hex'));
  add(report.agent.salesAgentName, agentLabel);
  add(report.agent.salesAgentId, agentLabel);
  for (const fragment of demoAgentNameFragments(report.agent.salesAgentName)) add(fragment, agentLabel);
  for (const row of [...report.selectedCalls, ...report.followUpOpportunities]) {
    // Distinct masked IDs preserve preview list keys without exposing source IDs.
    add(row.callId, indexed(row.callId, calls, '*LLAMADA DEMO* '));
    if (row.customerName) add(row.customerName, `${indexed(row.customerName, clients, '*CLIENTE ')}*`);
  }
  for (const id of report.options.selectedCallIds ?? []) add(id, indexed(id, calls, '*LLAMADA DEMO* '));
  for (const row of report.selectedCalls) {
    add(row.callName, '*LLAMADA DEMO*');
    add(row.summary, HIDDEN_EVIDENCE);
  }
  for (const priority of report.coachingPriorities) {
    for (const id of priority.relatedRubricCriteria) add(id, '*ID DEMO*');
    for (const evidence of priority.evidence) add(evidence, HIDDEN_EVIDENCE);
  }
  for (const row of [...report.objectionPlaybook, ...report.followUpOpportunities]) add(row.evidence, HIDDEN_EVIDENCE);

  // One longest-first pass also covers evidence/identity copies inside action plans
  // and coaching prose, without applying replacements again to generated labels.
  const terms = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const pattern = terms.length ? new RegExp('(?<![\\p{L}\\p{N}])(?:' + terms.map(term =>
    term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  ).join('|') + ')(?![\\p{L}\\p{N}])', 'giu') : null;
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') return pattern ? redactUnmaskedDemoText(value, text => text.replace(pattern, match => replacements.get(key(match))!)) : value;
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, child]) => [field, redact(child)]));
    return value;
  };
  const masked = redact(report) as AgentCoachingReport;
  masked.agent.salesAgentId = agentLabel;
  masked.agent.salesAgentName = isDemoMaskedValue(report.agent.salesAgentName) ? report.agent.salesAgentName : agentLabel;
  // These are validated period/option values, not presentation prose or identity.
  masked.reportType = report.reportType;
  masked.dateRange = { ...report.dateRange, label: masked.dateRange.label };
  masked.generatedAt = report.generatedAt;
  masked.options.reportLength = report.options.reportLength;
  masked.selectedCalls.forEach((row, index) => {
    row.callOccurredAtIso = report.selectedCalls[index].callOccurredAtIso;
    row.bucketDay = report.selectedCalls[index].bucketDay;
  });
  return masked;
}

export function demoReportFilename(report: AgentCoachingReport): string {
  return `demo-${report.reportType}-${report.dateRange.startDate}-${report.dateRange.endDate}.pdf`;
}
