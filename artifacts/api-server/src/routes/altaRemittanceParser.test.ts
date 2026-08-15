import { describe, it, expect } from "vitest";
import {
  parseAltaRemittanceCsv,
  toIsoDate,
  toServiceMonth,
  validatePositiveMoney,
  altaRowFingerprint,
  ALTA_INTERIM_MARKER,
} from "../lib/altaRemittanceParser";

const HEADER = "Client UCI Number,Authorization Number,Service Month,Amount,Check/Payment Number,Payment Date";

describe("parseAltaRemittanceCsv (interim Alta column mapping)", () => {
  it("parses well-formed rows into structured remittance rows", () => {
    const csv = [
      HEADER,
      'UCI-001,AUTH-9,2026-01,"$1,250.00",CHK-100,01/15/2026',
      "UCI-002,,2026-02,300.00,,2026-02-10",
    ].join("\n");
    const { rows, problems, headerError } = parseAltaRemittanceCsv(csv);
    expect(headerError).toBeNull();
    expect(problems).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      uciNumber: "UCI-001",
      authNumber: "AUTH-9",
      serviceMonth: "2026-01",
      amount: "1250.00",
      checkNumber: "CHK-100",
      remittanceDate: "2026-01-15",
    });
    // Optional auth/check absent → null, not guessed.
    expect(rows[1].authNumber).toBeNull();
    expect(rows[1].checkNumber).toBeNull();
    expect(rows[1].amount).toBe("300.00");
    expect(rows[1].remittanceDate).toBe("2026-02-10");
  });

  it("reports a header error (with the interim marker) when required columns are missing", () => {
    const csv = ["Name,Total,When", "Foo,100,2026-01-01"].join("\n");
    const { rows, headerError } = parseAltaRemittanceCsv(csv);
    expect(rows).toHaveLength(0);
    expect(headerError).toContain(ALTA_INTERIM_MARKER);
  });

  it("skips rows with missing/invalid required fields as per-row problems (never guesses)", () => {
    const csv = [
      HEADER,
      "UCI-001,AUTH-9,2026-01,100.00,CHK-1,2026-01-15", // valid
      ",AUTH-9,2026-01,100.00,CHK-2,2026-01-15", // missing UCI
      "UCI-003,AUTH-9,2026-01,notanumber,CHK-3,2026-01-15", // bad amount
      "UCI-004,AUTH-9,2026-01,100.00,CHK-4,", // missing date
    ].join("\n");
    const { rows, problems } = parseAltaRemittanceCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].uciNumber).toBe("UCI-001");
    expect(problems).toHaveLength(3);
    expect(problems.some((p) => p.includes("Row 3"))).toBe(true);
    expect(problems.some((p) => p.includes("Row 4"))).toBe(true);
    expect(problems.some((p) => p.includes("Row 5"))).toBe(true);
  });

  it("returns a header error for an empty file", () => {
    const { headerError } = parseAltaRemittanceCsv("");
    expect(headerError).toBeTruthy();
  });
});

describe("date/month normalization helpers", () => {
  it("normalizes common date formats to ISO", () => {
    expect(toIsoDate("2026-03-04")).toBe("2026-03-04");
    expect(toIsoDate("3/4/2026")).toBe("2026-03-04");
    expect(toIsoDate("03/04/26")).toBe("2026-03-04");
    expect(toIsoDate("not a date")).toBeNull();
    expect(toIsoDate("")).toBeNull();
  });

  it("normalizes service months to YYYY-MM", () => {
    expect(toServiceMonth("2026-05")).toBe("2026-05");
    expect(toServiceMonth("2026-05-20")).toBe("2026-05");
    expect(toServiceMonth("")).toBeNull();
  });
});

describe("validatePositiveMoney (Decimal path, not Number())", () => {
  it("accepts finite positive decimals with ≤2 places and canonicalizes them", () => {
    expect(validatePositiveMoney("100")).toBe("100.00");
    expect(validatePositiveMoney("100.5")).toBe("100.50");
    expect(validatePositiveMoney("0.01")).toBe("0.01");
    expect(validatePositiveMoney(".5")).toBe("0.50");
    expect(validatePositiveMoney("1250.00")).toBe("1250.00");
  });

  it("rejects Infinity, exponents, NaN, negatives, zero, and >2 decimals", () => {
    for (const bad of ["Infinity", "-Infinity", "1e3", "1E3", "NaN", "-5.00", "0", "0.00", "1.234", "abc", "", "  ", "+5", "5.", "1,000"]) {
      expect(validatePositiveMoney(bad)).toBeNull();
    }
  });

  it("rejects bad amounts as row problems before any insert", () => {
    const csv = [
      "Client UCI Number,Amount,Payment Date",
      "UCI-1,Infinity,2026-01-01",
      "UCI-2,1e5,2026-01-01",
      "UCI-3,-10.00,2026-01-01",
      "UCI-4,1.234,2026-01-01",
      "UCI-5,50.00,2026-01-01", // the only valid row
    ].join("\n");
    const { rows, problems } = parseAltaRemittanceCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].uciNumber).toBe("UCI-5");
    expect(rows[0].amount).toBe("50.00");
    expect(problems).toHaveLength(4);
  });
});

describe("altaRowFingerprint", () => {
  const base = { uciNumber: "UCI-1", authNumber: "A-1", serviceMonth: "2026-01", amount: "50.00", checkNumber: "C1", remittanceDate: "2026-01-15" };
  it("is stable and case/whitespace-insensitive for identical rows", () => {
    const a = altaRowFingerprint(base);
    const b = altaRowFingerprint({ ...base, uciNumber: " uci-1 ", authNumber: "a-1" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("differs when any field changes", () => {
    expect(altaRowFingerprint(base)).not.toBe(altaRowFingerprint({ ...base, amount: "50.01" }));
    expect(altaRowFingerprint(base)).not.toBe(altaRowFingerprint({ ...base, checkNumber: "C2" }));
    expect(altaRowFingerprint(base)).not.toBe(altaRowFingerprint({ ...base, authNumber: null }));
  });
});
