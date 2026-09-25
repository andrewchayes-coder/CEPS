import { Router, type IRouter } from "express";
import { eq, desc, and, or, gte, lte, ilike, count, sql, type SQL } from "drizzle-orm";
import { db, usersTable, auditLogTable, staffRolesTable, staffRolePermissionsTable } from "@workspace/db";
import {
  ListUserDirectoryQueryParams,
  ListUserDirectoryResponse,
  ListUsersQueryParams,
  ListUsersResponse,
  CreateUserBody,
  CreateUserResponse,
  UpdateUserBody,
  UpdateUserResponse,
  ListAuditLogQueryParams,
  ListAuditLogResponse,
} from "@workspace/api-zod";
import { requireStaff, requirePermission, hashPassword, iso, getUserPermissions, getUserStaffRole, hasUserPermissionInTransaction } from "../lib/auth";
import { userJson, userNameMap, diffDetail } from "../lib/serializers";
import { sortedOrder } from "../lib/sorting";

const router: IRouter = Router();
const requireManageUsers = requirePermission("manage_users");
const MANAGE_USERS_LOCK = sql`select pg_advisory_xact_lock(712046, 21)`;

class UserGuardrailError extends Error {}
class UserPermissionRevokedError extends Error {}

async function activeManageUsersCount(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<number> {
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

router.get("/user-directory", requireStaff, async (req, res): Promise<void> => {
  const rawActive = req.query.active;
  if (rawActive !== undefined && rawActive !== "true" && rawActive !== "false") {
    res.status(400).json({ error: "active must be true or false" });
    return;
  }
  const query = ListUserDirectoryQueryParams.safeParse({
    ...req.query,
    active: rawActive === undefined ? undefined : rawActive === "true",
  });
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conditions = [];
  if (query.data.role) conditions.push(eq(usersTable.role, query.data.role));
  if (query.data.active !== undefined) conditions.push(eq(usersTable.active, query.data.active));
  if (query.data.search) {
    const escaped = query.data.search.replace(/[\\%_]/g, (c) => `\\${c}`);
    conditions.push(ilike(usersTable.name, `%${escaped}%`));
  }
  const directoryQuery = db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      role: usersTable.role,
      active: usersTable.active,
    })
    .from(usersTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(usersTable.name);
  const entries = query.data.limit != null
    ? await directoryQuery.limit(Math.min(Math.max(query.data.limit, 1), 100))
    : await directoryQuery;
  res.json(ListUserDirectoryResponse.parse(entries));
});

router.get("/users", requireManageUsers, async (req, res): Promise<void> => {
  // Deliberately excluded from the reusable date-filter contract: this is the
  // small administrative account picker, returns an unpaginated array, and is
  // not a user-facing operational list despite users.createdAt being present.
  const query = ListUsersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conditions = [];
  if (query.data.role) conditions.push(eq(usersTable.role, query.data.role));
  const rawActive = req.query.active;
  if (typeof rawActive === "string" && (rawActive === "true" || rawActive === "false")) {
    conditions.push(eq(usersTable.active, rawActive === "true"));
  }
  if (query.data.search) {
    const escaped = query.data.search.replace(/[\\%_]/g, (c) => `\\${c}`);
    const like = `%${escaped}%`;
    conditions.push(or(ilike(usersTable.name, like), ilike(usersTable.email, like))!);
  }
  const usersQuery = db
    .select()
    .from(usersTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(usersTable.name);
  // Keep the existing administrative list response unbounded unless a picker
  // explicitly asks for a capped search result.
  const users = query.data.limit != null
    ? await usersQuery.limit(Math.min(Math.max(query.data.limit, 1), 100))
    : await usersQuery;
  const result = await Promise.all(users.map(async (user) => ({
    ...userJson(user, await getUserPermissions(user.id, db, req)),
    staffRole: await getUserStaffRole(user, db, req),
  })));
  res.json(ListUsersResponse.parse(result));
});

router.post("/users", requireManageUsers, async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing) {
    res.status(409).json({ error: "A user with this email already exists" });
    return;
  }
  if (parsed.data.role === "staff" && !parsed.data.staffRoleId) {
    res.status(400).json({ error: "Choose a staff role for staff users" });
    return;
  }
  if (parsed.data.role !== "staff" && parsed.data.staffRoleId) {
    res.status(400).json({ error: "Non-staff users cannot be assigned a staff role" });
    return;
  }
  let user;
  try {
    user = await db.transaction(async (tx) => {
      await tx.execute(MANAGE_USERS_LOCK);
      if (!(await hasUserPermissionInTransaction(tx, req.user!.id, "manage_users"))) {
        throw new UserPermissionRevokedError();
      }
      const [duplicate] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email));
      if (duplicate) throw new UserGuardrailError("A user with this email already exists");
      if (parsed.data.staffRoleId) {
        const [role] = await tx.select({ id: staffRolesTable.id }).from(staffRolesTable)
          .where(and(eq(staffRolesTable.id, parsed.data.staffRoleId), eq(staffRolesTable.isDeleted, false)));
        if (!role) throw new UserGuardrailError("Selected staff role was not found or has been deleted");
      }
      const [created] = await tx
        .insert(usersTable)
        .values({
          name: parsed.data.name,
          email,
          phone: parsed.data.phone,
          role: parsed.data.role,
          passwordHash: parsed.data.password ? hashPassword(parsed.data.password) : null,
          linkedRecordId: parsed.data.linkedRecordId,
          linkedRecordType: parsed.data.linkedRecordType,
          staffRoleId: parsed.data.role === "staff" ? parsed.data.staffRoleId : null,
          accountCreatedAt: new Date(),
        })
        .returning();
      await tx.insert(auditLogTable).values({
        userId: req.user!.id,
        action: "create_user",
        entityType: "user",
        entityId: created.id,
        detail: `Created ${created.role} account for ${created.email}`,
      });
      if (created.staffRoleId) await tx.insert(auditLogTable).values({
        userId: req.user!.id,
        action: "assign_user_role",
        entityType: "user",
        entityId: created.id,
        detail: JSON.stringify({ staffRoleId: [null, created.staffRoleId] }),
      });
      return created;
    });
  } catch (error) {
    if (error instanceof UserPermissionRevokedError) {
      res.status(403).json({ error: "Missing required permission", permission: "manage_users" });
      return;
    }
    if (error instanceof UserGuardrailError) {
      res.status(error.message.startsWith("A user") ? 409 : 400).json({ error: error.message });
      return;
    }
    throw error;
  }
  res.status(201).json(CreateUserResponse.parse({
    ...userJson(user, await getUserPermissions(user.id, db, req)),
    staffRole: await getUserStaffRole(user, db, req),
  }));
});

