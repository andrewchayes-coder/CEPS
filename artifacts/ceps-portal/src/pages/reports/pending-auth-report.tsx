import React, { useState, useEffect } from 'react';
import {
  useGetPendingAuthReport,
  getPendingAuthReport,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHeader, TableRow, SortableTableHead } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ClientLink } from '@/components/entity-links';
import { Download } from 'lucide-react';
import { downloadCSV } from '@/lib/csv';
import { useToast } from '@/hooks/use-toast';
import { PAGE_SIZE, ReportPagination } from './report-pagination';
import { useTableSort } from '@/lib/table-sorting';
import type { GlobalReportFilters } from '../reports';

type PendingAuthSortKey = 'clientName' | 'referralDate' | 'daysWaiting' | 'coordinatorName';

export default function PendingAuthReport({ filters }: { filters: GlobalReportFilters }) {
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const { sort, onSort } = useTableSort<PendingAuthSortKey>('clientName');
  const { toast } = useToast();

  useEffect(() => {
    setPage(0);
  }, [filters, sort]);

  const params: any = { ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE, sortBy: sort.key, sortDirection: sort.direction };

  const { data, isLoading } = useGetPendingAuthReport(params, {
    query: { queryKey: ['pendingAuthReport', params] },
  });

  const items = data?.items;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const changeSort = (key: PendingAuthSortKey) => {
    onSort(key);
  };

  const exportCSV = async () => {
    setExporting(true);
    try {
      const all: any[] = [];
      const batch = 1000;
      let offset = 0;
      for (;;) {
        const res = await getPendingAuthReport({ ...filters, limit: batch, offset, sortBy: sort.key, sortDirection: sort.direction } as any);
        all.push(...res.items);
        offset += res.items.length;
        if (res.items.length < batch || offset >= res.total) break;
      }
      const headers = ['Participant', 'Referral Date', 'Days Waiting', 'Service Coordinator'];
      const rows = all.map((r: any) => [
        r.clientName ?? '',
        r.referralDate ?? '',
        r.daysWaiting ?? 0,
        r.coordinatorName ?? '',
      ]);
      downloadCSV('pending_authorization_tracker.csv', headers, rows);
    } catch {
      toast({ variant: 'destructive', title: 'Export failed', description: 'Could not fetch all rows. Please try again.' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 pb-4 border-b sm:flex-row sm:items-end sm:justify-between">
        <div className="flex-1">
          <CardTitle>Pending Authorization Tracker</CardTitle>
          <CardDescription>Cases waiting on POS authorization from Alta.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={exportCSV} disabled={exporting || total === 0} data-testid="button-export-pending-auth" className="shrink-0">
          <Download className="w-4 h-4 mr-2" />{exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <Table data-testid="table-pending-auth">
          <TableHeader>
            <TableRow>
              <SortableTableHead sortDirection={sort.key === 'clientName' ? sort.direction : null} onSort={() => changeSort('clientName')}>Participant</SortableTableHead>
              <SortableTableHead sortDirection={sort.key === 'referralDate' ? sort.direction : null} onSort={() => changeSort('referralDate')}>Referral Date</SortableTableHead>
              <SortableTableHead className="text-right" sortDirection={sort.key === 'daysWaiting' ? sort.direction : null} onSort={() => changeSort('daysWaiting')}>Days Waiting</SortableTableHead>
              <SortableTableHead sortDirection={sort.key === 'coordinatorName' ? sort.direction : null} onSort={() => changeSort('coordinatorName')}>Service Coordinator</SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="h-24"><Skeleton className="h-4 w-full" /></TableCell></TableRow>
            ) : !items || items.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No cases pending authorization.</TableCell></TableRow>
            ) : (
              items.map((r: any) => (
                <TableRow key={r.referralId} data-testid={`row-pending-auth-${r.referralId}`}>
                  <TableCell className="font-medium"><ClientLink id={r.clientId} name={r.clientName} /></TableCell>
                  <TableCell className="text-muted-foreground">{r.referralDate}</TableCell>
                  <TableCell className="text-right font-bold">{r.daysWaiting}</TableCell>
                  <TableCell className="text-muted-foreground">{r.coordinatorName ?? '—'}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <ReportPagination page={page} pageCount={pageCount} total={total} setPage={setPage} testid="pending-auth" />
      </CardContent>
    </Card>
  );
}
