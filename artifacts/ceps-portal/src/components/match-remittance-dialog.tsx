import { useState } from 'react';
import { useListPayments, useMatchRemittance, type Remittance } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Link2 } from 'lucide-react';
import { format } from 'date-fns';
import { trackAnalyticsEvent } from '@/lib/analytics';

export function MatchRemittanceDialog({ remittance, onSaved }: { remittance: Remittance; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [amount, setAmount] = useState(remittance.remainingAmount);
  const { toast } = useToast();
  const match = useMatchRemittance();
  const { data, isLoading } = useListPayments({
    clientId: remittance.clientId, remitted: false, limit: 100,
    ...(remittance.authorizationId ? { authorizationId: remittance.authorizationId } : {}),
    ...(remittance.paymentMonth ? { paymentMonth: remittance.paymentMonth } : {}),
    ...(search ? { search } : {}),
  }, { query: { enabled: open, queryKey: ['eligible-payments', remittance.id, search] } });
  const eligiblePayments = data?.items?.filter((payment) => Number(payment.remainingAmount) > 0) ?? [];
  const selected = eligiblePayments.find((payment) => payment.id === paymentId);
  const close = () => { setOpen(false); setPaymentId(''); setSearch(''); setAmount(remittance.remainingAmount); };
  const submit = () => {
    if (!paymentId) { toast({ variant: 'destructive', title: 'Payment required', description: 'Select an eligible payment before matching.' }); return; }
    if (!amount || Number(amount) <= 0) { toast({ variant: 'destructive', title: 'Allocation required', description: 'Enter an amount greater than zero.' }); return; }
    match.mutate({ id: remittance.id, data: { paymentId, amount } }, {
      onSuccess: () => {
        trackAnalyticsEvent('remittance_matched', { source: 'manual' });
        toast({ title: 'Remittance allocated' });
        close();
        onSaved?.();
      },
      onError: (error: unknown) => toast({ variant: 'destructive', title: 'Could not match payment', description: (error as { data?: { error?: string } })?.data?.error ?? 'The payment may already be remitted. Refresh and try again.' }),
    });
  };
  return <Dialog open={open} onOpenChange={(next) => next ? setOpen(true) : close()}>
    <DialogTrigger asChild><Button variant="outline" size="sm" data-testid={`button-match-remittance-${remittance.id}`}><Link2 className="mr-1 h-4 w-4" /> Allocate</Button></DialogTrigger>
    <DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Allocate Remittance</DialogTitle><DialogDescription>Allocate some or all of the ${Number(remittance.remainingAmount).toFixed(2)} remaining remittance balance.</DialogDescription></DialogHeader>
      <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search check or payment reference" data-testid="input-match-payment-search" />
      <div className="max-h-72 overflow-y-auto rounded-md border">
        {isLoading ? <p className="p-4 text-sm text-muted-foreground">Loading eligible payments…</p> : eligiblePayments.length ? eligiblePayments.map((payment) => <button type="button" key={payment.id} onClick={() => setPaymentId(payment.id)} className={`w-full border-b p-3 text-left text-sm last:border-0 hover:bg-muted ${paymentId === payment.id ? 'bg-primary/10 ring-1 ring-primary' : ''}`} data-testid={`match-payment-option-${payment.id}`}>
          <div className="font-medium">{payment.clientName ?? 'Participant'} · Auth {payment.authNumber ?? '—'} · {payment.paymentMonth ?? '—'}</div><div className="text-muted-foreground">Check/reference {payment.qbCheckNumber} · {format(new Date(payment.checkDate), 'MMM d, yyyy')} · ${Number(payment.remainingAmount).toFixed(2)} remaining</div>
        </button>) : <p className="p-4 text-sm text-muted-foreground">No eligible unmatched payments found.</p>}
      </div>
      <div><label className="text-sm font-medium" htmlFor="allocation-amount">Allocation amount</label><Input id="allocation-amount" type="number" min="0.01" step="0.01" max={selected ? Math.min(Number(selected.remainingAmount), Number(remittance.remainingAmount)) : Number(remittance.remainingAmount)} value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
      <DialogFooter><Button variant="outline" onClick={close}>Cancel</Button><Button onClick={submit} disabled={!selected || match.isPending} data-testid="button-confirm-match-remittance">{match.isPending ? 'Allocating…' : 'Confirm Allocation'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}