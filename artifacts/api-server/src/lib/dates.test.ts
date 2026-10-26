import { describe, it, expect } from "vitest";
import { formatDate, formatDateTime, formatMonth, formatMonthRange, formatDateRange } from "./dates";

describe("CEPS server output dates", () => {
  it("preserves date-only calendar values, including the Pacific day-shift regression", () => {
    expect(formatDate("2026-03-01")).toBe("03/01/2026");
    expect(formatDate("2024-02-29")).toBe("02/29/2024");
    expect(formatDate("2026-02-29")).toBe("—");
    expect(formatDate(null)).toBe("—");
  });
  it("converts instants into Pacific dates and twelve-hour timestamps", () => {
    expect(formatDateTime("2026-03-01T07:30Z")).toBe("02/28/2026 11:30 PM");
    expect(formatDateTime(new Date("2026-10-22T22:05Z"))).toBe("10/22/2026 3:05 PM");
    expect(formatDateTime("2026-07-01T07:00Z")).toBe("07/01/2026 12:00 AM");
    expect(formatDateTime(undefined)).toBe("—");
  });
  it("uses MM/YYYY for service months", () => {
    expect(formatMonth("2026-10")).toBe("10/2026");
    expect(formatMonth("2026-00")).toBe("—");
  });
  it("uses full numeric month endpoints, even across years", () => {
    expect(formatMonthRange("2026-12", "2027-01")).toBe("12/2026 – 01/2027");
    expect(formatMonthRange(null, null)).toBe("—");
  });
  it("uses full numeric calendar endpoints for date ranges", () => {
    expect(formatDateRange("2026-03-01", "2026-03-31")).toBe("03/01/2026 – 03/31/2026");
    expect(formatDateRange("2026-03-01", null)).toBe("03/01/2026");
  });
});
