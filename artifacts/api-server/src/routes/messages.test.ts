import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db, usersTable, sessionsTable, clientsTable, familyRepresentativesTable, auditLogTable,
  messageThreadsTable, messagesTable, messageThreadFamilyMembersTable, messageThreadReadsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `messaging-${Date.now().toString(36)}`;
const ids: Record<string, string> = {}, cookies: Record<string, string> = {};
const clients: string[] = [];
let sequence = 0;
const get = (role: string, path: string, query = {}) => request(app).get(`/api${path}`).set("Cookie", cookies[role]).query(query);
const post = (role: string, path: string, body = {}) => request(app).post(`/api${path}`).set("Cookie", cookies[role]).send(body);
async function create(role = "staff", body = {}, clientId = clients[0]) {
  const response = await post(role, `/clients/${clientId}/message-threads`, {
    subject: `${nonce} subject ${sequence++}`, body: "Opening message",
    familyUserIds: [ids.parent], ...body,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}
beforeAll(async () => {
  for (const [key, role] of Object.entries({
    staff: "staff", staffB: "staff", coordinator: "service_coordinator", coordinatorB: "service_coordinator",
    parent: "parent_guardian", parentB: "parent_guardian", self: "self", outsider: "parent_guardian",
    inactive: "parent_guardian", unlinked: "parent_guardian", vendor: "vendor",
  })) {
    const [user] = await db.insert(usersTable).values({
      name: `${nonce} ${key}`, email: `${nonce}-${key}@test.local`, role, active: key !== "inactive",
    }).returning();
    ids[key] = user.id;
    const token = newToken();
    await db.insert(sessionsTable).values({ userId: user.id, token, expiresAt: new Date(Date.now() + 3600000) });
    cookies[key] = `ceps_session=${token}`;
  }
  for (let i = 0; i < 3; i++) {
    const [client] = await db.insert(clientsTable).values({
      firstName: "Messaging", lastName: `${nonce}-${i}`, dateOfBirth: "2000-01-01",
      uciNumber: `${nonce}-${i}`, assignedCoordinatorId: i === 1 ? ids.coordinatorB : ids.coordinator,
    }).returning();
    clients.push(client.id);
  }
  await db.update(usersTable).set({ linkedRecordType: "client", linkedRecordId: clients[0] })
    .where(inArray(usersTable.id, [ids.parent, ids.parentB, ids.self, ids.inactive]));
  await db.update(usersTable).set({ linkedRecordType: "client", linkedRecordId: clients[1] }).where(eq(usersTable.id, ids.outsider));
  await db.insert(familyRepresentativesTable).values([
    { clientId: clients[0], userId: ids.parent, name: `${nonce} Representative`, relationship: "guardian" },
    { clientId: clients[0], name: `${nonce} No portal`, relationship: "parent" },
    { clientId: clients[0], name: `${nonce} Deleted rep`, isDeleted: true },
  ]);
});
afterAll(async () => {
  if (clients.length) {
    const threads = await db.select({ id: messageThreadsTable.id }).from(messageThreadsTable).where(inArray(messageThreadsTable.clientId, clients));
    if (threads.length) {
      const threadIds = threads.map(t => t.id);
      await db.delete(messageThreadReadsTable).where(inArray(messageThreadReadsTable.threadId, threadIds));
      await db.delete(messageThreadFamilyMembersTable).where(inArray(messageThreadFamilyMembersTable.threadId, threadIds));
      await db.delete(messagesTable).where(inArray(messagesTable.threadId, threadIds));
      await db.delete(messageThreadsTable).where(inArray(messageThreadsTable.id, threadIds));
    }
    await db.delete(auditLogTable).where(and(eq(auditLogTable.entityType, "message_thread"), inArray(auditLogTable.entityId, clients)));
    await db.delete(familyRepresentativesTable).where(inArray(familyRepresentativesTable.clientId, clients));
    await db.delete(clientsTable).where(inArray(clientsTable.id, clients));
  }
  if (Object.values(ids).length) {
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, Object.values(ids)));
    await db.delete(usersTable).where(inArray(usersTable.id, Object.values(ids)));
  }
});

