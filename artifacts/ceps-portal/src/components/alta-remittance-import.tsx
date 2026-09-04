import { useRef, useState } from 'react';
import {
  useImportAltaRemittances,
  type AltaRemittanceImportResult,
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
import { Download, FileUp, Loader2, Upload } from 'lucide-react';
import { stableSort, useTableSort } from '@/lib/table-sorting';
import { trackAnalyticsEvent } from '@/lib/analytics';
import { downloadCSV } from '@/lib/csv';

export function AltaRemittanceImport({ onImported }: { onImported: (result: AltaRemittanceImportResult) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<AltaRemittanceImportResult | null>(null);
  const importMutation = useImportAltaRemittances();
  const { toast } = useToast();
  const { sort, onSort } = useTableSort<string>('rowNumber');
  const sortedResults = stableSort(result?.results ?? [], sort, {
    rowNumber: (row) => row.rowNumber,
    uciNumber: (row) => row.uciNumber,
    outcome: (row) => {
      if (row.outcome === 'auto_matched') return 'Auto-matched';
      if (row.outcome === 'needs_manual_match') return 'Needs manual match';
      if (row.outcome === 'skipped_duplicate') return 'Duplicate (skipped)';
      return 'Errored';
    },
    message: (row) => row.message,
  });
  const correctionRows = result?.results.filter(
    (row) => row.outcome === 'needs_manual_match' || row.outcome === 'errored',
  ) ?? [];

  const remittanceOutcomeLabel = (outcome: string) => {
    if (outcome === 'auto_matched') return 'Auto-matched';
    if (outcome === 'needs_manual_match') return 'Needs manual match';
    if (outcome === 'skipped_duplicate') return 'Duplicate (skipped)';
    return 'Errored';
  };

  const downloadCorrectionReport = () => {
    if (correctionRows.length === 0) return;

    downloadCSV(
      'alta_remittance_corrections.csv',
      ['Source row', 'UCI', 'Outcome', 'Detail'],
      correctionRows.map((row) => [
        row.rowNumber,
        row.uciNumber ?? '',
        row.outcome === 'needs_manual_match' ? 'Needs manual match' : 'Errored',
        row.message ?? '',
      ]),
    );
    trackAnalyticsEvent('alta_correction_report_downloaded', {
      import_type: 'remittances',
      row_count: correctionRows.length,
      errored: correctionRows.filter((row) => row.outcome === 'errored').length,
      needs_manual_match: correctionRows.filter((row) => row.outcome === 'needs_manual_match').length,
    });
  };

  const downloadFullAudit = () => {
    if (!result || result.results.length === 0) return;

    downloadCSV(
      'alta_remittance_full_audit.csv',
      ['Source row', 'UCI', 'Outcome', 'Detail'],
      result.results.map((row) => [
        row.rowNumber,
        row.uciNumber ?? '',
        remittanceOutcomeLabel(row.outcome),
        row.message ?? '',
      ]),
    );
    trackAnalyticsEvent('alta_full_audit_downloaded', {
      import_type: 'remittances',
      row_count: result.results.length,
      auto_matched: result.results.filter((row) => row.outcome === 'auto_matched').length,
      needs_manual_match: result.results.filter((row) => row.outcome === 'needs_manual_match').length,
      skipped_duplicate: result.results.filter((row) => row.outcome === 'skipped_duplicate').length,
      errored: result.results.filter((row) => row.outcome === 'errored').length,
    });
  };

  const handleFile = (file: File) => {
    setParseError(null);
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const csvText = String(reader.result ?? '');
      if (!csvText.trim()) {
        setParseError('The file appears to be empty.');
        return;
      }
      importMutation.mutate(
        { data: { csvText } },
        {
          onSuccess: (res) => {
            if (res.headerError) {
              setParseError(res.headerError);
              return;
            }
            if (res.parseProblems && res.parseProblems.length > 0) {
              toast({
                title: `${res.parseProblems.length} row(s) skipped during parsing`,
                description: res.parseProblems.slice(0, 3).join(' '),
              });
            }
            trackAnalyticsEvent('remittance_report_imported', {
              parsed: res.parsed,
              imported: res.imported,
              errored: res.errored,
              auto_matched: res.autoMatched,
              needs_manual_match: res.needsManualMatch,
              skipped_duplicate: res.skippedDuplicate,
            });
            setResult(res);
            onImported(res);
          },
          onError: (err: unknown) => {
            setParseError((err as { data?: { error?: string } })?.data?.error || 'Import failed.');
          },
        },
      );
    };
    reader.readAsText(file);
  };

  const outcomeBadge = (outcome: string) => {
    if (outcome === 'auto_matched') return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Auto-matched</Badge>;
    if (outcome === 'needs_manual_match') return <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">Needs manual match</Badge>;
    if (outcome === 'skipped_duplicate') return <Badge variant="secondary">Duplicate (skipped)</Badge>;
    return <Badge variant="destructive">Errored</Badge>;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setResult(null);
          setParseError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-import-alta-remittances">
          <Upload className="w-4 h-4 mr-2" /> Import Payment History Detail Report
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Alta Payment History Detail Report</DialogTitle>
          <DialogDescription>
            Upload Alta&apos;s Payment History Detail Report CSV. The report summary supplies the payment
            date and reference number; each detail line is resolved by UCI, authorization, service month,
            and amount before matching.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-3">
            <div
              role="button"
              tabIndex={0}
              data-testid="dropzone-alta-remittances"
              onClick={() => !importMutation.isPending && inputRef.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
              className="flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-muted-foreground/25 p-8 text-center text-sm cursor-pointer hover:border-primary/50 transition-colors"
            >
              {importMutation.isPending ? (
                <>
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <p className="text-muted-foreground">Importing…</p>
                </>
              ) : (
                <>
                  <FileUp className="h-6 w-6 text-muted-foreground" />
                  <p className="text-muted-foreground">Choose the Alta Payment History Detail Report CSV</p>
                  <p className="text-xs text-muted-foreground">
                    Expected sections: Date / Amount / Reference # summary, followed by UCI #, Auth #,
                    Service M/Y, and Amount detail rows
                  </p>
                </>
              )}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              data-testid="input-alta-remittances-csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = '';
              }}
            />
            <p className="text-xs text-muted-foreground">
              The detail Amount total must reconcile to the summary Amount before any rows are imported.
            </p>
            {parseError && (
              <p className="text-sm text-destructive" data-testid="text-alta-import-error">{parseError}</p>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Batch id: <span className="font-mono" data-testid="text-alta-batch-id">{result.remittanceBatchId}</span> — {result.parsed} row(s) parsed
            </div>
            <div className="grid grid-cols-5 gap-3 text-center">
              <div className="rounded-md border p-3">
                <p className="text-2xl font-semibold" data-testid="text-alta-imported-count">{result.imported}</p>
                <p className="text-xs text-muted-foreground">Imported</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-2xl font-semibold text-green-700" data-testid="text-alta-automatched-count">{result.autoMatched}</p>
                <p className="text-xs text-muted-foreground">Auto-matched</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-2xl font-semibold text-amber-700" data-testid="text-alta-needsmatch-count">{result.needsManualMatch}</p>
                <p className="text-xs text-muted-foreground">Needs match</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-2xl font-semibold" data-testid="text-alta-skipped-count">{result.skippedDuplicate}</p>
                <p className="text-xs text-muted-foreground">Duplicates</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-2xl font-semibold text-destructive" data-testid="text-alta-errored-count">{result.errored}</p>
                <p className="text-xs text-muted-foreground">Errored</p>
              </div>
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
                {sortedResults.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-sm">{r.rowNumber}</TableCell>
                    <TableCell className="font-mono text-sm">{r.uciNumber}</TableCell>
                    <TableCell>{outcomeBadge(r.outcome)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {result.errored > 0 && (
              <p className="text-sm text-muted-foreground">
                Errored rows were not imported (unresolvable UCI or authorization). Fix the Payment History Detail Report and
                re-import, or log those remittances manually.
              </p>
            )}

            <div className="flex justify-end gap-2">
              {correctionRows.length > 0 && (
                <Button
                  variant="outline"
                  onClick={downloadCorrectionReport}
                  data-testid="button-download-alta-remittance-corrections"
                >
                  <Download className="mr-2 h-4 w-4" /> Download Corrections CSV
                </Button>
              )}
              {result.results.length > 0 && (
                <Button
                  variant="ghost"
                  onClick={downloadFullAudit}
                  data-testid="button-download-alta-remittance-full-audit"
                >
                  <Download className="mr-2 h-4 w-4" /> Download Full Audit CSV
                </Button>
              )}
              <Button variant="outline" onClick={() => setResult(null)}>Import Another File</Button>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
