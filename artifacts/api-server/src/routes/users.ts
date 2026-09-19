import { Router, type IRouter } from "express";
import { eq, desc, and, or, gte, lte, ilike, count, sql, type SQL } from "drizzle-orm";
import { db, usersTable, auditLogTable, staffPermissionsTable, STAFF_PERMISSIONS } from "@workspace/db";
import {
  ListUsersQueryParams,
  ListUsersResponse,
  CreateUserBody,
  CreateUserResponse,
  UpdateUserBody,
  UpdateUserResponse,
  ListAuditLogQueryParams,
  ListAuditLogResponse,
} from "@workspace/api-zod";
import { requireStaff, hashPassword, audit, iso, getUserPermissions } from "../lib/auth";
import { userJson, userNameMap, diffDetail } from "../lib/serializers";
import { sortedOrder } from "../lib/sorting";

const router: IRouter = Router();

router.get("/users", requireStaff, async (req, res): Promise<void> => {
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
  const result = await Promise.all(users.map(async (user) => userJson(user, await getUserPermissions(user.id))));
  res.json(ListUsersResponse.parse(result));
});

router.post("/users", requireStaff, async (req, res): Promise<void> => {
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
  const permissions = parsed.data.role === "staff"
    ? (parsed.data.permissions === undefined ? [...STAFF_PERMISSIONS] : parsed.data.permissions)
    : [];
  const user = await db.transaction(async (tx) => {
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
      accountCreatedAt: new Date(),
      })
      .returning();
    if (permissions.length) await tx.insert(staffPermissionsTable).values(permissions.map((permission) => ({ userId: created.id, permission })));
    return created;
  });
  await audit(req.user!.id, "create_user", "user", user.id, `Created ${user.role} account for ${user.email}`);
  res.status(201).json(CreateUserResponse.parse(userJson(user, permissions)));
});

router.patch("/users/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { password, permissions: requestedPermissions, ...rest } = parsed.data;
  const updates: Record<string, unknown> = { ...rest };
  if (password) updates.passwordHash = hashPassword(password);
  const [before] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!before) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (rest.email) {
    const email = rest.email.trim().toLowerCase();
    updates.email = email;
    rest.email = email;
    if (email !== before.email) {
      const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
      if (existing) {
        res.status(409).json({ error: "A user with this email already exists" });
        return;
      }
    }
  } else if (rest.email !== undefined) {
    // Ignore empty-string email from untouched form fields
    delete updates.email;
    delete (rest as Record<string, unknown>).email;
  }
  const effectiveRole = (rest.role as string | undefined) ?? before.role;
  const permissions = effectiveRole === "staff"
    ? (requestedPermissions === undefined
      ? (before.role === "staff" ? await getUserPermissions(before.id) : [...STAFF_PERMISSIONS])
      : requestedPermissions)
    : [];
  const user = await db.transaction(async (tx) => {
    const [updated] = await tx.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
    await tx.delete(staffPermissionsTable).where(eq(staffPermissionsTable.userId, id));
    if (permissions.length) await tx.insert(staffPermissionsTable).values(permissions.map((permission) => ({ userId: id, permission })));
    return updated;
  });
  await audit(req.user!.id, "update_user", "user", user.id, diffDetail(before, rest, Object.keys(rest)));
  res.json(UpdateUserResponse.parse(userJson(user, permissions)));
});

router.delete("/users/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (id === req.user!.id) {
    res.status(400).json({ error: "You cannot delete your own account" });
    return;
  }
  const [user] = await db.update(usersTable).set({ active: false }).where(eq(usersTable.id, id)).returning();
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  await audit(req.user!.id, "delete_user", "user", user.id, `Deactivated ${user.email}`);
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