router.patch("/users/:id", requireManageUsers, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { password, permissions: _ignoredLegacyPermissions, staffRoleId: requestedStaffRoleId, ...rest } = parsed.data;
  void _ignoredLegacyPermissions;
  const passwordHash = password ? hashPassword(password) : undefined;
  let user;
  try {
    user = await db.transaction(async (tx) => {
      await tx.execute(MANAGE_USERS_LOCK);
      if (!(await hasUserPermissionInTransaction(tx, req.user!.id, "manage_users"))) {
        throw new UserPermissionRevokedError();
      }
      const [before] = await tx.select().from(usersTable).where(eq(usersTable.id, id));
      if (!before) throw new UserGuardrailError("User not found");

      const updates: Record<string, unknown> = { ...rest };
      if (passwordHash) updates.passwordHash = passwordHash;
      if (rest.email) {
        const email = rest.email.trim().toLowerCase();
        updates.email = email;
        rest.email = email;
        if (email !== before.email) {
          const [existing] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email));
          if (existing) throw new UserGuardrailError("A user with this email already exists");
        }
      } else if (rest.email !== undefined) {
        // Ignore empty-string email from untouched form fields.
        delete updates.email;
        delete (rest as Record<string, unknown>).email;
      }
      const effectiveRole = (rest.role as string | undefined) ?? before.role;
      const effectiveStaffRoleId = effectiveRole === "staff"
        ? (requestedStaffRoleId ?? (before.role === "staff" ? before.staffRoleId : null))
        : null;
      if (effectiveRole === "staff" && !effectiveStaffRoleId) {
        throw new UserGuardrailError("Choose a staff role for staff users");
      }
      // Always clear stale role assignments on non-staff accounts.
      updates.staffRoleId = effectiveStaffRoleId;
      if (effectiveStaffRoleId) {
        const [role] = await tx.select({ id: staffRolesTable.id }).from(staffRolesTable)
          .where(and(eq(staffRolesTable.id, effectiveStaffRoleId), eq(staffRolesTable.isDeleted, false)));
        if (!role) throw new UserGuardrailError("Selected staff role was not found or has been deleted");
      }
      const [updated] = await tx.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
      const managerCount = await activeManageUsersCount(tx);
      if (managerCount < 1) {
        throw new UserGuardrailError("At least one active staff user must retain the manage_users permission");
      }
      const changes = diffDetail(before, { ...rest, staffRoleId: effectiveStaffRoleId }, [...Object.keys(rest), "staffRoleId"]);
      await tx.insert(auditLogTable).values({
        userId: req.user!.id,
        action: "update_user",
        entityType: "user",
        entityId: updated.id,
        detail: changes,
      });
      if (before.staffRoleId !== updated.staffRoleId) await tx.insert(auditLogTable).values({
        userId: req.user!.id,
        action: "assign_user_role",
        entityType: "user",
        entityId: updated.id,
        detail: JSON.stringify({ staffRoleId: [before.staffRoleId, updated.staffRoleId] }),
      });
      return updated;
    });
  } catch (error) {
    if (error instanceof UserPermissionRevokedError) {
      res.status(403).json({ error: "Missing required permission", permission: "manage_users" });
      return;
    }
    if (error instanceof UserGuardrailError) {
      const status = error.message === "User not found" ? 404
        : error.message.startsWith("Selected") || error.message.startsWith("Choose") ? 400 : 409;
      res.status(status).json({ error: error.message });
      return;
    }
    throw error;
  }
  req.staffPermissionsCache?.delete(user.id);
  req.staffRoleCache?.delete(user.id);
  res.json(UpdateUserResponse.parse({
    ...userJson(user, await getUserPermissions(user.id, db, req)),
    staffRole: await getUserStaffRole(user, db, req),
  }));
});

