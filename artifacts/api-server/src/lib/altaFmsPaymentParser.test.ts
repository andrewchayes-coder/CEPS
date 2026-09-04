import { describe, expect, it } from "vitest";
import { altaFmsPaymentRowFingerprint, parseAltaFmsPaymentWorksheet } from "./altaFmsPaymentParser";

const header = ["Transaction date", "Transaction type", "Num", "Name", "Description", "Split", "Amount", "Customer"];
describe("parseAltaFmsPaymentWorksheet", () => {
  it("parses both direct and repayment FMS layouts and ignores non-check rows", () => {
    const result = parseAltaFmsPaymentWorksheet([
      header,
      ["03/15/2026", "Check", "SYN-100", "Vendor", "Services/Mar 26/SYN-AUTH-1", "", "125.00", "Synthetic FMS, Person 1234567 (1)"],
      ["03/15/2026", "Check", "SYN-100", "Vendor", "Repayment/Services/Feb 26/SYN-AUTH-2", "", "45.50", "Synthetic FMS, Person 7654321 (2)"],
      ["03/15/2026", "Deposit", "", "", "", "", "10.00", ""],
    ]);
    expect(result.headerError).toBeNull();
    expect(result.ignoredNonCheckRows).toBe(1);
    expect(result.rows).toMatchObject([
      { rowNumber: 2, uciNumber: "1234567", authNumber: "SYN-AUTH-1", serviceMonth: "2026-03", paymentType: "direct_payment" },
      { rowNumber: 3, uciNumber: "7654321", authNumber: "SYN-AUTH-2", serviceMonth: "2026-02", paymentType: "reimbursement" },
    ]);
  });
  it("reports malformed Check rows rather than guessing", () => {
    const result = parseAltaFmsPaymentWorksheet([header, ["03/15/2026", "Check", "SYN-1", "", "Services/Mar 26/", "", "1.00", "Synthetic Person"]]);
    expect(result.rows).toHaveLength(0);
    expect(result.problems).toHaveLength(1);
  });
  it("fingerprints raw FMS fields stably across trim and case", () => {
    const row = { uciNumber: " 1234567 ", authNumber: "Auth-A", serviceMonth: "2026-03", amount: "125.00", checkNumber: " Check-1 ", checkDate: "2026-03-15" };
    expect(altaFmsPaymentRowFingerprint(row)).toBe(altaFmsPaymentRowFingerprint({ ...row, uciNumber: "1234567", authNumber: "auth-a", checkNumber: "check-1" }));
  });
});