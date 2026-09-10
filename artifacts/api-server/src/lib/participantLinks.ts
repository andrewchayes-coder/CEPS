import { and, eq, or } from "drizzle-orm";
import {
  authorizationsTable, clientsTable, db, feesTable, invoicesTable, paymentsTable, remittancesTable, vendorsTable,
} from "@workspace/db";
import { notDeleted } from "./serializers";

type DbHandle = typeof db;
export type ParticipantLinkValidation = {
  error?: string;
  authorization?: typeof authorizationsTable.$inferSelect;
  invoice?: typeof invoicesTable.$inferSelect;
  payment?: typeof paymentsTable.$inferSelect;
};

export type SoftDeleteResult<T> =
  | { deleted: T }
  | { notFound: true }
  | { conflict: string };

/**
 * Soft-delete policy for records that anchor financial links:
 * - clients are retained while any active authorization, fee, invoice, payment, or remittance exists;
 * - authorizations are retained while any active financial row links to them;
 * - invoices are retained while any active payment links to them.
 *
 * The target row is locked before checking references so validation and deletion
 * use the same lock protocol as financial edits.
 */
export async function softDeleteAuthorization(
  tx: DbHandle,
  id: string,
  deletedBy: string,
): Promise<SoftDeleteResult<typeof authorizationsTable.$inferSelect>> {
  const [authorization] = await tx.select().from(authorizationsTable)
    .where(and(eq(authorizationsTable.id, id), notDeleted(authorizationsTable))).for("update");
  if (!authorization) return { notFound: true };

  const [reference] = await tx.select({
    authorizationId: authorizationsTable.id,
    feeId: feesTable.id,
    invoiceId: invoicesTable.id,
    paymentId: paymentsTable.id,
    remittanceId: remittancesTable.id,
  })
    .from(authorizationsTable)
    .leftJoin(feesTable, and(eq(feesTable.authorizationId, id), notDeleted(feesTable)))
    .leftJoin(invoicesTable, and(eq(invoicesTable.authorizationId, id), notDeleted(invoicesTable)))
    .leftJoin(paymentsTable, and(eq(paymentsTable.authorizationId, id), notDeleted(paymentsTable)))
    .leftJoin(remittancesTable, and(eq(remittancesTable.authorizationId, id), notDeleted(remittancesTable)))
    .where(and(
      eq(authorizationsTable.id, id),
      or(
        eq(feesTable.authorizationId, id),
        eq(invoicesTable.authorizationId, id),
        eq(paymentsTable.authorizationId, id),
        eq(remittancesTable.authorizationId, id),
      ),
    ))
    .limit(1);
  if (reference) return { conflict: "Authorization cannot be deleted while active financial records reference it" };

  const [deleted] = await tx.update(authorizationsTable)
    .set({ isDeleted: true, deletedAt: new Date(), deletedBy })
    .where(and(eq(authorizationsTable.id, id), notDeleted(authorizationsTable)))
    .returning();
  return { deleted };
}

export async function softDeleteInvoice(
  tx: DbHandle,
  id: string,
  deletedBy: string,
): Promise<SoftDeleteResult<typeof invoicesTable.$inferSelect>> {
  const [invoice] = await tx.select().from(invoicesTable)
    .where(and(eq(invoicesTable.id, id), notDeleted(invoicesTable))).for("update");
  if (!invoice) return { notFound: true };

  const [payment] = await tx.select({ id: paymentsTable.id }).from(paymentsTable)
    .where(and(eq(paymentsTable.invoiceId, id), notDeleted(paymentsTable))).limit(1);
  if (payment) return { conflict: "Invoice cannot be deleted while active payments reference it" };

  const [deleted] = await tx.update(invoicesTable)
    .set({ isDeleted: true, deletedAt: new Date(), deletedBy })
    .where(and(eq(invoicesTable.id, id), notDeleted(invoicesTable)))
    .returning();
  return { deleted };
}

