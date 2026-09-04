import { createHash } from "node:crypto";
import { validatePositiveMoney, money } from "./money";
export { validatePositiveMoney };

const normalize = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const SUMMARY_HEADERS = ["Date", "Units", "Amount", "Reference #"] as const;
const DETAIL_HEADERS = ["UCI #", "Consumer Name", "Auth #", "Svc Code", "Sub-Code", "Service M/Y", "Units", "Amount", "Invoice #", "Adj Code", "Inv Amt"] as const;

export function altaRowFingerprint(row: { uciNumber: string; authNumber: string | null; serviceMonth: string | null; amount: string; checkNumber: string | null; remittanceDate: string }): string {
  const norm = (value: string | null) => (value ?? "").trim().toLowerCase();
  return createHash("sha256").update([norm(row.uciNumber), norm(row.authNumber), norm(row.serviceMonth), norm(row.amount), norm(row.checkNumber), norm(row.remittanceDate)].join("|")).digest("hex");
}

export interface AltaParsedRow { rowNumber: number; uciNumber: string; authNumber: string | null; serviceMonth: string | null; amount: string; checkNumber: string | null; remittanceDate: string; }
export interface AltaParseResult { rows: AltaParsedRow[]; problems: string[]; headerError: string | null; }

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (char === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (char === '"') quoted = false; else field += char; }
    else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; row.push(field); field = ""; if (row.some((cell) => cell.trim())) rows.push(row); row = []; }
    else field += char;
  }
  row.push(field); if (row.some((cell) => cell.trim())) rows.push(row); return rows;
}

export function toIsoDate(raw: string): string | null {
  const value = raw.trim(); if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) return `${match[3].length === 2 ? `20${match[3]}` : match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return null;
}
export function toServiceMonth(raw: string): string | null {
  const match = raw.trim().match(/^(0[1-9]|1[0-2])\/(\d{4})$/);
  return match ? `${match[2]}-${match[1]}` : null;
}
const matchesHeader = (row: string[], headers: readonly string[]) => headers.every((header, index) => normalize(row[index] ?? "") === normalize(header));

/** Parse Alta's multi-section Payment History Detail Report CSV. */
export function parseAltaRemittanceCsv(text: string): AltaParseResult {
  const grid = parseCsv(text);
  const summaryIndex = grid.findIndex((row) => matchesHeader(row, SUMMARY_HEADERS));
  const detailIndex = grid.findIndex((row) => matchesHeader(row, DETAIL_HEADERS));
  if (summaryIndex < 0 || detailIndex < 0 || detailIndex <= summaryIndex + 1) {
    return { rows: [], problems: [], headerError: `Expected Payment History Detail Report summary headers (${SUMMARY_HEADERS.join(", ")}) and detail headers (${DETAIL_HEADERS.join(", ")}).` };
  }
  const summary = grid[summaryIndex + 1];
  const remittanceDate = toIsoDate(summary[0] ?? "");
  const summaryAmount = validatePositiveMoney((summary[2] ?? "").replace(/[$,]/g, ""));
  const reference = (summary[3] ?? "").trim();
  if (!remittanceDate || !summaryAmount || !reference) return { rows: [], problems: [], headerError: "The Payment History summary row requires Date, positive Amount, and Reference #." };
  const rows: AltaParsedRow[] = []; const problems: string[] = [];
  for (let index = detailIndex + 1; index < grid.length; index++) {
    const detail = grid[index]; const rowNumber = index + 1;
    const uciNumber = (detail[0] ?? "").trim(); const authNumber = (detail[2] ?? "").trim();
    const serviceMonth = toServiceMonth(detail[5] ?? ""); const amount = validatePositiveMoney((detail[7] ?? "").replace(/[$,]/g, ""));
    if (!uciNumber || !authNumber || !serviceMonth || !amount) { problems.push(`Row ${rowNumber}: missing/invalid UCI #, Auth #, Service M/Y, or Amount — skipped.`); continue; }
    rows.push({ rowNumber, uciNumber, authNumber, serviceMonth, amount, checkNumber: reference, remittanceDate });
  }
  const total = rows.reduce((sum, row) => sum.plus(money(row.amount)), money(0)).toFixed(2);
  if (problems.length || total !== summaryAmount) return { rows: [], problems, headerError: total !== summaryAmount ? `Detail Amount total ${total} does not reconcile to summary Amount ${summaryAmount}.` : "The report contains malformed detail rows; no rows imported." };
  return { rows, problems, headerError: null };
}