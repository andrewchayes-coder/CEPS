import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db, usersTable, sessionsTable, staffRolesTable, staffRolePermissionsTable, STAFF_PERMISSIONS,
  clientsTable, authorizationsTable, authorizationVersionsTable, paymentsTable,
  paymentAllocationsTable, feesTable, auditLogTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";
import {
  authorizationTotalsPaid, effectiveAuthStatus, effectiveAuthorizationStatusSql,
} from "../lib/serializers";

const nonce = `derived-${Date.now().toString(36)}`;
let staffId: string;
let roleId: string;
let clientId: string;
let cookie: string;
let sequence = 0;
let feeSequence = 0;
const date = (days = 0) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  const [role] = await db.insert(staffRolesTable).values({ name: nonce }).returning();
  roleId = role.id;
  await db.insert(staffRolePermissionsTable).values(STAFF_PERMISSIONS.map(permission => ({ roleId, permission })));
  const [staff] = await db.insert(usersTable).values({
    name: nonce, email: `${nonce}@test.local`, role: "staff", staffRoleId: roleId,
  }).returning();
  staffId = staff.id;
  const token = newToken();
  await db.insert(sessionsTable).values({ userId: staffId, token, expiresAt: new Date(Date.now() + 3600000) });
  cookie = `ceps_session=${token}`;
  const [client] = await db.insert(clientsTable).values({
    firstName: nonce, lastName: "Participant", dateOfBirth: "2000-01-01", uciNumber: nonce,
  }).returning();
  clientId = client.id;
});

afterAll(async () => {
  const auths = await db.select({ id: authorizationsTable.id }).from(authorizationsTable)
    .where(eq(authorizationsTable.clientId, clientId));
  const checks = await db.select({ id: paymentsTable.id }).from(paymentsTable)
    .where(eq(paymentsTable.clientId, clientId));
  await db.delete(feesTable).where(eq(feesTable.clientId, clientId));
  if (checks.length) await db.delete(paymentAllocationsTable).where(inArray(paymentAllocationsTable.paymentId, checks.map(p => p.id)));
  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, clientId));
  if (auths.length) await db.delete(authorizationVersionsTable).where(inArray(authorizationVersionsTable.authorizationId, auths.map(a => a.id)));
  await db.delete(authorizationsTable).where(eq(authorizationsTable.clientId, clientId));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
  await db.delete(staffRolePermissionsTable).where(eq(staffRolePermissionsTable.roleId, roleId));
  await db.delete(staffRolesTable).where(eq(staffRolesTable.id, roleId));
});

async function auth(extra: Partial<typeof authorizationsTable.$inferInsert> = {}) {
  const [row] = await db.insert(authorizationsTable).values({
    clientId, authNumber: `${nonce}-${++sequence}`, serviceCode: "459", paymentType: "direct_payment",
    servicePeriodStart: date(-30), servicePeriodEnd: date(30), maxPeriodAmount: "200.00", status: "active",
    ...extra,
  }).returning();
  return row;
}

async function usage(authorizationId: string, fee: boolean) {
  if (fee) {
    await db.insert(feesTable).values({
      clientId, authorizationId, feeMonth: `2026-${String(++feeSequence).padStart(2, "0")}`, amount: "160.00", status: "pending",
    });
  } else {
    const [payment] = await db.insert(paymentsTable).values({
      clientId, qbCheckNumber: randomUUID(), checkDate: date(), amount: "100.00",
      paymentType: "direct_payment", source: "manual",
    }).returning();
    await db.insert(paymentAllocationsTable).values({ paymentId: payment.id, authorizationId, amount: "100.00" });
  }
}

