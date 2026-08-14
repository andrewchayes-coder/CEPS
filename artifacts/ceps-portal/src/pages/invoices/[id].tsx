import React, { useState, useEffect } from 'react';
import { useLocation, useParams } from 'wouter';
import { useGetInvoice, useValidateInvoice, useUpdateInvoice, InvoiceValidationResult } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, CheckCircle2, XCircle, AlertTriangle, ShieldCheck } from 'lucide-react';
import { Link } from 'wouter';
import { Textarea } from '@/components/ui/textarea';

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [justification, setJustification] = useState('');
  
  const { data: invoice, isLoading, refetch } = useGetInvoice(id, {
    query: { enabled: !!id, queryKey: ['invoice', id] }
  });

  const [validation, setValidation] = useState<InvoiceValidationResult | null>(null);
  const validateInvoiceMutation = useValidateInvoice();
  const validating = validateInvoiceMutation.isPending;

  const runValidation = () => {
    if (id) {
      validateInvoiceMutation.mutate({ id }, {
        onSuccess: (data) => setValidation(data),
      });
    }
  };

  useEffect(() => {
    runValidation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const updateInvoice = useUpdateInvoice();

  if (isLoading) return <div className="p-8 text-center">Loading invoice...</div>;
  if (!invoice) return <div className="p-8 text-center">Invoice not found.</div>;

  const needsOverride = validation?.checks.some(c => !c.passed && c.check === 'No duplicate payments');

  const handleAction = (status: 'approved' | 'rejected', overrideDuplicate?: boolean) => {
    if (overrideDuplicate && !justification) {
      toast({ variant: 'destructive', title: 'Justification Required', description: 'Please provide a justification for overriding the duplicate payment warning.'});
      return;
    }

    updateInvoice.mutate({
      id,
      data: { status, notes: justification ? `OVERRIDE: ${justification}` : undefined }
    }, {
      onSuccess: () => {
        toast({ title: `Invoice ${status === 'approved' ? 'Approved' : 'Rejected'}` });
        refetch();
        runValidation();
      }
    });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/invoices"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Link>
      </Button>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Invoice Review</h1>
          <p className="text-muted-foreground mt-1">Service Month: {invoice.serviceMonth}</p>
        </div>
        <Badge className="text-base px-3 py-1 uppercase">{invoice.status.replace('_', ' ')}</Badge>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Invoice Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid grid-cols-3 gap-2">
              <dt className="text-muted-foreground">Client:</dt><dd className="col-span-2 font-medium">{invoice.clientName}</dd>
              <dt className="text-muted-foreground">Vendor:</dt><dd className="col-span-2">{invoice.vendorName}</dd>
              <dt className="text-muted-foreground">Auth Number:</dt><dd className="col-span-2 font-mono">{invoice.authNumber}</dd>
              <dt className="text-muted-foreground">Amount:</dt><dd className="col-span-2 font-bold text-lg">${parseFloat(invoice.amountRequested).toFixed(2)}</dd>
              <dt className="text-muted-foreground mt-2">Submitted By:</dt><dd className="col-span-2 mt-2 capitalize">{invoice.submittedByRole}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card className={validation?.valid ? 'border-chart-5/50' : 'border-destructive/50'}>
          <CardHeader className="bg-muted/30 pb-4">
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-primary" /> System Validation
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            {validating ? (
              <div className="text-center text-muted-foreground">Running checks...</div>
            ) : (
              <ul className="space-y-3">
                {validation?.checks.map((check, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm">
                    {check.passed ? 
                      <CheckCircle2 className="w-5 h-5 text-chart-5 shrink-0" /> : 
                      <XCircle className="w-5 h-5 text-destructive shrink-0" />
                    }
                    <div>
                      <p className={`font-medium ${check.passed ? 'text-foreground' : 'text-destructive'}`}>{check.check}</p>
                      <p className="text-muted-foreground text-xs mt-0.5">{check.message}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {invoice.status === 'pending_review' && (
              <div className="pt-4 border-t space-y-4">
                {needsOverride && (
                  <div className="space-y-3 bg-destructive/10 p-3 rounded-md border border-destructive/20">
                    <div className="flex gap-2 text-destructive font-medium text-sm">
                      <AlertTriangle className="w-4 h-4 shrink-0" /> Duplicate Payment Detected
                    </div>
                    <Textarea 
                      placeholder="Required: Provide justification to override duplicate payment stop..."
                      value={justification}
                      onChange={(e: any) => setJustification(e.target.value)}
                      className="bg-background text-sm"
                    />
                  </div>
                )}
                
                <div className="flex gap-2">
                  <Button 
                    className="w-full bg-chart-5 hover:bg-chart-5/90 text-white" 
                    disabled={updateInvoice.isPending || (needsOverride && !justification) || (!validation?.valid && !needsOverride)}
                    onClick={() => handleAction('approved', needsOverride)}
                  >
                    Approve
                  </Button>
                  <Button 
                    className="w-full" 
                    variant="destructive"
                    disabled={updateInvoice.isPending}
                    onClick={() => handleAction('rejected')}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
