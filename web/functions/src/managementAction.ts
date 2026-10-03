interface LocalizedString {
  es: string;
  en: string;
}

interface FeedbackWeaknessLike {
  title?: string;
  detail?: string;
  weakness_improvement_tip?: string;
}

interface LocalizedMentorshipTip {
  skill: LocalizedString;
  whenToUseIt: LocalizedString | null;
  examplePhrase: LocalizedString | null;
  whyItWorks: LocalizedString | null;
}

interface CallSynopsis {
  primaryWeaknessTitle: string;
  whatWentWrong: LocalizedString;
  whatToDoDifferently: LocalizedString;
  whatToSay: LocalizedString;
  whatToTrain: LocalizedString;
}

/** Documents the asLocalized behavior. */
function asLocalized(value: string | null | undefined): LocalizedString {
  const next = typeof value === "string" ? value.trim() : "";
  return {
    es: next,
    en: next,
  };
}

/** Documents the cleanSegment behavior. */
function cleanSegment(value: string | null | undefined): string | null {
  if (!value) return null;
  const next = value.replace(/\s+/g, " ").trim();
  return next.length > 0 ? next : null;
}

/** Documents the normalizeComparable behavior. */
function normalizeComparable(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Documents the normalizeTrainingLabel behavior. */
function normalizeTrainingLabel(value: string | null | undefined): string | null {
  const cleaned = cleanSegment(value);
  if (!cleaned) return null;
  const next = cleaned
    .replace(/^qué debió haber dicho\s*:\s*/i, "")
    .replace(/^mentor tips?\s*:\s*/i, "")
    .replace(/^tips? del mentor\s*:\s*/i, "")
    .trim();
  return next.length > 0 ? next : null;
}

/** Documents the splitMentorTips behavior. */
function splitMentorTips(value: string | null | undefined): string[] {
  const normalized = cleanSegment(value);
  if (!normalized) return [];

  const numbered = normalized
    .split(/\s*(?=\d+\)\s)/)
    .map(/** Handles the callback for this operation. */(part) => part.replace(/^\d+\)\s*/, "").trim())
    .filter(Boolean);
  if (numbered.length > 1) return numbered;

  const bullets = normalized
    .split(/\s*(?:•|-)\s+/)
    .map(/** Handles the callback for this operation. */(part) => part.trim())
    .filter(Boolean);
  if (bullets.length > 1) return bullets;

  const ordered = normalized
    .split(/\s+(?=\d+\.\s+)/)
    .map(/** Handles the callback for this operation. */(part) => part.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);
  if (ordered.length > 1) return ordered;

  return [normalized];
}

/** Documents the extractQuotedPhrases behavior. */
function extractQuotedPhrases(value: string | null | undefined): string[] {
  const text = cleanSegment(value);
  if (!text) return [];

  const quoted = Array.from(text.matchAll(/"([^"]+)"/g))
    .map(/** Handles the callback for this operation. */(match) => cleanSegment(match[1]))
    .filter(/** Handles the callback for this operation. */(item): item is string => Boolean(item));
  if (quoted.length > 0) {
    return quoted;
  }

  return text
    .split(/\s+o\s+(?=")|\s+\/\s+/i)
    .map(/** Handles the callback for this operation. */(part) => cleanSegment(part))
    .filter(/** Handles the callback for this operation. */(item): item is string => Boolean(item));
}

/** Documents the uniqueStrings behavior. */
function uniqueStrings(values: Array<string | null | undefined>, limit = Number.POSITIVE_INFINITY): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const cleaned = cleanSegment(value);
    if (!cleaned) continue;
    const normalized = normalizeComparable(cleaned);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(cleaned);
    if (next.length >= limit) break;
  }
  return next;
}

/** Documents the pickDistinctText behavior. */
function pickDistinctText(
  candidates: Array<string | null | undefined>,
  blocked: Array<string | null | undefined>
): string | null {
  const blockedSet = new Set(blocked.map(/** Handles the callback for this operation. */(value) => normalizeComparable(value)).filter(Boolean));
  for (const candidate of candidates) {
    const cleaned = cleanSegment(candidate);
    if (!cleaned) continue;
    const normalized = normalizeComparable(cleaned);
    if (!normalized || blockedSet.has(normalized)) continue;
    return cleaned;
  }
  return null;
}

