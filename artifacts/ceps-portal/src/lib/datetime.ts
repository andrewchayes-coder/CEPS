const PACIFIC = 'America/Los_Angeles';

export function formatPacific(ts: string): string {
  const d = new Date(ts);
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(d);
  return date;
}

const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** Today (Pacific) shows the time; otherwise the Pacific date. */
export function formatMessageClock(ts: string, now: Date = new Date()): string {
  const d = new Date(ts);
  if (dayKey(d) === dayKey(now)) {
    return new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, hour: 'numeric', minute: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}
