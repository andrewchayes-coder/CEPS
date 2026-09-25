import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogTable,
  db,
  STAFF_PERMISSIONS,
  staffRolePermissionsTable,
  staffRolesTable,
  usersTable,
} from "@workspace/db";
import { seedStaffRoles } from "./seed-staff-roles";

const nonce = `seed-staff-roles-${randomUUID()}`;
const unrelatedUnassignedStaff = await db.select({ id: usersTable.id }).from(usersTable)
  .where(sql`${usersTable.role} = 'staff' and ${usersTable.staffRoleId} is null`);
const userIds: string[] = [];
let fixtureRoleId: string | undefined;
let createdAdminRoleId: string | undefined;
let assignedStaffId: string;
let restrictedStaffId: string;
let nonStaffId: string;
let adminBefore: typeof staffRolesTable.$inferSelect | undefined;
let adminPermissionsBefore: string[] = [];

describe.skipIf(unrelatedUnassignedStaff.length > 0)("seedStaffRoles", () => {
  beforeAll(async () => {
    // The seed updates every unassigned staff account. Refuse to run in a
    // populated database where that could change unrelated users.
    const unassignedStaff = await db.select({ id: usersTable.id }).from(usersTable)
      .where(sql`${usersTable.role} = 'staff' and ${usersTable.staffRoleId} is null`);
    expect(unassignedStaff).toEqual([]);

    [adminBefore] = await db.select().from(staffRolesTable).where(and(
      sql`lower(${staffRolesTable.name}) = 'admin'`,
      eq(staffRolesTable.isDeleted, false),
    ));
    if (adminBefore) {
      const permissions = await db.select({ permission: staffRolePermissionsTable.permission })
        .from(staffRolePermissionsTable)
        .where(eq(staffRolePermissionsTable.roleId, adminBefore.id));
      adminPermissionsBefore = permissions.map(({ permission }) => permission).sort();
      // The development database's protected Admin is already seeded. Do not
      // let this test use the script to repair or otherwise alter it.
      expect(adminBefore.isSystem).toBe(true);
      expect(adminPermissionsBefore).toEqual([...STAFF_PERMISSIONS].sort());
    }

    const [restrictedRole] = await db.insert(staffRolesTable).values({
      name: `${nonce}-restricted`,
      description: "Test-only restricted role",
    }).returning();
    fixtureRoleId = restrictedRole.id;

    const users = await db.insert(usersTable).values([
      {
        name: `${nonce}-unassigned-staff`,
        email: `${nonce}-unassigned-staff@test.local`,
        role: "staff",
        staffRoleId: null,
      },
      {
        name: `${nonce}-restricted-staff`,
        email: `${nonce}-restricted-staff@test.local`,
        role: "staff",
        staffRoleId: restrictedRole.id,
      },
      {
        name: `${nonce}-non-staff`,
        email: `${nonce}-non-staff@test.local`,
        role: "parent_guardian",
        staffRoleId: restrictedRole.id,
      },
    ]).returning({ id: usersTable.id });
    userIds.push(...users.map(({ id }) => id));
    [assignedStaffId, restrictedStaffId, nonStaffId] = userIds;
  });

  afterAll(async () => {
    if (userIds.length) {
      await db.delete(auditLogTable).where(and(
        eq(auditLogTable.action, "assign_user_role"),
        inArray(auditLogTable.entityId, userIds),
      ));
      await db.delete(usersTable).where(inArray(usersTable.id, userIds));
    }
    if (fixtureRoleId) {
      await db.delete(staffRolePermissionsTable)
        .where(eq(staffRolePermissionsTable.roleId, fixtureRoleId));
      await db.delete(staffRolesTable).where(eq(staffRolesTable.id, fixtureRoleId));
    }
    if (createdAdminRoleId) {
      await db.delete(staffRolePermissionsTable)
        .where(eq(staffRolePermissionsTable.roleId, createdAdminRoleId));
      await db.delete(staffRolesTable).where(eq(staffRolesTable.id, createdAdminRoleId));
    }
  });

  it("creates the Admin permissions and assigns only unassigned staff, idempotently", async () => {
    const firstRun = await seedStaffRoles();
    if (!adminBefore) createdAdminRoleId = firstRun.roleId;

    expect(firstRun.roleId).toBe(adminBefore?.id ?? firstRun.roleId);
    expect(firstRun.assignedUsers).toBe(1);

    const [admin] = await db.select().from(staffRolesTable)
      .where(eq(staffRolesTable.id, firstRun.roleId));
    expect(admin.name).toBe("Admin");
    expect(admin.isSystem).toBe(true);
    const seededPermissions = await db.select({ permission: staffRolePermissionsTable.permission })
      .from(staffRolePermissionsTable)
      .where(eq(staffRolePermissionsTable.roleId, firstRun.roleId));
    expect(seededPermissions.map(({ permission }) => permission).sort())
      .toEqual([...STAFF_PERMISSIONS].sort());

    const secondRun = await seedStaffRoles();
    expect(secondRun).toEqual({ roleId: firstRun.roleId, assignedUsers: 0 });

    const [assignedStaff, restrictedStaff, nonStaff] = await db.select({
      id: usersTable.id,
      role: usersTable.role,
      staffRoleId: usersTable.staffRoleId,
    }).from(usersTable).where(inArray(usersTable.id, [
      assignedStaffId,
      restrictedStaffId,
      nonStaffId,
    ]));
    const byId = new Map([assignedStaff, restrictedStaff, nonStaff].map((user) => [user.id, user]));
    expect(byId.get(assignedStaffId)?.staffRoleId).toBe(firstRun.roleId);
    expect(byId.get(restrictedStaffId)?.staffRoleId).toBe(fixtureRoleId);
    expect(byId.get(nonStaffId)).toMatchObject({
      role: "parent_guardian",
      staffRoleId: fixtureRoleId,
    });

    const assignmentAudits = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.action, "assign_user_role"),
      eq(auditLogTable.entityId, assignedStaffId),
    ));
    expect(assignmentAudits).toHaveLength(1);

    if (adminBefore) {
      const [adminAfter] = await db.select().from(staffRolesTable)
        .where(eq(staffRolesTable.id, adminBefore.id));
      const permissionRows = await db.select({ permission: staffRolePermissionsTable.permission })
        .from(staffRolePermissionsTable)
        .where(eq(staffRolePermissionsTable.roleId, adminBefore.id));
      expect(adminAfter).toEqual(adminBefore);
      expect(permissionRows.map(({ permission }) => permission).sort()).toEqual(adminPermissionsBefore);
    }
  });
});