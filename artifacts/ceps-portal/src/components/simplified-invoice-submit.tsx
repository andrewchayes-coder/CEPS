import { useQueryClient } from '@tanstack/react-query';
import { invalidateInvoiceQueries } from '@/lib/invoice-query-cache';
import React from 'react';
import { getGetClientQueryKey, useCreateInvoice, useGetClient, useListClients, useListVendors } from '@workspace/api-client-react';
import { useUpload } from '@workspace/object-storage-web';
import { ArrowLeft, CheckCircle2, FileText, Loader2, RotateCcw, Save, XCircle } from 'lucide-react';
import { Link } from 'wouter';
import { Label } from '@/components/ui/label';
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
import { validateServiceDateRange } from '@/lib/invoice-service-dates';
import { Input } from '@/components/ui/input';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const simplifiedInvoiceSchema = z.object({
  clientId: z.string().min(1, 'Participant is required'),
  vendorId: z.string().optional(),
  documentType: z.enum(['invoice', 'receipt']),
  notes: z.string().optional(),
  serviceStartDate: z.string(),
  serviceEndDate: z.string(),
}).superRefine((v, ctx) => {
  const err = validateServiceDateRange(v.serviceStartDate, v.serviceEndDate);
  if (err) ctx.addIssue({ code: 'custom', path: [!v.serviceStartDate || err.includes('start date') ? 'serviceStartDate' : 'serviceEndDate'], message: err });
});

type UploadEntry = {
  id: string;
  file: File;
  status: 'uploading' | 'attached' | 'upload_failed' | 'submitting' | 'submit_failed' | 'submitted';
  objectPath?: string;
  error?: string;
  submissionValues?: z.infer<typeof simplifiedInvoiceSchema>;
};

