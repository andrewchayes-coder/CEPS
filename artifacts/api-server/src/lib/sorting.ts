import { asc, desc, sql, type SQL } from "drizzle-orm";

export type SortDirection = "asc" | "desc";

/**
 * Builds an allowlisted, NULLS LAST order with a unique tie-breaker. Query
 * schemas reject unknown keys before this helper is reached.
 */
export function sortedOrder(
  sortBy: string | undefined,
  sortDirection: SortDirection | undefined,
  columns: Record<string, SQL>,
  tieBreaker: SQL,
  defaultOrder: SQL[],
): SQL[] {
  if (!sortBy) return defaultOrder;
  const expression = columns[sortBy];
  if (!expression) return defaultOrder;
  const primary = sortDirection === "desc" ? desc(expression) : asc(expression);
  return [sql`${primary} nulls last`, asc(tieBreaker)];
}

/** Deterministic ordering for report rows assembled from more than one table. */
export function sortRows<T>(
  rows: T[],
  sortBy: string | undefined,
  sortDirection: SortDirection | undefined,
  value: (row: T, key: string) => string | number | boolean | null | undefined,
  id: (row: T) => string,
): T[] {
  if (!sortBy) return rows;
  const sign = sortDirection === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = value(a, sortBy);
    const bv = value(b, sortBy);
    if (av == null && bv == null) return id(a).localeCompare(id(b));
    if (av == null) return 1;
    if (bv == null) return -1;
    const compared =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { sensitivity: "base", numeric: true });
    return compared === 0 ? id(a).localeCompare(id(b)) : compared * sign;
  });
}