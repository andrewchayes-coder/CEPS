import { createHash } from "node:crypto";
import { validatePositiveMoney } from "./money";
import { toIsoDate } from "./altaRemittanceParser";

const HEADERS = [
  "Transaction date", "Transaction type", "Num", "Name", "Description", "Split", "Amount", "Customer",
] as const;

const normalize = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export interface AltaFmsPaymentRow {
  rowNumber: number;
  uciNumber: string;
  authNumber: string;
  serviceMonth: string;
  amount: string;
  checkNumber: string;
  checkDate: string;
  paymentType: "direct_payment" | "reimbursement";
}

export interface AltaFmsPaymentParseResult {
  rows: AltaFmsPaymentRow[];
  problems: string[];
  headerError: string | null;
  ignoredNonCheckRows: number;
}

/** Stable fingerprint for one raw line in an Alta FMS payment worksheet. */
export function altaFmsPaymentRowFingerprint(row: Pick<AltaFmsPaymentRow, "uciNumber" | "authNumber" | "serviceMonth" | "amount" | "checkNumber" | "checkDate">): string {
  const norm = (value: string) => value.trim().toLowerCase();
  return createHash("sha256")
    .update([row.uciNumber, row.authNumber, row.serviceMonth, row.amount, row.checkNumber, row.checkDate].map(norm).join("|"))
    .digest("hex");
}

/** Parse the exported Alta FMS payment worksheet, preserving source row numbers. */
export function parseAltaFmsPaymentWorksheet(grid: string[][]): AltaFmsPaymentParseResult {
  if (!grid.length) return { rows: [], problems: [], headerError: "The worksheet is empty.", ignoredNonCheckRows: 0 };
  const normalized = grid[0].map(normalize);
  const expected = HEADERS.map(normalize);
  if (normalized.length !== expected.length || expected.some((header, i) => normalized[i] !== header)) {
    return { rows: [], problems: [], headerError: `Expected Alta FMS headers: ${HEADERS.join(", ")}.`, ignoredNonCheckRows: 0 };
  }
  const rows: AltaFmsPaymentRow[] = [];
  const problems: string[] = [];
  let ignoredNonCheckRows = 0;
  for (let index = 1; index < grid.length; index++) {
    const cells = grid[index].map((cell) => (cell ?? "").trim());
    const rowNumber = index + 1;
    if (cells[1].toLowerCase() !== "check") {
      ignoredNonCheckRows++;
      continue;
    }
    const customer = cells[7];
    const uci = customer.match(/(\d{7})\s*\(\d+\)\s*$/)?.[1];
    const segments = cells[4].split("/").map((s) => s.trim());
    const service = segments.length >= 3 ? segments[segments.length - 2].match(/^([A-Za-z]{3})\s*(\d{2})$/) : null;
    const authNumber = segments.length >= 3 ? segments[segments.length - 1] : "";
    const amount = validatePositiveMoney(cells[6].replace(/[$,]/g, ""));
    const checkDate = toIsoDate(cells[0]);
    if (!uci || !service || !MONTHS[service[1].toLowerCase()] || !authNumber || !amount || !cells[2] || !checkDate) {
      problems.push(`Row ${rowNumber}: malformed Check row (requires customer UCI, service month, authorization, check number, date, and positive amount).`);
      continue;
    }
    rows.push({
      rowNumber,
      uciNumber: uci,
      authNumber,
      serviceMonth: `20${service[2]}-${MONTHS[service[1].toLowerCase()]}`,
      amount,
      checkNumber: cells[2],
      checkDate,
      paymentType: /^repayment\b/i.test(segments[0] ?? "") ? "reimbursement" : "direct_payment",
    });
  }
  return { rows, problems, headerError: null, ignoredNonCheckRows };
}