import React from 'react';
import { useLocation, useParams, Link } from 'wouter';
import { useGetRemittance, useDeleteRemittance } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { EditRemittanceDialog } from '@/components/edit-remittance-dialog';
import { DeleteEntityButton } from '@/components/delete-entity-button';
import { ClientLink } from '@/components/entity-links';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft } from 'lucide-react';
import { format } from 'date-fns';

export default function RemittanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const deleteRemittance = useDeleteRemittance();

  const { data: remittance, isLoading, refetch } = useGetRemittance(id, {
    query: { enabled: !!id, queryKey: ['remittance', id] },
  });

  if (isLoading) return <div className="p-8 text-center">Loading remittance...</div>;
  if (!remittance) return <div className="p-8 text-center">Remittance not found.</div>;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/remittances"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Link>
      </Button>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Alta Remittance</h1>
          <p className="text-muted-foreground mt-1 font-mono">{remittance.altaReference || 'No reference'}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={
            remittance.status === 'matched' ? 'bg-chart-5/10 text-chart-5 border-chart-5/20 text-base px-3 py-1' :
            remittance.status === 'pending' ? 'bg-chart-2/10 text-chart-2 border-chart-2/20 text-base px-3 py-1' : 'text-base px-3 py-1'
          }>
            {remittance.status}
          </Badge>
          {isStaff && (
            <>
              <EditRemittanceDialog id={id} remittance={remittance} onSaved={() => refetch()} />
              <DeleteEntityButton
                entityLabel="Remittance"
                testId="button-delete-remittance"
                onDelete={() => deleteRemittance.mutateAsync({ id })}
                onDeleted={() => navigate('/remittances')}
              />
            </>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Remittance Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid grid-cols-3 gap-2">
            <dt className="text-muted-foreground">Client:</dt>
            <dd className="col-span-2"><ClientLink id={remittance.clientId} name={remittance.clientName} testId="link-remittance-client" /></dd>
            <dt className="text-muted-foreground">Authorization:</dt>
            <dd className="col-span-2 font-mono">
              {remittance.authorizationId && remittance.authNumber ? (
                <Link href={`/authorizations/${remittance.authorizationId}`} className="text-primary hover:underline" data-testid="link-remittance-authorization">
                  {remittance.authNumber}
                </Link>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </dd>
            {remittance.matchedPaymentId && (
              <>
                <dt className="text-muted-foreground">Matched Payment:</dt>
                <dd className="col-span-2">
                  <Link href={`/payments/${remittance.matchedPaymentId}`} className="text-primary hover:underline" data-testid="link-remittance-payment">
                    View payment
                  </Link>
                  {remittance.autoMatched && <span className="ml-2 text-xs text-muted-foreground">(auto-matched)</span>}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Date Received:</dt>
            <dd className="col-span-2">{format(new Date(remittance.remittanceDate), 'MMM d, yyyy')}</dd>
            <dt className="text-muted-foreground">Service Month:</dt>
            <dd className="col-span-2">{remittance.paymentMonth || '-'}</dd>
            <dt className="text-muted-foreground">Amount:</dt>
            <dd className="col-span-2 font-bold text-lg">${parseFloat(remittance.amount).toFixed(2)}</dd>
            <dt className="text-muted-foreground">Source:</dt>
            <dd className="col-span-2 capitalize">{remittance.source?.replace('_', ' ')}</dd>
            {remittance.remittanceBatchId && (
              <>
                <dt className="text-muted-foreground">Batch:</dt>
                <dd className="col-span-2 font-mono text-xs">{remittance.remittanceBatchId}</dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
