import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useCreateAuthorization, useListClients, useListVendors, useParseAuthorizationPdf, AuthorizationInputServiceCode, AuthorizationInputPaymentType } from '@workspace/api-client-react';
import { useLocation } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Save, AlertTriangle, Sparkles, Loader2 } from 'lucide-react';
import { Link } from 'wouter';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { FileUpload } from '@/components/file-upload';

const formSchema = z.object({
  clientId: z.string().min(1, 'Client is required'),
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
  
  const { data: clientsData, isLoading: clientsLoading } = useListClients({ limit: 1000 });
  const { data: vendorsData, isLoading: vendorsLoading } = useListVendors({ limit: 1000 });
  const clients = clientsData?.items;
  const vendors = vendorsData?.items;
  const [warnings, setWarnings] = useState<string[]>([]);
  const parsePdf = useParseAuthorizationPdf();
  const [posPdfUrl, setPosPdfUrl] = useState<string | undefined>(undefined);
  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set());
  const [parseNote, setParseNote] = useState<string | null>(null);

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

  // Auto-set payment type based on service code
  React.useEffect(() => {
    if (serviceCode === '459') setValue('paymentType', 'direct_payment');
    if (serviceCode === '024') setValue('paymentType', 'reimbursement');
    if (serviceCode === '490') setValue('paymentType', 'fee');
  }, [serviceCode, setValue]);

  const handlePosFile = (file: File) => {
    setParseNote(null);
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] ?? '';
      parsePdf.mutate(
        { data: { pdfBase64: base64, fileName: file.name } },
        {
          onSuccess: (res) => {
            if (!res.success || !res.fields) {
              setParseNote(res.error || 'Could not extract fields from this PDF. Enter the details manually.');
              return;
            }
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
            // Try to match the extracted client name against the client list
            if (f.clientName && clients) {
              const target = f.clientName!.trim().toLowerCase();
              const match = clients.find(
                (c) => `${c.firstName} ${c.lastName}`.trim().toLowerCase() === target,
              );
              if (match) {
                setValue('clientId', match.id, { shouldValidate: true });
                filled.add('clientId');
              }
            }
            setAutoFilled(filled);
            setParseNote(
              f.clientName && !filled.has('clientId')
                ? `PDF parsed. Could not match client "${f.clientName}" automatically — please select the client manually.`
                : 'PDF parsed. Review every auto-filled field before saving.',
            );
            toast({ title: 'POS PDF Parsed', description: 'Fields were pre-filled from the PDF. Please review them.' });
          },
          onError: () => {
            setParseNote('PDF parsing failed. You can still enter the authorization manually.');
          },
        },
      );
    };
    reader.readAsDataURL(file);
  };

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
        paymentType: data.paymentType as AuthorizationInputPaymentType
      }
    }, {
      onSuccess: (res) => {
        if (!res.saved && res.warnings && res.warnings.length > 0) {
          // Validation warning returned from server, require explicit acceptance
          setWarnings(res.warnings);
          toast({
            variant: "destructive",
            title: "Data Quality Warning",
            description: "Please review the warnings before forcing save.",
          });
        } else {
          toast({
            title: "Authorization Created",
            description: "The POS has been saved successfully.",
          });
          setLocation('/authorizations');
        }
      },
      onError: (err: any) => {
        toast({
          variant: "destructive",
          title: "Error",
          description: err?.data?.message || "Failed to create authorization.",
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
            onUploaded={(r) => setPosPdfUrl(r.objectPath)}
          />
          {parsePdf.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-parsing">
              <Loader2 className="h-4 w-4 animate-spin" /> Extracting fields from the PDF…
            </p>
          )}
          {parseNote && !parsePdf.isPending && (
            <p className="text-sm text-muted-foreground" data-testid="text-parse-note">{parseNote}</p>
          )}
        </CardContent>
      </Card>

      <Card>
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
                    <FormControl><Input placeholder="e.g. 12345678" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="serviceCode" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Service Code<AutoBadge name="serviceCode" /></FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
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
                    <FormLabel>Client<AutoBadge name="clientId" /></FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={clientsLoading ? "Loading..." : "Select client"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {clients?.map(c => (
                          <SelectItem key={c.id} value={c.id}>{c.firstName} {c.lastName} ({c.uciNumber})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="vendorId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vendor</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={vendorsLoading ? "Loading..." : "Select vendor"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {vendors?.map(v => (
                          <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="servicePeriodStart" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Period Start Date<AutoBadge name="servicePeriodStart" /></FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="servicePeriodEnd" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Period End Date<AutoBadge name="servicePeriodEnd" /></FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
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
                          <Input className="pl-7" placeholder="0.00" {...field} />
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
                          <Input className="pl-7" placeholder="0.00" {...field} />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={createAuth.isPending}>
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
