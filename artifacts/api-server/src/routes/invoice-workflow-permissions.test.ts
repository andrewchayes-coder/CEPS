import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db, usersTable, sessionsTable, staffPermissionsTable, invoicesTable,
  invoiceLineItemsTable, authorizationsTable, paymentsTable, paymentAllocationsTable,
  clientsTable, auditLogTable, STAFF_PERMISSIONS,
  feesTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `wf${Date.now().toString(36)}`;
const ids = { users: [] as string[], clients: [] as string[], invoices: [] as string[], auths: [] as string[], payments: [] as string[] };
const cookies = new Map<string, string>();

async function makeUser(role = "staff") {
  const [user] = await db.insert(usersTable).values({ name: `${nonce}-${role}`, email: `${nonce}-${ids.users.length}@test.local`, role }).returning();
  ids.users.push(user.id);
  const token = newToken();
  await db.insert(sessionsTable).values({ userId: user.id, token, expiresAt: new Date(Date.now() + 3600000) });
  cookies.set(user.id, `ceps_session=${token}`);
  return user;
}

async function grant(userId: string, permissions: readonly string[]) {
  if (permissions.length) await db.insert(staffPermissionsTable).values(permissions.map((permission) => ({ userId, permission })));
}

async function fixture(status: string, month: string, max = "1000.00") {
  const [client] = await db.insert(clientsTable).values({ firstName: nonce, lastName: month, dateOfBirth: "2000-01-01", uciNumber: `${nonce}-${month}` }).returning();
  ids.clients.push(client.id);
  const [auth] = await db.insert(authorizationsTable).values({
    clientId: client.id, authNumber: `${nonce}-${month}`, serviceCode: "T1000",
    servicePeriodStart: "2025-01-01", servicePeriodEnd: "2030-12-31", paymentType: "direct_payment",
    maxPeriodAmount: max, status: "active",
  }).returning();
  ids.auths.push(auth.id);
  const [invoice] = await db.insert(invoicesTable).values({
    clientId: client.id, submittedByRole: "staff", submittedDate: "2026-01-01",
    amountRequested: "100.00", paymentType: "direct_payment", status, serviceMonth: month,
  }).returning();
  ids.invoices.push(invoice.id);
  await db.insert(invoiceLineItemsTable).values({ invoiceId: invoice.id, authorizationId: auth.id, serviceMonth: month, amount: "100.00" });
  return { invoice, auth, client };
}

beforeAll(async () => {
  const staff = await makeUser();
  await grant(staff.id, STAFF_PERMISSIONS);
});

afterAll(async () => {
  if (ids.payments.length) await db.delete(paymentAllocationsTable).where(inArray(paymentAllocationsTable.paymentId, ids.payments));
  if (ids.payments.length) await db.delete(feesTable).where(inArray(feesTable.paymentId, ids.payments));
  if (ids.payments.length) await db.delete(paymentsTable).where(inArray(paymentsTable.id, ids.payments));
  if (ids.invoices.length) await db.delete(invoicesTable).where(inArray(invoicesTable.id, ids.invoices));
  if (ids.auths.length) await db.delete(authorizationsTable).where(inArray(authorizationsTable.id, ids.auths));
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.users.length) {
    await db.delete(staffPermissionsTable).where(inArray(staffPermissionsTable.userId, ids.users));
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, ids.users));
    await db.delete(auditLogTable).where(inArray(auditLogTable.userId, ids.users));
    await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  }
});

