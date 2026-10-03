import type { RubricRef, Transcript, TranscriptSegment, WeaknessItem } from '@/types';

export interface EvidenceAnchor {
  startSec: number;
  endSec: number;
  speakerLabel?: string;
  speakerDisplay?: string;
  quote?: string;
}

export interface WeaknessEvidenceGroup {
  anchor: EvidenceAnchor;
  segments: TranscriptSegment[];
}

function parseTimeToken(value: string): number | null {
  const cleaned = value.trim().replace(/[^\d:.,]/g, '').replace(',', '.');
  if (!cleaned) {
    return null;
  }

  if (cleaned.includes(':')) {
    const parts = cleaned.split(':').map((part) => part.trim()).filter(Boolean);

    if (parts.length === 2) {
      const left = Number(parts[0]);
      const rightRaw = parts[1];
      const right = Number(rightRaw);
      if (!Number.isFinite(left) || !Number.isFinite(right) || left < 0 || right < 0) {
        return null;
      }

      if (rightRaw.length === 2 && right <= 59) {
        return left * 60 + right;
      }

      if (rightRaw.length === 3) {
        return left + right / 1000;
      }

      if (right <= 59) {
        return left * 60 + right;
      }

      return left + right / Math.pow(10, rightRaw.length);
    }

    if (parts.length === 3) {
      const [hoursRaw, minutesRaw, secondsRaw] = parts;
      const hours = Number(hoursRaw);
      const minutes = Number(minutesRaw);
      const seconds = Number(secondsRaw);
      if (
        Number.isFinite(hours) &&
        Number.isFinite(minutes) &&
        Number.isFinite(seconds) &&
        hours >= 0 &&
        minutes >= 0 &&
        seconds >= 0 &&
        minutes <= 59 &&
        seconds <= 59
      ) {
        return hours * 3600 + minutes * 60 + seconds;
      }
      return null;
    }

    return null;
  }

  const asNumber = Number(cleaned);
  if (!Number.isFinite(asNumber) || asNumber < 0) {
    return null;
  }
  return asNumber;
}

function parseSpeakerBlock(speakerBlock?: string): Pick<EvidenceAnchor, 'speakerLabel' | 'speakerDisplay'> {
  const normalized = (speakerBlock || '').trim();
  if (!normalized) {
    return {};
  }

  const speakerLabelMatch = normalized.match(/speaker\s+([A-Za-z0-9_]+)/i);
  const speakerLabel = speakerLabelMatch?.[1];
  const speakerDisplay = speakerLabel
    ? normalized.replace(new RegExp(`,?\\s*speaker\\s+${speakerLabel}`, 'i'), '').trim().replace(/^[-,:; ]+|[-,:; ]+$/g, '')
    : normalized;

  return {
    speakerLabel,
    speakerDisplay: speakerDisplay || undefined,
  };
}

function maybePushAnchor(
  anchors: EvidenceAnchor[],
  seen: Set<string>,
  anchor: EvidenceAnchor
): void {
  const key = `${Math.round(anchor.startSec * 1000)}-${Math.round(anchor.endSec * 1000)}-${(anchor.speakerLabel || '').toLowerCase()}`;
  if (!seen.has(key)) {
    seen.add(key);
    anchors.push(anchor);
  }
}

