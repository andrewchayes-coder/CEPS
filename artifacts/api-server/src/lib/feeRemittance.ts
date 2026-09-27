import { and, eq, sql } from "drizzle-orm";
import { db, feesTable, remittanceAllocationsTable, remittancesTable } from "@workspace/db";
import { audit } from "./auth";
import { money } from "./money";
import { notDeleted } from "./serializers";

/**
 * Synchronize fee lifecycle status after remittance allocations change.
 * Call this inside the same transaction as the allocation insert/update/delete.
 */
export async function updateFeeCollectionStatus(
  tx: typeof db,
  feeId: string,
  userId: string,
  remittanceId: string | null,
): Promise<void> {
  const [fee] = await tx.select().from(feesTable)
    .where(and(eq(feesTable.id, feeId), notDeleted(feesTable))).for("update");
  if (!fee || fee.status === "waived") return;

  // fee_id is part of the line-or-fee remittance target migration.
  const allocated = await tx.execute(sql`select coalesce(sum(amount), 0)::text as total from remittance_allocations where fee_id = ${feeId}`);
  const total = String((allocated.rows[0] as { total?: string } | undefined)?.total ?? "0");
  const nextStatus = money(total).equals(money(fee.amount)) ? "collected" : "pending";
  if (nextStatus === fee.status) return;

  await tx.update(feesTable).set({ status: nextStatus }).where(eq(feesTable.id, fee.id));
  await audit(
    userId,
    nextStatus === "collected" ? "collect_fee" : "uncollect_fee",
    "fee",
    fee.id,
    `Remittance ${remittanceId ?? "unknown"} allocation total ${total}; fee amount ${fee.amount}`,
    tx,
  );
}

/**
 * Acquire remittance locks in the documented order before locking a fee.
 * Remittance writers lock their remittance first and then the target fee.
 */
export async function lockRemittancesForFeeAllocations(
  tx: typeof db,
  feeId: string,
): Promise<string[]> {
  const locked = await tx.execute(sql`
    select r.id
    from remittances r
    where exists (
      select 1 from remittance_allocations ra
      where ra.remittance_id = r.id and ra.fee_id = ${feeId}
    )
    order by r.id
    for update
  `);
  return (locked.rows as Array<{ id: string }>).map(({ id }) => id);
}

/** Recompute remittance lifecycle fields after removing allocations. */
export async function recomputeRemittanceAllocationState(
  tx: typeof db,
  remittanceIds: string[],
): Promise<void> {
  for (const remittanceId of [...new Set(remittanceIds)].sort()) {
    const [remittance] = await tx.select().from(remittancesTable)
      .where(eq(remittancesTable.id, remittanceId));
    if (!remittance || remittance.isDeleted) continue;

    const allocations = await tx.select({
      paymentId: remittanceAllocationsTable.paymentId,
      autoMatched: remittanceAllocationsTable.autoMatched,
    }).from(remittanceAllocationsTable)
      .where(eq(remittanceAllocationsTable.remittanceId, remittanceId));
    const [allocated] = await tx.select({
      total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)`,
    }).from(remittanceAllocationsTable)
      .where(eq(remittanceAllocationsTable.remittanceId, remittanceId));
    const allocatedAmount = money(allocated?.total);
    const complete = allocatedAmount.greaterThanOrEqualTo(money(remittance.amount));
    const partial = allocatedAmount.greaterThan(0);
    const paymentIds = new Set(allocations.map(({ paymentId }) => paymentId).filter((id): id is string => !!id));
    const matchedPaymentId = remittance.matchedPaymentId && paymentIds.has(remittance.matchedPaymentId)
      ? remittance.matchedPaymentId
      : null;
    const autoMatched = allocations.length > 0 && allocations.every(({ autoMatched: allocationAutoMatched }) => allocationAutoMatched);

    await tx.update(remittancesTable).set({
      status: complete ? "matched" : "received",
      matchedPaymentId,
      autoMatched,
      reviewReason: complete ? null : partial ? "partially_allocated" : null,
      expectedAmount: null,
    }).where(eq(remittancesTable.id, remittanceId));
  }
}