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
import { userJson, userNameMap } from "../lib/serializers";

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
  const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  await audit(req.user!.id, "update_user", "user", user.id);
  res.json(UpdateUserResponse.parse(userJson(user)));
});

router.get("/audit-log", requireStaff, async (req, res): Promise<void> => {
  const query = ListAuditLogQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  let q = db.select().from(auditLogTable).orderBy(desc(auditLogTable.createdAt)).limit(query.data.limit ?? 100);
  let entries = await q;
  if (query.data.userId) entries = entries.filter((e) => e.userId === query.data.userId);
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
