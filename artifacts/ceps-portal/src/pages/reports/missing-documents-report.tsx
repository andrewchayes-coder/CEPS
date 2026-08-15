import React, { useState } from 'react';
import {
  useGetMissingDocumentsReport,
  getMissingDocumentsReport,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Download } from 'lucide-react';
import { downloadCSV } from '@/lib/csv';
import { useToast } from '@/hooks/use-toast';
import { PAGE_SIZE, ReportPagination } from './report-pagination';

const ALL = '__all__';

const DOC_LABELS: Record<string, string> = {
  w9: 'W-9',
  signature: 'Parent Signature',
  auth_pdf: 'Authorization PDF',
};

export default function MissingDocumentsReport({ initialDocType }: { initialDocType?: string }) {
  const [docType, setDocType] = useState(initialDocType ?? ALL);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();

  const filterParams = { ...(docType !== ALL ? { docType } : {}) };
  const params = { ...filterParams, limit: PAGE_SIZE, offset: page * PAGE_SIZE };

  const { data, isLoading } = useGetMissingDocumentsReport(params, {
    query: { queryKey: ['missingDocumentsReport', params] },
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
        const res = await getMissingDocumentsReport({ ...filterParams, limit: batch, offset });
        all.push(...res.items);
        offset += res.items.length;
        if (res.items.length < batch || offset >= res.total) break;
      }
      const headers = ['Document Type', 'Record', 'Client', 'Description'];
      const rows = all.map((r: any) => [
        DOC_LABELS[r.docType] ?? r.docType,
        r.entityName ?? '',
        r.clientName ?? '',
        r.description ?? '',
      ]);
      downloadCSV('missing_document_alerts.csv', headers, rows);
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
          <CardTitle>Missing Document Alerts</CardTitle>
          <CardDescription>Records missing a W-9, parent signature, or authorization PDF.</CardDescription>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            <div className="space-y-1">
              <Label className="text-xs">Document Type</Label>
              <Select value={docType} onValueChange={setFilter(setDocType)}>
                <SelectTrigger data-testid="select-missing-doc-type"><SelectValue placeholder="All documents" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All documents</SelectItem>
                  <SelectItem value="w9">W-9</SelectItem>
                  <SelectItem value="signature">Parent Signature</SelectItem>
                  <SelectItem value="auth_pdf">Authorization PDF</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={exportCSV} disabled={exporting || total === 0} data-testid="button-export-missing-docs" className="shrink-0">
          <Download className="w-4 h-4 mr-2" />{exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <Table data-testid="table-missing-docs">
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              <TableHead>Record</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="h-24"><Skeleton className="h-4 w-full" /></TableCell></TableRow>
            ) : !items || items.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No missing documents.</TableCell></TableRow>
            ) : (
              items.map((r: any, i: number) => (
                <TableRow key={`${r.entityType}-${r.entityId}-${r.docType}`} data-testid={`row-missing-doc-${i}`}>
                  <TableCell><Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">{DOC_LABELS[r.docType] ?? r.docType}</Badge></TableCell>
                  <TableCell className="font-medium">{r.entityName}</TableCell>
                  <TableCell className="text-muted-foreground">{r.clientName ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{r.description}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <ReportPagination page={page} pageCount={pageCount} total={total} setPage={setPage} testid="missing-docs" />
      </CardContent>
    </Card>
  );
}