/** Documents the firstSentence behavior. */
function firstSentence(value: string | null | undefined, maxSentences = 1): string | null {
  const cleaned = cleanSegment(value);
  if (!cleaned) return null;
  const parts = cleaned.match(/[^.!?]+[.!?]?/g)?.map(/** Handles the callback for this operation. */(part) => part.trim()).filter(Boolean) ?? [cleaned];
  return cleanSegment(parts.slice(0, maxSentences).join(" "));
}

/** Documents the parseImprovementTip behavior. */
function parseImprovementTip(raw: string | null | undefined): {
  intro: string | null;
  whatAgentShouldHaveSaid: string | null;
  mentorTips: string[];
  remainder: string | null;
} {
  const text = cleanSegment(raw);
  if (!text) {
    return {
      intro: null,
      whatAgentShouldHaveSaid: null,
      mentorTips: [],
      remainder: null,
    };
  }

  const whatRegex = /qué debió haber dicho\s*:\s*/i;
  const mentorRegex = /mentor tips?\s*:\s*/i;
  const whatMatch = whatRegex.exec(text);
  const mentorMatch = mentorRegex.exec(text);

  if (!whatMatch && !mentorMatch) {
    return {
      intro: null,
      whatAgentShouldHaveSaid: null,
      mentorTips: splitMentorTips(text),
      remainder: null,
    };
  }

  let intro: string | null = null;
  let whatAgentShouldHaveSaid: string | null = null;
  let mentorTips: string[] = [];
  let remainder: string | null = null;

  if (whatMatch) {
    intro = cleanSegment(text.slice(0, whatMatch.index));
    const afterWhat = text.slice(whatMatch.index + whatMatch[0].length);
    const nestedMentorMatch = mentorRegex.exec(afterWhat);
    if (nestedMentorMatch) {
      whatAgentShouldHaveSaid = cleanSegment(afterWhat.slice(0, nestedMentorMatch.index));
      mentorTips = splitMentorTips(afterWhat.slice(nestedMentorMatch.index + nestedMentorMatch[0].length));
    } else {
      whatAgentShouldHaveSaid = cleanSegment(afterWhat);
    }
  } else if (mentorMatch) {
    intro = cleanSegment(text.slice(0, mentorMatch.index));
    mentorTips = splitMentorTips(text.slice(mentorMatch.index + mentorMatch[0].length));
  }

  remainder = mentorTips.length === 0 && intro ? intro : null;

  return {
    intro,
    whatAgentShouldHaveSaid,
    mentorTips,
    remainder,
  };
}

/** Documents the buildFallbackMentorshipTips behavior. */
function buildFallbackMentorshipTips(
  weaknessTitle: string,
  intro: string | null,
  examplePhrase: string | null,
  mentorTips: string[]
): LocalizedMentorshipTip[] {
  const distinctTips = uniqueStrings(mentorTips, 1);
  if (distinctTips.length === 0) {
    return [];
  }

  return distinctTips.map(/** Handles the callback for this operation. */(tip) => ({
    skill: asLocalized(weaknessTitle),
    whenToUseIt: intro ? asLocalized(intro) : null,
    examplePhrase: examplePhrase ? asLocalized(examplePhrase) : null,
    whyItWorks: asLocalized(tip),
  }));
}

/** Documents the buildCallSynopsis behavior. */
function buildCallSynopsis(weaknessPlans: Array<{
  weaknessTitle: string;
  whatWentWrong: LocalizedString;
  whatToChangeNextCall: LocalizedString;
  whatToSayNext: LocalizedString[];
  whatToTrain: LocalizedString[];
}>): CallSynopsis | null {
  const primary = weaknessPlans[0];
  if (!primary) return null;

  const whatToSay = primary.whatToSayNext[0] ?? asLocalized("");
  const whatToTrain = primary.whatToTrain[0] ?? asLocalized(primary.weaknessTitle);

  return {
    primaryWeaknessTitle: primary.weaknessTitle,
    whatWentWrong: asLocalized(firstSentence(primary.whatWentWrong.es, 2) ?? primary.whatWentWrong.es),
    whatToDoDifferently: asLocalized(firstSentence(primary.whatToChangeNextCall.es, 1) ?? primary.whatToChangeNextCall.es),
    whatToSay,
    whatToTrain,
  };
}

