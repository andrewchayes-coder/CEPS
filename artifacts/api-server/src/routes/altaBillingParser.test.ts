import { describe, it, expect } from "vitest";
import { BILLING_HEADERS, parseAltaBillingCsv, billingFingerprint } from "../lib/altaBillingParser";
import { parseAltaRemittanceCsv } from "../lib/altaRemittanceParser";
import { deriveBillingStatus } from "../lib/billingStatus";
import { syntheticBillingCsv, syntheticHeaders } from "./fixtures/altaBillingCsv";

describe("Alta billing parser (synthetic layout)", () => {
  const csv = syntheticBillingCsv([
    { amount: "40", total: "100" }, { code: "24", auth: "TEST-B", amount: "60", total: "100" },
    { code: "34", invoice: "TEST-002", amount: "10" }, { code: "490", invoice: "TEST-003", amount: "160" },
    { code: "35", invoice: "TEST-004", amount: "12" },
    { amount: "0", total: "100" }, { amount: "", total: "100" },
  ]);
  it("finds all 17 real-layout headers after six metadata lines and skips deferred rows", () => {
    const p = parseAltaBillingCsv(csv);
    expect(p.headers).toEqual(syntheticHeaders);
    expect(p.headers).toEqual(BILLING_HEADERS);
    expect(p.rows).toHaveLength(4); expect(p.deferred).toBe(2);
    expect(p).toMatchObject({ payeeProgramCount: 1, payeeProgramAmount: "10.00" });
    expect(p.rows[0]).toMatchObject({ rowNumber: 8, billedAt: "2026-07-30", billedAmount: "40.00", serviceMonth: "2026-07" });
    expect(p.rows.map(r => r.serviceCode)).toEqual(["459", "024", "490", "035"]);
  });
  it("includes skipped 034 amounts in invoice totals and skips them before FMS record validation", () => {
    const lines = [
      { amount: "40", total: "100" },
      { code: "034", amount: "60", total: "100", auth: "", uci: "", date: "", month: "" },
    ];
    const p = parseAltaBillingCsv(syntheticBillingCsv(lines));
    expect(p.rows).toHaveLength(1);
    expect(p).toMatchObject({ payeeProgramCount: 1, payeeProgramAmount: "60.00", deferred: 0 });
    expect(() => parseAltaBillingCsv(syntheticBillingCsv(lines.map(r => ({ ...r, total: "40" }))))).toThrow(/total.*100.00.*40.00/i);
  });
  it("supports a payee-only invoice and keeps deferred payee rows in the deferred count", () => {
    const p = parseAltaBillingCsv(syntheticBillingCsv([
      { code: "34", amount: "10" }, { code: "034", amount: "2.50", invoice: "TEST-002" },
      { code: "34", amount: "0", total: "10" },
    ]));
    expect(p).toMatchObject({ rows: [], payeeProgramCount: 2, payeeProgramAmount: "12.50", deferred: 1 });
  });
  it("rejects an invoice-total mismatch and inconsistent totals", () => {
    expect(() => parseAltaBillingCsv(syntheticBillingCsv([{ amount: "40", total: "100" }]))).toThrow(/total.*40.00.*100.00/i);
    expect(() => parseAltaBillingCsv(syntheticBillingCsv([{ amount: "40", total: "100" }, { amount: "60", total: "120" }]))).toThrow(/inconsistent/i);
  });
  it("rejects invalid dates and negative/nonfinite amounts", () => {
    for (const row of [{ date: "02/30/2026" }, { amount: "-10" }, { amount: "NaN" }, { date: "13/01/2026" }]) {
      expect(() => parseAltaBillingCsv(syntheticBillingCsv([row]))).toThrow();
    }
  });
  it("rejects the payment layout and the payment parser rejects billing", () => {
    expect(() => parseAltaBillingCsv("Date,RC Name,Amount,Reference #\n07/30/2026,Test,100,C1\nUCI #,Client Name,Auth #,Service,Sub Code,Service M/Y,Unit Type,Amount\n9999001,Test,A1,459,,07/2026,V,100")).toThrow(/Payment History/);
    expect(parseAltaRemittanceCsv(csv).headerError).toMatch(/Invoice History.*billing/);
  });
  it("uses source strings and amount for stable fingerprints, not resolved IDs", () => {
    const r = parseAltaBillingCsv(csv).rows[0];
    expect(billingFingerprint(r)).toMatch(/^[a-f0-9]{64}$/);
    expect(billingFingerprint({ ...r, rowNumber: 500 })).toBe(billingFingerprint(r));
    expect(billingFingerprint({ ...r, invoiceNumber: "REBILL" })).not.toBe(billingFingerprint(r));
  });
});

describe("derived billing status", () => {
  it.each([
    ["0", false, undefined, "pending"], ["0", true, undefined, "billed"],
    ["40", false, undefined, "partially_paid"], ["40", true, "invoiced", "partially_paid"],
    ["100", false, undefined, "paid"], ["120", true, undefined, "paid"],
    ["0", false, "invoiced", "billed"], ["0", false, "collected", "paid"],
    ["0", true, "waived", "waived"],
  ] as const)("remitted=%s billed=%s fee=%s → %s", (remitted, billed, fee, status) => {
    expect(deriveBillingStatus("100", remitted, billed, fee)).toBe(status);
  });
});