export function SimplifiedInvoiceSubmit() {
  const { toast } = useToast();
  const { user } = useAuth();
  const createInvoice = useCreateInvoice();
  const queryClient = useQueryClient();
  const { uploadFile } = useUpload();
  const [uploads, setUploads] = React.useState<UploadEntry[]>([]);
  const [submissionInProgress, setSubmissionInProgress] = React.useState(false);
  const submissionLock = React.useRef(false);
  const [clientSearch, setClientSearch] = React.useState('');
  const [vendorSearch, setVendorSearch] = React.useState('');
  const debouncedClientSearch = useDebounce(clientSearch, 300);
  const debouncedVendorSearch = useDebounce(vendorSearch, 300);
  const isCoordinator = user?.role === 'service_coordinator';
  const linkedClientId = !isCoordinator && user?.linkedRecordType === 'client' ? user.linkedRecordId ?? '' : '';
  const { data: linkedClient, isLoading: linkedLoading, isError: linkedError } = useGetClient(linkedClientId, {
    query: { enabled: !isCoordinator && !!linkedClientId, queryKey: getGetClientQueryKey(linkedClientId) },
  });
  const form = useForm<z.infer<typeof simplifiedInvoiceSchema>>({
    resolver: zodResolver(simplifiedInvoiceSchema),
    defaultValues: { clientId: '', vendorId: '', documentType: 'invoice', notes: '', serviceStartDate: '', serviceEndDate: '' },
  });
  const watchedClientId = form.watch('clientId');
  const selectedClientId = isCoordinator ? watchedClientId : linkedClientId;
  const { data: clientsData, isLoading: clientsLoading } = useListClients({ search: debouncedClientSearch, limit: 50 }, { query: { enabled: isCoordinator, queryKey: ['clients', 'simplified-invoice', debouncedClientSearch] } });
  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors(
    { clientId: selectedClientId, search: debouncedVendorSearch, limit: 50, invoiceEligible: 'true' },
    { query: { enabled: !!selectedClientId, queryKey: ['vendors', 'simplified-invoice', { clientId: selectedClientId, search: debouncedVendorSearch, limit: 50, invoiceEligible: 'true' }] } },
  );
  const clients = clientsData?.items ?? [];
  const vendors = vendorsData?.items ?? [];
  const uploadCounter = React.useRef(0);
  const isUploading = uploads.some((upload) => upload.status === 'uploading');
  const hasSubmitFailures = uploads.some((upload) => upload.status === 'submit_failed');

  React.useEffect(() => {
    form.setValue('vendorId', '');
  }, [selectedClientId, form]);

  React.useEffect(() => {
    if (!isCoordinator && linkedClientId) form.setValue('clientId', linkedClientId);
  }, [isCoordinator, linkedClientId, form]);

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

  const submitOne = async (entry: UploadEntry, values: z.infer<typeof simplifiedInvoiceSchema>) => {
    if (!entry.objectPath) return false;
    setUploads((current) => current.map((item) => item.id === entry.id ? { ...item, status: 'submitting', error: undefined } : item));
    try {
      await createInvoice.mutateAsync({
        data: {
          clientId: isCoordinator ? values.clientId : linkedClientId,
          serviceStartDate: values.serviceStartDate,
          serviceEndDate: values.serviceEndDate,
          ...(values.vendorId && values.vendorId !== 'none' ? { vendorId: values.vendorId } : {}),
          ...(values.notes ? { notes: values.notes } : {}),
          documentUrl: entry.objectPath,
          amountRequested: '0',
          documentType: values.documentType,
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

  const submit = async (values: z.infer<typeof simplifiedInvoiceSchema>, retryOnlyFailed = false) => {
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
        void invalidateInvoiceQueries(queryClient);
        trackAnalyticsEvent('invoice_created', { role: user?.role ?? 'unknown', status: 'needs_entry', count: succeeded });
        toast({
          title: 'Invoices submitted',
          description: `${succeeded} invoice${succeeded === 1 ? '' : 's'} submitted to CEPS for review.`,
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
        <p className="text-muted-foreground mt-1">Attach invoice documents for CEPS to review.</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Invoice Details</CardTitle></CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((values) => submit(values))} className="space-y-6">
              {!isCoordinator ? (
                <div className="space-y-2">
                  <Label>Participant</Label>
                  {!linkedClientId || linkedError ? (
                    <p className="text-sm text-destructive" role="alert" data-testid="text-invoice-unlinked">Your account is not linked to a participant record. Contact CEPS to submit invoices.</p>
                  ) : (
                    <Input value={linkedLoading ? 'Loading…' : linkedClient ? `${linkedClient.firstName} ${linkedClient.lastName}` : ''} readOnly disabled translate="no" className="notranslate" data-testid="text-invoice-participant" />
                  )}
                </div>
              ) : <FormField control={form.control} name="clientId" render={({ field }) => (
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
              )} />}
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
              <FormField control={form.control} name="documentType" render={({ field }) => (
                <FormItem>
                  <FormLabel id="coordinator-document-type-label">Document type <span className="text-destructive">*</span></FormLabel>
                  <FormControl>
                    <div role="radiogroup" aria-labelledby="coordinator-document-type-label" className="flex gap-4">
                      {(['invoice', 'receipt'] as const).map((t) => (
                        <label key={t} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="coordinator-document-type"
                            value={t}
                            checked={field.value === t}
                            onChange={() => field.onChange(t)}
                            disabled={submissionInProgress || hasSubmitFailures}
                            data-testid={`radio-document-type-${t}`}
                          />
                          {t === 'invoice' ? 'Invoice' : 'Receipt'}
                        </label>
                      ))}
                    </div>
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
                <div className="grid gap-4 sm:grid-cols-2">
                  {(['serviceStartDate', 'serviceEndDate'] as const).map((name) => (
                    <FormField key={name} control={form.control} name={name} render={({ field }) => (
                      <FormItem>
                        <FormLabel htmlFor={`simplified-${name}`}>{name === 'serviceStartDate' ? 'Service start date' : 'Service end date'} <span className="text-destructive">*</span></FormLabel>
                        <FormControl>
                          <Input id={`simplified-${name}`} type="date" value={field.value} onChange={field.onChange} onBlur={field.onBlur} disabled={submissionInProgress || hasSubmitFailures} data-testid={`input-${name}`} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">These dates apply to every file attached below. Submit invoices for different service periods separately.</p>
              </div>
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
              <Button type="submit" className="w-full" disabled={createInvoice.isPending || isUploading || submissionInProgress || hasSubmitFailures || readyCount === 0 || !selectedClientId || (!isCoordinator && !linkedClient)}>
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