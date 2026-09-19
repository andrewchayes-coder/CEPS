import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  authorizationsTable,
  clientsTable,
  db,
  paymentAllocationsTable,
  paymentsTable,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `dashexhausted${Date.now().toString(36)}`;
const today = new Date().toISOString().slice(0, 10);
const dateOffset = (days: number) => {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

let staffId: string;
let familyId: string;
let clientId: string;
let staffCookie: string;
let familyCookie: string;
const authorizationIds: string[] = [];
const paymentIds: string[] = [];

beforeAll(async () => {
  const [staff, family] = await db.insert(usersTable).values([
    { name: "Exhausted Alert Staff", email: `${nonce}-staff@test.local`, role: "staff" },
    { name: "Exhausted Alert Family", email: `${nonce}-family@test.local`, role: "parent_guardian" },
  ]).returning();
  staffId = staff.id;
  familyId = family.id;

  const [client] = await db.insert(clientsTable).values({
    firstName: "Exhausted",
    lastName: "Review Participant",
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-uci`,
    status: "active",
  }).returning();
  clientId = client.id;
  await db.update(usersTable)
    .set({ linkedRecordType: "client", linkedRecordId: clientId })
    .where(eq(usersTable.id, familyId));

  const [staffToken, familyToken] = [newToken(), newToken()];
  await db.insert(sessionsTable).values([
    { userId: staffId, token: staffToken, expiresAt: new Date(Date.now() + 3600000) },
    { userId: familyId, token: familyToken, expiresAt: new Date(Date.now() + 3600000) },
  ]);
  staffCookie = `ceps_session=${staffToken}`;
  familyCookie = `ceps_session=${familyToken}`;

  const rows = await db.insert(authorizationsTable).values([
    {
      clientId, authNumber: `${nonce}-future`, serviceCode: "459", paymentType: "direct_payment",
      servicePeriodStart: dateOffset(-30), servicePeriodEnd: dateOffset(30),
      maxPeriodAmount: "100.00", status: "active",
    },
    {
      clientId, authNumber: `${nonce}-today`, serviceCode: "459", paymentType: "direct_payment",
      servicePeriodStart: dateOffset(-30), servicePeriodEnd: today,
      maxPeriodAmount: "100.00", status: "active",
    },
    {
      clientId, authNumber: `${nonce}-past`, serviceCode: "459", paymentType: "direct_payment",
      servicePeriodStart: dateOffset(-60), servicePeriodEnd: dateOffset(-1),
      maxPeriodAmount: "100.00", status: "active",
    },
    {
      clientId, authNumber: `${nonce}-below`, serviceCode: "459", paymentType: "direct_payment",
      servicePeriodStart: dateOffset(-30), servicePeriodEnd: dateOffset(30),
      maxPeriodAmount: "100.00", status: "active",
    },
    {
      clientId, authNumber: `${nonce}-deleted-payment`, serviceCode: "459", paymentType: "direct_payment",
      servicePeriodStart: dateOffset(-30), servicePeriodEnd: dateOffset(30),
      maxPeriodAmount: "100.00", status: "active",
    },
  ]).returning();
  authorizationIds.push(...rows.map((row) => row.id));

  const payments = await db.insert(paymentsTable).values(rows.map((row, index) => ({
    clientId,
    authorizationId: row.id,
    qbCheckNumber: `${nonce}-check-${index}`,
    checkDate: today,
    amount: index === 3 ? "25.00" : "100.00",
    paymentType: "direct_payment",
    source: "manual",
    isDeleted: index === 4,
  }))).returning();
  paymentIds.push(...payments.map((payment) => payment.id));
  await db.insert(paymentAllocationsTable).values(payments.map((payment, index) => ({
    paymentId: payment.id,
    authorizationId: rows[index].id,
    amount: payment.amount,
  })));
});

afterAll(async () => {
  await db.delete(paymentAllocationsTable).where(inArray(paymentAllocationsTable.paymentId, paymentIds));
  await db.delete(paymentsTable).where(inArray(paymentsTable.id, paymentIds));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.id, authorizationIds));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, familyId]));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, familyId]));
});

describe("GET /dashboard/summary exhausted active authorization alerts", () => {
  it("alerts staff for future and today end dates, but not past/below/deleted-payment records", async () => {
    const response = await request(app).get("/api/dashboard/summary").set("Cookie", staffCookie);
    expect(response.status).toBe(200);
    const alerts = response.body.alerts.filter(
      (alert: { kind: string; entityId: string }) =>
        alert.kind === "authorization_exhausted_active" && authorizationIds.includes(alert.entityId),
    );
    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert: { entityId: string }) => alert.entityId))
      .toEqual(expect.arrayContaining([authorizationIds[0], authorizationIds[1]]));
    for (const alert of alerts) {
      expect(alert.entityType).toBe("authorization");
      expect(alert.message).toContain("Exhausted Review Participant");
      expect(alert.message).toContain(`${nonce}-`);
    }
    expect(alerts.some((alert: { entityId: string }) => alert.entityId === authorizationIds[2])).toBe(false);
    expect(alerts.some((alert: { entityId: string }) => alert.entityId === authorizationIds[3])).toBe(false);
    expect(alerts.some((alert: { entityId: string }) => alert.entityId === authorizationIds[4])).toBe(false);
  });

  it("does not expose the staff-only alert to a family account", async () => {
    const response = await request(app).get("/api/dashboard/summary").set("Cookie", familyCookie);
    expect(response.status).toBe(200);
    expect(response.body.alerts.some(
      (alert: { kind: string }) => alert.kind === "authorization_exhausted_active",
    )).toBe(false);
  });
});