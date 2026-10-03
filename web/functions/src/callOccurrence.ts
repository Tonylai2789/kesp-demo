import { FieldValue, Timestamp } from "firebase-admin/firestore";

export const CALL_OCCURRED_AT_TIME_ZONE = "America/Mexico_City";

export type CallOccurredAtSource = "ccc_filename" | "created_at_fallback";

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Extracts date-time parts for a Date in a target IANA time zone. */
function getDateTimePartsInTimeZone(date: Date, timeZone: string): DateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  const hourText = lookup.get("hour") ?? "0";
  return {
    year: Number(lookup.get("year")),
    month: Number(lookup.get("month")),
    day: Number(lookup.get("day")),
    hour: hourText === "24" ? 0 : Number(hourText),
    minute: Number(lookup.get("minute")),
    second: Number(lookup.get("second")),
  };
}

/** Converts local wall-clock parts in an IANA time zone to the corresponding UTC Date. */
function zonedDateTimeToUtcDate(parts: DateTimeParts, timeZone: string): Date {
  const localAsUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let utcMs = localAsUtcMs;
  for (let i = 0; i < 3; i += 1) {
    const rendered = getDateTimePartsInTimeZone(new Date(utcMs), timeZone);
    const renderedAsUtcMs = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second
    );
    utcMs = localAsUtcMs - (renderedAsUtcMs - utcMs);
  }
  return new Date(utcMs);
}

/** Parses CCC YYYYMMDDHHMMSS timestamps as Mexico City local call-occurrence times. */
export function parseCccCallTimestampToDate(
  value: unknown,
  timeZone = CALL_OCCURRED_AT_TIME_ZONE
): Date | null {
  if (typeof value !== "string" || !/^\d{14}$/.test(value)) return null;
  const parts: DateTimeParts = {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(4, 6)),
    day: Number(value.slice(6, 8)),
    hour: Number(value.slice(8, 10)),
    minute: Number(value.slice(10, 12)),
    second: Number(value.slice(12, 14)),
  };
  if (
    parts.month < 1 || parts.month > 12 ||
    parts.day < 1 || parts.day > 31 ||
    parts.hour < 0 || parts.hour > 23 ||
    parts.minute < 0 || parts.minute > 59 ||
    parts.second < 0 || parts.second > 59
  ) {
    return null;
  }
  const parsed = zonedDateTimeToUtcDate(parts, timeZone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Builds Firestore call-occurrence fields from CCC filename metadata. */
export function callOccurrenceFieldsFromCccTimestamp(value: unknown): Record<string, unknown> {
  const callOccurredAt = parseCccCallTimestampToDate(value);
  if (!callOccurredAt) return {};
  /** Calls Firebase Admin Timestamp conversion when the runtime provides it. */
  const callOccurredAtValue = Timestamp?.fromDate ? Timestamp.fromDate(callOccurredAt) : callOccurredAt;
  return {
    callOccurredAt: callOccurredAtValue,
    callOccurredAtSource: "ccc_filename" satisfies CallOccurredAtSource,
  };
}

/** Builds fallback Firestore call-occurrence fields for calls without source metadata. */
export function callOccurrenceCreatedAtFallbackFields(): Record<string, unknown> {
  return {
    callOccurredAt: FieldValue.serverTimestamp(),
    callOccurredAtSource: "created_at_fallback" satisfies CallOccurredAtSource,
  };
}

/** Returns a Date from common Firestore/admin timestamp shapes. */
export function timestampLikeToDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && typeof (value as { toDate?: unknown }).toDate === "function") {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** Resolves the business date for a call, falling back to createdAt for legacy/manual calls. */
export function resolveCallOccurredAtDate(callData: Record<string, unknown>): { date: Date; source: CallOccurredAtSource } {
  const explicit = timestampLikeToDate(callData.callOccurredAt);
  if (explicit) {
    const explicitSource = callData.callOccurredAtSource === "created_at_fallback" ? "created_at_fallback" : "ccc_filename";
    return { date: explicit, source: explicitSource };
  }
  const parsed = parseCccCallTimestampToDate(callData.cccCallTimestamp);
  if (parsed) return { date: parsed, source: "ccc_filename" };
  const createdAt = timestampLikeToDate(callData.createdAt) ?? new Date();
  return { date: createdAt, source: "created_at_fallback" };
}
