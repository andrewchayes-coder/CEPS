import React, { useState, useEffect } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useUpdateInvoice, useListVendors, useListAuthorizations } from '@workspace/api-client-react';
import type { InvoiceUpdate, InvoiceLineItem } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
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
import { MonthYearInput } from '@/components/month-year-input';
import { useDebounce } from '@/hooks/use-debounce';
import { Badge } from '@/components/ui/badge';
import { apiErrorMessage } from '@/lib/api-error';

const formSchema = z.object({
  vendorId: z.string().optional(),
  paymentType: z.string(),
  notes: z.string().optional(),
  lineItems: z.array(z.object({
    id: z.string().optional(),
    authorizationId: z.string().min(1, 'Required'),
    serviceMonth: z.string().regex(/^\d{4}-\d{2}$/, 'Must be YYYY-MM format'),
    amount: z.string().min(1, 'Required').regex(/^\d+(\.\d{1,2})?$/, 'Invalid format'),
  })).min(1, 'At least one line item is required'),
});

type InvoiceLike = {
  clientId: string;
  clientName?: string | null;
  vendorId?: string | null;
  vendorName?: string | null;
  paymentType: string;
  status: string;
  notes?: string | null;
  lineItems: InvoiceLineItem[];
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

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      vendorId: invoice.vendorId ?? '',
      paymentType: invoice.paymentType,
      notes: invoice.notes ?? '',
      lineItems: invoice.lineItems.length > 0
        ? invoice.lineItems.map(l => ({ id: l.id, authorizationId: l.authorizationId, serviceMonth: l.serviceMonth, amount: l.amount }))
        : [{ authorizationId: '', serviceMonth: new Date().toISOString().substring(0, 7), amount: '' }]
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lineItems"
  });
  const lineItems = form.watch('lineItems');
  const totalAmount = lineItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);

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

  useEffect(() => {
    if (open) {
      form.reset({
        vendorId: invoice.vendorId ?? '',
        paymentType: invoice.paymentType,
        notes: invoice.notes ?? '',
        lineItems: invoice.lineItems.length > 0
          ? invoice.lineItems.map(l => ({ id: l.id, authorizationId: l.authorizationId, serviceMonth: l.serviceMonth, amount: l.amount }))
          : [{ authorizationId: '', serviceMonth: new Date().toISOString().substring(0, 7), amount: '' }]
      });
    }
  }, [open, invoice, form]);

  const onSubmit = (data: z.infer<typeof formSchema>) => {
    const updateData: InvoiceUpdate = {
      vendorId: data.vendorId === 'none' || data.vendorId === '' ? null : data.vendorId,
      amountRequested: totalAmount.toFixed(2),
      paymentType: data.paymentType as InvoiceUpdate['paymentType'],
      notes: data.notes === '' ? undefined : data.notes,
      lineItems: data.lineItems
    };
    updateInvoice.mutate(
      { id, data: updateData },
      {
        onSuccess: () => {
          toast({ title: 'Invoice updated' });
          setOpen(false);
          onSaved?.();
        },
        onError: (error: unknown) => toast({ variant: 'destructive', title: 'Error', description: apiErrorMessage(error, 'Could not update invoice.') }),
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
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Invoice</DialogTitle>
          <DialogDescription>Update the invoice details.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2 col-span-2">
                 <Label htmlFor="edit-invoice-participant">Participant</Label>
                <Input id="edit-invoice-participant" value={invoice.clientName ?? invoice.clientId} disabled />
              </div>
              <FormField control={form.control} name="vendorId" render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="edit-invoice-vendor">Vendor</FormLabel>
                  <FormControl>
                    <SearchableSelect
                      id="edit-invoice-vendor"
                      value={field.value ?? ''}
                      onValueChange={field.onChange}
                      options={vendors.map(v => ({ value: v.id, label: v.name }))}
                      onSearchChange={setVendorSearch}
                      loading={vendorsLoading}
                      placeholder="Select vendor"
                      selectedLabelFallback={invoice.vendorName ?? undefined}
                      allowClear
                      clearLabel="None"
                      data-testid="select-invoice-vendor"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="paymentType" render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="edit-invoice-payment-type">Payment Type</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl><SelectTrigger id="edit-invoice-payment-type"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="direct_payment">Direct Payment</SelectItem>
                      <SelectItem value="reimbursement">Reimbursement</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="space-y-2 col-span-2">
                 <Label>Status</Label>
                <div><Badge variant="secondary" className="capitalize">{invoice.status.replace(/_/g, ' ')}</Badge></div>
                <p className="text-xs text-muted-foreground">Use Validate / Approve / Reject on the invoice page to change status.</p>
              </div>
            </div>

            <div className="space-y-4 border rounded-md p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Line Items</h3>
                <div className="font-medium">Total: ${totalAmount.toFixed(2)}</div>
              </div>

              {fields.map((field, index) => (
                <div key={field.id} className="grid grid-cols-12 gap-3 items-start border-b pb-4 last:border-0 last:pb-0" data-testid={`row-line-item-${index}`}>
                  <div className="col-span-5">
                    <FormField control={form.control} name={`lineItems.${index}.authorizationId`} render={({ field: fField }) => (
                      <FormItem>
                        <FormLabel className="text-xs" htmlFor={`edit-line-${index}-auth`}>Authorization</FormLabel>
                        <FormControl>
                          <SearchableSelect
                            id={`edit-line-${index}-auth`}
                            value={form.watch(`lineItems.${index}.authorizationId`) ?? ''}
                            onValueChange={(v) => form.setValue(`lineItems.${index}.authorizationId`, v)}
                            options={authorizations.map(a => ({ value: a.id, label: a.authNumber, subtitle: a.activityDescription ?? undefined }))}
                            onSearchChange={setAuthSearch}
                            loading={authorizationsLoading}
                            placeholder="Select authorization"
                            data-testid={`select-line-${index}-authorization`}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <div className="col-span-4">
                    <FormField control={form.control} name={`lineItems.${index}.serviceMonth`} render={({ field: fField }) => (
                      <FormItem>
                        <FormLabel className="text-xs" htmlFor={`edit-line-${index}-month`}>Service Month</FormLabel>
                        <FormControl>
                          <MonthYearInput id={`edit-line-${index}-month`} label={null} value={fField.value} onChange={fField.onChange} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <div className="col-span-2">
                    <FormField control={form.control} name={`lineItems.${index}.amount`} render={({ field: fField }) => (
                      <FormItem>
                        <FormLabel className="text-xs" htmlFor={`edit-line-${index}-amount`}>Amount</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <span className="absolute left-2 top-2 text-muted-foreground text-sm">$</span>
                            <Input id={`edit-line-${index}-amount`} className="pl-6 text-sm" placeholder="0.00" {...fField} data-testid={`input-line-${index}-amount`} />
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <div className="col-span-1 pt-6 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(index)}
                      disabled={fields.length === 1}
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      data-testid={`button-remove-line-${index}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}

              <Button
                type="button"
                variant="outline"
                size="sm"
                 onClick={() => append({ authorizationId: '', serviceMonth: new Date().toISOString().substring(0, 7), amount: '' })}
                data-testid="button-add-line-item"
              >
                <Plus className="w-4 h-4 mr-2" /> Add Line Item
              </Button>
            </div>

            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem className="col-span-2">
                <FormLabel htmlFor="edit-invoice-notes">Notes</FormLabel>
                <FormControl><Textarea id="edit-invoice-notes" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={updateInvoice.isPending} data-testid="button-save-invoice">
                {updateInvoice.isPending ? 'Saving…' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
