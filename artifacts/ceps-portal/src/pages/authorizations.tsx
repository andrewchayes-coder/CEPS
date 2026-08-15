import React, { useState } from 'react';
import { useListAuthorizations, useDeleteAuthorization } from '@workspace/api-client-react';
import { DeleteEntityButton } from '@/components/delete-entity-button';
import { EditAuthorizationDialog } from '@/components/edit-authorization-dialog';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { 
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow 
} from '@/components/ui/table';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileCheck, Plus, Search, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/components/auth/auth-provider';

const PAGE_SIZE = 50;

export default function AuthorizationsPage() {
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  // Server-side pagination — mirrors the audit-log page. The authorizations
  // list API has no `search` param (Auth #, Client and Vendor names), so that
  // stays a client-side filter over the loaded page, like referrals.
  const params = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const { data, isLoading, refetch } = useListAuthorizations(params, {
    query: { queryKey: ['authorizations', params] },
  });
  const auths = data?.items;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const deleteAuthorization = useDeleteAuthorization();

  const filteredAuths = auths?.filter(a => 
    a.authNumber.toLowerCase().includes(search.toLowerCase()) ||
    a.clientName?.toLowerCase().includes(search.toLowerCase()) ||
    a.vendorName?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Authorizations (POS)</h1>
          <p className="text-muted-foreground mt-1">Manage purchase of service authorizations.</p>
        </div>
        {user?.role === 'staff' && (
          <Button asChild>
            <Link href="/authorizations/new">
              <Plus className="mr-2 h-4 w-4" />
              Enter POS
            </Link>
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="relative w-full sm:max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search by Auth #, Client, or Vendor..."
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Auth #</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Service Period</TableHead>
                <TableHead className="text-right">Max Amount</TableHead>
                <TableHead>Status</TableHead>
                {isStaff && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <AuthsTableSkeleton />
              ) : filteredAuths?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isStaff ? 7 : 6} className="h-24 text-center text-muted-foreground">
                    No authorizations found.
                  </TableCell>
                </TableRow>
              ) : (
                filteredAuths?.map((auth) => {
                  const isExpiring = auth.daysUntilExpiry != null && auth.daysUntilExpiry < 30 && auth.status === 'active';
                  
                  return (
                    <TableRow key={auth.id} className={isExpiring ? 'bg-chart-1/5' : ''}>
                      <TableCell className="font-medium text-primary">
                        {auth.authNumber}
                      </TableCell>
                      <TableCell>{auth.clientName}</TableCell>
                      <TableCell>{auth.vendorName}</TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {format(new Date(auth.servicePeriodStart), 'MM/dd/yy')} - {format(new Date(auth.servicePeriodEnd), 'MM/dd/yy')}
                        {isExpiring && (
                           <span className="flex items-center text-xs text-chart-1 mt-1 font-medium">
                             <AlertCircle className="w-3 h-3 mr-1" /> {auth.daysUntilExpiry} days left
                           </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        ${parseFloat(auth.maxPeriodAmount).toFixed(2)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={
                          auth.status === 'active' ? 'bg-chart-5/10 text-chart-5 border-chart-5/20' : 
                          auth.status === 'expired' ? 'bg-muted text-muted-foreground' : ''
                        }>
                          {auth.status}
                        </Badge>
                      </TableCell>
                      {isStaff && (
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <EditAuthorizationDialog
                              id={auth.id}
                              authorization={auth}
                              onSaved={() => refetch()}
                            />
                            <DeleteEntityButton
                              variant="ghost"
                              buttonLabel=""
                              entityLabel="Authorization"
                              testId={`button-delete-authorization`}
                              onDelete={() => deleteAuthorization.mutateAsync({ id: auth.id })}
                              onDeleted={() => refetch()}
                            />
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-muted-foreground" data-testid="text-authorizations-pagination">
              {total === 0
                ? 'No authorizations'
                : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} authorizations`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                data-testid="button-authorizations-prev"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {page + 1} of {pageCount}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                data-testid="button-authorizations-next"
              >
                Next <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AuthsTableSkeleton() {
  return (
    <>
      {[1, 2, 3, 4, 5].map((i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-4 w-28" /></TableCell>
          <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
          <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}
