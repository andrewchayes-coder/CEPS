import React, { useState } from 'react';
import { useListPayments, useDeletePayment } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { CheckRegisterImport } from '@/components/check-register-import';
import { LogPaymentDialog } from '@/components/log-payment-dialog';
import { DeleteEntityButton } from '@/components/delete-entity-button';
import { EditPaymentDialog } from '@/components/edit-payment-dialog';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';
import { Search, CheckCircle2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

const PAGE_SIZE = 50;

export default function PaymentsPage() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const deletePayment = useDeletePayment();

  // Server-driven search (matches the check #) + pagination — mirrors the
  // audit-log page pattern.
  const params = {
    ...(search ? { search } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const { data, isLoading, refetch } = useListPayments(params, {
    query: { queryKey: ['payments', params] },
  });

  const payments = data?.items;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const onSearch = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Payments Log</h1>
          <p className="text-muted-foreground mt-1">Record of checks issued from QuickBooks.</p>
        </div>
        {user?.role === 'staff' && (
          <div className="flex items-center gap-2">
            <LogPaymentDialog onSaved={() => refetch()} />
            <CheckRegisterImport onImported={() => refetch()} />
          </div>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="relative w-full sm:max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search by check #..."
              className="pl-8"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Check #</TableHead>
                <TableHead>Payee (Vendor)</TableHead>
                <TableHead>Client</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Remitted</TableHead>
                {isStaff && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={isStaff ? 7 : 6} className="h-24 text-center"><Skeleton className="h-4 w-full max-w-sm mx-auto" /></TableCell></TableRow>
              ) : !payments || payments.length === 0 ? (
                <TableRow><TableCell colSpan={isStaff ? 7 : 6} className="h-24 text-center text-muted-foreground">No payments found.</TableCell></TableRow>
              ) : (
                payments.map(p => (
                  <TableRow key={p.id}>
                    <TableCell className="whitespace-nowrap">{format(new Date(p.checkDate), 'MMM d, yyyy')}</TableCell>
                    <TableCell className="font-mono text-sm">{p.qbCheckNumber}</TableCell>
                    <TableCell>{p.vendorName}</TableCell>
                    <TableCell className="text-muted-foreground">{p.clientName}</TableCell>
                    <TableCell className="text-right font-medium">${parseFloat(p.amount).toFixed(2)}</TableCell>
                    <TableCell>
                      {p.remitted ? <CheckCircle2 className="w-5 h-5 text-chart-5" /> : <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    {isStaff && (
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <EditPaymentDialog
                            id={p.id}
                            payment={p}
                            onSaved={() => refetch()}
                          />
                          <DeleteEntityButton
                            variant="ghost"
                            buttonLabel=""
                            entityLabel="Payment"
                            testId="button-delete-payment"
                            onDelete={() => deletePayment.mutateAsync({ id: p.id })}
                            onDeleted={() => refetch()}
                          />
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-muted-foreground" data-testid="text-payments-pagination">
              {total === 0
                ? 'No payments'
                : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} payments`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                data-testid="button-payments-prev"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {page + 1} of {pageCount}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                data-testid="button-payments-next"
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