export function formatTimestamp(seconds: number): string {
  if (seconds < 0) return "--:--";
  const normalized = Math.floor(seconds);
  const minutes = Math.floor(normalized / 60);
  const secs = normalized % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Search transcript segments for a verbatim quote and return the timestamp range.
 * Handles single-segment matches and multi-segment matches (sentences split across 2-3 segments).
 */
function findTimestampForQuote(
  quote: string,
  segments: TranscriptSegment[],
): { startSec: number; endSec: number } | null {
  // Single-segment match (reuse existing logic)
  const singleMatches = findQuoteMatches(segments, quote);
  if (singleMatches.length > 0) {
    const span = singleMatches[singleMatches.length - 1].end - singleMatches[0].start;
    if (span <= 60) {
      return {
        startSec: singleMatches[0].start,
        endSec: singleMatches[singleMatches.length - 1].end,
      };
    }
    // Matches too spread out — fall through to multi-segment sliding window
  }

  // Multi-segment: sliding window of 2-3 consecutive segments
  const normalizedQuote = normalizeForLookup(quote);
  if (!normalizedQuote || normalizedQuote.length < 4) return null;

  for (let windowSize = 2; windowSize <= 3; windowSize++) {
    for (let i = 0; i <= segments.length - windowSize; i++) {
      const window = segments.slice(i, i + windowSize);
      const combinedText = normalizeForLookup(window.map((s) => s.text).join(' '));
      if (combinedText.includes(normalizedQuote)) {
        return {
          startSec: window[0].start,
          endSec: window[window.length - 1].end,
        };
      }
    }
  }

  return null;
}

/**
 * Post-process a detail string to normalize timestamp ranges to m:ss format.
 * When a transcript is provided, derives correct timestamps from the verbatim quote
 * instead of trusting the LLM's often-incorrect timestamp arithmetic.
 */
export function formatDetailTimestamps(detail: string, transcript?: Transcript | null): string {
  if (!detail?.trim()) return detail;

  const timeTokenCapture = '(\\d{1,4}(?::\\d{2,3})?(?:[\\.,]\\d{1,3})?)';
  const optUnit = '(?:\\s*(?:s|seg|secs?|seconds?)\\b)?';

  // Capture: prefix, startTs, separator, endTs, tail (speaker + quote)
  const evidenciaRangeRe = new RegExp(
    `(Evidencia\\s*:?\\s*)${timeTokenCapture}${optUnit}(\\s*[–—-]\\s*)${timeTokenCapture}${optUnit}((?:\\s*\\([^)]*\\))?(?:\\s*:?\\s*[\u201c""][^\u201d""\\n]*[\u201d""])?)`,
    'gi'
  );

  let result = detail.replace(evidenciaRangeRe, (_match, prefix, startRaw, sep, endRaw, tail) => {
    let startSec = parseTimeToken(startRaw);
    let endSec = parseTimeToken(endRaw);
    if (startSec === null || endSec === null) return _match;

    // Try to derive correct timestamps from the quote in the transcript
    if (transcript?.segments?.length) {
      const quoteMatch = (tail || '').match(/[\u201c""]([^\u201d""]{3,})[\u201d""]/);
      if (quoteMatch) {
        const found = findTimestampForQuote(quoteMatch[1].trim(), transcript.segments);
        if (found) {
          startSec = found.startSec;
          endSec = found.endSec;
        }
      }
    }

    return `${prefix}${formatTimestamp(startSec)}${sep}${formatTimestamp(endSec)}${tail || ''}`;
  });

  // Handle new no-timestamp format: Evidencia (Speaker): "quote"
  // Inject derived timestamps when transcript is available
  if (transcript?.segments?.length) {
    const noTimestampRe = /Evidencia\s*(\([^)]*\)\s*:?\s*[\u201c""]([^\u201d""]{3,})[\u201d""])/gi;
    result = result.replace(noTimestampRe, (fullMatch, _tail, quote) => {
      // Skip if this was already handled by the timestamp pattern (has mm:ss before the parenthesis)
      const precedingChunk = result.slice(Math.max(0, result.indexOf(fullMatch) - 20), result.indexOf(fullMatch));
      if (/\d+:\d{2}\s*$/.test(precedingChunk)) return fullMatch;

      const found = findTimestampForQuote(quote.trim(), transcript.segments);
      if (found) {
        return `Evidencia: ${formatTimestamp(found.startSec)}\u2013${formatTimestamp(found.endSec)} ${_tail}`;
      }
      return fullMatch;
    });
  }

  return result;
}

export function formatRubricPath(ref?: RubricRef): string {
  if (!ref) {
    return '';
  }

  const sectionParts = ref.section_path
    .split('>')
    .map((part) => part.trim())
    .filter(Boolean);

  const displaySections =
    sectionParts.length >= 2
      ? [sectionParts[sectionParts.length - 2], sectionParts[sectionParts.length - 1]]
      : sectionParts;

  const parts = [...displaySections];
  if (ref.subsection_text?.trim()) {
    parts.push(ref.subsection_text.trim());
  }
  return parts.join(' -> ');
}

