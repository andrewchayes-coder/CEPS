import React, { useRef } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useCreateInvoice, useListClients, useListVendors, useListAuthorizations, InvoiceInputPaymentType } from '@workspace/api-client-react';
import { useLocation } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Save, FileText, Plus, Trash2 } from 'lucide-react';
import { Link } from 'wouter';
import { FileUpload } from '@/components/file-upload';
import { useAuth } from '@/components/auth/auth-provider';
import { trackAnalyticsEvent } from '@/lib/analytics';
import { SearchableSelect } from '@/components/searchable-select';
import { MonthYearInput } from '@/components/month-year-input';
import { useDebounce } from '@/hooks/use-debounce';

const formSchema = z.object({
  clientId: z.string().min(1, 'Participant is required'),
  vendorId: z.string().optional(),
  paymentType: z.enum(['direct_payment', 'reimbursement']),
  notes: z.string().optional(),
  lineItems: z.array(z.object({
    authorizationId: z.string().min(1, 'Required'),
    serviceMonth: z.string().regex(/^\d{4}-\d{2}$/, 'Must be YYYY-MM'),
    amount: z.string().min(1, 'Required').regex(/^\d+(\.\d{1,2})?$/, 'Invalid format'),
    documentUrl: z.string().nullable().optional(),
  })).min(1, 'At least one line item is required'),
});

