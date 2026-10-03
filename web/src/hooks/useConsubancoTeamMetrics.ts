import { useEffect, useMemo, useState } from 'react';
import { subscribeToAgentCallSnapshots } from '@/services/agentActivity';
import type { AgentCallSnapshot } from '@/types';
import type { AgentAnalysis } from '@/types/agentAnalysis';
import { buildAgentKey, getCurrentBucketKey } from '@/lib/agentActivity';
import { getAgentInitials } from '@/lib/consubancoAgents';

interface SnapshotSubscriptionState {
  profileSignature?: string;
  snapshotsByAgent: Record<string, AgentCallSnapshot[]>;
  loadedAgentIds: Set<string>;
}

export interface ConsubancoAgentMetrics {
  agent: AgentAnalysis;
  initials: string;
  snapshots: AgentCallSnapshot[];
  currentSnapshots: AgentCallSnapshot[];
  previousSnapshots: AgentCallSnapshot[];
  totalAnalyzedCalls: number;
  currentAnalyzedCalls: number;
  soldLoanCount: number;
  amountPlaced: number;
  averageScore: number | null;
  previousAverageScore: number | null;
  scoreDelta: number | null;
  conversionRate: number | null;
  scoreTrend: Array<number | null>;
  status: 'good' | 'warn' | 'bad';
  topWeakness: string | null;
}

export interface TeamPatternMetric {
  title: string;
  affectedAgents: number;
  affectedCalls: number;
  pct: number;
  severity: 'good' | 'warn' | 'bad';
}

export interface TeamTrendMetric {
  monthKey: string;
  label: string;
  amountPlaced: number;
  averageScore: number | null;
  analyzedCalls: number;
}

export interface ConsubancoTeamMetrics {
  loading: boolean;
  agents: ConsubancoAgentMetrics[];
  officialAgentCount: number;
  activeAgentCount: number;
  totalAnalyzedCalls: number;
  averageScore: number | null;
  latestMonthKey: string;
  previousMonthKey: string;
  periodLabel: string;
  activeTodayCount: number;
  soldLoanCount: number;
  amountPlaced: number;
  conversionRate: number | null;
  teamTrend: TeamTrendMetric[];
  moversUp: ConsubancoAgentMetrics[];
  moversDown: ConsubancoAgentMetrics[];
  teamPatterns: TeamPatternMetric[];
  coachingPriority: ConsubancoAgentMetrics[];
}

/** Documents the isFiniteNumber behavior. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Documents the average behavior. */
function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce(/** Handles the callback for this operation. */(sum, value) => sum + value, 0) / values.length;
}

