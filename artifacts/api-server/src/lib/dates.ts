/** Server output formats mirror the portal; API/storage values remain ISO. */
export type DateValue = string | Date | null | undefined;
export const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const EMPTY = "—";
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function calendarDate(value: string): string | null {
  const match = datePattern.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return y > 0 && m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]
    ? `${month}/${day}/${year}` : EMPTY;
}

function instant(value: DateValue): Date | null {
  if (!value || (typeof value === "string" && datePattern.test(value))) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: DateValue): string {
  if (typeof value === "string") {
    const calendar = calendarDate(value);
    if (calendar !== null) return calendar;
  }
  const date = instant(value);
  return date ? new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE, month: "2-digit", day: "2-digit", year: "numeric",
  }).format(date) : EMPTY;
}

export function formatDateTime(value: DateValue): string {
  if (typeof value === "string" && datePattern.test(value)) return formatDate(value);
  const date = instant(value);
  if (!date) return EMPTY;
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date);
  return `${formatDate(date)} ${time}`;
}

export function formatMonth(value?: string | null): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value ?? "");
  return match && Number(match[1]) > 0 ? `${match[2]}/${match[1]}` : EMPTY;
}

export function formatMonthRange(a?: string | null, b?: string | null): string {
  if (!a) return formatMonth(b);
  if (!b) return formatMonth(a);
  return `${formatMonth(a)} – ${formatMonth(b)}`;
}

export function formatDateRange(start: DateValue, end: DateValue): string {
  if (!start) return formatDate(end);
  if (!end) return formatDate(start);
  return `${formatDate(start)} – ${formatDate(end)}`;
}
