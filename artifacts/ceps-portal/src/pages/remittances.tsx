import React, { useMemo, useState } from 'react';
import { useListRemittances, useDeleteRemittance, type AltaRemittanceImportResult } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { DeleteEntityButton } from '@/components/delete-entity-button';
import { EditRemittanceDialog } from '@/components/edit-remittance-dialog';
import { CreateRemittanceDialog } from '@/components/create-remittance-dialog';
import { MatchRemittanceDialog } from '@/components/match-remittance-dialog';
import { Link } from 'wouter';
import { AltaRemittanceImport } from '@/components/alta-remittance-import';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, SortableTableHead, useTableSort } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { format } from 'date-fns';
import { ChevronLeft, ChevronRight, X, AlertTriangle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

const PAGE_SIZE = 50;

// Assign a stable short label + color per batch id so line items from the same
// Remittance Report are visually grouped in the list.
const BATCH_BADGE_CLASSES = [
  'bg-blue-100 text-blue-800',
  'bg-purple-100 text-purple-800',
  'bg-teal-100 text-teal-800',
  'bg-orange-100 text-orange-800',
  'bg-pink-100 text-pink-800',
  'bg-indigo-100 text-indigo-800',
];

type RemittanceTab = 'all' | 'needs_manual_match';

export default function RemittancesPage() {
  const [page, setPage] = useState(0);
  const [batchFilter, setBatchFilter] = useState<string>('');
  const [tab, setTab] = useState<RemittanceTab>('all');
  const sort = useTableSort<'remittanceDate' | 'altaReference' | 'remittanceBatchId' | 'authNumber' | 'amount' | 'status'>();
  const onSort = (key: Parameters<typeof sort.toggleSort>[0]) => {
    sort.toggleSort(key);
    setPage(0);
  };
  const { user } = useAuth();
  const isStaff = user?.role === 'staff';
  // "Needs Manual Match" is a staff-only triage view: imported rows that landed
  // as status "received" without an automatic payment match (autoMatched=false).
  const triage = isStaff && tab === 'needs_manual_match';
  const params = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(batchFilter ? { remittanceBatchId: batchFilter } : {}),
    ...(triage ? { status: 'received', autoMatched: false } : {}),
    ...(sort.sortBy ? { sortBy: sort.sortBy, sortDirection: sort.sortDirection } : {}),
  };
  const { data, isLoading, refetch } = useListRemittances(params, {
    query: { queryKey: ['remittances', params] },
  });
  const remittances = data?.items;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const deleteRemittance = useDeleteRemittance();

  const onTabChange = (value: string) => {
    setTab(value === 'needs_manual_match' ? 'needs_manual_match' : 'all');
    setPage(0);
  };

  // Map each batch id present on the current page to a stable badge index.
  const batchColorIndex = useMemo(() => {
    const map = new Map<string, number>();
    let next = 0;
    for (const r of remittances ?? []) {
      if (r.remittanceBatchId && !map.has(r.remittanceBatchId)) {
        map.set(r.remittanceBatchId, next++ % BATCH_BADGE_CLASSES.length);
      }
    }
    return map;
  }, [remittances]);

  const onImported = (result: AltaRemittanceImportResult) => {
    // Jump straight to the freshly-imported batch so staff see its line items.
    setBatchFilter(result.remittanceBatchId);
    setPage(0);
    refetch();
  };
  const reviewMessage = (reason?: string | null, expectedAmount?: string | null, amount?: string) => {
    if (reason === 'amount_mismatch') return `Actual $${Number(amount).toFixed(2)} vs expected $${Number(expectedAmount ?? 0).toFixed(2)} — partial or amount mismatch needs review.`;
    if (!reason) return null;
    return reason.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Remittances</h1>
          <p className="text-muted-foreground mt-1">Reconciliation of funds received from Alta Regional Center.</p>
        </div>
        {isStaff && <div className="flex gap-2"><CreateRemittanceDialog onSaved={() => refetch()} /><AltaRemittanceImport onImported={onImported} /></div>}
      </div>

      {isStaff && (
        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList>
            <TabsTrigger value="all" data-testid="tab-remittances-all">
              All Remittances
            </TabsTrigger>
            <TabsTrigger value="needs_manual_match" data-testid="tab-remittances-needs-manual-match">
              Needs Manual Match
              {triage && total > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-2"
                  data-testid="badge-needs-manual-match-count"
                >
                  {total}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {triage && (
        <p className="text-sm text-muted-foreground" data-testid="text-triage-help">
          Imported remittances with no automatic payment match. Select Match Payment to reconcile an eligible payment.
        </p>
      )}

      {batchFilter && (
        <div className="flex items-center gap-2" data-testid="banner-batch-filter">
          <Badge variant="outline" className="font-mono">
            Batch: {batchFilter.slice(0, 8)}…
          </Badge>
          <span className="text-sm text-muted-foreground">Showing only line items from this Remittance Report.</span>
          <Button
            variant="ghost"
            size="sm"
            data-testid="button-clear-batch-filter"
            onClick={() => {
              setBatchFilter('');
              setPage(0);
            }}
          >
            <X className="w-4 h-4 mr-1" /> Clear
          </Button>
        </div>
      )}

      {isStaff && !batchFilter && (
        <div className="flex items-center gap-2">
          <Input
            className="max-w-xs"
            placeholder="Filter by remittance batch id…"
            data-testid="input-batch-filter"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setBatchFilter((e.target as HTMLInputElement).value.trim());
                setPage(0);
              }
            }}
          />
          <span className="text-xs text-muted-foreground">Press Enter to filter to one uploaded report.</span>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="Date Received" sortKey="remittanceDate" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Reference" sortKey="altaReference" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Batch" sortKey="remittanceBatchId" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Auth #" sortKey="authNumber" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                <SortableTableHead label="Amount" sortKey="amount" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} className="text-right" />
                <SortableTableHead label="Status" sortKey="status" activeSortBy={sort.sortBy} sortDirection={sort.sortDirection} onSort={onSort} />
                {isStaff && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={isStaff ? 7 : 6} className="h-24 text-center"><Skeleton className="h-4 w-full max-w-sm mx-auto" /></TableCell></TableRow>
              ) : remittances?.length === 0 ? (
                <TableRow><TableCell colSpan={isStaff ? 7 : 6} className="h-24 text-center text-muted-foreground">No remittances found.</TableCell></TableRow>
              ) : (
                remittances?.map((r, index) => {
                  const prior = remittances[index - 1];
                  const startsGroup = !prior || prior.altaReference !== r.altaReference || prior.remittanceDate !== r.remittanceDate;
                  const review = reviewMessage(r.reviewReason, r.expectedAmount, r.amount);
                  return (
                  <TableRow key={r.id} className={startsGroup && index > 0 ? 'border-t-4 border-muted bg-muted/20' : ''}>
                    <TableCell className="whitespace-nowrap">{format(new Date(r.remittanceDate), 'MMM d, yyyy')}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {r.altaReference || '—'}
                      {review && <div className="mt-1 flex items-start gap-1 text-xs text-destructive"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{review}</div>}
                    </TableCell>
                    <TableCell>
                      {r.remittanceBatchId ? (
                        <button
                          type="button"
                          data-testid="badge-batch"
                          onClick={() => { setBatchFilter(r.remittanceBatchId!); setPage(0); }}
                          title={`Filter to Remittance Report batch ${r.remittanceBatchId}`}
                          className={`rounded px-2 py-0.5 text-xs font-mono ${BATCH_BADGE_CLASSES[batchColorIndex.get(r.remittanceBatchId) ?? 0]}`}
                        >
                          {r.remittanceBatchId.slice(0, 8)}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                      {r.reportReference && <div className="mt-1 text-xs text-muted-foreground">Report: {r.reportReference}</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.authorizationId ? (
                        <Link href={`/authorizations/${r.authorizationId}`} className="text-primary hover:underline">{r.authNumber}</Link>
                      ) : r.authNumber}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      ${parseFloat(r.amount).toFixed(2)}
                      {r.expectedAmount && <div className="text-xs font-normal text-muted-foreground">Expected ${parseFloat(r.expectedAmount).toFixed(2)}</div>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={
                        r.status === 'matched' ? 'bg-chart-5/10 text-chart-5 border-chart-5/20' :
                        r.status === 'pending' ? 'bg-chart-2/10 text-chart-2 border-chart-2/20' : ''
                      }>
                        {r.status}
                      </Badge>
                    </TableCell>
                    {isStaff && (
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" asChild data-testid={`button-view-remittance-${r.id}`}>
                            <Link href={`/remittances/${r.id}`}>View</Link>
                          </Button>
                          <EditRemittanceDialog
                            id={r.id}
                            remittance={r}
                            onSaved={() => refetch()}
                          />
                          {triage && !r.matchedPaymentId && <MatchRemittanceDialog remittance={r} onSaved={() => refetch()} />}
                          <DeleteEntityButton
                            variant="ghost"
                            buttonLabel=""
                            entityLabel="Remittance"
                            testId="button-delete-remittance"
                            onDelete={() => deleteRemittance.mutateAsync({ id: r.id })}
                            onDeleted={() => refetch()}
                          />
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                )})
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-muted-foreground" data-testid="text-remittances-pagination">
              {total === 0
                ? 'No remittances'
                : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} remittances`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                data-testid="button-remittances-prev"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {page + 1} of {pageCount}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                data-testid="button-remittances-next"
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
