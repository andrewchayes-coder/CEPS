import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, paymentsTable } from "@workspace/db";
import { notDeleted } from "./serializers";

export type Payment = typeof paymentsTable.$inferSelect;

export interface DuplicatePaymentArgs {
  clientId: string;
  /**
   * The authorization the payment is tied to. When null (e.g. an imported
   * check-register row that carries no authorization), the match falls back to
   * payments with no authorization for the same client + month.
   */
  authorizationId: string | null;
  paymentMonth: string;
  /**
   * When updating an existing payment, exclude its own row from the duplicate
   * match so a no-op edit doesn't flag itself as a duplicate.
   */
  excludePaymentId?: string;
}

/**
 * Serialize duplicate-payment checks for the same client + authorization +
 * month within a transaction. A unique index is NOT viable because justified
 * overrides legitimately allow duplicate triples, so we take a transaction-
 * scoped pg advisory lock instead. The lock key is derived from the same
 * triple the duplicate check keys on, so concurrent inserts/updates for that
 * triple serialize while unrelated payments proceed in parallel. The lock is
 * released automatically when the transaction commits or rolls back.
 */
export async function lockDuplicatePaymentKey(
  database: typeof db,
  { clientId, authorizationId, paymentMonth }: Pick<DuplicatePaymentArgs, "clientId" | "authorizationId" | "paymentMonth">,
): Promise<void> {
  const key = `${clientId}:${authorizationId ?? ""}:${paymentMonth}`;
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
  { clientId, authorizationId, paymentMonth, excludePaymentId }: DuplicatePaymentArgs,
): Promise<DuplicatePaymentResult> {
  const existingPayments = await database
    .select()
    .from(paymentsTable)
    .where(
      and(
        eq(paymentsTable.clientId, clientId),
        authorizationId === null
          ? isNull(paymentsTable.authorizationId)
          : eq(paymentsTable.authorizationId, authorizationId),
        eq(paymentsTable.paymentMonth, paymentMonth),
        excludePaymentId ? ne(paymentsTable.id, excludePaymentId) : undefined,
        notDeleted(paymentsTable),
      ),
    );
  return { isDuplicate: existingPayments.length > 0, existingPayments };
}
