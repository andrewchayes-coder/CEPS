import { and, eq } from "drizzle-orm";
import {
  authorizationsTable, clientsTable, db, feesTable, invoicesTable, invoiceLineItemsTable, paymentsTable, paymentAllocationsTable, remittancesTable, vendorsTable, unmatchedPosDocumentsTable,
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
  | { conflict: string; blockers: DeleteBlocker[] };

export type DeleteBlocker = {
  type: "authorization" | "fee" | "invoice" | "payment" | "remittance";
  label: string;
  count: number;
  records: Array<{ id: string; label: string; href: string }>;
};

function blocker(
  type: DeleteBlocker["type"],
  label: string,
  records: DeleteBlocker["records"],
): DeleteBlocker | null {
  return records.length ? { type, label, count: records.length, records } : null;
}

function activeBlockers(values: Array<DeleteBlocker | null>): DeleteBlocker[] {
  return values.filter((value): value is DeleteBlocker => value !== null);
}

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

  const fees = await tx.select({ id: feesTable.id, feeMonth: feesTable.feeMonth }).from(feesTable)
    .where(and(eq(feesTable.authorizationId, id), notDeleted(feesTable)));
  const invoices = await tx.select({ id: invoicesTable.id, serviceMonth: invoiceLineItemsTable.serviceMonth }).from(invoiceLineItemsTable)
    .innerJoin(invoicesTable, eq(invoicesTable.id, invoiceLineItemsTable.invoiceId))
    .where(and(eq(invoiceLineItemsTable.authorizationId, id), notDeleted(invoicesTable)));
  const payments = await tx.select({ id: paymentsTable.id, checkNumber: paymentsTable.qbCheckNumber }).from(paymentAllocationsTable)
    .innerJoin(paymentsTable, eq(paymentsTable.id, paymentAllocationsTable.paymentId))
    .where(and(eq(paymentAllocationsTable.authorizationId, id), notDeleted(paymentsTable)));
  const remittances = await tx.select({ id: remittancesTable.id, reference: remittancesTable.altaReference }).from(remittancesTable)
    .where(and(eq(remittancesTable.authorizationId, id), notDeleted(remittancesTable)));
  const blockers = activeBlockers([
    blocker("fee", "Fees", fees.map((row) => ({ id: row.id, label: row.feeMonth ? `Fee for ${row.feeMonth}` : "Fee record", href: `/clients/${authorization.clientId}?tab=fees` }))),
    blocker("invoice", "Invoices", invoices.map((row) => ({ id: row.id, label: `Invoice for ${row.serviceMonth}`, href: `/invoices/${row.id}` }))),
    blocker("payment", "Payments", payments.map((row) => ({ id: row.id, label: `Check ${row.checkNumber}`, href: `/payments/${row.id}` }))),
    blocker("remittance", "Remittances", remittances.map((row) => ({ id: row.id, label: row.reference ? `Remittance ${row.reference}` : "Remittance record", href: `/remittances/${row.id}` }))),
  ]);
  if (blockers.length) return { conflict: "Authorization cannot be deleted while active financial records reference it", blockers };

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

  const payments = await tx.select({ id: paymentsTable.id, checkNumber: paymentsTable.qbCheckNumber }).from(paymentsTable)
    .where(and(eq(paymentsTable.invoiceId, id), notDeleted(paymentsTable)));
  const blockers = activeBlockers([
    blocker("payment", "Payments", payments.map((row) => ({ id: row.id, label: `Check ${row.checkNumber}`, href: `/payments/${row.id}` }))),
  ]);
  if (blockers.length) return { conflict: "Invoice cannot be deleted while active payments reference it", blockers };

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

  const authorizations = await tx.select({ id: authorizationsTable.id, authNumber: authorizationsTable.authNumber }).from(authorizationsTable)
    .where(and(eq(authorizationsTable.clientId, id), notDeleted(authorizationsTable)));
  const fees = await tx.select({ id: feesTable.id, feeMonth: feesTable.feeMonth }).from(feesTable)
    .where(and(eq(feesTable.clientId, id), notDeleted(feesTable)));
  const invoices = await tx.select({ id: invoicesTable.id, serviceMonth: invoiceLineItemsTable.serviceMonth }).from(invoicesTable)
    .leftJoin(invoiceLineItemsTable, eq(invoiceLineItemsTable.invoiceId, invoicesTable.id))
    .where(and(eq(invoicesTable.clientId, id), notDeleted(invoicesTable)));
  const payments = await tx.select({ id: paymentsTable.id, checkNumber: paymentsTable.qbCheckNumber }).from(paymentsTable)
    .where(and(eq(paymentsTable.clientId, id), notDeleted(paymentsTable)));
  const remittances = await tx.select({ id: remittancesTable.id, reference: remittancesTable.altaReference }).from(remittancesTable)
    .where(and(eq(remittancesTable.clientId, id), notDeleted(remittancesTable)));
  const blockers = activeBlockers([
    blocker("authorization", "Authorizations", authorizations.map((row) => ({ id: row.id, label: `Authorization ${row.authNumber}`, href: `/authorizations/${row.id}` }))),
    blocker("fee", "Fees", fees.map((row) => ({ id: row.id, label: row.feeMonth ? `Fee for ${row.feeMonth}` : "Fee record", href: `/clients/${id}?tab=fees` }))),
    blocker("invoice", "Invoices", invoices.map((row) => ({ id: row.id, label: `Invoice for ${row.serviceMonth}`, href: `/invoices/${row.id}` }))),
    blocker("payment", "Payments", payments.map((row) => ({ id: row.id, label: `Check ${row.checkNumber}`, href: `/payments/${row.id}` }))),
    blocker("remittance", "Remittances", remittances.map((row) => ({ id: row.id, label: row.reference ? `Remittance ${row.reference}` : "Remittance record", href: `/remittances/${row.id}` }))),
  ]);
  if (blockers.length) return { conflict: "Participant cannot be deleted while active financial records reference them", blockers };
  await tx.update(unmatchedPosDocumentsTable)
    .set({ suggestedClientId: null, suggestionMethod: null, suggestedAt: null })
    .where(eq(unmatchedPosDocumentsTable.suggestedClientId, id));

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
  links: { authorizationId?: string | null; invoiceId?: string | null; paymentId?: string | null; vendorId?: string | null; allowDeletedPayment?: boolean },
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
      .where(and(eq(paymentsTable.id, links.paymentId), ...(links.allowDeletedPayment ? [] : [notDeleted(paymentsTable)]))).for("share");
    if (!payment) return { error: "paymentId must reference a non-deleted payment" };
    if (payment.clientId !== clientId) return { error: "paymentId must belong to clientId" };
  }

  if (links.vendorId) {
    const [vendor] = await tx.select().from(vendorsTable)
      .where(eq(vendorsTable.id, links.vendorId)).for("share");
    if (!vendor) return { error: "vendorId must reference an existing vendor" };

    // Match GET /vendors?clientId&invoiceEligible=true and the database guard.
    // Lock the proof row rather than relying on an unlocked EXISTS check.
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