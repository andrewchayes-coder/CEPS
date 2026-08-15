import React, { useState } from 'react';
import {
  useGetCaseStatusReport,
  getCaseStatusReport,
  useListUsers,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Download } from 'lucide-react';
import { downloadCSV } from '@/lib/csv';
import { useToast } from '@/hooks/use-toast';
import { PAGE_SIZE, ReportPagination } from './report-pagination';

const ALL = '__all__';

const STATUS_STAGES = [
  'intake',
  'pending_signature',
  'pending_auth',
  'pending_w9',
  'pending_invoice',
  'active',
  'closed',
];

const STATUS_LABELS: Record<string, string> = {
  intake: 'Intake',
  pending_signature: 'Pending Signature',
  pending_auth: 'Pending Authorization',
  pending_w9: 'Pending W-9',
  pending_invoice: 'Pending Invoice',
  active: 'Active',
  closed: 'Closed',
};

export default function CaseStatusReport({ initialStatus }: { initialStatus?: string }) {
  const [status, setStatus] = useState(initialStatus ?? ALL);
  const [coordinatorId, setCoordinatorId] = useState(ALL);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();

  const filterParams = {
    ...(status !== ALL ? { status } : {}),
    ...(coordinatorId !== ALL ? { coordinatorId } : {}),
    ...(search ? { search } : {}),
  };
  const params = { ...filterParams, limit: PAGE_SIZE, offset: page * PAGE_SIZE };

  const { data, isLoading } = useGetCaseStatusReport(params, {
    query: { queryKey: ['caseStatusReport', params] },
  });
  const { data: users } = useListUsers({ role: 'service_coordinator' }, {
    query: { queryKey: ['users', 'service_coordinator'] },
  });

  const items = data?.items;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setFilter = (setter: (v: string) => void) => (value: string) => {
    setter(value);
    setPage(0);
  };

  const exportCSV = async () => {
    setExporting(true);
    try {
      const all: any[] = [];
      const batch = 1000;
      let offset = 0;
      for (;;) {
        const res = await getCaseStatusReport({ ...filterParams, limit: batch, offset });
        all.push(...res.items);
        offset += res.items.length;
        if (res.items.length < batch || offset >= res.total) break;
      }
      const headers = ['Client', 'Status', 'Referral Date', 'Service Coordinator'];
      const rows = all.map((r: any) => [
        r.clientName ?? '',
        STATUS_LABELS[r.status] ?? r.status,
        r.referralDate ?? '',
        r.coordinatorName ?? '',
      ]);
      downloadCSV('case_status_overview.csv', headers, rows);
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
          <CardTitle>Program-Level Case Status Overview</CardTitle>
          <CardDescription>Every case broken out by its current status stage.</CardDescription>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
            <div className="space-y-1">
              <Label className="text-xs">Status</Label>
              <Select value={status} onValueChange={setFilter(setStatus)}>
                <SelectTrigger data-testid="select-case-status-stage"><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  {STATUS_STAGES.map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Service Coordinator</Label>
              <Select value={coordinatorId} onValueChange={setFilter(setCoordinatorId)}>
                <SelectTrigger data-testid="select-case-status-coordinator"><SelectValue placeholder="All coordinators" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All coordinators</SelectItem>
                  {(users ?? []).map((u: any) => (
                    <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="case-status-search" className="text-xs">Client</Label>
              <Input
                id="case-status-search"
                data-testid="input-case-status-search"
                placeholder="Search client…"
                value={search}
                onChange={(e) => setFilter(setSearch)(e.target.value)}
              />
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={exportCSV} disabled={exporting || total === 0} data-testid="button-export-case-status" className="shrink-0">
          <Download className="w-4 h-4 mr-2" />{exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <Table data-testid="table-case-status">
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Referral Date</TableHead>
              <TableHead>Service Coordinator</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="h-24"><Skeleton className="h-4 w-full" /></TableCell></TableRow>
            ) : !items || items.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No cases found.</TableCell></TableRow>
            ) : (
              items.map((r: any) => (
                <TableRow key={r.referralId} data-testid={`row-case-status-${r.referralId}`}>
                  <TableCell className="font-medium">{r.clientName ?? '—'}</TableCell>
                  <TableCell><Badge variant="secondary">{STATUS_LABELS[r.status] ?? r.status}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{r.referralDate}</TableCell>
                  <TableCell className="text-muted-foreground">{r.coordinatorName ?? '—'}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <ReportPagination page={page} pageCount={pageCount} total={total} setPage={setPage} testid="case-status" />
      </CardContent>
    </Card>
  );
}