router.delete("/users/:id", requireManageUsers, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (id === req.user!.id) {
    res.status(400).json({ error: "You cannot delete your own account" });
    return;
  }
  let user;
  try {
    user = await db.transaction(async (tx) => {
      await tx.execute(MANAGE_USERS_LOCK);
      if (!(await hasUserPermissionInTransaction(tx, req.user!.id, "manage_users"))) {
        throw new UserPermissionRevokedError();
      }
      const [deactivated] = await tx.update(usersTable).set({ active: false }).where(eq(usersTable.id, id)).returning();
      if (!deactivated) return null;
      if (await activeManageUsersCount(tx) < 1) {
        throw new UserGuardrailError("At least one active staff user must retain the manage_users permission");
      }
      await tx.insert(auditLogTable).values({
        userId: req.user!.id,
        action: "delete_user",
        entityType: "user",
        entityId: deactivated.id,
        detail: `Deactivated ${deactivated.email}`,
      });
      return deactivated;
    });
  } catch (error) {
    if (error instanceof UserPermissionRevokedError) {
      res.status(403).json({ error: "Missing required permission", permission: "manage_users" });
      return;
    }
    if (error instanceof UserGuardrailError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ ok: true });
});

router.get("/audit-log", requireStaff, async (req, res): Promise<void> => {
  const query = ListAuditLogQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { userId, action, entityType } = query.data;
  // Preserve dateFrom/dateTo while accepting the reusable list-filter aliases.
  const dateFrom = query.data.dateFrom ?? query.data.startDate;
  const dateTo = query.data.dateTo ?? query.data.endDate;
  if (dateFrom && dateTo && new Date(`${dateFrom}T00:00:00Z`) > new Date(`${dateTo}T00:00:00Z`)) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const conditions: SQL[] = [];
  if (userId) conditions.push(eq(auditLogTable.userId, userId));
  if (action) conditions.push(ilike(auditLogTable.action, `%${escapeLike(action)}%`));
  if (entityType) conditions.push(ilike(auditLogTable.entityType, `%${escapeLike(entityType)}%`));
  // The audit log's free-text search covers every displayed field, including
  // related actor names and the displayed entity identifier.
  const search = query.data.search;
  if (search) {
    const like = `%${escapeLike(search)}%`;
    conditions.push(or(
      ilike(auditLogTable.action, like),
      ilike(auditLogTable.entityType, like),
      ilike(auditLogTable.entityId, like),
      ilike(auditLogTable.detail, like),
      sql`${auditLogTable.userId} in (select id from users where name ilike ${like} or email ilike ${like})`,
      sql`cast(${auditLogTable.createdAt} as text) ilike ${like}`,
      sql`to_char(${auditLogTable.createdAt}, 'Mon FMDD, YYYY FMHH12:MI AM') ilike ${like}`,
    )!);
  }
  if (dateFrom) {
    const from = new Date(`${dateFrom}T00:00:00Z`);
    if (!Number.isNaN(from.getTime())) conditions.push(gte(auditLogTable.createdAt, from));
  }
  if (dateTo) {
    const to = new Date(`${dateTo}T23:59:59.999Z`);
    if (!Number.isNaN(to.getTime())) conditions.push(lte(auditLogTable.createdAt, to));
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const order = sortedOrder(
    query.data.sortBy,
    query.data.sortDirection,
    {
      createdAt: sql`${auditLogTable.createdAt}`,
      userName: sql`lower((select name from users where id = ${auditLogTable.userId}))`,
      action: sql`lower(${auditLogTable.action})`,
      entityType: sql`lower(${auditLogTable.entityType})`,
      entityId: sql`lower(${auditLogTable.entityId})`,
      detail: sql`lower(${auditLogTable.detail})`,
    },
    sql`${auditLogTable.id}`,
    [desc(auditLogTable.createdAt), desc(auditLogTable.id)],
  );
  const [[{ total }], entries] = await Promise.all([
    db.select({ total: count() }).from(auditLogTable).where(where),
    db
      .select()
      .from(auditLogTable)
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
  ]);
  const names = await userNameMap(entries.map((e) => e.userId));
  res.json(
    ListAuditLogResponse.parse({
      entries: entries.map((e) => ({
        id: e.id,
        userId: e.userId,
        userName: e.userId ? (names.get(e.userId) ?? null) : null,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        detail: e.detail,
        createdAt: iso(e.createdAt),
      })),
      total,
    }),
  );
});

export default router;
