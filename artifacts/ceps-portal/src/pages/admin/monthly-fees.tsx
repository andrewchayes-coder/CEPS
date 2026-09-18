import { useMemo, useState } from 'react';
import {
  useAuditMonthlyFees,
  useRepairMonthlyFees,
  type MonthlyFeeAuditItem,
  type MonthlyFeeRepairResult,
} from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldAlert, Wrench } from 'lucide-react';

const issueLabels: Record<MonthlyFeeAuditItem['issue'], string> = {
  missing: 'Missing',
  stale: 'Stale',
  obsolete_rule: 'Obsolete rule',
};

const actionLabels: Record<MonthlyFeeAuditItem['repairAction'], string> = {
  create: 'Create',
  reverse: 'Reverse',
  replace: 'Replace',
  none: 'Manual review',
};

function formatMonth(value: string) {
  const [year, month] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function countActions(items: MonthlyFeeAuditItem[]) {
  return {
    create: items.filter((item) => item.repairAction === 'create').length,
    reverse: items.filter((item) => item.repairAction === 'reverse').length,
    replace: items.filter((item) => item.repairAction === 'replace').length,
    protected: items.filter((item) => item.protected).length,
  };
}

export default function MonthlyFeeCleanupPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isStaff = user?.role === 'staff';
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [lastResult, setLastResult] = useState<MonthlyFeeRepairResult | null>(null);
  const audit = useAuditMonthlyFees(undefined, {
    query: { enabled: isStaff, queryKey: ['/api/payments/monthly-fees/audit'] },
  });
  const repair = useRepairMonthlyFees();

  const report = audit.data;
  const repairableClientIds = useMemo(
    () => Array.from(new Set(report?.items.filter((item) => !item.protected).map((item) => item.clientId) ?? [])),
    [report],
  );
  const selectedItems = useMemo(
    () => report?.items.filter((item) => selectedClientIds.has(item.clientId)) ?? [],
    [report, selectedClientIds],
  );
  const selectedCounts = countActions(selectedItems);
  const selectedRepairableCount = selectedCounts.create + selectedCounts.reverse + selectedCounts.replace;
  const allSelected = repairableClientIds.length > 0 && repairableClientIds.every((id) => selectedClientIds.has(id));

  if (!isStaff) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground" data-testid="text-monthly-fees-forbidden">
          You don't have access to monthly fee cleanup.
        </CardContent>
      </Card>
    );
  }

  const toggleClient = (clientId: string, checked: boolean) => {
    setSelectedClientIds((current) => {
      const next = new Set(current);
      if (checked) next.add(clientId);
      else next.delete(clientId);
      return next;
    });
    setLastResult(null);
  };

  const runRepair = () => {
    const clientIds = Array.from(selectedClientIds);
    repair.mutate(
      { data: { confirm: true, clientIds } },
      {
        onSuccess: async (result) => {
          setLastResult(result);
          setSelectedClientIds(new Set());
          await audit.refetch();
          toast({ title: 'Monthly fee cleanup completed' });
        },
        onError: (error: unknown) => {
          toast({
            title: 'Monthly fee cleanup failed',
            description: (error as { data?: { error?: string } })?.data?.error ?? 'No fees were changed. Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Monthly Fee Cleanup</h1>
          <p className="mt-1 text-muted-foreground">
            Review participant-months that do not match the confirmed ${report?.flatAmount ?? '160.00'} monthly fee rule.
          </p>
        </div>
        <Button variant="outline" onClick={() => audit.refetch()} disabled={audit.isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${audit.isFetching ? 'animate-spin' : ''}`} />
          Refresh audit
        </Button>
      </div>

      {lastResult && (
        <Alert data-testid="monthly-fee-repair-result">
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Cleanup complete</AlertTitle>
          <AlertDescription>
            Created {lastResult.created}, reversed {lastResult.reversed}, replaced {lastResult.replaced}, protected{' '}
            {lastResult.protected}, and {lastResult.remainingIssues} remaining.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Total discrepancies</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{report?.totalIssues ?? '—'}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Safe to repair</CardTitle></CardHeader><CardContent className="text-2xl font-bold text-primary">{report?.repairableIssues ?? '—'}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Protected</CardTitle></CardHeader><CardContent className="text-2xl font-bold text-amber-700">{report?.protectedIssues ?? '—'}</CardContent></Card>
      </div>

      <Alert>
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Protected fees require manual review</AlertTitle>
        <AlertDescription>
          Fees that have progressed or were manually created or adjusted cannot be selected or changed by this cleanup.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 border-b">
          <div>
            <CardTitle>Audit results</CardTitle>
            {report && <p className="mt-1 text-sm text-muted-foreground">Generated {new Date(report.generatedAt).toLocaleString()}</p>}
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button disabled={selectedRepairableCount === 0 || repair.isPending}>
                <Wrench className="mr-2 h-4 w-4" />
                Review cleanup ({selectedClientIds.size})
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Run monthly fee cleanup?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will repair all safe discrepancies for {selectedClientIds.size} selected participant{selectedClientIds.size === 1 ? '' : 's'}.
                  Protected fees will not be changed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="grid grid-cols-2 gap-3 rounded-md border p-4 text-sm">
                <span>Create missing fees</span><strong className="text-right">{selectedCounts.create}</strong>
                <span>Reverse stale fees</span><strong className="text-right">{selectedCounts.reverse}</strong>
                <span>Replace obsolete fees</span><strong className="text-right">{selectedCounts.replace}</strong>
                <span>Leave protected</span><strong className="text-right">{selectedCounts.protected}</strong>
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={runRepair}>Confirm and run cleanup</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <Checkbox
                    aria-label="Select all repairable participants"
                    checked={allSelected}
                    onCheckedChange={(checked) => setSelectedClientIds(checked ? new Set(repairableClientIds) : new Set())}
                    disabled={repairableClientIds.length === 0}
                  />
                </TableHead>
                <TableHead>Participant</TableHead>
                <TableHead>Month</TableHead>
                <TableHead>Issue</TableHead>
                <TableHead>Current fee</TableHead>
                <TableHead>Automatic action</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audit.isLoading ? (
                <TableRow><TableCell colSpan={7} className="h-24"><Skeleton className="mx-auto h-4 max-w-md" /></TableCell></TableRow>
              ) : audit.isError ? (
                <TableRow><TableCell colSpan={7} className="h-24 text-center text-destructive">Could not load the monthly fee audit.</TableCell></TableRow>
              ) : !report?.items.length ? (
                <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No monthly fee discrepancies found.</TableCell></TableRow>
              ) : report.items.map((item) => (
                <TableRow key={`${item.clientId}-${item.feeMonth}`}>
                  <TableCell>
                    <Checkbox
                      aria-label={`Select ${item.clientName}`}
                      checked={!item.protected && selectedClientIds.has(item.clientId)}
                      onCheckedChange={(checked) => toggleClient(item.clientId, checked === true)}
                      disabled={item.protected}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{item.clientName}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatMonth(item.feeMonth)}</TableCell>
                  <TableCell><Badge variant="outline">{issueLabels[item.issue]}</Badge></TableCell>
                  <TableCell>{item.feeAmount ? `$${item.feeAmount} · ${item.feeStatus}` : 'None'}</TableCell>
                  <TableCell>
                    {item.protected ? (
                      <Badge variant="secondary"><ShieldAlert className="mr-1 h-3 w-3" />Protected</Badge>
                    ) : (
                      <Badge>{actionLabels[item.repairAction]}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-sm text-sm text-muted-foreground">{item.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {repair.isPending && (
            <div className="flex items-center justify-center gap-2 border-t p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Running cleanup…
            </div>
          )}
        </CardContent>
      </Card>

      {report && report.protectedIssues > 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          {report.protectedIssues} protected discrepancy{report.protectedIssues === 1 ? '' : 'ies'} remain for manual review.
        </p>
      )}
    </div>
  );
}