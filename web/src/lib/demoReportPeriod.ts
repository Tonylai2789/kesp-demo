/** Last completed Monday-Sunday period in the demo's Mexico City business timezone. */
export function previousDemoWeek(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (kind: string) => parts.find((part) => part.type === kind)?.value;
  const end = new Date(get('year') + '-' + get('month') + '-' + get('day') + 'T12:00:00Z');
  end.setUTCDate(end.getUTCDate() - (end.getUTCDay() || 7));
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6);
  const thursday = new Date(start); thursday.setUTCDate(thursday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), weekKey: year + '-W' + String(week).padStart(2, '0') };
}
