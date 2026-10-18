import type { ListMessageThreadsParams, ThreadMessage } from '@workspace/api-client-react';

export type RangeMode = 'recent' | 'archive' | 'custom';
export interface MessageRange { mode: RangeMode; from?: string; to?: string }
export const DEFAULT_RANGE: MessageRange = { mode: 'recent' };

export function unreadBadgeLabel(count: number | undefined): string | null {
  if (!count || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

export function rangeParams(r: MessageRange): Pick<ListMessageThreadsParams, 'range' | 'dateFrom' | 'dateTo'> {
  if (r.mode === 'custom' && (r.from || r.to)) {
    return { ...(r.from ? { dateFrom: r.from } : {}), ...(r.to ? { dateTo: r.to } : {}) };
  }
  return { range: r.mode === 'archive' ? 'archive' : 'recent' };
}

export function rangeCaption(r: MessageRange): string {
  if (r.mode === 'archive') return 'Showing archived messages (older than 6 months)';
  if (r.mode === 'custom' && (r.from || r.to)) return `Showing ${r.from ?? 'the beginning'} to ${r.to ?? 'today'}`;
  return 'Showing the last 6 months';
}

export function roleLabel(role: string): string {
  if (role === 'staff') return 'CEPS Staff';
  if (role === 'service_coordinator') return 'Service Coordinator';
  return 'Family';
}

export type Segment = { type: 'text'; value: string } | { type: 'link'; value: string; href: string };

/** Split plain text into text and safe http(s) link segments. Never produces HTML. */
export function linkify(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /https?:\/\/[^\s<>"']+/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)\]]+$/);
    if (trail) url = url.slice(0, url.length - trail[0].length);
    let ok = false;
    try { const u = new URL(url); ok = u.protocol === 'http:' || u.protocol === 'https:'; } catch { ok = false; }
    if (!ok || !url) continue;
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push({ type: 'link', value: url, href: url });
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

export interface PendingMessage { tempId: string; body: string; knownIds: string[] }

/** Newest-first lists merged without duplicate ids (first occurrence wins). */
export function mergeNewestFirst(...lists: ThreadMessage[][]): ThreadMessage[] {
  const seen = new Set<string>();
  const out: ThreadMessage[] = [];
  for (const list of lists) for (const m of list) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
  return out;
}

/** Hide a pending message once an equivalent new message of mine has arrived via poll. */
export function visiblePending(pending: PendingMessage[], messages: ThreadMessage[]): PendingMessage[] {
  return pending.filter((p) => !messages.some((m) => m.isMine && m.body === p.body && !p.knownIds.includes(m.id)));
}
