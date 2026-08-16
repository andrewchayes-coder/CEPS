import React from 'react';
import { useLocation, useParams, Link } from 'wouter';
import { useGetPayment, useDeletePayment } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { EditPaymentDialog } from '@/components/edit-payment-dialog';
import { DeleteEntityButton } from '@/components/delete-entity-button';
import { ClientLink, VendorLink } from '@/components/entity-links';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';

export default function PaymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const deletePayment = useDeletePayment();

  const { data: payment, isLoading, refetch } = useGetPayment(id, {
    query: { enabled: !!id, queryKey: ['payment', id] },
  });

  if (isLoading) return <div className="p-8 text-center">Loading payment...</div>;
  if (!payment) return <div className="p-8 text-center">Payment not found.</div>;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/payments"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Link>
      </Button>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Payment</h1>
          <p className="text-muted-foreground mt-1 font-mono">Check #{payment.qbCheckNumber}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-base px-3 py-1 capitalize">
            {payment.remitted ? 'Remitted' : 'Not Remitted'}
          </Badge>
          {isStaff && (
            <>
              <EditPaymentDialog id={id} payment={payment} onSaved={() => refetch()} />
              <DeleteEntityButton
                entityLabel="Payment"
                testId="button-delete-payment"
                onDelete={() => deletePayment.mutateAsync({ id })}
                onDeleted={() => navigate('/payments')}
              />
            </>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payment Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid grid-cols-3 gap-2">
            <dt className="text-muted-foreground">Client:</dt>
            <dd className="col-span-2"><ClientLink id={payment.clientId} name={payment.clientName} testId="link-payment-client" /></dd>
            <dt className="text-muted-foreground">Payee (Vendor):</dt>
            <dd className="col-span-2"><VendorLink id={payment.vendorId} name={payment.vendorName} testId="link-payment-vendor" /></dd>
            <dt className="text-muted-foreground">Authorization:</dt>
            <dd className="col-span-2 font-mono">
              {payment.authorizationId && payment.authNumber ? (
                <Link href={`/authorizations/${payment.authorizationId}`} className="text-primary hover:underline" data-testid="link-payment-authorization">
                  {payment.authNumber}
                </Link>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </dd>
            {payment.invoiceId && (
              <>
                <dt className="text-muted-foreground">Invoice:</dt>
                <dd className="col-span-2">
                  <Link href={`/invoices/${payment.invoiceId}`} className="text-primary hover:underline" data-testid="link-payment-invoice">
                    View invoice
                  </Link>
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Check Date:</dt>
            <dd className="col-span-2">{format(new Date(payment.checkDate), 'MMM d, yyyy')}</dd>
            <dt className="text-muted-foreground">Service Month:</dt>
            <dd className="col-span-2">{payment.paymentMonth || '-'}</dd>
            <dt className="text-muted-foreground">Amount:</dt>
            <dd className="col-span-2 font-bold text-lg">${parseFloat(payment.amount).toFixed(2)}</dd>
            <dt className="text-muted-foreground">Payment Type:</dt>
            <dd className="col-span-2 capitalize">{payment.paymentType.replace('_', ' ')}</dd>
            <dt className="text-muted-foreground">Source:</dt>
            <dd className="col-span-2 capitalize">{payment.source?.replace('_', ' ')}</dd>
            <dt className="text-muted-foreground">Remitted:</dt>
            <dd className="col-span-2">
              {payment.remitted ? <CheckCircle2 className="w-4 h-4 text-chart-5" /> : <span className="text-muted-foreground">Not yet remitted</span>}
            </dd>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
