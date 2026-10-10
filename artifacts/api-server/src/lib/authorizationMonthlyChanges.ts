import { inArray, sql } from "drizzle-orm";
import { db, authorizationVersionsTable, type Authorization } from "@workspace/db";

type PriorAmount = { monthlyAmount: string | null; receivedDate: string | null };
export type MonthlyAmountChange = {
  monthlyAmountChanged: boolean;
  previousMonthlyAmount: string | null;
  monthlyAmountChangedReceivedDate: string | null;
};

/** One grouped history query for the authorized page, never one per row. */
export async function authorizationMonthlyChanges(auths: Authorization[]) {
  const changes = new Map<string, MonthlyAmountChange>();
  if (!auths.length) return changes;
  const histories = await db.select({
    authorizationId: authorizationVersionsTable.authorizationId,
    versions: sql<PriorAmount[]>`jsonb_agg(
      jsonb_build_object(
        'monthlyAmount', ${authorizationVersionsTable.monthlyAmount}::text,
        'receivedDate', ${authorizationVersionsTable.receivedDate}
      ) order by ${authorizationVersionsTable.changedAt} desc, ${authorizationVersionsTable.id} desc
    )`,
  }).from(authorizationVersionsTable)
    .where(inArray(authorizationVersionsTable.authorizationId, auths.map(a => a.id)))
    .groupBy(authorizationVersionsTable.authorizationId);
  const byId = new Map(histories.map(h => [h.authorizationId, h.versions]));
  for (const auth of auths) {
    let newerReceivedDate = auth.receivedDate;
    let change: MonthlyAmountChange = {
      monthlyAmountChanged: false, previousMonthlyAmount: null, monthlyAmountChangedReceivedDate: null,
    };
    // A later amendment may change only dates/notes. Find the most recent
    // actual amount transition and its newer version's received date.
    for (const prior of byId.get(auth.id) ?? []) {
      if (prior.monthlyAmount !== auth.monthlyAmount) {
        change = {
          monthlyAmountChanged: true,
          previousMonthlyAmount: prior.monthlyAmount,
          monthlyAmountChangedReceivedDate: newerReceivedDate,
        };
        break;
      }
      newerReceivedDate = prior.receivedDate;
    }
    changes.set(auth.id, change);
  }
  return changes;
}
