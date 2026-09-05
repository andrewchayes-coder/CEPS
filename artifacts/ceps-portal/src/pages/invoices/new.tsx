import React from 'react';
import { useForm } from 'react-hook-form';
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
import { ArrowLeft, Save, FileText } from 'lucide-react';
import { Link } from 'wouter';
import { FileUpload } from '@/components/file-upload';
import { useAuth } from '@/components/auth/auth-provider';
import { trackAnalyticsEvent } from '@/lib/analytics';
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';

const formSchema = z.object({
  clientId: z.string().min(1, 'Participant is required'),
  authorizationId: z.string().optional(),
  vendorId: z.string().optional(),
  serviceMonth: z.string().regex(/^\d{4}-\d{2}$/, 'Must be YYYY-MM format'),
  amountRequested: z.string().min(1, 'Amount is required'),
  paymentType: z.enum(['direct_payment', 'reimbursement']),
  notes: z.string().optional(),
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
      authorizationId: '',
      vendorId: '',
      serviceMonth: new Date().toISOString().substring(0, 7), // YYYY-MM
      amountRequested: '',
      paymentType: 'direct_payment',
      notes: ''
    }
  });

  const selectedClientId = form.watch('clientId');

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

  // On participant change clear authorization and vendor
  React.useEffect(() => {
    form.setValue('authorizationId', '');
    form.setValue('vendorId', '');
  }, [selectedClientId, form]);

  const handleAuthChange = (authId: string) => {
    form.setValue('authorizationId', authId);
    if (!authId || authId === 'none') return;

    const auth = filteredAuthorizations.find(a => a.id === authId);
    if (auth?.vendorId) {
      if (filteredVendors.some(v => v.id === auth.vendorId)) {
        form.setValue('vendorId', auth.vendorId);
      }
    }
  };

  const onSubmit = (data: z.infer<typeof formSchema>) => {
    createInvoice.mutate({
      data: {
        ...data,
        authorizationId: data.authorizationId === 'none' || data.authorizationId === '' ? undefined : data.authorizationId,
        vendorId: data.vendorId === 'none' || data.vendorId === '' ? undefined : data.vendorId,
        paymentType: data.paymentType as InvoiceInputPaymentType,
        documentUrl: documentUrl || undefined
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
                    <FormLabel>Participant</FormLabel>
                    <FormControl>
                      <SearchableSelect
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
                <FormField control={form.control} name="authorizationId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Authorization</FormLabel>
                    <FormControl>
                      <SearchableSelect
                        value={field.value ?? ''}
                        onValueChange={handleAuthChange}
                        options={filteredAuthorizations.map(a => ({ value: a.id, label: a.authNumber, subtitle: a.activityDescription ?? undefined }))}
                        onSearchChange={setAuthSearch}
                        loading={authorizationsLoading}
                        disabled={!selectedClientId}
                        placeholder={!selectedClientId ? "Select a participant first" : "Select authorization"}
                        emptyMessage={!selectedClientId ? "Select a participant first" : "No authorizations found"}
                        allowClear
                        clearLabel="None"
                        data-testid="select-invoice-authorization"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="vendorId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vendor</FormLabel>
                    <FormControl>
                      <SearchableSelect
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
                <FormField control={form.control} name="serviceMonth" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Service Month (YYYY-MM)</FormLabel>
                    <FormControl><Input type="month" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="paymentType" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Payment Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="direct_payment">Direct Payment</SelectItem>
                        <SelectItem value="reimbursement">Reimbursement</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <FormField control={form.control} name="amountRequested" render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount Requested</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                      <Input className="pl-7" placeholder="0.00" {...field} />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (Optional)</FormLabel>
                  <FormControl><Textarea {...field} /></FormControl>
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
                  <FileUpload
                    label="Drag & drop the invoice document here, or click to browse"
                    onUploaded={(r) => setDocumentUrl(r.objectPath)}
                  />
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
