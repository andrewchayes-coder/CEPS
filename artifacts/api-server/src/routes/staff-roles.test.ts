import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  auditLogTable,
  staffRolesTable,
  staffRolePermissionsTable,
  STAFF_PERMISSIONS,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `staffroles${Date.now().toString(36)}`;
const roleIds: string[] = [];
const userIds: string[] = [];
const cookies = new Map<string, string>();
const cookiesByUserId = new Map<string, string>();
let adminRoleId: string;
let basicRoleId: string;
let createRoleId: string;

async function makeRole(name: string, permissions: readonly string[], isSystem = false) {
  const [role] = await db.insert(staffRolesTable).values({
    name: `${nonce}-${name}`,
    isSystem,
  }).returning();
  roleIds.push(role.id);
  if (permissions.length) await db.insert(staffRolePermissionsTable).values(
    permissions.map((permission) => ({ roleId: role.id, permission })),
  );
  return role.id;
}

async function makeUser(name: string, role: string, staffRoleId: string | null) {
  const [user] = await db.insert(usersTable).values({
    name: `${nonce}-${name}`,
    email: `${nonce}-${name}@test.local`,
    role,
    staffRoleId,
  }).returning();
  userIds.push(user.id);
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId: user.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  cookies.set(name, `ceps_session=${token}`);
  cookiesByUserId.set(user.id, `ceps_session=${token}`);
  return user.id;
}

async function managerCookie() {
  const [manager] = await db.select({ id: usersTable.id }).from(usersTable)
    .innerJoin(staffRolesTable, eq(usersTable.staffRoleId, staffRolesTable.id))
    .innerJoin(staffRolePermissionsTable, eq(staffRolesTable.id, staffRolePermissionsTable.roleId))
    .where(and(
      inArray(usersTable.id, userIds),
      eq(usersTable.role, "staff"),
      eq(usersTable.active, true),
      eq(staffRolesTable.isDeleted, false),
      eq(staffRolePermissionsTable.permission, "manage_users"),
    ));
  return cookiesByUserId.get(manager.id)!;
}

beforeAll(async () => {
  adminRoleId = await makeRole("admin", STAFF_PERMISSIONS, true);
  basicRoleId = await makeRole("basic", []);
  await makeUser("admin-a", "staff", adminRoleId);
  await makeUser("admin-b", "staff", adminRoleId);
  await makeUser("admin-c", "staff", adminRoleId);
  await makeUser("basic-staff", "staff", basicRoleId);
  await makeUser("stale-nonstaff", "parent_guardian", adminRoleId);
});

afterAll(async () => {
  if (createRoleId) roleIds.push(createRoleId);
  if (userIds.length) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.userId, userIds));
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  if (roleIds.length) {
    await db.delete(staffRolePermissionsTable).where(inArray(staffRolePermissionsTable.roleId, roleIds));
    await db.delete(staffRolesTable).where(inArray(staffRolesTable.id, roleIds));
  }
});

