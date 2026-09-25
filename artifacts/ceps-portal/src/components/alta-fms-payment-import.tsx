import { useRef, useState } from 'react';
import { readSheet, type CellValue } from 'read-excel-file/browser';
import {
  useAuditAltaFmsPayments,
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
import { Download, FileSpreadsheet, Upload, ShieldCheck, AlertTriangle } from 'lucide-react';
import { stableSort, useTableSort } from '@/lib/table-sorting';
import { trackAnalyticsEvent } from '@/lib/analytics';
import { downloadCSV } from '@/lib/csv';
import { Link } from 'wouter';
import { apiErrorMessage } from '@/lib/api-error';
import { auditLabel, downloadPaymentAudit, needsAcknowledgement, needsInvoiceChoice, type PaymentAuditReport, unacknowledgeableResults } from '@/lib/payment-audit';

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
  const selection = useRef(0);
  const [open, setOpen] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<AltaFmsPaymentImportResult | null>(null);
  const [audit, setAudit] = useState<PaymentAuditReport | null>(null);
  const [worksheetRows, setWorksheetRows] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [invoiceChoices, setInvoiceChoices] = useState<Record<number, string>>({});
  const auditMutation = useAuditAltaFmsPayments();
  const importMutation = useImportAltaFmsPayments();
  const { toast } = useToast();
  const { sort, onSort } = useTableSort<string>('rowNumber');
  const sortedResults = stableSort(result?.results ?? [], sort, {
    rowNumber: (row) => row.rowNumber,
    uciNumber: (row) => row.uciNumber,
    outcome: (row) => row.outcome,
    message: (row) => row.message,
  });
  const correctionRows = result?.results.filter(
    (row) => row.outcome === 'flagged_duplicate' || row.outcome === 'errored',
  ) ?? [];
  const outstanding = audit?.rows.filter(row => needsAcknowledgement(row) && !notes[row.rowNumber]?.trim()).length ?? 0;
  const unresolved = audit?.rows.filter(row => needsInvoiceChoice(row) &&
    !row.candidates?.some(candidate => candidate.invoiceId === invoiceChoices[row.rowNumber])).length ?? 0;
  const canImport = !!audit && !!worksheetRows && !audit.headerError && audit.rows.length > 0 &&
    outstanding === 0 && unresolved === 0 && !reading && !auditMutation.isPending && !importMutation.isPending;

  const paymentOutcomeLabel = (outcome: string) => {
    if (outcome === 'imported') return 'Imported';
    if (outcome === 'skipped_duplicate') return 'Duplicate (skipped)';
    if (outcome === 'flagged_duplicate') return 'Needs review';
    return 'Errored';
  };

  const downloadCorrectionReport = () => {
    if (correctionRows.length === 0) return;

    downloadCSV(
      'alta_fms_payment_corrections.csv',
      ['Source row', 'UCI', 'Outcome', 'Detail'],
      correctionRows.map((row) => [
        row.rowNumber,
        row.uciNumber ?? '',
        row.outcome === 'flagged_duplicate' ? 'Needs review' : 'Errored',
        row.message ?? '',
      ]),
    );
    trackAnalyticsEvent('alta_correction_report_downloaded', {
      import_type: 'payments',
      row_count: correctionRows.length,
      errored: correctionRows.filter((row) => row.outcome === 'errored').length,
      needs_review: correctionRows.filter((row) => row.outcome === 'flagged_duplicate').length,
    });
  };

  const downloadFullAudit = () => {
    if (!result || result.results.length === 0) return;

    downloadCSV(
      'alta_fms_payment_full_audit.csv',
      ['Source row', 'UCI', 'Outcome', 'Detail'],
      result.results.map((row) => [
        row.rowNumber,
        row.uciNumber ?? '',
        paymentOutcomeLabel(row.outcome),
        row.message ?? '',
      ]),
    );
    trackAnalyticsEvent('alta_full_audit_downloaded', {
      import_type: 'payments',
      row_count: result.results.length,
      imported: result.results.filter((row) => row.outcome === 'imported').length,
      skipped_duplicate: result.results.filter((row) => row.outcome === 'skipped_duplicate').length,
      flagged_duplicate: result.results.filter((row) => row.outcome === 'flagged_duplicate').length,
      errored: result.results.filter((row) => row.outcome === 'errored').length,
    });
  };

  const handleFile = async (file: File) => {
    const current = ++selection.current;
    setParseError(null);
    setResult(null);
    setAudit(null);
    setNotes({});
    setInvoiceChoices({});
    setWorksheetRows(null);
    setFileName(file.name);
    setReading(true);
    try {
      const workbookRows = await readSheet(file);
      if (current !== selection.current) return;
      const rows = workbookRows.map((row) => row.map(cellText));
      setWorksheetRows(rows);
      const report: PaymentAuditReport = await auditMutation.mutateAsync({ data: { worksheetRows: rows } });
      if (current !== selection.current) return;
      setAudit(report);
      if (report.headerError) setParseError(report.headerError);
    } catch (error) {
      if (current === selection.current) setParseError(
        worksheetRows ? apiErrorMessage(error, 'The audit could not be completed. Try again.') :
          'Could not read or audit this workbook. Check that it is an Alta FMS Transaction Detail by Account .xlsx file and try again.',
      );
    } finally {
      if (current === selection.current) setReading(false);
    }
  };

  const handleImport = () => {
    if (!canImport || !worksheetRows || !audit) return;
    const current = selection.current;
    importMutation.mutate(
      { data: {
        worksheetRows,
        acknowledgements: audit.rows.filter(needsAcknowledgement).map(row => ({
          rowNumber: row.rowNumber, note: notes[row.rowNumber].trim(),
          ...(needsInvoiceChoice(row) ? { invoiceId: invoiceChoices[row.rowNumber] } : {}),
        })),
      } },
      {
        onSuccess: (res) => {
          if (current !== selection.current) return;
          if (res.headerError) { setParseError(res.headerError); return; }
          if (res.parseProblems.length > 0) toast({
            title: `${res.parseProblems.length} Check row(s) could not be imported`,
            description: res.parseProblems.slice(0, 3).join(' '),
          });
          trackAnalyticsEvent('bulk_import_completed', {
            entity: 'payments', imported: res.imported, errored: res.errored,
            duplicate: res.skippedDuplicate, flagged_duplicate: res.flaggedDuplicate,
          });
          setResult(res);
          onImported();
        },
        onError: (error: unknown) => {
          if (current === selection.current) setParseError(apiErrorMessage(error, 'Import failed. Review the audit and try again.'));
        },
      },
    );
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
          selection.current++;
          setResult(null);
          setAudit(null);
          setWorksheetRows(null);
          setNotes({});
          setInvoiceChoices({});
          setParseError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-import-alta-fms-payments">
          <Upload className="mr-2 h-4 w-4" /> Import Alta FMS Payments
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Alta FMS Payments</DialogTitle>
          <DialogDescription>
            Upload the Alta FMS Transaction Detail by Account workbook. We compare every Check against approved invoices before anything is imported. Invoice and Deposit rows are ignored.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-3">
            <div
              role="button"
              tabIndex={0}
              data-testid="dropzone-alta-fms-payments"
              onClick={() => !importMutation.isPending && inputRef.current?.click()}
              onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !importMutation.isPending) { event.preventDefault(); inputRef.current?.click(); } }}
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-muted-foreground/25 p-8 text-center text-sm transition-colors hover:border-primary/50"
            >
              {reading || auditMutation.isPending || importMutation.isPending ? (
                <>
                  <div className="w-full max-w-xs space-y-2" aria-hidden="true">
                    <div className="h-3 w-3/5 animate-pulse rounded bg-primary/15" />
                    <div className="h-3 w-full animate-pulse rounded bg-primary/10" />
                    <div className="h-3 w-4/5 animate-pulse rounded bg-primary/10" />
                  </div>
                  <p className="text-muted-foreground">{importMutation.isPending ? 'Importing Check rows…' : 'Reading workbook and checking approved invoices…'}</p>
                </>
              ) : (
                <>
                  <FileSpreadsheet className="h-6 w-6 text-muted-foreground" />
                  <p className="text-muted-foreground">{fileName ? `${fileName} · Choose another workbook` : 'Choose the Alta FMS Transaction Detail by Account workbook'}</p>
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
            {parseError && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" data-testid="text-alta-fms-import-error">{parseError}</div>}
            {audit && (
              <section className="space-y-4" aria-label="Audit Report" data-testid="section-alta-fms-audit">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Pre-import review</p>
                    <h3 className="mt-1 flex items-center gap-2 text-xl font-semibold"><ShieldCheck className="h-5 w-5 text-primary" /> Audit Report</h3>
                    <p className="mt-1 text-sm text-muted-foreground">No payments have been saved. Review each exception before continuing.</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => downloadPaymentAudit(audit, downloadCSV)} data-testid="button-download-alta-fms-audit">
                    <Download className="mr-2 h-4 w-4" /> Download audit as CSV
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 text-sm" data-testid="summary-alta-fms-audit">
                  <Badge className="bg-green-100 text-green-800 hover:bg-green-100">{audit.summary.match ?? 0} match</Badge>
                  <Badge variant="outline">{audit.rows.length - (audit.summary.match ?? 0)} flagged</Badge>
                  <span className="text-muted-foreground">{audit.ignoredNonCheckRows ?? 0} non-Check rows ignored</span>
                </div>
                {!!audit.parseProblems?.length && (
                  <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="text-alta-fms-audit-parse-problems">
                    <strong>Workbook issues:</strong> {audit.parseProblems.join(' ')}
                  </div>
                )}
                {audit.rows.length === 0 && <p className="rounded-md border p-4 text-sm text-muted-foreground">No Check rows to import. Choose a workbook with Check transactions.</p>}
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[960px] text-left text-sm">
                    <thead className="bg-muted/50 text-xs text-muted-foreground"><tr>
                      {['Row / Check', 'Date', 'Participant', 'Payee on check / Approved vendor', 'Check / Approved / Remaining', 'Result & reason', 'Invoice'].map(label => <th key={label} scope="col" className="px-3 py-3 font-medium">{label}</th>)}
                    </tr></thead>
                    <tbody className="divide-y">
                      {audit.rows.map(row => {
                        const actionable = needsAcknowledgement(row);
                        const skipped = unacknowledgeableResults.includes(row.result);
                        return <tr key={row.rowNumber} className={row.result === 'match' ? 'bg-green-50/60' : 'bg-amber-50/40'} data-testid={`row-alta-fms-audit-${row.rowNumber}`}>
                          <td className="px-3 py-3 align-top"><span className="font-mono text-xs text-muted-foreground">#{row.rowNumber}</span><div className="font-medium">{row.checkNumber || 'No check #'}</div></td>
                          <td className="px-3 py-3 align-top whitespace-nowrap">{row.checkDate || '—'}</td>
                          <td className="px-3 py-3 align-top"><div>{row.participantName || 'Unknown'}</div><div className="font-mono text-xs text-muted-foreground">{row.uciNumber || '—'}</div></td>
                          <td className="px-3 py-3 align-top"><div>{row.payeeName || '—'}</div><div className="text-xs text-muted-foreground">Approved: {row.invoiceVendor || 'Not found'}</div></td>
                          <td className="px-3 py-3 align-top whitespace-nowrap"><div>{row.checkAmount ?? '—'}</div><div className="text-xs text-muted-foreground">Approved: {row.approvedAmount ?? '—'}<br />Remaining: {row.remainingAmount ?? '—'}</div></td>
                          <td className="min-w-56 px-3 py-3 align-top">
                            <Badge className={row.result === 'match' ? 'bg-green-100 text-green-800 hover:bg-green-100' : 'bg-amber-100 text-amber-900 hover:bg-amber-100'}>{auditLabel(row.result)}</Badge>
                            <p className="mt-1 text-xs leading-relaxed">{row.reason || (row.result === 'match' ? 'Payee and amount match the approved invoice.' : 'Review this check before importing.')}</p>
                            {skipped && <p className="mt-1 text-xs font-medium text-muted-foreground">Cannot acknowledge · skipped on import</p>}
                            {actionable && <div className="mt-3">
                              <label htmlFor={`audit-note-${row.rowNumber}`} className="block text-xs font-medium">Acknowledgment note <span className="text-destructive">*</span></label>
                              <textarea id={`audit-note-${row.rowNumber}`} rows={2} value={notes[row.rowNumber] ?? ''} onChange={e => setNotes(prev => ({ ...prev, [row.rowNumber]: e.target.value }))}
                                aria-required="true" data-testid={`input-alta-fms-audit-note-${row.rowNumber}`} placeholder="Why is this exception acceptable?" className="mt-1 w-full rounded-md border bg-background p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                            </div>}
                            {needsInvoiceChoice(row) && <fieldset className="mt-3 space-y-2" data-testid={`choices-alta-fms-audit-${row.rowNumber}`}>
                              <legend className="text-xs font-semibold">Choose the approved invoice <span className="text-destructive">*</span></legend>
                              <p className="text-xs text-muted-foreground">Several invoices could apply. Verify the invoice before choosing; no selection is made automatically.</p>
                              {row.candidates?.map((candidate, index) => (
                                <div key={candidate.invoiceId} className="rounded-md border bg-background p-2">
                                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                                    <input type="radio" name={`audit-invoice-${row.rowNumber}`} value={candidate.invoiceId}
                                      checked={invoiceChoices[row.rowNumber] === candidate.invoiceId}
                                      onChange={() => setInvoiceChoices(prev => ({ ...prev, [row.rowNumber]: candidate.invoiceId }))}
                                      data-testid={`radio-alta-fms-audit-invoice-${row.rowNumber}-${index}`} className="mt-0.5 accent-primary" />
                                    <span><strong>{candidate.vendorName || 'Unknown vendor'}</strong><br />Approved: {candidate.approvedAmount ?? '—'} · Remaining: {candidate.remainingAmount ?? 'Uncertain (unlinked allocations)'}
                                      {candidate.reviewedBy && <><br />Reviewed by {candidate.reviewedBy}{candidate.reviewedAt ? ` · ${candidate.reviewedAt}` : ''}</>}
                                    </span>
                                  </label>
                                  <Link href={`/invoices/${candidate.invoiceId}`} target="_blank" rel="noopener noreferrer"
                                    data-testid={`link-alta-fms-audit-candidate-${row.rowNumber}-${index}`} className="ml-5 text-xs text-primary underline underline-offset-2">View invoice</Link>
                                </div>
                              ))}
                            </fieldset>}
                          </td>
                          <td className="px-3 py-3 align-top">
                            {row.invoiceId ? <Link href={`/invoices/${row.invoiceId}`} target="_blank" rel="noopener noreferrer" data-testid={`link-alta-fms-audit-invoice-${row.rowNumber}`} className="text-primary underline underline-offset-2">View invoice</Link> : '—'}
                            {row.reviewedBy && <p className="mt-1 text-xs text-muted-foreground">Approved by {row.reviewedBy}{row.reviewedAt ? ` · ${row.reviewedAt}` : ''}</p>}
                          </td>
                        </tr>;
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/50 p-3">
                  <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                    {outstanding > 0 && <AlertTriangle className="h-4 w-4 text-amber-700" />}
                    {outstanding > 0 || unresolved > 0
                      ? `${outstanding} note${outstanding === 1 ? '' : 's'} and ${unresolved} invoice choice${unresolved === 1 ? '' : 's'} still required.`
                      : 'Review complete. Unresolvable rows will be skipped.'}
                  </p>
                  <Button onClick={handleImport} disabled={!canImport} data-testid="button-confirm-alta-fms-import">
                    {importMutation.isPending ? 'Importing…' : 'Import reviewed checks'}
                  </Button>
                </div>
              </section>
            )}
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
              {correctionRows.length > 0 && (
                <Button
                  variant="outline"
                  onClick={downloadCorrectionReport}
                  data-testid="button-download-alta-fms-corrections"
                >
                  <Download className="mr-2 h-4 w-4" /> Download Corrections CSV
                </Button>
              )}
              {result.results.length > 0 && (
                <Button
                  variant="ghost"
                  onClick={downloadFullAudit}
                  data-testid="button-download-alta-fms-full-audit"
                >
                  <Download className="mr-2 h-4 w-4" /> Download Full Audit CSV
                </Button>
              )}
              <Button variant="outline" onClick={() => {
                selection.current++;
                setResult(null);
                setAudit(null);
                setNotes({});
                setInvoiceChoices({});
                setWorksheetRows(null);
                setFileName('');
                setParseError(null);
              }}>Import Another Workbook</Button>
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