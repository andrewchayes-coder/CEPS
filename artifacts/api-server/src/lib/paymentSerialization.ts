import { and, eq, inArray, sql } from "drizzle-orm";
import { db, paymentsTable, paymentAllocationsTable, remittanceAllocationsTable, remittancesTable } from "@workspace/db";
import { money } from "./money";
import { authNumberMap, clientNameMap, vendorNameMap, notDeleted, paymentJson } from "./serializers";

export async function allocatedToLine(paymentAllocationId: string, database: typeof db): Promise<ReturnType<typeof money>> {
  const [row] = await database.select({ total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)` })
    .from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.paymentAllocationId, paymentAllocationId));
  return money(row?.total ?? 0);
}

// Use the same complete payment-line contract in payment and participant responses.
export async function enrichPayments(
  payments: (typeof paymentsTable.$inferSelect)[],
  viewer?: { role: string; linkedRecordType?: string | null; linkedRecordId?: string | null },
) {
  if (!payments.length) return [];
  const ids = payments.map((p) => p.id);
  const [clientNames, vendorNames, authNums, allocationRows, paymentAllocations] = await Promise.all([
    clientNameMap(payments.map((p) => p.clientId)),
    vendorNameMap(payments.map((p) => p.vendorId)),
    authNumberMap(payments.map((p) => p.authorizationId)),
    db.select({
      paymentId: remittanceAllocationsTable.paymentId,
      total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)`,
    }).from(remittanceAllocationsTable).where(inArray(remittanceAllocationsTable.paymentId, ids)).groupBy(remittanceAllocationsTable.paymentId),
    db.select().from(paymentAllocationsTable).where(inArray(paymentAllocationsTable.paymentId, ids)),
  ]);
  const allocationIds = paymentAllocations.map((allocation) => allocation.id);
  const remittanceLinks = viewer?.role === "vendor" || !allocationIds.length
    ? []
    : await db.select({
      paymentAllocationId: remittanceAllocationsTable.paymentAllocationId,
      id: remittancesTable.id,
      clientId: remittancesTable.clientId,
      reference: sql<string | null>`coalesce(${remittancesTable.altaReference}, ${remittancesTable.reportReference})`,
      date: sql<string>`${remittancesTable.remittanceDate}::text`,
      amount: remittanceAllocationsTable.amount,
    })
      .from(remittanceAllocationsTable)
      .innerJoin(remittancesTable, eq(remittancesTable.id, remittanceAllocationsTable.remittanceId))
      .where(and(
        inArray(remittanceAllocationsTable.paymentAllocationId, allocationIds),
        notDeleted(remittancesTable),
      ));
  const allocationAuthNums = await authNumberMap(paymentAllocations.map((a) => a.authorizationId));
  const allocated = new Map(allocationRows.map((r) => [r.paymentId, money(r.total)]));
  const remittedByLine = new Map<string, ReturnType<typeof money>>();
  const remittancesByLine = new Map<string, typeof remittanceLinks>();
  for (const link of remittanceLinks) {
    // Never expose a remittance from a different participant through a malformed allocation.
    const line = paymentAllocations.find((allocation) => allocation.id === link.paymentAllocationId);
    if (!line || payments.find((payment) => payment.id === line.paymentId)?.clientId !== link.clientId) continue;
    if ((viewer?.role === "parent_guardian" || viewer?.role === "self") &&
      (viewer.linkedRecordType !== "client" || viewer.linkedRecordId !== link.clientId)) continue;
    const list = remittancesByLine.get(link.paymentAllocationId!) ?? [];
    list.push(link);
    remittancesByLine.set(link.paymentAllocationId!, list);
  }
  await Promise.all(paymentAllocations.map(async (allocation) => {
    remittedByLine.set(allocation.id, await allocatedToLine(allocation.id, db));
  }));
  return payments.map((p) =>
    paymentJson(p, {
      clientName: clientNames.get(p.clientId),
      vendorName: p.vendorId ? vendorNames.get(p.vendorId) : null,
      authNumber: p.authorizationId ? authNums.get(p.authorizationId) : null,
      allocatedAmount: (allocated.get(p.id) ?? money(p.remitted ? p.amount : 0)).toFixed(2),
      remainingAmount: money(p.amount).minus(allocated.get(p.id) ?? money(p.remitted ? p.amount : 0)).toFixed(2),
      allocations: paymentAllocations.filter((a) => a.paymentId === p.id).map((a) => ({
        id: a.id,
        authorizationId: a.authorizationId,
        authNumber: allocationAuthNums.get(a.authorizationId) ?? null,
        serviceMonth: a.serviceMonth ?? p.paymentMonth ?? p.checkDate.slice(0, 7),
        amount: a.amount,
        remittedAmount: (remittedByLine.get(a.id) ?? money(0)).toFixed(2),
        remittanceLinks: (remittancesByLine.get(a.id) ?? []).map((link) => ({
          id: link.id,
          reference: link.reference,
          date: link.date.slice(0, 10),
          amount: link.amount,
        })),
        remitted: (remittedByLine.get(a.id) ?? money(0)).isZero()
          ? "none"
          : (remittedByLine.get(a.id) ?? money(0)).greaterThanOrEqualTo(money(a.amount)) ? "full" : "partial",
      })),
    }),
  );
}
