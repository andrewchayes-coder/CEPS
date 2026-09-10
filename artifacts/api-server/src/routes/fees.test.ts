import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import {
  auditLogTable, authorizationsTable, clientsTable, db, feesTable,
  paymentsTable, sessionsTable, usersTable, vendorsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `fees-links-${Date.now().toString(36)}`;
let staffId: string;
let clientA: string;
let clientB: string;
let vendorA: string;
let authA: string;
let authB: string;
let paymentA: string;
let paymentB: string;
let deletedAuth: string;
let deletedPayment: string;
let cookie: string;

beforeAll(async () => {
  const [staff] = await db.insert(usersTable).values({
    name: "Fee Link Staff", email: `${nonce}@test.local`, role: "staff",
  }).returning();
  staffId = staff.id;
  const clients = await db.insert(clientsTable).values([
    { firstName: "Fee", lastName: "A", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-a` },
    { firstName: "Fee", lastName: "B", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-b` },
  ]).returning();
  clientA = clients[0].id;
  clientB = clients[1].id;
  const [vendor] = await db.insert(vendorsTable).values({ name: nonce }).returning();
  vendorA = vendor.id;
  const auths = await db.insert(authorizationsTable).values([
    { clientId: clientA, vendorId: vendorA, authNumber: `${nonce}-auth-a`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01", oneTimeAmount: "100.00", maxPeriodAmount: "1000.00", status: "active" },
    { clientId: clientB, vendorId: vendorA, authNumber: `${nonce}-auth-b`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01", oneTimeAmount: "100.00", maxPeriodAmount: "1000.00", status: "active" },
    { clientId: clientA, vendorId: vendorA, authNumber: `${nonce}-auth-deleted`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01", oneTimeAmount: "100.00", maxPeriodAmount: "1000.00", status: "active", isDeleted: true },
  ]).returning();
  [authA, authB, deletedAuth] = auths.map((auth) => auth.id);
  const payments = await db.insert(paymentsTable).values([
    { clientId: clientA, authorizationId: authA, vendorId: vendorA, qbCheckNumber: `${nonce}-a`, checkDate: "2026-03-15", amount: "100.00", paymentMonth: "2026-03", paymentType: "direct_payment", source: "manual" },
    { clientId: clientB, authorizationId: authB, vendorId: vendorA, qbCheckNumber: `${nonce}-b`, checkDate: "2026-03-15", amount: "100.00", paymentMonth: "2026-03", paymentType: "direct_payment", source: "manual" },
    { clientId: clientA, authorizationId: authA, vendorId: vendorA, qbCheckNumber: `${nonce}-deleted`, checkDate: "2026-03-15", amount: "100.00", paymentMonth: "2026-03", paymentType: "direct_payment", source: "manual", isDeleted: true },
  ]).returning();
  [paymentA, paymentB, deletedPayment] = payments.map((payment) => payment.id);
  const token = newToken();
  await db.insert(sessionsTable).values({ userId: staffId, token, expiresAt: new Date(Date.now() + 3_600_000) });
  cookie = `ceps_session=${token}`;
});

afterAll(async () => {
  await db.delete(feesTable).where(inArray(feesTable.clientId, [clientA, clientB]));
  await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, [clientA, clientB]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientA, clientB]));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorA));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
});

describe("fee participant links", () => {
  it("accepts valid same-participant payment and authorization links", async () => {
    const response = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, paymentId: paymentA, authorizationId: authA, amount: "5.00",
    });
    expect(response.status).toBe(201);
    expect(response.body.paymentId).toBe(paymentA);
    expect(response.body.authorizationId).toBe(authA);
  });

  it.each([
    ["paymentId", () => paymentB],
    ["authorizationId", () => authB],
  ])("rejects a cross-participant %s without writing a fee or audit", async (field, id) => {
    const beforeFees = await db.select().from(feesTable).where(eq(feesTable.clientId, clientA));
    const beforeAudits = await db.select().from(auditLogTable).where(eq(auditLogTable.userId, staffId));
    const response = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "9.00", [field]: id(),
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(field);
    expect((await db.select().from(feesTable).where(eq(feesTable.clientId, clientA))).length).toBe(beforeFees.length);
    expect((await db.select().from(auditLogTable).where(eq(auditLogTable.userId, staffId))).length).toBe(beforeAudits.length);
  });

  it.each([
    ["paymentId", () => deletedPayment],
    ["authorizationId", () => deletedAuth],
  ])("rejects a deleted %s with a clear error", async (field, id) => {
    const response = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "9.00", [field]: id(),
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(`${field} must reference a non-deleted`);
  });

});

describe("monthly fee CRUD", () => {
  it("round-trips feeMonth on POST and list", async () => {
    const created = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, amount: "160.00", feeMonth: "2026-01",
    });
    expect(created.status).toBe(201);
    expect(created.body.feeMonth).toBe("2026-01");

    const listed = await request(app).get("/api/fees").query({ clientId: clientB, feeMonth: "2026-01" }).set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].feeMonth).toBe("2026-01");
  });

  it("returns 409 for a duplicate active client/month", async () => {
    const first = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2026-02",
    });
    expect(first.status).toBe(201);
    const duplicate = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2026-02",
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toContain("active fee already exists");
  });

  it("allows a different month and recreates a soft-deleted month", async () => {
    const different = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2026-03",
    });
    expect(different.status).toBe(201);

    const deleted = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, amount: "160.00", feeMonth: "2026-04",
    });
    expect(deleted.status).toBe(201);
    const removed = await request(app).delete(`/api/fees/${deleted.body.id}`).set("Cookie", cookie);
    expect(removed.status).toBe(200);
    const recreated = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, amount: "160.00", feeMonth: "2026-04",
    });
    expect(recreated.status).toBe(201);
  });

  it("rejects invalid feeMonth format", async () => {
    const response = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2026-13",
    });
    expect(response.status).toBe(400);
  });

  it("returns 409 on PATCH month conflict without mutation or audit", async () => {
    const first = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, amount: "160.00", feeMonth: "2026-05",
    });
    const second = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, amount: "160.00", feeMonth: "2026-06",
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const beforeAudits = await db.select().from(auditLogTable).where(eq(auditLogTable.userId, staffId));
    const conflict = await request(app).patch(`/api/fees/${second.body.id}`).set("Cookie", cookie).send({
      feeMonth: "2026-05",
    });
    expect(conflict.status).toBe(409);
    const [unchanged] = await db.select().from(feesTable).where(eq(feesTable.id, second.body.id));
    expect(unchanged.feeMonth).toBe("2026-06");
    const afterAudits = await db.select().from(auditLogTable).where(eq(auditLogTable.userId, staffId));
    expect(afterAudits).toHaveLength(beforeAudits.length);
  });
});