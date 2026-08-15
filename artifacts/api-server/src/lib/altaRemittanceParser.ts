// ⚠️ INTERIM PLACEHOLDER — Alta "Payment Detail Report" column mapping.
//
// NO real sample of the Alta Payment Detail Report CSV exists yet, so the exact
// column headers below are an EDUCATED GUESS pending confirmation from CEPS
// (mirrors the fee placeholder pattern in routes/payments.ts — the marker
// `interim_..._pending_confirmation` makes this trivially greppable/swappable
// once a real report arrives).
//
// This module is intentionally the ONLY place the Alta column layout is
// assumed. When a sample lands, update ALTA_INTERIM_COLUMN_CANDIDATES and, if
// needed, the row-shaping below — nothing else in the import flow hard-codes
// column names. Kept dependency-free so it is unit-testable in isolation.
//
// INTERIM ASSUMED COLUMNS (any header casing / punctuation is normalized):
//   - Client UCI Number    → uciNumber      (required; resolves the client)
//   - Authorization Number → authNumber     (optional; scoped to that client)
//   - Service Month        → serviceMonth    (optional; normalized to YYYY-MM)
//   - Amount               → amount          (required; remitted dollar amount)
//   - Check/Payment Number → checkNumber     (optional; the Alta payment ref)
//   - Payment Date         → remittanceDate  (required; date funds were remitted)

import { createHash } from "node:crypto";
import { validatePositiveMoney } from "./money";

// Re-exported from money.ts (the shared home for money validation). Kept here so
// existing importers of altaRemittanceParser.validatePositiveMoney keep working.
export { validatePositiveMoney };

export const ALTA_INTERIM_MARKER = "interim_alta_columns_pending_confirmation";

/**
 * Deterministic sha256 fingerprint of a normalized Alta source report row. Used
 * to detect (and skip) re-uploaded rows. Fields are lower-cased/trimmed and
 * joined with a delimiter so identical report rows always hash the same,
 * regardless of upload order or batch. The amount is the canonical fixed(2)
 * value produced by the parser.
 */
export function altaRowFingerprint(row: {
  uciNumber: string;
  authNumber: string | null;
  serviceMonth: string | null;
  amount: string;
  checkNumber: string | null;
  remittanceDate: string;
}): string {
  const norm = (v: string | null) => (v ?? "").trim().toLowerCase();
  const key = [
    norm(row.uciNumber),
    norm(row.authNumber),
    norm(row.serviceMonth),
    norm(row.amount),
    norm(row.checkNumber),
    norm(row.remittanceDate),
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

export interface AltaParsedRow {
  /** 1-based source row (accounting for the header row) — for error reporting. */
  rowNumber: number;
  uciNumber: string;
  authNumber: string | null;
  serviceMonth: string | null; // YYYY-MM
  amount: string;
  checkNumber: string | null;
  remittanceDate: string; // ISO YYYY-MM-DD
}

export interface AltaParseResult {
  rows: AltaParsedRow[];
  /** Per-row parse problems (bad/missing required fields) for staff review. */
  problems: string[];
  /** Set when the required interim columns could not be located in the header. */
  headerError: string | null;
}

/** Interim header candidates, normalized (lowercase, alphanumerics only). */
const ALTA_INTERIM_COLUMN_CANDIDATES = {
  uciNumber: ["clientucinumber", "ucinumber", "uci", "clientuci", "consumeruci"],
  authNumber: ["authorizationnumber", "authnumber", "auth", "posnumber", "authno"],
  serviceMonth: ["servicemonth", "month", "serviceperiod", "periodmonth"],
  amount: ["amount", "paymentamount", "remittedamount", "amountpaid", "paid"],
  checkNumber: ["checknumber", "checkpaymentnumber", "paymentnumber", "checkno", "warrantnumber"],
  remittanceDate: ["paymentdate", "remittancedate", "date", "checkdate", "issuedate"],
} as const;

/** Minimal CSV parser with quoted-field support (RFC-4180 style). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
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
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function findColumn(headers: string[], candidates: readonly string[]): number {
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
  for (const cand of candidates) {
    const idx = norm.indexOf(cand);
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Normalize a date-ish string to ISO YYYY-MM-DD (or null if unparseable). */
export function toIsoDate(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Normalize a service-month-ish string to YYYY-MM (or null). */
export function toServiceMonth(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}$/.test(t)) return t;
  const iso = toIsoDate(t);
  return iso ? iso.slice(0, 7) : null;
}

/**
 * Parse raw CSV text of an Alta Payment Detail Report into structured
 * remittance rows. Required fields (UCI, amount, payment date) that are
 * missing/invalid produce a per-row problem instead of a guessed value —
 * unresolvable rows are surfaced, never fabricated.
 */
export function parseAltaRemittanceCsv(text: string): AltaParseResult {
  const grid = parseCsv(text);
  if (grid.length < 2) {
    return { rows: [], problems: [], headerError: "The CSV appears to be empty (no data rows found under the header)." };
  }
  const headers = grid[0];
  const cols = {
    uciNumber: findColumn(headers, ALTA_INTERIM_COLUMN_CANDIDATES.uciNumber),
    authNumber: findColumn(headers, ALTA_INTERIM_COLUMN_CANDIDATES.authNumber),
    serviceMonth: findColumn(headers, ALTA_INTERIM_COLUMN_CANDIDATES.serviceMonth),
    amount: findColumn(headers, ALTA_INTERIM_COLUMN_CANDIDATES.amount),
    checkNumber: findColumn(headers, ALTA_INTERIM_COLUMN_CANDIDATES.checkNumber),
    remittanceDate: findColumn(headers, ALTA_INTERIM_COLUMN_CANDIDATES.remittanceDate),
  };
  if (cols.uciNumber === -1 || cols.amount === -1 || cols.remittanceDate === -1) {
    return {
      rows: [],
      problems: [],
      headerError:
        `Could not find the required Alta columns (interim mapping: ${ALTA_INTERIM_MARKER}). ` +
        `Needed: Client UCI Number, Amount, Payment Date. Found headers: ${headers.join(", ")}`,
    };
  }

  const rows: AltaParsedRow[] = [];
  const problems: string[] = [];
  grid.slice(1).forEach((r, i) => {
    const rowNumber = i + 2; // 1-based, accounting for the header row
    const uciNumber = (r[cols.uciNumber] ?? "").trim();
    // Validate the amount as a finite positive decimal (≤2 places) via the
    // Decimal path — NOT Number(), which admits Infinity/exponents/NaN.
    const amount = validatePositiveMoney((r[cols.amount] ?? "").replace(/[$,]/g, ""));
    const remittanceDate = toIsoDate(r[cols.remittanceDate] ?? "");
    if (!uciNumber || !amount || !remittanceDate) {
      problems.push(`Row ${rowNumber}: missing/invalid UCI number, amount, or payment date — skipped.`);
      return;
    }
    const authNumber = cols.authNumber !== -1 ? (r[cols.authNumber] ?? "").trim() : "";
    const checkNumber = cols.checkNumber !== -1 ? (r[cols.checkNumber] ?? "").trim() : "";
    const serviceMonth = cols.serviceMonth !== -1 ? toServiceMonth(r[cols.serviceMonth] ?? "") : null;
    rows.push({
      rowNumber,
      uciNumber,
      amount,
      remittanceDate,
      authNumber: authNumber || null,
      checkNumber: checkNumber || null,
      serviceMonth,
    });
  });
  return { rows, problems, headerError: null };
}
