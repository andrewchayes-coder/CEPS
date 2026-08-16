import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, sessionsTable, auditLogTable } from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `me${Date.now().toString(36)}`;

let userId: string;
let userCookie: string;

let otherUserId: string;

beforeAll(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      name: "Me Test User",
      email: `${nonce}-me@test.local`,
      role: "parent_guardian",
    })
    .returning();
  userId = user.id;

  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  userCookie = `ceps_session=${token}`;

  const [other] = await db
    .insert(usersTable)
    .values({
      name: "Other User",
      email: `${nonce}-other@test.local`,
      role: "parent_guardian",
    })
    .returning();
  otherUserId = other.id;
});

afterAll(async () => {
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [userId]));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, userId));
  await db.delete(usersTable).where(inArray(usersTable.id, [userId, otherUserId]));
});

describe("PATCH /auth/me", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await request(app).patch("/api/auth/me").send({ name: "New Name" });
    expect(res.status).toBe(401);
  });

  it("updates display name", async () => {
    const newName = `Updated ${nonce}`;
    const res = await request(app)
      .patch("/api/auth/me")
      .set("Cookie", userCookie)
      .send({ name: newName });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(newName);
    expect(res.body.id).toBe(userId);
    // verify persisted
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(row.name).toBe(newName);
  });

  it("updates email and normalizes to lowercase", async () => {
    const newEmail = `${nonce}-UPDATED@test.local`;
    const res = await request(app)
      .patch("/api/auth/me")
      .set("Cookie", userCookie)
      .send({ email: newEmail });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(newEmail.toLowerCase());
    // GET /auth/me also reflects new email in same session
    const me = await request(app).get("/api/auth/me").set("Cookie", userCookie);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(newEmail.toLowerCase());
  });

  it("returns 409 when email is already used by another account", async () => {
    const res = await request(app)
      .patch("/api/auth/me")
      .set("Cookie", userCookie)
      .send({ email: `${nonce}-other@test.local` });
    expect(res.status).toBe(409);
  });

  it("rejects whitespace-only name", async () => {
    const res = await request(app)
      .patch("/api/auth/me")
      .set("Cookie", userCookie)
      .send({ name: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body has neither name nor email", async () => {
    const res = await request(app)
      .patch("/api/auth/me")
      .set("Cookie", userCookie)
      .send({});
    expect(res.status).toBe(400);
  });

  it("writes an audit log entry", async () => {
    const res = await request(app)
      .patch("/api/auth/me")
      .set("Cookie", userCookie)
      .send({ name: `Audit ${nonce}` });
    expect(res.status).toBe(200);
    const logs = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.userId, userId));
    const entry = logs.find((l) => l.action === "update_self");
    expect(entry).toBeDefined();
  });
});
