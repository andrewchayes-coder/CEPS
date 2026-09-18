import React, { useState, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
    useCreateAuthorization,
    useListClients,
    useListVendors,
    useParseAuthorizationPdf,
    AuthorizationInputServiceCode,
    AuthorizationInputPaymentType,
    useMatchPosClient,
    useSaveUnmatchedPos,
    PosParseResultFields,
    PosMatchResultClient,
    PosMatchResult
} from '@workspace/api-client-react';
import { useLocation } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Save, AlertTriangle, Sparkles, Loader2, ArrowRight, CheckCircle } from 'lucide-react';
import { Link } from 'wouter';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { FileUpload } from '@/components/file-upload';
import { trackAnalyticsEvent } from '@/lib/analytics';
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';

type ApiErrorResponse = { data?: { error?: string; message?: string } };

const formSchema = z.object({
  clientId: z.string().min(1, 'Participant is required'),
  vendorId: z.string().optional(),
  authNumber: z.string().min(1, 'Authorization number is required'),
  serviceCode: z.enum(['459', '024', '490']),
  paymentType: z.enum(['direct_payment', 'reimbursement', 'fee']),
  activityDescription: z.string().optional(),
  servicePeriodStart: z.string().min(1, 'Start date is required'),
  servicePeriodEnd: z.string().min(1, 'End date is required'),
  monthlyAmount: z.string().optional(),
  oneTimeAmount: z.string().optional(),
  maxPeriodAmount: z.string().min(1, 'Max period amount is required'),
  acceptMaxAmountWarning: z.boolean().default(false)
});

