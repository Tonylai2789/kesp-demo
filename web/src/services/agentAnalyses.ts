import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type DocumentData,
  type QueryConstraint,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db } from './firebase';
import { isDemoFirebaseProject } from './firebaseApp';
import { functions } from './firebaseFunctions';
import type {
  AgentAnalysis,
  AgentAnalysisProcessingConfig,
  AgentAnalysisReport,
  AgentAnalysisReportV2,
  AgentAnalysisRun,
  AgentAnalysisRunTask,
  AgentAnalysisStatus,
  BehaviorPattern,
  BehaviorPatternExample,
  BehaviorPatternExecutionGuide,
  SeverityBinReport,
  SummarizedWeakness,
  LegacyAgentAnalysisReport,
  WeaknessSeverityBin,
  WeaknessSummaryDepth,
} from '@/types';
import {
  registerKespDemoAgentAnalysisTerms,
  registerKespDemoAgentReportTerms,
} from '@/lib/kespDemoRedaction';

const AGENT_ANALYSES_COLLECTION = 'agent_analyses';
const CONSUBANCO_ORGANIZATION_ID = 'consubanco';
/** Calls an external SDK or API dependency. */
const startAgentAnalysisFn = httpsCallable<
  { agentAnalysisId: string; reportProcessingConfig?: AgentAnalysisProcessingConfig },
  {
    success: boolean;
    started: boolean;
    result:
    | 'started'
    | 'already_running'
    | 'no_changes'
    | 'no_complete_calls'
    | 'no_eligible_calls';
    sourceCallCount: number;
    eligibleCallCount: number;
    latestReportId?: string;
    activeRunId?: string;
  }
>(functions, 'startAgentAnalysis');
const severityBins: WeaknessSeverityBin[] = [
  'severe',
  'moderate-severe',
  'moderate',
  'moderate-minor',
  'minor',
];

const summaryDepthBySeverity: Record<WeaknessSeverityBin, WeaknessSummaryDepth> = {
  severe: 'comprehensive',
  'moderate-severe': 'detailed',
  moderate: 'balanced',
  'moderate-minor': 'concise',
  minor: 'very-concise',
};

/** Documents the timestampToDate behavior. */
function timestampToDate(timestamp: Timestamp | undefined): Date | undefined {
  return timestamp?.toDate();
}

/** Documents the normalizeString behavior. */
function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Documents the normalizeOptionalString behavior. */
function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Documents the normalizeSummaryDepth behavior. */
function normalizeSummaryDepth(
  value: unknown,
  severityBin: WeaknessSeverityBin
): WeaknessSummaryDepth {
  return value === 'very-concise' ||
    value === 'concise' ||
    value === 'balanced' ||
    value === 'detailed' ||
    value === 'comprehensive'
    ? value
    : summaryDepthBySeverity[severityBin];
}

/** Documents the normalizeSummarizedWeakness behavior. */
function normalizeSummarizedWeakness(
  value: unknown,
  severityBin: WeaknessSeverityBin,
  index: number
): SummarizedWeakness {
  const weakness = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const critique =
    weakness.critique && typeof weakness.critique === 'object'
      ? (weakness.critique as Record<string, unknown>)
      : {};

  return {
    summaryId: normalizeString(weakness.summaryId, `${severityBin}:summary:${index + 1}`),
    sourceGroupIds: Array.isArray(weakness.sourceGroupIds)
      ? weakness.sourceGroupIds.filter(
        /** Handles the callback for this operation. */
        (groupId): groupId is string => typeof groupId === 'string' && groupId.length > 0
      )
      : [],
    critique: {
      headline: normalizeString(critique.headline),
      summary: normalizeString(critique.summary),
      affectedCallCount:
        typeof critique.affectedCallCount === 'number' ? critique.affectedCallCount : 0,
      occurrenceCount: typeof critique.occurrenceCount === 'number' ? critique.occurrenceCount : 0,
    },
    evidence: Array.isArray(weakness.evidence)
      ? weakness.evidence
        .filter(
          /** Handles the callback for this operation. */
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
        )
        .map(/** Handles the callback for this operation. */(item) => ({
          callId: normalizeString(item.callId),
          quote: normalizeString(item.quote),
          speakerLabel:
            typeof item.speakerLabel === 'string'
              ? item.speakerLabel
              : typeof item.speaker_label === 'string'
                ? item.speaker_label
                : null,
          speakerDisplay:
            typeof item.speakerDisplay === 'string'
              ? item.speakerDisplay
              : typeof item.speaker_display === 'string'
                ? item.speaker_display
                : null,
        }))
        .filter(/** Handles the callback for this operation. */(item) => item.quote.length > 0)
      : [],
    mentorshipTips: Array.isArray(weakness.mentorshipTips)
      ? weakness.mentorshipTips
        .filter(
          /** Handles the callback for this operation. */
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
        )
        .reduce<Array<{ tip: string; priority: 'primary' | 'secondary' }>>(/** Handles the callback for this operation. */(tips, item) => {
          const priority: 'primary' | 'secondary' =
            item.priority === 'secondary' ? 'secondary' : 'primary';
          const tip = normalizeString(item.tip);
          if (tip.length > 0) {
            tips.push({ tip, priority });
          }
          return tips;
        }, [])
      : [],
  };
}

