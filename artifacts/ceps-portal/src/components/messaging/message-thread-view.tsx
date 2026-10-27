import { ProtectedData } from '@/components/protected-data';
import { formatDate } from '@/lib/dates';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowLeft } from 'lucide-react';
import {
  useGetMessageThread, getGetMessageThreadQueryKey, getMessageThread, sendMessage, markMessageThreadRead,
  type MessageCursor, type MessageThreadDetail, type ThreadMessage,
} from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { errText, invalidateMessaging } from '@/hooks/use-messaging';
import { formatPacific } from '@/lib/datetime';
import { mergeNewestFirst, roleLabel, visiblePending, type PendingMessage } from '@/lib/messaging';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { MessageBody } from './message-body';
import { AddFamilyDialog } from './add-family-dialog';
import { ThreadAssignment } from './thread-assignment';
import { ThreadStatus } from './thread-status';

export function MessageThreadView({ threadId, untilDate }: { threadId: string; untilDate?: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isStaffLike = user?.role === 'staff' || user?.role === 'service_coordinator';
  const params = useMemo(() => ({ limit: 50, ...(untilDate ? { untilDate } : {}) }), [untilDate]);
  const qk = useMemo(() => [...getGetMessageThreadQueryKey(threadId, params), user?.id], [threadId, user?.id, params]);
  const { data, dataUpdatedAt, isLoading, isError, refetch } = useGetMessageThread(threadId, params, {
    query: { queryKey: qk, refetchInterval: 30000, refetchOnWindowFocus: true },
  });
  const [, navigate] = useLocation();
  const search = useSearch();
  const jumpToLatest = () => {
    const next = new URLSearchParams(search);
    next.delete('until');
    navigate(`/messages/${threadId}${next.size ? `?${next}` : ''}`);
  };
  const [viewedLatest, setViewedLatest] = useState(false);

  const [older, setOlder] = useState<ThreadMessage[]>([]);
  const [olderLoaded, setOlderLoaded] = useState(false);
  const [olderCursor, setOlderCursor] = useState<MessageCursor | null>(null);
  const [olderHasMore, setOlderHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const markedFor = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Keep messages that scroll out of the latest-50 window when a poll replaces it.
  const prevWindow = useRef<ThreadMessage[]>([]);
  const windowMessages = data?.messages;
  useEffect(() => {
    if (!windowMessages) return;
    const prev = prevWindow.current;
    prevWindow.current = windowMessages;
    const ids = new Set(windowMessages.map((m) => m.id));
    const dropped = prev.filter((m) => !ids.has(m.id));
    if (dropped.length) setOlder((o) => mergeNewestFirst(dropped, o));
  }, [windowMessages]);

  const newestFirst = useMemo(() => mergeNewestFirst(data?.messages ?? [], older), [data?.messages, older]);
  const shownPending = visiblePending(pending, newestFirst);
  const lastKey = (shownPending.at(-1)?.tempId ?? newestFirst[0]?.id) ?? '';
  const cursor = olderLoaded ? olderCursor : data?.nextCursor ?? null;
  const hasMore = olderLoaded ? olderHasMore : !!data?.hasMore;

  // Mark read for this thread only, and again when new incoming messages arrive while viewing.
  const selfAssignedAt = data?.thread.assignee?.userId === user?.id ? data?.thread.assignedAt ?? '' : '';
  const incomingId = `${data?.messages.find((m) => !m.isMine)?.id ?? 'none'}|${selfAssignedAt}`;
  const loaded = !!data;
  useEffect(() => {
    if (!loaded || (untilDate && (data?.hasNewer || !viewedLatest)) || markedFor.current === incomingId) return;
    const run = () => {
      if (document.hidden || markedFor.current === incomingId) return;
      markedFor.current = incomingId;
      markMessageThreadRead(threadId).then(() => invalidateMessaging(qc)).catch(() => { markedFor.current = null; });
    };
    if (!document.hidden) { run(); return; }
    document.addEventListener('visibilitychange', run);
    return () => document.removeEventListener('visibilitychange', run);
  }, [loaded, incomingId, threadId, qc, dataUpdatedAt, untilDate, data?.hasNewer, viewedLatest]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastKey, loaded]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && prevHeight.current != null) { el.scrollTop += el.scrollHeight - prevHeight.current; prevHeight.current = null; }
  }, [older.length]);

  const loadOlder = async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true); setOlderError(null);
    try {
      const page = await getMessageThread(threadId, { before: cursor.before, beforeId: cursor.beforeId, limit: 50 });
      if (!mounted.current) return;
      prevHeight.current = scroller.current?.scrollHeight ?? null;
      nearBottom.current = false;
      setOlder((o) => mergeNewestFirst(o, page.messages));
      setOlderLoaded(true); setOlderCursor(page.nextCursor); setOlderHasMore(page.hasMore);
    } catch (e) { if (mounted.current) setOlderError(errText(e, 'Could not load older messages.')); }
    finally { if (mounted.current) setLoadingOlder(false); }
  };

  const sending = pending.length > 0;
  const send = () => {
    const originalDraft = draft;
    const body = draft.trim();
    if (!body || draft.length > 5000 || sending || !data) return;
    const p: PendingMessage = { tempId: `pending-${Date.now()}`, body, knownIds: newestFirst.map((m) => m.id) };
    nearBottom.current = true;
    setPending([p]); setDraft(''); setError(null);
    sendMessage(threadId, { body }).then((msg) => {
      if (untilDate) {
        invalidateMessaging(qc);
        if (mounted.current) jumpToLatest();
        return;
      }
      qc.setQueryData<MessageThreadDetail>(qk, (old) => old && !old.messages.some((m) => m.id === msg.id)
        ? { ...old, messages: [msg, ...old.messages], thread: { ...old.thread, lastMessageAt: msg.createdAt, lastMessagePreview: msg.body } } : old);
      if (mounted.current) setPending([]);
      invalidateMessaging(qc);
      void refetch(); // reply may auto-reopen the thread; refresh the header status
    }).catch((e) => {
      if (!mounted.current) return;
      setPending([]);
      setDraft((d) => (d.trim() ? `${originalDraft}\n${d}` : originalDraft));
      setError(errText(e));
    });
  };

  if (isLoading) return <div className="space-y-3 p-4" data-testid="message-thread-loading"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>;
  if (isError || !data) return (
    <div className="flex flex-col items-start gap-3 p-4 text-sm text-muted-foreground" data-testid="message-thread-error">
      This conversation could not be loaded.
      <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
    </div>
  );

  const t = data.thread;
  const toList = ['CEPS staff', ...(t.includeCoordinator && t.coordinatorName ? [t.coordinatorName] : []), ...t.familyMemberNames];
  const display = [...newestFirst].reverse();

  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="message-thread-view" aria-label={`Conversation: ${t.subject}`}>
      <header className="space-y-1 border-b p-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2 md:hidden">
          <Link href="/messages" data-testid="button-messages-back"><ArrowLeft className="mr-1 h-4 w-4" /> Messages</Link>
        </Button>
        <h2 className="break-words text-lg font-semibold" data-testid="text-thread-subject">{t.subject}</h2>
        <p className="text-sm text-muted-foreground">
          Participant:{' '}
          {isStaffLike ? <Link href={`/clients/${t.clientId}`} className="text-primary hover:underline"><ProtectedData>{t.clientName}</ProtectedData></Link> : <ProtectedData>{t.clientName}</ProtectedData>}
        </p>
        {user?.role === 'service_coordinator' && (
          <p className="text-sm text-muted-foreground" data-testid="text-thread-assignment">{t.assignee ? `Assigned to ${t.assignee.name}` : 'Unassigned'}</p>
        )}
        <ThreadStatus thread={t} qk={qk} canChange={isStaffLike} />
        {user?.role === 'staff' && <ThreadAssignment thread={t} qk={qk} currentUserId={user.id} canAssignOthers={(user.permissions ?? []).includes('manage_users')} />}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" data-testid="text-thread-to">To: {toList.join(', ')}</p>
          {isStaffLike && <AddFamilyDialog thread={t} />}
        </div>
      </header>
      {untilDate && (
        <div className="flex items-center justify-between gap-2 border-b bg-secondary px-4 py-2 text-sm" data-testid="banner-message-history">
          <span>Showing messages up to <ProtectedData>{formatDate(untilDate)}</ProtectedData>.</span>
          <Button size="sm" variant="outline" onClick={jumpToLatest} data-testid="button-jump-to-latest">Jump to latest</Button>
        </div>
      )}
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" data-testid="message-thread-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (nearBottom.current && !data.hasNewer) setViewedLatest(true);
        }}>
        {hasMore && (
          <div className="text-center">
            <Button size="sm" variant="outline" onClick={() => void loadOlder()} disabled={loadingOlder} data-testid="button-load-older-messages">
              {loadingOlder ? 'Loading...' : 'Load older messages'}
            </Button>
            {olderError && <p role="alert" className="mt-1 text-xs text-destructive">{olderError}</p>}
          </div>
        )}
        {display.map((m) => (
          <article key={m.id} className={cn('max-w-[85%] rounded-md border p-3', m.isMine ? 'ml-auto bg-primary/10' : 'bg-card')} data-testid={`message-${m.id}`}>
            <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
              <span className="text-sm font-medium text-foreground"><ProtectedData>{m.author.name}</ProtectedData></span>
              <span>{roleLabel(m.author.role)}</span>
              <span><ProtectedData>{formatPacific(m.createdAt)}</ProtectedData></span>
            </div>
            <MessageBody text={m.body} />
          </article>
        ))}
        {shownPending.map((p) => (
          <article key={p.tempId} className="ml-auto max-w-[85%] rounded-md border border-dashed bg-primary/5 p-3 opacity-70" data-testid="message-pending">
            <p className="mb-1 text-xs text-muted-foreground">Sending...</p>
            <MessageBody text={p.body} />
          </article>
        ))}
      </div>
      <div className="space-y-2 border-t p-3">
        <Textarea value={draft} rows={3} maxLength={5000} disabled={sending} onChange={(e) => setDraft(e.target.value)} placeholder="Write a reply" aria-label="Reply"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} data-testid="textarea-reply" />
        {error && <p role="alert" className="text-sm text-destructive" data-testid="error-reply">{error}</p>}
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{draft.length}/5000 - Ctrl/Cmd+Enter to send</span>
          <Button size="sm" onClick={send} disabled={!draft.trim() || draft.length > 5000 || sending} data-testid="button-send-reply">{sending ? 'Sending...' : 'Send'}</Button>
        </div>
      </div>
    </section>
  );
}
