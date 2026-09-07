import React, { useState } from 'react';
import { useUpdateInvoice, useListVendors, useListAuthorizations } from '@workspace/api-client-react';
import type { InvoiceUpdate } from '@workspace/api-client-react';
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
import { Pencil } from 'lucide-react';
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';

type InvoiceLike = {
  clientId: string;
  clientName?: string | null;
  authorizationId?: string | null;
  authNumber?: string | null;
  vendorId?: string | null;
  vendorName?: string | null;
  serviceMonth: string;
  amountRequested: string;
  paymentType: string;
  status: string;
  notes?: string | null;
};

type Props = {
  id: string;
  invoice: InvoiceLike;
  onSaved?: () => void;
};

export function EditInvoiceDialog({ id, invoice, onSaved }: Props) {
  const { toast } = useToast();
  const updateInvoice = useUpdateInvoice();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    authorizationId: invoice.authorizationId ?? 'none',
    vendorId: invoice.vendorId ?? 'none',
    serviceMonth: invoice.serviceMonth,
    amountRequested: invoice.amountRequested,
    paymentType: invoice.paymentType,
    status: invoice.status,
    notes: invoice.notes ?? '',
  });

  const [vendorSearch, setVendorSearch] = useState('');
  const debouncedVendorSearch = useDebounce(vendorSearch, 300);
  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors(
    { clientId: invoice.clientId, search: debouncedVendorSearch, limit: 50 },
    { query: { enabled: open, queryKey: ['vendors', { clientId: invoice.clientId, search: debouncedVendorSearch, limit: 50 }] } }
  );
  const vendors = vendorsData?.items ?? [];

  const [authSearch, setAuthSearch] = useState('');
  const debouncedAuthSearch = useDebounce(authSearch, 300);
  const { data: authorizationsData, isLoading: authorizationsLoading } = useListAuthorizations(
    { clientId: invoice.clientId, search: debouncedAuthSearch, limit: 50 },
    { query: { enabled: open, queryKey: ['authorizations', { clientId: invoice.clientId, search: debouncedAuthSearch, limit: 50 }] } }
  );
  const authorizations = authorizationsData?.items ?? [];

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const handleSave = () => {
    const data: InvoiceUpdate = {
      authorizationId: form.authorizationId === 'none' ? null : form.authorizationId,
      vendorId: form.vendorId === 'none' ? null : form.vendorId,
      serviceMonth: form.serviceMonth,
      amountRequested: form.amountRequested,
      paymentType: form.paymentType as InvoiceUpdate['paymentType'],
      status: form.status as InvoiceUpdate['status'],
      notes: form.notes === '' ? undefined : form.notes,
    };
    updateInvoice.mutate(
      { id, data },
      {
        onSuccess: () => {
          toast({ title: 'Invoice updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: () => toast({ variant: 'destructive', title: 'Error', description: 'Could not update invoice.' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-edit-invoice">
          <Pencil className="w-4 h-4 mr-2" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Invoice</DialogTitle>
          <DialogDescription>Update the invoice details.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-2 col-span-2">
            <Label htmlFor="edit-invoice-participant">Participant</Label>
            <Input id="edit-invoice-participant" value={invoice.clientName ?? invoice.clientId} disabled />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-invoice-authorization">Authorization</Label>
            <SearchableSelect
              id="edit-invoice-authorization"
              value={form.authorizationId}
              onValueChange={(v) => set('authorizationId', v)}
              options={authorizations.map(a => ({ value: a.id, label: a.authNumber, subtitle: a.activityDescription ?? undefined }))}
              onSearchChange={setAuthSearch}
              loading={authorizationsLoading}
              placeholder="Select authorization"
              selectedLabelFallback={invoice.authNumber ?? undefined}
              allowClear
              clearLabel="None"
              data-testid="select-invoice-authorization"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-invoice-vendor">Vendor</Label>
            <SearchableSelect
              id="edit-invoice-vendor"
              value={form.vendorId}
              onValueChange={(v) => set('vendorId', v)}
              options={vendors.map(v => ({ value: v.id, label: v.name }))}
              onSearchChange={setVendorSearch}
              loading={vendorsLoading}
              placeholder="Select vendor"
              selectedLabelFallback={invoice.vendorName ?? undefined}
              allowClear
              clearLabel="None"
              data-testid="select-invoice-vendor"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-invoice-service-month">Service Month</Label>
            <Input id="edit-invoice-service-month" placeholder="YYYY-MM" value={form.serviceMonth} onChange={(e) => set('serviceMonth', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-invoice-amount">Amount Requested</Label>
            <Input id="edit-invoice-amount" value={form.amountRequested} onChange={(e) => set('amountRequested', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-invoice-payment-type">Payment Type</Label>
            <Select value={form.paymentType} onValueChange={(v) => set('paymentType', v)}>
              <SelectTrigger id="edit-invoice-payment-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="direct_payment">Direct Payment</SelectItem>
                <SelectItem value="reimbursement">Reimbursement</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-invoice-status">Status</Label>
            <Select value={form.status} onValueChange={(v) => set('status', v)}>
              <SelectTrigger id="edit-invoice-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pending_review">Pending Review</SelectItem>
                <SelectItem value="validated">Validated</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="duplicate">Duplicate</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 col-span-2">
            <Label htmlFor="edit-invoice-notes">Notes</Label>
            <Textarea id="edit-invoice-notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateInvoice.isPending} data-testid="button-save-invoice">
            {updateInvoice.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