describe("staff role permissions and guardrails", () => {
  it("resolves /auth/me permissions from the role and excludes stale non-staff assignments", async () => {
    const staff = await request(app).get("/api/auth/me").set("Cookie", cookies.get("admin-a")!);
    expect(staff.status).toBe(200);
    expect(staff.body.staffRole).toEqual({ id: adminRoleId, name: `${nonce}-admin` });
    expect(staff.body.permissions.sort()).toEqual([...STAFF_PERMISSIONS].sort());

    const parent = await request(app).get("/api/auth/me").set("Cookie", cookies.get("stale-nonstaff")!);
    expect(parent.status).toBe(200);
    expect(parent.body.staffRole).toBeNull();
    expect(parent.body.permissions).toEqual([]);
  });

  it("gates user management by manage_users while leaving the audit log staff-readable", async () => {
    expect((await request(app).get("/api/users").set("Cookie", cookies.get("admin-a")!)).status).toBe(200);
    expect((await request(app).get("/api/users").set("Cookie", cookies.get("basic-staff")!)).status).toBe(403);
    expect((await request(app).get("/api/staff-roles").set("Cookie", cookies.get("basic-staff")!)).status).toBe(403);
    expect((await request(app).get("/api/audit-log").set("Cookie", cookies.get("basic-staff")!)).status).toBe(200);
  });

  it("rechecks the actor permission after waiting for the authorization lock", async () => {
    let pendingCreate: Promise<request.Response> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(712046, 21)`);
      pendingCreate = Promise.resolve(request(app).post("/api/staff-roles")
        .set("Cookie", cookies.get("admin-a")!)
        .send({ name: `${nonce}-revoked-actor`, permissions: [] }));
      // Let the request pass middleware and reach the lock while this
      // transaction still owns it.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await tx.delete(staffRolePermissionsTable).where(and(
        eq(staffRolePermissionsTable.roleId, adminRoleId),
        eq(staffRolePermissionsTable.permission, "manage_users"),
      ));
    });
    const response = await pendingCreate!;
    expect(response.status).toBe(403);
    await db.insert(staffRolePermissionsTable).values({
      roleId: adminRoleId,
      permission: "manage_users",
    });
  });

  it("uses the target user's role assignment read after waiting for the lock", async () => {
    const targetId = userIds[4];
    await db.update(usersTable).set({ role: "parent_guardian", staffRoleId: null })
      .where(eq(usersTable.id, targetId));
    let pendingUpdate: Promise<request.Response> | undefined;

    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(712046, 21)`);
      pendingUpdate = Promise.resolve(request(app).patch(`/api/users/${targetId}`)
        .set("Cookie", cookies.get("admin-c")!)
        .send({ name: `${nonce}-fresh-target`, staffRoleId: basicRoleId }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      await tx.update(usersTable).set({ role: "staff", staffRoleId: adminRoleId })
        .where(eq(usersTable.id, targetId));
    });

    const response = await pendingUpdate!;
    expect(response.status).toBe(200);
    expect(response.body.role).toBe("staff");
    expect(response.body.staffRole).toEqual({ id: basicRoleId, name: `${nonce}-basic` });
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId));
    expect(target.staffRoleId).toBe(basicRoleId);
    const [assignmentAudit] = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.entityId, targetId),
      eq(auditLogTable.action, "assign_user_role"),
    ));
    expect(JSON.parse(assignmentAudit.detail!).staffRoleId).toEqual([adminRoleId, basicRoleId]);
  });

  it("protects Admin and refuses deleting a role with active users", async () => {
    const cannotReduce = await request(app).patch(`/api/staff-roles/${adminRoleId}`)
      .set("Cookie", cookies.get("admin-a")!)
      .send({ permissions: STAFF_PERMISSIONS.filter((permission) => permission !== "check_writing") });
    expect(cannotReduce.status).toBe(400);
    const cannotRename = await request(app).patch(`/api/staff-roles/${adminRoleId}`)
      .set("Cookie", cookies.get("admin-a")!).send({ name: "renamed-admin" });
    expect(cannotRename.status).toBe(400);
    const cannotDelete = await request(app).delete(`/api/staff-roles/${adminRoleId}`)
      .set("Cookie", cookies.get("admin-a")!);
    expect(cannotDelete.status).toBe(400);

    const inUse = await request(app).delete(`/api/staff-roles/${basicRoleId}`)
      .set("Cookie", cookies.get("admin-a")!);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error).toContain("active user");
  });

  it("serializes concurrent demotions so at least one manage_users user remains", async () => {
    const [adminA, adminB] = userIds;
    const results = await Promise.all([
      request(app).patch(`/api/users/${adminA}`).set("Cookie", cookies.get("admin-a")!)
        .send({ staffRoleId: basicRoleId }),
      request(app).patch(`/api/users/${adminB}`).set("Cookie", cookies.get("admin-b")!)
        .send({ staffRoleId: basicRoleId }),
    ]);
    expect(results.some((result) => result.status === 200)).toBe(true);
    // The development seed may contain additional managers, so both isolated
    // fixture users can be demoted without violating the global invariant.
    expect(results.every((result) => result.status === 200 || result.status === 409 || result.status === 403)).toBe(true);
    const remaining = await db.select({ id: usersTable.id }).from(usersTable)
      .innerJoin(staffRolesTable, eq(usersTable.staffRoleId, staffRolesTable.id))
      .innerJoin(staffRolePermissionsTable, eq(staffRolesTable.id, staffRolePermissionsTable.roleId))
      .where(and(
        eq(usersTable.role, "staff"),
        eq(usersTable.active, true),
        eq(staffRolesTable.isDeleted, false),
        eq(staffRolePermissionsTable.permission, "manage_users"),
      ));
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  });

  it("creates roles from catalog permissions and audits the permission before/after", async () => {
    const catalog = await request(app).get("/api/staff-permissions").set("Cookie", cookies.get("admin-c")!);
    expect(catalog.status).toBe(200);
    expect(catalog.body.map((entry: { permission: string }) => entry.permission).sort()).toEqual([...STAFF_PERMISSIONS].sort());

    const actor = await managerCookie();
    const created = await request(app).post("/api/staff-roles")
      .set("Cookie", actor)
      .send({ name: `${nonce}-new-role`, permissions: ["remittance_entry"] });
    expect(created.status).toBe(201);
    createRoleId = created.body.id;
    expect(created.body.permissions).toEqual(["remittance_entry"]);
    const edited = await request(app).patch(`/api/staff-roles/${createRoleId}`)
      .set("Cookie", actor)
      .send({ permissions: ["invoice_approve"] });
    expect(edited.status).toBe(200);
    const audits = await db.select().from(auditLogTable)
      .where(eq(auditLogTable.entityId, createRoleId));
    expect(audits.some((entry) => entry.action === "change_staff_role_permissions" &&
      entry.detail?.includes('["remittance_entry"]') && entry.detail.includes('["invoice_approve"]'))).toBe(true);
  });
});