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
let coordUserId: string;
let staffUserId: string;
let clientA: string; // parent's linked client
let clientB: string; // another client
let parentCookie: string;
let staffCookie: string;

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

  const [coord] = await db
    .insert(usersTable)
    .values({
      name: "FE Coordinator",
      email: `${nonce}-coord@test.local`,
      phone: "(916) 555-0042",
      role: "service_coordinator",
    })
    .returning();
  coordUserId = coord.id;
  await db.update(clientsTable).set({ assignedCoordinatorId: coordUserId }).where(inArray(clientsTable.id, [clientA]));

  const [staff] = await db
    .insert(usersTable)
    .values({
      name: "FE Staff",
      email: `${nonce}-staff@test.local`,
      role: "staff",
    })
    .returning();
  staffUserId = staff.id;
  staffCookie = await session(staffUserId);

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
  const userIds = [parentUserId, coordUserId, staffUserId];
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, userIds));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, userIds));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
  await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

describe("GET /clients/:id/case coordinator contact disclosure", () => {
  it("includes coordinator email/phone for the family user", async () => {
    const res = await request(app).get(`/api/clients/${clientA}/case`).set("Cookie", parentCookie);
    expect(res.status).toBe(200);
    expect(res.body.client.assignedCoordinatorName).toBe("FE Coordinator");
    expect(res.body.client.assignedCoordinatorEmail).toBe(`${nonce}-coord@test.local`);
    expect(res.body.client.assignedCoordinatorPhone).toBe("(916) 555-0042");
  });

  it("omits coordinator email/phone for non-family roles", async () => {
    const res = await request(app).get(`/api/clients/${clientA}/case`).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    expect(res.body.client.assignedCoordinatorName).toBe("FE Coordinator");
    expect(res.body.client.assignedCoordinatorEmail).toBeNull();
    expect(res.body.client.assignedCoordinatorPhone).toBeNull();
  });
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
