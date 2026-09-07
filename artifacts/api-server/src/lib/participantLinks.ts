import { and, eq } from "drizzle-orm";
import {
  authorizationsTable, clientsTable, db, invoicesTable, paymentsTable, vendorsTable,
} from "@workspace/db";
import { notDeleted } from "./serializers";

type DbHandle = typeof db;
export type ParticipantLinkValidation = {
  error?: string;
  authorization?: typeof authorizationsTable.$inferSelect;
  invoice?: typeof invoicesTable.$inferSelect;
  payment?: typeof paymentsTable.$inferSelect;
};

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