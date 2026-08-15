import Decimal from "decimal.js";

// Decimal-safe money helpers. Postgres numeric(12,2) values arrive as strings;
// never coerce them through Number() for comparisons or sums (float drift can
// flip cent-level thresholds). Parse to Decimal, do exact math, and only format
// back to a fixed 2-decimal string at the storage/display boundary.

export type MoneyInput = string | number | Decimal | null | undefined;

// Parse a money-ish value to Decimal, treating null/undefined/"" as 0.
export function money(value: MoneyInput): Decimal {
  if (value == null || value === "") return new Decimal(0);
  return new Decimal(value);
}

// Exact sum of a list of money-ish values.
export function sumMoney(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(money(v)), new Decimal(0));
}

// Format a money-ish value to a fixed 2-decimal string for storage/display.
export function formatMoney(value: MoneyInput): string {
  return money(value).toFixed(2);
}