/** Documents the normalizeSeverityBinReport behavior. */
function normalizeSeverityBinReport(
  value: unknown,
  severityBin: WeaknessSeverityBin
): SeverityBinReport | null {
  const report = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!report) {
    return null;
  }

  return {
    summaryDepth: normalizeSummaryDepth(report.summaryDepth, severityBin),
    summarizedWeaknesses: Array.isArray(report.summarizedWeaknesses)
      ? report.summarizedWeaknesses.map(/** Handles the callback for this operation. */(item, index) =>
        normalizeSummarizedWeakness(item, severityBin, index)
      )
      : [],
    overflowSummary:
      report.overflowSummary && typeof report.overflowSummary === 'object'
        ? {
          critique: normalizeString(
            (report.overflowSummary as Record<string, unknown>).critique
          ),
          evidence: Array.isArray((report.overflowSummary as Record<string, unknown>).evidence)
            ? ((report.overflowSummary as Record<string, unknown>).evidence as unknown[])
              .filter(
                /** Handles the callback for this operation. */
                (item): item is Record<string, unknown> =>
                  Boolean(item) && typeof item === 'object'
              )
              .map(/** Handles the callback for this operation. */(item) => ({
                callId: normalizeString(item.callId),
                quote: normalizeString(item.quote),
              }))
              .filter(/** Handles the callback for this operation. */(item) => item.quote.length > 0)
            : [],
          mentorshipTips: Array.isArray(
            (report.overflowSummary as Record<string, unknown>).mentorshipTips
          )
            ? ((report.overflowSummary as Record<string, unknown>).mentorshipTips as unknown[])
              .filter(
                /** Handles the callback for this operation. */
                (item): item is Record<string, unknown> =>
                  Boolean(item) && typeof item === 'object'
              )
              .map(/** Handles the callback for this operation. */(item) => ({
                tip: normalizeString(item.tip),
              }))
              .filter(/** Handles the callback for this operation. */(item) => item.tip.length > 0)
            : [],
        }
        : null,
  };
}

/** Documents the normalizeSeverityBins behavior. */
function normalizeSeverityBins(
  value: unknown
): Partial<Record<WeaknessSeverityBin, SeverityBinReport>> {
  const rawBins = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const normalized: Partial<Record<WeaknessSeverityBin, SeverityBinReport>> = {};

  for (const severityBin of severityBins) {
    const nextBin = normalizeSeverityBinReport(rawBins[severityBin], severityBin);
    if (nextBin) {
      normalized[severityBin] = nextBin;
    }
  }

  return normalized;
}

/** Documents the normalizeSeverityDistribution behavior. */
function normalizeSeverityDistribution(
  value: unknown
): Partial<Record<WeaknessSeverityBin, number>> {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const normalized: Partial<Record<WeaknessSeverityBin, number>> = {};

  for (const severityBin of severityBins) {
    const count = source[severityBin];
    if (typeof count === 'number' && count > 0) {
      normalized[severityBin] = count;
    }
  }

  return normalized;
}

/** Documents the normalizeComparisonText behavior. */
function normalizeComparisonText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Documents the looksActionOnlyExampleResponse behavior. */
function looksActionOnlyExampleResponse(value: string): boolean {
  const normalized = normalizeComparisonText(value);
  if (!normalized) {
    return true;
  }

  const actionAdvicePrefixes = [
    'debio ',
    'debiste ',
    'debe ',
    'deberia ',
    'habia que ',
    'hay que ',
    'se debe ',
    'se debio ',
    'tenia que ',
    'tiene que ',
    'validar ',
    'reconocer ',
    'explicar ',
    'explorar ',
    'preguntar ',
    'pedir ',
    'confirmar ',
    'acordar ',
    'proponer ',
    'cerrar ',
    'evitar ',
    'mantener ',
    'dar seguimiento ',
  ];

  if (actionAdvicePrefixes.some(/** Handles the callback for this operation. */(prefix) => normalized.startsWith(prefix))) {
    return true;
  }

  return /\b(el|la) agente (debe|debio|deberia|tenia que|tiene que)\b/.test(normalized);
}

/** Documents the hasEllipsisLikeText behavior. */
function hasEllipsisLikeText(value: string): boolean {
  return /…|\.{2,}/.test(value);
}

/** Documents the normalizeStringArray behavior. */
function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || seen.has(item)) {
      continue;
    }
    seen.add(item);
    normalized.push(item);
  }

  return normalized;
}

/** Documents the normalizeExecutionGuide behavior. */
function normalizeExecutionGuide(value: unknown): BehaviorPatternExecutionGuide | undefined {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!raw) {
    return undefined;
  }

  const guide: BehaviorPatternExecutionGuide = {};
  const whenToUse = normalizeOptionalString(raw.whenToUse);
  const sayThis = normalizeOptionalString(raw.sayThis);
  const whyItWorks = normalizeOptionalString(raw.whyItWorks ?? raw.why_it_works);
  const avoidThis = normalizeOptionalString(raw.avoidThis);
  const nextStep = normalizeOptionalString(raw.nextStep);

  if (whenToUse) guide.whenToUse = whenToUse;
  if (sayThis) guide.sayThis = sayThis;
  if (whyItWorks) guide.whyItWorks = whyItWorks;
  if (avoidThis) guide.avoidThis = avoidThis;
  if (nextStep) guide.nextStep = nextStep;

  return Object.keys(guide).length > 0 ? guide : undefined;
}

