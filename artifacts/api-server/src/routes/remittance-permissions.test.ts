import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  authorizationsTable,
  remittancesTable,
  auditLogTable,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `remperm${Date.now().toString(36)}`;
const roleIds = { remittance: randomUUID(), checks: randomUUID() };
const userIds: string[] = [];
const cookies = new Map<string, string>();
let clientId: string;
let authorizationId: string;
let remittanceId: string;

async function makeStaff(name: string, roleId?: string) {
  const userId = randomUUID();
  await db.insert(usersTable).values({
    id: userId,
    name: `${nonce}-${name}`,
    email: `${nonce}-${name}@test.local`,
    role: "staff",
  });
  userIds.push(userId);
  if (roleId) {
    await db.execute(sql`UPDATE users SET staff_role_id = ${roleId} WHERE id = ${userId}`);
  }
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  cookies.set(name, `ceps_session=${token}`);
}

beforeAll(async () => {
  await db.execute(sql`INSERT INTO staff_roles (id, name) VALUES
    (${roleIds.remittance}, ${`${nonce}-remittance-entry`}),
    (${roleIds.checks}, ${`${nonce}-check-writing`})`);
  await db.execute(sql`INSERT INTO staff_role_permissions (role_id, permission) VALUES
    (${roleIds.remittance}, 'remittance_entry'),
    (${roleIds.checks}, 'check_writing')`);
  await makeStaff("no-permission");
  await makeStaff("check-writer", roleIds.checks);
  await makeStaff("remittance-entry", roleIds.remittance);

  const [client] = await db.insert(clientsTable).values({
    firstName: "Permission",
    lastName: "Test",
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-uci`,
  }).returning();
  clientId = client.id;
  const [authorization] = await db.insert(authorizationsTable).values({
    clientId,
    authNumber: `${nonce}-auth`,
    serviceCode: "459",
    paymentType: "direct_payment",
    servicePeriodStart: "2026-01-01",
    servicePeriodEnd: "2026-12-31",
    maxPeriodAmount: "10000.00",
  }).returning();
  authorizationId = authorization.id;
  const [remittance] = await db.insert(remittancesTable).values({
    clientId,
    authorizationId,
    remittanceDate: "2026-09-20",
    amount: "77.00",
    paymentMonth: "2026-09",
    status: "received",
    source: "manual",
  }).returning();
  remittanceId = remittance.id;
});

afterAll(async () => {
  if (clientId) await db.delete(remittancesTable).where(eq(remittancesTable.clientId, clientId));
  if (authorizationId) await db.delete(authorizationsTable).where(eq(authorizationsTable.id, authorizationId));
  if (clientId) await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  if (userIds.length) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.userId, userIds));
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await db.execute(sql`DELETE FROM staff_role_permissions WHERE role_id IN (${roleIds.remittance}, ${roleIds.checks})`);
  await db.execute(sql`DELETE FROM staff_roles WHERE id IN (${roleIds.remittance}, ${roleIds.checks})`);
});

describe("remittance mutation permissions", () => {
  const mutations = [
    {
      name: "create",
      send: (cookie: string) => request(app).post("/api/remittances").set("Cookie", cookie).send({
        clientId,
        authorizationId,
        altaReference: `${nonce}-created`,
        remittanceDate: "2026-09-21",
        amount: "78.00",
        paymentMonth: "2026-09",
      }),
    },
    {
      name: "match",
      send: (cookie: string) => request(app).post(`/api/remittances/${remittanceId}/match`)
        .set("Cookie", cookie).send({ paymentId: randomUUID(), amount: "77.00" }),
    },
    {
      name: "import",
      send: (cookie: string) => request(app).post("/api/remittances/import")
        .set("Cookie", cookie).send({ csvText: "" }),
    },
    {
      name: "edit",
      send: (cookie: string) => request(app).patch(`/api/remittances/${remittanceId}`)
        .set("Cookie", cookie).send({ amount: "78.00" }),
    },
    {
      name: "delete",
      send: (cookie: string) => request(app).delete(`/api/remittances/${remittanceId}`).set("Cookie", cookie),
    },
  ];

  it.each(mutations)("requires remittance_entry for $name", async ({ send }) => {
    for (const identity of ["no-permission", "check-writer"]) {
      const response = await send(cookies.get(identity)!);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        error: "Missing required permission",
        permission: "remittance_entry",
      });
    }
  });

  it("allows remittance creation for a user with remittance_entry", async () => {
    const response = await mutations[0].send(cookies.get("remittance-entry")!);
    expect(response.status).toBe(201);
    expect(response.body.clientId).toBe(clientId);
  });
});