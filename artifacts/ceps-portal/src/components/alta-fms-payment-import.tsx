import { useRef, useState } from 'react';
import { readSheet, type CellValue } from 'read-excel-file/browser';
import {
  useImportAltaFmsPayments,
  type AltaFmsPaymentImportResult,
} from '@workspace/api-client-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHeader, TableRow, SortableTableHead } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { stableSort, useTableSort } from '@/lib/table-sorting';
import { trackAnalyticsEvent } from '@/lib/analytics';

function cellText(cell: CellValue): string {
  if (cell == null) return '';
  if (cell instanceof Date) {
    const month = String(cell.getMonth() + 1).padStart(2, '0');
    const day = String(cell.getDate()).padStart(2, '0');
    return `${month}/${day}/${cell.getFullYear()}`;
  }
  return String(cell);
}

export function AltaFmsPaymentImport({ onImported }: { onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<AltaFmsPaymentImportResult | null>(null);
  const importMutation = useImportAltaFmsPayments();
  const { toast } = useToast();
  const { sort, onSort } = useTableSort<string>('rowNumber');
  const sortedResults = stableSort(result?.results ?? [], sort, {
    rowNumber: (row) => row.rowNumber,
    uciNumber: (row) => row.uciNumber,
    outcome: (row) => row.outcome,
    message: (row) => row.message,
  });

  const handleFile = async (file: File) => {
    setParseError(null);
    setResult(null);
    try {
      const workbookRows = await readSheet(file);
      const worksheetRows = workbookRows.map((row) => row.map(cellText));
      importMutation.mutate(
        { data: { worksheetRows } },
        {
          onSuccess: (res) => {
            if (res.headerError) {
              setParseError(res.headerError);
              return;
            }
            if (res.parseProblems.length > 0) {
              toast({
                title: `${res.parseProblems.length} Check row(s) could not be imported`,
                description: res.parseProblems.slice(0, 3).join(' '),
              });
            }
            trackAnalyticsEvent('bulk_import_completed', {
              entity: 'payments',
              imported: res.imported,
              errored: res.errored,
              duplicate: res.skippedDuplicate,
              flagged_duplicate: res.flaggedDuplicate,
            });
            setResult(res);
            onImported();
          },
          onError: (error: unknown) => {
            setParseError((error as { data?: { error?: string } })?.data?.error || 'Import failed.');
          },
        },
      );
    } catch {
      setParseError('Could not read this workbook. Choose the Alta FMS Transaction Detail by Account .xlsx file.');
    }
  };

  const outcomeBadge = (outcome: string) => {
    if (outcome === 'imported') return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Imported</Badge>;
    if (outcome === 'skipped_duplicate') return <Badge variant="secondary">Duplicate (skipped)</Badge>;
    if (outcome === 'flagged_duplicate') return <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">Needs review</Badge>;
    return <Badge variant="destructive">Errored</Badge>;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setResult(null);
          setParseError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-import-alta-fms-payments">
          <Upload className="mr-2 h-4 w-4" /> Import Alta FMS Payments
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Alta FMS Payments</DialogTitle>
          <DialogDescription>
            Upload the Alta FMS Transaction Detail by Account Excel workbook. Check rows are resolved to
            participants by UCI and to their authorization and service month; Invoice and Deposit rows are ignored.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-3">
            <div
              role="button"
              tabIndex={0}
              data-testid="dropzone-alta-fms-payments"
              onClick={() => !importMutation.isPending && inputRef.current?.click()}
              onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && inputRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-muted-foreground/25 p-8 text-center text-sm transition-colors hover:border-primary/50"
            >
              {importMutation.isPending ? (
                <>
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <p className="text-muted-foreground">Validating and importing Check rows…</p>
                </>
              ) : (
                <>
                  <FileSpreadsheet className="h-6 w-6 text-muted-foreground" />
                  <p className="text-muted-foreground">Choose the Alta FMS Transaction Detail by Account workbook</p>
                  <p className="text-xs text-muted-foreground">
                    Expected columns: Transaction date, Transaction type, Num, Name, Description, Split, Amount, Customer
                  </p>
                </>
              )}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              data-testid="input-alta-fms-payments"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
                event.target.value = '';
              }}
            />
            <p className="text-xs text-muted-foreground">
              Each monthly Check line is imported separately. Re-uploading the same line is safe; duplicates are skipped.
              Historical imports do not create CEPS fees.
            </p>
            {parseError && <p className="text-sm text-destructive" data-testid="text-alta-fms-import-error">{parseError}</p>}
          </div>
        )}

        {result && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-5">
              <Count value={result.imported} label="Imported" className="text-green-700" testId="text-alta-fms-imported" />
              <Count value={result.skippedDuplicate} label="Duplicates" testId="text-alta-fms-duplicates" />
              <Count value={result.flaggedDuplicate} label="Needs review" className="text-amber-700" testId="text-alta-fms-flagged" />
              <Count value={result.errored} label="Errored" className="text-destructive" testId="text-alta-fms-errored" />
              <Count value={result.ignoredNonCheckRows} label="Non-Check rows ignored" testId="text-alta-fms-ignored" />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead sortDirection={sort.key === 'rowNumber' ? sort.direction : null} onSort={() => onSort('rowNumber')}>Row</SortableTableHead>
                  <SortableTableHead sortDirection={sort.key === 'uciNumber' ? sort.direction : null} onSort={() => onSort('uciNumber')}>UCI</SortableTableHead>
                  <SortableTableHead sortDirection={sort.key === 'outcome' ? sort.direction : null} onSort={() => onSort('outcome')}>Outcome</SortableTableHead>
                  <SortableTableHead sortDirection={sort.key === 'message' ? sort.direction : null} onSort={() => onSort('message')}>Detail</SortableTableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedResults.map((row) => (
                  <TableRow key={row.rowNumber}>
                    <TableCell className="font-mono text-sm">{row.rowNumber}</TableCell>
                    <TableCell className="font-mono text-sm">{row.uciNumber || '—'}</TableCell>
                    <TableCell>{outcomeBadge(row.outcome)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{row.message || 'Imported successfully.'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setResult(null)}>Import Another Workbook</Button>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Count({ value, label, className = '', testId }: { value: number; label: string; className?: string; testId: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className={`text-2xl font-semibold ${className}`} data-testid={testId}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}