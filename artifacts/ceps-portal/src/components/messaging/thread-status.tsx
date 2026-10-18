import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useSetMessageThreadStatus, getGetMessageThreadQueryKey,
  type MessageThreadDetail, type MessageThreadHeader,
} from '@workspace/api-client-react';
import { errText, invalidateMessaging } from '@/hooks/use-messaging';
import { formatPacific } from '@/lib/datetime';
import { Button } from '@/components/ui/button';

export function ThreadStatus({ thread, qk, canChange }: { thread: MessageThreadHeader; qk: readonly unknown[]; canChange: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const setStatus = useSetMessageThreadStatus();
  const resolved = thread.resolvedAt != null;

  const run = () => {
    if (setStatus.isPending) return;
    setError(null);
    setStatus.mutate({ threadId: thread.id, data: { status: resolved ? 'open' : 'resolved' } }, {
      onSuccess: (header) => {
        const patch = (old: MessageThreadDetail | undefined) => old
          ? { ...old, thread: { ...old.thread, resolvedAt: header.resolvedAt ?? null, resolvedBy: header.resolvedBy ?? null } } : old;
        qc.setQueriesData<MessageThreadDetail>({ queryKey: getGetMessageThreadQueryKey(thread.id) }, patch);
        qc.setQueryData<MessageThreadDetail>(qk, patch);
        invalidateMessaging(qc);
      },
      onError: (e) => setError(errText(e, 'Could not change the status. Please try again.')),
    });
  };

  return (
    <div className="space-y-1" data-testid="thread-status">
      <div className="flex flex-wrap items-center gap-2">
        {resolved && <span className="rounded-full border bg-secondary px-2 py-0.5 text-xs font-medium" data-testid="badge-thread-status-resolved">Resolved</span>}
        {canChange && (
          <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={run} data-testid="button-thread-status">
            {resolved ? 'Reopen' : 'Mark resolved'}
          </Button>
        )}
      </div>
      {resolved && (thread.resolvedBy || thread.resolvedAt) && (
        <p className="text-xs text-muted-foreground" data-testid="text-thread-resolved-meta">
          {thread.resolvedBy ? `Resolved by ${thread.resolvedBy.name}` : 'Resolved'}{thread.resolvedAt ? `, ${formatPacific(thread.resolvedAt)}` : ''}
        </p>
      )}
      {error && <p role="alert" className="text-xs text-destructive" data-testid="error-thread-status">{error}</p>}
    </div>
  );
}
