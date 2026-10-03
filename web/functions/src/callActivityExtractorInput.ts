import type { CallOccurredAtSource } from "./callOccurrence";

export interface CallActivityExtractorInputParams {
  callId: string;
  callOccurredAt: Date | null;
  callOccurredAtSource: CallOccurredAtSource | null;
  referenceTimeZone: string;
  transcriptData: Record<string, unknown>;
  feedback: Record<string, unknown>;
}

export interface CallActivityExtractorInput {
  call_id: string;
  reference_call_occurred_at_iso: string | null;
  reference_call_occurred_local_date: string | null;
  reference_call_occurred_at_source: CallOccurredAtSource | null;
  reference_call_created_at_iso: string | null;
  reference_timezone: string;
  transcript: Record<string, unknown>;
  feedback_context: {
    agent_name: unknown;
    customer_name: unknown;
    loan_completed: unknown;
    suggested_followup_message: unknown;
    overall_score: unknown;
    performance_tier: unknown;
    low_confidence: unknown;
  };
}

/** Extracts date parts for a Date in an IANA time zone. */
function datePartsInTimeZone(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map(/** Stores one formatted date part by type. */(part) => [part.type, part.value]));
  return {
    year: Number(lookup.get("year")),
    month: Number(lookup.get("month")),
    day: Number(lookup.get("day")),
  };
}

/** Formats a Date as the local YYYY-MM-DD day in the supplied time zone. */
export function formatLocalDateForTimeZone(date: Date | null, timeZone: string): string | null {
  if (!date) return null;
  const parts = datePartsInTimeZone(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Builds the JSON input sent to the downstream call activity extractor prompt. */
export function buildCallActivityExtractorInput(
  params: CallActivityExtractorInputParams
): CallActivityExtractorInput {
  const referenceIso = params.callOccurredAt ? params.callOccurredAt.toISOString() : null;
  return {
    call_id: params.callId,
    reference_call_occurred_at_iso: referenceIso,
    reference_call_occurred_local_date: formatLocalDateForTimeZone(params.callOccurredAt, params.referenceTimeZone),
    reference_call_occurred_at_source: params.callOccurredAtSource,
    // Deprecated alias kept temporarily so older prompt overrides still receive the date field they expect.
    reference_call_created_at_iso: referenceIso,
    reference_timezone: params.referenceTimeZone,
    transcript: params.transcriptData,
    feedback_context: {
      agent_name: params.feedback.agent_name ?? null,
      customer_name: params.feedback.customer_name ?? null,
      loan_completed: params.feedback.loan_completed ?? "unclear",
      suggested_followup_message: params.feedback.suggested_followup_message ?? null,
      overall_score: params.feedback.overall_score ?? null,
      performance_tier: params.feedback.performance_tier ?? null,
      low_confidence: params.feedback.low_confidence ?? false,
    },
  };
}
