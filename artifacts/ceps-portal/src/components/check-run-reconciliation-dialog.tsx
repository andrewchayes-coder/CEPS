import { useRef, useState } from "react";
import { useReconcileCheckRun, type CheckRunReconciliationResponse } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ClipboardCheck, Loader2 } from "lucide-react";

type Props = { canReconcile: boolean };

function Bucket({ title, rows, amountMismatch = false }: { title: string; rows: CheckRunReconciliationResponse["matched"]; amountMismatch?: boolean }) {
  return (
    <section className="space-y-2" data-testid={`check-run-${title.toLowerCase().replaceAll(" ", "-")}`}>
      <h3 className="font-semibold">{title} ({rows.length})</h3>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
        <div className="overflow-x-auto border rounded-md">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left"><th className="p-2">Vendor</th><th className="p-2">App amount</th><th className="p-2">Check amount</th><th className="p-2">Check # / date</th><th className="p-2">Address</th></tr></thead>
            <tbody>{rows.map((row, index) => (
              <tr key={`${row.check?.rowNumber ?? row.payment?.id ?? index}`} className="border-b last:border-0">
                <td className="p-2">{row.payment?.vendorName ?? row.check?.vendorName ?? "Unknown vendor"}</td>
                <td className="p-2">{row.payment ? `$${row.payment.amount}` : "-"}</td>
                <td className="p-2">{row.check ? `$${row.check.amount}` : "-"}</td>
                <td className="p-2">{row.check?.checkNumber ?? row.payment?.checkNumber ?? "Not available"} / {row.check?.checkDate ?? row.payment?.checkDate ?? "Not available"}</td>
                <td className="p-2 min-w-[220px]">
                  <div><span className="font-medium">Uploaded check address:</span> {row.check?.address || "Not available"}</div>
                  <div><span className="font-medium">Current billing address:</span> {row.payment?.address || "Not available"}</div>
                  <div className="mt-1">{row.addressMatch ? <Badge variant="secondary">Address matches</Badge> : <Badge variant="destructive">{amountMismatch ? "Review amount/address" : "Review address"}</Badge>}</div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function CheckRunReconciliationDialog({ canReconcile }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [report, setReport] = useState<CheckRunReconciliationResponse | null>(null);
  const [clientError, setClientError] = useState("");
  const [requestError, setRequestError] = useState("");
  const mutation = useReconcileCheckRun();
  const { toast } = useToast();
  if (!canReconcile) return null;

  const submit = () => {
    setClientError("");
    if (!csv.trim() || !startDate || !endDate) {
      setClientError("Paste or upload a CSV and select a start and end date.");
      return;
    }
    if (startDate > endDate) {
      setClientError("Start date must be on or before end date.");
      return;
    }
    setRequestError("");
    mutation.mutate({ data: { csv, startDate, endDate } }, {
      onSuccess: (result) => setReport(result),
      onError: (error) => {
        const message = error instanceof Error && error.message ? error.message : "The check run could not be parsed or compared.";
        setRequestError(message);
        toast({ title: "Reconciliation failed", description: message });
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setReport(null); }}>
      <DialogTrigger asChild><Button variant="outline" data-testid="button-reconcile-check-run"><ClipboardCheck className="mr-2 h-4 w-4" /> Reconcile Check Run</Button></DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
        <DialogHeader><DialogTitle>Reconcile Check Run</DialogTitle><DialogDescription>Read-only comparison of a printed check run against approved, logged payments. Matching uses vendor name and amount; no data is imported or changed.</DialogDescription></DialogHeader>
        {!report && <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3"><label className="text-sm">Start date<Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} data-testid="input-check-run-start-date" /></label><label className="text-sm">End date<Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} data-testid="input-check-run-end-date" /></label></div>
          <Input ref={inputRef} type="file" accept=".csv,text/csv" data-testid="input-check-run-csv" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setCsv(await file.text()); }} />
          <Textarea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="Or paste the printed check run CSV here" rows={10} data-testid="textarea-check-run-csv" />
          {clientError && <p className="text-sm text-destructive" data-testid="text-check-run-error">{clientError}</p>}
          {requestError && <p className="text-sm text-destructive" data-testid="text-check-run-request-error">{requestError}</p>}
          <Button onClick={submit} disabled={mutation.isPending} data-testid="button-run-check-reconciliation">{mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Run read-only reconciliation</Button>
        </div>}
        {report && <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{[["Matched", report.matched.length], ["Payment Without Check", report.paymentsWithoutChecks.length], ["Check Without Payment", report.checksWithoutPayments.length], ["Amount Mismatch", report.amountMismatches.length]].map(([label, count]) => <div className="rounded-md border p-3" key={label}><div className="text-sm text-muted-foreground">{label}</div><div className="text-2xl font-semibold" data-testid={`text-check-run-${String(label).toLowerCase().replaceAll(" ", "-")}`}>{count}</div></div>)}</div>
          {report.errors.length > 0 && <div className="rounded-md border border-destructive p-3 text-sm" data-testid="check-run-parse-errors"><strong>Rows needing correction</strong><ul className="list-disc pl-5">{report.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
          <Bucket title="Matched" rows={report.matched} /><Bucket title="Payments Without Checks" rows={report.paymentsWithoutChecks} /><Bucket title="Checks Without Payments" rows={report.checksWithoutPayments} /><Bucket title="Amount Mismatches" rows={report.amountMismatches} amountMismatch />
          <Button variant="outline" onClick={() => setReport(null)} data-testid="button-check-run-new">Reconcile another run</Button>
        </div>}
      </DialogContent>
    </Dialog>
  );
}