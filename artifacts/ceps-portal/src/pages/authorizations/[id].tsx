import React from 'react';
import { useLocation, useParams, Link } from 'wouter';
import { useGetAuthorization, useDeleteAuthorization } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { EditAuthorizationDialog } from '@/components/edit-authorization-dialog';
import { DeleteEntityButton } from '@/components/delete-entity-button';
import { ClientLink, VendorLink } from '@/components/entity-links';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ArrowLeft, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';

export default function AuthorizationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const deleteAuthorization = useDeleteAuthorization();

  const { data: auth, isLoading, refetch } = useGetAuthorization(id, {
    query: { enabled: !!id, queryKey: ['authorization', id] },
  });

  if (isLoading) return <div className="p-8 text-center">Loading authorization...</div>;
  if (!auth) return <div className="p-8 text-center">Authorization not found.</div>;

  const max = parseFloat(auth.maxPeriodAmount);
  const paid = parseFloat(auth.totalPaid || '0');
  const percent = max > 0 ? Math.min(100, (paid / max) * 100) : 0;
  const isExpiring = auth.daysUntilExpiry != null && auth.daysUntilExpiry < 30 && auth.status === 'active';

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/authorizations"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Link>
      </Button>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Authorization (POS)</h1>
          <p className="text-muted-foreground mt-1 font-mono">{auth.authNumber}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={
            auth.status === 'active' ? 'bg-chart-5/10 text-chart-5 border-chart-5/20 text-base px-3 py-1' :
            auth.status === 'expired' ? 'bg-muted text-muted-foreground text-base px-3 py-1' : 'text-base px-3 py-1'
          }>
            {auth.status}
          </Badge>
          {isStaff && (
            <>
              <EditAuthorizationDialog id={id} authorization={auth} onSaved={() => refetch()} />
              <DeleteEntityButton
                entityLabel="Authorization"
                testId="button-delete-authorization"
                onDelete={() => deleteAuthorization.mutateAsync({ id })}
                onDeleted={() => navigate('/authorizations')}
              />
            </>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Authorization Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid grid-cols-3 gap-2">
              <dt className="text-muted-foreground">Client:</dt>
              <dd className="col-span-2"><ClientLink id={auth.clientId} name={auth.clientName} testId="link-authorization-client" /></dd>
              <dt className="text-muted-foreground">Vendor:</dt>
              <dd className="col-span-2"><VendorLink id={auth.vendorId} name={auth.vendorName} testId="link-authorization-vendor" /></dd>
              <dt className="text-muted-foreground">Service Code:</dt><dd className="col-span-2">{auth.serviceCode}</dd>
              <dt className="text-muted-foreground">Payment Type:</dt><dd className="col-span-2 capitalize">{auth.paymentType?.replace('_', ' ')}</dd>
              {auth.activityDescription && (
                <>
                  <dt className="text-muted-foreground">Activity:</dt><dd className="col-span-2">{auth.activityDescription}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Service Period:</dt>
              <dd className="col-span-2">
                {format(new Date(auth.servicePeriodStart), 'MM/dd/yy')} - {format(new Date(auth.servicePeriodEnd), 'MM/dd/yy')}
              </dd>
              {auth.monthlyAmount && (
                <>
                  <dt className="text-muted-foreground">Monthly Amount:</dt><dd className="col-span-2">${parseFloat(auth.monthlyAmount).toFixed(2)}</dd>
                </>
              )}
              {auth.oneTimeAmount && (
                <>
                  <dt className="text-muted-foreground">One-Time Amount:</dt><dd className="col-span-2">${parseFloat(auth.oneTimeAmount).toFixed(2)}</dd>
                </>
              )}
              {auth.units != null && (
                <>
                  <dt className="text-muted-foreground">Units:</dt><dd className="col-span-2">{auth.units}</dd>
                </>
              )}
              {auth.receivedDate && (
                <>
                  <dt className="text-muted-foreground">Received:</dt><dd className="col-span-2">{auth.receivedDate}</dd>
                </>
              )}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Utilization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid grid-cols-3 gap-2">
              <dt className="text-muted-foreground">Max (Period):</dt><dd className="col-span-2 font-bold text-lg">${max.toFixed(2)}</dd>
              <dt className="text-muted-foreground">Total Paid:</dt><dd className="col-span-2">${paid.toFixed(2)}</dd>
              <dt className="text-muted-foreground">Remaining:</dt><dd className="col-span-2">${parseFloat(auth.remainingAmount ?? '0').toFixed(2)}</dd>
            </dl>
            <div className="space-y-2 pt-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Utilized: ${paid.toFixed(2)}</span>
                <span>Max: ${max.toFixed(2)}</span>
              </div>
              <Progress value={percent} className="h-2" />
              {isExpiring && (
                <p className="text-xs text-chart-1 font-medium flex items-center gap-1 mt-2">
                  <AlertCircle className="w-3 h-3" /> Expires in {auth.daysUntilExpiry} days
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
