import { ProtectedData } from '@/components/protected-data';
import { useState } from 'react';
import { useListClients } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { useDebounce } from '@/hooks/use-debounce';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

/** Searchable participant list; server scopes coordinators to their caseload. */
export function ClientSearchList({ onSelect, testIdPrefix }: { onSelect: (c: { id: string; name: string }) => void; testIdPrefix: string }) {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const search = useDebounce(q.trim(), 300);
  const params = { limit: 20, ...(search ? { search } : {}) };
  const { data, isLoading, isError, refetch } = useListClients(params, { query: { queryKey: ['message-client-search', user?.id, params] } });
  return (
    <div className="space-y-2">
      <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search participants" aria-label="Search participants" data-testid={`${testIdPrefix}-search`} />
      <div className="max-h-64 overflow-y-auto rounded-md border" role="listbox" aria-label="Participants">
        {isLoading ? (
          <div className="space-y-2 p-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
        ) : isError ? (
          <button type="button" className="w-full p-3 text-left text-sm text-muted-foreground" onClick={() => void refetch()}>Could not load participants. Retry</button>
        ) : (data?.items ?? []).length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No participants found.</p>
        ) : (
          (data?.items ?? []).map((c) => (
            <button
              key={c.id} type="button" role="option" aria-selected={false}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none"
              onClick={() => onSelect({ id: c.id, name: `${c.firstName} ${c.lastName}` })}
              data-testid={`${testIdPrefix}-option-${c.id}`}
            >
              <ProtectedData>{c.firstName} {c.lastName}</ProtectedData>
              <span className="ml-2 font-mono text-xs text-muted-foreground">{c.uciNumber}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
