import { useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useFlagForReview, useResolveReviewFlag, type BillingStatus, type ReviewFlag } from '@workspace/api-client-react';
import { Flag, FlagOff, ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ProtectedData } from '@/components/protected-data';
import { formatDate, formatDateTime } from '@/lib/dates';
import { useToast } from '@/hooks/use-toast';

export const BILLING_STATUS_PRESENTATION: Record<BillingStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'border-slate-400/60 bg-slate-500/10 text-slate-700 dark:text-slate-300' },
  billed: { label: 'Billed', className: 'border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  partially_paid: { label: 'Partially paid', className: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  paid: { label: 'Paid', className: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  waived: { label: 'Waived', className: 'border-border bg-muted/50 text-muted-foreground' },
};

/** Backwards-compatible fallback only used when the API omits billingStatus. */
export function fallbackLineStatus(remitted?: string | null, legacyRemitted = false, billedAt?: string | null): BillingStatus {
  if (remitted === 'full' || (!remitted && legacyRemitted)) return 'paid';
  if (remitted === 'partial') return 'partially_paid';
  return billedAt ? 'billed' : 'pending';
}
export function fallbackFeeStatus(status: string, remittedAmount?: string | null, billedAt?: string | null): BillingStatus {
  if (status === 'waived') return 'waived';
  if (status === 'collected') return 'paid';
  if (Number(remittedAmount ?? 0) > 0) return 'partially_paid';
  if (status === 'invoiced' || billedAt) return 'billed';
  return 'pending';
}

const money = (v?: string | null) => `$${Number(v ?? 0).toFixed(2)}`;

export function BillingStatusCell({
  testId, status, remittedAmount, amount, billedAt, billedAmount, invoiceNumber, flag, billingCount,
}: {
  billingCount?: number | null;
  testId: string;
  status: BillingStatus;
  remittedAmount?: string | null;
  amount?: string | null;
  billedAt?: string | null;
  billedAmount?: string | null;
  invoiceNumber?: string | null;
  flag?: ReviewFlag | null;
}) {
  const p = BILLING_STATUS_PRESENTATION[status] ?? BILLING_STATUS_PRESENTATION.pending;
  const hasDetails = !!(billedAt || billedAmount || invoiceNumber);
  return (
    <div className="flex min-w-[130px] flex-col items-start gap-1" data-testid={testId}>
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className={`justify-center ${p.className}`} data-testid={`${testId}-badge`} data-billing-status={status}>{p.label}</Badge>
        {hasDetails && (
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center rounded p-0.5 text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-label="Billing details" data-testid={`${testId}-details`}>
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64 text-sm" align="start">
              <p className="mb-2 font-medium">Billing details</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">Billed on</dt><dd><ProtectedData>{billedAt ? formatDate(billedAt) : '-'}</ProtectedData></dd>
                <dt className="text-muted-foreground">Invoice #</dt><dd><ProtectedData>{invoiceNumber || '-'}</ProtectedData></dd>
                <dt className="text-muted-foreground">Billed amount</dt><dd><ProtectedData>{billedAmount ? money(billedAmount) : '-'}</ProtectedData></dd>
              </dl>
              {(billingCount ?? 0) > 1 && <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300" data-testid={`${testId}-billing-count`}>Billed <ProtectedData>{billingCount}</ProtectedData> times (re-billed)</p>}
            </PopoverContent>
          </Popover>
        )}
      </div>
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        Remitted <ProtectedData>{money(remittedAmount)}</ProtectedData>{amount != null && <> of <ProtectedData>{money(amount)}</ProtectedData></>}
      </span>
      {flag && !flag.resolvedAt && (
        <span className="flex max-w-[220px] items-start gap-1 text-xs font-medium text-destructive" data-testid={`${testId}-flag`}>
          <Flag className="mt-0.5 h-3 w-3 shrink-0 fill-current" aria-hidden />
          <span><span className="sr-only">Flagged for review: </span><ProtectedData>{flag.reason}</ProtectedData></span>
        </span>
      )}
    </div>
  );
}

export function invalidateBillingQueries(qc: QueryClient) {
  return qc.invalidateQueries({
    predicate: (q) => {
      const k = String(q.queryKey[0] ?? '');
      return k.startsWith('/api/payments') || k.startsWith('/api/fees') || k.startsWith('/api/reports') || k.startsWith('/api/billing')
        || ['clientCase', 'fees', 'payments', 'billingReport'].includes(k) || /report/i.test(k);
    },
  });
}

export function ReviewFlagAction({ targetType, targetId, flag, testId }: { targetType: 'payment_line' | 'fee'; targetId: string; flag?: ReviewFlag | null; testId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const qc = useQueryClient();
  const { toast } = useToast();
  const flagMut = useFlagForReview();
  const resolveMut = useResolveReviewFlag();
  const isOpenFlag = !!flag && !flag.resolvedAt;
  const pending = flagMut.isPending || resolveMut.isPending;

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    const done = {
      onSuccess: () => { void invalidateBillingQueries(qc); setOpen(false); setText(''); toast({ title: isOpenFlag ? 'Flag resolved' : 'Flagged for review' }); },
      onError: (e: unknown) => toast({ variant: 'destructive', title: 'Could not save', description: (e as { message?: string })?.message ?? 'Please try again.' }),
    };
    if (isOpenFlag) resolveMut.mutate({ id: flag!.id, data: { note: value } }, done);
    else flagMut.mutate({ data: { targetType, targetId, reason: value } }, done);
  };

  return (
    <>
      <Button variant="ghost" size="sm" className={isOpenFlag ? 'text-destructive' : ''} onClick={() => setOpen(true)} data-testid={testId}>
        {isOpenFlag ? <FlagOff className="mr-1 h-4 w-4" /> : <Flag className="mr-1 h-4 w-4" />}
        {isOpenFlag ? 'Resolve' : 'Flag'}
      </Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setText(''); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isOpenFlag ? 'Resolve review flag' : 'Flag for review'}</DialogTitle>
            <DialogDescription>
              {isOpenFlag ? 'Record how this item was resolved. The note is kept with the flag history.' : 'Explain what needs attention. The flag stays visible until resolved.'}
            </DialogDescription>
          </DialogHeader>
          {isOpenFlag && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-medium text-destructive"><ProtectedData>{flag!.reason}</ProtectedData></p>
              <p className="mt-1 text-xs text-muted-foreground">
                Flagged by <ProtectedData>{flag!.flaggedByName ?? flag!.flaggedBy}</ProtectedData> on <ProtectedData>{formatDateTime(flag!.flaggedAt)}</ProtectedData>
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`${testId}-text`}>{isOpenFlag ? 'Resolution note' : 'Reason'}</Label>
            <Textarea id={`${testId}-text`} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} data-testid={`${testId}-input`} />
            <p className="text-right text-xs text-muted-foreground">{text.length}/500</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!text.trim() || pending} data-testid={`${testId}-submit`}>
              {pending ? 'Saving...' : isOpenFlag ? 'Resolve flag' : 'Flag for review'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
