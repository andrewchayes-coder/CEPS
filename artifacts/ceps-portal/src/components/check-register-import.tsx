import { useRef, useState } from 'react';
import {
  useImportCheckRegister,
  type CheckRegisterRow,
  type CheckRegisterImportResult,
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

/** Minimal CSV parser with quoted-field support. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function findColumn(headers: string[], candidates: string[]): number {
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const cand of candidates) {
    const idx = norm.indexOf(cand);
    if (idx !== -1) return idx;
  }
  return -1;
}

function toIsoDate(raw: string): string | null {
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function CheckRegisterImport({ onImported }: { onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckRegisterImportResult | null>(null);
  const importMutation = useImportCheckRegister();
  const { toast } = useToast();

  const handleFile = (file: File) => {
    setParseError(null);
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseCsv(String(reader.result ?? ''));
      if (rows.length < 2) {
        setParseError('The CSV appears to be empty (no data rows found under the header).');
        return;
      }
      const headers = rows[0];
      const colCheck = findColumn(headers, ['checknumber', 'qbchecknumber', 'checkno', 'check', 'num', 'number', 'refno']);
      const colDate = findColumn(headers, ['checkdate', 'date', 'paymentdate']);
      const colAmount = findColumn(headers, ['amount', 'paymentamount', 'debit']);
      const colClient = findColumn(headers, ['clientname', 'client', 'consumer', 'consumername']);
      const colPayee = findColumn(headers, ['payeename', 'payee', 'vendor', 'vendorname', 'name']);
      const colMemo = findColumn(headers, ['memo', 'description', 'notes']);
      if (colCheck === -1 || colDate === -1 || colAmount === -1) {
        setParseError(
          `Could not find the required columns. Needed: check number, date, amount. Found headers: ${headers.join(', ')}`,
        );
        return;
      }
      const parsed: CheckRegisterRow[] = [];
      const problems: string[] = [];
      rows.slice(1).forEach((r, i) => {
        const qbCheckNumber = (r[colCheck] ?? '').trim();
        const isoDate = toIsoDate(r[colDate] ?? '');
        const amount = (r[colAmount] ?? '').replace(/[$,]/g, '').trim();
        if (!qbCheckNumber || !isoDate || !amount || isNaN(Number(amount))) {
          problems.push(`Row ${i + 2}: missing/invalid check number, date, or amount — skipped.`);
          return;
        }
        parsed.push({
          qbCheckNumber,
          checkDate: isoDate,
          amount,
          ...(colClient !== -1 && r[colClient]?.trim() ? { clientName: r[colClient].trim() } : {}),
          ...(colPayee !== -1 && r[colPayee]?.trim() ? { payeeName: r[colPayee].trim() } : {}),
          ...(colMemo !== -1 && r[colMemo]?.trim() ? { memo: r[colMemo].trim() } : {}),
        });
      });
      if (parsed.length === 0) {
        setParseError('No valid rows found in the CSV.' + (problems.length ? ` ${problems[0]}` : ''));
        return;
      }
      if (problems.length > 0) {
        toast({
          title: `${problems.length} row(s) skipped during parsing`,
          description: problems.slice(0, 3).join(' '),
        });
      }
      importMutation.mutate(
        { data: { rows: parsed } },
        {
          onSuccess: (res) => {
            setResult(res);
            onImported();
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
    if (outcome === 'imported') return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Imported</Badge>;
    if (outcome === 'skipped_duplicate') return <Badge variant="secondary">Duplicate (check #)</Badge>;
    if (outcome === 'flagged_duplicate') return <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">Flagged duplicate</Badge>;
    return <Badge variant="destructive">Unmatched</Badge>;
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
        <Button variant="outline" data-testid="button-import-check-register">
          <Upload className="w-4 h-4 mr-2" /> Import Check Register
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Check Register</DialogTitle>
          <DialogDescription>
            Upload a QuickBooks check-register CSV. Rows are matched to clients by name; duplicates
            (by check number) are skipped automatically.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-3">
            <div
              role="button"
              tabIndex={0}
              data-testid="dropzone-check-register"
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
                  <p className="text-muted-foreground">Click to choose the check-register CSV</p>
                  <p className="text-xs text-muted-foreground">
                    Needs columns for check number, date, and amount (client name recommended)
                  </p>
                </>
              )}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              data-testid="input-check-register-csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = '';
              }}
            />
            {parseError && (
              <p className="text-sm text-destructive" data-testid="text-import-error">{parseError}</p>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-md border p-3">
                <p className="text-2xl font-semibold text-green-700" data-testid="text-imported-count">{result.imported}</p>
                <p className="text-xs text-muted-foreground">Imported</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-2xl font-semibold" data-testid="text-skipped-count">{result.skipped}</p>
                <p className="text-xs text-muted-foreground">Skipped (duplicates)</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-2xl font-semibold text-destructive" data-testid="text-unmatched-count">{result.unmatched}</p>
                <p className="text-xs text-muted-foreground">Unmatched</p>
              </div>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Check #</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.results.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-sm">{r.qbCheckNumber}</TableCell>
                    <TableCell>{outcomeBadge(r.outcome)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {result.unmatched > 0 && (
              <p className="text-sm text-muted-foreground">
                Unmatched rows were not imported. Create those payments manually from the payment form,
                or fix the client names in the CSV and re-import (already-imported checks are skipped).
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
