export const fmtDur = /** Formats elapsed audio time without fractional numeric text. */ (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '—';
  const seconds = Math.floor(s);
  if (!Number.isSafeInteger(seconds)) return '—';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export const fmtMoney = /** Documents the fmtMoney behavior. */ (n: number, locale = 'es-MX') =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 0,
  }).format(n);