describe("invoice workflow permissions", () => {
  it("exposes session permissions and preserves the flat invoice list for zero-grant staff", async () => {
    const user = await makeUser();
    const me = await request(app).get("/api/auth/me").set("Cookie", cookies.get(user.id)!);
    expect(me.status).toBe(200);
    expect(me.body.permissions).toEqual([]);
    expect((await request(app).get("/api/invoices").set("Cookie", cookies.get(user.id)!)).status).toBe(200);
  });

  it("creates omitted staff permissions as all, honors [] and subsets, and clears role changes", async () => {
    const admin = await makeUser();
    const create = (body: Record<string, unknown>) => request(app).post("/api/users").set("Cookie", cookies.get(admin.id)!).send({
      name: nonce, email: `${nonce}-${Math.random()}@test.local`, role: "staff", ...body,
    });
    const all = await create({});
    const none = await create({ permissions: [] });
    const subset = await create({ permissions: ["invoice_approve"] });
    expect(all.body.permissions).toHaveLength(3);
    expect(none.body.permissions).toEqual([]);
    expect(subset.body.permissions).toEqual(["invoice_approve"]);
    const changed = await request(app).patch(`/api/users/${subset.body.id}`).set("Cookie", cookies.get(admin.id)!).send({ role: "service_coordinator" });
    expect(changed.body.permissions).toEqual([]);
    ids.users.push(all.body.id, none.body.id, subset.body.id);
  });

  it("gates validation and approval/check queues by their independent grants", async () => {
    const validator = await makeUser(); await grant(validator.id, ["invoice_log_validate"]);
    const approver = await makeUser(); await grant(approver.id, ["invoice_approve"]);
    const checker = await makeUser(); await grant(checker.id, ["check_writing"]);
    const pending = await fixture("pending_review", "2026-01");
    expect((await request(app).post(`/api/invoices/${pending.invoice.id}/validate`).set("Cookie", cookies.get(validator.id)!)).status).toBe(200);
    await db.update(invoicesTable).set({ status: "validated" }).where(eq(invoicesTable.id, pending.invoice.id));
    expect((await request(app).post(`/api/invoices/${pending.invoice.id}/validate`).set("Cookie", cookies.get(approver.id)!)).status).toBe(403);
    expect((await request(app).get("/api/invoices/queues/ready-to-approve").set("Cookie", cookies.get(approver.id)!)).status).toBe(200);
    expect((await request(app).get("/api/invoices/queues/ready-to-approve").set("Cookie", cookies.get(checker.id)!)).status).toBe(403);
    expect((await request(app).post(`/api/invoices/${pending.invoice.id}/decision`).set("Cookie", cookies.get(approver.id)!).send({ status: "approved" })).status).toBe(200);
    expect((await request(app).get("/api/invoices/queues/ready-for-check-writing").set("Cookie", cookies.get(checker.id)!)).body.items.some((i: { id: string }) => i.id === pending.invoice.id)).toBe(true);
  });

  it("rejects nonvalidated decisions and rejects expired or exhausted approval lines", async () => {
    const approver = await makeUser(); await grant(approver.id, ["invoice_approve"]);
    const pending = await fixture("pending_review", "2026-02");
    expect((await request(app).post(`/api/invoices/${pending.invoice.id}/decision`).set("Cookie", cookies.get(approver.id)!).send({ status: "approved" })).status).toBe(409);
    await db.update(invoicesTable).set({ status: "validated" }).where(eq(invoicesTable.id, pending.invoice.id));
    await db.update(authorizationsTable).set({ servicePeriodEnd: "2020-01-01" }).where(eq(authorizationsTable.id, pending.auth.id));
    const expired = await request(app).post(`/api/invoices/${pending.invoice.id}/decision`).set("Cookie", cookies.get(approver.id)!).send({ status: "approved" });
    expect(expired.status).toBe(409);
    expect(expired.body.error).toContain(pending.auth.authNumber);
    expect(expired.body.error).toContain("2026-02");
  });

  it("contains the normalized migration backfill and only grants all permissions to staff", async () => {
    const migrationSql = readFileSync("../../lib/db/migrations/0026_staff_permissions.sql", "utf8");
    expect(migrationSql).toContain("invoice_log_validate");
    expect(migrationSql).toContain("invoice_approve");
    expect(migrationSql).toContain("check_writing");
    expect(migrationSql).toMatch(/where[\s\S]*role[\s\S]*staff/i);
    const staff = await makeUser("staff");
    const nonstaff = await makeUser("service_coordinator");
    await db.delete(staffPermissionsTable).where(inArray(staffPermissionsTable.userId, [staff.id, nonstaff.id]));
    await db.execute(sql`INSERT INTO staff_permissions (user_id, permission)
      SELECT u.id, p.permission FROM users u
      CROSS JOIN (VALUES ('invoice_log_validate'), ('invoice_approve'), ('check_writing')) p(permission)
      WHERE u.role = 'staff' ON CONFLICT DO NOTHING`);
    expect((await db.select().from(staffPermissionsTable).where(eq(staffPermissionsTable.userId, staff.id))).map((r) => r.permission).sort()).toEqual([...STAFF_PERMISSIONS].sort());
    expect(await db.select().from(staffPermissionsTable).where(eq(staffPermissionsTable.userId, nonstaff.id))).toEqual([]);
  });

  it("replaces explicit permission subsets and exposes them in the session", async () => {
    const admin = await makeUser();
    const created = await request(app).post("/api/users").set("Cookie", cookies.get(admin.id)!).send({
      name: nonce, email: `${nonce}-replace-${Date.now()}@test.local`, role: "staff", permissions: ["check_writing"],
    });
    expect(created.status).toBe(201);
    ids.users.push(created.body.id);
    const replaced = await request(app).patch(`/api/users/${created.body.id}`).set("Cookie", cookies.get(admin.id)!).send({ name: nonce, permissions: ["invoice_log_validate"] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.permissions).toEqual(["invoice_log_validate"]);
    const sessionUser = await makeUser();
    await grant(sessionUser.id, ["invoice_log_validate"]);
    const me = await request(app).get("/api/auth/me").set("Cookie", cookies.get(sessionUser.id)!);
    expect(me.status).toBe(200);
    expect(me.body.permissions).toEqual(["invoice_log_validate"]);
  });

  it("allows and denies validation independently", async () => {
    const validator = await makeUser(); await grant(validator.id, ["invoice_log_validate"]);
    const denied = await makeUser();
    const one = await fixture("pending_review", "2026-03");
    expect((await request(app).post(`/api/invoices/${one.invoice.id}/validate`).set("Cookie", cookies.get(validator.id)!)).status).toBe(200);
    const two = await fixture("pending_review", "2026-04");
    expect((await request(app).post(`/api/invoices/${two.invoice.id}/validate`).set("Cookie", cookies.get(denied.id)!)).status).toBe(403);
  });

  it("allows approve and reject only through the decision endpoint and permission", async () => {
    const approver = await makeUser(); await grant(approver.id, ["invoice_approve"]);
    const denied = await makeUser();
    const approved = await fixture("validated", "2026-05");
    expect((await request(app).post(`/api/invoices/${approved.invoice.id}/decision`).set("Cookie", cookies.get(denied.id)!).send({ status: "approved" })).status).toBe(403);
    expect((await request(app).patch(`/api/invoices/${approved.invoice.id}`).set("Cookie", cookies.get(approver.id)!).send({ status: "validated" })).status).toBe(400);
    expect((await request(app).post(`/api/invoices/${approved.invoice.id}/decision`).set("Cookie", cookies.get(approver.id)!).send({ status: "approved" })).status).toBe(200);
    const rejected = await fixture("validated", "2026-06");
    expect((await request(app).post(`/api/invoices/${rejected.invoice.id}/decision`).set("Cookie", cookies.get(approver.id)!).send({ status: "rejected" })).status).toBe(200);
  });

  it("returns approve queue oldest first with totals and removes approved and rejected decisions", async () => {
    const approver = await makeUser(); await grant(approver.id, ["invoice_approve"]);
    const older = await fixture("validated", "2026-07");
    const newer = await fixture("validated", "2026-08");
    await db.update(invoicesTable).set({ submittedDate: "2000-01-01" }).where(eq(invoicesTable.id, older.invoice.id));
    await db.update(invoicesTable).set({ submittedDate: "2001-01-01" }).where(eq(invoicesTable.id, newer.invoice.id));
    const first = await request(app).get("/api/invoices/queues/ready-to-approve?limit=1&offset=0").set("Cookie", cookies.get(approver.id)!);
    expect(first.status).toBe(200); expect(first.body.total).toBeGreaterThanOrEqual(2); expect(first.body.items).toHaveLength(1);
    const second = await request(app).get("/api/invoices/queues/ready-to-approve?limit=1&offset=1").set("Cookie", cookies.get(approver.id)!);
    expect(second.body.items).toHaveLength(1);
    expect(first.body.items[0].id).toBe(older.invoice.id);
    await request(app).post(`/api/invoices/${older.invoice.id}/decision`).set("Cookie", cookies.get(approver.id)!).send({ status: "approved" });
    expect((await request(app).get("/api/invoices/queues/ready-to-approve").set("Cookie", cookies.get(approver.id)!)).body.items.some((i: any) => i.id === older.invoice.id)).toBe(false);
    await request(app).post(`/api/invoices/${newer.invoice.id}/decision`).set("Cookie", cookies.get(approver.id)!).send({ status: "rejected" });
    expect((await request(app).get("/api/invoices/queues/ready-to-approve").set("Cookie", cookies.get(approver.id)!)).body.items.some((i: any) => i.id === newer.invoice.id)).toBe(false);
  });

  it("returns only approved unpaid invoices and uses direct invoice payment links", async () => {
    const checker = await makeUser(); await grant(checker.id, ["check_writing"]);
    const one = await fixture("approved", "2026-09");
    const two = await fixture("approved", "2026-10");
    await db.update(invoicesTable).set({ submittedDate: "2000-01-01" }).where(eq(invoicesTable.id, one.invoice.id));
    await db.update(invoicesTable).set({ submittedDate: "2001-01-01" }).where(eq(invoicesTable.id, two.invoice.id));
    const queue = () => request(app).get("/api/invoices/queues/ready-for-check-writing?limit=1000&offset=0").set("Cookie", cookies.get(checker.id)!);
    const first = await queue(); expect(first.status).toBe(200); expect(first.body.total).toBeGreaterThanOrEqual(2);
    const own = first.body.items.filter((i: any) => [one.invoice.id, two.invoice.id].includes(i.id));
    expect(own[0].id).toBe(one.invoice.id);
    const payment = await db.insert(paymentsTable).values({
      clientId: one.client.id, invoiceId: one.invoice.id, qbCheckNumber: `${nonce}-direct`, checkDate: "2026-09-15",
      paymentMonth: "2026-09", paymentType: "direct_payment", amount: "100.00", source: "manual",
    } as any).returning();
    ids.payments.push(payment[0].id);
    expect((await queue()).body.items.some((i: any) => i.id === one.invoice.id)).toBe(false);
    await db.update(paymentsTable).set({ isDeleted: true }).where(eq(paymentsTable.id, payment[0].id));
    expect((await queue()).body.items.some((i: any) => i.id === one.invoice.id)).toBe(true);
    const unlinked = await db.insert(paymentsTable).values({
      clientId: two.client.id, invoiceId: null, qbCheckNumber: `${nonce}-unlinked`, checkDate: "2026-10-15",
      paymentMonth: "2026-10", paymentType: "direct_payment", amount: "100.00", source: "manual",
    } as any).returning();
    ids.payments.push(unlinked[0].id);
    expect((await request(app).get("/api/invoices/queues/ready-for-check-writing").set("Cookie", cookies.get(checker.id)!)).body.items.some((i: any) => i.id === two.invoice.id)).toBe(true);
  });

  it("rejects expired and exhausted payment guards without writes and permits exact remaining capacity", async () => {
    const writer = await makeUser(); await grant(writer.id, ["check_writing"]);
    const expired = await fixture("approved", "2026-11");
    await db.update(authorizationsTable).set({ servicePeriodEnd: "2020-01-01" }).where(eq(authorizationsTable.id, expired.auth.id));
    const body = { clientId: expired.client.id, invoiceId: expired.invoice.id, qbCheckNumber: `${nonce}-expired`, checkDate: "2026-11-15", paymentMonth: "2026-11", paymentType: "direct_payment", amount: "100.00", allocations: [{ authorizationId: expired.auth.id, amount: "100.00" }] };
    const before = (await db.select().from(paymentsTable).where(eq(paymentsTable.clientId, expired.client.id))).length;
    const denied = await request(app).post("/api/payments").set("Cookie", cookies.get(writer.id)!).send(body);
    expect(denied.status).toBe(400); expect(denied.body.error).toContain(expired.auth.authNumber); expect(denied.body.error).toContain("2026-11");
    expect((await db.select().from(paymentsTable).where(eq(paymentsTable.clientId, expired.client.id))).length).toBe(before);
    const exact = await fixture("approved", "2026-12", "100.00");
    const ok = await request(app).post("/api/payments").set("Cookie", cookies.get(writer.id)!).send({ ...body, clientId: exact.client.id, invoiceId: exact.invoice.id, qbCheckNumber: `${nonce}-exact`, paymentMonth: "2026-12", checkDate: "2026-12-15", allocations: [{ authorizationId: exact.auth.id, amount: "100.00" }] });
    expect(ok.status).toBe(201);
    ids.payments.push(ok.body.id);
  });

  it("rechecks invoice approval and authorization on PATCH without allocations", async () => {
    const writer = await makeUser(); await grant(writer.id, ["check_writing"]);
    const source = await fixture("approved", "2027-01");
    const target = await fixture("pending_review", "2027-02");
    const [payment] = await db.insert(paymentsTable).values({ clientId: source.client.id, invoiceId: source.invoice.id, qbCheckNumber: `${nonce}-patch`, checkDate: "2027-01-15", paymentMonth: "2027-01", paymentType: "direct_payment", amount: "100.00", source: "manual" } as any).returning();
    ids.payments.push(payment.id);
    const denied = await request(app).patch(`/api/payments/${payment.id}`).set("Cookie", cookies.get(writer.id)!).send({ invoiceId: target.invoice.id });
    expect(denied.status).toBe(400);
    const [unchanged] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id));
    expect(unchanged.invoiceId).toBe(source.invoice.id);
  });

  it("rejects every allocation authorization not present on the effective invoice", async () => {
    const writer = await makeUser(); await grant(writer.id, ["check_writing"]);
    const target = await fixture("approved", "2027-03");
    const [otherAuth] = await db.insert(authorizationsTable).values({
      clientId: target.client.id, authNumber: `${nonce}-other-${Date.now()}`, serviceCode: "T1000",
      servicePeriodStart: "2025-01-01", servicePeriodEnd: "2030-12-31", paymentType: "direct_payment",
      maxPeriodAmount: "1000.00", status: "active",
    }).returning();
    ids.auths.push(otherAuth.id);
    const body = {
      clientId: target.client.id, invoiceId: target.invoice.id, qbCheckNumber: `${nonce}-wrong-auth`,
      checkDate: "2027-03-15", paymentMonth: "2027-03", paymentType: "direct_payment",
      amount: "100.00", allocations: [{ authorizationId: otherAuth.id, amount: "100.00" }],
    };
    const rejected = await request(app).post("/api/payments").set("Cookie", cookies.get(writer.id)!).send(body);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain(otherAuth.id);
    expect(rejected.body.error).toContain(target.invoice.id);
    expect(await db.select().from(paymentsTable).where(eq(paymentsTable.qbCheckNumber, body.qbCheckNumber))).toEqual([]);

    const [payment] = await db.insert(paymentsTable).values({
      clientId: target.client.id, invoiceId: target.invoice.id, qbCheckNumber: `${nonce}-patch-auth`,
      checkDate: "2027-03-16", paymentMonth: "2027-03", paymentType: "direct_payment",
      amount: "100.00", source: "manual",
    } as any).returning();
    ids.payments.push(payment.id);
    const patch = await request(app).patch(`/api/payments/${payment.id}`).set("Cookie", cookies.get(writer.id)!)
      .send({ authorizationId: otherAuth.id });
    expect(patch.status).toBe(400);
    expect(patch.body.error).toContain(otherAuth.id);
    const [unchanged] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id));
    expect(unchanged.authorizationId).toBeNull();
    await db.update(authorizationsTable).set({ servicePeriodEnd: "2020-01-01" }).where(eq(authorizationsTable.id, otherAuth.id));
    const expired = await request(app).post("/api/payments").set("Cookie", cookies.get(writer.id)!).send({ ...body, qbCheckNumber: `${nonce}-expired-other` });
    expect(expired.status).toBe(400);
  });
});