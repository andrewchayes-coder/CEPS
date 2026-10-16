export const SERVICE_DATE_MAX_MONTHS = 12;

export function isValidIsoDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Calendar months touched, inclusive. Returns [] for missing/invalid/reversed input. */
export function monthsInRange(start: string | null | undefined, end: string | null | undefined): string[] {
  if (!isValidIsoDate(start) || !isValidIsoDate(end) || end < start) return [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(5, 7));
  const out: string[] = [];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/** Returns an error message, or null when the range is valid. */
export function validateServiceDateRange(start: string, end: string): string | null {
  if (!start) return 'Service start date is required';
  if (!end) return 'Service end date is required';
  if (!isValidIsoDate(start)) return 'Service start date is not a valid date';
  if (!isValidIsoDate(end)) return 'Service end date is not a valid date';
  if (end < start) return 'Service end date must be on or after the start date';
  if (monthsInRange(start, end).length > SERVICE_DATE_MAX_MONTHS) return 'Service dates cannot span more than 12 months';
  return null;
}

export function blankLinesForServiceDates(
  start: string | null | undefined,
  end: string | null | undefined,
  fallbackMonth: string,
) {
  const months = monthsInRange(start, end);
  return (months.length ? months : [fallbackMonth]).map((serviceMonth) => ({ authorizationId: '', serviceMonth, amount: '' }));
}

export function formatServiceDates(start?: string | null, end?: string | null): string | null {
  return start && end ? `${start} – ${end}` : null;
}
