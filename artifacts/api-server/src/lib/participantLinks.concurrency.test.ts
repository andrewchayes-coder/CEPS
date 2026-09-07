import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  authorizationsTable,
  clientsTable,
  db,
  invoicesTable,
  paymentsTable,
  pool,
  remittancesTable,
  vendorsTable,
} from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { validateParticipantLinks } from "./participantLinks";

const nonce = `link-race-${Date.now().toString(36)}`;
let clientId: string;
let counter = 0;

type SoftDeleteTable = "clients" | "authorizations" | "invoices";

async function waitUntilBackendIsLockBlocked(pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      `select wait_event_type = 'Lock' as blocked from pg_stat_activity where pid = $1`,
      [pid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not block on the expected row lock`);
}

async function raceDeleteAgainstFinancialEdit(
  table: SoftDeleteTable,
  proofId: string,
  links: Parameters<typeof validateParticipantLinks>[2],
  applyEdit: (tx: typeof db) => Promise<void>,
) {
  const deleteClient = await pool.connect();
  const editClient = await pool.connect();
  try {
    await deleteClient.query("begin");
    await deleteClient.query(
      `update ${table} set is_deleted = true, deleted_at = now() where id = $1`,
      [proofId],
    );

    await editClient.query("begin");
    const pid = (await editClient.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    const editDb = drizzle(editClient, { schema }) as unknown as typeof db;
    const validationPromise = validateParticipantLinks(editDb, clientId, links);

    await waitUntilBackendIsLockBlocked(pid);
    await deleteClient.query("commit");

    const validation = await validationPromise;
    if (!validation.error) await applyEdit(editDb);
    await editClient.query("commit");
    return validation;
  } catch (error) {
    await Promise.allSettled([
      deleteClient.query("rollback"),
      editClient.query("rollback"),
    ]);
    throw error;
  } finally {
    deleteClient.release();
    editClient.release();
  }
}

async function makeAuthorization(vendorId?: string) {
  const [authorization] = await db.insert(authorizationsTable).values({
    clientId,
    vendorId: vendorId ?? null,
    authNumber: `${nonce}-auth-${counter++}`,
    serviceCode: "459",
    paymentType: "direct_payment",
    servicePeriodStart: "2026-01-01",
    servicePeriodEnd: "2099-12-31",
    maxPeriodAmount: "1000.00",
    status: "active",
  }).returning();
  return authorization;
}

async function makeInvoice(authorizationId?: string, vendorId?: string) {
  const [invoice] = await db.insert(invoicesTable).values({
    clientId,
    authorizationId: authorizationId ?? null,
    vendorId: vendorId ?? null,
    submittedByRole: "staff",
    submittedDate: "2026-01-01",
    serviceMonth: "2026-01",
    amountRequested: "100.00",
    paymentType: "direct_payment",
    status: "validated",
  }).returning();
  return invoice;
}

async function makePayment() {
  const [payment] = await db.insert(paymentsTable).values({
    clientId,
    qbCheckNumber: `${nonce}-check-${counter++}`,
    checkDate: "2026-01-15",
    amount: "100.00",
    paymentMonth: "2026-01",
    paymentType: "direct_payment",
    source: "manual",
  }).returning();
  return payment;
}

beforeAll(async () => {
  const [client] = await db.insert(clientsTable).values({
    firstName: "Race",
    lastName: "Participant",
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-uci`,
  }).returning();
  clientId = client.id;
});

afterAll(async () => {
  await db.delete(remittancesTable).where(eq(remittancesTable.clientId, clientId));
  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, clientId));
  await db.delete(invoicesTable).where(eq(invoicesTable.clientId, clientId));
  await db.delete(authorizationsTable).where(eq(authorizationsTable.clientId, clientId));
  await db.delete(vendorsTable).where(sql`${vendorsTable.name} like ${`${nonce}%`}`);
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
});

describe("financial edit and participant-link soft-delete races", () => {
  it("rejects an invoice edit when its authorization deletion commits first", async () => {
    const authorization = await makeAuthorization();
    const invoice = await makeInvoice();

    const validation = await raceDeleteAgainstFinancialEdit(
      "authorizations",
      authorization.id,
      { authorizationId: authorization.id },
      async (tx) => {
        await tx.update(invoicesTable).set({ authorizationId: authorization.id }).where(eq(invoicesTable.id, invoice.id));
      },
    );

    expect(validation.error).toContain("non-deleted authorization");
    const [saved] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoice.id));
    expect(saved.authorizationId).toBeNull();
  });

  it("rejects a payment edit when its invoice deletion commits first", async () => {
    const invoice = await makeInvoice();
    const payment = await makePayment();

    const validation = await raceDeleteAgainstFinancialEdit(
      "invoices",
      invoice.id,
      { invoiceId: invoice.id },
      async (tx) => {
        await tx.update(paymentsTable).set({ invoiceId: invoice.id }).where(eq(paymentsTable.id, payment.id));
      },
    );

    expect(validation.error).toContain("non-deleted invoice");
    const [saved] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id));
    expect(saved.invoiceId).toBeNull();
  });

  it("rejects a remittance edit when its client deletion commits first", async () => {
    const authorization = await makeAuthorization();
    const [remittance] = await db.insert(remittancesTable).values({
      clientId,
      remittanceDate: "2026-01-15",
      amount: "100.00",
      status: "received",
      source: "manual",
    }).returning();

    const validation = await raceDeleteAgainstFinancialEdit(
      "clients",
      clientId,
      { authorizationId: authorization.id },
      async (tx) => {
        await tx.update(remittancesTable).set({ authorizationId: authorization.id }).where(eq(remittancesTable.id, remittance.id));
      },
    );

    expect(validation.error).toContain("non-deleted client");
    const [saved] = await db.select().from(remittancesTable).where(eq(remittancesTable.id, remittance.id));
    expect(saved.authorizationId).toBeNull();
    await db.update(clientsTable).set({ isDeleted: false, deletedAt: null }).where(eq(clientsTable.id, clientId));
  });

  it("rejects a payment vendor edit when its only vendor association is deleted first", async () => {
    const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor`, active: true }).returning();
    const authorization = await makeAuthorization(vendor.id);
    const payment = await makePayment();

    const validation = await raceDeleteAgainstFinancialEdit(
      "authorizations",
      authorization.id,
      { vendorId: vendor.id },
      async (tx) => {
        await tx.update(paymentsTable).set({ vendorId: vendor.id }).where(eq(paymentsTable.id, payment.id));
      },
    );

    expect(validation.error).toContain("already be associated");
    const [saved] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id));
    expect(saved.vendorId).toBeNull();
  });
});