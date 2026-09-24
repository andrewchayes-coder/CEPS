import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, paymentsTable, paymentAllocationsTable } from "@workspace/db";
import { notDeleted } from "./serializers";

export type Payment = typeof paymentsTable.$inferSelect;

export interface DuplicatePaymentArgs {
  clientId: string;
  /**
   * The authorization the payment is tied to. When null, the match falls back
   * to payments with no authorization for the same client + service month.
   */
  authorizationId: string | null;
  serviceMonth: string;
  /**
   * When updating an existing payment, exclude its own row from the duplicate
   * match so a no-op edit doesn't flag itself as a duplicate.
   */
  excludePaymentId?: string;
}

/**
 * Serialize duplicate-payment checks for the same client + authorization +
 * service month within a transaction. A cross-payment unique index is NOT viable
 * because justified overrides legitimately allow duplicate triples, so we take
 * a transaction-scoped pg advisory lock instead. The lock key is derived from
 * the same triple the duplicate check keys on, so concurrent inserts/updates
 * for that triple serialize while unrelated payments proceed in parallel. The lock is
 * released automatically when the transaction commits or rolls back.
 */
export async function lockDuplicatePaymentKey(
  database: typeof db,
  { clientId, authorizationId, serviceMonth }: Pick<DuplicatePaymentArgs, "clientId" | "authorizationId" | "serviceMonth">,
): Promise<void> {
  const key = `${clientId}:${authorizationId ?? ""}:${serviceMonth}`;
  await database.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

export interface DuplicatePaymentResult {
  isDuplicate: boolean;
  existingPayments: Payment[];
}

/**
 * The single source of truth for "what counts as a duplicate payment".
 *
 * The PRD's hard-stop rule: no two payments may exist for the same client +
 * authorization + service month without a written override justification.
 * This queries the (non-soft-deleted) payments matching that triple so every
 * call site — invoice validation, manual payment entry, and bulk import —
 * agrees on the same definition.
 */
export async function checkDuplicatePayment(
  database: typeof db,
  { clientId, authorizationId, serviceMonth, excludePaymentId }: DuplicatePaymentArgs,
): Promise<DuplicatePaymentResult> {
  const existingPayments = authorizationId === null
    ? await database.select().from(paymentsTable).where(and(
      eq(paymentsTable.clientId, clientId),
      isNull(paymentsTable.authorizationId),
      eq(paymentsTable.paymentMonth, serviceMonth),
      sql`NOT EXISTS (
        SELECT 1 FROM payment_allocations pa_legacy
        WHERE pa_legacy.payment_id = ${paymentsTable.id}
      )`,
      excludePaymentId ? ne(paymentsTable.id, excludePaymentId) : undefined,
      notDeleted(paymentsTable),
    ))
    : (await database.select({ payment: paymentsTable }).from(paymentsTable)
      .leftJoin(paymentAllocationsTable, eq(paymentAllocationsTable.paymentId, paymentsTable.id))
      .where(and(
        eq(paymentsTable.clientId, clientId),
        sql`(
          (${paymentAllocationsTable.authorizationId} = ${authorizationId}
             AND coalesce(${paymentAllocationsTable.serviceMonth}, ${paymentsTable.paymentMonth}) = ${serviceMonth})
          OR (
            ${paymentsTable.authorizationId} = ${authorizationId}
             AND ${paymentsTable.paymentMonth} = ${serviceMonth}
            AND ${paymentAllocationsTable.id} IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM payment_allocations pa_legacy
              WHERE pa_legacy.payment_id = ${paymentsTable.id}
            )
          )
        )`,
        excludePaymentId ? ne(paymentsTable.id, excludePaymentId) : undefined,
        notDeleted(paymentsTable),
      ))).map((row) => row.payment);
  return { isDuplicate: existingPayments.length > 0, existingPayments };
}

export async function checkDuplicatePaymentAllocations(
  database: typeof db,
  args: { clientId: string; allocations: { authorizationId: string; serviceMonth: string }[]; excludePaymentId?: string },
): Promise<DuplicatePaymentResult> {
  const unique = [...new Map(args.allocations.map((allocation) => [
    `${allocation.authorizationId}:${allocation.serviceMonth}`,
    allocation,
  ])).values()];
  const results = await Promise.all(unique.map((allocation) =>
    checkDuplicatePayment(database, {
      clientId: args.clientId,
      authorizationId: allocation.authorizationId,
      serviceMonth: allocation.serviceMonth,
      excludePaymentId: args.excludePaymentId,
    }),
  ));
  return {
    isDuplicate: results.some((result) => result.isDuplicate),
    existingPayments: results.flatMap((result) => result.existingPayments)
      .filter((payment, index, all) => all.findIndex((candidate) => candidate.id === payment.id) === index),
  };
}
