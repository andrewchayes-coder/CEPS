import { useState } from 'react';
import { useLocation, Link } from 'wouter';
import { MessageSquare } from 'lucide-react';
import { useMessagingRole, useClientThreadList, useUnreadCount } from '@/hooks/use-messaging';
import { useDebounce } from '@/hooks/use-debounce';
import { rangeParams, unreadBadgeLabel, DEFAULT_RANGE, type MessageRange } from '@/lib/messaging';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageRangeControl, MessageRangeCaption } from './message-range-control';
import { MessageThreadRows } from './message-thread-rows';
import { MessageComposeDialog } from './message-compose-dialog';

export function ParticipantMessagesCard({ clientId, clientName, assignedCoordinatorId }: { clientId: string; clientName: string; assignedCoordinatorId?: string | null }) {
  const { user, isFamily } = useMessagingRole();
  if (!user) return null;
  if (isFamily) return user.linkedRecordId === clientId ? <FamilyCard /> : null;
  if (user.role === 'staff' || (user.role === 'service_coordinator' && user.id === assignedCoordinatorId)) {
    return <StaffCard clientId={clientId} clientName={clientName} />;
  }
  return null;
}

function FamilyCard() {
  const { data } = useUnreadCount();
  const label = unreadBadgeLabel(data?.count);
  return (
    <Card data-testid="card-participant-messages">
      <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-lg"><MessageSquare className="h-5 w-5 text-primary" /> Messages with CEPS</CardTitle></CardHeader>
      <CardContent className="flex items-center justify-between gap-3 text-sm">
        <span data-testid="text-family-unread">{label ? `${label} unread` : 'No unread messages'}</span>
        <Button asChild size="sm" variant="outline"><Link href="/messages" data-testid="link-open-messages">Open Messages</Link></Button>
      </CardContent>
    </Card>
  );
}

function StaffCard({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [, navigate] = useLocation();
  const [range, setRange] = useState<MessageRange>(DEFAULT_RANGE);
  const [q, setQ] = useState('');
  const search = useDebounce(q.trim(), 300);
  const [composing, setComposing] = useState(false);
  const params = { limit: 50, ...rangeParams(range), ...(search ? { search } : {}) };
  const { data, isLoading, isError, refetch } = useClientThreadList(clientId, params, true);
  return (
    <Card data-testid="card-participant-messages">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-lg"><MessageSquare className="h-5 w-5 text-primary" /> Messages</CardTitle>
          <Button size="sm" onClick={() => setComposing(true)} data-testid="button-new-message">New message</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages" aria-label="Search this participant's messages" data-testid="input-participant-message-search" />
          <MessageRangeControl value={range} onChange={setRange} />
        </div>
        <MessageRangeCaption range={range} />
        <div className="overflow-hidden rounded-md border">
          {isLoading ? <div className="space-y-2 p-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
            : isError ? <div className="flex items-center gap-3 p-3 text-sm text-muted-foreground">Messages could not be loaded.<Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button></div>
            : (data?.items ?? []).length === 0 ? <p className="p-4 text-center text-sm text-muted-foreground" data-testid="participant-messages-empty">No messages found.</p>
            : <MessageThreadRows threads={data!.items} showParticipant={false} showAssignee />}
        </div>
        {data && data.total > data.items.length && <p className="text-xs text-muted-foreground">Showing {data.items.length} of {data.total}. Open Messages for the full inbox.</p>}
      </CardContent>
      <MessageComposeDialog open={composing} onOpenChange={setComposing} clientId={clientId} clientName={clientName} onCreated={(id) => navigate(`/messages/${id}`)} />
    </Card>
  );
}
