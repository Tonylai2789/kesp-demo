export interface ParsedCoachingTip {
  intro: string | null;
  whatAgentShouldHaveSaid: string | null;
  mentorTips: string[];
  remainder: string | null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanSegment(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeWhitespace(value);
  return normalized.length > 0 ? normalized : null;
}

function splitMentorTips(value: string): string[] {
  const normalized = value.trim();
  if (!normalized) return [];

  const numberedParts = normalized
    .split(/\s*(?=\d+\)\s)/)
    .map((part) => part.replace(/^\d+\)\s*/, "").trim())
    .filter(Boolean);
  if (numberedParts.length > 1) return numberedParts;

  const bulletParts = normalized
    .split(/\s*(?:•|-)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (bulletParts.length > 1) return bulletParts;

  const sentenceParts = normalized
    .split(/\s+(?=\d+\.\s+)/)
    .map((part) => part.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);
  if (sentenceParts.length > 1) return sentenceParts;

  return [normalized];
}

export function parseCoachingTip(raw: string | null | undefined): ParsedCoachingTip {
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

  let intro: string | null = null;
  let whatAgentShouldHaveSaid: string | null = null;
  let mentorTips: string[] = [];
  let remainder: string | null = null;

  if (whatMatch) {
    const start = whatMatch.index;
    intro = cleanSegment(text.slice(0, start));

    const afterWhat = text.slice(start + whatMatch[0].length);
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
  } else {
    remainder = text;
  }

  if (!whatMatch && !mentorMatch) {
    return {
      intro: null,
      whatAgentShouldHaveSaid: null,
      mentorTips: [text],
      remainder: null,
    };
  }

  if (mentorTips.length === 0 && mentorMatch && !whatMatch) {
    remainder = null;
  }

  return {
    intro,
    whatAgentShouldHaveSaid,
    mentorTips,
    remainder,
  };
}
