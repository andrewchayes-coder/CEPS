import { Router, type IRouter } from "express";
import { eq, desc, and, gte, lte, ilike, count, type SQL } from "drizzle-orm";
import { db, usersTable, auditLogTable } from "@workspace/db";
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
import { requireStaff, hashPassword, audit, iso } from "../lib/auth";
import { userJson, userNameMap, diffDetail } from "../lib/serializers";

const router: IRouter = Router();

router.get("/users", requireStaff, async (req, res): Promise<void> => {
  const query = ListUsersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  let users = await db.select().from(usersTable).orderBy(usersTable.name);
  if (query.data.role) users = users.filter((u) => u.role === query.data.role);
  res.json(ListUsersResponse.parse(users.map(userJson)));
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
  const [user] = await db
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
  await audit(req.user!.id, "create_user", "user", user.id, `Created ${user.role} account for ${user.email}`);
  res.status(201).json(CreateUserResponse.parse(userJson(user)));
});

router.patch("/users/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { password, ...rest } = parsed.data;
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
  const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
  await audit(req.user!.id, "update_user", "user", user.id, diffDetail(before, rest, Object.keys(rest)));
  res.json(UpdateUserResponse.parse(userJson(user)));
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
  const { userId, action, entityType, dateFrom, dateTo } = query.data;
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const conditions: SQL[] = [];
  if (userId) conditions.push(eq(auditLogTable.userId, userId));
  if (action) conditions.push(ilike(auditLogTable.action, `%${escapeLike(action)}%`));
  if (entityType) conditions.push(ilike(auditLogTable.entityType, `%${escapeLike(entityType)}%`));
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
  const [[{ total }], entries] = await Promise.all([
    db.select({ total: count() }).from(auditLogTable).where(where),
    db
      .select()
      .from(auditLogTable)
      .where(where)
      .orderBy(desc(auditLogTable.createdAt), desc(auditLogTable.id))
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
