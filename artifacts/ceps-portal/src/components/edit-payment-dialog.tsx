import React, { useState } from 'react';
import { useUpdatePayment, useListVendors, useListInvoices, useListAuthorizations } from '@workspace/api-client-react';
import type { PaymentUpdate } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { Pencil } from 'lucide-react';
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';

const PAYMENT_TYPES = ['direct_payment', 'reimbursement', 'fee'];

type PaymentLike = {
  clientId: string;
  qbCheckNumber: string;
  checkDate: string;
  amount: string;
  paymentMonth?: string | null;
  paymentType: string;
  vendorId?: string | null;
  vendorName?: string | null;
  invoiceId?: string | null;
  authorizationId?: string | null;
  authNumber?: string | null;
};

type Props = {
  id: string;
  payment: PaymentLike;
  onSaved?: () => void;
};

export function EditPaymentDialog({ id, payment, onSaved }: Props) {
  const { toast } = useToast();
  const updatePayment = useUpdatePayment();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    qbCheckNumber: payment.qbCheckNumber,
    checkDate: payment.checkDate?.slice(0, 10) ?? '',
    amount: payment.amount,
    paymentMonth: payment.paymentMonth ?? '',
    paymentType: payment.paymentType,
    vendorId: payment.vendorId ?? 'none',
    invoiceId: payment.invoiceId ?? 'none',
    authorizationId: payment.authorizationId ?? 'none',
  });

  const [vendorSearch, setVendorSearch] = useState('');
  const debouncedVendorSearch = useDebounce(vendorSearch, 300);
  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors(
    { clientId: payment.clientId, search: debouncedVendorSearch, limit: 50 },
    { query: { enabled: open && !!payment.clientId, queryKey: ['vendors', { clientId: payment.clientId, search: debouncedVendorSearch, limit: 50 }] } }
  );
  const vendors = vendorsData?.items ?? [];

  const [invoiceSearch, setInvoiceSearch] = useState('');
  const debouncedInvoiceSearch = useDebounce(invoiceSearch, 300);
  const { data: invoicesData, isLoading: invoicesLoading } = useListInvoices(
    { clientId: payment.clientId, search: debouncedInvoiceSearch, limit: 50 },
    { query: { enabled: open && !!payment.clientId, queryKey: ['invoices', { clientId: payment.clientId, search: debouncedInvoiceSearch, limit: 50 }] } }
  );
  const invoices = invoicesData?.items ?? [];

  const [authSearch, setAuthSearch] = useState('');
  const debouncedAuthSearch = useDebounce(authSearch, 300);
  const { data: authorizationsData, isLoading: authorizationsLoading } = useListAuthorizations(
    { clientId: payment.clientId, search: debouncedAuthSearch, limit: 50 },
    { query: { enabled: open && !!payment.clientId, queryKey: ['authorizations', { clientId: payment.clientId, search: debouncedAuthSearch, limit: 50 }] } }
  );
  const authorizations = authorizationsData?.items ?? [];

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    const data: PaymentUpdate = {
      qbCheckNumber: form.qbCheckNumber,
      checkDate: form.checkDate || undefined,
      amount: form.amount,
      paymentMonth: form.paymentMonth === '' ? null : form.paymentMonth,
      paymentType: form.paymentType as PaymentUpdate['paymentType'],
      vendorId: form.vendorId === 'none' ? null : form.vendorId,
      invoiceId: form.invoiceId === 'none' ? null : form.invoiceId,
      authorizationId: form.authorizationId === 'none' ? null : form.authorizationId,
    };
    updatePayment.mutate(
      { id, data },
      {
        onSuccess: () => {
          toast({ title: 'Payment updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not update payment.' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="button-edit-payment">
          <Pencil className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Payment</DialogTitle>
          <DialogDescription>Update the payment details.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
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
            <SearchableSelect
              value={form.vendorId}
              onValueChange={(v) => set('vendorId', v)}
              options={vendors.map((v) => ({ value: v.id, label: v.name }))}
              onSearchChange={setVendorSearch}
              loading={vendorsLoading}
              placeholder="Select vendor"
              selectedLabelFallback={payment.vendorName ?? undefined}
              allowClear
              clearLabel="None"
              data-testid="select-payment-vendor-id"
            />
          </div>
          <div className="space-y-2">
            <Label>Invoice</Label>
            <SearchableSelect
              value={form.invoiceId}
              onValueChange={(v) => set('invoiceId', v)}
              options={invoices.map((i) => ({
                value: i.id,
                label: `${i.serviceMonth} – $${parseFloat(i.amountRequested).toFixed(2)}`
              }))}
              onSearchChange={setInvoiceSearch}
              loading={invoicesLoading}
              placeholder="Select invoice"
              allowClear
              clearLabel="None"
              data-testid="select-payment-invoice-id"
            />
          </div>
          <div className="space-y-2">
            <Label>Authorization</Label>
            <SearchableSelect
              value={form.authorizationId}
              onValueChange={(v) => set('authorizationId', v)}
              options={authorizations.map((a) => ({
                value: a.id,
                label: a.authNumber,
                subtitle: a.activityDescription ?? undefined
              }))}
              onSearchChange={setAuthSearch}
              loading={authorizationsLoading}
              placeholder="Select authorization"
              selectedLabelFallback={payment.authNumber ?? undefined}
              allowClear
              clearLabel="None"
              data-testid="select-payment-authorization-id"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updatePayment.isPending} data-testid="button-save-payment">
            {updatePayment.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