export default function AuthorizationNewPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createAuth = useCreateAuthorization();
  const matchClient = useMatchPosClient();
  const saveUnmatched = useSaveUnmatchedPos();
  const parsePdf = useParseAuthorizationPdf();

  const [clientSearch, setClientSearch] = useState('');
  const debouncedClientSearch = useDebounce(clientSearch, 300);
  const { data: clientsData, isLoading: clientsLoading } = useListClients({ search: debouncedClientSearch, limit: 50 });
  const clients = clientsData?.items ?? [];

  const [vendorSearch, setVendorSearch] = useState('');
  const debouncedVendorSearch = useDebounce(vendorSearch, 300);
  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors({ search: debouncedVendorSearch, limit: 50 });
  const vendors = vendorsData?.items ?? [];

  const [warnings, setWarnings] = useState<string[]>([]);
  const [posPdfUrl, setPosPdfUrl] = useState<string | undefined>(undefined);
  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set());
  const [parseNote, setParseNote] = useState<string | null>(null);

  const [parsedFields, setParsedFields] = useState<PosParseResultFields | null>(null);
  const [matchResult, setMatchResult] = useState<PosMatchResult | null>(null);
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [matchedClient, setMatchedClient] = useState<PosMatchResultClient | null>(null);

  // Track unique file ID to prevent cross-contamination or duplicate autosaves
  const [isQueued, setIsQueued] = useState(false);
  const [queueSaveFailed, setQueueSaveFailed] = useState(false);
  const activeFileIdRef = useRef<string | null>(null);
  const queueingFileIdRef = useRef<string | null>(null);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      clientId: '',
      vendorId: '',
      authNumber: '',
      serviceCode: '459',
      paymentType: 'direct_payment',
      activityDescription: '',
      servicePeriodStart: '',
      servicePeriodEnd: '',
      monthlyAmount: '',
      oneTimeAmount: '',
      maxPeriodAmount: '',
      acceptMaxAmountWarning: false
    }
  });

  const { watch, setValue } = form;
  const serviceCode = watch('serviceCode');

  const allClientOptions = React.useMemo(() => {
    const opts = clients.map(c => ({ value: c.id, label: `${c.firstName} ${c.lastName} (${c.uciNumber})` }));
    if (matchedClient && matchedClient.id && !opts.find(o => o.value === matchedClient.id)) {
        opts.push({ value: matchedClient.id, label: `${matchedClient.firstName} ${matchedClient.lastName} (${matchedClient.uciNumber})` });
    }
    return opts;
  }, [clients, matchedClient]);

  // Auto-set payment type based on service code
  React.useEffect(() => {
    if (serviceCode === '459') setValue('paymentType', 'direct_payment');
    if (serviceCode === '024') setValue('paymentType', 'reimbursement');
    if (serviceCode === '490') setValue('paymentType', 'fee');
  }, [serviceCode, setValue]);

  const handlePosFile = (file: File) => {
    const fileId = `${file.name}-${Date.now()}`;
    activeFileIdRef.current = fileId;
    queueingFileIdRef.current = null;
    setFileName(file.name);
    setPosPdfUrl(undefined);
    setParsedFields(null);
    setMatchResult(null);
    setMatchedClient(null);
    setIsQueued(false);
    setQueueSaveFailed(false);
    setParseNote(null);
    setAutoFilled(new Set());
    setWarnings([]);
    form.reset({
      clientId: '',
      vendorId: '',
      authNumber: '',
      serviceCode: '459',
      paymentType: 'direct_payment',
      activityDescription: '',
      servicePeriodStart: '',
      servicePeriodEnd: '',
      monthlyAmount: '',
      oneTimeAmount: '',
      maxPeriodAmount: '',
      acceptMaxAmountWarning: false
    });

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] ?? '';
      parsePdf.mutate(
        { data: { pdfBase64: base64, fileName: file.name } },
        {
          onSuccess: async (res) => {
            if (activeFileIdRef.current !== fileId) return;
            if (!res.success || !res.fields) {
              setParseNote(res.error || 'Could not extract fields from this PDF. Enter the details manually.');
              return;
            }
            setParsedFields(res.fields);

            const f = res.fields;
            const filled = new Set<string>();
            const setIf = (name: keyof z.infer<typeof formSchema>, value: string | null | undefined) => {
              if (value != null && value !== '') {
                setValue(name, value as never, { shouldValidate: true });
                filled.add(name);
              }
            };
            setIf('authNumber', f.authNumber);
            if (f.serviceCode === '459' || f.serviceCode === '024' || f.serviceCode === '490') {
              setValue('serviceCode', f.serviceCode);
              filled.add('serviceCode');
            }
            setIf('activityDescription', f.activityDescription);
            setIf('servicePeriodStart', f.servicePeriodStart);
            setIf('servicePeriodEnd', f.servicePeriodEnd);
            setIf('monthlyAmount', f.monthlyAmount);
            setIf('maxPeriodAmount', f.maxPeriodAmount);
            setAutoFilled(filled);

            matchClient.mutate({ data: { clientName: f.clientName, uciNumber: f.uciNumber } }, {
                onSuccess: (match) => {
                    if (activeFileIdRef.current !== fileId) return;
                    setMatchResult(match);
                    if (match.method === 'uci' || match.method === 'name') {
                        setMatchedClient(match.client);
                        if (match.client && match.client.id) {
                          setValue('clientId', match.client.id, { shouldValidate: true });
                          setAutoFilled(prev => new Set(prev).add('clientId'));
                        }

                        if (match.method === 'uci') {
                            setParseNote(`High confidence match by UCI: Participant "${match.client?.firstName} ${match.client?.lastName}". Please review fields.`);
                            toast({ title: 'Matched by UCI', description: 'Participant auto-selected based on UCI number.' });
                        } else {
                            setParseNote(`Matched by name: Participant "${match.client?.firstName} ${match.client?.lastName}". Please verify this is the correct person.`);
                            toast({ title: 'Matched by Name', description: 'Please verify the participant selection.' });
                        }
                    } else {
                        setParseNote('Participant not found. Matching will complete after PDF upload finishes.');
                    }
                },
                onError: () => {
                    if (activeFileIdRef.current !== fileId) return;
                    setParseNote('Participant matching failed. You can still enter the authorization manually.');
                }
            });
          },
          onError: () => {
            if (activeFileIdRef.current !== fileId) return;
            setParseNote('PDF parsing failed. You can still enter the authorization manually.');
          },
        },
      );
    };
    reader.readAsDataURL(file);
  };

  React.useEffect(() => {
    // Only proceed to auto-save if all async dependencies are resolved for the CURRENT file,
    // it was not matched, and it hasn't been queued yet.
    if (
        matchResult &&
        matchResult.method === 'none' &&
        posPdfUrl &&
        parsedFields &&
        fileName &&
        activeFileIdRef.current &&
        !isQueued &&
        !queueSaveFailed &&
        queueingFileIdRef.current !== activeFileIdRef.current &&
        !saveUnmatched.isPending
    ) {
        const fileId = activeFileIdRef.current;
        queueingFileIdRef.current = fileId;
        setParseNote('Participant not found. Saving to Unmatched queue...');

        saveUnmatched.mutate({
            data: {
                posPdfUrl,
                sourceFileName: fileName,
                clientName: parsedFields.clientName,
                clientAddress: parsedFields.clientAddress,
                clientPhone: parsedFields.clientPhone,
                uciNumber: parsedFields.uciNumber,
                authNumber: parsedFields.authNumber,
                serviceCode: parsedFields.serviceCode,
                activityDescription: parsedFields.activityDescription,
                servicePeriodStart: parsedFields.servicePeriodStart,
                servicePeriodEnd: parsedFields.servicePeriodEnd,
                units: parsedFields.units,
                monthlyAmount: parsedFields.monthlyAmount,
                maxPeriodAmount: parsedFields.maxPeriodAmount,
                caseworkerName: parsedFields.caseworkerName,
            }
        }, {
            onSuccess: () => {
                if (activeFileIdRef.current !== fileId) return;
                setIsQueued(true);
                setParseNote('Participant could not be found. This POS has been safely queued for Unmatched processing.');
                toast({ title: 'Saved to Unmatched Queue', description: 'Participant not found. The POS document was safely queued.' });
            },
            onError: (err: unknown) => {
                if (activeFileIdRef.current !== fileId) return;
                queueingFileIdRef.current = null;
                setQueueSaveFailed(true);
                const apiErr = err as ApiErrorResponse;
                setParseNote('Failed to save to the unmatched queue. Retry before leaving this page so the POS is not lost.');
                toast({ variant: 'destructive', title: 'Queue Error', description: apiErr?.data?.error || apiErr?.data?.message || 'Could not save to unmatched queue.' });
            }
        });
    }
  }, [matchResult, posPdfUrl, parsedFields, fileName, saveUnmatched.isPending, saveUnmatched.mutate, isQueued, queueSaveFailed, toast]);

  const AutoBadge = ({ name }: { name: string }) =>
    autoFilled.has(name) ? (
      <Badge variant="secondary" className="ml-2 text-[10px] px-1.5 py-0" data-testid={`badge-autofilled-${name}`}>
        <Sparkles className="w-3 h-3 mr-0.5" /> From PDF
      </Badge>
    ) : null;

  const onSubmit = (data: z.infer<typeof formSchema>) => {
    createAuth.mutate({
      data: {
        ...data,
        posPdfUrl,
        serviceCode: data.serviceCode as AuthorizationInputServiceCode,
        paymentType: data.paymentType as AuthorizationInputPaymentType,
        vendorId: data.vendorId === 'none' ? undefined : data.vendorId
      }
    }, {
      onSuccess: (res) => {
        if (!res.saved && res.warnings && res.warnings.length > 0) {
          setWarnings(res.warnings);
          toast({
            variant: "destructive",
            title: "Data Quality Warning",
            description: "Please review the warnings before forcing save.",
          });
        } else {
          trackAnalyticsEvent('authorization_created', {
            payment_type: data.paymentType,
            service_code: data.serviceCode,
          });
          toast({
            title: "Authorization Created",
            description: "The POS has been saved successfully.",
          });
          setLocation('/authorizations');
        }
      },
      onError: (err: unknown) => {
        const apiErr = err as ApiErrorResponse;
        toast({
          variant: "destructive",
          title: "Error",
          description: apiErr?.data?.error || apiErr?.data?.message || "Failed to create authorization.",
        });
      }
    });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-20">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/authorizations"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Link>
      </Button>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">Manual POS Entry</h1>
        <p className="text-muted-foreground mt-1">Enter a new purchase of service authorization from Alta.</p>
      </div>

      {warnings.length > 0 && (
        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Data Quality Warning</AlertTitle>
          <AlertDescription className="space-y-4">
            <ul className="list-disc pl-4 mt-2">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
            <div className="flex items-center gap-2 pt-2">
              <Button size="sm" variant="outline" className="border-destructive/30 hover:bg-destructive/20"
                onClick={() => {
                  form.setValue('acceptMaxAmountWarning', true);
                  form.handleSubmit(onSubmit)();
                }}>
                Force Save Anyway
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setWarnings([])}>Cancel</Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {isQueued && (
        <Alert className="bg-muted border-primary/20">
          <CheckCircle className="h-4 w-4 text-primary" />
          <AlertTitle className="text-primary font-medium">Document safely queued</AlertTitle>
          <AlertDescription className="space-y-2 mt-2">
            <p>This POS document was added to the Unmatched Queue because a participant could not be reliably found. Please continue processing it from the queue rather than submitting it here to avoid creating duplicates.</p>
            <Button asChild size="sm" className="mt-2">
              <Link href="/authorizations/unmatched">
                Go to Unmatched Queue <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Upload POS PDF</CardTitle>
          <CardDescription>
            Upload the Alta POS document to auto-fill the form below. Review every extracted field —
            nothing is saved until you submit. Manual entry works exactly as before.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <FileUpload
            accept=".pdf"
            label="Drag & drop the POS PDF here, or click to browse"
            onFileSelected={handlePosFile}
            onUploaded={(r) => {
              if (activeFileIdRef.current) {
                setPosPdfUrl(r.objectPath);
              }
            }}
          />
          {(parsePdf.isPending || matchClient.isPending || saveUnmatched.isPending) && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-parsing">
              <Loader2 className="h-4 w-4 animate-spin" />
              {parsePdf.isPending ? 'Extracting fields from the PDF…' :
               matchClient.isPending ? 'Matching participant…' :
               'Saving to unmatched queue...'}
            </p>
          )}
          {parseNote && !parsePdf.isPending && !matchClient.isPending && !saveUnmatched.isPending && (
            <p className="text-sm text-muted-foreground" data-testid="text-parse-note">{parseNote}</p>
          )}
          {queueSaveFailed && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setQueueSaveFailed(false)}
              data-testid="button-retry-queue-save"
            >
              Retry saving to Unmatched Queue
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className={isQueued ? 'opacity-60 pointer-events-none' : ''}>
        <CardHeader>
          <CardTitle>Authorization Details</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="authNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel>POS Number<AutoBadge name="authNumber" /></FormLabel>
                    <FormControl><Input placeholder="e.g. 12345678" {...field} disabled={isQueued} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="serviceCode" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Service Code<AutoBadge name="serviceCode" /></FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value} disabled={isQueued}>
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="Select code" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="459">459 (Direct Pay)</SelectItem>
                        <SelectItem value="024">024 (Reimbursement)</SelectItem>
                        <SelectItem value="490">490 (FMS Fee)</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="clientId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Participant<AutoBadge name="clientId" /></FormLabel>
                    <FormControl>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        options={allClientOptions}
                        onSearchChange={setClientSearch}
                        loading={clientsLoading}
                        placeholder="Select participant"
                        data-testid="select-auth-client"
                        disabled={isQueued}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="vendorId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vendor</FormLabel>
                    <FormControl>
                      <SearchableSelect
                        value={field.value ?? ''}
                        onValueChange={field.onChange}
                        options={vendors.map(v => ({ value: v.id, label: v.name }))}
                        onSearchChange={setVendorSearch}
                        loading={vendorsLoading}
                        placeholder="Select vendor"
                        allowClear
                        clearLabel="None"
                        data-testid="select-auth-vendor"
                        disabled={isQueued}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="servicePeriodStart" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Period Start Date<AutoBadge name="servicePeriodStart" /></FormLabel>
                    <FormControl><Input type="date" {...field} disabled={isQueued} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="servicePeriodEnd" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Period End Date<AutoBadge name="servicePeriodEnd" /></FormLabel>
                    <FormControl><Input type="date" {...field} disabled={isQueued} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="bg-secondary/30 p-4 rounded-lg border space-y-4">
                <h3 className="text-sm font-medium">Financial Amounts</h3>
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="monthlyAmount" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Monthly Amount (Optional)<AutoBadge name="monthlyAmount" /></FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                          <Input className="pl-7" placeholder="0.00" {...field} disabled={isQueued} />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="maxPeriodAmount" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Max Period Amount<AutoBadge name="maxPeriodAmount" /></FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                          <Input className="pl-7" placeholder="0.00" {...field} disabled={isQueued} />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={createAuth.isPending || isQueued}>
                <Save className="w-4 h-4 mr-2" />
                {createAuth.isPending ? 'Saving...' : 'Save Authorization'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
