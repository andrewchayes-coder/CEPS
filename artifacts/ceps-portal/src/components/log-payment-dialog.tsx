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
import { Plus, AlertTriangle, Trash2 } from 'lucide-react';
import { trackAnalyticsEvent } from '@/lib/analytics';
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';
import { getInvoiceDisplayMonth } from '@/lib/invoice-utils';
import { apiErrorMessage } from '@/lib/api-error';
import { MonthYearInput } from '@/components/month-year-input';
import { getCurrentServiceMonth, getLatestServiceMonth } from '@/lib/payment-utils';

const PAYMENT_TYPES = ['direct_payment', 'reimbursement', 'fee'];

type Props = {
  onSaved?: () => void;
  defaultClientId?: string;
  defaultInvoiceId?: string;
};

const emptyForm = {
  clientId: '',
  qbCheckNumber: '',
  checkDate: '',
  paymentType: 'direct_payment',
  vendorId: 'none',
  invoiceId: 'none',
  allocations: [{ authorizationId: 'none', serviceMonth: getCurrentServiceMonth(), amount: '' }]
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

export function LogPaymentDialog({ onSaved, defaultClientId, defaultInvoiceId }: Props) {
  const { toast } = useToast();
  const createPayment = useCreatePayment();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm, clientId: defaultClientId ?? '', invoiceId: defaultInvoiceId ?? 'none' });
  const [duplicate, setDuplicate] = useState<Payment[] | null>(null);
  const [justification, setJustification] = useState('');
  const [allocationError, setAllocationError] = useState('');

  const [clientSearch, setClientSearch] = useState('');
  const debouncedClientSearch = useDebounce(clientSearch, 300);
  const { data: clientsData, isLoading: clientsLoading } = useListClients(
    { search: debouncedClientSearch, limit: 50 },
    { query: { enabled: open, queryKey: ['clients', { search: debouncedClientSearch, limit: 50 }] } },
  );
  const clients = clientsData?.items;

  const [vendorSearch, setVendorSearch] = useState('');
  const debouncedVendorSearch = useDebounce(vendorSearch, 300);
  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors(
    { clientId: form.clientId, search: debouncedVendorSearch, limit: 50 },
    { query: { enabled: open && !!form.clientId, queryKey: ['vendors', { clientId: form.clientId, search: debouncedVendorSearch, limit: 50 }] } }
  );
  const vendors = vendorsData?.items;

  const [invoiceSearch, setInvoiceSearch] = useState('');
  const debouncedInvoiceSearch = useDebounce(invoiceSearch, 300);
  const invoiceQuery = { clientId: form.clientId, search: debouncedInvoiceSearch, limit: 50 };
  const { data: validatedInvoicesData, isLoading: validatedInvoicesLoading } = useListInvoices(
    { ...invoiceQuery, status: 'validated' },
    { query: { enabled: open && !!form.clientId, queryKey: ['invoices', { ...invoiceQuery, status: 'validated' }] } },
  );
  const { data: approvedInvoicesData, isLoading: approvedInvoicesLoading } = useListInvoices(
    { ...invoiceQuery, status: 'approved' },
    { query: { enabled: open && !!form.clientId, queryKey: ['invoices', { ...invoiceQuery, status: 'approved' }] } },
  );
  const invoices = Array.from(new Map(
    [...(validatedInvoicesData?.items ?? []), ...(approvedInvoicesData?.items ?? [])].map((invoice) => [invoice.id, invoice]),
  ).values()).sort((a, b) => getInvoiceDisplayMonth(a).localeCompare(getInvoiceDisplayMonth(b)));
  const invoicesLoading = validatedInvoicesLoading || approvedInvoicesLoading;

  React.useEffect(() => {
    if (defaultInvoiceId && invoices.some((invoice) => invoice.id === defaultInvoiceId)) {
      handleInvoiceChange(defaultInvoiceId);
    }
  }, [defaultInvoiceId, invoices.length]);

  const [authSearch, setAuthSearch] = useState('');
  const debouncedAuthSearch = useDebounce(authSearch, 300);
  const { data: authorizationsData, isLoading: authorizationsLoading } = useListAuthorizations(
    { clientId: form.clientId, search: debouncedAuthSearch, limit: 50 },
    { query: { enabled: open && !!form.clientId, queryKey: ['authorizations', { clientId: form.clientId, search: debouncedAuthSearch, limit: 50 }] } }
  );
  const authorizations = authorizationsData?.items;

  const set = (k: string, v: any) => setForm((p) => ({ ...p, [k]: v }));

  const handleClientChange = (v: string) => {
    setAllocationError('');
    setForm((p) => ({
      ...p,
      clientId: v,
      vendorId: 'none',
      invoiceId: 'none',
      allocations: [{ authorizationId: 'none', serviceMonth: getCurrentServiceMonth(), amount: '' }],
    }));
  };

  const handleInvoiceChange = (invId: string) => {
    setAllocationError('');
    const inv = invoices.find(i => i.id === invId);
    if (!inv || !inv.lineItems) {
      setForm(p => ({ ...p, invoiceId: invId, allocations: [{ authorizationId: 'none', serviceMonth: getLatestServiceMonth(p.allocations.map((allocation) => allocation.serviceMonth)), amount: '' }] }));
      return;
    }

    const latestMonth = getLatestServiceMonth(inv.lineItems.map((line) => line.serviceMonth));
    const newAllocations = inv.lineItems.map((line) => ({
      authorizationId: line.authorizationId || 'none',
      serviceMonth: line.serviceMonth || latestMonth,
      amount: line.amount,
    }));

    setForm(p => ({
      ...p,
      invoiceId: invId,
      vendorId: inv.vendorId || 'none',
      allocations: newAllocations.length > 0 ? newAllocations : [{ authorizationId: 'none', serviceMonth: latestMonth, amount: '' }]
    }));
  };

  const handleAddAllocation = () => {
    setAllocationError('');
    const selectedInvoice = invoices.find((invoice) => invoice.id === form.invoiceId);
    const latestMonth = selectedInvoice
      ? getLatestServiceMonth(selectedInvoice.lineItems.map((line) => line.serviceMonth))
      : getLatestServiceMonth(form.allocations.map((allocation) => allocation.serviceMonth));
    setForm(p => ({ ...p, allocations: [...p.allocations, { authorizationId: 'none', serviceMonth: latestMonth, amount: '' }] }));
  };

  const handleRemoveAllocation = (index: number) => {
    setAllocationError('');
    setForm(p => ({ ...p, allocations: p.allocations.filter((_, i) => i !== index) }));
  };

  const handleAllocationChange = (index: number, key: 'authorizationId' | 'serviceMonth' | 'amount', value: string) => {
    setAllocationError('');
    setForm(p => {
      const newAllocs = [...p.allocations];
      newAllocs[index] = { ...newAllocs[index], [key]: value };
      return { ...p, allocations: newAllocs };
    });
  };

  const computedTotal = form.allocations.reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);

  const reset = () => {
    setForm({ ...emptyForm, clientId: defaultClientId ?? '', invoiceId: defaultInvoiceId ?? 'none' });
    setDuplicate(null);
    setJustification('');
    setAllocationError('');
  };

  const submit = (override: boolean) => {
    if (!form.clientId) {
      toast({ variant: 'destructive', title: 'Participant required', description: 'Choose a participant for this payment.' });
      return;
    }
    if (form.allocations.some((a) => !a.authorizationId || a.authorizationId === 'none' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(a.serviceMonth))) {
      setAllocationError('Select an authorization and service month for every allocation before logging the payment.');
      return;
    }
    setAllocationError('');
    if (override && justification.trim() === '') {
      toast({ variant: 'destructive', title: 'Justification required', description: 'Enter a written justification to override the duplicate-payment stop.' });
      return;
    }
    const data: PaymentInput = {
      clientId: form.clientId,
      qbCheckNumber: form.qbCheckNumber,
      checkDate: form.checkDate,
      amount: computedTotal.toFixed(2),
      paymentType: form.paymentType as PaymentInput['paymentType'],
      vendorId: form.vendorId === 'none' ? null : form.vendorId,
      invoiceId: form.invoiceId === 'none' ? null : form.invoiceId,
      allocations: form.allocations.map(a => ({
        authorizationId: a.authorizationId,
        serviceMonth: a.serviceMonth,
        amount: a.amount
      })),
      ...(override ? { overrideDuplicate: true, overrideJustification: justification.trim() } : {}),
    };
    createPayment.mutate(
      { data },
      {
        onSuccess: () => {
          trackAnalyticsEvent('payment_recorded', {
            payment_type: form.paymentType,
            source: 'manual',
          });
          toast({ title: override ? 'Payment logged (duplicate overridden)' : 'Payment logged' });
          setOpen(false);
          reset();
          onSaved?.();
        },
        onError: (err: unknown) => {
          const dup = asDuplicateError(err);
          if (dup) {
            setDuplicate(dup.existingPayments);
            return;
          }
          toast({ variant: 'destructive', title: 'Error', description: apiErrorMessage(err, 'Could not log the payment.') });
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
            <Label htmlFor="payment-client">Participant</Label>
            <SearchableSelect
              id="payment-client"
              value={form.clientId}
              onValueChange={handleClientChange}
              options={clients?.map((c) => ({ value: c.id, label: `${c.firstName} ${c.lastName}` })) ?? []}
              onSearchChange={setClientSearch}
              loading={clientsLoading}
              placeholder="Select a participant"
              data-testid="select-payment-client-id"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment-check-number">Check #</Label>
            <Input id="payment-check-number" value={form.qbCheckNumber} onChange={(e) => set('qbCheckNumber', e.target.value)} data-testid="input-payment-check-number" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment-date">Payment Date</Label>
            <Input id="payment-date" type="date" value={form.checkDate} onChange={(e) => set('checkDate', e.target.value)} data-testid="input-payment-date" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment-type">Payment Type</Label>
            <Select value={form.paymentType} onValueChange={(v) => set('paymentType', v)}>
              <SelectTrigger id="payment-type" data-testid="select-payment-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAYMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="capitalize">{t.replace(/_/g, ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment-vendor">Vendor</Label>
            <SearchableSelect
              id="payment-vendor"
              value={form.vendorId}
              onValueChange={(v) => set('vendorId', v)}
              options={vendors?.map((v) => ({ value: v.id, label: v.name })) ?? []}
              onSearchChange={setVendorSearch}
              loading={vendorsLoading}
              disabled={!form.clientId}
              placeholder="Select vendor"
              allowClear
              clearLabel="None"
              data-testid="select-payment-vendor-id"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment-invoice">Invoice</Label>
            <SearchableSelect
              id="payment-invoice"
              value={form.invoiceId}
              onValueChange={handleInvoiceChange}
              options={invoices?.map((i) => ({
                value: i.id,
                label: `${getInvoiceDisplayMonth(i)} – $${parseFloat(i.amountRequested).toFixed(2)}`
              })) ?? []}
              onSearchChange={setInvoiceSearch}
              loading={invoicesLoading}
              disabled={!form.clientId}
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
                  onValueChange={(v) => handleAllocationChange(index, 'authorizationId', v)}
                  options={authorizations?.map((a) => ({
                    value: a.id,
                    label: a.authNumber,
                    subtitle: a.activityDescription ?? undefined
                  })) ?? []}
                  onSearchChange={setAuthSearch}
                  loading={authorizationsLoading}
                  disabled={!form.clientId}
                  placeholder={!form.clientId ? "Select participant first" : "Select authorization"}
                  allowClear
                  clearLabel="None"
                  data-testid={`select-payment-alloc-${index}-auth`}
                />
              </div>
              <div className="w-36 space-y-1">
                <MonthYearInput
                  id={`payment-alloc-${index}-month`}
                  label="Service Month"
                  value={alloc.serviceMonth}
                  required
                  onChange={(value) => handleAllocationChange(index, 'serviceMonth', value)}
                />
              </div>
              <div className="w-28 space-y-1">
                <Input
                  placeholder="0.00"
                  value={alloc.amount}
                  onChange={(e) => handleAllocationChange(index, 'amount', e.target.value)}
                  data-testid={`input-payment-alloc-${index}-amount`}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => handleRemoveAllocation(index)}
                disabled={form.allocations.length === 1}
                className="text-destructive mt-0.5"
                data-testid={`button-remove-payment-alloc-${index}`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
          {allocationError && <p role="alert" className="text-sm text-destructive" data-testid="error-payment-allocation">{allocationError}</p>}

          <Button type="button" variant="outline" size="sm" onClick={handleAddAllocation} data-testid="button-add-payment-allocation">
            <Plus className="w-4 h-4 mr-2" /> Add Allocation
          </Button>
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
                  A payment already exists for this participant, authorization, and month. This is a hard
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
