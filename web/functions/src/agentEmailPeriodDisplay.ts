export type EmailPeriodDisplayReportType = "daily" | "weekly";

export interface EmailPeriodDisplayPeriod {
  reportType: EmailPeriodDisplayReportType;
  periodKey?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  label?: string | null;
}

/** Formats report periods for recipient-facing email copy. */
export function formatEmailPeriodDisplay(period: EmailPeriodDisplayPeriod): string {
  const startDate = period.startDate?.trim();
  const endDate = period.endDate?.trim();
  if (period.reportType === "weekly" && startDate && endDate) {
    return `Semana del ${startDate} al ${endDate}`;
  }
  return period.label?.trim() || startDate || period.periodKey?.trim() || "";
}
