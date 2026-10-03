export interface TimedSegment { start: number; end: number }
export interface PlaybackInterval { start: number; end: number; includesPause: boolean }

/** Rejects timestamps that cannot define a playable audio interval. */
export function validInterval(segment: TimedSegment | undefined): segment is TimedSegment {
  return Boolean(segment && Number.isFinite(segment.start) && Number.isFinite(segment.end)
    && segment.start >= 0 && segment.end > segment.start);
}

/** Preserves the following silence without truncating overlapping speech. */
export function segmentPlaybackInterval(
  segments: readonly TimedSegment[], index: number, duration?: number,
): PlaybackInterval | null {
  const current = segments[index];
  if (!validInterval(current)) return null;
  const next = segments[index + 1];
  const end = validInterval(next) ? Math.max(current.end, next.start) : current.end;
  const clampedEnd = Number.isFinite(duration) && duration! > 0 ? Math.min(end, duration!) : end;
  if (clampedEnd <= current.start) return null;
  return { start: current.start, end: clampedEnd, includesPause: clampedEnd > current.end };
}

/** Matches evidence by time, including both sides of silence rather than relying on IDs. */
export function transcriptEvidenceIndices(segments: readonly TimedSegment[], evidence: TimedSegment | null): number[] {
  if (!evidence || !Number.isFinite(evidence.start) || !Number.isFinite(evidence.end)
    || evidence.start < 0 || evidence.end < evidence.start) return [];
  const matches: number[] = [];
  segments.forEach(/** Includes lexical segments overlapping the evidence interval. */ (segment, index) => {
    if (validInterval(segment) && segment.start < evidence.end && segment.end > evidence.start) matches.push(index);
  });
  if (matches.length) return matches;
  let before = -1;
  let after = -1;
  segments.forEach(/** Locates the nearest original turns surrounding gap or point evidence. */ (segment, index) => {
    if (!validInterval(segment)) return;
    if (segment.end <= evidence.start && (before < 0 || segment.end > segments[before].end)) before = index;
    if (segment.start >= evidence.end && (after < 0 || segment.start < segments[after].start)) after = index;
  });
  return [...new Set([before, after].filter(/** Omits absent boundary turns. */ (index) => index >= 0))];
}
