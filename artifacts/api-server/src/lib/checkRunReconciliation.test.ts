import { describe, expect, it } from "vitest";
import { parseCheckRunCsv, reconcileCheckRun } from "./checkRunReconciliation";

describe("check-run reconciliation", () => {
  it("parses aliases, quoted commas, and reports row errors", () => {
    const result = parseCheckRunCsv(
      'Vendor,Vendor Address,Check Amount,Check #,Date\n"Acme, Inc.","12 Main St, Suite 4",100.00,1001,2026-01-02\nBad Vendor,,0,,2026-01-03',
      "2026-01-01",
      "2026-01-31",
    );
    expect(result.parsedCount).toBe(1);
    expect(result.rows[0]).toMatchObject({ vendorName: "Acme, Inc.", address: "12 Main St, Suite 4", amount: "100.00", checkNumber: "1001" });
    expect(result.errors).toHaveLength(1);
  });

  it("consumes exact matches first, then same-vendor amount mismatches one-to-one", () => {
    const payments = [
      { id: "p1", vendorName: " Acme  ", address: "12 Main St", amount: "100.00", checkNumber: "app-1", checkDate: "2026-01-01" },
      { id: "p2", vendorName: "Acme", address: "12 Main St", amount: "200.00", checkNumber: "app-2", checkDate: "2026-01-02" },
      { id: "p3", vendorName: "Other", address: "1 Other St", amount: "50.00", checkNumber: "app-3", checkDate: "2026-01-03" },
    ];
    const checks = [
      { rowNumber: 2, vendorName: "ACME", address: "12 MAIN ST", amount: "100.00", checkNumber: "c-1", checkDate: "2026-01-01" },
      { rowNumber: 3, vendorName: "Acme", address: "Old address", amount: "250.00", checkNumber: "c-2", checkDate: "2026-01-02" },
      { rowNumber: 4, vendorName: "Missing", address: "9 Nowhere", amount: "25.00", checkNumber: "c-3", checkDate: "2026-01-03" },
    ];
    const report = reconcileCheckRun(payments, checks);
    expect(report.matched).toHaveLength(1);
    expect(report.matched[0].addressMatch).toBe(true);
    expect(report.amountMismatches).toHaveLength(1);
    expect(report.amountMismatches[0].payment?.id).toBe("p2");
    expect(report.amountMismatches[0].addressMatch).toBe(false);
    expect(report.paymentsWithoutChecks.map((row) => row.payment?.id)).toEqual(["p3"]);
    expect(report.checksWithoutPayments.map((row) => row.check?.checkNumber)).toEqual(["c-3"]);
  });

  it("uses exact amount before mismatch regardless of input order", () => {
    const report = reconcileCheckRun(
      [
        { id: "p-200", vendorName: "Vendor", address: "A", amount: "200", checkNumber: "2", checkDate: "2026-01-02" },
        { id: "p-100", vendorName: "Vendor", address: "A", amount: "100", checkNumber: "1", checkDate: "2026-01-01" },
      ],
      [
        { rowNumber: 2, vendorName: " vendor ", address: "A", amount: "150.00", checkNumber: "c150", checkDate: "2026-01-01" },
        { rowNumber: 3, vendorName: "VENDOR", address: "A", amount: "200.0", checkNumber: "c200", checkDate: "2026-01-02" },
      ],
    );
    expect(report.matched[0].payment?.id).toBe("p-200");
    expect(report.amountMismatches[0].payment?.id).toBe("p-100");
  });

  it("pairs duplicate amounts once and leaves deterministic surplus unmatched", () => {
    const payments = [
      { id: "p2", vendorName: "V", address: "A", amount: "100.0", checkNumber: "z", checkDate: "2026-01-02" },
      { id: "p1", vendorName: "V", address: "A", amount: "100.00", checkNumber: "a", checkDate: "2026-01-01" },
      { id: "p3", vendorName: "V", address: "100 A", amount: "100", checkNumber: "b", checkDate: "2026-01-03" },
    ];
    const checks = [
      { rowNumber: 4, vendorName: " V ", address: "A", amount: "100", checkNumber: "c2", checkDate: "2026-01-02" },
      { rowNumber: 2, vendorName: "v", address: "A", amount: "100.00", checkNumber: "c1", checkDate: "2026-01-01" },
    ];
    const report = reconcileCheckRun(payments, checks);
    expect(report.matched.map((row) => row.payment?.id)).toEqual(["p1", "p2"]);
    expect(report.paymentsWithoutChecks.map((row) => row.payment?.id)).toEqual(["p3"]);
  });

  it("never matches unknown vendors and normalizes whitespace, case, cents, and addresses", () => {
    const report = reconcileCheckRun(
      [
        { id: "known", vendorName: "  ACME   SUPPLY ", address: "12  Main St", amount: "100.0", checkNumber: "p", checkDate: "2026-01-01" },
        { id: "unknown", vendorName: "Unknown vendor", vendorKey: "", address: null, amount: "50.00", checkNumber: "u", checkDate: "2026-01-01" },
      ],
      [
        { rowNumber: 2, vendorName: "acme supply", address: "12 Main St", amount: "100.00", checkNumber: "c", checkDate: "2026-01-01" },
        { rowNumber: 3, vendorName: "Unknown vendor", address: "Nowhere", amount: "50", checkNumber: "u2", checkDate: "2026-01-01" },
      ],
    );
    expect(report.matched).toHaveLength(1);
    expect(report.matched[0].addressMatch).toBe(true);
    expect(report.paymentsWithoutChecks[0].payment?.id).toBe("unknown");
    expect(report.checksWithoutPayments[0].check?.checkNumber).toBe("u2");
  });

  it("marks a non-equal billing address for review", () => {
    const report = reconcileCheckRun(
      [{ id: "p", vendorName: "V", address: "12 Main Street", amount: "10", checkNumber: "p", checkDate: "2026-01-01" }],
      [{ rowNumber: 2, vendorName: "V", address: "99 Other Street", amount: "10", checkNumber: "c", checkDate: "2026-01-01" }],
    );
    expect(report.matched[0].addressMatch).toBe(false);
  });
});