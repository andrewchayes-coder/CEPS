import React, { useState } from 'react';
import { useListPayments, useDeletePayment } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { AltaFmsPaymentImport } from '@/components/alta-fms-payment-import';
import { LogPaymentDialog } from '@/components/log-payment-dialog';
import { DeleteEntityButton } from '@/components/delete-entity-button';
import { EditPaymentDialog } from '@/components/edit-payment-dialog';
import { ClientLink, VendorLink } from '@/components/entity-links';
import { Link } from 'wouter';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, SortableTableHead, useTableSort } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';
import { Search, CheckCircle2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { DateRangeFilter } from '@/components/date-range-filter';

const PAGE_SIZE = 50;

export default function PaymentsPage() {
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState<string>();
  const [endDate, setEndDate] = useState<string>();
  const [page, setPage] = useState(0);
  const sort = useTableSort<'checkDate' | 'qbCheckNumber' | 'vendorName' | 'clientName' | 'amount' | 'remitted'>();
  const onSort = (key: Parameters<typeof sort.toggleSort>[0]) => {
    sort.toggleSort(key);
    setPage(0);
  };
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  const deletePayment = useDeletePayment();

  // Server-driven broad search (check number, vendor, or participant) + pagination.
  const params = {
    ...(search ? { search } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(sort.sortBy ? { sortBy: sort.sortBy, sortDirection: sort.sortDirection } : {}),
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
          <p className="text-muted-foreground mt-1">Monthly payment records from Alta FMS and staff-entered checks.</p>
        </div>
        {user?.role === 'staff' && (
          <div className="flex items-center gap-2">
            <LogPaymentDialog onSaved={() => refetch()} />
            <AltaFmsPaymentImport onImported={() => refetch()} />
          </div>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
            <div className="relative w-full sm:max-w-md">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search by check #, vendor, or participant..."
                className="pl-8"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
              />
            </div>
            <div className="w-full sm:w-auto">
              <DateRangeFilter
                label="Date range"
                startDate={startDate}
                endDate={endDate}
                onChange={(range) => {
                  setStartDate(range.startDate);
                  setEndDate(range.endDate);
                  setPage(0);
                }}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="Date" sortKey="checkDate" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Check #" sortKey="qbCheckNumber" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Payee (Vendor)" sortKey="vendorName" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Participant" sortKey="clientName" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Amount" sortKey="amount" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} className="text-right" />
                <SortableTableHead label="Remitted" sortKey="remitted" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
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
                    <TableCell className="font-mono text-sm">
                      <Link href={`/payments/${p.id}`} className="text-primary hover:underline" data-testid="link-payment">
                        {p.qbCheckNumber}
                      </Link>
                    </TableCell>
                    <TableCell><VendorLink id={p.vendorId} name={p.vendorName} /></TableCell>
                    <TableCell className="text-muted-foreground"><ClientLink id={p.clientId} name={p.clientName} className="text-muted-foreground hover:underline" /></TableCell>
                    <TableCell className="text-right font-medium">${parseFloat(p.amount).toFixed(2)}</TableCell>
                    <TableCell>
                      {p.remitted ? <CheckCircle2 className="w-5 h-5 text-chart-5" /> : <span className="text-xs text-muted-foreground">${parseFloat(p.allocatedAmount ?? '0').toFixed(2)} allocated<br />${parseFloat(p.remainingAmount ?? p.amount).toFixed(2)} remaining</span>}
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
