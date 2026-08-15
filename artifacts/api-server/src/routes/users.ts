import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
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
  let entries = await db.select().from(auditLogTable).orderBy(desc(auditLogTable.createdAt));
  const { userId, action, entityType, dateFrom, dateTo } = query.data;
  if (userId) entries = entries.filter((e) => e.userId === userId);
  if (action) {
    const needle = action.toLowerCase();
    entries = entries.filter((e) => e.action.toLowerCase().includes(needle));
  }
  if (entityType) {
    const needle = entityType.toLowerCase();
    entries = entries.filter((e) => (e.entityType ?? "").toLowerCase().includes(needle));
  }
  if (dateFrom) {
    const from = new Date(`${dateFrom}T00:00:00Z`).getTime();
    if (!Number.isNaN(from)) entries = entries.filter((e) => e.createdAt != null && e.createdAt.getTime() >= from);
  }
  if (dateTo) {
    const to = new Date(`${dateTo}T23:59:59.999Z`).getTime();
    if (!Number.isNaN(to)) entries = entries.filter((e) => e.createdAt != null && e.createdAt.getTime() <= to);
  }
  entries = entries.slice(0, query.data.limit ?? 500);
  const names = await userNameMap(entries.map((e) => e.userId));
  res.json(
    ListAuditLogResponse.parse(
      entries.map((e) => ({
        id: e.id,
        userId: e.userId,
        userName: e.userId ? (names.get(e.userId) ?? null) : null,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        detail: e.detail,
        createdAt: iso(e.createdAt),
      })),
    ),
  );
});

export default router;
