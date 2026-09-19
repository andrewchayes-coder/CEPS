import { money, validatePositiveMoney } from "./money";
import { parseCsv, toIsoDate } from "./altaRemittanceParser";

export type CheckRunRow = {
  rowNumber: number;
  vendorName: string;
  address: string;
  amount: string;
  checkNumber: string;
  checkDate: string;
};

export type CheckRunParseResult = {
  rows: CheckRunRow[];
  parsedCount: number;
  errors: string[];
};

const headerAliases: Record<keyof Omit<CheckRunRow, "rowNumber">, string[]> = {
  vendorName: ["vendor name", "vendor"],
  address: ["address", "vendor address"],
  amount: ["amount", "check amount"],
  checkNumber: ["check number", "check #", "num"],
  checkDate: ["check date", "date"],
};

const headerKey = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");

export function normalizeVendor(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function normalizeAddress(value: string | null): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function parseCheckRunCsv(csv: string, startDate: string, endDate: string): CheckRunParseResult {
  const rows = parseCsv(csv);
  if (!rows.length) return { rows: [], parsedCount: 0, errors: ["CSV is empty."] };
  const indexes = {} as Record<keyof Omit<CheckRunRow, "rowNumber">, number>;
  const headers = rows[0].map(headerKey);
  for (const [key, aliases] of Object.entries(headerAliases) as [keyof typeof headerAliases, string[]][]) {
    const index = headers.findIndex((header) => aliases.includes(header));
    if (index < 0) return { rows: [], parsedCount: 0, errors: [`Missing required column: ${aliases[0]}.`] };
    indexes[key] = index;
  }
  const parsed: CheckRunRow[] = [];
  const errors: string[] = [];
  for (let index = 1; index < rows.length; index++) {
    const source = rows[index];
    const rowNumber = index + 1;
    const vendorName = (source[indexes.vendorName] ?? "").trim();
    const address = (source[indexes.address] ?? "").trim();
    const amount = validatePositiveMoney((source[indexes.amount] ?? "").replace(/[$,]/g, ""));
    const checkNumber = (source[indexes.checkNumber] ?? "").trim();
    const checkDate = toIsoDate(source[indexes.checkDate] ?? "");
    if (!vendorName || !address || !amount || !checkNumber || !checkDate || !isValidIsoDate(checkDate)) {
      errors.push(`Row ${rowNumber}: vendor name, address, positive amount, check number, and valid check date are required.`);
      continue;
    }
    if (checkDate < startDate || checkDate > endDate) {
      errors.push(`Row ${rowNumber}: check date ${checkDate} is outside the requested date range.`);
      continue;
    }
    parsed.push({ rowNumber, vendorName, address, amount, checkNumber, checkDate });
  }
  return { rows: parsed, parsedCount: parsed.length, errors };
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export type ReconciliationPayment = {
  id: string;
  vendorName: string;
  /** Internal matching key; blank means the vendor is unknown and cannot match. */
  vendorKey?: string;
  address: string | null;
  amount: string;
  checkNumber: string;
  checkDate: string;
};

export type ReconciliationMatch = {
  payment: ReconciliationPayment | null;
  check: CheckRunRow | null;
  addressMatch: boolean;
};

export function reconcileCheckRun(payments: ReconciliationPayment[], checks: CheckRunRow[]) {
  const sortedPayments = [...payments].sort((a, b) => a.checkDate.localeCompare(b.checkDate) || a.checkNumber.localeCompare(b.checkNumber) || a.id.localeCompare(b.id));
  const sortedChecks = [...checks].sort((a, b) => a.checkDate.localeCompare(b.checkDate) || a.checkNumber.localeCompare(b.checkNumber) || a.rowNumber - b.rowNumber);
  const unusedPayments = new Set(sortedPayments.map((_, i) => i));
  const unusedChecks = new Set(sortedChecks.map((_, i) => i));
  const matched: ReconciliationMatch[] = [];
  const amountMismatches: ReconciliationMatch[] = [];
  const address = (payment: ReconciliationPayment, check: CheckRunRow) => normalizeAddress(payment.address) === normalizeAddress(check.address) && !!payment.address;
  for (const checkIndex of [...unusedChecks]) {
    const check = sortedChecks[checkIndex];
    const paymentIndex = [...unusedPayments].find((candidate) => {
      const payment = sortedPayments[candidate];
      const paymentVendor = payment.vendorKey ?? normalizeVendor(payment.vendorName);
      return paymentVendor !== "" && paymentVendor === normalizeVendor(check.vendorName) && money(payment.amount).equals(money(check.amount));
    });
    if (paymentIndex === undefined) continue;
    unusedChecks.delete(checkIndex);
    unusedPayments.delete(paymentIndex);
    matched.push({ payment: sortedPayments[paymentIndex], check, addressMatch: address(sortedPayments[paymentIndex], check) });
  }
  for (const checkIndex of [...unusedChecks]) {
    const check = sortedChecks[checkIndex];
    const paymentIndex = [...unusedPayments].find((candidate) => {
      const payment = sortedPayments[candidate];
      const paymentVendor = payment.vendorKey ?? normalizeVendor(payment.vendorName);
      return paymentVendor !== "" && paymentVendor === normalizeVendor(check.vendorName);
    });
    if (paymentIndex === undefined) continue;
    unusedChecks.delete(checkIndex);
    unusedPayments.delete(paymentIndex);
    amountMismatches.push({ payment: sortedPayments[paymentIndex], check, addressMatch: address(sortedPayments[paymentIndex], check) });
  }
  return {
    matched,
    paymentsWithoutChecks: [...unusedPayments].map((index) => ({ payment: sortedPayments[index], check: null, addressMatch: false })),
    checksWithoutPayments: [...unusedChecks].map((index) => ({ payment: null, check: sortedChecks[index], addressMatch: false })),
    amountMismatches,
  };
}