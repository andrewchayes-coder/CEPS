import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, clientsTable, clientNotesTable, usersTable, sessionsTable,
  auditLogTable, staffRolesTable, staffRolePermissionsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `notes-${Date.now().toString(36)}`;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};
let clientId: string;
let otherClientId: string;
let roleId: string;
let staffNoteId: string;
let coordinatorNoteId: string;

beforeAll(async () => {
  const [role] = await db.insert(staffRolesTable).values({ name: `${nonce}-admin` }).returning();
  roleId = role.id;
  await db.insert(staffRolePermissionsTable).values({ roleId, permission: "manage_users" });
  for (const [key, role] of Object.entries({
    staff: "staff", otherStaff: "staff", admin: "staff", coordinator: "service_coordinator",
    otherCoordinator: "service_coordinator", parent: "parent_guardian", self: "self", vendor: "vendor",
  })) {
    const [user] = await db.insert(usersTable).values({
      name: `${nonce}-${key}`, email: `${nonce}-${key}@test.local`, role,
      staffRoleId: key === "admin" ? roleId : null,
    }).returning();
    ids[key] = user.id;
    const token = newToken();
    await db.insert(sessionsTable).values({ userId: user.id, token, expiresAt: new Date(Date.now() + 3600000) });
    cookies[key] = `ceps_session=${token}`;
  }
  const [client] = await db.insert(clientsTable).values({
    firstName: "Note", lastName: "Fixture", dateOfBirth: "2000-01-01",
    uciNumber: nonce, assignedCoordinatorId: ids.coordinator,
  }).returning();
  clientId = client.id;
  const [other] = await db.insert(clientsTable).values({
    firstName: "Other", lastName: "Fixture", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-other`,
  }).returning();
  otherClientId = other.id;
  await db.update(usersTable).set({ linkedRecordType: "client", linkedRecordId: clientId })
    .where(inArray(usersTable.id, [ids.parent, ids.self]));
});

afterAll(async () => {
  if (clientId) {
    await db.delete(auditLogTable).where(and(eq(auditLogTable.entityType, "client_note"), inArray(auditLogTable.entityId, [clientId, otherClientId])));
    await db.delete(clientNotesTable).where(inArray(clientNotesTable.clientId, [clientId, otherClientId]));
    await db.delete(clientsTable).where(inArray(clientsTable.id, [clientId, otherClientId]));
  }
  if (Object.values(ids).length) {
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, Object.values(ids)));
    await db.delete(usersTable).where(inArray(usersTable.id, Object.values(ids)));
  }
  if (roleId) {
    await db.delete(staffRolePermissionsTable).where(eq(staffRolePermissionsTable.roleId, roleId));
    await db.delete(staffRolesTable).where(eq(staffRolesTable.id, roleId));
  }
});

const url = (noteId?: string, participantId = clientId) =>
  `/api/clients/${participantId}/notes${noteId ? `/${noteId}` : ""}`;
const add = (who: string, body: unknown) => request(app).post(url()).set("Cookie", cookies[who]).send({ body });
const list = (who: string) => request(app).get(url()).set("Cookie", cookies[who]);
const edit = (who: string, noteId: string, body: unknown) =>
  request(app).patch(url(noteId)).set("Cookie", cookies[who]).send({ body });
const remove = (who: string, noteId: string) =>
  request(app).delete(url(noteId)).set("Cookie", cookies[who]);

describe("Participant notes access and persistence", () => {
  it("staff and assigned coordinator add, trim, and see each other's notes with server-owned stamps", async () => {
    const staff = await request(app).post(url()).set("Cookie", cookies.staff).send({
      body: "  Staff context\nSecond line  ", createdBy: ids.otherStaff, createdAt: "2000-01-01",
    });
    expect(staff.status).toBe(201);
    staffNoteId = staff.body.id;
    expect(staff.body).toMatchObject({
      body: "Staff context\nSecond line", authorName: `${nonce}-staff`, authorRole: "staff",
      canEdit: true, canDelete: true, updatedAt: null, updatedByName: null,
    });
    expect(new Date(staff.body.createdAt).getTime()).toBeGreaterThan(Date.now() - 60000);
    const coordinator = await add("coordinator", "Coordinator context");
    expect(coordinator.status).toBe(201);
    coordinatorNoteId = coordinator.body.id;
    for (const who of ["staff", "coordinator", "admin"]) {
      const result = await list(who);
      expect(result.status).toBe(200);
      expect(result.body).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: staffNoteId, authorRole: "staff", canEdit: who === "staff", canDelete: who === "staff" || who === "admin" }),
        expect.objectContaining({ id: coordinatorNoteId, authorRole: "service_coordinator", canEdit: who === "coordinator", canDelete: who === "coordinator" || who === "admin" }),
      ]));
    }
    const [audit] = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.action, "create_client_note"), eq(auditLogTable.entityId, clientId), eq(auditLogTable.userId, ids.staff),
    ));
    expect(audit.entityType).toBe("client_note");
    expect(audit.detail).toBe(`Note ${staffNoteId}\nStaff context\nSecond line`);
  });

  for (const who of ["otherCoordinator", "parent", "self", "vendor"]) {
    it(`${who} is forbidden on every notes endpoint`, async () => {
      expect((await list(who)).status).toBe(403);
      expect((await add(who, "not permitted")).status).toBe(403);
      expect((await edit(who, staffNoteId, "not permitted")).status).toBe(403);
      expect((await remove(who, staffNoteId)).status).toBe(403);
    });
  }

  it("only the author edits, including denial to other staff and manage-users staff", async () => {
    for (const who of ["otherStaff", "admin", "coordinator"]) {
      expect((await edit(who, staffNoteId, "not permitted")).status).toBe(403);
    }
    await db.update(clientNotesTable).set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(clientNotesTable.id, coordinatorNoteId));
    const result = await edit("coordinator", coordinatorNoteId, "  Edited years later\nStill shared  ");
    expect(result.status).toBe(200);
    expect(result.body.body).toBe("Edited years later\nStill shared");
    expect(result.body.updatedByName).toBe(`${nonce}-coordinator`);
    expect(result.body.updatedAt).not.toBeNull();
    const [row] = await db.select().from(clientNotesTable).where(eq(clientNotesTable.id, coordinatorNoteId));
    expect(row.updatedBy).toBe(ids.coordinator);
    expect(row.createdAt.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("every edit records the entire before/after text without truncation", async () => {
    const old = `Old "${"a".repeat(4986)}"\nEnd`;
    const next = `New "${"b".repeat(4986)}"\nEnd`;
    const created = await add("staff", old);
    expect(created.status).toBe(201);
    expect((await edit("staff", created.body.id, next)).status).toBe(200);
    expect((await edit("staff", created.body.id, "Third version")).status).toBe(200);
    const audits = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.action, "update_client_note"), eq(auditLogTable.entityId, clientId),
    ));
    expect(audits.map(a => a.detail)).toEqual(expect.arrayContaining([
      `Note ${created.body.id}\nBefore: "${old}" → After: "${next}"`,
      `Note ${created.body.id}\nBefore: "${next}" → After: "Third version"`,
    ]));
  });

  for (const body of ["", " \n\t ", "x".repeat(5001), null, 7]) {
    it(`rejects invalid body ${typeof body === "string" ? `length ${body.length}` : String(body)} on add and edit`, async () => {
      expect((await add("staff", body)).status).toBe(400);
      expect((await edit("staff", staffNoteId, body)).status).toBe(400);
    });
  }

  it("accepts exactly 5000 characters after trimming", async () => {
    const result = await add("staff", `  ${"x".repeat(5000)}  `);
    expect(result.status).toBe(201);
    expect(result.body.body.length).toBe(5000);
  });

  it("list is newest-first by creation, not by edit time", async () => {
    const result = await list("staff");
    expect(result.status).toBe(200);
    const times = result.body.map((n: { createdAt: string }) => new Date(n.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(result.body.at(-1).id).toBe(coordinatorNoteId);
  });

  it("ordinary staff cannot delete another author's note", async () => {
    expect((await remove("otherStaff", staffNoteId)).status).toBe(403);
    expect((await remove("coordinator", staffNoteId)).status).toBe(403);
  });

  it("author and manage-users staff soft delete, retaining text and auditing each deletion", async () => {
    expect((await remove("coordinator", coordinatorNoteId)).status).toBe(204);
    expect((await remove("admin", staffNoteId)).status).toBe(204);
    for (const [noteId, deletedBy] of [[coordinatorNoteId, ids.coordinator], [staffNoteId, ids.admin]]) {
      const [note] = await db.select().from(clientNotesTable).where(eq(clientNotesTable.id, noteId));
      expect(note.isDeleted).toBe(true);
      expect(note.deletedBy).toBe(deletedBy);
      expect(note.deletedAt).not.toBeNull();
      expect(note.body.length).toBeGreaterThan(0);
      const [audit] = await db.select().from(auditLogTable).where(and(
        eq(auditLogTable.action, "delete_client_note"), eq(auditLogTable.entityId, clientId), eq(auditLogTable.userId, deletedBy),
      ));
      expect(audit.detail).toBe(`Note ${noteId}\n${note.body}`);
      expect((await edit("staff", noteId, "cannot restore")).status).toBe(404);
      expect((await remove("admin", noteId)).status).toBe(404);
    }
    const result = await list("staff");
    expect(result.body.some((n: { id: string }) => [coordinatorNoteId, staffNoteId].includes(n.id))).toBe(false);
  });

  it("cross-participant note IDs never resolve", async () => {
    const created = await add("staff", "Bound to one participant");
    expect((await request(app).patch(url(created.body.id, otherClientId)).set("Cookie", cookies.staff).send({ body: "wrong" })).status).toBe(404);
    expect((await request(app).delete(url(created.body.id, otherClientId)).set("Cookie", cookies.admin)).status).toBe(404);
  });

  it("malformed IDs return 400 and unauthenticated callers return 401", async () => {
    expect((await request(app).get("/api/clients/not-a-uuid/notes").set("Cookie", cookies.staff)).status).toBe(400);
    expect((await request(app).get(url())).status).toBe(401);
  });

  it("assignment changes revoke coordinator access to their own existing notes", async () => {
    const created = await add("coordinator", "Before reassignment");
    expect(created.status).toBe(201);
    await db.update(clientsTable).set({ assignedCoordinatorId: ids.otherCoordinator }).where(eq(clientsTable.id, clientId));
    try {
      expect((await list("coordinator")).status).toBe(403);
      expect((await edit("coordinator", created.body.id, "no longer allowed")).status).toBe(403);
      expect((await remove("coordinator", created.body.id)).status).toBe(403);
      expect((await list("otherCoordinator")).status).toBe(200);
    } finally {
      await db.update(clientsTable).set({ assignedCoordinatorId: ids.coordinator }).where(eq(clientsTable.id, clientId));
    }
  });

  it("deleted participants do not expose notes", async () => {
    await db.update(clientsTable).set({ isDeleted: true }).where(eq(clientsTable.id, clientId));
    try { expect((await list("staff")).status).toBe(404); }
    finally { await db.update(clientsTable).set({ isDeleted: false }).where(eq(clientsTable.id, clientId)); }
  });
});