export function parseEvidenceAnchors(detail: string): EvidenceAnchor[] {
  if (!detail?.trim()) {
    return [];
  }

  const anchors: EvidenceAnchor[] = [];
  const seen = new Set<string>();
  const timeToken = '(\\d{1,4}(?::\\d{2,3})?(?:[\\.,]\\d{1,3})?)';

  const canonicalPattern = new RegExp(
    `Evidencia\\s*:?\\s*${timeToken}\\s*(?:s|seg|secs?|seconds?)?\\s*[–—-]\\s*${timeToken}\\s*(?:s|seg|secs?|seconds?)?(?:\\s*\\(([^)]*)\\))?(?:\\s*:\\s*[“"]?([^”"\\n]+)?[”"]?)?`,
    'gi'
  );

  let canonical = canonicalPattern.exec(detail);
  while (canonical) {
    const startSec = parseTimeToken(canonical[1]);
    const endSec = parseTimeToken(canonical[2]);
    if (startSec !== null && endSec !== null) {
      const speakerInfo = parseSpeakerBlock(canonical[3]);
      const quote = canonical[4]?.trim();
      maybePushAnchor(anchors, seen, {
        startSec: Math.min(startSec, endSec),
        endSec: Math.max(startSec, endSec),
        ...speakerInfo,
        quote: quote || undefined,
      });
    }
    canonical = canonicalPattern.exec(detail);
  }

  // New no-timestamp format: Evidencia (Speaker): "quote"
  const noTimestampPattern = /Evidencia\s*\(([^)]*)\)\s*:?\s*[\u201c""]([^\u201d""]{3,})[\u201d""]/gi;
  let noTs = noTimestampPattern.exec(detail);
  while (noTs) {
    const speakerInfo = parseSpeakerBlock(noTs[1]);
    const quote = noTs[2]?.trim();
    // Use -1 as sentinel: no LLM-provided timestamps
    maybePushAnchor(anchors, seen, {
      startSec: -1,
      endSec: -1,
      ...speakerInfo,
      quote: quote || undefined,
    });
    noTs = noTimestampPattern.exec(detail);
  }

  const looseRangePattern = new RegExp(
    `${timeToken}\\s*(?:s|seg|secs?|seconds?)?\\s*[–—-]\\s*${timeToken}\\s*(?:s|seg|secs?|seconds?)?`,
    'gi'
  );

  let loose = looseRangePattern.exec(detail);
  while (loose) {
    const startRaw = loose[1];
    const endRaw = loose[2];
    const looksLikeTimeRange = /[:.,]/.test(startRaw) || /[:.,]/.test(endRaw) || /s\b/i.test(loose[0]);
    if (!looksLikeTimeRange) {
      loose = looseRangePattern.exec(detail);
      continue;
    }

    const startSec = parseTimeToken(startRaw);
    const endSec = parseTimeToken(endRaw);

    if (startSec !== null && endSec !== null) {
      const matchStart = loose.index;
      const matchEnd = matchStart + loose[0].length;
      const nearbyContext = detail.slice(Math.max(0, matchStart - 48), Math.min(detail.length, matchEnd + 96));
      const trailingContext = detail.slice(matchEnd, Math.min(detail.length, matchEnd + 140));

      const speakerBlock = nearbyContext.match(/\(([^)]*speaker[^)]*)\)/i)?.[1];
      const speakerInfo = parseSpeakerBlock(speakerBlock);
      const quote =
        trailingContext.match(/[“"]([^”"\n]{3,})[”"]/)?.[1]?.trim() ||
        nearbyContext.match(/[“"]([^”"\n]{3,})[”"]/)?.[1]?.trim();

      maybePushAnchor(anchors, seen, {
        startSec: Math.min(startSec, endSec),
        endSec: Math.max(startSec, endSec),
        ...speakerInfo,
        quote: quote || undefined,
      });
    }

    loose = looseRangePattern.exec(detail);
  }

  return anchors;
}

function overlaps(segment: TranscriptSegment, startSec: number, endSec: number): boolean {
  return segment.end >= startSec && segment.start <= endSec;
}

function remapLikelySubMinuteToken(seconds: number): number {
  const normalized = Math.max(0, seconds);
  const whole = Math.floor(normalized);
  const major = Math.floor(whole / 60);
  const minor = whole % 60;
  const fraction = normalized - whole;
  return major + minor / 100 + fraction / 100;
}

