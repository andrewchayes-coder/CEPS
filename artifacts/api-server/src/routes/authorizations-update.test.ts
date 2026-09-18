import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  authorizationsTable,
  authorizationVersionsTable,
  auditLogTable,
  clientsTable,
  paymentsTable,
  paymentAllocationsTable,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `aup${Date.now().toString(36)}`;
let staffId: string;
let parentId: string;
let clientId: string;
let authorizationId: string;
let softDeletedId: string;
let staffCookie: string;
let parentCookie: string;

async function cookie(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({ userId, token, expiresAt: new Date(Date.now() + 3600000) });
  return `ceps_session=${token}`;
}

beforeAll(async () => {
  const [staff] = await db.insert(usersTable).values({ name: "Authorization Update Staff", email: `${nonce}-staff@test.local`, role: "staff" }).returning();
  const [parent] = await db.insert(usersTable).values({ name: "Authorization Update Parent", email: `${nonce}-parent@test.local`, role: "parent_guardian" }).returning();
  staffId = staff.id;
  parentId = parent.id;
  const [client] = await db.insert(clientsTable).values({ firstName: "Update", lastName: "Authorization", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uci` }).returning();
  clientId = client.id;
  staffCookie = await cookie(staffId);
  parentCookie = await cookie(parentId);
  const [auth] = await db.insert(authorizationsTable).values({
    clientId,
    authNumber: `${nonce}-one`,
    serviceCode: "459",
    paymentType: "direct_payment",
    servicePeriodStart: "2020-01-01",
    servicePeriodEnd: "2030-12-31",
    maxPeriodAmount: "100.00",
    status: "active",
    posPdfUrl: "/objects/old-pos.pdf",
    receivedDate: "2024-01-15",
    activityDescription: "Unchanged activity",
  }).returning();
  authorizationId = auth.id;
  const [deleted] = await db.insert(authorizationsTable).values({
    clientId,
    authNumber: `${nonce}-deleted`,
    serviceCode: "459",
    paymentType: "direct_payment",
    servicePeriodStart: "2020-01-01",
    servicePeriodEnd: "2030-12-31",
    maxPeriodAmount: "50.00",
    status: "active",
    isDeleted: true,
  }).returning();
  softDeletedId = deleted.id;
});

afterAll(async () => {
  await db.delete(authorizationVersionsTable).where(inArray(authorizationVersionsTable.authorizationId, [authorizationId, softDeletedId]));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [staffId, parentId]));
  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, clientId));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.id, [authorizationId, softDeletedId]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, parentId]));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, parentId]));
});

describe("authorization update and version history", () => {
  it("persists max amount, recalculates remaining, and snapshots the predecessor", async () => {
    const [payment] = await db.insert(paymentsTable).values({
      clientId,
      authorizationId,
      qbCheckNumber: `${nonce}-check`,
      checkDate: "2025-01-01",
      amount: "25.00",
      paymentType: "direct_payment",
      source: "manual",
    }).returning();
    await db.insert(paymentAllocationsTable).values({ paymentId: payment.id, authorizationId, amount: "25.00" });
    const patch = await request(app).patch(`/api/authorizations/${authorizationId}`).set("Cookie", staffCookie).send({
      maxPeriodAmount: "200.00",
      activityDescription: "Updated activity",
      posPdfUrl: "/objects/new-pos.pdf",
      receivedDate: "2025-02-20",
    });
    expect(patch.status).toBe(200);
    expect(patch.body.saved).toBe(true);
    expect(patch.body.authorization.maxPeriodAmount).toBe("200.00");
    expect(patch.body.authorization.remainingAmount).toBe("175.00");

    const detail = await request(app).get(`/api/authorizations/${authorizationId}`).set("Cookie", staffCookie);
    expect(detail.body.maxPeriodAmount).toBe("200.00");
    expect(detail.body.remainingAmount).toBe("175.00");

    const versions = await request(app).get(`/api/authorizations/${authorizationId}/versions`).set("Cookie", staffCookie);
    expect(versions.status).toBe(200);
    expect(versions.body).toHaveLength(1);
    expect(versions.body[0]).toMatchObject({
      authorizationId,
      maxPeriodAmount: "100.00",
      posPdfUrl: "/objects/old-pos.pdf",
      receivedDate: "2024-01-15",
      changedBy: staffId,
      isDeleted: false,
    });
    const [live] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.id, authorizationId));
    expect(live).toMatchObject({ activityDescription: "Updated activity", isDeleted: false, clientId });
  });

  it("forbids non-staff update and version access", async () => {
    expect((await request(app).patch(`/api/authorizations/${authorizationId}`).set("Cookie", parentCookie).send({ maxPeriodAmount: "300.00" })).status).toBe(403);
    expect((await request(app).get(`/api/authorizations/${authorizationId}/versions`).set("Cookie", parentCookie)).status).toBe(403);
  });

  it("does not update or snapshot a soft-deleted authorization", async () => {
    const response = await request(app).patch(`/api/authorizations/${softDeletedId}`).set("Cookie", staffCookie).send({ maxPeriodAmount: "75.00" });
    expect(response.status).toBe(404);
    const versions = await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, softDeletedId));
    expect(versions).toHaveLength(0);
  });

  it("does not snapshot when a max amount warning requires confirmation", async () => {
    const response = await request(app).patch(`/api/authorizations/${authorizationId}`).set("Cookie", staffCookie).send({
      monthlyAmount: "200.00",
      maxPeriodAmount: "200.00",
      servicePeriodStart: "2025-01-01",
      servicePeriodEnd: "2026-12-31",
    });
    expect(response.status).toBe(200);
    expect(response.body.saved).toBe(false);
    const versions = await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, authorizationId));
    expect(versions).toHaveLength(1);
  });
});