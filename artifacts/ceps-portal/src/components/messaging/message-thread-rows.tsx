import { Link, useSearch } from 'wouter';
import type { MessageThreadHeader } from '@workspace/api-client-react';
import { formatMessageClock } from '@/lib/datetime';
import { cn } from '@/lib/utils';

export function MessageThreadRows({ threads, selectedId, showParticipant, showAssignee = false }: {
  threads: MessageThreadHeader[]; selectedId?: string; showParticipant: boolean; showAssignee?: boolean;
}) {
  const search = useSearch();
  const qs = search ? `?${search}` : '';
  return (
    <ul className="divide-y" data-testid="list-message-threads">
      {threads.map((t) => (
        <li key={t.id}>
          <Link
            href={`/messages/${t.id}${qs}`}
            aria-current={t.id === selectedId ? 'true' : undefined}
            data-testid={`message-thread-${t.id}`}
            data-unread={t.unread ? 'true' : 'false'}
            className={cn(
              'flex gap-3 px-3 py-3 text-sm transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              t.id === selectedId && 'bg-secondary',
            )}
          >
            <span className="mt-1.5 w-2 shrink-0">
              {t.unread && <span className="block h-2 w-2 rounded-full bg-primary" aria-label="Unread" data-testid={`unread-dot-${t.id}`} />}
            </span>
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="flex items-baseline justify-between gap-2">
                <span className={cn('truncate', t.unread ? 'font-semibold' : 'font-medium')}>
                  {showParticipant ? t.clientName : t.subject}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatMessageClock(t.lastMessageAt)}</span>
              </span>
              {t.resolvedAt != null && (
                <span className="inline-block rounded-full border bg-secondary px-2 py-0.5 text-xs font-medium" data-testid={`badge-thread-resolved-${t.id}`}>Resolved</span>
              )}
              {showParticipant && <span className={cn('block truncate', t.unread && 'font-semibold')}>{t.subject}</span>}
              <span className="block truncate text-muted-foreground">
                {t.lastMessageByName ? `${t.lastMessageByName}: ` : ''}{t.lastMessagePreview}
              </span>
              {showAssignee && (
                <span className={cn('block truncate text-xs', t.assignee ? 'text-foreground' : 'text-muted-foreground/70 italic')} data-testid={`text-row-assignee-${t.id}`}>
                  {t.assignee ? `Assigned to ${t.assignee.name}` : 'Unassigned'}
                </span>
              )}
              <span className="block text-xs text-muted-foreground">{t.messageCount} {t.messageCount === 1 ? 'message' : 'messages'}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