export default function InvoiceNewPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createInvoice = useCreateInvoice();
  const { user } = useAuth();
  const [documentUrl, setDocumentUrl] = React.useState<string | undefined>(undefined);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      clientId: '',
      vendorId: '',
      paymentType: 'direct_payment',
      notes: '',
      lineItems: [{ authorizationId: '', serviceMonth: new Date().toISOString().substring(0, 7), amount: '' }]
    }
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lineItems"
  });
  const lineFieldIndexes = useRef(new Map<string, number>());
  lineFieldIndexes.current.clear();
  fields.forEach((field, index) => lineFieldIndexes.current.set(field.id, index));
  const setLineDocument = (fieldId: string, objectPath: string) => {
    const currentIndex = lineFieldIndexes.current.get(fieldId);
    if (currentIndex !== undefined) {
      form.setValue(`lineItems.${currentIndex}.documentUrl`, objectPath);
    }
  };

  const selectedClientId = form.watch('clientId');
  const lineItems = form.watch('lineItems');
  const totalAmount = lineItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);

  const [clientSearch, setClientSearch] = React.useState('');
  const debouncedClientSearch = useDebounce(clientSearch, 300);
  const { data: clientsData, isLoading: clientsLoading } = useListClients({ search: debouncedClientSearch, limit: 50 });
  const clients = clientsData?.items ?? [];

  const [authSearch, setAuthSearch] = React.useState('');
  const debouncedAuthSearch = useDebounce(authSearch, 300);
  const { data: authorizationsData, isLoading: authorizationsLoading } = useListAuthorizations(
    { clientId: selectedClientId, search: debouncedAuthSearch, limit: 50 },
    { query: { enabled: !!selectedClientId, queryKey: ['authorizations', { clientId: selectedClientId, search: debouncedAuthSearch, limit: 50 }] } }
  );
  const filteredAuthorizations = authorizationsData?.items ?? [];

  const [vendorSearch, setVendorSearch] = React.useState('');
  const debouncedVendorSearch = useDebounce(vendorSearch, 300);
  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors(
    { clientId: selectedClientId, search: debouncedVendorSearch, limit: 50 },
    { query: { enabled: !!selectedClientId, queryKey: ['vendors', { clientId: selectedClientId, search: debouncedVendorSearch, limit: 50 }] } }
  );
  const filteredVendors = vendorsData?.items ?? [];

  // On participant change clear authorizations in line items and vendor
  React.useEffect(() => {
    form.setValue('vendorId', '');
    const currentLines = form.getValues('lineItems');
    form.setValue('lineItems', currentLines.map(line => ({ ...line, authorizationId: '' })));
  }, [selectedClientId, form]);

  const handleAuthChange = (index: number, authId: string) => {
    form.setValue(`lineItems.${index}.authorizationId`, authId);
    if (!authId || authId === 'none') return;

    const auth = filteredAuthorizations.find(a => a.id === authId);
    if (auth?.vendorId && form.getValues('vendorId') === '') {
      if (filteredVendors.some(v => v.id === auth.vendorId)) {
        form.setValue('vendorId', auth.vendorId);
      }
    }
  };

  const onSubmit = (data: z.infer<typeof formSchema>) => {
    createInvoice.mutate({
      data: {
        ...data,
        vendorId: data.vendorId === 'none' || data.vendorId === '' ? undefined : data.vendorId,
        paymentType: data.paymentType as InvoiceInputPaymentType,
        documentUrl: documentUrl || undefined,
        amountRequested: totalAmount.toFixed(2)
      }
    }, {
      onSuccess: () => {
        trackAnalyticsEvent('invoice_created', {
          role: user?.role ?? 'unknown',
          status: 'submitted',
        });
        toast({ title: "Invoice Submitted", description: "The invoice has been added to the queue." });
        setLocation('/invoices');
      },
      onError: (err: any) => {
        toast({
          variant: "destructive",
          title: "Submission Failed",
          description: err?.data?.message || "Failed to submit invoice.",
        });
      }
    });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-20">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/invoices"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Link>
      </Button>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">Submit Invoice</h1>
        <p className="text-muted-foreground mt-1">Enter invoice details for processing.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invoice Details</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="clientId" render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="invoice-client">Participant</FormLabel>
                    <FormControl>
                      <SearchableSelect
                        id="invoice-client"
                        value={field.value}
                        onValueChange={field.onChange}
                        options={clients.map(c => ({ value: c.id, label: `${c.firstName} ${c.lastName}` }))}
                        onSearchChange={setClientSearch}
                        loading={clientsLoading}
                        placeholder="Select participant"
                        data-testid="select-invoice-client"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="vendorId" render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="invoice-vendor">Vendor</FormLabel>
                    <FormControl>
                      <SearchableSelect
                        id="invoice-vendor"
                        value={field.value ?? ''}
                        onValueChange={field.onChange}
                        options={filteredVendors.map(v => ({ value: v.id, label: v.name }))}
                        onSearchChange={setVendorSearch}
                        loading={vendorsLoading}
                        disabled={!selectedClientId}
                        placeholder={!selectedClientId ? "Select a participant first" : "Select vendor"}
                        emptyMessage={!selectedClientId ? "Select a participant first" : "No authorized vendors found"}
                        allowClear
                        clearLabel="None"
                        data-testid="select-invoice-vendor"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="paymentType" render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="invoice-payment-type">Payment Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl><SelectTrigger id="invoice-payment-type"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="direct_payment">Direct Payment</SelectItem>
                        <SelectItem value="reimbursement">Reimbursement</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="space-y-4 border rounded-md p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">Line Items</h3>
                  <div className="font-medium">Total: ${totalAmount.toFixed(2)}</div>
                </div>

                {fields.map((field, index) => (
                  <div key={field.id} className="grid grid-cols-12 gap-3 items-start border-b pb-4 last:border-0 last:pb-0" data-testid={`row-line-item-${index}`}>
                    <div className="col-span-5">
                      <FormField control={form.control} name={`lineItems.${index}.authorizationId`} render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs" htmlFor={`line-${index}-auth`}>Authorization</FormLabel>
                          <FormControl>
                            <SearchableSelect
                              id={`line-${index}-auth`}
                              value={field.value ?? ''}
                              onValueChange={(v) => handleAuthChange(index, v)}
                              options={filteredAuthorizations.map(a => ({ value: a.id, label: a.authNumber, subtitle: a.activityDescription ?? undefined }))}
                              onSearchChange={setAuthSearch}
                              loading={authorizationsLoading}
                              disabled={!selectedClientId}
                              placeholder={!selectedClientId ? "Select participant first" : "Select authorization"}
                              emptyMessage={!selectedClientId ? "Select participant first" : "No authorizations found"}
                              data-testid={`select-line-${index}-authorization`}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="col-span-4">
                      <FormField control={form.control} name={`lineItems.${index}.serviceMonth`} render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs" htmlFor={`line-${index}-month`}>Service Month</FormLabel>
                          <FormControl>
                            <MonthYearInput id={`line-${index}-month`} value={field.value} onChange={field.onChange} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="col-span-2">
                      <FormField control={form.control} name={`lineItems.${index}.amount`} render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs" htmlFor={`line-${index}-amount`}>Amount</FormLabel>
                          <FormControl>
                            <div className="relative">
                              <span className="absolute left-2 top-2 text-muted-foreground text-sm">$</span>
                              <Input id={`line-${index}-amount`} className="pl-6 text-sm" placeholder="0.00" {...field} data-testid={`input-line-${index}-amount`} />
                            </div>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="col-span-11 space-y-2">
                      <Label className="text-xs">Line Document (Optional)</Label>
                      {form.watch(`lineItems.${index}.documentUrl`) ? (
                        <div className="flex items-center justify-between rounded-md border p-2 text-xs" data-testid={`text-line-${index}-document-attached`}>
                          <a className="text-primary hover:underline truncate" href={`/api/storage${form.watch(`lineItems.${index}.documentUrl`)}`} target="_blank" rel="noreferrer">
                            {form.watch(`lineItems.${index}.documentUrl`)}
                          </a>
                          <Button type="button" variant="ghost" size="sm" onClick={() => form.setValue(`lineItems.${index}.documentUrl`, null)} data-testid={`button-remove-line-${index}-document`}>Remove</Button>
                        </div>
                      ) : (
                        <div data-testid={`upload-line-${index}-document`}>
                          <FileUpload
                            label="Attach documentation for this authorization"
                            onUploaded={(r) => setLineDocument(field.id, r.objectPath)}
                            className="[&>div]:p-3"
                          />
                        </div>
                      )}
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
                  onClick={() => append({ authorizationId: '', serviceMonth: new Date().toISOString().substring(0, 7), amount: '', documentUrl: null })}
                  data-testid="button-add-line-item"
                >
                  <Plus className="w-4 h-4 mr-2" /> Add Line Item
                </Button>
              </div>

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="invoice-notes">Notes (Optional)</FormLabel>
                  <FormControl><Textarea id="invoice-notes" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <div className="space-y-2">
                <Label>Attach Document (Optional)</Label>
                {documentUrl ? (
                  <div className="flex items-center justify-between rounded-md border p-3 text-sm" data-testid="text-invoice-document-attached">
                    <span className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-muted-foreground" /> Document attached
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDocumentUrl(undefined)}
                      data-testid="button-remove-invoice-document"
                    >
                      Remove
                    </Button>
                  </div>
                ) : (
                  <div data-testid="upload-invoice-document">
                    <FileUpload
                      label="Drag & drop the invoice document here, or click to browse"
                      onUploaded={(r) => setDocumentUrl(r.objectPath)}
                    />
                  </div>
                )}
              </div>

              <Button type="submit" className="w-full" disabled={createInvoice.isPending}>
                <Save className="w-4 h-4 mr-2" />
                {createInvoice.isPending ? 'Submitting...' : 'Submit Invoice'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