/** Documents the buildManagementActionPlanV1 behavior. */
export function buildManagementActionPlanV1(input: {
  weaknesses: FeedbackWeaknessLike[];
  suggestedFollowupMessage?: string | null;
}): {
  summary: LocalizedString | null;
  nextActionSummary: LocalizedString | null;
  phraseBankPreview: LocalizedString[];
  trainingFocus: LocalizedString[];
  weaknessPlans: Array<{
    weaknessTitle: string;
    weaknessDetail: string | null;
    whatWentWrong: LocalizedString;
    whenItHappened: LocalizedString | null;
    whyItHurts: LocalizedString | null;
    whatToChangeNextCall: LocalizedString;
    whatToSayNext: LocalizedString[];
    whatToTrain: LocalizedString[];
    mentorshipTips: LocalizedMentorshipTip[];
  }>;
  callSynopsis: CallSynopsis | null;
} {
  const weaknessPlans = input.weaknesses.map(/** Handles the callback for this operation. */(weakness) => {
    const parsed = parseImprovementTip(weakness.weakness_improvement_tip);
    const weaknessTitle = cleanSegment(weakness.title) ?? "";
    const weaknessDetail = cleanSegment(weakness.detail);

    const phraseCandidates = uniqueStrings(
      [
        ...extractQuotedPhrases(parsed.whatAgentShouldHaveSaid),
        parsed.whatAgentShouldHaveSaid,
      ],
      2
    );

    const uniqueActionGuidance = pickDistinctText(
      [
        firstSentence(parsed.mentorTips[0], 1),
        parsed.remainder,
        parsed.intro,
        weakness.weakness_improvement_tip,
      ],
      [weaknessDetail, ...phraseCandidates]
    );

    const uniqueWhyItHurts = pickDistinctText(
      [parsed.remainder, parsed.intro],
      [weaknessDetail, uniqueActionGuidance]
    );

    const trainingItems = uniqueStrings(
      [
        normalizeTrainingLabel(weaknessTitle),
        ...parsed.mentorTips.map(/** Handles the callback for this operation. */(tip) => firstSentence(tip, 1)),
        parsed.intro,
      ],
      3
    );

    const mentorshipTips = buildFallbackMentorshipTips(
      weaknessTitle,
      parsed.intro,
      phraseCandidates[0] ?? null,
      uniqueStrings(parsed.mentorTips, 1)
    );

    return {
      weaknessTitle,
      weaknessDetail,
      whatWentWrong: asLocalized(weaknessDetail),
      whenItHappened: parsed.intro ? asLocalized(parsed.intro) : null,
      whyItHurts: uniqueWhyItHurts ? asLocalized(uniqueWhyItHurts) : null,
      whatToChangeNextCall: asLocalized(uniqueActionGuidance ?? weaknessDetail ?? ""),
      whatToSayNext: phraseCandidates.map(/** Handles the callback for this operation. */(phrase) => asLocalized(phrase)),
      whatToTrain: trainingItems.map(/** Handles the callback for this operation. */(item) => asLocalized(item)),
      mentorshipTips,
    };
  });

  const phraseBankPreview = weaknessPlans
    .flatMap(/** Handles the callback for this operation. */(plan) => plan.whatToSayNext)
    .slice(0, 3);
  const trainingFocus = weaknessPlans
    .flatMap(/** Handles the callback for this operation. */(plan) => plan.whatToTrain)
    .slice(0, 3);
  const callSynopsis = buildCallSynopsis(weaknessPlans);

  return {
    summary: callSynopsis?.whatWentWrong ?? weaknessPlans[0]?.whatWentWrong ?? null,
    nextActionSummary: input.suggestedFollowupMessage ? asLocalized(input.suggestedFollowupMessage) : null,
    phraseBankPreview,
    trainingFocus,
    weaknessPlans,
    callSynopsis,
  };
}
