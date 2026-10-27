import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useImportAltaBilling, useListBillingRows, type BillingImportResult, type BillingRow, type BillingRowMatchStatus } from '@workspace/api-client-react';
import { FileSpreadsheet, Loader2, Upload, ChevronLeft, ChevronRight, ReceiptText } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { ProtectedData } from '@/components/protected-data';
import { formatDate, formatMonth } from '@/lib/dates';
import { useToast } from '@/hooks/use-toast';
import { invalidateBillingQueries } from './billing-status';

type Row = BillingRow & { rebilled?: boolean; untracked?: boolean };
type Result = BillingImportResult & { untrackedCount?: number; untrackedAmount?: string; rebilled?: number };

const money = (v?: string | null) => `$${Number(v ?? 0).toFixed(2)}`;
const MATCH: Record<BillingRowMatchStatus, { label: string; className: string }> = {
  matched: { label: 'Matched', className: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  amount_mismatch: { label: 'Amount mismatch', className: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  unmatched: { label: 'Unmatched', className: 'border-destructive/50 bg-destructive/10 text-destructive' },
  already_imported: { label: 'Already imported', className: 'border-border bg-muted/50 text-muted-foreground' },
};
const normalizeCode = (c: string) => (/^\d{1,2}$/.test(c.trim()) ? c.trim().padStart(3, '0') : c);
const isUntracked = (r: Row) => !!r.untracked || /isn.?t tracked|not tracked|untracked/i.test(r.reviewReason ?? '');

function RowsTable({ rows, testId }: { rows: Row[]; testId: string }) {
  return (
    <div className="overflow-x-auto">
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            <TableHead>Participant</TableHead><TableHead>UCI</TableHead><TableHead>Auth #</TableHead><TableHead>Service</TableHead>
            <TableHead>Invoice</TableHead><TableHead className="text-right">Billed</TableHead><TableHead>Match</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => {
            const m = MATCH[r.matchStatus] ?? MATCH.unmatched;
            return (
              <TableRow key={r.id ?? `${r.rowNumber}-${i}`} data-testid={`row-billing-${r.id ?? r.rowNumber}`}>
                <TableCell>{r.clientName ? <ProtectedData>{r.clientName}</ProtectedData> : <span className="text-muted-foreground">Not found</span>}</TableCell>
                <TableCell className="font-mono text-xs"><ProtectedData>{r.uciNumber}</ProtectedData></TableCell>
                <TableCell className="font-mono text-xs"><ProtectedData>{r.authNumber}</ProtectedData></TableCell>
                <TableCell className="whitespace-nowrap text-xs"><ProtectedData>{formatMonth(r.serviceMonth)}</ProtectedData> · <span className="font-mono"><ProtectedData>{normalizeCode(r.serviceCode)}</ProtectedData></span></TableCell>
                <TableCell className="whitespace-nowrap text-xs"><span className="font-mono"><ProtectedData>{r.invoiceNumber}</ProtectedData></span><div className="text-muted-foreground"><ProtectedData>{formatDate(r.billedAt)}</ProtectedData></div></TableCell>
                <TableCell className="text-right font-medium"><ProtectedData>{money(r.billedAmount)}</ProtectedData></TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant="outline" className={m.className}>{m.label}</Badge>
                    {r.rebilled && <Badge variant="outline" className="border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-300" data-testid={`badge-rebilled-${r.id ?? r.rowNumber}`}>Re-billed</Badge>}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {r.targetCount > 0 ? `Will mark ${r.targetCount} item${r.targetCount === 1 ? '' : 's'} as Billed` : 'No portal items'}
                  </div>
                  {r.reviewReason && <div className="mt-0.5 max-w-[240px] text-xs text-destructive">{r.reviewReason}</div>}
                </TableCell>
              </TableRow>
            );
          })}
          {rows.length === 0 && <TableRow><TableCell colSpan={7} className="h-16 text-center text-muted-foreground">No rows.</TableCell></TableRow>}
        </TableBody>
      </Table>
    </div>
  );
}

