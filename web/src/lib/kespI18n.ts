export type KespLanguage = 'en' | 'es';
export type KespLocale = 'en-US' | 'es-MX';

export function getKespLanguage(language?: string | null): KespLanguage {
  return language?.toLowerCase().startsWith('en') ? 'en' : 'es';
}

export function getKespLocale(language?: string | null): KespLocale {
  return getKespLanguage(language) === 'en' ? 'en-US' : 'es-MX';
}

export function formatKespDate(
  date: Date | null | undefined,
  language: string | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat(getKespLocale(language), options).format(date);
}

export function formatKespMoneyMx(
  value: number | null | undefined,
  language: string | null | undefined
): string {
  if (typeof value !== 'number' || !isFinite(value)) return '—';
  return new Intl.NumberFormat(getKespLocale(language), {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}
