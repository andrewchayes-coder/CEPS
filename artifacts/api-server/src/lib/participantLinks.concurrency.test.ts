import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import request from "supertest";
import {
  authorizationsTable,
  auditLogTable,
  clientsTable,
  db,
  feesTable,
  invoicesTable,
  paymentsTable,
  pool,
  remittancesTable,
  sessionsTable,
  usersTable,
  vendorsTable,
} from "@workspace/db";
import * as schema from "@workspace/db/schema";
import app from "../app";
import { newToken } from "./auth";
import { validateParticipantLinks } from "./participantLinks";

const nonce = `link-race-${Date.now().toString(36)}`;
let clientId: string;
let staffId: string;
let cookie: string;
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

async function waitUntilRouteDeleteIsLockBlocked(editPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      `select exists (
         select 1 from pg_stat_activity
         where pid <> pg_backend_pid()
           and pid <> $1
           and wait_event_type = 'Lock'
       ) as blocked`,
      [editPid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Delete route did not block on the expected participant-link row lock");
}

async function raceFeeCommitBeforeDelete(
  target: "client" | "authorization",
  authorizationId?: string,
  targetClientId = clientId,
) {
  const editClient = await pool.connect();
  try {
    await editClient.query("begin");
    const editPid = (await editClient.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    const editDb = drizzle(editClient, { schema }) as unknown as typeof db;
    const validation = await validateParticipantLinks(editDb, targetClientId, { authorizationId });
    expect(validation.error).toBeUndefined();

    const path = target === "client"
      ? `/api/clients/${targetClientId}`
      : `/api/authorizations/${authorizationId}`;
    const deletePromise = request(app).delete(path).set("Cookie", cookie).then((response) => response);
    await waitUntilRouteDeleteIsLockBlocked(editPid);

    await editDb.insert(feesTable).values({
      clientId: targetClientId,
      authorizationId: authorizationId ?? null,
      amount: "5.00",
      status: "pending",
      ruleApplied: `${nonce}-concurrency`,
    });
    await editClient.query("commit");
    return await deletePromise;
  } catch (error) {
    await editClient.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    editClient.release();
  }
}

async function raceAuthorizationCommitBeforeClientDelete(targetClientId: string) {
  const editClient = await pool.connect();
  try {
    await editClient.query("begin");
    const editPid = (await editClient.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    const editDb = drizzle(editClient, { schema }) as unknown as typeof db;
    const validation = await validateParticipantLinks(editDb, targetClientId, {});
    expect(validation.error).toBeUndefined();

    const deletePromise = request(app)
      .delete(`/api/clients/${targetClientId}`)
      .set("Cookie", cookie)
      .then((response) => response);
    await waitUntilRouteDeleteIsLockBlocked(editPid);

    const [authorization] = await editDb.insert(authorizationsTable).values({
      clientId: targetClientId,
      authNumber: `${nonce}-auth-race-${counter++}`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2099-12-31",
      maxPeriodAmount: "1000.00",
      status: "active",
    }).returning();
    await editClient.query("commit");
    return { response: await deletePromise, authorization };
  } catch (error) {
    await editClient.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    editClient.release();
  }
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

async function makeClient(label: string) {
  const [client] = await db.insert(clientsTable).values({
    firstName: "Isolated",
    lastName: label,
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-${label}-${counter++}`,
  }).returning();
  return client;
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
  const [staff] = await db.insert(usersTable).values({
    name: "Link Race Staff",
    email: `${nonce}@test.local`,
    role: "staff",
  }).returning();
  staffId = staff.id;
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId: staffId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  cookie = `ceps_session=${token}`;

  const [client] = await db.insert(clientsTable).values({
    firstName: "Race",
    lastName: "Participant",
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-uci`,
  }).returning();
  clientId = client.id;
});

afterAll(async () => {
  await db.delete(feesTable).where(eq(feesTable.clientId, clientId));
  await db.delete(remittancesTable).where(eq(remittancesTable.clientId, clientId));
  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, clientId));
  await db.delete(invoicesTable).where(eq(invoicesTable.clientId, clientId));
  await db.delete(authorizationsTable).where(eq(authorizationsTable.clientId, clientId));
  await db.delete(vendorsTable).where(sql`${vendorsTable.name} like ${`${nonce}%`}`);
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
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

  it("rejects authorization deletion after an invoice edit commits its link", async () => {
    const authorization = await makeAuthorization();
    const invoice = await makeInvoice();
    await db.transaction(async (tx) => {
      const validation = await validateParticipantLinks(tx as unknown as typeof db, clientId, { authorizationId: authorization.id });
      expect(validation.error).toBeUndefined();
      await tx.update(invoicesTable).set({ authorizationId: authorization.id }).where(eq(invoicesTable.id, invoice.id));
    });

    const response = await request(app).delete(`/api/authorizations/${authorization.id}`).set("Cookie", cookie);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Authorization cannot be deleted while active financial records reference it");
  });

  it("rejects invoice deletion after a payment edit commits its link", async () => {
    const invoice = await makeInvoice();
    const payment = await makePayment();
    await db.transaction(async (tx) => {
      const validation = await validateParticipantLinks(tx as unknown as typeof db, clientId, { invoiceId: invoice.id });
      expect(validation.error).toBeUndefined();
      await tx.update(paymentsTable).set({ invoiceId: invoice.id }).where(eq(paymentsTable.id, payment.id));
    });

    const response = await request(app).delete(`/api/invoices/${invoice.id}`).set("Cookie", cookie);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Invoice cannot be deleted while active payments reference it");
  });

  it("rejects client deletion after a remittance edit commits", async () => {
    const client = await makeClient("remittance");
    const [remittance] = await db.insert(remittancesTable).values({
      clientId: client.id,
      remittanceDate: "2026-01-15",
      amount: "100.00",
      status: "received",
      source: "manual",
    }).returning();
    await db.transaction(async (tx) => {
      const validation = await validateParticipantLinks(tx as unknown as typeof db, client.id, {});
      expect(validation.error).toBeUndefined();
      await tx.update(remittancesTable).set({ status: "matched" }).where(eq(remittancesTable.id, remittance.id));
    });

    const response = await request(app).delete(`/api/clients/${client.id}`).set("Cookie", cookie);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Client cannot be deleted while active financial records reference them");
    await db.delete(remittancesTable).where(eq(remittancesTable.id, remittance.id));
    await db.delete(clientsTable).where(eq(clientsTable.id, client.id));
  });

  it("rejects client deletion that starts while a fee edit is committing", async () => {
    const client = await makeClient("fee-race");
    const response = await raceFeeCommitBeforeDelete("client", undefined, client.id);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Client cannot be deleted while active financial records reference them");
    await db.delete(feesTable).where(eq(feesTable.clientId, client.id));
    await db.delete(clientsTable).where(eq(clientsTable.id, client.id));
  });

  it("rejects authorization deletion that starts while a linked fee edit is committing", async () => {
    const authorization = await makeAuthorization();
    const response = await raceFeeCommitBeforeDelete("authorization", authorization.id);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Authorization cannot be deleted while active financial records reference it");
  });

  it("rejects client deletion when an active authorization is its only child", async () => {
    const client = await makeClient("authorization-only");
    const [authorization] = await db.insert(authorizationsTable).values({
      clientId: client.id,
      authNumber: `${nonce}-auth-only-${counter++}`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2099-12-31",
      maxPeriodAmount: "1000.00",
      status: "active",
    }).returning();

    const response = await request(app).delete(`/api/clients/${client.id}`).set("Cookie", cookie);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Client cannot be deleted while active financial records reference them");
    await db.delete(authorizationsTable).where(eq(authorizationsTable.id, authorization.id));
    await db.delete(clientsTable).where(eq(clientsTable.id, client.id));
  });

  it("rejects client deletion that starts while an authorization is committing", async () => {
    const client = await makeClient("authorization-race");
    const { response, authorization } = await raceAuthorizationCommitBeforeClientDelete(client.id);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Client cannot be deleted while active financial records reference them");
    await db.delete(authorizationsTable).where(eq(authorizationsTable.id, authorization.id));
    await db.delete(clientsTable).where(eq(clientsTable.id, client.id));
  });
});