describe("messaging API", () => {
  it("returns only eligible portal users, representative names/relationships and separate no-portal representatives", async () => {
    for (const role of ["staff", "coordinator", "parent", "self"]) {
      const response = await get(role, `/clients/${clients[0]}/message-recipients`);
      expect(response.status).toBe(200);
      expect(response.body.coordinator.userId).toBe(ids.coordinator);
      expect(response.body.family.map((p: { userId: string }) => p.userId).sort()).toEqual([ids.parent, ids.parentB, ids.self].sort());
      expect(response.body.family.find((p: { userId: string }) => p.userId === ids.parent)).toMatchObject({ name: `${nonce} Representative`, relationship: "guardian" });
      expect(response.body.family.find((p: { userId: string }) => p.userId === ids.self).relationship).toBeNull();
      expect(response.body.familyWithoutPortal.map((p: { name: string }) => p.name)).toEqual([`${nonce} No portal`]);
    }
    expect((await get("coordinatorB", `/clients/${clients[0]}/message-recipients`)).status).toBe(404);
    expect((await get("outsider", `/clients/${clients[0]}/message-recipients`)).status).toBe(404);
    expect((await get("unlinked", `/clients/${clients[0]}/message-recipients`)).status).toBe(404);
  });

  it("shares staff inbox threads while keeping each staff user's unread state separate, without read audits", async () => {
    const created = await create();
    const threadId = created.thread.id;
    expect(created.thread).toMatchObject({ unread: false, messageCount: 1, includeCoordinator: true });
    expect(created.thread.familyMemberNames).toContain(`${nonce} Representative`);
    expect((await get("staffB", "/messages/threads", { clientId: clients[0], search: created.thread.subject, view: "unread" })).body.total).toBe(1);
    const auditBefore = await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, clients[0]));
    expect((await post("staffB", `/messages/threads/${threadId}/read`)).status).toBe(200);
    expect((await get("staffB", `/messages/threads/${threadId}`)).body.thread.unread).toBe(false);
    expect(await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, clients[0]))).toHaveLength(auditBefore.length);
    expect((await post("coordinator", `/messages/threads/${threadId}/messages`, { body: "Reply to both staff members" })).status).toBe(201);
    for (const role of ["staff", "staffB"]) expect((await get(role, `/messages/threads/${threadId}`)).body.thread.unread).toBe(true);
    await post("staff", `/messages/threads/${threadId}/read`);
    expect((await get("staff", `/messages/threads/${threadId}`)).body.thread.unread).toBe(false);
    expect((await get("staffB", `/messages/threads/${threadId}`)).body.thread.unread).toBe(true);
    const audit = auditBefore.find(row => row.detail?.includes(threadId));
    expect(audit).toMatchObject({ action: "create_message_thread", entityType: "message_thread", entityId: clients[0] });
    expect(audit?.detail).toContain(`To: ${nonce} coordinator, ${nonce} Representative`);
  });

  it("transfers coordinator history on reassignment and never exposes coordinator-excluded threads", async () => {
    const { thread } = await create();
    expect((await get("coordinator", `/messages/threads/${thread.id}`)).status).toBe(200);
    expect((await get("coordinatorB", `/messages/threads/${thread.id}`)).status).toBe(404);
    await db.update(clientsTable).set({ assignedCoordinatorId: ids.coordinatorB }).where(eq(clientsTable.id, clients[0]));
    try {
      expect((await get("coordinator", `/messages/threads/${thread.id}`)).status).toBe(404);
      expect((await get("coordinatorB", `/messages/threads/${thread.id}`)).status).toBe(200);
      expect((await post("coordinator", `/messages/threads/${thread.id}/messages`, { body: "Not my case anymore" })).status).toBe(404);
    } finally {
      await db.update(clientsTable).set({ assignedCoordinatorId: ids.coordinator }).where(eq(clientsTable.id, clients[0]));
    }
    const excluded = await create("staff", { includeCoordinator: false });
    expect((await get("coordinator", `/messages/threads/${excluded.thread.id}`)).status).toBe(404);
    expect((await get("coordinator", "/messages/threads", { clientId: clients[0], search: excluded.thread.subject })).body.total).toBe(0);
    expect((await post("coordinator", `/messages/threads/${excluded.thread.id}/family-members`, { userIds: [ids.self] })).status).toBe(404);
    const own = await create("coordinator", { includeCoordinator: false, familyUserIds: [] });
    expect(own.thread.includeCoordinator).toBe(true);
  });

  it("enforces family membership and linkage on every read and reply, including hostile filters", async () => {
    const { thread } = await create();
    expect((await get("parent", `/messages/threads/${thread.id}`)).status).toBe(200);
    const reply = await post("parent", `/messages/threads/${thread.id}/messages`, {
      body: "  <b>Permanent plain text</b>  ", clientId: clients[1], authorUserId: ids.staff,
    });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ body: "<b>Permanent plain text</b>", isMine: true, author: { userId: ids.parent } });
    const [row] = await db.select().from(messagesTable).where(eq(messagesTable.id, reply.body.id));
    expect(row.clientId).toBe(clients[0]);
    for (const role of ["parentB", "self", "outsider", "unlinked", "coordinatorB"]) {
      expect((await get(role, `/messages/threads/${thread.id}`)).status).toBe(404);
      expect((await post(role, `/messages/threads/${thread.id}/messages`, { body: "Not allowed" })).status).toBe(404);
      expect((await post(role, `/messages/threads/${thread.id}/read`)).status).toBe(404);
      expect((await get(role, "/messages/threads", { clientId: clients[0], search: thread.subject, view: "all", range: "recent" })).body.total).toBe(0);
    }
    await db.update(usersTable).set({ linkedRecordId: clients[1] }).where(eq(usersTable.id, ids.parent));
    expect((await get("parent", `/messages/threads/${thread.id}`)).status).toBe(404);
    await db.update(usersTable).set({ linkedRecordId: clients[0] }).where(eq(usersTable.id, ids.parent));
    expect((await get("inactive", "/messages/threads")).status).toBe(401);
  });

  it.each(["parent", "self"])("%s can start a staff-visible thread with coordinator included and automatic author membership", async (role) => {
    const result = await create(role, { familyUserIds: [] });
    expect(result.thread.includeCoordinator).toBe(true);
    expect(result.thread.unread).toBe(false);
    expect((await get("staffB", `/messages/threads/${result.thread.id}`)).body.thread.unread).toBe(true);
    expect((await get("coordinator", `/messages/threads/${result.thread.id}`)).status).toBe(200);
    expect((await get(role, `/messages/threads/${result.thread.id}`)).status).toBe(200);
    const members = await db.select().from(messageThreadFamilyMembersTable).where(eq(messageThreadFamilyMembersTable.threadId, result.thread.id));
    expect(members.map(m => m.userId)).toEqual([ids[role]]);
  });

  it("allows staff/coordinator to add validated family members, never family users, with no duplicate membership", async () => {
    const { thread } = await create();
    expect((await post("parent", `/messages/threads/${thread.id}/family-members`, { userIds: [ids.parentB] })).status).toBe(403);
    const added = await post("coordinator", `/messages/threads/${thread.id}/family-members`, { userIds: [ids.self, ids.self] });
    expect(added.status).toBe(200);
    expect((await get("self", `/messages/threads/${thread.id}`)).status).toBe(200);
    expect((await post("staffB", `/messages/threads/${thread.id}/family-members`, { userIds: [ids.parentB] })).status).toBe(200);
    expect((await get("parentB", `/clients/${clients[0]}/message-threads`, { search: thread.subject })).body.total).toBe(1);
    const audit = await db.select().from(auditLogTable).where(and(eq(auditLogTable.entityId, clients[0]), eq(auditLogTable.action, "update_message_thread_members")));
    expect(audit.some(a => a.detail?.includes(thread.id))).toBe(true);
  });

  it("rejects invalid recipients atomically and requires an actual coordinator or family recipient for staff", async () => {
    const { thread } = await create();
    for (const invalid of [ids.outsider, ids.inactive, ids.vendor, ids.unlinked, ids.staff]) {
      const response = await post("staff", `/clients/${clients[0]}/message-threads`, { subject: "Invalid", body: "Must not commit", familyUserIds: [ids.parent, invalid] });
      expect(response.status).toBe(400);
      expect((await post("staff", `/messages/threads/${thread.id}/family-members`, { userIds: [ids.parentB, invalid] })).status).toBe(400);
    }
    expect((await get("parentB", `/messages/threads/${thread.id}`)).status).toBe(404);
    const empty = await post("staff", `/clients/${clients[0]}/message-threads`, { subject: "No one", body: "Nobody", includeCoordinator: false, familyUserIds: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("Choose who this message is to");
    expect((await post("unlinked", `/clients/${clients[0]}/message-threads`, { subject: "Wrong", body: "No" })).status).toBe(404);
    expect((await post("coordinatorB", `/clients/${clients[0]}/message-threads`, { subject: "Wrong", body: "No" })).status).toBe(404);
  });

  it("denies vendors on every messaging route and requires authentication", async () => {
    const { thread } = await create();
    const paths = [
      ["get", "/messages/threads"], ["get", "/messages/unread-count"],
      ["get", `/clients/${clients[0]}/message-recipients`], ["get", `/clients/${clients[0]}/message-threads`],
      ["post", `/clients/${clients[0]}/message-threads`], ["get", `/messages/threads/${thread.id}`],
      ["post", `/messages/threads/${thread.id}/messages`], ["post", `/messages/threads/${thread.id}/read`],
      ["post", `/messages/threads/${thread.id}/family-members`],
    ];
    for (const [method, path] of paths) {
      expect((await (method === "get" ? get("vendor", path) : post("vendor", path))).status).toBe(403);
      expect((await (method === "get" ? request(app).get(`/api${path}`) : request(app).post(`/api${path}`))).status).toBe(401);
    }
  });

  it("supports recent/archive and date bounds overriding the range", async () => {
    const { thread } = await create();
    const old = new Date(Date.now() - 210 * 86400000);
    await db.update(messageThreadsTable).set({ lastMessageAt: old }).where(eq(messageThreadsTable.id, thread.id));
    const query = { clientId: clients[0], search: thread.subject };
    expect((await get("staff", "/messages/threads", query)).body.total).toBe(0);
    expect((await get("staff", "/messages/threads", { ...query, range: "archive" })).body.total).toBe(1);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(old);
    expect((await get("staff", "/messages/threads", { ...query, range: "recent", dateFrom: day, dateTo: day })).body.total).toBe(1);
    expect((await get("staff", `/clients/${clients[0]}/message-threads`, { search: thread.subject, range: "archive" })).body.total).toBe(1);
  });

  it.each([
    ["2026-02-01T07:30:00Z", "2026-01-31", "2026-02-01"],
    ["2026-08-01T06:30:00Z", "2026-07-31", "2026-08-01"],
  ])("uses inclusive Pacific calendar days across month boundaries and DST: %s", async (instant, pacificDay, utcDay) => {
    const { thread } = await create();
    await db.update(messageThreadsTable).set({ lastMessageAt: new Date(instant) }).where(eq(messageThreadsTable.id, thread.id));
    const query = { clientId: clients[0], search: thread.subject, range: "archive" };
    expect((await get("staff", "/messages/threads", { ...query, dateFrom: pacificDay, dateTo: pacificDay })).body.total).toBe(1);
    expect((await get("staff", "/messages/threads", { ...query, dateFrom: utcDay, dateTo: utcDay })).body.total).toBe(0);
    expect((await get("staff", `/clients/${clients[0]}/message-threads`, { search: thread.subject, dateFrom: pacificDay, dateTo: pacificDay })).body.total).toBe(1);
  });

  it("searches subject, any message body, and participant name with literal %, _ and backslash", async () => {
    const special = await create("staff", { subject: `${nonce} SpecialNeedle`, body: "History special 85% part_under \\literal" });
    await post("staff", `/messages/threads/${special.thread.id}/messages`, { body: "Newest preview is not the matching body" });
    const plain = await create("staff", { body: "History plain 850 partXunder Xliteral" });
    for (const search of ["SpecialNeedle", "85%", "part_under", "\\literal"]) {
      const response = await get("staff", "/messages/threads", { clientId: clients[0], search });
      expect(response.status).toBe(200);
      expect(response.body.items.map((t: { id: string }) => t.id)).toContain(special.thread.id);
      expect(response.body.items.map((t: { id: string }) => t.id)).not.toContain(plain.thread.id);
    }
    const byName = await get("coordinator", "/messages/threads", { search: `${nonce}-0`, clientId: clients[0] });
    expect(byName.body.items.some((t: { id: string }) => t.id === special.thread.id)).toBe(true);
    expect((await get("parentB", "/messages/threads", { search: "SpecialNeedle", clientId: clients[0] })).body.total).toBe(0);
  });

  it("paginates 120 equal-microsecond timestamps as 50, 50, 20 without loss or duplicates", async () => {
    const { thread } = await create();
    const instant = sql`'2026-10-17T12:00:00.123456Z'::timestamptz`;
    await db.update(messagesTable).set({ createdAt: instant }).where(eq(messagesTable.threadId, thread.id));
    await db.insert(messagesTable).values(Array.from({ length: 119 }, (_, n) => ({
      threadId: thread.id, clientId: clients[0], authorUserId: ids.staff, body: `Page message ${n}`, createdAt: instant,
    })));
    await db.update(messageThreadsTable).set({ messageCount: 120, lastMessageAt: instant }).where(eq(messageThreadsTable.id, thread.id));
    const first = await get("staff", `/messages/threads/${thread.id}`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.messages).toHaveLength(50);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor.before).toContain(".123456Z");
    const second = await get("staff", `/messages/threads/${thread.id}`, first.body.nextCursor);
    expect(second.body.messages).toHaveLength(50);
    expect(second.body.hasMore).toBe(true);
    const third = await get("staff", `/messages/threads/${thread.id}`, second.body.nextCursor);
    expect(third.body.messages).toHaveLength(20);
    expect(third.body).toMatchObject({ hasMore: false, nextCursor: null });
    expect(new Set([...first.body.messages, ...second.body.messages, ...third.body.messages].map((m: { id: string }) => m.id)).size).toBe(120);
  });

  it("supports assignment views without widening role scope, full totals, and stable inbox pagination", async () => {
    const assigned = await create();
    await db.update(messageThreadsTable).set({ assigneeUserId: ids.staffB, assignedBy: ids.staff, assignedAt: new Date() }).where(eq(messageThreadsTable.id, assigned.thread.id));
    const page = await get("staffB", "/messages/threads", { clientId: clients[0], view: "assigned_to_me", limit: 1 });
    expect(page.body.total).toBe(1);
    expect(page.body.items[0].assignee).toEqual({ userId: ids.staffB, name: `${nonce} staffB` });
    expect((await get("staff", "/messages/threads", { clientId: clients[0], view: "assigned_to_me" })).body.total).toBe(0);
    expect((await get("outsider", "/messages/threads", { clientId: clients[0], view: "unassigned" })).body.total).toBe(0);
    const list = await get("staff", "/messages/threads", { clientId: clients[0], limit: 1 });
    const next = await get("staff", "/messages/threads", { clientId: clients[0], limit: 1, offset: 1 });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.total).toBeGreaterThan(1);
    expect(next.body.total).toBe(list.body.total);
    expect(next.body.items[0].id).not.toBe(list.body.items[0].id);
  });

  it("matches unread-count to the recent unread inbox total in exactly one message query", async () => {
    for (const role of ["staff", "staffB", "coordinator", "parent", "self", "outsider"]) {
      const inbox = await get(role, "/messages/threads", { view: "unread" });
      const spy = vi.spyOn(db, "execute");
      try {
        const count = await get(role, "/messages/unread-count");
        expect(count.status).toBe(200);
        expect(count.body.count).toBe(inbox.body.total);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally { spy.mockRestore(); }
    }
  });

  it("serializes concurrent replies, exact counts, read state, preview, and audit rows", async () => {
    const { thread } = await create();
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      post("parent", `/messages/threads/${thread.id}/messages`, { body: `Concurrent ${i} ${"a".repeat(180)}` })));
    expect(replies.map(r => r.status)).toEqual(Array(8).fill(201));
    const detail = await get("staff", `/messages/threads/${thread.id}`);
    expect(detail.body.thread.messageCount).toBe(9);
    expect(detail.body.messages).toHaveLength(9);
    expect(detail.body.thread.lastMessagePreview).toBe(detail.body.messages[0].body.slice(0, 140));
    expect(detail.body.thread.lastMessageByName).toBe(`${nonce} parent`);
    expect((await get("parent", `/messages/threads/${thread.id}`)).body.thread.unread).toBe(false);
    const audits = await db.select().from(auditLogTable).where(and(eq(auditLogTable.entityId, clients[0]), eq(auditLogTable.action, "send_message")));
    expect(audits.filter(a => a.detail?.includes(thread.id))).toHaveLength(8);
  });

  it("validates whitespace, lengths, UUIDs, dates, cursor combinations, and has no edit/delete routes", async () => {
    const { thread, messages } = await create("staff", { subject: "  Trim subject  ", body: "  Trim body  " });
    expect(thread.subject).toBe("Trim subject");
    expect(messages[0].body).toBe("Trim body");
    for (const body of ["", " \n ", "x".repeat(5001)]) {
      expect((await post("staff", `/messages/threads/${thread.id}/messages`, { body })).status).toBe(400);
    }
    for (const subject of ["", " \n ", "x".repeat(201)]) {
      expect((await post("staff", `/clients/${clients[0]}/message-threads`, { subject, body: "Valid" })).status).toBe(400);
    }
    expect((await get("staff", "/messages/threads", { dateFrom: "2026-02-30" })).status).toBe(400);
    expect((await get("staff", "/messages/threads", { dateFrom: "2026-10-05", dateTo: "2026-10-01" })).status).toBe(400);
    expect((await get("staff", `/messages/threads/${thread.id}`, { beforeId: messages[0].id })).status).toBe(400);
    expect((await get("staff", `/messages/threads/${thread.id}`, { before: "nonsense" })).status).toBe(400);
    expect((await get("staff", "/messages/threads", { clientId: "not-uuid" })).status).toBe(400);
    for (const path of [`/messages/threads/${thread.id}`, `/messages/threads/${thread.id}/messages/${messages[0].id}`]) {
      expect((await request(app).patch(`/api${path}`).set("Cookie", cookies.staff).send({ body: "Changed" })).status).toBe(404);
      expect((await request(app).delete(`/api${path}`).set("Cookie", cookies.staff)).status).toBe(404);
    }
  });

  it("keeps deleted participant history staff-only and blocks new threads and replies", async () => {
    const { thread } = await create("staff", { familyUserIds: [] }, clients[2]);
    await db.update(clientsTable).set({ isDeleted: true }).where(eq(clientsTable.id, clients[2]));
    expect((await get("staffB", `/messages/threads/${thread.id}`)).status).toBe(200);
    expect((await get("staff", "/messages/threads", { clientId: clients[2] })).body.total).toBe(1);
    expect((await get("coordinator", `/messages/threads/${thread.id}`)).status).toBe(404);
    expect((await get("coordinator", "/messages/threads", { clientId: clients[2] })).body.total).toBe(0);
    expect((await get("coordinator", `/clients/${clients[2]}/message-threads`)).status).toBe(404);
    expect((await post("staff", `/clients/${clients[2]}/message-threads`, { subject: "Blocked", body: "Blocked" })).status).toBe(409);
    expect((await post("staff", `/messages/threads/${thread.id}/messages`, { body: "Blocked" })).status).toBe(409);
  });
});
