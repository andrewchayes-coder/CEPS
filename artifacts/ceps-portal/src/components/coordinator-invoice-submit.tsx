import React from 'react';
import { useCreateInvoice, useListClients, useListVendors } from '@workspace/api-client-react';
import { useUpload } from '@workspace/object-storage-web';
import { ArrowLeft, CheckCircle2, FileText, Loader2, RotateCcw, Save, XCircle } from 'lucide-react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormControl, FormField, FormItem, FormLabel, FormMessage, Form } from '@/components/ui/form';
import { SearchableSelect } from '@/components/searchable-select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { trackAnalyticsEvent } from '@/lib/analytics';
import { apiErrorMessage } from '@/lib/api-error';
import { useAuth } from '@/components/auth/auth-provider';
import { useDebounce } from '@/hooks/use-debounce';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const coordinatorSchema = z.object({
  clientId: z.string().min(1, 'Participant is required'),
  vendorId: z.string().optional(),
  notes: z.string().optional(),
});

type UploadEntry = {
  id: string;
  file: File;
  status: 'uploading' | 'attached' | 'upload_failed' | 'submitting' | 'submit_failed' | 'submitted';
  objectPath?: string;
  error?: string;
  submissionValues?: z.infer<typeof coordinatorSchema>;
};

export function CoordinatorInvoiceSubmit() {
  const { toast } = useToast();
  const { user } = useAuth();
  const createInvoice = useCreateInvoice();
  const { uploadFile } = useUpload();
  const [uploads, setUploads] = React.useState<UploadEntry[]>([]);
  const [submissionInProgress, setSubmissionInProgress] = React.useState(false);
  const submissionLock = React.useRef(false);
  const [clientSearch, setClientSearch] = React.useState('');
  const [vendorSearch, setVendorSearch] = React.useState('');
  const debouncedClientSearch = useDebounce(clientSearch, 300);
  const debouncedVendorSearch = useDebounce(vendorSearch, 300);
  const form = useForm<z.infer<typeof coordinatorSchema>>({
    resolver: zodResolver(coordinatorSchema),
    defaultValues: { clientId: '', vendorId: '', notes: '' },
  });
  const selectedClientId = form.watch('clientId');
  const { data: clientsData, isLoading: clientsLoading } = useListClients({ search: debouncedClientSearch, limit: 50 });
  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors(
    { clientId: selectedClientId, search: debouncedVendorSearch, limit: 50, invoiceEligible: 'true' },
    { query: { enabled: !!selectedClientId, queryKey: ['vendors', { clientId: selectedClientId, search: debouncedVendorSearch, limit: 50, invoiceEligible: 'true' }] } },
  );
  const clients = clientsData?.items ?? [];
  const vendors = vendorsData?.items ?? [];
  const uploadCounter = React.useRef(0);
  const isUploading = uploads.some((upload) => upload.status === 'uploading');
  const hasSubmitFailures = uploads.some((upload) => upload.status === 'submit_failed');

  React.useEffect(() => {
    form.setValue('vendorId', '');
  }, [selectedClientId, form]);

  const uploadSelectedFile = async (entry: UploadEntry) => {
    setUploads((current) => current.map((item) => item.id === entry.id ? { ...item, status: 'uploading', error: undefined } : item));
    try {
      const response = await uploadFile(entry.file);
      if (!response) throw new Error('Upload failed. Please try again.');
      setUploads((current) => current.map((item) => item.id === entry.id
        ? { ...item, status: 'attached', objectPath: response.objectPath, error: undefined }
        : item));
    } catch (error) {
      setUploads((current) => current.map((item) => item.id === entry.id
        ? { ...item, status: 'upload_failed', error: error instanceof Error ? error.message : 'Upload failed. Please try again.' }
        : item));
    }
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const entries: UploadEntry[] = Array.from(files).map((file) => ({
      id: `invoice-upload-${++uploadCounter.current}`,
      file,
      status: 'uploading',
    }));
    const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg'];
    const accepted = entries.filter(({ file }) => allowedTypes.includes(file.type) && file.size <= 10 * 1024 * 1024);
    const rejected = entries.length - accepted.length;
    if (rejected) {
      toast({ variant: 'destructive', title: 'Some files could not be added', description: 'Attach PDF, PNG, or JPG files up to 10MB each.' });
    }
    setUploads((current) => [...current, ...accepted]);
    accepted.forEach((entry) => { void uploadSelectedFile(entry); });
  };

  const submitOne = async (entry: UploadEntry, values: z.infer<typeof coordinatorSchema>) => {
    if (!entry.objectPath) return false;
    setUploads((current) => current.map((item) => item.id === entry.id ? { ...item, status: 'submitting', error: undefined } : item));
    try {
      await createInvoice.mutateAsync({
        data: {
          clientId: values.clientId,
          ...(values.vendorId && values.vendorId !== 'none' ? { vendorId: values.vendorId } : {}),
          ...(values.notes ? { notes: values.notes } : {}),
          documentUrl: entry.objectPath,
          amountRequested: '0',
          paymentType: 'direct_payment',
        },
      });
      setUploads((current) => current.map((item) => item.id === entry.id
        ? { ...item, status: 'submitted', submissionValues: undefined, error: undefined }
        : item));
      return true;
    } catch (error) {
      const message = apiErrorMessage(error, 'Invoice submission failed.');
      setUploads((current) => current.map((item) => item.id === entry.id
        ? { ...item, status: 'submit_failed', error: message, submissionValues: { ...values } }
        : item));
      return false;
    }
  };

  const submit = async (values: z.infer<typeof coordinatorSchema>, retryOnlyFailed = false) => {
    if (submissionLock.current || (hasSubmitFailures && !retryOnlyFailed)) return;
    const eligible = uploads.filter((entry) => entry.objectPath && (retryOnlyFailed
      ? entry.status === 'submit_failed'
      : entry.status === 'attached' || entry.status === 'submit_failed'));
    if (!eligible.length) return;
    const snapshot = { ...values };
    submissionLock.current = true;
    setSubmissionInProgress(true);
    try {
      const results = await Promise.all(eligible.map((entry) => submitOne(entry, entry.submissionValues ?? snapshot)));
      const succeeded = results.filter(Boolean).length;
      if (succeeded > 0) {
        trackAnalyticsEvent('invoice_created', { role: user?.role ?? 'unknown', status: 'needs_entry', count: succeeded });
        toast({
          title: 'Invoices submitted',
          description: `${succeeded} invoice${succeeded === 1 ? '' : 's'} submitted to CEPS for entry.`,
        });
      }
      if (succeeded < results.length) {
        toast({ variant: 'destructive', title: 'Some invoices need retry', description: 'Successful submissions were kept. Retry only the failed invoices below.' });
      }
    } finally {
      submissionLock.current = false;
      setSubmissionInProgress(false);
    }
  };

  const retryFailed = form.handleSubmit((values) => submit(values, true));
  const readyCount = uploads.filter((entry) => entry.status === 'attached' || entry.status === 'submit_failed').length;

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-20">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/invoices"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Link>
      </Button>
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Submit Invoice</h1>
        <p className="text-muted-foreground mt-1">Attach invoice documents for CEPS to enter and review.</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Invoice Details</CardTitle></CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((values) => submit(values))} className="space-y-6">
              <FormField control={form.control} name="clientId" render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="coordinator-invoice-client">Participant</FormLabel>
                  <FormControl>
                    <SearchableSelect
                      id="coordinator-invoice-client"
                      value={field.value}
                      onValueChange={field.onChange}
                      options={clients.map((client) => ({ value: client.id, label: `${client.firstName} ${client.lastName}` }))}
                      onSearchChange={setClientSearch}
                      loading={clientsLoading}
                      disabled={submissionInProgress || hasSubmitFailures}
                      placeholder="Select participant"
                      data-testid="select-coordinator-invoice-client"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="vendorId" render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="coordinator-invoice-vendor">Vendor (Optional)</FormLabel>
                  <FormControl>
                    <SearchableSelect
                      id="coordinator-invoice-vendor"
                      value={field.value ?? ''}
                      onValueChange={field.onChange}
                      options={vendors.map((vendor) => ({ value: vendor.id, label: vendor.name }))}
                      onSearchChange={setVendorSearch}
                      loading={vendorsLoading}
                      disabled={!selectedClientId || submissionInProgress || hasSubmitFailures}
                      placeholder={!selectedClientId ? 'Select a participant first' : 'Select vendor'}
                      emptyMessage={!selectedClientId ? 'Select a participant first' : 'No linked vendors found'}
                      allowClear
                      clearLabel="None"
                      data-testid="select-coordinator-invoice-vendor"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="coordinator-invoice-notes">Notes (Optional)</FormLabel>
                  <FormControl><Textarea id="coordinator-invoice-notes" {...field} disabled={submissionInProgress || hasSubmitFailures} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="space-y-3">
                <label htmlFor="coordinator-invoice-files" className="text-sm font-medium">Attach invoice(s) <span className="text-destructive">*</span></label>
                <p className="text-sm text-muted-foreground">Select one or more PDF, PNG, or JPG invoice documents. Each attached file is submitted as a separate invoice.</p>
                <input
                  id="coordinator-invoice-files"
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg"
                  multiple
                  disabled={isUploading || createInvoice.isPending || submissionInProgress || hasSubmitFailures}
                  onChange={(event) => {
                    addFiles(event.target.files);
                    event.target.value = '';
                  }}
                  className="block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-secondary file:px-4 file:py-2 file:font-medium"
                  data-testid="input-coordinator-invoice-files"
                />
                {uploads.length > 0 && (
                  <ul className="space-y-2" aria-label="Attached invoice files">
                    {uploads.map((entry) => (
                      <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm" data-testid={`coordinator-invoice-file-${entry.id}`}>
                        <span className="flex items-center gap-2">
                          {entry.status === 'uploading' || entry.status === 'submitting'
                            ? <Loader2 className="h-4 w-4 animate-spin text-primary" />
                            : entry.status === 'submitted'
                              ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                              : entry.status === 'upload_failed' || entry.status === 'submit_failed'
                                ? <XCircle className="h-4 w-4 text-destructive" />
                                : <FileText className="h-4 w-4 text-muted-foreground" />}
                          <span>{entry.file.name}</span>
                          <span className="text-muted-foreground">
                            {entry.status === 'uploading' ? 'Uploading…'
                              : entry.status === 'attached' ? 'Ready to submit'
                                : entry.status === 'submitting' ? 'Submitting…'
                                  : entry.status === 'submitted' ? 'Submitted to CEPS'
                                    : entry.error}
                          </span>
                        </span>
                        {entry.status === 'upload_failed' && (
                  <Button type="button" variant="outline" size="sm" onClick={() => void uploadSelectedFile(entry)} disabled={isUploading || submissionInProgress || hasSubmitFailures}>
                            <RotateCcw className="mr-2 h-4 w-4" /> Retry upload
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {uploads.length === 0 && <p className="text-sm text-destructive" role="alert">At least one invoice document is required.</p>}
              </div>
              {hasSubmitFailures && (
                <Button type="button" variant="outline" className="w-full" onClick={() => void retryFailed()} disabled={createInvoice.isPending || isUploading || submissionInProgress}>
                  <RotateCcw className="mr-2 h-4 w-4" /> Retry failed invoice submissions
                </Button>
              )}
              <Button type="submit" className="w-full" disabled={createInvoice.isPending || isUploading || submissionInProgress || hasSubmitFailures || readyCount === 0 || !selectedClientId}>
                <Save className="w-4 h-4 mr-2" />
                {createInvoice.isPending ? 'Submitting…' : 'Submit Invoice(s)'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}