/** Documents the normalizePatternExamples behavior. */
function normalizePatternExamples(
  value: unknown,
  patternId: string
): BehaviorPatternExample[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(/** Handles the callback for this operation. */(item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map(/** Handles the callback for this operation. */(item, index) => ({
      exampleId: normalizeString(item.exampleId, `${patternId}:example:${index + 1}`),
      callId: normalizeString(item.callId),
      observedFragment: normalizeString(item.observedFragment ?? item.observed_fragment),
      context: normalizeString(item.context),
      whyItIsWrong: normalizeString(item.whyItIsWrong ?? item.why_it_is_wrong),
      whatShouldHaveDone: normalizeString(
        item.whatShouldHaveDone ?? item.what_should_have_done
      ),
      whyItHelps: normalizeString(item.whyItHelps ?? item.why_it_helps),
      avoid: normalizeString(item.avoid),
      nextStep: normalizeString(item.nextStep ?? item.next_step),
    }))
    .filter(
      /** Handles the callback for this operation. */
      (item) =>
        item.callId.length > 0 &&
        item.observedFragment.length > 0 &&
        item.context.length > 0 &&
        item.whyItIsWrong.length > 0 &&
        item.whatShouldHaveDone.length > 0 &&
        item.whyItHelps.length > 0 &&
        !looksActionOnlyExampleResponse(item.whatShouldHaveDone) &&
        !hasEllipsisLikeText(item.observedFragment) &&
        !hasEllipsisLikeText(item.whatShouldHaveDone)
    )
    .slice(0, 3);
}

/** Documents the deriveLegacyExecutionGuide behavior. */
function deriveLegacyExecutionGuide(
  mentorshipTips: Array<{ tip: string; priority?: 'primary' | 'secondary' }>
): BehaviorPatternExecutionGuide | undefined {
  const guide: BehaviorPatternExecutionGuide = {};

  for (const mentorshipTip of mentorshipTips) {
    const trimmedTip = mentorshipTip.tip.trim();
    if (!guide.sayThis && /^di:/i.test(trimmedTip)) {
      guide.sayThis = trimmedTip.replace(/^di:\s*/i, '').trim();
      continue;
    }
    if (!guide.avoidThis && /^(no\b|no hagas\b)/i.test(trimmedTip)) {
      guide.avoidThis = trimmedTip;
    }
  }

  return Object.keys(guide).length > 0 ? guide : undefined;
}

/** Documents the isImperativeLike behavior. */
function isImperativeLike(value: string): boolean {
  const normalized = normalizeComparisonText(value);
  if (!normalized) return false;
  const forbiddenStarts = [
    'entrenar',
    'fortalecer',
    'trabajar',
    'mejorar',
    'desarrollar',
    'usar una secuencia',
    'aplicar una metodologia',
    'escucha consultiva',
    'manejo consultivo',
  ];
  return !forbiddenStarts.some(/** Handles the callback for this operation. */(start) => normalized.startsWith(start));
}

/** Documents the normalizeBehaviorPattern behavior. */
function normalizeBehaviorPattern(value: unknown, index: number): BehaviorPattern {
  const pattern = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const mentorshipTips = Array.isArray(pattern.mentorshipTips)
    ? pattern.mentorshipTips
      .filter(
        /** Handles the callback for this operation. */
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
      )
      .reduce<Array<{ tip: string; priority: 'primary' | 'secondary' }>>(/** Handles the callback for this operation. */(tips, item) => {
        const tip = normalizeString(item.tip);
        if (!tip) {
          return tips;
        }
        const normalizedTip = normalizeComparisonText(tip);
        const normalizedFocus = normalizeComparisonText(normalizeString(pattern.coachingFocus));
        if (normalizedTip === normalizedFocus) {
          return tips;
        }
        if (tips.some(/** Handles the callback for this operation. */(existing) => normalizeComparisonText(existing.tip) === normalizedTip)) {
          return tips;
        }
        if (
          normalizedTip.length < 8 ||
          ['adapta la conversacion al cliente', 'conecta mejor con el cliente', 'escucha mas y adapta tu discurso'].includes(
            normalizedTip
          )
        ) {
          return tips;
        }
        tips.push({
          tip,
          priority: item.priority === 'secondary' ? 'secondary' : 'primary',
        });
        return tips;
      }, [])
      .slice(0, 3)
    : [];
  const executionGuide =
    normalizeExecutionGuide(pattern.executionGuide) ?? deriveLegacyExecutionGuide(mentorshipTips);
  const supportingEvidence = Array.isArray(pattern.supportingEvidence)
    ? pattern.supportingEvidence
      .filter(
        /** Handles the callback for this operation. */
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
      )
      .map(/** Handles the callback for this operation. */(item) => ({
        callId: normalizeString(item.callId),
        quote: normalizeString(item.quote),
        speakerLabel:
          typeof item.speakerLabel === 'string'
            ? item.speakerLabel
            : typeof item.speaker_label === 'string'
              ? item.speaker_label
              : null,
        speakerDisplay:
          typeof item.speakerDisplay === 'string'
            ? item.speakerDisplay
            : typeof item.speaker_display === 'string'
              ? item.speaker_display
              : null,
      }))
      .filter(/** Handles the callback for this operation. */(item, evidenceIndex, items) => {
        if (!item.quote.length) {
          return false;
        }
        const normalizedQuote = normalizeComparisonText(item.quote);
        return (
          items.findIndex(/** Handles the callback for this operation. */(candidate) => normalizeComparisonText(candidate.quote) === normalizedQuote) ===
          evidenceIndex
        );
      })
      .slice(0, 5)
    : [];

  return {
    patternId: normalizeString(pattern.patternId, `pattern_${index + 1}`),
    patternName: normalizeString(pattern.patternName, `Pattern ${index + 1}`),
    seenInCallCount:
      typeof pattern.seenInCallCount === 'number' ? pattern.seenInCallCount : 0,
    totalCallCount: typeof pattern.totalCallCount === 'number' ? pattern.totalCallCount : 0,
    priorityScore: typeof pattern.priorityScore === 'number' ? pattern.priorityScore : 0,
    behaviorSummary: normalizeString(pattern.behaviorSummary),
    whenItHappens: normalizeString(pattern.whenItHappens),
    businessImpact: normalizeString(pattern.businessImpact),
    rootCause: normalizeString(pattern.rootCause),
    coachingFocus: isImperativeLike(normalizeString(pattern.coachingFocus))
      ? normalizeString(pattern.coachingFocus)
      : normalizeString(pattern.coachingFocus),
    mentorshipTips,
    executionGuide,
    supportingEvidence,
    examples: normalizePatternExamples(
      pattern.examples,
      normalizeString(pattern.patternId, `pattern_${index + 1}`)
    ),
    relatedSignalIds: Array.isArray(pattern.relatedSignalIds)
      ? pattern.relatedSignalIds.filter(
        /** Handles the callback for this operation. */
        (id): id is string => typeof id === 'string' && id.length > 0
      )
      : [],
    relatedCriterionIds: Array.isArray(pattern.relatedCriterionIds)
      ? pattern.relatedCriterionIds.filter(
        /** Handles the callback for this operation. */
        (id): id is string => typeof id === 'string' && id.length > 0
      )
      : [],
    severityDistribution: normalizeSeverityDistribution(pattern.severityDistribution),
    sourceCallIds:
      normalizeStringArray(pattern.sourceCallIds).length > 0
        ? normalizeStringArray(pattern.sourceCallIds)
        : normalizeStringArray(
          supportingEvidence
            .map(/** Handles the callback for this operation. */(item) => item.callId)
            .filter(/** Handles the callback for this operation. */(callId) => typeof callId === 'string' && callId.length > 0)
        ),
  };
}

/** Documents the normalizeProcessingConfig behavior. */
function normalizeProcessingConfig(value: unknown): AgentAnalysisProcessingConfig | undefined {
  const config = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!config) {
    return undefined;
  }

  const promptVersions = config.promptVersions;
  const normalizedPromptVersions =
    promptVersions && typeof promptVersions === 'object'
      ? Object.entries(promptVersions as Record<string, unknown>).reduce<Record<string, string>>(
        /** Handles the callback for this operation. */
        (accumulator, [taskId, version]) => {
          if (typeof version === 'string' && version.length > 0) {
            accumulator[taskId] = version;
          }
          return accumulator;
        },
        {}
      )
      : undefined;

  const analyzerModel =
    typeof config.analyzerModel === 'string' && config.analyzerModel.length > 0
      ? config.analyzerModel
      : undefined;

  if (!analyzerModel && (!normalizedPromptVersions || Object.keys(normalizedPromptVersions).length === 0)) {
    return undefined;
  }

  return {
    analyzerModel,
    promptVersions:
      normalizedPromptVersions && Object.keys(normalizedPromptVersions).length > 0
        ? normalizedPromptVersions
        : undefined,
  };
}

/** Documents the docToAgentAnalysis behavior. */
function docToAgentAnalysis(id: string, data: DocumentData): AgentAnalysis {
  const agentAnalysis: AgentAnalysis = {
    id,
    uploadedBy: data.uploadedBy ?? '',
    salesAgentId: data.salesAgentId ?? '',
    salesAgentName: data.salesAgentName ?? '',
    organizationId: normalizeOptionalString(data.organizationId),
    organizationName: normalizeOptionalString(data.organizationName),
    visibilityScope:
      data.visibilityScope === 'organization' || data.visibilityScope === 'user'
        ? data.visibilityScope
        : undefined,
    profileSource: normalizeOptionalString(data.profileSource),
    isCccCanonicalProfile: data.isCccCanonicalProfile === true,
    cccAgentMappingId: normalizeOptionalString(data.cccAgentMappingId),
    accountNumber: normalizeOptionalString(data.accountNumber),
    cccUserId: normalizeOptionalString(data.cccUserId),
    cccUsername: typeof data.cccUsername === 'string' ? data.cccUsername : null,
    supervisorName: typeof data.supervisorName === 'string' ? data.supervisorName : null,
    isActiveAgentProfile: data.isActiveAgentProfile === true,
    activeAgentProfileKey: normalizeOptionalString(data.activeAgentProfileKey),
    activeAgentSource: normalizeOptionalString(data.activeAgentSource),
    activeAgentDisplayName: normalizeOptionalString(data.activeAgentDisplayName),
    seededAt: timestampToDate(data.seededAt),
    callProcessingConfig: normalizeProcessingConfig(data.callProcessingConfig),
    reportProcessingConfig: normalizeProcessingConfig(data.reportProcessingConfig),
    status: (data.status ?? 'ready') as AgentAnalysisStatus,
    activeRunId: data.activeRunId,
    latestRunId: data.latestRunId,
    latestReportId: data.latestReportId,
    analysisStartedAt: timestampToDate(data.analysisStartedAt),
    analysisCompletedAt: timestampToDate(data.analysisCompletedAt),
    error: data.error ?? null,
    createdAt: timestampToDate(data.createdAt) ?? new Date(),
    updatedAt: timestampToDate(data.updatedAt) ?? new Date(),
  };
  registerKespDemoAgentAnalysisTerms(agentAnalysis);
  return agentAnalysis;
}

/** Documents the docToAgentAnalysisReport behavior. */
function docToAgentAnalysisReport(id: string, data: DocumentData): AgentAnalysisReport {
  if (data.schemaVersion === '2') {
    const report: AgentAnalysisReportV2 = {
      reportId: id,
      schemaVersion: '2',
      uploadedBy: data.uploadedBy ?? '',
      salesAgentId: data.salesAgentId ?? '',
      salesAgentName: data.salesAgentName ?? '',
      sourceCallIds: Array.isArray(data.sourceCallIds) ? data.sourceCallIds : [],
      coverage: {
        sourceCallCount: data.coverage?.sourceCallCount ?? 0,
        eligibleCallCount: data.coverage?.eligibleCallCount ?? 0,
        skippedCallCount: data.coverage?.skippedCallCount ?? 0,
      },
      patterns: Array.isArray(data.patterns)
        ? data.patterns.map(/** Handles the callback for this operation. */(pattern, index) => normalizeBehaviorPattern(pattern, index))
        : [],
      patternOrder: Array.isArray(data.patternOrder)
        ? data.patternOrder.filter(
          /** Handles the callback for this operation. */
          (patternId: unknown): patternId is string =>
            typeof patternId === 'string' && patternId.length > 0
        )
        : [],
      createdAt: timestampToDate(data.createdAt),
      updatedAt: timestampToDate(data.updatedAt),
    };

    if (report.patternOrder.length === 0) {
      report.patternOrder = report.patterns.map(/** Handles the callback for this operation. */(pattern) => pattern.patternId);
    }

    registerKespDemoAgentReportTerms(report);
    return report;
  }

  const legacyReport: LegacyAgentAnalysisReport = {
    reportId: id,
    schemaVersion: '1',
    uploadedBy: data.uploadedBy ?? '',
    salesAgentId: data.salesAgentId ?? '',
    salesAgentName: data.salesAgentName ?? '',
    sourceCallIds: Array.isArray(data.sourceCallIds) ? data.sourceCallIds : [],
    coverage: {
      sourceCallCount: data.coverage?.sourceCallCount ?? 0,
      eligibleCallCount: data.coverage?.eligibleCallCount ?? 0,
      skippedCallCount: data.coverage?.skippedCallCount ?? 0,
    },
    severityBins: normalizeSeverityBins(data.severityBins),
    primaryWeaknessOrder: Array.isArray(data.primaryWeaknessOrder)
      ? data.primaryWeaknessOrder
      : [],
    createdAt: timestampToDate(data.createdAt),
    updatedAt: timestampToDate(data.updatedAt),
  };

  registerKespDemoAgentReportTerms(legacyReport);
  return legacyReport;
}

/** Documents the docToAgentAnalysisRun behavior. */
function docToAgentAnalysisRun(id: string, data: DocumentData): AgentAnalysisRun {
  return {
    runId: id,
    status: data.status ?? 'pending',
    sourceCallCount: data.sourceCallCount ?? 0,
    eligibleCallCount: data.eligibleCallCount ?? 0,
    skippedCallCount: data.skippedCallCount ?? 0,
    taskCount: data.taskCount ?? 0,
    completedTaskCount: data.completedTaskCount ?? 0,
    skipReasons: data.skipReasons ?? {},
    usedPromptFamily: data.usedPromptFamily,
    createdAt: timestampToDate(data.createdAt),
    completedAt: timestampToDate(data.completedAt),
  };
}

/** Documents the docToAgentAnalysisRunTask behavior. */
function docToAgentAnalysisRunTask(id: string, data: DocumentData): AgentAnalysisRunTask {
  return {
    taskId: id,
    taskType: data.taskType,
    promptTaskId: data.promptTaskId,
    status: data.status ?? 'pending',
    promptPath: data.promptPath,
    model: data.model ?? null,
    inputPayload: data.inputPayload,
    output: data.output,
    error: data.error ?? null,
    attempts: data.attempts,
    createdAt: timestampToDate(data.createdAt),
    startedAt: timestampToDate(data.startedAt),
    completedAt: timestampToDate(data.completedAt),
  };
}

/** Documents the createAgentAnalysis behavior. */
export async function createAgentAnalysis(input: {
  uploadedBy: string;
  salesAgentName: string;
}): Promise<string> {
  const now = Timestamp.now();
  /** Calls an external SDK or API dependency. */
  const ref = doc(collection(db, AGENT_ANALYSES_COLLECTION));
  const generatedSalesAgentId = `agent_${ref.id}`;

  /** Calls an external SDK or API dependency. */
  await setDoc(ref, {
    uploadedBy: input.uploadedBy,
    organizationId: CONSUBANCO_ORGANIZATION_ID,
    visibilityScope: 'organization',
    salesAgentId: generatedSalesAgentId,
    salesAgentName: input.salesAgentName,
    status: 'ready',
    error: null,
    createdAt: now,
    updatedAt: now,
  });

  return ref.id;
}

/** Documents the updateAgentAnalysisProcessingConfig behavior. */
export async function updateAgentAnalysisProcessingConfig(
  agentAnalysisId: string,
  input: {
    callProcessingConfig?: AgentAnalysisProcessingConfig;
    reportProcessingConfig?: AgentAnalysisProcessingConfig;
  }
): Promise<void> {
  const updatePayload: Record<string, unknown> = {
    updatedAt: Timestamp.now(),
  };

  if (input.callProcessingConfig) {
    updatePayload.callProcessingConfig = {
      ...(input.callProcessingConfig.analyzerModel
        ? { analyzerModel: input.callProcessingConfig.analyzerModel }
        : {}),
      ...(input.callProcessingConfig.promptVersions &&
        Object.keys(input.callProcessingConfig.promptVersions).length > 0
        ? { promptVersions: input.callProcessingConfig.promptVersions }
        : {}),
    };
  }

  if (input.reportProcessingConfig) {
    updatePayload.reportProcessingConfig = {
      ...(input.reportProcessingConfig.analyzerModel
        ? { analyzerModel: input.reportProcessingConfig.analyzerModel }
        : {}),
      ...(input.reportProcessingConfig.promptVersions &&
        Object.keys(input.reportProcessingConfig.promptVersions).length > 0
        ? { promptVersions: input.reportProcessingConfig.promptVersions }
        : {}),
    };
  }

  /** Calls an external SDK or API dependency. */
  await updateDoc(doc(db, AGENT_ANALYSES_COLLECTION, agentAnalysisId), updatePayload);
}

/** Documents the sortAgentAnalysesByCreatedAtDesc behavior. */
function sortAgentAnalysesByCreatedAtDesc(agentAnalyses: AgentAnalysis[]): AgentAnalysis[] {
  return [...agentAnalyses].sort(
    /** Handles the callback for this operation. */
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
}

/** Documents the mergeAgentAnalysisLists behavior. */
function mergeAgentAnalysisLists(...lists: AgentAnalysis[][]): AgentAnalysis[] {
  const byId = new Map<string, AgentAnalysis>();
  for (const list of lists) {
    for (const agentAnalysis of list) {
      const key = isDemoFirebaseProject && agentAnalysis.salesAgentId
        ? `agent:${agentAnalysis.salesAgentId}`
        : `document:${agentAnalysis.id}`;
      const existing = byId.get(key);
      // Shared demo profiles are the navigation target for overlapping owned copies.
      if (existing && isSharedDemoAgentProfile(existing) && !isSharedDemoAgentProfile(agentAnalysis)) continue;
      byId.set(key, agentAnalysis);
    }
  }
  return sortAgentAnalysesByCreatedAtDesc([...byId.values()]);
}

/** Documents the createOwnedAgentAnalysesQuery behavior. */
function createOwnedAgentAnalysesQuery(userId: string) {
  return query(
    collection(db, AGENT_ANALYSES_COLLECTION),
    where('uploadedBy', '==', userId),
    orderBy('createdAt', 'desc')
  );
}

/** Documents the createSharedAgentAnalysesQuery behavior. */
function createSharedAgentAnalysesQuery() {
  return query(
    collection(db, AGENT_ANALYSES_COLLECTION),
    where('organizationId', '==', CONSUBANCO_ORGANIZATION_ID),
    where('visibilityScope', '==', 'organization'),
    ...(isDemoFirebaseProject ? [] : [where('isCccCanonicalProfile', '==', true)]),
    orderBy('createdAt', 'desc')
  );
}

/** Documents the isCanonicalAutomaticAgentProfile behavior. */
export function isCanonicalAutomaticAgentProfile(agentAnalysis: AgentAnalysis): boolean {
  return (
    agentAnalysis.isCccCanonicalProfile === true &&
    agentAnalysis.profileSource === 'ccc_mapping'
  );
}

export function isSharedDemoAgentProfile(agent: AgentAnalysis): boolean {
  return isDemoFirebaseProject && agent.organizationId === CONSUBANCO_ORGANIZATION_ID && agent.visibilityScope === 'organization';
}

/** Documents the isManualAgentProfile behavior. */
export function isManualAgentProfile(agentAnalysis: AgentAnalysis, userId: string): boolean {
  return agentAnalysis.uploadedBy === userId && agentAnalysis.isCccCanonicalProfile !== true;
}

/** Documents the filterAutomaticAgentProfiles behavior. */
function filterAutomaticAgentProfiles(agentAnalyses: AgentAnalysis[]): AgentAnalysis[] {
  return sortAgentAnalysesByCreatedAtDesc(agentAnalyses.filter(isDemoFirebaseProject ? isSharedDemoAgentProfile : isCanonicalAutomaticAgentProfile));
}

/** Documents the filterManualAgentProfiles behavior. */
function filterManualAgentProfiles(agentAnalyses: AgentAnalysis[], userId: string): AgentAnalysis[] {
  return sortAgentAnalysesByCreatedAtDesc(
    agentAnalyses.filter(
      /** Handles the callback for this operation. */
      (agentAnalysis) => isManualAgentProfile(agentAnalysis, userId)
    )
  );
}

/** Documents the fetchAutomaticAgentProfiles behavior. */
export async function fetchAutomaticAgentProfiles(): Promise<AgentAnalysis[]> {
  /** Calls an external SDK or API dependency to fetch organization-visible canonical CCC profiles. */
  const snapshot = await getDocs(createSharedAgentAnalysesQuery());
  return filterAutomaticAgentProfiles(
    snapshot.docs.map(
      /** Handles the callback for this operation. */
      (snapshotDoc) => docToAgentAnalysis(snapshotDoc.id, snapshotDoc.data())
    )
  );
}

/** Documents the fetchManualAgentProfiles behavior. */
export async function fetchManualAgentProfiles(userId: string): Promise<AgentAnalysis[]> {
  if (isDemoFirebaseProject) return fetchAgentAnalyses(userId);
  /** Calls an external SDK or API dependency to fetch the current user's manual agent profiles. */
  const snapshot = await getDocs(createOwnedAgentAnalysesQuery(userId));
  return filterManualAgentProfiles(
    snapshot.docs.map(
      /** Handles the callback for this operation. */
      (snapshotDoc) => docToAgentAnalysis(snapshotDoc.id, snapshotDoc.data())
    ),
    userId
  );
}

/** Documents the subscribeToAutomaticAgentProfiles behavior. */
export function subscribeToAutomaticAgentProfiles(
  callback: (agentAnalyses: AgentAnalysis[]) => void
): () => void {
  /** Calls an external SDK or API dependency to subscribe to organization-visible canonical CCC profiles. */
  return onSnapshot(
    createSharedAgentAnalysesQuery(),
    /** Handles the callback for this operation. */
    (snapshot) => {
      callback(
        filterAutomaticAgentProfiles(
          snapshot.docs.map(
            /** Handles the callback for this operation. */
            (snapshotDoc) => docToAgentAnalysis(snapshotDoc.id, snapshotDoc.data())
          )
        )
      );
    },
    /** Handles the callback for this operation. */
    (error) => {
      console.warn('Unable to subscribe to automatic CCC agent profiles:', error);
      callback([]);
    }
  );
}

/** Documents the subscribeToManualAgentProfiles behavior. */
export function subscribeToManualAgentProfiles(
  userId: string,
  callback: (agentAnalyses: AgentAnalysis[]) => void
): () => void {
  if (isDemoFirebaseProject) return subscribeToAgentAnalyses(userId, callback);
  /** Calls an external SDK or API dependency to subscribe to the current user's manual agent profiles. */
  return onSnapshot(
    createOwnedAgentAnalysesQuery(userId),
    /** Handles the callback for this operation. */
    (snapshot) => {
      callback(
        filterManualAgentProfiles(
          snapshot.docs.map(
            /** Handles the callback for this operation. */
            (snapshotDoc) => docToAgentAnalysis(snapshotDoc.id, snapshotDoc.data())
          ),
          userId
        )
      );
    }
  );
}

/** Documents the fetchAgentAnalyses behavior. */
export async function fetchAgentAnalyses(userId: string): Promise<AgentAnalysis[]> {
  /** Calls an external SDK or API dependency to fetch the current user's owned agent profiles. */
  const ownedSnapshot = await getDocs(createOwnedAgentAnalysesQuery(userId));
  let canonicalSnapshot;
  try {
    /** Calls an external SDK or API dependency to fetch organization-visible canonical CCC profiles. */
    canonicalSnapshot = await getDocs(createSharedAgentAnalysesQuery());
  } catch (error) {
    console.warn('Unable to fetch organization-visible CCC agent profiles:', error);
  }

  return mergeAgentAnalysisLists(
    ownedSnapshot.docs.map(
      /** Handles the callback for this operation. */
      (snapshotDoc) => docToAgentAnalysis(snapshotDoc.id, snapshotDoc.data())
    ),
    canonicalSnapshot?.docs.map(
      /** Handles the callback for this operation. */
      (snapshotDoc) => docToAgentAnalysis(snapshotDoc.id, snapshotDoc.data())
    ) ?? []
  );
}

/** Documents the subscribeToAgentAnalyses behavior. */
export function subscribeToAgentAnalyses(
  userId: string,
  callback: (agentAnalyses: AgentAnalysis[]) => void
): () => void {
  let ownedAgentAnalyses: AgentAnalysis[] = [];
  let canonicalAgentAnalyses: AgentAnalysis[] = [];
  let ownedLoaded = false;
  let canonicalLoaded = false;

  /** Documents the emitMergedAgentAnalyses behavior. */
  const emitMergedAgentAnalyses = () => {
    if (ownedLoaded && canonicalLoaded) {
      callback(mergeAgentAnalysisLists(ownedAgentAnalyses, canonicalAgentAnalyses));
    }
  };

  /** Calls an external SDK or API dependency to subscribe to the current user's owned agent profiles. */
  const unsubscribeOwned = onSnapshot(
    createOwnedAgentAnalysesQuery(userId),
    /** Handles the callback for this operation. */
    (snapshot) => {
      ownedAgentAnalyses = snapshot.docs.map(
        /** Handles the callback for this operation. */
        (snapshotDoc) => docToAgentAnalysis(snapshotDoc.id, snapshotDoc.data())
      );
      ownedLoaded = true;
      emitMergedAgentAnalyses();
    },
    (error) => {
      console.warn('Unable to subscribe to owned agent profiles:', error);
      ownedAgentAnalyses = [];
      ownedLoaded = true;
      emitMergedAgentAnalyses();
    }
  );

  /** Calls an external SDK or API dependency to subscribe to organization-visible canonical CCC profiles. */
  const unsubscribeCanonical = onSnapshot(
    createSharedAgentAnalysesQuery(),
    /** Handles the callback for this operation. */
    (snapshot) => {
      canonicalAgentAnalyses = snapshot.docs.map(
        /** Handles the callback for this operation. */
        (snapshotDoc) => docToAgentAnalysis(snapshotDoc.id, snapshotDoc.data())
      );
      canonicalLoaded = true;
      emitMergedAgentAnalyses();
    },
    /** Handles the callback for this operation. */
    (error) => {
      console.warn('Unable to subscribe to organization-visible CCC agent profiles:', error);
      canonicalAgentAnalyses = [];
      canonicalLoaded = true;
      emitMergedAgentAnalyses();
    }
  );

  return () => {
    unsubscribeOwned();
    unsubscribeCanonical();
  };
}

/** Documents the fetchAgentAnalysis behavior. */
export async function fetchAgentAnalysis(agentAnalysisId: string): Promise<AgentAnalysis | null> {
  /** Calls an external SDK or API dependency. */
  const snapshot = await getDoc(doc(db, AGENT_ANALYSES_COLLECTION, agentAnalysisId));
  if (!snapshot.exists()) {
    return null;
  }
  return docToAgentAnalysis(snapshot.id, snapshot.data());
}

/** Documents the subscribeToAgentAnalysis behavior. */
export function subscribeToAgentAnalysis(
  agentAnalysisId: string,
  callback: (agentAnalysis: AgentAnalysis | null) => void
): () => void {
  /** Calls an external SDK or API dependency. */
  return onSnapshot(
    doc(db, AGENT_ANALYSES_COLLECTION, agentAnalysisId),
    /** Handles the callback for this operation. */
    (snapshot) => {
      callback(snapshot.exists() ? docToAgentAnalysis(snapshot.id, snapshot.data()) : null);
    },
    /** Handles the callback for this operation. */
    () => callback(null)
  );
}

/** Documents the triggerAgentAnalysisRun behavior. */
export async function triggerAgentAnalysisRun(
  agentAnalysisId: string,
  input?: { reportProcessingConfig?: AgentAnalysisProcessingConfig }
): Promise<{
  success: boolean;
  started: boolean;
  result:
  | 'started'
  | 'already_running'
  | 'no_changes'
  | 'no_complete_calls'
  | 'no_eligible_calls';
  sourceCallCount: number;
  eligibleCallCount: number;
  latestReportId?: string;
  activeRunId?: string;
}> {
  const payload: {
    agentAnalysisId: string;
    reportProcessingConfig?: AgentAnalysisProcessingConfig;
  } = { agentAnalysisId };

  if (input && Object.prototype.hasOwnProperty.call(input, 'reportProcessingConfig')) {
    payload.reportProcessingConfig = input.reportProcessingConfig;
  }

  const result = await startAgentAnalysisFn(payload);
  return result.data;
}

/** Documents the fetchAgentAnalysisReport behavior. */
export async function fetchAgentAnalysisReport(
  agentAnalysisId: string,
  reportId: string
): Promise<AgentAnalysisReport | null> {
  /** Calls an external SDK or API dependency. */
  const snapshot = await getDoc(
    doc(db, AGENT_ANALYSES_COLLECTION, agentAnalysisId, 'reports', reportId)
  );
  if (!snapshot.exists()) {
    return null;
  }
  return docToAgentAnalysisReport(snapshot.id, snapshot.data());
}

/** Documents the subscribeToAgentAnalysisReport behavior. */
export function subscribeToAgentAnalysisReport(
  agentAnalysisId: string,
  reportId: string | undefined,
  callback: (report: AgentAnalysisReport | null) => void
): () => void {
  if (!reportId) {
    callback(null);
    return /** Handles the callback for this operation. */ () => undefined;
  }

  /** Calls an external SDK or API dependency. */
  return onSnapshot(
    doc(db, AGENT_ANALYSES_COLLECTION, agentAnalysisId, 'reports', reportId),
    /** Handles the callback for this operation. */
    (snapshot) => {
      callback(snapshot.exists() ? docToAgentAnalysisReport(snapshot.id, snapshot.data()) : null);
    },
    /** Handles the callback for this operation. */
    () => callback(null)
  );
}

/** Documents the fetchAgentAnalysisRuns behavior. */
export async function fetchAgentAnalysisRuns(agentAnalysisId: string): Promise<AgentAnalysisRun[]> {
  /** Calls an external SDK or API dependency. */
  const constraints: QueryConstraint[] = [orderBy('createdAt', 'desc')];
  /** Calls an external SDK or API dependency. */
  const snapshot = await getDocs(
    query(collection(db, AGENT_ANALYSES_COLLECTION, agentAnalysisId, 'analysis_runs'), ...constraints)
  );
  return snapshot.docs.map(/** Handles the callback for this operation. */(snapshotDoc) => docToAgentAnalysisRun(snapshotDoc.id, snapshotDoc.data()));
}

/** Documents the fetchAgentAnalysisRunTasks behavior. */
export async function fetchAgentAnalysisRunTasks(
  agentAnalysisId: string,
  runId: string
): Promise<AgentAnalysisRunTask[]> {
  /** Calls an external SDK or API dependency. */
  const snapshot = await getDocs(
    collection(db, AGENT_ANALYSES_COLLECTION, agentAnalysisId, 'analysis_runs', runId, 'tasks')
  );
  return snapshot.docs.map(/** Handles the callback for this operation. */(snapshotDoc) =>
    docToAgentAnalysisRunTask(snapshotDoc.id, snapshotDoc.data())
  );
}
