import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { db, usersTable, staffRolesTable, staffRolePermissionsTable, auditLogTable, STAFF_PERMISSIONS } from "@workspace/db";

/**
 * Explicit, idempotent one-time bootstrap. This is intentionally never called
 * by application startup or deployment code.
 */
export async function seedStaffRoles(): Promise<{ roleId: string; assignedUsers: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(712046, 21)`);
    await tx.insert(staffRolesTable).values({
      name: "Admin",
      description: "Full access, including users and roles",
      isSystem: true,
    }).onConflictDoNothing();
    const [admin] = await tx.select().from(staffRolesTable)
      .where(sql`lower(${staffRolesTable.name}) = 'admin' and ${staffRolesTable.isDeleted} = false`);
    if (!admin) throw new Error("Unable to create or locate the Admin staff role");
    if (!admin.isSystem) {
      await tx.update(staffRolesTable).set({ isSystem: true })
        .where(eq(staffRolesTable.id, admin.id));
    }
    await tx.insert(staffRolePermissionsTable).values(
      STAFF_PERMISSIONS.map((permission) => ({ roleId: admin.id, permission })),
    ).onConflictDoNothing();
    const assigned = await tx.update(usersTable)
      .set({ staffRoleId: admin.id })
      .where(sql`${usersTable.role} = 'staff' and ${usersTable.staffRoleId} is null`)
      .returning({ id: usersTable.id });
    if (assigned.length) await tx.insert(auditLogTable).values(assigned.map(({ id }) => ({
      action: "assign_user_role",
      entityType: "user",
      entityId: id,
      detail: JSON.stringify({ staffRoleId: [null, admin.id], source: "initial_role_seed" }),
    })));
    return { roleId: admin.id, assignedUsers: assigned.length };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedStaffRoles().then(({ roleId, assignedUsers }) => {
    process.stdout.write(`Admin role ${roleId}; assigned ${assignedUsers} previously unassigned staff account(s).\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`Staff role seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}