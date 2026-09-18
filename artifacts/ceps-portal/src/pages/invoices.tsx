import React, { useState } from 'react';
import { useListInvoices } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { ClientLink, VendorLink } from '@/components/entity-links';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, SortableTableHead, useTableSort
} from '@/components/ui/table';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Search, Receipt, ChevronLeft, ChevronRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/components/auth/auth-provider';
import { DateRangeFilter } from '@/components/date-range-filter';
import { getInvoiceDisplayMonth } from '@/lib/invoice-utils';

const PAGE_SIZE = 50;

export default function InvoicesPage() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState<string>();
  const [endDate, setEndDate] = useState<string>();
  const [page, setPage] = useState(0);
  const sort = useTableSort<'serviceMonth' | 'vendorName' | 'clientName' | 'authNumber' | 'amountRequested' | 'status'>();
  const onSort = (key: Parameters<typeof sort.toggleSort>[0]) => {
    sort.toggleSort(key);
    setPage(0);
  };

  const params = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(sort.sortBy ? { sortBy: sort.sortBy, sortDirection: sort.sortDirection } : {}),
  };
  const { data, isLoading } = useListInvoices(params, {
    query: { queryKey: ['invoices', params] },
  });
  const invoices = data?.items;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Invoices</h1>
          <p className="text-muted-foreground mt-1">Manage vendor and family invoices.</p>
        </div>
        <Button asChild>
          <Link href="/invoices/new">
            <Plus className="mr-2 h-4 w-4" />
            Submit Invoice
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
            <div className="relative w-full sm:max-w-md">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search by vendor, participant, or auth #..."
                className="pl-8"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              />
            </div>
            <div className="w-full sm:w-auto">
              <DateRangeFilter
                label="Service month"
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
                <SortableTableHead label="Service Month" sortKey="serviceMonth" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Vendor" sortKey="vendorName" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Participant" sortKey="clientName" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Auth #" sortKey="authNumber" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Amount" sortKey="amountRequested" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} className="text-right" />
                <SortableTableHead label="Status" sortKey="status" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <InvoicesTableSkeleton />
              ) : invoices?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    No invoices found.
                  </TableCell>
                </TableRow>
              ) : (
                invoices?.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell className="font-medium whitespace-nowrap">{getInvoiceDisplayMonth(invoice)}</TableCell>
                    <TableCell><VendorLink id={invoice.vendorId} name={invoice.vendorName} /></TableCell>
                    <TableCell><ClientLink id={invoice.clientId} name={invoice.clientName} /></TableCell>
                    <TableCell className="text-muted-foreground text-xs space-y-1">
                      {invoice.lineItems && invoice.lineItems.length > 0 ? (
                        Array.from(new Set(invoice.lineItems.filter(l => l.authorizationId).map(l =>
                          JSON.stringify({ id: l.authorizationId, num: l.authNumber })
                        ))).map(str => JSON.parse(str)).map((auth, idx) => (
                          <div key={`${auth.id}-${idx}`}>
                            <Link href={`/authorizations/${auth.id}`} className="text-primary hover:underline">{auth.num}</Link>
                          </div>
                        ))
                      ) : (
                        invoice.authorizationId ? (
                          <Link href={`/authorizations/${invoice.authorizationId}`} className="text-primary hover:underline">{invoice.authNumber}</Link>
                        ) : invoice.authNumber || '-'
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium">${parseFloat(invoice.amountRequested).toFixed(2)}</TableCell>
                    <TableCell>
                      <StatusBadge status={invoice.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/invoices/${invoice.id}`}>View</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-muted-foreground" data-testid="text-invoices-pagination">
              {total === 0
                ? 'No invoices'
                : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} invoices`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                data-testid="button-invoices-prev"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {page + 1} of {pageCount}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                data-testid="button-invoices-next"
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

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'pending_review':
      return <Badge variant="outline" className="bg-chart-2/10 text-chart-2 border-chart-2/20">Pending Review</Badge>;
    case 'validated':
      return <Badge variant="outline" className="bg-chart-4/10 text-chart-4 border-chart-4/20">Validated</Badge>;
    case 'approved':
      return <Badge variant="outline" className="bg-chart-5/10 text-chart-5 border-chart-5/20">Approved</Badge>;
    case 'rejected':
      return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">Rejected</Badge>;
    case 'duplicate':
      return <Badge variant="outline" className="bg-destructive text-destructive-foreground">Duplicate</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function InvoicesTableSkeleton() {
  return (
    <>
      {[1, 2, 3, 4, 5].map((i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
          <TableCell><Skeleton className="h-5 w-24 rounded-full" /></TableCell>
          <TableCell className="text-right"><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}
