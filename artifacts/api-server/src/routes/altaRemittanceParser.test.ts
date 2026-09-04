import { describe, expect, it } from "vitest";
import { altaRowFingerprint, parseAltaRemittanceCsv } from "../lib/altaRemittanceParser";

const summary = ["Date", "Units", "Amount", "Reference #"];
const detail = ["UCI #", "Consumer Name", "Auth #", "Svc Code", "Sub-Code", "Service M/Y", "Units", "Amount", "Invoice #", "Adj Code", "Inv Amt"];
describe("Payment History Detail Report parser", () => {
  it("parses the real multi-section structure", () => {
    const csv = [...Array.from({ length: 6 }, () => ["Report metadata"]), summary, ["03/20/2026", "2", "125.00", "SYN-REF"], detail, ["1234567", "Synthetic Person", "SYN-AUTH", "459", "", "02/2026", "2", "125.00", "INV", "", "125.00"]].map((row) => row.join(",")).join("\n");
    const result = parseAltaRemittanceCsv(csv);
    expect(result.headerError).toBeNull();
    expect(result.rows[0]).toMatchObject({ rowNumber: 10, uciNumber: "1234567", authNumber: "SYN-AUTH", serviceMonth: "2026-02", amount: "125.00", checkNumber: "SYN-REF", remittanceDate: "2026-03-20" });
  });
  it("rejects a report whose detail total does not reconcile", () => {
    const csv = [summary, ["03/20/2026", "1", "10.00", "SYN"], detail, ["1234567", "Synthetic", "A", "", "", "02/2026", "1", "9.00"]].map((row) => row.join(",")).join("\n");
    expect(parseAltaRemittanceCsv(csv).headerError).toContain("does not reconcile");
  });
  it("has stable cross-path fingerprints", () => {
    expect(altaRowFingerprint({ uciNumber: " 1234567 ", authNumber: "a", serviceMonth: "2026-02", amount: "1.00", checkNumber: "x", remittanceDate: "2026-03-01" })).toBe(altaRowFingerprint({ uciNumber: "1234567", authNumber: "A", serviceMonth: "2026-02", amount: "1.00", checkNumber: "X", remittanceDate: "2026-03-01" }));
  });
});