/** Documents the formatMonthLabel behavior. */
function formatMonthLabel(monthKey: string, language?: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month) return monthKey;
  return new Intl.DateTimeFormat(language?.startsWith('en') ? 'en-US' : 'es-MX', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** Documents the shiftMonthKey behavior. */
function shiftMonthKey(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month) return getCurrentBucketKey('month');
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Documents the buildRecentMonthKeys behavior. */
function buildRecentMonthKeys(latestMonthKey: string, count: number): string[] {
  return Array.from({ length: count }, /** Handles the callback for this operation. */(_, index) =>
    shiftMonthKey(latestMonthKey, index - count + 1)
  );
}

/** Documents the getScoreValues behavior. */
function getScoreValues(snapshots: AgentCallSnapshot[]): number[] {
  return snapshots.map(/** Handles the callback for this operation. */(snapshot) => snapshot.overallScore).filter(isFiniteNumber);
}

/** Documents the isSoldLoanSnapshot behavior. */
function isSoldLoanSnapshot(snapshot: AgentCallSnapshot): boolean {
  if (snapshot.effectiveLifecycleStage === 'lost_cancelled') return false;
  return (
    snapshot.effectiveLifecycleStage === 'fully_completed' ||
    snapshot.effectiveLifecycleStage === 'sold_pending_follow_through' ||
    snapshot.saleReachedOnCall === true ||
    snapshot.loanCompleted === 'yes'
  );
}

/** Documents the getStatus behavior. */
function getStatus(score: number | null): 'good' | 'warn' | 'bad' {
  if (score == null) return 'warn';
  if (score >= 80) return 'good';
  if (score >= 70) return 'warn';
  return 'bad';
}

/** Documents the getTopWeakness behavior. */
function getTopWeakness(snapshots: AgentCallSnapshot[]): string | null {
  const counts = new Map<string, number>();
  for (const snapshot of snapshots) {
    for (const title of snapshot.weaknessTitles) {
      if (!title) continue;
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
  }
  return (
    Array.from(counts.entries()).sort(/** Handles the callback for this operation. */(left, right) => right[1] - left[1])[0]?.[0] ?? null
  );
}

/** Documents the buildAgentMetrics behavior. */
function buildAgentMetrics(
  agent: AgentAnalysis,
  snapshots: AgentCallSnapshot[],
  latestMonthKey: string,
  previousMonthKey: string
): ConsubancoAgentMetrics {
  const currentSnapshots = snapshots.filter(/** Handles the callback for this operation. */(snapshot) => snapshot.bucketMonth === latestMonthKey);
  const previousSnapshots = snapshots.filter(
    /** Handles the callback for this operation. */
    (snapshot) => snapshot.bucketMonth === previousMonthKey
  );
  const soldSnapshots = currentSnapshots.filter(isSoldLoanSnapshot);
  const averageScore = average(getScoreValues(currentSnapshots));
  const previousAverageScore = average(getScoreValues(previousSnapshots));
  const recentMonths = buildRecentMonthKeys(latestMonthKey, 7);
  const scoreTrend = recentMonths.map(/** Handles the callback for this operation. */(monthKey) =>
    average(getScoreValues(snapshots.filter(/** Handles the callback for this operation. */(snapshot) => snapshot.bucketMonth === monthKey)))
  );

  return {
    agent,
    initials: getAgentInitials(agent.salesAgentName),
    snapshots,
    currentSnapshots,
    previousSnapshots,
    totalAnalyzedCalls: snapshots.length,
    currentAnalyzedCalls: currentSnapshots.length,
    soldLoanCount: soldSnapshots.length,
    amountPlaced: soldSnapshots.reduce(
      /** Handles the callback for this operation. */
      (sum, snapshot) => sum + (isFiniteNumber(snapshot.loanAmount) ? snapshot.loanAmount : 0),
      0
    ),
    averageScore,
    previousAverageScore,
    scoreDelta:
      averageScore != null && previousAverageScore != null ? averageScore - previousAverageScore : null,
    conversionRate:
      currentSnapshots.length > 0 ? (soldSnapshots.length / currentSnapshots.length) * 100 : null,
    scoreTrend,
    status: getStatus(averageScore),
    topWeakness: getTopWeakness(currentSnapshots),
  };
}

/** Documents the buildTeamPatterns behavior. */
function buildTeamPatterns(agentMetrics: ConsubancoAgentMetrics[]): TeamPatternMetric[] {
  const patternMap = new Map<string, { calls: number; agents: Set<string> }>();
  for (const metric of agentMetrics) {
    for (const snapshot of metric.currentSnapshots) {
      const uniqueTitles = new Set(snapshot.weaknessTitles.filter(Boolean));
      for (const title of uniqueTitles) {
        const existing = patternMap.get(title) ?? { calls: 0, agents: new Set<string>() };
        existing.calls += 1;
        existing.agents.add(metric.agent.id);
        patternMap.set(title, existing);
      }
    }
  }

  return Array.from(patternMap.entries())
    .map(/** Handles the callback for this operation. */([title, value]) => {
      const affectedAgents = value.agents.size;
      const pct =
        agentMetrics.length > 0
          ? Math.round((affectedAgents / agentMetrics.length) * 100)
          : 0;
      return {
        title,
        affectedAgents,
        affectedCalls: value.calls,
        pct,
        severity: pct >= 25 ? 'bad' : pct >= 10 ? 'warn' : 'good',
      } satisfies TeamPatternMetric;
    })
    .sort(/** Handles the callback for this operation. */(left, right) => right.affectedCalls - left.affectedCalls)
    .slice(0, 5);
}

/** Documents the useConsubancoTeamMetrics behavior. */
export function useConsubancoTeamMetrics(
  canonicalAgents: AgentAnalysis[],
  language?: string
): ConsubancoTeamMetrics {
  const profileSignature = useMemo(
    /** Handles the callback for this operation. */
    () => canonicalAgents.map(/** Handles the callback for this operation. */(agent) => `${agent.id}:${agent.uploadedBy}:${agent.salesAgentId}`).join('|'),
    [canonicalAgents]
  );
  const [snapshotState, setSnapshotState] = useState<SnapshotSubscriptionState>({
    snapshotsByAgent: {},
    loadedAgentIds: new Set(),
  });

  useEffect(/** Handles the callback for this operation. */() => {
    if (canonicalAgents.length === 0) return undefined;

    const unsubscribes = canonicalAgents.map(/** Handles the callback for this operation. */(agent) => {
      const agentKey = buildAgentKey(agent.uploadedBy, agent.salesAgentId);
      return subscribeToAgentCallSnapshots(agentKey, /** Handles the callback for this operation. */(snapshots) => {
        setSnapshotState(/** Handles the callback for this operation. */(current) => {
          const base =
            current.profileSignature === profileSignature
              ? current
              : { profileSignature, snapshotsByAgent: {}, loadedAgentIds: new Set<string>() };
          const next = new Set(base.loadedAgentIds);
          next.add(agent.id);
          return {
            profileSignature,
            snapshotsByAgent: {
              ...base.snapshotsByAgent,
              [agent.id]: snapshots,
            },
            loadedAgentIds: next,
          };
        });
      });
    });

    return /** Handles the callback for this operation. */ () => {
      unsubscribes.forEach(/** Handles the callback for this operation. */(unsubscribe) => unsubscribe());
    };
  }, [canonicalAgents, profileSignature]);

  return useMemo(/** Handles the callback for this operation. */() => {
    const snapshotsByAgent =
      snapshotState.profileSignature === profileSignature ? snapshotState.snapshotsByAgent : {};
    const loadedAgentCount =
      snapshotState.profileSignature === profileSignature ? snapshotState.loadedAgentIds.size : 0;
    const allSnapshots = canonicalAgents.flatMap(
      /** Handles the callback for this operation. */
      (agent) => snapshotsByAgent[agent.id] ?? []
    );
    const latestMonthKey =
      allSnapshots
        .map(/** Handles the callback for this operation. */(snapshot) => snapshot.bucketMonth)
        .filter(Boolean)
        .sort()
        .at(-1) ?? getCurrentBucketKey('month');
    const previousMonthKey = shiftMonthKey(latestMonthKey, -1);
    const agents = canonicalAgents.map(/** Handles the callback for this operation. */(agent) =>
      buildAgentMetrics(agent, snapshotsByAgent[agent.id] ?? [], latestMonthKey, previousMonthKey)
    );
    const currentSnapshots = agents.flatMap(/** Handles the callback for this operation. */(agent) => agent.currentSnapshots);
    const currentSoldSnapshots = currentSnapshots.filter(isSoldLoanSnapshot);
    const totalAnalyzedCalls = allSnapshots.length;
    const allScoreValues = getScoreValues(allSnapshots);
    const activeTodayKey = getCurrentBucketKey('day');
    const recentMonths = buildRecentMonthKeys(latestMonthKey, 7);
    const teamTrend = recentMonths.map(/** Handles the callback for this operation. */(monthKey) => {
      const monthSnapshots = allSnapshots.filter(/** Handles the callback for this operation. */(snapshot) => snapshot.bucketMonth === monthKey);
      const monthSoldSnapshots = monthSnapshots.filter(isSoldLoanSnapshot);
      return {
        monthKey,
        label: formatMonthLabel(monthKey, language).slice(0, 3),
        amountPlaced: monthSoldSnapshots.reduce(
          /** Handles the callback for this operation. */
          (sum, snapshot) => sum + (isFiniteNumber(snapshot.loanAmount) ? snapshot.loanAmount : 0),
          0
        ),
        averageScore: average(getScoreValues(monthSnapshots)),
        analyzedCalls: monthSnapshots.length,
      };
    });
    const moversUp = agents
      .filter(/** Handles the callback for this operation. */(agent) => agent.scoreDelta != null && agent.scoreDelta > 0)
      .sort(/** Handles the callback for this operation. */(left, right) => (right.scoreDelta ?? 0) - (left.scoreDelta ?? 0))
      .slice(0, 3);
    const moversDown = agents
      .filter(/** Handles the callback for this operation. */(agent) => agent.totalAnalyzedCalls > 0)
      .sort(/** Handles the callback for this operation. */(left, right) => {
        const leftDelta = left.scoreDelta ?? (left.averageScore != null ? left.averageScore - 70 : 0);
        const rightDelta =
          right.scoreDelta ?? (right.averageScore != null ? right.averageScore - 70 : 0);
        return leftDelta - rightDelta;
      })
      .slice(0, 3);
    const coachingPriority = agents
      .filter(/** Handles the callback for this operation. */(agent) => agent.totalAnalyzedCalls > 0)
      .sort(/** Handles the callback for this operation. */(left, right) => {
        const leftScore = left.averageScore ?? 101;
        const rightScore = right.averageScore ?? 101;
        const leftDelta = left.scoreDelta ?? 0;
        const rightDelta = right.scoreDelta ?? 0;
        return leftScore - rightScore || leftDelta - rightDelta;
      })
      .slice(0, 4);

    return {
      loading: canonicalAgents.length > 0 && loadedAgentCount < canonicalAgents.length,
      agents,
      officialAgentCount: canonicalAgents.length,
      activeAgentCount: agents.filter(/** Handles the callback for this operation. */(agent) => agent.totalAnalyzedCalls > 0).length,
      totalAnalyzedCalls,
      averageScore: average(allScoreValues),
      latestMonthKey,
      previousMonthKey,
      periodLabel: formatMonthLabel(latestMonthKey, language),
      activeTodayCount: agents.filter(/** Handles the callback for this operation. */(agent) =>
        agent.snapshots.some(/** Handles the callback for this operation. */(snapshot) => snapshot.bucketDay === activeTodayKey)
      ).length,
      soldLoanCount: currentSoldSnapshots.length,
      amountPlaced: currentSoldSnapshots.reduce(
        /** Handles the callback for this operation. */
        (sum, snapshot) => sum + (isFiniteNumber(snapshot.loanAmount) ? snapshot.loanAmount : 0),
        0
      ),
      conversionRate:
        currentSnapshots.length > 0 ? (currentSoldSnapshots.length / currentSnapshots.length) * 100 : null,
      teamTrend,
      moversUp,
      moversDown,
      teamPatterns: buildTeamPatterns(agents),
      coachingPriority,
    };
  }, [canonicalAgents, language, profileSignature, snapshotState]);
}