function normalizeAnchorsToTranscriptDuration(
  anchors: EvidenceAnchor[],
  transcriptDuration: number
): EvidenceAnchor[] {
  if (!Number.isFinite(transcriptDuration) || transcriptDuration <= 0) {
    return anchors;
  }

  const safeUpperBound = transcriptDuration + 3;

  return anchors.map((anchor) => {
    if (anchor.endSec <= safeUpperBound) {
      return anchor;
    }

    const remappedStart = remapLikelySubMinuteToken(anchor.startSec);
    const remappedEnd = remapLikelySubMinuteToken(anchor.endSec);

    const remapLooksValid =
      remappedStart >= 0 &&
      remappedEnd >= remappedStart &&
      remappedEnd <= safeUpperBound;

    if (!remapLooksValid) {
      return anchor;
    }

    return {
      ...anchor,
      startSec: remappedStart,
      endSec: remappedEnd,
    };
  });
}

function normalizeForLookup(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findQuoteMatches(
  segments: TranscriptSegment[],
  quote: string,
  speakerLabel?: string
): TranscriptSegment[] {
  const normalizedQuote = normalizeForLookup(quote);
  if (!normalizedQuote || normalizedQuote.length < 4) {
    return [];
  }

  const sameSpeaker = speakerLabel
    ? segments.filter((segment) => segment.speaker.toLowerCase() === speakerLabel.toLowerCase())
    : segments;

  const findIn = (candidateSegments: TranscriptSegment[]) =>
    candidateSegments.filter((segment) => {
      const normalizedSegment = normalizeForLookup(segment.text);
      return normalizedSegment.includes(normalizedQuote);
    });

  const speakerMatches = findIn(sameSpeaker);
  if (speakerMatches.length > 0) {
    return speakerMatches;
  }

  if (sameSpeaker !== segments) {
    return findIn(segments);
  }

  return [];
}

export function buildWeaknessEvidenceGroups(weakness: WeaknessItem, transcript: Transcript | null): WeaknessEvidenceGroup[] {
  if (!transcript) {
    return [];
  }

  const anchors = normalizeAnchorsToTranscriptDuration(
    parseEvidenceAnchors(weakness.detail || ''),
    transcript.duration
  );

  return anchors.map((anchor) => {
    // Sentinel timestamps (< 0): no LLM timestamps, go straight to quote matching
    if (anchor.startSec < 0) {
      const quoteMatches = anchor.quote
        ? findQuoteMatches(transcript.segments, anchor.quote, anchor.speakerLabel)
        : [];

      // Derive anchor timestamps from matched segments (use first match if scattered)
      const quoteSpan = quoteMatches.length > 1
        ? quoteMatches[quoteMatches.length - 1].end - quoteMatches[0].start
        : 0;
      const useMatches = quoteSpan > 60
        ? quoteMatches.slice(0, 1)  // scattered matches, use only the first
        : quoteMatches;
      const resolvedAnchor = useMatches.length > 0
        ? {
            ...anchor,
            startSec: useMatches[0].start,
            endSec: useMatches[useMatches.length - 1].end,
          }
        : anchor;

      return {
        anchor: resolvedAnchor,
        segments: quoteMatches.slice(0, 6),
      };
    }

    const exactSpeakerMatches = anchor.speakerLabel
      ? transcript.segments.filter(
          (segment) =>
            segment.speaker.toLowerCase() === anchor.speakerLabel?.toLowerCase() &&
            overlaps(segment, anchor.startSec, anchor.endSec)
        )
      : [];

    const overlapMatches =
      exactSpeakerMatches.length > 0
        ? exactSpeakerMatches
        : transcript.segments.filter((segment) => overlaps(segment, anchor.startSec, anchor.endSec));

    const quoteMatches =
      overlapMatches.length === 0 && anchor.quote
        ? findQuoteMatches(transcript.segments, anchor.quote, anchor.speakerLabel)
        : [];

    const segments = overlapMatches.length > 0 ? overlapMatches : quoteMatches;

    return {
      anchor,
      segments: segments.slice(0, 6),
    };
  });
}
