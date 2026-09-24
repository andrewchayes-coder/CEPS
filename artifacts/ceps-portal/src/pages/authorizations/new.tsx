import React, { useState, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
    useCreateAuthorization,
    useListClients,
    useListVendors,
    getListVendorsQueryKey,
    useParseAuthorizationPdf,
    AuthorizationInputServiceCode,
    AuthorizationInputPaymentType,
    useMatchPosClient,
    useSaveUnmatchedPos,
    PosParseResultFields,
    PosMatchResultClient,
    PosMatchResult,
    useLookupAuthorization,
    getLookupAuthorizationQueryKey,
    useAmendAuthorization
} from '@workspace/api-client-react';
import { useLocation } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Save, AlertTriangle, Sparkles, Loader2, ArrowRight, CheckCircle, FileEdit, CheckSquare } from 'lucide-react';
import { Link } from 'wouter';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { FileUpload } from '@/components/file-upload';
import { trackAnalyticsEvent } from '@/lib/analytics';
import { apiErrorMessage } from '@/lib/api-error';
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';

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
  posNotes: z.string().optional(),
  acceptMaxAmountWarning: z.boolean().default(false)
});

export default function AuthorizationNewPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createAuth = useCreateAuthorization();
  const matchClient = useMatchPosClient();
  const saveUnmatched = useSaveUnmatchedPos();
  const parsePdf = useParseAuthorizationPdf();
  const amendAuth = useAmendAuthorization();

  const [clientSearch, setClientSearch] = useState('');
  const debouncedClientSearch = useDebounce(clientSearch, 300);
  const { data: clientsData, isLoading: clientsLoading } = useListClients({ search: debouncedClientSearch, limit: 50 });
  const clients = clientsData?.items ?? [];

  const [vendorSearch, setVendorSearch] = useState('');
  const debouncedVendorSearch = useDebounce(vendorSearch, 300);
  const [showAllVendors, setShowAllVendors] = useState(false);

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
  const [activeUploadId, setActiveUploadId] = useState<string | null>(null);
  const isUploadPending = activeUploadId === activeFileIdRef.current && activeFileIdRef.current !== null;

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
      posNotes: '',
      acceptMaxAmountWarning: false
    }
  });

  const { watch, setValue } = form;
  const serviceCode = watch('serviceCode');
  const watchClientId = watch('clientId');
  const watchVendorId = watch('vendorId');
  const watchAuthNumber = watch('authNumber');
  const vendorParams = {
    ...(watchClientId && !showAllVendors ? { clientId: watchClientId } : {}),
    search: debouncedVendorSearch,
    limit: 50,
  };
  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors(vendorParams, {
    query: {
      enabled: !!watchClientId,
      queryKey: getListVendorsQueryKey(vendorParams),
    },
  });
  const vendors = vendorsData?.items ?? [];
  const previousClientId = useRef(watchClientId);
  const pendingVendorPreselection = useRef<string | null>(null);

  const handleClientChange = (clientId: string) => {
    if (form.getValues('clientId') !== clientId) {
      previousClientId.current = clientId;
      pendingVendorPreselection.current = clientId || null;
      setValue('vendorId', '', { shouldDirty: true, shouldValidate: true });
      setShowAllVendors(false);
    }
    setValue('clientId', clientId, { shouldDirty: true, shouldValidate: true });
  };

  React.useEffect(() => {
    // Keep programmatic client selection (including POS matching) in sync with
    // the same dependent-field behavior as the participant picker.
    if (previousClientId.current === watchClientId) return;
    previousClientId.current = watchClientId;
    pendingVendorPreselection.current = watchClientId || null;
    setValue('vendorId', '', { shouldDirty: true, shouldValidate: true });
    setShowAllVendors(false);
  }, [watchClientId, setValue]);

  React.useEffect(() => {
    const clientToPreselect = pendingVendorPreselection.current;
    if (
      !clientToPreselect ||
      clientToPreselect !== watchClientId ||
      showAllVendors ||
      vendorsLoading
    ) return;

    pendingVendorPreselection.current = null;
    if (vendors.length === 1 && !watchVendorId) {
      setValue('vendorId', vendors[0].id, { shouldDirty: true, shouldValidate: true });
    }
  }, [watchClientId, watchVendorId, showAllVendors, vendors, vendorsLoading, setValue]);

  const currentDiffFingerprint = JSON.stringify({
    servicePeriodStart: watch('servicePeriodStart'),
    servicePeriodEnd: watch('servicePeriodEnd'),
    monthlyAmount: watch('monthlyAmount'),
    maxPeriodAmount: watch('maxPeriodAmount'),
    posNotes: watch('posNotes'),
    posPdfUrl
  });

  const debouncedClientId = useDebounce(watchClientId, 300);
  const debouncedAuthNumber = useDebounce(watchAuthNumber, 300);
  const trimmedAuthNumber = debouncedAuthNumber.trim();

  const isSyncingPair = watchClientId !== debouncedClientId || watchAuthNumber !== debouncedAuthNumber;

  const isLookupEnabled = !!debouncedClientId && trimmedAuthNumber.length > 0 && !isQueued;
  const { data: lookupResult, isFetching: isCheckingLookup } = useLookupAuthorization(
    { clientId: debouncedClientId, authNumber: debouncedAuthNumber },
    {
      query: {
        enabled: isLookupEnabled,
        staleTime: 0,
        queryKey: getLookupAuthorizationQueryKey({ clientId: debouncedClientId, authNumber: debouncedAuthNumber })
      }
    }
  );

  const isAmendment = !isSyncingPair && !!(lookupResult?.exists && lookupResult.authorization);
  const existingAuth = !isSyncingPair ? lookupResult?.authorization : null;
  const [confirmedFingerprint, setConfirmedFingerprint] = useState<string | null>(null);
  const isAmendmentConfirmed = confirmedFingerprint === currentDiffFingerprint;

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
    setActiveUploadId(fileId);
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
    setConfirmedFingerprint(null);
    setShowAllVendors(false);
    pendingVendorPreselection.current = null;
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
      posNotes: '',
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
            setIf('posNotes', f.posNotes);
            setAutoFilled(filled);

            matchClient.mutate({ data: { clientName: f.clientName, uciNumber: f.uciNumber } }, {
                onSuccess: (match) => {
                    if (activeFileIdRef.current !== fileId) return;
                    setMatchResult(match);
                    if (match.method === 'uci' || match.method === 'name') {
                        setMatchedClient(match.client);
                        if (match.client && match.client.id) {
                          handleClientChange(match.client.id);
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
    return fileId;
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
                posNotes: parsedFields.posNotes,
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
                setParseNote('Failed to save to the unmatched queue. Retry before leaving this page so the POS is not lost.');
                toast({ variant: 'destructive', title: 'Queue Error', description: apiErrorMessage(err, 'Could not save to unmatched queue.') });
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
    if (isAmendment && existingAuth) {
      if (!isAmendmentConfirmed) {
        toast({ variant: "destructive", title: "Confirmation Required", description: "You must confirm the amendment changes." });
        return;
      }
      amendAuth.mutate({
        id: existingAuth.id,
        data: {
          servicePeriodStart: data.servicePeriodStart,
          servicePeriodEnd: data.servicePeriodEnd,
          monthlyAmount: data.monthlyAmount || null,
          maxPeriodAmount: data.maxPeriodAmount,
          posNotes: data.posNotes || null,
          ...(posPdfUrl ? { posPdfUrl } : {}),
          confirmed: true,
          acceptMaxAmountWarning: data.acceptMaxAmountWarning,
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
            trackAnalyticsEvent('authorization_amended', {
              authorization_id: existingAuth.id,
            });
            toast({
              title: "Authorization Amended",
              description: "The authorization has been successfully amended.",
            });
            setLocation(`/authorizations/${existingAuth.id}`);
          }
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Error",
            description: apiErrorMessage(err, "Failed to amend authorization."),
          });
        }
      });
      return;
    }

    createAuth.mutate({
      data: {
        ...data,
        posPdfUrl,
        serviceCode: data.serviceCode as AuthorizationInputServiceCode,
        paymentType: data.paymentType as AuthorizationInputPaymentType,
        vendorId: data.vendorId === 'none' ? undefined : data.vendorId,
        posNotes: data.posNotes || null,
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
          setLocation(res.authorization ? `/authorizations/${res.authorization.id}` : '/authorizations');
        }
      },
      onError: (err: unknown) => {
        toast({
          variant: "destructive",
          title: "Error",
          description: apiErrorMessage(err, "Failed to create authorization."),
        });
      }
    });
  };

  const DiffRow = ({ label, current, proposed }: { label: string, current: string | null | undefined, proposed: string | null | undefined }) => {
    const isChanged = current !== proposed;
    return (
      <div className="grid grid-cols-3 gap-4 py-2 border-b last:border-0 text-sm">
        <div className="text-muted-foreground font-medium">{label}</div>
        <div className="text-muted-foreground">{current || '—'}</div>
        <div className={`font-medium ${isChanged ? 'text-chart-1 font-bold' : ''}`}>
          {proposed || '—'}
          {isChanged && <span className="ml-2 text-[10px] uppercase tracking-wider bg-chart-1/10 text-chart-1 px-1.5 py-0.5 rounded">Changed</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-20">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/authorizations"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Link>
      </Button>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          {isAmendment ? 'Amend Authorization' : 'Manual POS Entry'}
        </h1>
        <p className="text-muted-foreground mt-1">
          {isAmendment
            ? 'An authorization with this POS number already exists for this participant. Review the changes below to amend it.'
            : 'Enter a new purchase of service authorization from Alta.'}
        </p>
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
            onUploadError={(_, uploadId) => {
              if (uploadId === activeFileIdRef.current) {
                setActiveUploadId(null);
                setPosPdfUrl(undefined);
              }
            }}
            onUploaded={(r) => {
              if (r.uploadId === activeFileIdRef.current) {
                setPosPdfUrl(r.objectPath);
                setActiveUploadId(null);
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
          <div className="flex justify-between items-center">
            <CardTitle>{isAmendment ? 'Proposed Details' : 'Authorization Details'}</CardTitle>
            {isCheckingLookup && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          </div>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="authNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel>POS Number<AutoBadge name="authNumber" /></FormLabel>
                    <FormControl><Input placeholder="e.g. 12345678" {...field} disabled={isQueued || isAmendment} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="serviceCode" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Service Code<AutoBadge name="serviceCode" /></FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value} disabled={isQueued || isAmendment}>
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
                        onValueChange={handleClientChange}
                        options={allClientOptions}
                        onSearchChange={setClientSearch}
                        loading={clientsLoading}
                        placeholder="Select participant"
                        data-testid="select-auth-client"
                        disabled={isQueued || isAmendment}
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
                        placeholder={watchClientId ? 'Select vendor' : 'Select a participant first'}
                        allowClear
                        clearLabel="None"
                        data-testid="select-auth-vendor"
                        disabled={isQueued || isAmendment || !watchClientId}
                      />
                    </FormControl>
                    <FormMessage />
                    <div className="flex items-center gap-2 pt-1">
                      <Checkbox
                        id="show-all-auth-vendors"
                        checked={showAllVendors}
                        onCheckedChange={(checked) => setShowAllVendors(checked === true)}
                        disabled={!watchClientId || isQueued || isAmendment}
                        data-testid="checkbox-show-all-auth-vendors"
                      />
                      <label htmlFor="show-all-auth-vendors" className="text-sm text-muted-foreground">
                        Show all vendors
                      </label>
                    </div>
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
                      <div className="relative">
                        <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                        <FormControl>
                          <Input className="pl-7" placeholder="0.00" {...field} disabled={isQueued} />
                        </FormControl>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="maxPeriodAmount" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Max Period Amount<AutoBadge name="maxPeriodAmount" /></FormLabel>
                      <div className="relative">
                        <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                        <FormControl>
                          <Input className="pl-7" placeholder="0.00" {...field} disabled={isQueued} />
                        </FormControl>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              <FormField control={form.control} name="posNotes" render={({ field }) => (
                <FormItem>
                  <FormLabel>POS Notes<AutoBadge name="posNotes" /></FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Add any notes from the POS here..."
                      className="min-h-[80px]"
                      {...field}
                      disabled={isQueued}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              {isAmendment && existingAuth && (
                <div className="mt-8 border rounded-lg overflow-hidden border-primary/20">
                  <div className="bg-primary/5 px-4 py-3 border-b border-primary/20">
                    <h3 className="font-semibold text-primary flex items-center gap-2">
                      <FileEdit className="w-4 h-4" /> Amendment Summary
                    </h3>
                  </div>
                  <div className="p-4 space-y-2">
                    <div className="grid grid-cols-3 gap-4 pb-2 border-b text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                      <div>Field</div>
                      <div>Current</div>
                      <div>Proposed</div>
                    </div>

                    <DiffRow label="Start Date" current={existingAuth.servicePeriodStart?.slice(0, 10)} proposed={form.watch('servicePeriodStart')} />
                    <DiffRow label="End Date" current={existingAuth.servicePeriodEnd?.slice(0, 10)} proposed={form.watch('servicePeriodEnd')} />
                    <DiffRow label="Monthly Amount" current={existingAuth.monthlyAmount} proposed={form.watch('monthlyAmount')} />
                    <DiffRow label="Max Period Amount" current={existingAuth.maxPeriodAmount} proposed={form.watch('maxPeriodAmount')} />
                    <DiffRow label="POS Notes" current={existingAuth.posNotes} proposed={form.watch('posNotes')} />
                    <DiffRow
                      label="POS PDF"
                      current={existingAuth.posPdfUrl ? 'Existing PDF' : 'None'}
                      proposed={posPdfUrl ? 'New PDF uploaded' : (existingAuth.posPdfUrl ? 'Existing PDF' : 'None')}
                    />

                    <div className="pt-4 mt-2">
                      <div className="flex items-start space-x-3 bg-secondary/20 p-4 rounded-md border">
                        <Checkbox
                          id="confirm-amendment"
                          checked={isAmendmentConfirmed}
                          onCheckedChange={(checked) => setConfirmedFingerprint(checked ? currentDiffFingerprint : null)}
                          className="mt-0.5"
                        />
                        <div className="grid gap-1.5 leading-none">
                          <label
                            htmlFor="confirm-amendment"
                            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                          >
                            Confirm Amendment
                          </label>
                          <p className="text-sm text-muted-foreground">
                            I verify that these changes reflect the new POS document.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={
                  createAuth.isPending ||
                  amendAuth.isPending ||
                  isQueued ||
                  isCheckingLookup ||
                  isUploadPending ||
                  isSyncingPair ||
                  !!(isAmendment && !isAmendmentConfirmed)
                }
              >
                {isAmendment ? (
                  <>
                    <CheckSquare className="w-4 h-4 mr-2" />
                    {amendAuth.isPending ? 'Applying Amendment...' : 'Apply Amendment'}
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4 mr-2" />
                    {createAuth.isPending ? 'Saving...' : 'Save Authorization'}
                  </>
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
