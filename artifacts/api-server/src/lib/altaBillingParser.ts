import { createHash } from "node:crypto";
import { parseCsv, toIsoDate, toServiceMonth } from "./altaRemittanceParser";
import { money, validatePositiveMoney } from "./money";

export const BILLING_HEADERS = ["Invoice Date", "Invoice #", "Service Month/Year", "Invoice Units", "Total Amount", "Client Name", "UCI #", "Auth #", "Auth Dates", "Total Units", "Service", "Sub-Code", "Unit Type", "Line Amount", "Notes", "Total Service Days", "Remote Service Days"];
export interface BillingSource {
  rowNumber: number; invoiceNumber: string; billedAt: string; uciNumber: string;
  authNumber: string; serviceCode: string; serviceMonth: string; billedAmount: string;
}
export const billingFingerprint = (r: BillingSource) => createHash("sha256")
  .update([r.invoiceNumber, r.uciNumber, r.authNumber, r.serviceMonth, r.billedAmount].join("|")).digest("hex");

export function parseAltaBillingCsv(text: string): { headers: string[]; rows: BillingSource[]; deferred: number } {
  const grid = parseCsv(text.replace(/^\uFEFF/, ""));
  const normalize = (s: string) => s.trim().toLowerCase();
  const headerIndex = grid.findIndex(r => BILLING_HEADERS.every(h => r.some(c => normalize(c) === normalize(h))));
  if (headerIndex < 0) {
    if (grid.some(r => r.some(c => /service m\/y|payment history/i.test(c)))) throw new Error("This is a Payment History file. Use the payment import; billing requires Alta Invoice History.");
    throw new Error(`Invoice History headers not found. Required: ${BILLING_HEADERS.join(", ")}.`);
  }
  const headers = grid[headerIndex].map(s => s.trim());
  const columns = new Map(headers.map((h, i) => [normalize(h), i]));
  const rows: BillingSource[] = [];
  const invoices = new Map<string, { expected: string; total: ReturnType<typeof money> }>();
  let deferred = 0;
  for (let i = headerIndex + 1; i < grid.length; i++) {
    const raw = grid[i];
    if (!raw.some(v => v.trim())) continue;
    if (raw.some(v => normalize(v) === "invoice date")) continue;
    const get = (name: string) => (raw[columns.get(normalize(name))!] ?? "").trim();
    const clean = (s: string) => s.replace(/[$,]/g, "");
    const amountText = clean(get("Line Amount"));
    const invoiceNumber = get("Invoice #");
    const expected = validatePositiveMoney(clean(get("Total Amount")));
    // Ignore a trailing textual total/footer, but never silently skip a data row.
    if (!invoiceNumber && !get("UCI #") && /^(grand )?total/i.test(raw[0] ?? "")) continue;
    if (!invoiceNumber || !expected) throw new Error(`Row ${i + 1}: Invoice # and a positive Total Amount are required.`);
    const invoice = invoices.get(invoiceNumber);
    if (invoice && invoice.expected !== expected) throw new Error(`Invoice ${invoiceNumber}: inconsistent Total Amount values.`);
    if (!invoice) invoices.set(invoiceNumber, { expected, total: money(0) });
    if (!amountText || /^0+(?:\.0{1,2})?$/.test(amountText)) { deferred++; continue; }
    const billedAmount = validatePositiveMoney(amountText);
    const billedAt = toIsoDate(get("Invoice Date"));
    const serviceMonth = toServiceMonth(get("Service Month/Year"));
    const service = get("Service");
    if (!billedAmount || !billedAt || !Number.isFinite(Date.parse(`${billedAt}T00:00:00Z`)) || new Date(`${billedAt}T00:00:00Z`).toISOString().slice(0, 10) !== billedAt ||
        !serviceMonth || !get("UCI #") || !get("Auth #") || !/^\d{1,3}$/.test(service)) {
      throw new Error(`Row ${i + 1}: invalid Invoice Date, Line Amount, service month, UCI, authorization or service code. Nothing imported.`);
    }
    invoices.get(invoiceNumber)!.total = invoices.get(invoiceNumber)!.total.plus(money(billedAmount));
    rows.push({ rowNumber: i + 1, invoiceNumber, billedAt, serviceMonth,
      uciNumber: get("UCI #"), authNumber: get("Auth #"), serviceCode: service.padStart(3, "0"), billedAmount });
  }
  for (const [number, invoice] of invoices) {
    if (!invoice.total.equals(money(invoice.expected))) throw new Error(`Invoice ${number}: positive Line Amounts total $${invoice.total.toFixed(2)}, but Total Amount is $${invoice.expected}. Nothing imported.`);
  }
  if (!rows.length) throw new Error("No positive billed rows found. Deferred rows do not mark anything Billed.");
  return { headers, rows, deferred };
}
