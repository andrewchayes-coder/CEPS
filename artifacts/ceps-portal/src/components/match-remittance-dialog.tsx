import { useMemo, useState } from 'react';
import {
  useGetAuthorization,
  useListFees,
  useListPayments,
  useMatchRemittance,
  type Fee,
  type Payment,
  type PaymentAllocation,
  type Remittance,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Link2 } from 'lucide-react';
import { format } from 'date-fns';
import { trackAnalyticsEvent } from '@/lib/analytics';
import { useAuth } from '@/components/auth/auth-provider';

type Target = {
  key: string;
  kind: 'line' | 'fee';
  remaining: number;
  paymentId?: string;
  paymentAllocationId?: string;
  feeId?: string;
  payment?: Payment;
  allocation?: PaymentAllocation;
  fee?: Fee;
};

export function MatchRemittanceDialog({ remittance, onSaved }: { remittance: Remittance; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const [amount, setAmount] = useState(remittance.remainingAmount);
  const { toast } = useToast();
  const { user } = useAuth();
  const canEnterRemittances = user?.role === 'staff' && (user.permissions ?? []).includes('remittance_entry');
  const match = useMatchRemittance();
  const { data: authorization, isLoading: authorizationLoading } = useGetAuthorization(remittance.authorizationId ?? '', {
    query: { enabled: open && !!remittance.authorizationId, queryKey: ['authorization', remittance.authorizationId] },
  });
  const isFeeAuthorization = authorization?.paymentType === 'fee';
  const { data: paymentsData, isLoading: paymentsLoading } = useListPayments({
    clientId: remittance.clientId,
    remitted: false,
    limit: 100,
    ...(remittance.authorizationId && !isFeeAuthorization ? { authorizationId: remittance.authorizationId } : {}),
    ...(remittance.paymentMonth && !isFeeAuthorization ? { paymentMonth: remittance.paymentMonth } : {}),
    ...(search ? { search } : {}),
  }, { query: { enabled: open && !isFeeAuthorization, queryKey: ['eligible-payment-lines', remittance.id, search, isFeeAuthorization] } });
  const { data: feesData, isLoading: feesLoading } = useListFees({
    clientId: remittance.clientId,
    status: 'pending',
    ...(remittance.paymentMonth ? { feeMonth: remittance.paymentMonth } : {}),
  }, { query: { enabled: open, queryKey: ['eligible-remittance-fees', remittance.id] } });
  const remainingRemittance = Number(remittance.remainingAmount);

  const lineTargets = useMemo<Target[]>(() => (paymentsData?.items ?? []).flatMap((payment) =>
    (payment.allocations ?? []).flatMap((allocation) => {
      const remaining = Math.max(0, Number(allocation.amount) - Number(allocation.remittedAmount ?? 0));
      if (remaining <= 0) return [];
      if (remittance.authorizationId && allocation.authorizationId !== remittance.authorizationId) return [];
      if (remittance.paymentMonth && allocation.serviceMonth !== remittance.paymentMonth) return [];
      if (payment.paymentType === 'fee') return [];
      return [{
        key: `line:${allocation.id}`,
        kind: 'line' as const,
        remaining,
        paymentId: payment.id,
        paymentAllocationId: allocation.id,
        payment,
        allocation,
      }];
    }),
  ), [paymentsData, remittance.authorizationId, remittance.paymentMonth]);

  const feeTargets = useMemo<Target[]>(() => (feesData ?? []).flatMap((fee) => {
    if (fee.status !== 'pending') return [];
    if (remittance.paymentMonth && fee.feeMonth !== remittance.paymentMonth) return [];
    if (remittance.authorizationId && fee.authorizationId !== remittance.authorizationId &&
      !(isFeeAuthorization && !fee.authorizationId)) return [];
    const remaining = Math.max(0, Number(fee.amount) - Number(fee.remittedAmount ?? 0));
    if (remaining <= 0) return [];
    return [{ key: `fee:${fee.id}`, kind: 'fee' as const, remaining, feeId: fee.id, fee }];
  }), [feesData, remittance.authorizationId, remittance.paymentMonth, isFeeAuthorization]);

  const targets = isFeeAuthorization
    ? feeTargets
    : remittance.authorizationId
      ? lineTargets
      : lineTargets.length > 0
        ? lineTargets
        : feeTargets;
  const selected = targets.find((target) => target.key === targetKey);
  const isLoading = authorizationLoading || paymentsLoading || feesLoading;
  const close = () => {
    setOpen(false);
    setTargetKey('');
    setSearch('');
    setAmount(remittance.remainingAmount);
  };
  const selectTarget = (target: Target) => {
    setTargetKey(target.key);
    setAmount(Math.min(remainingRemittance, target.remaining).toFixed(2));
  };
  const submit = () => {
    if (!canEnterRemittances) return;
    if (!selected) { toast({ variant: 'destructive', title: 'Target required', description: 'Select an eligible payment line or fee before matching.' }); return; }
    if (!amount || Number(amount) <= 0) { toast({ variant: 'destructive', title: 'Allocation required', description: 'Enter an amount greater than zero.' }); return; }
    match.mutate({
      id: remittance.id,
      data: {
        ...(selected.kind === 'line' ? { paymentAllocationId: selected.paymentAllocationId } : { feeId: selected.feeId }),
        amount,
      },
    }, {
      onSuccess: () => {
        trackAnalyticsEvent('remittance_matched', { source: 'manual' });
        toast({ title: 'Remittance allocated' });
        close();
        onSaved?.();
      },
      onError: (error: unknown) => toast({ variant: 'destructive', title: 'Could not match target', description: (error as { data?: { error?: string } })?.data?.error ?? 'The target may already be fully remitted. Refresh and try again.' }),
    });
  };
  if (!canEnterRemittances) return null;
  return <Dialog open={open} onOpenChange={(next) => next ? setOpen(true) : close()}>
    <DialogTrigger asChild><Button variant="outline" size="sm" data-testid={`button-match-remittance-${remittance.id}`}><Link2 className="mr-1 h-4 w-4" /> Allocate</Button></DialogTrigger>
    <DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>Allocate Remittance</DialogTitle><DialogDescription>Allocate some or all of the ${remainingRemittance.toFixed(2)} remaining remittance balance.</DialogDescription></DialogHeader>
      {!isFeeAuthorization && <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search check or payee" data-testid="input-match-payment-search" />}
      <div className="max-h-80 overflow-y-auto rounded-md border">
        {isLoading ? <p className="p-4 text-sm text-muted-foreground">Loading eligible lines and fees…</p> : targets.length ? targets.map((target) => {
          const isSelected = targetKey === target.key;
          const content = target.kind === 'line'
            ? <>
                <div className="font-medium">Check #{target.payment?.qbCheckNumber} · {target.allocation?.serviceMonth} · Auth {target.allocation?.authNumber ?? '—'}</div>
                <div className="text-muted-foreground">{target.payment?.checkDate ? format(new Date(target.payment.checkDate), 'MMM d, yyyy') : '—'} · {target.payment?.vendorName ?? 'Payee unavailable'} · Line ${Number(target.allocation?.amount ?? 0).toFixed(2)} · ${target.remaining.toFixed(2)} remaining</div>
              </>
            : <>
                <div className="font-medium">Fee · {target.fee?.feeMonth ?? 'Month unavailable'} · Auth {target.fee?.authNumber ?? (target.fee?.feeAuthorizationMissing ? 'Missing authorization' : '—')}</div>
                <div className="text-muted-foreground">${Number(target.fee?.amount ?? 160).toFixed(2)} fee · ${target.remaining.toFixed(2)} remaining</div>
              </>;
          return <button type="button" key={target.key} onClick={() => selectTarget(target)} className={`w-full border-b p-3 text-left text-sm last:border-0 hover:bg-muted ${isSelected ? 'bg-primary/10 ring-1 ring-primary' : ''}`} data-testid={`match-${target.kind}-option-${target.kind === 'line' ? target.paymentAllocationId : target.feeId}`}>
            {content}
          </button>;
        }) : <p className="p-4 text-sm text-muted-foreground">No eligible payment lines or pending fees found for this participant, authorization, and month.</p>}
      </div>
      <div><label className="text-sm font-medium" htmlFor="allocation-amount">Allocation amount</label><Input id="allocation-amount" type="number" min="0.01" step="0.01" max={selected ? Math.min(selected.remaining, remainingRemittance) : remainingRemittance} value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
      <DialogFooter><Button variant="outline" onClick={close}>Cancel</Button><Button onClick={submit} disabled={!selected || match.isPending} data-testid="button-confirm-match-remittance">{match.isPending ? 'Allocating…' : 'Confirm Allocation'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}