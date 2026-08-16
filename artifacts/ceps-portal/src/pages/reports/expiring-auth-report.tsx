import React, { useState } from 'react';
import {
  useGetExpiringAuthReport,
  getExpiringAuthReport,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Download } from 'lucide-react';
import { Link } from 'wouter';
import { ClientLink, VendorLink } from '@/components/entity-links';
import { downloadCSV } from '@/lib/csv';
import { formatMoney } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { PAGE_SIZE, ReportPagination } from './report-pagination';

const WINDOWS = [
  { value: '7', label: 'Next 7 days' },
  { value: '30', label: 'Next 30 days' },
  { value: '60', label: 'Next 60 days' },
  { value: '90', label: 'Next 90 days' },
];

export default function ExpiringAuthReport() {
  const [withinDays, setWithinDays] = useState('30');
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();

  const filterParams = { withinDays: Number(withinDays) };
  const params = { ...filterParams, limit: PAGE_SIZE, offset: page * PAGE_SIZE };

  const { data, isLoading } = useGetExpiringAuthReport(params, {
    query: { queryKey: ['expiringAuthReport', params] },
  });

  const items = data?.items;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setWindow = (value: string) => {
    setWithinDays(value);
    setPage(0);
  };

  const exportCSV = async () => {
    setExporting(true);
    try {
      const all: any[] = [];
      const batch = 1000;
      let offset = 0;
      for (;;) {
        const res = await getExpiringAuthReport({ ...filterParams, limit: batch, offset });
        all.push(...res.items);
        offset += res.items.length;
        if (res.items.length < batch || offset >= res.total) break;
      }
      const headers = ['Auth Number', 'Client', 'Vendor', 'Service Code', 'Expires', 'Days Until Expiry', 'Max Period Amount'];
      const rows = all.map((r: any) => [
        r.authNumber ?? '',
        r.clientName ?? '',
        r.vendorName ?? '',
        r.serviceCode ?? '',
        r.servicePeriodEnd ?? '',
        r.daysUntilExpiry ?? '',
        r.maxPeriodAmount != null ? formatMoney(r.maxPeriodAmount) : '',
      ]);
      downloadCSV('expiring_authorization_alerts.csv', headers, rows);
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
          <CardTitle>Expiring Authorization Alerts</CardTitle>
          <CardDescription>Active authorizations approaching the end of their service period.</CardDescription>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            <div className="space-y-1">
              <Label className="text-xs">Window</Label>
              <Select value={withinDays} onValueChange={setWindow}>
                <SelectTrigger data-testid="select-expiring-window"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WINDOWS.map((w) => (
                    <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={exportCSV} disabled={exporting || total === 0} data-testid="button-export-expiring-auth" className="shrink-0">
          <Download className="w-4 h-4 mr-2" />{exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <Table data-testid="table-expiring-auth">
          <TableHeader>
            <TableRow>
              <TableHead>Auth #</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="text-right">Days Left</TableHead>
              <TableHead className="text-right">Max Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="h-24"><Skeleton className="h-4 w-full" /></TableCell></TableRow>
            ) : !items || items.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No expiring authorizations.</TableCell></TableRow>
            ) : (
              items.map((r: any) => (
                <TableRow key={r.authorizationId} data-testid={`row-expiring-auth-${r.authorizationId}`}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/authorizations/${r.authorizationId}`} className="text-primary hover:underline">{r.authNumber}</Link>
                  </TableCell>
                  <TableCell className="font-medium"><ClientLink id={r.clientId} name={r.clientName} /></TableCell>
                  <TableCell className="text-muted-foreground"><VendorLink id={r.vendorId} name={r.vendorName} className="text-muted-foreground hover:underline" /></TableCell>
                  <TableCell className="text-muted-foreground">{r.servicePeriodEnd}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant="outline" className="bg-chart-1/10 text-chart-1 border-chart-1/20">{r.daysUntilExpiry}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-medium">{r.maxPeriodAmount != null ? `$${formatMoney(r.maxPeriodAmount)}` : '—'}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <ReportPagination page={page} pageCount={pageCount} total={total} setPage={setPage} testid="expiring-auth" />
      </CardContent>
    </Card>
  );
}
