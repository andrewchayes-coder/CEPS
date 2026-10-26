import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListAssignableMessageStaff, useAssignMessageThread, getGetMessageThreadQueryKey,
  type MessageThreadDetail, type MessageThreadHeader,
} from '@workspace/api-client-react';
import { errText, invalidateMessaging } from '@/hooks/use-messaging';
import { formatPacific } from '@/lib/datetime';
import { Button } from '@/components/ui/button';

const NONE = '';

export function ThreadAssignment({ thread, qk, currentUserId, canAssignOthers }: {
  thread: MessageThreadHeader; qk: readonly unknown[]; currentUserId: string; canAssignOthers: boolean;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const staff = useListAssignableMessageStaff({ query: {
    queryKey: ['/api/messages/assignable-staff', currentUserId, canAssignOthers], enabled: canAssignOthers,
  } });
  const assign = useAssignMessageThread();
  const people = staff.data ?? [];
  const current = thread.assignee?.userId ?? NONE;
  const pending = assign.isPending;

  const run = (assigneeUserId: string | null) => {
    if (assign.isPending) return;
    setError(null);
    assign.mutate({ threadId: thread.id, data: { assigneeUserId } }, {
      onSuccess: (header) => {
        qc.setQueriesData<MessageThreadDetail>({ queryKey: getGetMessageThreadQueryKey(thread.id) }, (old) => old ? { ...old, thread: { ...old.thread, ...header } } : old);
        qc.setQueryData<MessageThreadDetail>(qk, (old) => old ? { ...old, thread: { ...old.thread, ...header } } : old);
        invalidateMessaging(qc);
      },
      onError: (e) => setError(errText(e, 'Could not change the assignee. Please try again.')),
    });
  };

  const unavailableOwner = thread.assignee && !people.some((p) => p.userId === thread.assignee!.userId);

  return (
    <div className="space-y-1" data-testid="thread-assignment">
      <div className="flex flex-wrap items-center gap-2">
        {canAssignOthers ? <>
        <label htmlFor="select-thread-assignee" className="text-sm text-muted-foreground">Assigned to</label>
        <select id="select-thread-assignee" data-testid="select-thread-assignee" value={current} disabled={pending || staff.isLoading || staff.isError}
          onChange={(e) => run(e.target.value === NONE ? null : e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <option value={NONE}>Unassigned</option>
          {unavailableOwner && <option value={current} disabled>{thread.assignee!.name} (unavailable)</option>}
          {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
        </select>
        {current !== currentUserId && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(currentUserId)} data-testid="button-assign-to-me">Assign to me</Button>
        )}
        </> : current === NONE ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(currentUserId)} data-testid="button-claim-thread">Claim</Button>
        ) : current === currentUserId ? (
          <>
            <span className="text-sm">Assigned to {thread.assignee!.name}</span>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(null)} data-testid="button-release-thread">Release</Button>
          </>
        ) : <span className="text-sm" data-testid="text-thread-owner">Assigned to {thread.assignee!.name}</span>}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="text-thread-assignment">
        {thread.assignee
          ? thread.assignedBy ? `Assigned by ${thread.assignedBy.name}${thread.assignedAt ? `, ${formatPacific(thread.assignedAt)}` : ''}` : `Assigned to ${thread.assignee.name}`
          : 'Unassigned'}
      </p>
      {canAssignOthers && staff.isError && <p role="alert" className="text-xs text-destructive">Staff could not be loaded. <Button variant="link" size="sm" onClick={() => void staff.refetch()}>Retry</Button></p>}
      {error && <p role="alert" className="text-xs text-destructive" data-testid="error-assignment">{error}</p>}
    </div>
  );
}
