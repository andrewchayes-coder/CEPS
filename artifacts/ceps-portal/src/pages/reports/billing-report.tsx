import { useState } from 'react';
import { exportBillingReport, useGetBillingReport, type GetBillingReportParams } from '@workspace/api-client-react';
import { Download, Flag, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ProtectedData } from '@/components/protected-data';
import { ClientLink } from '@/components/entity-links';
import { BILLING_STATUS_PRESENTATION, ReviewFlagAction } from '@/components/billing/billing-status';
import { useAuth } from '@/components/auth/auth-provider';
import { formatDate, formatDateTime, formatMonth } from '@/lib/dates';
import { useToast } from '@/hooks/use-toast';
import type { GlobalReportFilters } from '../reports';

const PAGE = 50;
const money = (v?: string | null) => (v == null ? '-' : `$${Number(v).toFixed(2)}`);

export default function BillingReport({ report, filters }: { report: 'flagged' | 'unpaid'; filters: GlobalReportFilters }) {
  const { user } = useAuth();
  const canMutate = user?.role === 'staff' && (user.permissions ?? []).includes('remittance_entry');
  const { toast } = useToast();
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [age, setAge] = useState<'0' | '30' | '60' | '90'>('0');
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  // Billing reports accept participant + dates only; coordinator is intentionally not sent.
  const base = {
    report,
    ...(filters.clientId ? { clientId: filters.clientId } : {}),
    ...(filters.startDate ? { startDate: filters.startDate } : {}),
    ...(filters.endDate ? { endDate: filters.endDate } : {}),
    ...(report === 'flagged' ? { status } : { olderThanDays: Number(age) as 0 | 30 | 60 | 90 }),
  } as Omit<GetBillingReportParams, 'limit' | 'offset'>;
  const params: GetBillingReportParams = { ...base, limit: PAGE, offset: page * PAGE };
  const { data, isLoading, isError, refetch } = useGetBillingReport(params);
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const flagged = report === 'flagged';

  const doExport = async () => {
    setExporting(true);
    try {
      const csv = await exportBillingReport(base);
      const blob = new Blob([typeof csv === 'string' ? csv : String(csv)], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = flagged ? 'flagged_for_review.csv' : 'billed_not_paid.csv';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ variant: 'destructive', title: 'Export failed', description: 'Please try again.' });
    } finally { setExporting(false); }
  };

  const cols = flagged ? (canMutate ? 9 : 8) : 8;
  return (
    <Card data-testid={`card-billing-report-${report}`}>
      <CardHeader className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex-1">
          <CardTitle>{flagged ? 'Flagged for review' : 'Billed, not paid'}</CardTitle>
          <CardDescription>
            {flagged ? 'Check lines and fees staff flagged for follow-up.' : 'Items billed to Alta with no full payment recorded yet.'}
            {' '}Filtered by participant and date range; the coordinator filter does not apply here.
          </CardDescription>
          <div className="mt-4 w-full sm:w-56 space-y-1">
            {flagged ? (
              <>
                <Label className="text-xs">Flag status</Label>
                <Select value={status} onValueChange={(v) => { setStatus(v as typeof status); setPage(0); }}>
                  <SelectTrigger data-testid="select-flag-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="resolved">Resolved</SelectItem>
                    <SelectItem value="all">All</SelectItem>
                  </SelectContent>
                </Select>
              </>
            ) : (
              <>
                <Label className="text-xs">Billed at least</Label>
                <Select value={age} onValueChange={(v) => { setAge(v as typeof age); setPage(0); }}>
                  <SelectTrigger data-testid="select-unpaid-age"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Any age</SelectItem>
                    <SelectItem value="30">30+ days ago</SelectItem>
                    <SelectItem value="60">60+ days ago</SelectItem>
                    <SelectItem value="90">90+ days ago</SelectItem>
                  </SelectContent>
                </Select>
              </>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void doExport()} disabled={exporting} className="shrink-0" data-testid={`button-export-billing-${report}`}>
          <Download className="mr-2 h-4 w-4" /> {exporting ? 'Exporting...' : 'Export CSV (all rows)'}
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Participant</TableHead><TableHead>Item</TableHead><TableHead>Service Month</TableHead>
                <TableHead className="text-right">Amount</TableHead><TableHead>Billed</TableHead><TableHead className="text-right">Remitted</TableHead>
                {flagged ? <TableHead>Flag</TableHead> : <TableHead>Status</TableHead>}
                {flagged ? <TableHead>Resolution</TableHead> : <TableHead className="text-right">Days since billed</TableHead>}
                {flagged && canMutate && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [0, 1, 2].map((i) => <TableRow key={i}><TableCell colSpan={cols}><Skeleton className="h-5 w-full" /></TableCell></TableRow>)
              ) : isError ? (
                <TableRow><TableCell colSpan={cols} className="h-20 text-center text-muted-foreground">Report could not be loaded. <Button size="sm" variant="outline" className="ml-2" onClick={() => void refetch()}>Retry</Button></TableCell></TableRow>
              ) : (data?.items.length ?? 0) === 0 ? (
                <TableRow><TableCell colSpan={cols} className="h-20 text-center text-muted-foreground">{flagged ? 'Nothing flagged for these filters.' : 'No billed-but-unpaid items for these filters.'}</TableCell></TableRow>
              ) : data!.items.map((r) => {
                const st = BILLING_STATUS_PRESENTATION[r.billingStatus] ?? BILLING_STATUS_PRESENTATION.pending;
                return (
                  <TableRow key={`${r.targetType}-${r.targetId}`} data-testid={`row-billing-report-${r.targetId}`}>
                    <TableCell className="font-medium"><ClientLink id={r.clientId} name={r.clientName} /></TableCell>
                    <TableCell className="text-sm"><Badge variant="outline" className="mr-1.5">{r.targetType === 'fee' ? 'Fee' : 'Check line'}</Badge><ProtectedData>{r.item}</ProtectedData></TableCell>
                    <TableCell className="whitespace-nowrap"><ProtectedData>{formatMonth(r.serviceMonth)}</ProtectedData></TableCell>
                    <TableCell className="text-right"><ProtectedData>{money(r.amount)}</ProtectedData></TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      <ProtectedData>{money(r.billedAmount)}</ProtectedData>
                      <div className="text-muted-foreground"><ProtectedData>{r.billedAt ? formatDate(r.billedAt) : '-'}</ProtectedData>{r.invoiceNumber && <> · <ProtectedData>{r.invoiceNumber}</ProtectedData></>}</div>
                    </TableCell>
                    <TableCell className="text-right"><ProtectedData>{money(r.remittedAmount)}</ProtectedData></TableCell>
                    {flagged ? (
                      <TableCell className="max-w-[240px] text-xs">
                        {r.flag ? (
                          <>
                            <span className={`flex items-start gap-1 font-medium ${r.flag.resolvedAt ? 'text-muted-foreground' : 'text-destructive'}`}><Flag className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /><ProtectedData>{r.flag.reason}</ProtectedData></span>
                            <span className="text-muted-foreground"><ProtectedData>{r.flag.flaggedByName ?? r.flag.flaggedBy}</ProtectedData> · <ProtectedData>{formatDateTime(r.flag.flaggedAt)}</ProtectedData></span>
                          </>
                        ) : '-'}
                      </TableCell>
                    ) : (
                      <TableCell><Badge variant="outline" className={st.className}>{st.label}</Badge></TableCell>
                    )}
                    {flagged ? (
                      <TableCell className="max-w-[220px] text-xs">
                        {r.flag?.resolvedAt ? <><ProtectedData>{r.flag.resolutionNote ?? ''}</ProtectedData><div className="text-muted-foreground">Resolved <ProtectedData>{formatDateTime(r.flag.resolvedAt)}</ProtectedData></div></> : <span className="text-muted-foreground">Open</span>}
                      </TableCell>
                    ) : (
                      <TableCell className="text-right tabular-nums"><ProtectedData>{r.daysSinceBilled ?? '-'}</ProtectedData></TableCell>
                    )}
                    {flagged && canMutate && (
                      <TableCell className="text-right">{r.flag && !r.flag.resolvedAt && <ReviewFlagAction targetType={r.targetType} targetId={r.targetId} flag={r.flag} testId={`button-resolve-flag-${r.targetId}`} />}</TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between border-t px-4 py-3">
          <p className="text-sm text-muted-foreground" data-testid={`text-billing-report-${report}-pagination`}>
            {total === 0 ? 'No items' : `Showing ${page * PAGE + 1}–${Math.min((page + 1) * PAGE, total)} of ${total}`}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="mr-1 h-4 w-4" /> Previous</Button>
            <span className="text-sm text-muted-foreground">Page {page + 1} of {pages}</span>
            <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight className="ml-1 h-4 w-4" /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
