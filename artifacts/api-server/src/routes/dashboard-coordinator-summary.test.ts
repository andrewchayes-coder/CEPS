import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db, usersTable, sessionsTable, clientsTable, vendorsTable, authorizationsTable,
  invoicesTable, paymentsTable, paymentAllocationsTable,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `dashcoord${Date.now().toString(36)}`;
const today = new Date().toISOString().slice(0, 10);
function day(offset: number) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
const accounts = new Map<string, { id: string; cookie: string }>();
const clientIds: string[] = [], vendorIds: string[] = [], authIds: string[] = [], paymentIds: string[] = [];
let baseline: { expiringAuthorizations: number; invoicesInReview: number; pendingInvoices: number };
async function summary(role: string) {
  const result = await request(app).get("/api/dashboard/summary").set("Cookie", accounts.get(role)!.cookie);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}
beforeAll(async () => {
  for (const [key, role] of [
    ["staff", "staff"], ["coordinator", "service_coordinator"], ["empty", "service_coordinator"],
    ["parent", "parent_guardian"], ["self", "self"], ["vendor", "vendor"],
  ]) {
    const [user] = await db.insert(usersTable).values({ name: `${nonce} ${key}`, email: `${nonce}-${key}@test.local`, role }).returning();
    const token = newToken();
    await db.insert(sessionsTable).values({ userId: user.id, token, expiresAt: new Date(Date.now() + 3600000) });
    accounts.set(key, { id: user.id, cookie: `ceps_session=${token}` });
  }
  const clients = await db.insert(clientsTable).values([
    { firstName: nonce, lastName: "Own", dateOfBirth: "2000-01-01", uciNumber: `${nonce}a`, status: "active", assignedCoordinatorId: accounts.get("coordinator")!.id },
    { firstName: nonce, lastName: "Other", dateOfBirth: "2000-01-01", uciNumber: `${nonce}b`, status: "active" },
  ]).returning();
  clientIds.push(...clients.map((c) => c.id));
  const vendors = await db.insert(vendorsTable).values([{ name: `${nonce} own`, w9Status: "on_file" }, { name: `${nonce} other`, w9Status: "on_file" }]).returning();
  vendorIds.push(...vendors.map((v) => v.id));
  await db.update(usersTable).set({ linkedRecordType: "client", linkedRecordId: clientIds[0] })
    .where(inArray(usersTable.id, [accounts.get("parent")!.id, accounts.get("self")!.id]));
  await db.update(usersTable).set({ linkedRecordType: "vendor", linkedRecordId: vendorIds[0] }).where(eq(usersTable.id, accounts.get("vendor")!.id));
  baseline = (await summary("staff")).totals;
  async function auth(extra: Partial<typeof authorizationsTable.$inferInsert> = {}) {
    const [row] = await db.insert(authorizationsTable).values({
      clientId: clientIds[0], vendorId: vendorIds[0], authNumber: `${nonce}-${authIds.length}`,
      serviceCode: "459", paymentType: "direct_payment", status: "active",
      servicePeriodStart: day(-60), servicePeriodEnd: day(15), maxPeriodAmount: "1000", monthlyAmount: "100",
      ...extra,
    }).returning();
    authIds.push(row.id);
    return row;
  }
  for (let i = 0; i < 30; i++) await auth();
  await auth({ servicePeriodEnd: today }); // Inclusive today boundary.
  await auth({ servicePeriodEnd: day(30) }); // Inclusive day-30 boundary.
  await auth({ status: "expired" }); // Stored status must not override derived active.
  await auth({ clientId: clientIds[1], vendorId: vendorIds[1], servicePeriodEnd: day(5) });
  await auth({ servicePeriodEnd: day(31) });
  await auth({ servicePeriodEnd: day(-1) });
  await auth({ status: "canceled" });
  await auth({ servicePeriodStart: day(5), servicePeriodEnd: day(10) });
  await auth({ isDeleted: true });
  const exhausted = await auth({ maxPeriodAmount: "100" });
  const [payment] = await db.insert(paymentsTable).values({
    clientId: clientIds[0], vendorId: vendorIds[0], authorizationId: exhausted.id,
    amount: "100", qbCheckNumber: nonce, checkDate: today, paymentMonth: today.slice(0, 7), paymentType: "direct_payment",
    source: "manual",
  }).returning();
  paymentIds.push(payment.id);
  await db.insert(paymentAllocationsTable).values({
    paymentId: payment.id, authorizationId: exhausted.id, amount: "100", serviceMonth: today.slice(0, 7),
  });
  for (let i = 0; i < clientIds.length; i++) {
    for (const status of ["needs_entry", "pending_review", "validated", "approved", "rejected", "duplicate"]) {
      await db.insert(invoicesTable).values({
        clientId: clientIds[i], vendorId: vendorIds[i], submittedByRole: "parent",
        submittedDate: today, paymentType: "reimbursement", documentType: "receipt",
        amountRequested: "0", status, documentUrl: `/objects/uploads/${accounts.get("parent")!.id}/${randomUUID()}`,
      });
    }
  }
});
afterAll(async () => {
  if (paymentIds.length) {
    await db.delete(paymentAllocationsTable).where(inArray(paymentAllocationsTable.paymentId, paymentIds));
    await db.delete(paymentsTable).where(inArray(paymentsTable.id, paymentIds));
  }
  if (clientIds.length) await db.delete(invoicesTable).where(inArray(invoicesTable.clientId, clientIds));
  if (authIds.length) await db.delete(authorizationsTable).where(inArray(authorizationsTable.id, authIds));
  if (clientIds.length) await db.delete(clientsTable).where(inArray(clientsTable.id, clientIds));
  const userIds = [...accounts.values()].map((u) => u.id);
  if (userIds.length) {
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  if (vendorIds.length) await db.delete(vendorsTable).where(inArray(vendorsTable.id, vendorIds));
});

describe("coordinator dashboard totals", () => {
  it("counts all derived-active expiring authorizations for staff independently of the alert cap", async () => {
    const response = await summary("staff");
    expect(response.totals.expiringAuthorizations).toBe(baseline.expiringAuthorizations + 34);
    expect(response.alerts.filter((a: { kind: string }) => a.kind === "expiring_authorization").length).toBeLessThanOrEqual(25);
    expect(response.totals.pendingInvoices).toBe(baseline.pendingInvoices + 4);
    expect(response.totals.invoicesInReview).toBe(baseline.invoicesInReview + 6);
  });
  it("scopes the full uncapped count to the coordinator caseload and includes today/day-30", async () => {
    const response = await summary("coordinator");
    expect(response.totals.expiringAuthorizations).toBe(33);
    expect(response.alerts.filter((a: { kind: string }) => a.kind === "expiring_authorization")).toHaveLength(25);
    expect(response.totals.invoicesInReview).toBe(3);
    expect(response.totals.pendingInvoices).toBe(2);
    const hostile = await request(app).get("/api/dashboard/summary").query({ clientId: clientIds[1], coordinatorId: accounts.get("staff")!.id })
      .set("Cookie", accounts.get("coordinator")!.cookie);
    expect(hostile.body.totals.expiringAuthorizations).toBe(33);
  });
  it("returns a genuine zero for an empty coordinator caseload", async () => {
    expect((await summary("empty")).totals).toMatchObject({ expiringAuthorizations: 0, invoicesInReview: 0, pendingInvoices: 0, activeClients: 0 });
  });
  it.each(["parent", "self", "vendor"])("%s review total includes needs_entry and excludes final statuses and other participants/vendors", async (role) => {
    const response = await summary(role);
    expect(response.totals).toMatchObject({ invoicesInReview: 3, pendingInvoices: 2, needsEntryInvoices: 1, expiringAuthorizations: 33 });
  });
});
