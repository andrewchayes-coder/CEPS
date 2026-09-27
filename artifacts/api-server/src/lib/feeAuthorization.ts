import { and, desc, eq, gte, lte, ne } from "drizzle-orm";
import { authorizationsTable, db, feesTable } from "@workspace/db";
import { notDeleted } from "./serializers";

/**
 * Find the active 490 authorization covering the first day of a fee month.
 * The latest-starting authorization wins when service periods overlap.
 */
export async function findFeeAuthorizationForMonth(
  database: typeof db,
  clientId: string,
  feeMonth: string | null,
): Promise<string | null> {
  if (!feeMonth) return null;
  const firstDay = `${feeMonth}-01`;
  const [authorization] = await database
    .select({ id: authorizationsTable.id })
    .from(authorizationsTable)
    .where(and(
      eq(authorizationsTable.clientId, clientId),
      eq(authorizationsTable.paymentType, "fee"),
      ne(authorizationsTable.status, "canceled"),
      notDeleted(authorizationsTable),
      lte(authorizationsTable.servicePeriodStart, firstDay),
      gte(authorizationsTable.servicePeriodEnd, firstDay),
    ))
    .orderBy(desc(authorizationsTable.servicePeriodStart))
    .limit(1);
  return authorization?.id ?? null;
}

/**
 * Re-evaluate pending fees for a participant after a 490 authorization is
 * created, amended, or re-dated. This also clears stale links where no
 * eligible fee authorization now covers the month.
 */
export async function relinkPendingFeesToFeeAuthorizations(
  database: typeof db,
  clientId: string,
): Promise<void> {
  const pendingFees = await database
    .select({ id: feesTable.id, feeMonth: feesTable.feeMonth, authorizationId: feesTable.authorizationId })
    .from(feesTable)
    .where(and(
      eq(feesTable.clientId, clientId),
      eq(feesTable.status, "pending"),
      notDeleted(feesTable),
    ));
  for (const fee of pendingFees) {
    const authorizationId = await findFeeAuthorizationForMonth(database, clientId, fee.feeMonth);
    if (authorizationId !== fee.authorizationId) {
      await database.update(feesTable).set({ authorizationId }).where(eq(feesTable.id, fee.id));
    }
  }
}