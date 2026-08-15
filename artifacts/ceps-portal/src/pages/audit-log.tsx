import React, { useState } from 'react';
import { useListAuditLog, useListUsers, listAuditLog } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { downloadCSV } from '@/lib/csv';
import { useToast } from '@/hooks/use-toast';

const PAGE_SIZE = 50;
const ALL_USERS = '__all__';

export default function AuditLogPage() {
  const [search, setSearch] = useState('');
  const [entityType, setEntityType] = useState('');
  const [userId, setUserId] = useState(ALL_USERS);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ fetched: number; total: number } | null>(null);
  const { toast } = useToast();

  const filterParams = {
    ...(search ? { action: search } : {}),
    ...(entityType ? { entityType } : {}),
    ...(userId !== ALL_USERS ? { userId } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  };
  const params = { ...filterParams, limit: PAGE_SIZE, offset: page * PAGE_SIZE };

  const { data, isLoading } = useListAuditLog(params, {
    query: { queryKey: ['auditLog', params] },
  });
  const { data: users } = useListUsers(undefined, {
    query: { queryKey: ['users'] },
  });

  const entries = data?.entries;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setFilter = (setter: (v: string) => void) => (value: string) => {
    setter(value);
    setPage(0);
  };

  const formatTs = (ts?: string | null) =>
    ts ? format(new Date(ts), 'MMM d, yyyy h:mm a') : '';

  const exportAuditLog = async () => {
    setExporting(true);
    setExportProgress(null);
    try {
      const all: any[] = [];
      const batch = 1000;
      let offset = 0;
      for (;;) {
        const res = await listAuditLog({ ...filterParams, limit: batch, offset });
        all.push(...res.entries);
        offset += res.entries.length;
        setExportProgress({ fetched: offset, total: res.total });
        if (res.entries.length < batch || offset >= res.total) break;
      }
      const headers = ['Timestamp', 'User', 'Action', 'Entity Type', 'Entity ID', 'Detail'];
      const rows = all.map((e: any) => [
        formatTs(e.createdAt),
        e.userName ?? '',
        e.action ?? '',
        e.entityType ?? '',
        e.entityId ?? '',
        e.detail ?? '',
      ]);
      downloadCSV('audit_log.csv', headers, rows);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Export failed',
        description: 'Could not fetch all audit entries. Please check your connection and try again.',
      });
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Audit Log</h1>
          <p className="text-muted-foreground mt-1">System activity history across all records.</p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 pb-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 flex-1">
            <div className="space-y-1">
              <Label className="text-xs">User</Label>
              <Select value={userId} onValueChange={setFilter(setUserId)}>
                <SelectTrigger data-testid="select-audit-user">
                  <SelectValue placeholder="All users" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_USERS}>All users</SelectItem>
                  {(users ?? []).map((u: any) => (
                    <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-search" className="text-xs">Action</Label>
              <Input
                id="audit-search"
                data-testid="input-audit-search"
                placeholder="Search action…"
                value={search}
                onChange={(e) => setFilter(setSearch)(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-entity" className="text-xs">Entity Type</Label>
              <Input
                id="audit-entity"
                data-testid="input-audit-entity"
                placeholder="e.g. invoice"
                value={entityType}
                onChange={(e) => setFilter(setEntityType)(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-from" className="text-xs">From</Label>
              <Input
                id="audit-from"
                data-testid="input-audit-date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setFilter(setDateFrom)(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-to" className="text-xs">To</Label>
              <Input
                id="audit-to"
                data-testid="input-audit-date-to"
                type="date"
                value={dateTo}
                onChange={(e) => setFilter(setDateTo)(e.target.value)}
              />
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={exportAuditLog}
            disabled={exporting || total === 0}
            data-testid="button-export-audit-log"
            className="shrink-0"
          >
            <Download className="w-4 h-4 mr-2" />
            {exporting
              ? exportProgress
                ? `Fetched ${exportProgress.fetched.toLocaleString()} of ${exportProgress.total.toLocaleString()}…`
                : 'Exporting…'
              : 'Export CSV'}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table data-testid="table-audit-log">
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity Type</TableHead>
                <TableHead>Entity ID</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="h-24"><Skeleton className="h-4 w-full" /></TableCell></TableRow>
              ) : !entries || entries.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No audit entries found.</TableCell></TableRow>
              ) : (
                entries.map((e: any) => (
                  <TableRow key={e.id} data-testid={`row-audit-${e.id}`}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatTs(e.createdAt)}</TableCell>
                    <TableCell className="font-medium">{e.userName ?? '—'}</TableCell>
                    <TableCell><span className="font-mono text-xs">{e.action}</span></TableCell>
                    <TableCell className="capitalize text-muted-foreground">{e.entityType ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{e.entityId ?? '—'}</TableCell>
                    <TableCell className="max-w-xs">
                      {e.detail ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block truncate cursor-default">{e.detail}</span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm whitespace-pre-wrap break-words">
                            {e.detail}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-muted-foreground" data-testid="text-audit-pagination">
              {total === 0
                ? 'No entries'
                : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} entries`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                data-testid="button-audit-prev"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {page + 1} of {pageCount}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                data-testid="button-audit-next"
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
