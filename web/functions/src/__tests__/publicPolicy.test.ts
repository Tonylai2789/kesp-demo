import { privatePolicyUnavailable, redactedPrivatePolicy } from '../privatePolicy';
import { validateAndRepairCriterionResult, validateAndRepairRubricCriteriaResults } from '../rubricCreditValidation';
import { evaluateCriterionEvidencePattern, hasExplicitPressureMarker, normalizeQuoteEvidenceText,
  sanitizeEvidenceForTranscript, summarizeEvidenceQuality } from '../quoteEvidenceQuality';
import { applyConversationSpeedScoring } from '../conversationSpeedScoring';
import { buildShortCallQualityResult, durationBucketForSeconds } from '../shortCallQuality';
import { calculateConversationMetrics, calculateOpenAiSegmentConversationMetrics,
  unavailableConversationMetrics, countConversationWords, conversationRoleMapping,
  isOpenAiSegmentTranscript } from '../conversationMetrics';

test('short-call scoring and conversation calculations require private assets', () => {
  const operations = [
    () => buildShortCallQualityResult({ durationSeconds: null, contactStatus: 'unknown', agentConcern: '', rawCriteria: [] }),
    () => durationBucketForSeconds(null),
    () => calculateConversationMetrics({ words: [] }),
    () => calculateOpenAiSegmentConversationMetrics({ segments: [] }, {}),
    () => unavailableConversationMetrics('missing_timing'),
  ];
  for (const operation of operations) expect(operation).toThrow('Missing private evaluation assets');
});

test('generic conversation helpers remain usable without private policy', () => {
  expect(countConversationWords('Example words 12.5')).toBe(3);
  expect(conversationRoleMapping({ agent_speaker: 'X', customer_speaker: 'Y' })).toEqual({ agent: 'X', customer: 'Y' });
  expect(conversationRoleMapping({ agent_speaker: 'X', customer_speaker: 'X' })).toEqual({ agent: null, customer: null });
  expect(isOpenAiSegmentTranscript({ provider: 'openai', model: 'gpt-4o-transcribe-diarize' })).toBe(true);
});

test('redacted policy contracts fail explicitly instead of returning invented values', () => {
  const policy = redactedPrivatePolicy<{ weights: number[] }>();
  expect(() => policy.weights).toThrow('Missing private evaluation assets');
  expect(() => Object.keys(policy)).toThrow('Missing private evaluation assets');
  expect(privatePolicyUnavailable).toThrow('Missing private evaluation assets');
});

test('criterion repair, evidence policy and score adjustments require private assets', () => {
  const operations = [
    () => validateAndRepairCriterionResult({ callId: 'synthetic', criterionResult: {} }),
    () => validateAndRepairRubricCriteriaResults({ callId: 'synthetic', criteriaResults: [] }),
    () => hasExplicitPressureMarker('synthetic text'),
    () => sanitizeEvidenceForTranscript({ evidence: [], criterionId: 'example', context: 'test' }),
    () => evaluateCriterionEvidencePattern({ criterionId: 'example', state: 'unknown', evidence: [], agentSpeaker: 'A', customerSpeaker: 'B' }),
    () => applyConversationSpeedScoring([]),
  ];
  for (const operation of operations) expect(operation).toThrow('Missing private evaluation assets');
});

test('generic quote normalization and metric aggregation remain usable', () => {
  expect(normalizeQuoteEvidenceText('  Example words!  ')).toBe('example words');
  expect(normalizeQuoteEvidenceText(null)).toBe('');
  expect(summarizeEvidenceQuality([{ total: 2, accepted: 1, hardDropped: 1, repaired: 0, softIssues: 0, passRate: 0.5 }]))
    .toEqual({ total: 2, accepted: 1, hardDropped: 1, repaired: 0, softIssues: 0, passRate: 0.5 });
});
