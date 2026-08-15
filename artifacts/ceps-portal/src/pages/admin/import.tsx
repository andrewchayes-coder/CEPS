import { useRef, useState, type ReactElement } from 'react';
import {
  getImportTemplate,
  useValidateImport,
  useCommitImport,
  type ImportValidateResult,
  type ImportCommitResult,
} from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Download, FileUp, Loader2, Upload, CheckCircle2, RotateCcw } from 'lucide-react';

// The five entities the bulk-import system covers, in the documented build
// order. Kept in sync with the server-side field registry (importRegistry.ts).
const ENTITIES = [
  { value: 'clients', label: 'Clients' },
  { value: 'vendors', label: 'Vendors' },
  { value: 'authorizations', label: 'Authorizations' },
  { value: 'payments', label: 'Payments (historical — no fee auto-generated)' },
  { value: 'remittances', label: 'Remittances' },
] as const;

type Entity = (typeof ENTITIES)[number]['value'];

export default function AdminImportPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [entity, setEntity] = useState<Entity>('clients');
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [validation, setValidation] = useState<ImportValidateResult | null>(null);
  const [commitResult, setCommitResult] = useState<ImportCommitResult | null>(null);
  const [downloading, setDownloading] = useState(false);

  const validateMutation = useValidateImport();
  const commitMutation = useCommitImport();

  // Staff-only guard (nav already hides it, but defend the route too).
  if (user && user.role !== 'staff') {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Bulk Import</h1>
        <p className="text-muted-foreground">This page is available to staff only.</p>
      </div>
    );
  }

  const reset = () => {
    setCsvText(null);
    setFileName(null);
    setValidation(null);
    setCommitResult(null);
  };

  const onEntityChange = (v: string) => {
    setEntity(v as Entity);
    reset();
  };

  // Always fetch the template fresh from the API (never a cached/static file).
  const downloadTemplate = async () => {
    setDownloading(true);
    try {
      const csv = await getImportTemplate(entity, { responseType: 'text' } as never);
      const blob = new Blob([typeof csv === 'string' ? csv : String(csv)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${entity}-import-template.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: 'Could not download the template', variant: 'destructive' });
    } finally {
      setDownloading(false);
    }
  };

  const handleFile = (file: File) => {
    setValidation(null);
    setCommitResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      if (!text.trim()) {
        toast({ title: 'The file appears to be empty.', variant: 'destructive' });
        return;
      }
      setCsvText(text);
      setFileName(file.name);
      validateMutation.mutate(
        { entity, data: { csvText: text } },
        {
          onSuccess: (res) => setValidation(res),
          onError: (err: unknown) =>
            toast({
              title: 'Validation failed',
              description: (err as { data?: { error?: string } })?.data?.error || 'Please check the file and try again.',
              variant: 'destructive',
            }),
        },
      );
    };
    reader.readAsText(file);
  };

  const commit = () => {
    if (!csvText) return;
    commitMutation.mutate(
      { entity, data: { csvText } },
      {
        onSuccess: (res) => setCommitResult(res),
        onError: (err: unknown) =>
          toast({
            title: 'Import failed',
            description: (err as { data?: { error?: string } })?.data?.error || 'Nothing was imported.',
            variant: 'destructive',
          }),
      },
    );
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case 'valid':
        return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Valid</Badge>;
      case 'imported':
        return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Imported</Badge>;
      case 'duplicate':
      case 'skipped_duplicate':
        return <Badge variant="secondary">Duplicate (skipped)</Badge>;
      default:
        return <Badge variant="destructive">Error</Badge>;
    }
  };

  const canCommit = validation && !validation.headerError && validation.validRows > 0 && !commitResult;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Bulk Import</h1>
        <p className="text-muted-foreground mt-1">
          Import clients, vendors, authorizations, payments, and remittances from a CSV. Download the
          template, fill it in, then upload to preview and confirm. Duplicates are skipped, unresolvable
          rows are reported — nothing is guessed.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Choose what to import</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Select value={entity} onValueChange={onEntityChange}>
            <SelectTrigger className="w-72" data-testid="select-import-entity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENTITIES.map((e) => (
                <SelectItem key={e.value} value={e.value} data-testid={`option-${e.value}`}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={downloadTemplate} disabled={downloading} data-testid="button-download-template">
            {downloading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
            Download template
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Upload &amp; preview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div
            role="button"
            tabIndex={0}
            data-testid="dropzone-import"
            onClick={() => !validateMutation.isPending && inputRef.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
            className="flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-muted-foreground/25 p-8 text-center text-sm cursor-pointer hover:border-primary/50 transition-colors"
          >
            {validateMutation.isPending ? (
              <>
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <p className="text-muted-foreground">Validating…</p>
              </>
            ) : (
              <>
                <FileUp className="h-6 w-6 text-muted-foreground" />
                <p className="text-muted-foreground">
                  {fileName ? `Selected: ${fileName}` : 'Click to choose a CSV that matches the template'}
                </p>
                <p className="text-xs text-muted-foreground">Required columns are marked with an asterisk in the template.</p>
              </>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            data-testid="input-import-csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = '';
            }}
          />

          {validation?.headerError && (
            <p className="text-sm text-destructive" data-testid="text-import-header-error">
              {validation.headerError}
            </p>
          )}

          {validation && !validation.headerError && (
            <div className="space-y-4">
              <div className="grid grid-cols-4 gap-3 text-center">
                <div className="rounded-md border p-3">
                  <p className="text-2xl font-semibold" data-testid="text-total-rows">{validation.totalRows}</p>
                  <p className="text-xs text-muted-foreground">Rows</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-2xl font-semibold text-green-700" data-testid="text-valid-rows">{validation.validRows}</p>
                  <p className="text-xs text-muted-foreground">Valid</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-2xl font-semibold" data-testid="text-duplicate-rows">{validation.duplicateRows}</p>
                  <p className="text-xs text-muted-foreground">Duplicates</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-2xl font-semibold text-destructive" data-testid="text-error-rows">{validation.errorRows}</p>
                  <p className="text-xs text-muted-foreground">Errors</p>
                </div>
              </div>

              <PreviewTable rows={validation.results.map((r) => ({
                rowNumber: r.rowNumber,
                status: r.status,
                detail: r.message || (r.errors && r.errors.length ? r.errors.join('; ') : (r.warnings && r.warnings.length ? r.warnings.join('; ') : '')),
                statusBadge,
              }))} />
            </div>
          )}
        </CardContent>
      </Card>

      {validation && !validation.headerError && !commitResult && (
        <Card>
          <CardHeader>
            <CardTitle>3. Confirm import</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-muted-foreground">
              {validation.validRows} row(s) will be imported. {validation.duplicateRows} duplicate(s) and{' '}
              {validation.errorRows} errored row(s) will be skipped.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={reset} data-testid="button-import-reset">
                <RotateCcw className="w-4 h-4 mr-2" /> Start over
              </Button>
              <Button onClick={commit} disabled={!canCommit || commitMutation.isPending} data-testid="button-import-commit">
                {commitMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                Import {validation.validRows} row(s)
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {commitResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600" /> Import complete
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-md border p-3">
                <p className="text-2xl font-semibold text-green-700" data-testid="text-committed-imported">{commitResult.imported}</p>
                <p className="text-xs text-muted-foreground">Imported</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-2xl font-semibold" data-testid="text-committed-skipped">{commitResult.skippedDuplicate}</p>
                <p className="text-xs text-muted-foreground">Skipped (duplicate)</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-2xl font-semibold text-destructive" data-testid="text-committed-errored">{commitResult.errored}</p>
                <p className="text-xs text-muted-foreground">Errored</p>
              </div>
            </div>

            <PreviewTable rows={commitResult.results.map((r) => ({
              rowNumber: r.rowNumber,
              status: r.status,
              detail: r.message || (r.errors && r.errors.length ? r.errors.join('; ') : ''),
              statusBadge,
            }))} />

            <div className="flex justify-end">
              <Button onClick={reset} data-testid="button-import-done">Import another file</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface PreviewRow {
  rowNumber: number;
  status: string;
  detail: string;
  statusBadge: (status: string) => ReactElement;
}

function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  return (
    <div className="max-h-96 overflow-y-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Row</TableHead>
            <TableHead className="w-44">Status</TableHead>
            <TableHead>Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.rowNumber} data-testid={`row-import-${r.rowNumber}`}>
              <TableCell className="font-mono text-sm">{r.rowNumber}</TableCell>
              <TableCell>{r.statusBadge(r.status)}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{r.detail}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
