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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { FileUp, Loader2, Upload } from 'lucide-react';

// ⚠️ The Alta "Payment Detail Report" CSV column mapping is INTERIM (pending a
// real sample) and lives server-side in the isolated parser
// (api-server/src/lib/altaRemittanceParser.ts, marker
// `interim_alta_columns_pending_confirmation`). This component just uploads the
// raw CSV text — it never assumes columns itself.
const ALTA_INTERIM_MARKER = 'interim_alta_columns_pending_confirmation';

export function AltaRemittanceImport({ onImported }: { onImported: (result: AltaRemittanceImportResult) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<AltaRemittanceImportResult | null>(null);
  const importMutation = useImportAltaRemittances();
  const { toast } = useToast();

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
          <Upload className="w-4 h-4 mr-2" /> Import Alta Report
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Alta Payment Detail Report</DialogTitle>
          <DialogDescription>
            Upload one Alta Payment Detail Report CSV. Each line becomes a remittance sharing a
            single batch id; rows are resolved to clients by UCI number and auto-matched to payments
            like manual entries. Unresolvable rows are reported, never guessed.
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
                  <p className="text-muted-foreground">Click to choose the Alta Payment Detail Report CSV</p>
                  <p className="text-xs text-muted-foreground">
                    Interim columns: Client UCI Number, Amount, Payment Date (Authorization Number,
                    Service Month, Check/Payment Number optional)
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
              ⚠️ Column mapping is interim ({ALTA_INTERIM_MARKER}) — a real Alta sample is still
              needed to confirm the exact headers.
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
                  <TableHead>Row</TableHead>
                  <TableHead>UCI</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.results.map((r, i) => (
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
                Errored rows were not imported (unresolvable UCI or authorization). Fix the report and
                re-import, or log those remittances manually.
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setResult(null)}>Import Another File</Button>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
