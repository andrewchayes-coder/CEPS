import { Router, type IRouter } from "express";
import { and, count, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  auditLogTable,
  staffRolesTable,
  staffRolePermissionsTable,
  STAFF_PERMISSION_CATALOG,
  type StaffPermission,
} from "@workspace/db";
import {
  CreateStaffRoleBody,
  CreateStaffRoleResponse,
  DeleteStaffRoleResponse,
  GetStaffPermissionsResponse,
  ListStaffRolesResponse,
  UpdateStaffRoleParams,
  UpdateStaffRoleBody,
  UpdateStaffRoleResponse,
  DeleteStaffRoleParams,
} from "@workspace/api-zod";
import { requirePermission, hasUserPermissionInTransaction } from "../lib/auth";

const router: IRouter = Router();
const requireManageUsers = requirePermission("manage_users");
class RoleGuardrailError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function lockAuthorizationChanges(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(712046, 21)`);
}

async function ensureManageUsersPermission(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
): Promise<void> {
  if (!(await hasUserPermissionInTransaction(tx, userId, "manage_users"))) {
    throw new RoleGuardrailError("Missing required permission: manage_users", 403);
  }
}

async function activeManagerCount(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<number> {
  const [{ value }] = await tx.select({ value: count() })
    .from(usersTable)
    .innerJoin(staffRolesTable, eq(usersTable.staffRoleId, staffRolesTable.id))
    .innerJoin(staffRolePermissionsTable, eq(staffRolesTable.id, staffRolePermissionsTable.roleId))
    .where(and(
      eq(usersTable.role, "staff"),
      eq(usersTable.active, true),
      eq(staffRolesTable.isDeleted, false),
      eq(staffRolePermissionsTable.permission, "manage_users"),
    ));
  return value;
}

async function serializeRole(roleId: string) {
  const [role] = await db.select().from(staffRolesTable)
    .where(and(eq(staffRolesTable.id, roleId), eq(staffRolesTable.isDeleted, false)));
  if (!role) return null;
  const [permissionRows, [{ activeUserCount }]] = await Promise.all([
    db.select({ permission: staffRolePermissionsTable.permission })
      .from(staffRolePermissionsTable)
      .where(eq(staffRolePermissionsTable.roleId, role.id)),
    db.select({ activeUserCount: count() })
      .from(usersTable)
      .where(and(eq(usersTable.staffRoleId, role.id), eq(usersTable.active, true))),
  ]);
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissions: permissionRows.map(({ permission }) => permission),
    activeUserCount,
  };
}

async function listRoles() {
  const roles = await db.select({ id: staffRolesTable.id }).from(staffRolesTable)
    .where(eq(staffRolesTable.isDeleted, false))
    .orderBy(staffRolesTable.name);
  return Promise.all(roles.map(({ id }) => serializeRole(id)));
}

router.get("/staff-permissions", requireManageUsers, async (_req, res): Promise<void> => {
  res.json(GetStaffPermissionsResponse.parse(STAFF_PERMISSION_CATALOG));
});

router.get("/staff-roles", requireManageUsers, async (_req, res): Promise<void> => {
  res.json(ListStaffRolesResponse.parse(await listRoles()));
});

router.post("/staff-roles", requireManageUsers, async (req, res): Promise<void> => {
  const parsed = CreateStaffRoleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const roleId = await db.transaction(async (tx) => {
      await lockAuthorizationChanges(tx);
      await ensureManageUsersPermission(tx, req.user!.id);
      const [role] = await tx.insert(staffRolesTable).values({
        name: parsed.data.name.trim(),
        description: parsed.data.description ?? null,
        createdBy: req.user!.id,
      }).returning();
      if (parsed.data.permissions.length) await tx.insert(staffRolePermissionsTable).values(
        parsed.data.permissions.map((permission) => ({ roleId: role.id, permission })),
      );
      await tx.insert(auditLogTable).values({
        userId: req.user!.id,
        action: "create_staff_role",
        entityType: "staff_role",
        entityId: role.id,
        detail: JSON.stringify({
          name: [null, role.name],
          description: [null, role.description],
          permissions: [[], parsed.data.permissions],
        }),
      });
      return role.id;
    });
    res.status(201).json(CreateStaffRoleResponse.parse(await serializeRole(roleId)));
  } catch (error) {
    if (error instanceof RoleGuardrailError) {
      res.status(error.status).json(error.status === 403
        ? { error: "Missing required permission", permission: "manage_users" }
        : { error: error.message });
      return;
    }
    if ((error as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A role with this name already exists" });
      return;
    }
    throw error;
  }
});

router.patch("/staff-roles/:id", requireManageUsers, async (req, res): Promise<void> => {
  const params = UpdateStaffRoleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { id } = params.data;
  const parsed = UpdateStaffRoleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    await db.transaction(async (tx) => {
      await lockAuthorizationChanges(tx);
      await ensureManageUsersPermission(tx, req.user!.id);
      const [before] = await tx.select().from(staffRolesTable)
        .where(and(eq(staffRolesTable.id, id), eq(staffRolesTable.isDeleted, false)));
      if (!before) throw new RoleGuardrailError("Staff role not found", 404);
      if (before.isSystem && parsed.data.name !== undefined && parsed.data.name.trim() !== before.name) {
        throw new RoleGuardrailError("The Admin role cannot be renamed", 400);
      }
      const beforePermissions = (await tx.select({ permission: staffRolePermissionsTable.permission })
        .from(staffRolePermissionsTable)
        .where(eq(staffRolePermissionsTable.roleId, id)))
        .map(({ permission }) => permission as StaffPermission);
      const nextPermissions = parsed.data.permissions ?? beforePermissions;
      if (before.isSystem && beforePermissions.some((permission) => !nextPermissions.includes(permission))) {
        throw new RoleGuardrailError("The Admin role permissions cannot be reduced", 400);
      }
      const updates: { name?: string; description?: string | null } = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name.trim();
      if (parsed.data.description !== undefined) updates.description = parsed.data.description ?? null;
      if (Object.keys(updates).length) {
        await tx.update(staffRolesTable).set(updates).where(eq(staffRolesTable.id, id));
      }
      if (parsed.data.permissions !== undefined) {
        await tx.delete(staffRolePermissionsTable).where(eq(staffRolePermissionsTable.roleId, id));
        if (nextPermissions.length) await tx.insert(staffRolePermissionsTable).values(
          nextPermissions.map((permission) => ({ roleId: id, permission })),
        );
      }
      if (await activeManagerCount(tx) < 1) {
        throw new RoleGuardrailError("At least one active staff user must retain the manage_users permission", 409);
      }
      const after = {
        name: updates.name ?? before.name,
        description: updates.description === undefined ? before.description : updates.description,
        permissions: nextPermissions,
      };
      await tx.insert(auditLogTable).values({
        userId: req.user!.id,
        action: "update_staff_role",
        entityType: "staff_role",
        entityId: id,
        detail: JSON.stringify({
          name: [before.name, after.name],
          description: [before.description, after.description],
          permissions: [beforePermissions, after.permissions],
        }),
      });
      if (JSON.stringify([...beforePermissions].sort()) !== JSON.stringify([...nextPermissions].sort())) {
        await tx.insert(auditLogTable).values({
          userId: req.user!.id,
          action: "change_staff_role_permissions",
          entityType: "staff_role",
          entityId: id,
          detail: JSON.stringify({ permissions: [beforePermissions, nextPermissions] }),
        });
      }
    });
    const role = await serializeRole(id);
    if (!role) {
      res.status(404).json({ error: "Staff role not found" });
      return;
    }
    res.json(UpdateStaffRoleResponse.parse(role));
  } catch (error) {
    if (error instanceof RoleGuardrailError) {
      res.status(error.status).json(error.status === 403
        ? { error: "Missing required permission", permission: "manage_users" }
        : { error: error.message });
      return;
    }
    if ((error as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A role with this name already exists" });
      return;
    }
    throw error;
  }
});

router.delete("/staff-roles/:id", requireManageUsers, async (req, res): Promise<void> => {
  const params = DeleteStaffRoleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { id } = params.data;
  try {
    await db.transaction(async (tx) => {
      await lockAuthorizationChanges(tx);
      await ensureManageUsersPermission(tx, req.user!.id);
      const [role] = await tx.select().from(staffRolesTable)
        .where(and(eq(staffRolesTable.id, id), eq(staffRolesTable.isDeleted, false)));
      if (!role) throw new RoleGuardrailError("Staff role not found", 404);
      if (role.isSystem) throw new RoleGuardrailError("The Admin role cannot be deleted", 400);
      const [{ activeUserCount }] = await tx.select({ activeUserCount: count() })
        .from(usersTable)
        .where(and(eq(usersTable.staffRoleId, id), eq(usersTable.active, true)));
      if (activeUserCount > 0) {
        throw new RoleGuardrailError(`Cannot delete this role while ${activeUserCount} active user(s) are assigned; reassign them first`, 409);
      }
      const beforePermissions = (await tx.select({ permission: staffRolePermissionsTable.permission })
        .from(staffRolePermissionsTable)
        .where(eq(staffRolePermissionsTable.roleId, id)))
        .map(({ permission }) => permission);
      const deletedAt = new Date();
      await tx.update(staffRolesTable).set({ isDeleted: true, deletedAt, deletedBy: req.user!.id })
        .where(eq(staffRolesTable.id, id));
      await tx.insert(auditLogTable).values({
        userId: req.user!.id,
        action: "delete_staff_role",
        entityType: "staff_role",
        entityId: id,
        detail: JSON.stringify({ name: [role.name, null], permissions: [beforePermissions, []] }),
      });
    });
    res.json(DeleteStaffRoleResponse.parse({ ok: true }));
  } catch (error) {
    if (error instanceof RoleGuardrailError) {
      res.status(error.status).json(error.status === 403
        ? { error: "Missing required permission", permission: "manage_users" }
        : { error: error.message });
      return;
    }
    throw error;
  }
});

export default router;