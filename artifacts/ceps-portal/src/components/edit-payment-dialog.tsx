import React, { useState } from 'react';
import { apiErrorMessage } from '@/lib/api-error';
import { useUpdatePayment, useListVendors, useListInvoices, useListAuthorizations, type PaymentAllocation } from '@workspace/api-client-react';
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
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';
import { getInvoiceDisplayMonth } from '@/lib/invoice-utils';

const PAYMENT_TYPES = ['direct_payment', 'reimbursement', 'fee'];

type PaymentLike = {
  clientId: string;
  qbCheckNumber: string;
  checkDate: string;
  amount: string;
  paymentType: string;
  vendorId?: string | null;
  vendorName?: string | null;
  invoiceId?: string | null;
  authorizationId?: string | null;
  authNumber?: string | null;
  allocations?: PaymentAllocation[];
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
    paymentType: payment.paymentType,
    vendorId: payment.vendorId ?? 'none',
    invoiceId: payment.invoiceId ?? 'none',
    allocations: payment.allocations && payment.allocations.length > 0
      ? payment.allocations.map(a => ({ authorizationId: a.authorizationId, amount: a.amount }))
      : payment.authorizationId
        ? [{ authorizationId: payment.authorizationId, amount: payment.amount }]
        : [{ authorizationId: 'none', amount: '' }]
  });

  // Re-sync on open
  React.useEffect(() => {
    if (open) {
      setForm({
        qbCheckNumber: payment.qbCheckNumber,
        checkDate: payment.checkDate?.slice(0, 10) ?? '',
        paymentType: payment.paymentType,
        vendorId: payment.vendorId ?? 'none',
        invoiceId: payment.invoiceId ?? 'none',
        allocations: payment.allocations && payment.allocations.length > 0
          ? payment.allocations.map(a => ({ authorizationId: a.authorizationId, amount: a.amount }))
          : payment.authorizationId
            ? [{ authorizationId: payment.authorizationId, amount: payment.amount }]
            : [{ authorizationId: 'none', amount: '' }]
      });
    }
  }, [open, payment]);

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

  const set = (k: string, v: any) => setForm((p) => ({ ...p, [k]: v }));

  const handleInvoiceChange = (invId: string) => {
    const inv = invoices.find(i => i.id === invId);
    if (!inv || !inv.lineItems) {
      setForm(p => ({ ...p, invoiceId: invId }));
      return;
    }

    const grouped = inv.lineItems.reduce((acc, line) => {
      const authId = line.authorizationId || 'none';
      if (!acc[authId]) acc[authId] = 0;
      acc[authId] += parseFloat(line.amount) || 0;
      return acc;
    }, {} as Record<string, number>);

    const newAllocations = Object.entries(grouped).map(([authId, sum]) => ({
      authorizationId: authId,
      amount: sum.toFixed(2),
    }));

    setForm(p => ({
      ...p,
      invoiceId: invId,
      vendorId: inv.vendorId || 'none',
      allocations: newAllocations.length > 0 ? newAllocations : [{ authorizationId: 'none', amount: '' }]
    }));
  };

  const computedTotal = form.allocations.reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);

  const handleSave = () => {
    const data: PaymentUpdate = {
      qbCheckNumber: form.qbCheckNumber,
      checkDate: form.checkDate || undefined,
      amount: computedTotal.toFixed(2),
      paymentType: form.paymentType as PaymentUpdate['paymentType'],
      vendorId: form.vendorId === 'none' ? null : form.vendorId,
      invoiceId: form.invoiceId === 'none' ? null : form.invoiceId,
      allocations: form.allocations.map(a => ({
        authorizationId: a.authorizationId === 'none' ? '' : a.authorizationId,
        amount: a.amount
      }))
    };
    updatePayment.mutate(
      { id, data },
      {
        onSuccess: () => {
          toast({ title: 'Payment updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: (error: unknown) => toast({ variant: 'destructive', title: 'Error', description: apiErrorMessage(error, 'Could not update payment.') }),
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
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Payment</DialogTitle>
          <DialogDescription>Update the payment details.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="edit-payment-check-number">Check #</Label>
            <Input id="edit-payment-check-number" value={form.qbCheckNumber} onChange={(e) => set('qbCheckNumber', e.target.value)} data-testid="input-payment-check-number" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-payment-date">Payment Date</Label>
            <Input id="edit-payment-date" type="date" value={form.checkDate} onChange={(e) => set('checkDate', e.target.value)} data-testid="input-payment-date" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-payment-type">Payment Type</Label>
            <Select value={form.paymentType} onValueChange={(v) => set('paymentType', v)}>
              <SelectTrigger id="edit-payment-type" data-testid="select-payment-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAYMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="capitalize">{t.replace(/_/g, ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-payment-vendor">Vendor</Label>
            <SearchableSelect
              id="edit-payment-vendor"
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
            <Label htmlFor="edit-payment-invoice">Invoice</Label>
            <SearchableSelect
              id="edit-payment-invoice"
              value={form.invoiceId}
              onValueChange={handleInvoiceChange}
              options={invoices.map((i) => ({
                value: i.id,
                label: `${getInvoiceDisplayMonth(i)} – $${parseFloat(i.amountRequested).toFixed(2)}`
              }))}
              onSearchChange={setInvoiceSearch}
              loading={invoicesLoading}
              placeholder="Select invoice"
              allowClear
              clearLabel="None"
              data-testid="select-payment-invoice-id"
            />
          </div>
        </div>

        <div className="space-y-4 border rounded-md p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">Allocations</h3>
            <div className="font-medium text-sm">Total: ${computedTotal.toFixed(2)}</div>
          </div>

          {form.allocations.map((alloc, index) => (
            <div key={index} className="flex gap-3 items-start" data-testid={`row-payment-allocation-${index}`}>
              <div className="flex-1 space-y-1">
                <SearchableSelect
                  value={alloc.authorizationId}
                  onValueChange={(v) => {
                    const newAlloc = [...form.allocations];
                    newAlloc[index].authorizationId = v;
                    set('allocations', newAlloc);
                  }}
                  options={authorizations.map((a) => ({
                    value: a.id,
                    label: a.authNumber,
                    subtitle: a.activityDescription ?? undefined
                  }))}
                  onSearchChange={setAuthSearch}
                  loading={authorizationsLoading}
                  placeholder="Select authorization"
                  allowClear
                  clearLabel="None"
                  data-testid={`select-payment-alloc-${index}-auth`}
                />
              </div>
              <div className="w-28 space-y-1">
                <Input
                  placeholder="0.00"
                  value={alloc.amount}
                  onChange={(e) => {
                    const newAlloc = [...form.allocations];
                    newAlloc[index].amount = e.target.value;
                    set('allocations', newAlloc);
                  }}
                  data-testid={`input-payment-alloc-${index}-amount`}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => {
                  set('allocations', form.allocations.filter((_, i) => i !== index));
                }}
                disabled={form.allocations.length === 1}
                className="text-destructive mt-0.5"
                data-testid={`button-remove-payment-alloc-${index}`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => set('allocations', [...form.allocations, { authorizationId: 'none', amount: '' }])}
            data-testid="button-add-payment-allocation"
          >
            <Plus className="w-4 h-4 mr-2" /> Add Allocation
          </Button>
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
