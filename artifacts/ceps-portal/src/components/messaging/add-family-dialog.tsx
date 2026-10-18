import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useListMessageRecipients, getListMessageRecipientsQueryKey, addMessageThreadFamilyMembers, getGetMessageThreadQueryKey, type MessageThreadHeader } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { errText, invalidateMessaging } from '@/hooks/use-messaging';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export function AddFamilyDialog({ thread }: { thread: MessageThreadHeader }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: rec, isLoading, isError, refetch } = useListMessageRecipients(thread.clientId, {
    query: { enabled: open, queryKey: [...getListMessageRecipientsQueryKey(thread.clientId), user?.id] },
  });
  // The header exposes names only, so every eligible family portal user is listed.
  // Adding someone already on the thread is idempotent on the server.
  const eligible = rec?.family ?? [];

  const add = async () => {
    setBusy(true); setError(null);
    try {
      const header = await addMessageThreadFamilyMembers(thread.id, { userIds: sel });
      qc.setQueriesData<{ thread: MessageThreadHeader }>({ queryKey: getGetMessageThreadQueryKey(thread.id) }, (old) => (old ? { ...old, thread: header } : old));
      invalidateMessaging(qc);
      setOpen(false); setSel([]);
    } catch (e) { setError(errText(e, 'Could not add family members.')); } finally { setBusy(false); }
  };

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => { setOpen(true); setError(null); }} data-testid="button-add-family-member">
        <UserPlus className="mr-1.5 h-4 w-4" /> Add family member
      </Button>
      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <DialogContent data-testid="dialog-add-family">
          <DialogHeader>
            <DialogTitle>Add family member</DialogTitle>
            <DialogDescription>They will see the whole conversation. Anyone already on the thread is left unchanged.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {isLoading ? <p className="text-sm text-muted-foreground">Loading...</p> : isError ? (
              <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
            ) : eligible.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-eligible-family">No other family portal users are available to add.</p>
            ) : eligible.map((f) => (
              <div key={f.userId} className="flex items-center gap-2">
                <Checkbox id={`add-${f.userId}`} checked={sel.includes(f.userId)} onCheckedChange={(v) => setSel((s) => (v === true ? [...s, f.userId] : s.filter((x) => x !== f.userId)))} data-testid={`checkbox-add-family-${f.userId}`} />
                <Label htmlFor={`add-${f.userId}`} className="font-normal">
                  {f.name} ({f.relationship || 'Self'})
                </Label>
              </div>
            ))}
            {error && <p role="alert" className="text-sm text-destructive" data-testid="error-add-family">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void add()} disabled={busy || sel.length === 0} data-testid="button-confirm-add-family">{busy ? 'Adding...' : 'Add'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
