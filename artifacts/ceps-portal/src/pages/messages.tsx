import { useState } from 'react';
import { useLocation, useParams, useSearch } from 'wouter';
import { Inbox, Plus, X } from 'lucide-react';
import { useMessagingRole, useThreadList, useUnreadCount } from '@/hooks/use-messaging';
import { useDebounce } from '@/hooks/use-debounce';
import { rangeParams, DEFAULT_RANGE, type MessageRange } from '@/lib/messaging';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { MessageRangeControl, MessageRangeCaption } from '@/components/messaging/message-range-control';
import { MessageThreadRows } from '@/components/messaging/message-thread-rows';
import { MessageThreadView } from '@/components/messaging/message-thread-view';
import { MessageComposeDialog } from '@/components/messaging/message-compose-dialog';
import { ClientSearchList } from '@/components/messaging/client-search-list';

type MessageView = 'all' | 'unread' | 'assigned_to_me' | 'unassigned';
type Client = { id: string; name: string };

export default function MessagesPage() {
  const { user, isMessagingUser, isStaffLike, isFamily } = useMessagingRole();
  const isStaff = user?.role === 'staff';
  const { threadId } = useParams<{ threadId?: string }>();
  const [, navigate] = useLocation();
  const urlSearch = useSearch();
  const rawView = new URLSearchParams(urlSearch).get('view');
  const view: MessageView = rawView === 'unread' || (isStaff && (rawView === 'assigned_to_me' || rawView === 'unassigned')) ? rawView : 'all';
  const setView = (v: MessageView) => navigate(`${threadId ? `/messages/${threadId}` : '/messages'}${v === 'all' ? '' : `?view=${v}`}`);
  const counts = useUnreadCount().data;
  const [q, setQ] = useState('');
  const search = useDebounce(q.trim(), 300);
  const [range, setRange] = useState<MessageRange>(DEFAULT_RANGE);
  const [client, setClient] = useState<Client | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [compose, setCompose] = useState<Client | null>(null);

  const params = {
    view,
    ...rangeParams(range),
    ...(search ? { search } : {}),
    ...(client ? { clientId: client.id } : {}),
  };
  const { items, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useThreadList(params, isMessagingUser);
  const reset = () => undefined; // params change resets paging via the query key

  if (!isMessagingUser) {
    return (
      <Card className="mx-auto max-w-xl" data-testid="page-messages">
        <CardHeader><CardTitle>Not authorized</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">You are not authorized to view messages.</CardContent>
      </Card>
    );
  }

  const startNew = () => {
    if (isFamily) {
      if (user?.linkedRecordId) setCompose({ id: user.linkedRecordId, name: '' });
    } else setPicking(true);
  };
  const noFilters = !search && !client && view === 'all' && range.mode === 'recent';

  return (
    <div className="space-y-4" data-testid="page-messages">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Messages</h1>
          <p className="mt-1 text-muted-foreground">Messages are permanent and cannot be edited or deleted.</p>
        </div>
        <Button onClick={startNew} data-testid="button-new-message"><Plus className="mr-2 h-4 w-4" /> New message</Button>
      </div>

      <div className="grid h-[calc(100dvh-14rem)] min-h-[480px] overflow-hidden rounded-lg border bg-card md:grid-cols-[minmax(300px,380px)_1fr]">
        <div className={cn('flex min-h-0 flex-col border-r', threadId && 'hidden md:flex')} data-testid="message-list-pane">
          <div className="space-y-2 border-b p-3">
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Message views">
              {((isStaff ? ['all', 'unread', 'assigned_to_me', 'unassigned'] : ['all', 'unread']) as MessageView[]).map((v) => (
                <Button key={v} size="sm" role="tab" aria-selected={view === v} variant={view === v ? 'default' : 'outline'}
                  onClick={() => { setView(v); reset(); }} data-testid={`tab-messages-${v}`}>
                  {v === 'all' ? 'All' : v === 'unread' ? 'Unread' : v === 'assigned_to_me' ? 'Assigned to me' : 'Unassigned'}
                  {v === 'assigned_to_me' && <span className="ml-1.5 rounded-full bg-primary-foreground/20 px-1.5 text-xs" data-testid="count-assigned-to-me">{counts?.assignedToMeUnread ?? 0}</span>}
                  {v === 'unassigned' && <span className="ml-1.5 rounded-full bg-primary-foreground/20 px-1.5 text-xs" data-testid="count-unassigned">{counts?.unassignedOpen ?? 0}</span>}
                </Button>
              ))}
            </div>
            <Input type="search" value={q} onChange={(e) => { setQ(e.target.value); reset(); }} placeholder="Search messages" aria-label="Search messages" data-testid="input-message-search" />
            {isStaffLike && (
              <div className="flex gap-2">
                <Popover open={filterOpen} onOpenChange={setFilterOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="min-w-0 flex-1 justify-start" data-testid="filter-message-participant">
                      <span className="truncate">{client ? client.name : 'All participants'}</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80" align="start">
                    <ClientSearchList testIdPrefix="filter-participant" onSelect={(c) => { setClient(c); reset(); setFilterOpen(false); }} />
                  </PopoverContent>
                </Popover>
                {client && <Button size="sm" variant="ghost" aria-label="Clear participant filter" onClick={() => { setClient(null); reset(); }}><X className="h-4 w-4" /></Button>}
              </div>
            )}
            <MessageRangeControl value={range} onChange={(r) => { setRange(r); reset(); }} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="space-y-3 p-3" data-testid="messages-loading">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
            ) : isError ? (
              <div className="flex flex-col items-start gap-3 p-4 text-sm text-muted-foreground" data-testid="messages-error">
                Messages could not be loaded.<Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground" data-testid="messages-empty">
                <Inbox className="h-8 w-8" />
                <p>{isFamily ? (noFilters ? 'No messages yet.' : 'No messages match.')
                  : range.mode === 'recent' && !search && !client && view === 'all'
                    ? "No messages in the last 6 months. Check the archive or start a message from a participant's record."
                    : 'No messages match these filters.'}</p>
                {isFamily && <Button size="sm" onClick={startNew}>New message</Button>}
              </div>
            ) : (
              <>
                <MessageThreadRows threads={items} selectedId={threadId} showParticipant={isStaffLike} showAssignee={isStaffLike} />
                {hasNextPage && (
                  <div className="p-3 text-center">
                    <Button variant="outline" size="sm" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage} data-testid="button-load-more-threads">{isFetchingNextPage ? 'Loading...' : 'Load more'}</Button>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="border-t p-2"><MessageRangeCaption range={range} /></div>
        </div>

        <div className={cn('min-h-0 min-w-0', !threadId && 'hidden md:block')}>
          {threadId ? <MessageThreadView key={threadId} threadId={threadId} /> : (
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Select a conversation to read it.</div>
          )}
        </div>
      </div>

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent data-testid="dialog-pick-participant">
          <DialogHeader><DialogTitle>Choose a participant</DialogTitle></DialogHeader>
          <ClientSearchList testIdPrefix="picker-participant" onSelect={(c) => { setPicking(false); setCompose(c); }} />
        </DialogContent>
      </Dialog>
      {compose && (
        <MessageComposeDialog open onOpenChange={(o) => { if (!o) setCompose(null); }} clientId={compose.id} clientName={compose.name || undefined}
          onCreated={(id) => { setCompose(null); navigate(`/messages/${id}`); }} />
      )}
    </div>
  );
}
