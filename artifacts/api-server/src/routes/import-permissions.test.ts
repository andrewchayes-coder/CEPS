import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, usersTable, sessionsTable, staffRolesTable, staffRolePermissionsTable,
  clientsTable, remittancesTable, auditLogTable,
} from "@workspace/db";
import app from "../app";
import * as auth from "../lib/auth";

const nonce = `import-perms-${Date.now().toString(36)}`;
const userIds: string[] = [];
const roleIds: string[] = [];
let clientId: string;
let allowedCookie: string;
let deniedCookie: string;

beforeAll(async () => {
  const [client] = await db.insert(clientsTable).values({
    firstName: nonce, lastName: "Participant", dateOfBirth: "2000-01-01", uciNumber: nonce,
  }).returning();
  clientId = client.id;
  for (const allowed of [false, true]) {
    const [role] = await db.insert(staffRolesTable).values({ name: `${nonce}-${allowed}` }).returning();
    roleIds.push(role.id);
    if (allowed) await db.insert(staffRolePermissionsTable).values({ roleId: role.id, permission: "remittance_entry" });
    const [user] = await db.insert(usersTable).values({
      name: `${nonce}-${allowed}`, email: `${nonce}-${allowed}@test.local`, role: "staff", staffRoleId: role.id,
    }).returning();
    userIds.push(user.id);
    const token = auth.newToken();
    await db.insert(sessionsTable).values({ userId: user.id, token, expiresAt: new Date(Date.now() + 3600000) });
    if (allowed) allowedCookie = `ceps_session=${token}`;
    else deniedCookie = `ceps_session=${token}`;
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  await db.delete(remittancesTable).where(eq(remittancesTable.clientId, clientId));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, userIds));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, userIds));
  await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  await db.delete(staffRolePermissionsTable).where(inArray(staffRolePermissionsTable.roleId, roleIds));
  await db.delete(staffRolesTable).where(inArray(staffRolesTable.id, roleIds));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
});

const csv = (day: string) => `Client UCI *,Remittance Date *,Amount *\n${nonce},2098-10-${day},160.00`;

describe("generic remittance import permissions", () => {
  it.each(["validate", "commit"])("%s denies staff without remittance_entry and permits authorized staff", async action => {
    const denied = await request(app).post(`/api/import/remittances/${action}`).set("Cookie", deniedCookie).send({ csvText: csv("01") });
    expect(denied.status).toBe(403);
    expect(denied.body.permission).toBe("remittance_entry");
    const allowed = await request(app).post(`/api/import/remittances/${action}`).set("Cookie", allowedCookie).send({ csvText: csv("01") });
    expect(allowed.status).toBe(200);
    expect(action === "validate" ? allowed.body.validRows : allowed.body.imported).toBe(1);
  });

  it("protects the remittance template without restricting plain-staff entity imports", async () => {
    expect((await request(app).get("/api/import/remittances/template").set("Cookie", deniedCookie)).status).toBe(403);
    expect((await request(app).get("/api/import/remittances/template").set("Cookie", allowedCookie)).status).toBe(200);
    for (const entity of ["clients", "vendors", "authorizations"]) {
      expect((await request(app).get(`/api/import/${entity}/template`).set("Cookie", deniedCookie)).status).toBe(200);
    }
  });

  it("rechecks permission inside the commit transaction and returns 403 without inserting a row", async () => {
    const check = vi.spyOn(auth, "hasUserPermissionInTransaction").mockResolvedValueOnce(false);
    try {
      const response = await request(app).post("/api/import/remittances/commit").set("Cookie", allowedCookie).send({ csvText: csv("02") });
      expect(response.status).toBe(403);
      expect(response.body.permission).toBe("remittance_entry");
      expect(check).toHaveBeenCalledWith(expect.anything(), userIds[1], "remittance_entry");
      expect(await db.select().from(remittancesTable).where(and(
        eq(remittancesTable.clientId, clientId), eq(remittancesTable.remittanceDate, "2098-10-02"),
      ))).toHaveLength(0);
    } finally {
      check.mockRestore();
    }
  });
});