function ResultSummary({ result }: { result: Result }) {
  const rows = result.rows as Row[];
  const untracked = rows.filter(isUntracked);
  const tracked = rows.filter((r) => !isUntracked(r));
  const untrackedCount = result.untrackedCount ?? untracked.length;
  const untrackedAmount = result.untrackedAmount ?? untracked.reduce((s, r) => s + Number(r.billedAmount), 0).toFixed(2);
  const rebilled = result.rebilled ?? rows.filter((r) => r.rebilled).length;
  const stats = [
    ['Matched', result.matched], ['Amount mismatch', result.amountMismatch], ['Unmatched', result.unmatched],
    ['Duplicates', result.alreadyImported], ['Deferred', result.deferred], ['Re-billed', rebilled],
  ] as const;
  return (
    <div className="space-y-4" data-testid="billing-import-summary">
      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border bg-muted/30 p-3">
        <p className="text-sm">
          {result.mode === 'commit' ? `Imported ${result.imported} rows.` : 'Preview only. Nothing has been saved yet.'}
        </p>
        <p className="text-sm">Invoice total <strong><ProtectedData>{money(result.totalAmount)}</ProtectedData></strong></p>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {stats.map(([label, n]) => (
          <div key={label} className="rounded-md border p-2" data-testid={`stat-billing-${label.toLowerCase().replace(/\s+/g, '-')}`}>
            <div className="text-lg font-semibold tabular-nums">{n}</div><div className="text-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      <RowsTable rows={tracked} testId="table-billing-import-rows" />
      {untrackedCount > 0 && (
        <div className="space-y-2" data-testid="group-billing-untracked">
          <h4 className="text-sm font-semibold">Services not tracked in the portal: {untrackedCount} rows · <ProtectedData>{money(untrackedAmount)}</ProtectedData></h4>
          <p className="text-xs text-muted-foreground">These invoice lines are kept for reference but do not mark any portal item as Billed.</p>
          <RowsTable rows={untracked} testId="table-billing-untracked-rows" />
        </div>
      )}
    </div>
  );
}

export function AltaBillingImport({ onImported }: { onImported?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mut = useImportAltaBilling();
  const qc = useQueryClient();
  const { toast } = useToast();

  const run = (content: string, mode: 'preview' | 'commit') => {
    setError(null);
    mut.mutate({ data: { csvContent: content, mode } }, {
      onSuccess: (r) => {
        setResult(r as Result);
        if (mode === 'commit') {
          setCsv(null);
          void invalidateBillingQueries(qc);
          toast({ title: 'Invoice history imported', description: `${r.imported} rows marked as Billed.` });
          onImported?.();
        }
      },
      onError: (e: unknown) => setError((e as { message?: string })?.message ?? 'The file could not be processed.'),
    });
  };

  const onFile = async (file?: File) => {
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    const text = await file.text();
    setCsv(text);
    run(text, 'preview');
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="button-import-alta-billing">
        <ReceiptText className="mr-2 h-4 w-4" /> Import Invoice History
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Alta Invoice History (billing)</DialogTitle>
            <DialogDescription data-testid="text-billing-import-description">Marks items as Billed. Does not record any payment.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-3">
            <input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} data-testid="input-billing-file" />
            <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={mut.isPending} data-testid="button-choose-billing-file">
              <FileSpreadsheet className="mr-2 h-4 w-4" /> Choose CSV
            </Button>
            {fileName && <span className="text-sm text-muted-foreground"><ProtectedData>{fileName}</ProtectedData></span>}
            {mut.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-label="Processing" />}
          </div>
          {error && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert" data-testid="text-billing-import-error">{error}</p>}
          {result && <ResultSummary result={result} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
            {csv && result?.mode === 'preview' && (
              <Button onClick={() => run(csv, 'commit')} disabled={mut.isPending} data-testid="button-confirm-billing-import">
                <Upload className="mr-2 h-4 w-4" /> Confirm import
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const HISTORY_PAGE = 25;
export function BillingHistoryCard() {
  const [filter, setFilter] = useState<'all' | 'matched' | 'unmatched' | 'amount_mismatch'>('all');
  const [page, setPage] = useState(0);
  const params = { limit: HISTORY_PAGE, offset: page * HISTORY_PAGE, ...(filter !== 'all' ? { matchStatus: filter } : {}) };
  const { data, isLoading, isError, refetch } = useListBillingRows(params);
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
  return (
    <Card data-testid="card-billing-history">
      <CardHeader className="gap-3 border-b pb-3">
        <div>
          <CardTitle className="text-lg">Alta Invoice History</CardTitle>
          <CardDescription>Billing rows imported from Alta. Billing is not payment.</CardDescription>
        </div>
        <Tabs value={filter} onValueChange={(v) => { setFilter(v as typeof filter); setPage(0); }}>
          <TabsList className="flex h-auto flex-wrap">
            <TabsTrigger value="all" data-testid="tab-billing-all">All</TabsTrigger>
            <TabsTrigger value="unmatched" data-testid="tab-billing-unmatched">Unmatched</TabsTrigger>
            <TabsTrigger value="amount_mismatch" data-testid="tab-billing-mismatch">Amount mismatch</TabsTrigger>
            <TabsTrigger value="matched" data-testid="tab-billing-matched">Matched</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
        ) : isError ? (
          <div className="flex items-center gap-3 p-4 text-sm text-muted-foreground">Billing history could not be loaded. <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button></div>
        ) : (
          <RowsTable rows={(data?.items ?? []) as Row[]} testId="table-billing-history" />
        )}
        <div className="flex items-center justify-between border-t px-4 py-3">
          <p className="text-sm text-muted-foreground" data-testid="text-billing-history-pagination">
            {total === 0 ? 'No billing rows' : `Showing ${page * HISTORY_PAGE + 1}–${Math.min((page + 1) * HISTORY_PAGE, total)} of ${total}`}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)} data-testid="button-billing-prev"><ChevronLeft className="mr-1 h-4 w-4" /> Previous</Button>
            <span className="text-sm text-muted-foreground">Page {page + 1} of {pages}</span>
            <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} data-testid="button-billing-next">Next <ChevronRight className="ml-1 h-4 w-4" /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
