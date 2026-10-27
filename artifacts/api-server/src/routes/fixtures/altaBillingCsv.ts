// Synthetic only. Never copy names, UCIs or source report contents from attachments.
export const syntheticHeaders = ["Invoice Date", "Invoice #", "Service Month/Year", "Invoice Units", "Total Amount", "Client Name", "UCI #", "Auth #", "Auth Dates", "Total Units", "Service", "Sub-Code", "Unit Type", "Line Amount", "Notes", "Total Service Days", "Remote Service Days"];
export interface SyntheticBillingRow {
  invoice?: string; date?: string; month?: string; total?: string; amount?: string;
  uci?: string; auth?: string; code?: string; name?: string;
}
export function syntheticBillingCsv(rows: SyntheticBillingRow[]): string {
  const meta = [
    ["RC Name:", "Synthetic center", "Run Date:", "2026-10-27 10:00:00"],
    ["Vendor:", "TEST"], ["Name:", "SYNTHETIC TEST PAYEE"], ["", "TEST ONLY"],
    ["", "1 Test Street"], ["", "Example City, CA 00000"],
  ];
  const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
  return [...meta.map(r => [...r, ...Array(17 - r.length).fill("")]), syntheticHeaders,
    ...rows.map(r => [r.date ?? "07/30/2026", r.invoice ?? "TEST-001", r.month ?? "07/2026", "1", r.total ?? r.amount ?? "100",
      r.name ?? "EXAMPLE, SYNTHETIC", r.uci ?? "9999001", r.auth ?? "TEST-A", "07/01/26-12/31/26", "1",
      r.code ?? "459", "TEST", "V", r.amount ?? "100", r.amount === "0" || r.amount === "" ? "Deferred" : "", "1", "0"])]
    .map(r => r.map(quote).join(",")).join("\n");
}
