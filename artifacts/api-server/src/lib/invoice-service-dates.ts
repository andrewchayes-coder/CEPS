function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

/** Calendar-only strings: never convert business dates through local time. */
export function invoiceServiceDatesError(
  start: string | null | undefined,
  end: string | null | undefined,
  simplified = false,
): string | null {
  if (simplified && (!start || !end)) return "Service start date and service end date are required";
  for (const value of [start, end]) {
    if (value != null && !validCalendarDate(value)) {
      return "Service dates must be valid calendar dates in YYYY-MM-DD format";
    }
  }
  if (start && end) {
    if (start > end) return "Service start date must be on or before service end date";
    const months = (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12
      + Number(end.slice(5, 7)) - Number(start.slice(5, 7)) + 1;
    if (simplified && months > 12) return "Service dates may span at most 12 calendar months";
  }
  return null;
}