export async function softDeleteClient(
  tx: DbHandle,
  id: string,
  deletedBy: string,
): Promise<SoftDeleteResult<typeof clientsTable.$inferSelect>> {
  const [client] = await tx.select().from(clientsTable)
    .where(and(eq(clientsTable.id, id), notDeleted(clientsTable))).for("update");
  if (!client) return { notFound: true };

  const [reference] = await tx.select({
    feeId: feesTable.id,
    invoiceId: invoicesTable.id,
    paymentId: paymentsTable.id,
    remittanceId: remittancesTable.id,
  })
    .from(clientsTable)
    .leftJoin(authorizationsTable, and(eq(authorizationsTable.clientId, id), notDeleted(authorizationsTable)))
    .leftJoin(feesTable, and(eq(feesTable.clientId, id), notDeleted(feesTable)))
    .leftJoin(invoicesTable, and(eq(invoicesTable.clientId, id), notDeleted(invoicesTable)))
    .leftJoin(paymentsTable, and(eq(paymentsTable.clientId, id), notDeleted(paymentsTable)))
    .leftJoin(remittancesTable, and(eq(remittancesTable.clientId, id), notDeleted(remittancesTable)))
    .where(and(
      eq(clientsTable.id, id),
      or(
        eq(authorizationsTable.clientId, id),
        eq(feesTable.clientId, id),
        eq(invoicesTable.clientId, id),
        eq(paymentsTable.clientId, id),
        eq(remittancesTable.clientId, id),
      ),
    ))
    .limit(1);
  if (reference) return { conflict: "Client cannot be deleted while active financial records reference them" };

  const [deleted] = await tx.update(clientsTable)
    .set({ isDeleted: true, deletedAt: new Date(), deletedBy })
    .where(and(eq(clientsTable.id, id), notDeleted(clientsTable)))
    .returning();
  return { deleted };
}

/**
 * Validates create-time participant links while holding share locks on every
 * non-deleted row used as a soft-delete invariant or vendor-association proof.
 */
export async function validateParticipantLinks(
  tx: DbHandle,
  clientId: string,
  links: { authorizationId?: string | null; invoiceId?: string | null; paymentId?: string | null; vendorId?: string | null },
): Promise<ParticipantLinkValidation> {
  const [client] = await tx.select().from(clientsTable)
    .where(and(eq(clientsTable.id, clientId), notDeleted(clientsTable))).for("share");
  if (!client) return { error: "clientId must reference a non-deleted client" };

  let authorization: typeof authorizationsTable.$inferSelect | undefined;
  if (links.authorizationId) {
    [authorization] = await tx.select().from(authorizationsTable)
      .where(and(eq(authorizationsTable.id, links.authorizationId), notDeleted(authorizationsTable))).for("share");
    if (!authorization) return { error: "authorizationId must reference a non-deleted authorization" };
    if (authorization.clientId !== clientId) return { error: "authorizationId must belong to clientId" };
  }

  let invoice: typeof invoicesTable.$inferSelect | undefined;
  if (links.invoiceId) {
    [invoice] = await tx.select().from(invoicesTable)
      .where(and(eq(invoicesTable.id, links.invoiceId), notDeleted(invoicesTable))).for("share");
    if (!invoice) return { error: "invoiceId must reference a non-deleted invoice" };
    if (invoice.clientId !== clientId) return { error: "invoiceId must belong to clientId" };
  }

  let payment: typeof paymentsTable.$inferSelect | undefined;
  if (links.paymentId) {
    [payment] = await tx.select().from(paymentsTable)
      .where(and(eq(paymentsTable.id, links.paymentId), notDeleted(paymentsTable))).for("share");
    if (!payment) return { error: "paymentId must reference a non-deleted payment" };
    if (payment.clientId !== clientId) return { error: "paymentId must belong to clientId" };
  }

  if (links.vendorId) {
    const [vendor] = await tx.select().from(vendorsTable)
      .where(eq(vendorsTable.id, links.vendorId)).for("share");
    if (!vendor) return { error: "vendorId must reference an existing vendor" };

    // This order and OR behavior exactly mirror GET /vendors?clientId. Lock the
    // actual association row rather than relying on an unlocked EXISTS proof.
    const authProof = await tx.select({ id: authorizationsTable.id }).from(authorizationsTable)
      .where(and(eq(authorizationsTable.vendorId, links.vendorId), eq(authorizationsTable.clientId, clientId), notDeleted(authorizationsTable)))
      .limit(1).for("share");
    const invoiceProof = authProof.length ? [] : await tx.select({ id: invoicesTable.id }).from(invoicesTable)
      .where(and(eq(invoicesTable.vendorId, links.vendorId), eq(invoicesTable.clientId, clientId), notDeleted(invoicesTable)))
      .limit(1).for("share");
    const paymentProof = authProof.length || invoiceProof.length ? [] : await tx.select({ id: paymentsTable.id }).from(paymentsTable)
      .where(and(eq(paymentsTable.vendorId, links.vendorId), eq(paymentsTable.clientId, clientId), notDeleted(paymentsTable)))
      .limit(1).for("share");
    if (!authProof.length && !invoiceProof.length && !paymentProof.length) {
      return { error: "vendorId must already be associated with clientId" };
    }
  }

  return { authorization, invoice, payment };
}