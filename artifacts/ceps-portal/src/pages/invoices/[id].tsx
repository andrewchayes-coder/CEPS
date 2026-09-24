import React, { useState } from 'react';
import { useLocation, useParams } from 'wouter';
import { useGetInvoice, useValidateInvoice, useDecideInvoice, useUpdateInvoice, useDeleteInvoice, InvoiceValidationResult } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { EditInvoiceDialog } from '@/components/edit-invoice-dialog';
import { DeleteEntityButton } from '@/components/delete-entity-button';
import { ClientLink, VendorLink } from '@/components/entity-links';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, CheckCircle2, XCircle, AlertTriangle, ShieldCheck, FileText, ExternalLink } from 'lucide-react';
import { Link } from 'wouter';
import { Textarea } from '@/components/ui/textarea';
import { FileUpload } from '@/components/file-upload';
import { DocumentPreview } from '@/components/document-preview';
import { getInvoiceDisplayMonth } from '@/lib/invoice-utils';
import { apiErrorMessage } from '@/lib/api-error';

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const permissions = new Set((user as any)?.permissions ?? []);
  const canValidate = permissions.has('invoice_log_validate');
  const canApprove = permissions.has('invoice_approve');
  const { toast } = useToast();
  const [justification, setJustification] = useState('');
  const deleteInvoice = useDeleteInvoice();

  const { data: invoice, isLoading, refetch } = useGetInvoice(id, {
    query: { enabled: !!id, queryKey: ['invoice', id] }
  });

  const [validation, setValidation] = useState<InvoiceValidationResult | null>(null);
  const validateInvoiceMutation = useValidateInvoice();
  const decideInvoice = useDecideInvoice();
  const validating = validateInvoiceMutation.isPending;

  const runValidation = () => {
    if (id) {
      if (!canValidate) return;
      validateInvoiceMutation.mutate({ id }, {
        onSuccess: (data) => {
          setValidation(data);
          void refetch();
        },
      });
    }
  };

  const updateInvoice = useUpdateInvoice();

  const handleDocument = (documentUrl: string | null) => {
    updateInvoice.mutate(
      { id, data: { documentUrl } },
      {
        onSuccess: () => {
          toast({ title: documentUrl ? 'Document attached' : 'Document removed' });
          refetch();
        },
         onError: (error: unknown) => toast({ variant: 'destructive', title: 'Error', description: apiErrorMessage(error, 'Could not update the attachment.') }),
      },
    );
  };

  if (isLoading) return <div className="p-8 text-center">Loading invoice...</div>;
  if (!invoice) return <div className="p-8 text-center">Invoice not found.</div>;

  const needsOverride = validation?.checks.some(c => !c.passed && c.check === 'no_duplicate_payment');

  const handleAction = (status: 'approved' | 'rejected', overrideDuplicate?: boolean) => {
    if (overrideDuplicate && !justification) {
      toast({ variant: 'destructive', title: 'Justification Required', description: 'Please provide a justification for overriding the duplicate payment warning.'});
      return;
    }

    decideInvoice.mutate({
      id,
      data: { status, notes: justification ? `OVERRIDE: ${justification}` : undefined }
    }, {
      onSuccess: () => {
        toast({ title: `Invoice ${status === 'approved' ? 'Approved' : 'Rejected'}` });
        refetch();
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
          <p className="text-muted-foreground mt-1">Service Month: {getInvoiceDisplayMonth(invoice)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="text-base px-3 py-1 uppercase">{invoice.status.replace('_', ' ')}</Badge>
          {isStaff && (
            <>
              <EditInvoiceDialog id={id} invoice={invoice} onSaved={() => { refetch(); }} />
              <DeleteEntityButton
                entityLabel="Invoice"
                testId="button-delete-invoice"
                onDelete={() => deleteInvoice.mutateAsync({ id })}
                onDeleted={() => navigate('/invoices')}
              />
            </>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Invoice Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid grid-cols-3 gap-2">
              <dt className="text-muted-foreground">Participant:</dt><dd className="col-span-2 font-medium"><ClientLink id={invoice.clientId} name={invoice.clientName} /></dd>
              <dt className="text-muted-foreground">Vendor:</dt><dd className="col-span-2"><VendorLink id={invoice.vendorId} name={invoice.vendorName} /></dd>
              <dt className="text-muted-foreground">Amount Requested:</dt><dd className="col-span-2 font-bold text-lg">${parseFloat(invoice.amountRequested).toFixed(2)}</dd>
              <dt className="text-muted-foreground mt-2">Submitted By:</dt><dd className="col-span-2 mt-2 capitalize">{invoice.submittedByRole}</dd>
            </dl>

            <div className="pt-4 border-t space-y-3 mt-4">
              <p className="font-semibold">Line Items</p>
              <div className="space-y-2">
                {invoice.lineItems.map((line, index) => (
                  <div key={line.id || index} className="p-3 bg-muted/30 rounded-md border text-sm flex flex-col gap-1" data-testid={`text-line-item-${index}`}>
                    <div className="flex justify-between font-medium">
                      <span>{line.serviceMonth}</span>
                      <span>${parseFloat(line.amount).toFixed(2)}</span>
                    </div>
                    <div className="text-muted-foreground">
                      Authorization:{' '}
                      {line.authorizationId ? (
                        <Link href={`/authorizations/${line.authorizationId}`} className="text-primary hover:underline">{line.authNumber}</Link>
                      ) : (
                        <span className="italic">None</span>
                      )}
                    </div>
                    {line.documentUrl && (
                      <a
                        href={`/api/storage${line.documentUrl}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                        data-testid={`link-line-item-${index}-document`}
                        aria-label={`View document for line item ${index + 1}`}
                      >
                        <FileText className="h-3.5 w-3.5" /> View line document
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-4 border-t space-y-3 mt-4">
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground font-medium">Attachment</p>
                {invoice.documentUrl && isStaff && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDocument(null)}
                    disabled={updateInvoice.isPending}
                    className="h-8 text-destructive hover:text-destructive"
                    data-testid="button-remove-invoice-document"
                  >
                    Remove
                  </Button>
                )}
              </div>

              {invoice.documentUrl ? (
                <DocumentPreview objectPath={invoice.documentUrl} filename={`Invoice-${getInvoiceDisplayMonth(invoice)}.pdf`} className="max-h-[600px]" />
              ) : (
                !isStaff && <p className="text-muted-foreground">No document attached.</p>
              )}
              {isStaff && (
                <FileUpload
                  label={invoice.documentUrl ? 'Drag & drop to replace the document, or click to browse' : 'Drag & drop the invoice document here, or click to browse'}
                  onUploaded={(r) => handleDocument(r.objectPath)}
                />
              )}
            </div>
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

             {invoice.status === 'pending_review' && canValidate && (
               <div className="pt-4 border-t">
                 <Button className="w-full" onClick={runValidation} disabled={validating} data-testid="button-validate-invoice">
                   {validating ? 'Validating…' : 'Validate invoice'}
                 </Button>
               </div>
             )}
             {isStaff && invoice.status === 'pending_review' && !canValidate && (
               <p className="pt-4 border-t text-sm text-muted-foreground">You don't have permission to validate invoices — ask an admin to grant it in Admin &gt; Users.</p>
             )}
             {invoice.status === 'validated' && canApprove && (
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
             {isStaff && invoice.status === 'validated' && !canApprove && (
               <p className="pt-4 border-t text-sm text-muted-foreground">You don't have permission to approve invoices — ask an admin to grant it in Admin &gt; Users.</p>
             )}

                <div className="flex gap-2">
                  <Button
                    className="w-full bg-chart-5 hover:bg-chart-5/90 text-white"
                     disabled={decideInvoice.isPending || (needsOverride && !justification) || !canApprove}
                    onClick={() => handleAction('approved', needsOverride)}
                  >
                    Approve
                  </Button>
                  <Button
                    className="w-full"
                    variant="destructive"
                    disabled={decideInvoice.isPending || !canApprove}
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
