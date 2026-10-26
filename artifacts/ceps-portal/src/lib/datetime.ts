import { formatDate, formatDateTime } from './dates';

export function formatPacific(ts: string): string {
  const value = formatDateTime(ts);
  return value === '—' ? value : `${value} PT`;
}

/** Today (Pacific) shows the time; otherwise the Pacific date. */
export function formatMessageClock(ts: string, now: Date = new Date()): string {
  if (formatDate(ts) === formatDate(now)) {
    return formatDateTime(ts).replace(/^\d{2}\/\d{2}\/\d{4} /, '');
  }
  return formatDate(ts);
}
