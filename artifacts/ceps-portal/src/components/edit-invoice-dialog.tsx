import { useQueryClient } from '@tanstack/react-query';
import { invalidateInvoiceQueries } from '@/lib/invoice-query-cache';
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
import { DocumentTypeSelect, DocumentTypeMismatchHint } from '@/components/invoice-document-type';
import { blankLinesForServiceDates, formatServiceDates } from '@/lib/invoice-service-dates';
import { invoiceEditSchema as formSchema, lineServiceDateWarning } from '@/lib/invoice-edit-schema';
import { apiErrorMessage } from '@/lib/api-error';

type InvoiceLike = {
  clientId: string;
  clientName?: string | null;
  vendorId?: string | null;
  vendorName?: string | null;
  paymentType: string;
  documentType?: string;
  serviceCodes?: string[];
  status: string;
  notes?: string | null;
  serviceStartDate?: string | null;
  serviceEndDate?: string | null;
  lineItems: InvoiceLineItem[];
};

type Props = {
  id: string;
  invoice: InvoiceLike;
  onSaved?: () => void;
  variant?: 'dialog' | 'inline';
};

export function EditInvoiceDialog({ id, invoice, onSaved, variant = 'dialog' }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateInvoice = useUpdateInvoice();
  const [open, setOpen] = useState(false);
  const isInline = variant === 'inline';
  const isActive = isInline || open;

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      vendorId: invoice.vendorId ?? '',
      paymentType: invoice.paymentType,
      documentType: invoice.documentType === 'receipt' ? 'receipt' : 'invoice',
      notes: invoice.notes ?? '',
      serviceStartDate: invoice.serviceStartDate ?? '',
      serviceEndDate: invoice.serviceEndDate ?? '',
      lineItems: invoice.lineItems.length > 0
        ? invoice.lineItems.map(l => ({ id: l.id, authorizationId: l.authorizationId, serviceMonth: l.serviceMonth, amount: l.amount }))
        : blankLinesForServiceDates(invoice.serviceStartDate, invoice.serviceEndDate, new Date().toISOString().substring(0, 7))
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lineItems"
  });
  const lineItems = form.watch('lineItems');
  const watchedDocType = form.watch('documentType');
  const watchedPayType = form.watch('paymentType');
  const serviceStartDate = form.watch('serviceStartDate');
  const serviceEndDate = form.watch('serviceEndDate');
  const totalAmount = lineItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);

  const [vendorSearch, setVendorSearch] = useState('');
  const debouncedVendorSearch = useDebounce(vendorSearch, 300);
  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors(
    { clientId: invoice.clientId, search: debouncedVendorSearch, limit: 50, invoiceEligible: 'true' },
    { query: { enabled: isActive, queryKey: ['vendors', { clientId: invoice.clientId, search: debouncedVendorSearch, limit: 50, invoiceEligible: 'true' }] } }
  );
  const vendors = vendorsData?.items ?? [];

  const [authSearch, setAuthSearch] = useState('');
  const debouncedAuthSearch = useDebounce(authSearch, 300);
  const { data: authorizationsData, isLoading: authorizationsLoading } = useListAuthorizations(
    { clientId: invoice.clientId, search: debouncedAuthSearch, limit: 50 },
    { query: { enabled: isActive, queryKey: ['authorizations', { clientId: invoice.clientId, search: debouncedAuthSearch, limit: 50 }] } }
  );
  const authorizations = (authorizationsData?.items ?? []).filter((auth) => auth.paymentType !== 'fee');
  const codeForAuth = (authId: string | undefined, lineIndex: number): string | null => {
    if (!authId) return null;
    const found = authorizations.find((a) => a.id === authId);
    if (found) return found.serviceCode ?? null;
    const existing = invoice.lineItems.find((l) => l.authorizationId === authId);
    return existing?.serviceCode ?? null;
  };

  useEffect(() => {
    if (isActive) {
      form.reset({
        vendorId: invoice.vendorId ?? '',
        paymentType: invoice.paymentType,
        documentType: invoice.documentType === 'receipt' ? 'receipt' : 'invoice',
        notes: invoice.notes ?? '',
        serviceStartDate: invoice.serviceStartDate ?? '',
        serviceEndDate: invoice.serviceEndDate ?? '',
        lineItems: invoice.lineItems.length > 0
          ? invoice.lineItems.map(l => ({ id: l.id, authorizationId: l.authorizationId, serviceMonth: l.serviceMonth, amount: l.amount }))
          : blankLinesForServiceDates(invoice.serviceStartDate, invoice.serviceEndDate, new Date().toISOString().substring(0, 7))
      });
    }
  }, [isActive, invoice, form]);

  const onSubmit = (data: z.infer<typeof formSchema>) => {
    const updateData: InvoiceUpdate = {
      vendorId: data.vendorId === 'none' || data.vendorId === '' ? null : data.vendorId,
      amountRequested: totalAmount.toFixed(2),
      paymentType: data.paymentType as InvoiceUpdate['paymentType'],
      documentType: data.documentType,
      notes: data.notes === '' ? undefined : data.notes,
      lineItems: data.lineItems,
      serviceStartDate: data.serviceStartDate || null,
      serviceEndDate: data.serviceEndDate || null,
      ...(invoice.status === 'needs_entry' ? { status: 'pending_review' as InvoiceUpdate['status'] } : {}),
    };
    updateInvoice.mutate(
      { id, data: updateData },
      {
        onSuccess: () => {
          void invalidateInvoiceQueries(queryClient);
          toast({ title: 'Invoice updated' });
          if (!isInline) setOpen(false);
          onSaved?.();
        },
        onError: (error: unknown) => toast({ variant: 'destructive', title: 'Error', description: apiErrorMessage(error, 'Could not update invoice.') }),
      },
    );
  };

  const editorForm = (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2 sm:col-span-2">
                 <Label htmlFor="edit-invoice-participant">Participant</Label>
                <Input id="edit-invoice-participant" value={invoice.clientName ?? invoice.clientId} disabled />
              </div>
              {(['serviceStartDate', 'serviceEndDate'] as const).map((name) => (
                <FormField key={name} control={form.control} name={name} render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor={`edit-invoice-${name}`}>{name === 'serviceStartDate' ? 'Service start date' : 'Service end date'}</FormLabel>
                    <FormControl><Input id={`edit-invoice-${name}`} type="date" value={field.value ?? ''} onChange={field.onChange} onBlur={field.onBlur} data-testid={`input-edit-${name}`} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              ))}
              <FormField control={form.control} name="vendorId" render={({ field }) => (
                <FormItem className="sm:col-span-2">
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
              <FormField control={form.control} name="documentType" render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="edit-invoice-document-type">Document Type</FormLabel>
                  <DocumentTypeSelect id="edit-invoice-document-type" value={field.value} onValueChange={field.onChange} />
                  <FormMessage />
                </FormItem>
              )} />
              <DocumentTypeMismatchHint documentType={watchedDocType} paymentType={watchedPayType} />
              <div className="space-y-2 sm:col-span-2">
                 <Label>Status</Label>
                <div><Badge variant="secondary" className="capitalize">{invoice.status.replace(/_/g, ' ')}</Badge></div>
                 <p className="text-xs text-muted-foreground">
                   {invoice.status === 'needs_entry'
                     ? 'Saving valid line items moves this invoice to Pending Review.'
                     : 'Use Validate / Approve / Reject on the invoice page to change status.'}
                 </p>
              </div>
            </div>

            <div className="space-y-4 border rounded-md p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Line Items</h3>
                <div className="font-medium">Total: ${totalAmount.toFixed(2)}</div>
              </div>

              {fields.map((field, index) => (
                <div key={field.id} className="grid grid-cols-1 gap-3 items-start border-b pb-4 last:border-0 last:pb-0" data-testid={`row-line-item-${index}`}>
                  <div>
                    <FormField control={form.control} name={`lineItems.${index}.authorizationId`} render={({ field: fField }) => (
                      <FormItem>
                        <FormLabel className="text-xs" htmlFor={`edit-line-${index}-auth`}>Authorization</FormLabel>
                        <FormControl>
                          <SearchableSelect
                            id={`edit-line-${index}-auth`}
                            value={form.watch(`lineItems.${index}.authorizationId`) ?? ''}
                            onValueChange={(v) => form.setValue(`lineItems.${index}.authorizationId`, v)}
                            options={authorizations.map(a => ({ value: a.id, label: a.authNumber, subtitle: [a.serviceCode, a.activityDescription].filter(Boolean).join(' · ') || undefined }))}
                            selectedLabelFallback={invoice.lineItems.find((l) => l.authorizationId === form.watch(`lineItems.${index}.authorizationId`))?.authNumber ?? undefined}
                            onSearchChange={setAuthSearch}
                            loading={authorizationsLoading}
                            placeholder="Select authorization"
                            data-testid={`select-line-${index}-authorization`}
                          />
                        </FormControl>
                        {codeForAuth(form.watch(`lineItems.${index}.authorizationId`), index) && (
                          <p className="text-xs text-muted-foreground" data-testid={`text-line-${index}-service-code`}>Svc Code: {codeForAuth(form.watch(`lineItems.${index}.authorizationId`), index)}</p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FormField control={form.control} name={`lineItems.${index}.serviceMonth`} render={({ field: fField }) => (
                      <FormItem>
                        <FormLabel className="text-xs" htmlFor={`edit-line-${index}-month`}>Service Month</FormLabel>
                        <FormControl>
                          <MonthYearInput id={`edit-line-${index}-month`} label={null} value={fField.value} onChange={fField.onChange} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
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
                  {lineServiceDateWarning(lineItems[index]?.serviceMonth ?? '', serviceStartDate, serviceEndDate) && (
                    <p className="text-xs text-amber-700 dark:text-amber-400" data-testid={`warning-line-${index}-service-dates`}>
                      {lineServiceDateWarning(lineItems[index]?.serviceMonth ?? '', serviceStartDate, serviceEndDate)}
                    </p>
                  )}
                  <div className="flex justify-end">
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
              <FormItem>
                <FormLabel htmlFor="edit-invoice-notes">Notes</FormLabel>
                <FormControl><Textarea id="edit-invoice-notes" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="flex justify-end gap-2">
              {!isInline && <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>}
              <Button type="submit" disabled={updateInvoice.isPending} data-testid="button-save-invoice">
                {updateInvoice.isPending
                  ? 'Saving…'
                  : invoice.status === 'needs_entry' ? 'Save Line Items & Send to Review' : 'Save Changes'}
              </Button>
            </div>
      </form>
    </Form>
  );

  if (isInline) {
    return (
      <section className="space-y-3" data-testid="inline-invoice-editor">
        {formatServiceDates(invoice.serviceStartDate, invoice.serviceEndDate) && (
          <p className="text-sm font-medium" data-testid="text-inline-service-dates-top">Service dates submitted: {formatServiceDates(invoice.serviceStartDate, invoice.serviceEndDate)}</p>
        )}
        <div>
          <h3 className="font-semibold">CEPS Line-Item Entry</h3>
          <p className="text-sm text-muted-foreground">Add at least one valid authorization, service month, and amount to move this invoice to review.</p>
        </div>
        {editorForm}
      </section>
    );
  }

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
        {editorForm}
      </DialogContent>
    </Dialog>
  );
}
