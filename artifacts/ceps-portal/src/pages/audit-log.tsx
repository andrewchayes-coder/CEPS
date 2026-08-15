import React, { useState } from 'react';
import { useListAuditLog } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Download } from 'lucide-react';
import { format } from 'date-fns';
import { downloadCSV } from '@/lib/csv';

export default function AuditLogPage() {
  const [search, setSearch] = useState('');
  const [entityType, setEntityType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const params = {
    ...(search ? { action: search } : {}),
    ...(entityType ? { entityType } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    limit: 500,
  };

  const { data: entries, isLoading } = useListAuditLog(params, {
    query: { queryKey: ['auditLog', params] },
  });

  const formatTs = (ts?: string | null) =>
    ts ? format(new Date(ts), 'MMM d, yyyy h:mm a') : '';

  const exportAuditLog = () => {
    if (!entries) return;
    const headers = ['Timestamp', 'User', 'Action', 'Entity Type', 'Entity ID', 'Detail'];
    const rows = entries.map((e: any) => [
      formatTs(e.createdAt),
      e.userName ?? '',
      e.action ?? '',
      e.entityType ?? '',
      e.entityId ?? '',
      e.detail ?? '',
    ]);
    downloadCSV('audit_log.csv', headers, rows);
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 flex-1">
            <div className="space-y-1">
              <Label htmlFor="audit-search" className="text-xs">Action</Label>
              <Input
                id="audit-search"
                data-testid="input-audit-search"
                placeholder="Search action…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-entity" className="text-xs">Entity Type</Label>
              <Input
                id="audit-entity"
                data-testid="input-audit-entity"
                placeholder="e.g. invoice"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-from" className="text-xs">From</Label>
              <Input
                id="audit-from"
                data-testid="input-audit-date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-to" className="text-xs">To</Label>
              <Input
                id="audit-to"
                data-testid="input-audit-date-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={exportAuditLog}
            disabled={!entries || entries.length === 0}
            data-testid="button-export-audit-log"
            className="shrink-0"
          >
            <Download className="w-4 h-4 mr-2" /> Export CSV
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
        </CardContent>
      </Card>
    </div>
  );
}
