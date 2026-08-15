import React, { useState } from 'react';
import {
  useCreatePayment,
  useListClients,
  useListVendors,
  useListInvoices,
  useListAuthorizations,
  type PaymentInput,
  type DuplicatePaymentError,
  type Payment,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Plus, AlertTriangle } from 'lucide-react';

const PAYMENT_TYPES = ['direct_payment', 'reimbursement', 'fee'];

type Props = {
  onSaved?: () => void;
  defaultClientId?: string;
};

const emptyForm = {
  clientId: '',
  qbCheckNumber: '',
  checkDate: '',
  amount: '',
  paymentMonth: '',
  paymentType: 'direct_payment',
  vendorId: 'none',
  invoiceId: 'none',
  authorizationId: 'none',
};

// The customFetch layer throws an ApiError carrying { status, data }. We read
// the 409 duplicate-payment payload off that shape without importing the class.
function asDuplicateError(err: unknown): DuplicatePaymentError | null {
  const e = err as { status?: number; data?: DuplicatePaymentError };
  if (e && e.status === 409 && e.data && e.data.code === 'duplicate_payment') {
    return e.data;
  }
  return null;
}

export function LogPaymentDialog({ onSaved, defaultClientId }: Props) {
  const { toast } = useToast();
  const createPayment = useCreatePayment();
  const { data: clientsData } = useListClients({ limit: 1000 });
  const { data: vendorsData } = useListVendors({ limit: 1000 });
  const { data: invoicesData } = useListInvoices({ limit: 1000 });
  const { data: authorizationsData } = useListAuthorizations({ limit: 1000 });
  const clients = clientsData?.items;
  const vendors = vendorsData?.items;
  const invoices = invoicesData?.items;
  const authorizations = authorizationsData?.items;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm, clientId: defaultClientId ?? '' });
  // Duplicate-payment hard stop state: the blocking payment(s), plus the
  // written justification the user must supply to override.
  const [duplicate, setDuplicate] = useState<Payment[] | null>(null);
  const [justification, setJustification] = useState('');

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const reset = () => {
    setForm({ ...emptyForm, clientId: defaultClientId ?? '' });
    setDuplicate(null);
    setJustification('');
  };

  const submit = (override: boolean) => {
    if (!form.clientId) {
      toast({ variant: 'destructive', title: 'Client required', description: 'Choose a client for this payment.' });
      return;
    }
    if (override && justification.trim() === '') {
      toast({ variant: 'destructive', title: 'Justification required', description: 'Enter a written justification to override the duplicate-payment stop.' });
      return;
    }
    const data: PaymentInput = {
      clientId: form.clientId,
      qbCheckNumber: form.qbCheckNumber,
      checkDate: form.checkDate,
      amount: form.amount,
      paymentMonth: form.paymentMonth === '' ? undefined : form.paymentMonth,
      paymentType: form.paymentType as PaymentInput['paymentType'],
      vendorId: form.vendorId === 'none' ? null : form.vendorId,
      invoiceId: form.invoiceId === 'none' ? null : form.invoiceId,
      authorizationId: form.authorizationId === 'none' ? null : form.authorizationId,
      ...(override ? { overrideDuplicate: true, overrideJustification: justification.trim() } : {}),
    };
    createPayment.mutate(
      { data },
      {
        onSuccess: () => {
          toast({ title: override ? 'Payment logged (duplicate overridden)' : 'Payment logged' });
          setOpen(false);
          reset();
          onSaved?.();
        },
        onError: (err: unknown) => {
          const dup = asDuplicateError(err);
          if (dup) {
            // Not a generic error — surface the blocking payment(s) as an inline
            // warning with an override-with-justification path.
            setDuplicate(dup.existingPayments);
            return;
          }
          toast({ variant: 'destructive', title: 'Error', description: 'Could not log the payment.' });
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button data-testid="button-log-payment">
          <Plus className="w-4 h-4 mr-2" /> Log Payment
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Log Payment</DialogTitle>
          <DialogDescription>Manually record a check/payment.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-2 col-span-2">
            <Label>Client</Label>
            <Select value={form.clientId} onValueChange={(v) => set('clientId', v)}>
              <SelectTrigger data-testid="select-payment-client-id"><SelectValue placeholder="Select a client" /></SelectTrigger>
              <SelectContent>
                {clients?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{`${c.firstName} ${c.lastName}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Check #</Label>
            <Input value={form.qbCheckNumber} onChange={(e) => set('qbCheckNumber', e.target.value)} data-testid="input-payment-check-number" />
          </div>
          <div className="space-y-2">
            <Label>Payment Date</Label>
            <Input type="date" value={form.checkDate} onChange={(e) => set('checkDate', e.target.value)} data-testid="input-payment-date" />
          </div>
          <div className="space-y-2">
            <Label>Amount</Label>
            <Input value={form.amount} onChange={(e) => set('amount', e.target.value)} data-testid="input-payment-amount" />
          </div>
          <div className="space-y-2">
            <Label>Payment Month</Label>
            <Input placeholder="YYYY-MM" value={form.paymentMonth} onChange={(e) => set('paymentMonth', e.target.value)} data-testid="input-payment-month" />
          </div>
          <div className="space-y-2">
            <Label>Payment Type</Label>
            <Select value={form.paymentType} onValueChange={(v) => set('paymentType', v)}>
              <SelectTrigger data-testid="select-payment-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAYMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="capitalize">{t.replace(/_/g, ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Vendor</Label>
            <Select value={form.vendorId} onValueChange={(v) => set('vendorId', v)}>
              <SelectTrigger data-testid="select-payment-vendor-id"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {vendors?.map((v) => (
                  <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Invoice</Label>
            <Select value={form.invoiceId} onValueChange={(v) => set('invoiceId', v)}>
              <SelectTrigger data-testid="select-payment-invoice-id"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {invoices?.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {`${i.clientName ?? 'Unknown'} – ${i.serviceMonth} – $${parseFloat(i.amountRequested).toFixed(2)}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Authorization</Label>
            <Select value={form.authorizationId} onValueChange={(v) => set('authorizationId', v)}>
              <SelectTrigger data-testid="select-payment-authorization-id"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {authorizations?.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {`${a.authNumber} – ${a.clientName ?? 'Unknown'}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {duplicate && (
          <div
            className="rounded-md border border-amber-300 bg-amber-50 p-4 space-y-3"
            data-testid="warning-duplicate-payment"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium text-amber-900">Duplicate payment — hard stop</p>
                <p className="text-sm text-amber-800">
                  A payment already exists for this client, authorization, and month. This is a hard
                  stop. To proceed you must enter a written justification and confirm the override.
                </p>
              </div>
            </div>
            <ul className="text-sm text-amber-900 space-y-1 pl-7 list-disc">
              {duplicate.map((p) => (
                <li key={p.id} data-testid={`text-existing-payment-${p.id}`}>
                  {`Check ${p.qbCheckNumber} — $${parseFloat(p.amount).toFixed(2)}${p.paymentMonth ? ` (${p.paymentMonth})` : ''}`}
                </li>
              ))}
            </ul>
            <div className="space-y-2 pl-7">
              <Label htmlFor="override-justification">Override justification</Label>
              <Textarea
                id="override-justification"
                placeholder="Explain why this apparent duplicate should still be logged…"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                data-testid="input-override-justification"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          {duplicate ? (
            <Button
              variant="destructive"
              onClick={() => submit(true)}
              disabled={createPayment.isPending || justification.trim() === ''}
              data-testid="button-confirm-override"
            >
              {createPayment.isPending ? 'Saving…' : 'Override & Log Payment'}
            </Button>
          ) : (
            <Button
              onClick={() => submit(false)}
              disabled={createPayment.isPending}
              data-testid="button-save-payment"
            >
              {createPayment.isPending ? 'Saving…' : 'Log Payment'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