describe("fully derived authorization status", () => {
  it.each([
    { stored: "pending", start: -30, end: 30, max: "200.00", expected: "active" },
    { stored: "expired", start: -30, end: 30, max: "200.00", expected: "active" },
    { stored: "exhausted", start: -30, end: 30, max: "200.00", expected: "active" },
    { stored: "pending", start: 2, end: 30, max: "50.00", expected: "pending" },
    { stored: "exhausted", start: 2, end: 30, max: "50.00", expected: "pending" },
    { stored: "pending", start: -30, end: -1, max: "50.00", expected: "expired" },
    { stored: "canceled", start: 2, end: 30, max: "50.00", expected: "canceled" },
    { stored: "canceled", start: -30, end: -1, max: "50.00", expected: "canceled" },
    { stored: "active", start: -30, end: 30, max: "100.00", expected: "exhausted" },
    { stored: "expired", start: -30, end: 30, max: "100.00", expected: "exhausted" },
    { stored: "pending", start: 0, end: 0, max: "200.00", expected: "active" },
    { stored: "exhausted", start: -30, end: 30, max: "160.00", expected: "exhausted", fee: true },
    { stored: "active", start: -30, end: 30, max: "100.00", expected: "exhausted", fee: true },
    { stored: "expired", start: -30, end: 30, max: "320.00", expected: "active", fee: true },
    { stored: "canceled", start: -30, end: 30, max: "160.00", expected: "canceled", fee: true },
    { stored: "pending", start: 2, end: 30, max: "160.00", expected: "pending", fee: true },
    { stored: "active", start: -30, end: -1, max: "160.00", expected: "expired", fee: true },
  ])("SQL, serializer, list and detail agree: $stored / $start / $end → $expected", async fixture => {
    const row = await auth({
      status: fixture.stored, servicePeriodStart: date(fixture.start), servicePeriodEnd: date(fixture.end),
      maxPeriodAmount: fixture.max,
      ...(fixture.fee ? { paymentType: "fee", serviceCode: "490" } : {}),
    });
    await usage(row.id, !!fixture.fee);
    const total = (await authorizationTotalsPaid([row.id])).get(row.id)!;
    const [sqlResult] = await db.select({ status: effectiveAuthorizationStatusSql() })
      .from(authorizationsTable).where(eq(authorizationsTable.id, row.id));
    expect(effectiveAuthStatus(row, total)).toBe(fixture.expected);
    expect(sqlResult.status).toBe(fixture.expected);
    const listed = await request(app).get("/api/authorizations")
      .query({ clientId, status: fixture.expected, limit: 1000 }).set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.items.find((a: { id: string }) => a.id === row.id)?.status).toBe(fixture.expected);
    const detail = await request(app).get(`/api/authorizations/${row.id}`).set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe(fixture.expected);
    const [unchanged] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.id, row.id));
    expect(unchanged.status).toBe(fixture.stored);
  });

  it.each(["pending", "expired", "exhausted"])("generic creation ignores supplied %s and stores active", async status => {
    const created = await request(app).post("/api/authorizations").set("Cookie", cookie).send({
      clientId, authNumber: `${nonce}-create-${status}`, serviceCode: "459",
      servicePeriodStart: date(-5), servicePeriodEnd: date(30), maxPeriodAmount: "100.00", status,
    });
    expect(created.status).toBe(201);
    expect(created.body.authorization.status).toBe("active");
    const [stored] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.id, created.body.authorization.id));
    expect(stored.status).toBe("active");
  });

  it("removes Status from the import template; blank and stale Status values cannot set stored status", async () => {
    const template = await request(app).get("/api/import/authorizations/template").set("Cookie", cookie);
    expect(template.status).toBe(200);
    expect(template.text.split("\n")[0].split(",")).not.toContain("Status");
    for (const status of ["", "exhausted"]) {
      const number = `${nonce}-import-${status || "blank"}`;
      const csvText = [
        "Client UCI *,Auth Number *,Service Code *,Service Period Start *,Service Period End *,Max Period Amount *,Status",
        `${nonce},${number},459,${date(-5)},${date(30)},100.00,${status}`,
      ].join("\n");
      const imported = await request(app).post("/api/import/authorizations/commit").set("Cookie", cookie).send({ csvText });
      expect(imported.status).toBe(200);
      const [stored] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.authNumber, number));
      expect(stored?.status).toBe("active");
      const detail = await request(app).get(`/api/authorizations/${stored.id}`).set("Cookie", cookie);
      expect(detail.body.status).toBe("active");
    }
  });

  it.each(["expired", "exhausted"])("an amendment re-derives legacy %s without rewriting stored status", async stored => {
    const row = await auth({
      status: stored, servicePeriodEnd: stored === "expired" ? date(-1) : date(30),
      maxPeriodAmount: stored === "exhausted" ? "0.00" : "100.00", receivedDate: date(-20),
    });
    expect(effectiveAuthStatus(row, 0)).toBe(stored);
    const receivedDate = date(-2);
    const amended = await request(app).post(`/api/authorizations/${row.id}/amend`).set("Cookie", cookie).send({
      servicePeriodStart: date(-30), servicePeriodEnd: date(60), maxPeriodAmount: "200.00",
      receivedDate, confirmed: true,
    });
    expect(amended.status).toBe(200);
    expect(amended.body.authorization).toMatchObject({ status: "active", receivedDate });
    const [live] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.id, row.id));
    expect(live).toMatchObject({ status: stored, receivedDate });
    const versions = await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, row.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ status: stored, receivedDate: row.receivedDate });
    expect(versions[0].changedFields).toContain("receivedDate");
  });

  it("defaults amendment receivedDate to today and rejects invalid dates without writing", async () => {
    const row = await auth();
    const body = { servicePeriodStart: date(-30), servicePeriodEnd: date(60), maxPeriodAmount: "200.00", confirmed: true };
    for (const receivedDate of ["2026-02-30", "10/09/2026", ""]) {
      const invalid = await request(app).post(`/api/authorizations/${row.id}/amend`).set("Cookie", cookie).send({ ...body, receivedDate });
      expect(invalid.status).toBe(400);
    }
    expect(await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, row.id))).toHaveLength(0);
    const amended = await request(app).post(`/api/authorizations/${row.id}/amend`).set("Cookie", cookie).send(body);
    expect(amended.status).toBe(200);
    expect(amended.body.authorization.receivedDate).toBe(date());
    const [version] = await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, row.id));
    expect(version.receivedDate).toBeNull();
  });

  it("saves unrelated edits without a max warning, but checks a max-only PATCH against merged values", async () => {
    const row = await auth({ servicePeriodStart: "2020-01-01", servicePeriodEnd: "2030-12-31", monthlyAmount: "100.00", maxPeriodAmount: "1000.00" });
    for (const updates of [
      { posNotes: "Notes-only edit" },
      { vendorId: null, posNotes: "Unrelated vendor edit" },
      { monthlyAmount: row.monthlyAmount, maxPeriodAmount: row.maxPeriodAmount, posNotes: "Unchanged financial fields" },
    ]) {
      const saved = await request(app).patch(`/api/authorizations/${row.id}`).set("Cookie", cookie).send(updates);
      expect(saved.status).toBe(200);
      expect(saved.body.saved).toBe(true);
      expect(saved.body.warnings ?? []).toEqual([]);
    }
    const priorVersions = await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, row.id));
    const patch = await request(app).patch(`/api/authorizations/${row.id}`).set("Cookie", cookie).send({ maxPeriodAmount: "100.00" });
    expect(patch.status).toBe(200);
    expect(patch.body.saved).toBe(false);
    expect(patch.body.warnings[0]).toMatch(/monthly amount.*maximum/i);
    const [unchanged] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.id, row.id));
    expect(unchanged.maxPeriodAmount).toBe("1000.00");
    expect(await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, row.id))).toHaveLength(priorVersions.length);
    const accepted = await request(app).patch(`/api/authorizations/${row.id}`).set("Cookie", cookie).send({ maxPeriodAmount: "100.00", acceptMaxAmountWarning: true });
    expect(accepted.body.saved).toBe(true);
  });

  it("keeps the prior received date and amounts in history while the amendment becomes the current version", async () => {
    const created = await request(app).post("/api/authorizations").set("Cookie", cookie).send({
      clientId, authNumber: `${nonce}-received-history`, serviceCode: "459",
      servicePeriodStart: "2026-01-01", servicePeriodEnd: "2026-02-28",
      monthlyAmount: "100.00", maxPeriodAmount: "200.00", receivedDate: "2026-01-05",
    });
    expect(created.status).toBe(201);
    const id = created.body.authorization.id;
    const amended = await request(app).post(`/api/authorizations/${id}/amend`).set("Cookie", cookie).send({
      servicePeriodStart: "2026-01-01", servicePeriodEnd: "2026-04-30",
      monthlyAmount: "100.00", maxPeriodAmount: "400.00", receivedDate: "2026-03-02", confirmed: true,
    });
    expect(amended.status).toBe(200);
    expect(amended.body.saved).toBe(true);
    expect(amended.body.authorization).toMatchObject({ maxPeriodAmount: "400.00", receivedDate: "2026-03-02" });
    const [version] = await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, id));
    expect(version).toMatchObject({ maxPeriodAmount: "200.00", servicePeriodEnd: "2026-02-28", receivedDate: "2026-01-05" });
    const [current] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.id, id));
    expect(current).toMatchObject({ maxPeriodAmount: "400.00", servicePeriodEnd: "2026-04-30", receivedDate: "2026-03-02" });
  });

  it("derived status drives expiring searches, reports and dashboard alerts", async () => {
    const expiring = await auth({ status: "pending", servicePeriodEnd: date(7) });
    const exhausted = await auth({ status: "pending", maxPeriodAmount: "100.00" });
    await usage(exhausted.id, false);
    const fee = await auth({ status: "exhausted", paymentType: "fee", serviceCode: "490", maxPeriodAmount: "160.00" });
    await usage(fee.id, true);
    const listed = await request(app).get("/api/authorizations")
      .query({ clientId, expiringWithinDays: 10 }).set("Cookie", cookie);
    expect(listed.body.items.some((a: { id: string }) => a.id === expiring.id)).toBe(true);
    const search = await request(app).get("/api/authorizations")
      .query({ clientId, search: "active", limit: 1000 }).set("Cookie", cookie);
    expect(search.body.items.some((a: { id: string }) => a.id === expiring.id)).toBe(true);
    expect(search.body.items.some((a: { id: string }) => a.id === exhausted.id)).toBe(false);
    const dashboard = await request(app).get("/api/dashboard/summary").set("Cookie", cookie);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.alerts.some((a: { kind: string; entityId: string }) => a.entityId === expiring.id && a.kind === "expiring_authorization")).toBe(true);
    expect(dashboard.body.alerts.some((a: { kind: string; entityId: string }) => a.entityId === exhausted.id && a.kind === "authorization_exhausted_active")).toBe(true);
    expect(dashboard.body.alerts.some((a: { kind: string; entityId: string }) => a.entityId === fee.id && a.kind === "authorization_exhausted_active")).toBe(true);
    const report = await request(app).get("/api/reports/expiring-authorizations").query({ days: 10 }).set("Cookie", cookie);
    expect(report.status).toBe(200);
    expect(JSON.stringify(report.body)).toContain(expiring.id);
    expect(JSON.stringify(report.body)).not.toContain(exhausted.id);
  });
});
