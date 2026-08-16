import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db, usersTable, sessionsTable, clientsTable, auditLogTable } from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// PATCH /clients/:id family-role rules: a parent_guardian (or self) may edit
// ONLY contact/spelling fields on ONLY their own linked client.
const nonce = `clfe${Date.now().toString(36)}`;

let parentUserId: string;
let clientA: string; // parent's linked client
let clientB: string; // another client
let parentCookie: string;

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

beforeAll(async () => {
  const [a] = await db
    .insert(clientsTable)
    .values({
      firstName: "FE-Kid",
      lastName: nonce,
      dateOfBirth: "2015-01-01",
      uciNumber: `${nonce}-A`,
      status: "active",
    })
    .returning();
  clientA = a.id;
  const [b] = await db
    .insert(clientsTable)
    .values({
      firstName: "FE-Other",
      lastName: nonce,
      dateOfBirth: "2015-01-01",
      uciNumber: `${nonce}-B`,
      status: "active",
    })
    .returning();
  clientB = b.id;

  const [parent] = await db
    .insert(usersTable)
    .values({
      name: "FE Parent",
      email: `${nonce}-parent@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientA,
    })
    .returning();
  parentUserId = parent.id;
  parentCookie = await session(parentUserId);
});

afterAll(async () => {
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [parentUserId]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [parentUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [parentUserId]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
});

describe("PATCH /clients/:id as parent_guardian", () => {
  it("updates contact/spelling fields on the linked client", async () => {
    const res = await request(app)
      .patch(`/api/clients/${clientA}`)
      .set("Cookie", parentCookie)
      .send({ lastName: `${nonce}-Fixed`, phone: "(916) 555-0000", familyRepPhone: "(916) 555-0001" });
    expect(res.status).toBe(200);
    expect(res.body.lastName).toBe(`${nonce}-Fixed`);
    expect(res.body.phone).toBe("(916) 555-0000");
  });

  it("rejects case-management fields with 403", async () => {
    const res = await request(app)
      .patch(`/api/clients/${clientA}`)
      .set("Cookie", parentCookie)
      .send({ status: "closed" });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("status");
  });

  it("cannot edit a client that is not their own", async () => {
    const res = await request(app)
      .patch(`/api/clients/${clientB}`)
      .set("Cookie", parentCookie)
      .send({ phone: "(916) 555-9999" });
    expect(res.status).toBe(403);
  });
});
