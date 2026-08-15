import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  authorizationsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// SQL-level list pagination + role scoping for GET /clients (Prompt 6).
// Mirrors the payments/referrals list-test conventions: unique per-run nonce,
// self-cleaning, asserts on the { items, total } envelope.
const nonce = `clls${Date.now().toString(36)}`;

let staffId: string;
let coordId: string;
let otherCoordId: string;
let vendorUserId: string;
let parentUserId: string;
let vendorId: string;
let clientA: string; // parent user's linked client, coordId-assigned, has vendor auth
let clientB: string; // otherCoord-assigned, no vendor auth
let staffCookie: string;
let coordCookie: string;
let vendorCookie: string;
let parentCookie: string;

const createdAuthIds: string[] = [];

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

async function get(cookie: string, qs: Record<string, string | number>) {
  return request(app).get("/api/clients").query(qs).set("Cookie", cookie);
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "CL Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [coord] = await db
    .insert(usersTable)
    .values({ name: "CL Coord", email: `${nonce}-coord@test.local`, role: "service_coordinator" })
    .returning();
  coordId = coord.id;
  const [otherCoord] = await db
    .insert(usersTable)
    .values({ name: "CL OtherCoord", email: `${nonce}-coord2@test.local`, role: "service_coordinator" })
    .returning();
  otherCoordId = otherCoord.id;

  const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor` }).returning();
  vendorId = vendor.id;

  const [ca] = await db
    .insert(clientsTable)
    .values({
      firstName: "Alice",
      lastName: `${nonce}Aardvark`,
      dateOfBirth: "2000-01-01",
      uciNumber: `${nonce}-uciA`,
      status: "active",
      assignedCoordinatorId: coordId,
    })
    .returning();
  clientA = ca.id;
  const [cb] = await db
    .insert(clientsTable)
    .values({
      firstName: "Bob",
      lastName: `${nonce}Zebra`,
      dateOfBirth: "2000-01-01",
      uciNumber: `${nonce}-uciB`,
      status: "inactive",
      assignedCoordinatorId: otherCoordId,
    })
    .returning();
  clientB = cb.id;

  // clientA has an authorization linked to our vendor → vendor user can see it.
  const [auth] = await db
    .insert(authorizationsTable)
    .values({
      clientId: clientA,
      vendorId,
      authNumber: `${nonce}-auth`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      maxPeriodAmount: "1000.00",
      status: "active",
    })
    .returning();
  createdAuthIds.push(auth.id);

  const [vendorUser] = await db
    .insert(usersTable)
    .values({
      name: "CL Vendor User",
      email: `${nonce}-vendoruser@test.local`,
      role: "vendor",
      linkedRecordType: "vendor",
      linkedRecordId: vendorId,
    })
    .returning();
  vendorUserId = vendorUser.id;

  const [parentUser] = await db
    .insert(usersTable)
    .values({
      name: "CL Parent User",
      email: `${nonce}-parentuser@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientA,
    })
    .returning();
  parentUserId = parentUser.id;

  staffCookie = await session(staffId);
  coordCookie = await session(coordId);
  vendorCookie = await session(vendorUserId);
  parentCookie = await session(parentUserId);
});

afterAll(async () => {
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.id, createdAuthIds));
  // Clients FK-reference coordinator users, so delete clients first.
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
  await db
    .delete(sessionsTable)
    .where(inArray(sessionsTable.userId, [staffId, coordId, otherCoordId, vendorUserId, parentUserId]));
  await db
    .delete(usersTable)
    .where(inArray(usersTable.id, [staffId, coordId, otherCoordId, vendorUserId, parentUserId]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorId]));
});

describe("GET /clients auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/clients");
    expect(res.status).toBe(401);
  });
});

describe("GET /clients envelope + pagination", () => {
  it("returns an { items, total } envelope", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 50 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe("number");
  });

  it("staff sees both this run's clients (isolated by search nonce)", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 1000 });
    expect(res.body.total).toBe(2);
  });

  it("paginates with a stable total and SQL limit/offset", async () => {
    const first = await get(staffCookie, { search: nonce, limit: 1, offset: 0 });
    expect(first.body.total).toBe(2);
    expect(first.body.items).toHaveLength(1);
    const second = await get(staffCookie, { search: nonce, limit: 1, offset: 1 });
    expect(second.body.total).toBe(2);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it("offset beyond the result set returns empty items but the real total", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 10, offset: 100 });
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(2);
  });

  it("clamps limit to at least 1", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 0 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(2);
  });

  it("clamps negative offset to 0", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 1, offset: -10 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("orders by lastName ascending", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 1000 });
    // Aardvark before Zebra.
    expect(res.body.items[0].id).toBe(clientA);
    expect(res.body.items[1].id).toBe(clientB);
  });
});

describe("GET /clients SQL-level role scoping", () => {
  it("coordinators only see clients on their caseload", async () => {
    const res = await get(coordCookie, { search: nonce, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(clientA);
  });

  it("coordinator scoping cannot be widened by a status filter", async () => {
    // clientB is inactive & not on this coordinator's caseload.
    const res = await get(coordCookie, { search: nonce, status: "inactive", limit: 1000 });
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });

  it("parent/self users only see their linked client", async () => {
    const res = await get(parentCookie, { search: nonce, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(clientA);
  });

  it("vendor users only see clients they hold an authorization for", async () => {
    const res = await get(vendorCookie, { search: nonce, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(clientA);
  });
});

describe("GET /clients filters", () => {
  it("filters by status at the SQL level", async () => {
    const res = await get(staffCookie, { search: nonce, status: "inactive", limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(clientB);
  });

  it("search matches name or UCI (ilike) at the SQL level", async () => {
    const res = await get(staffCookie, { search: `${nonce}-uciA`, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(clientA);
  });

  it("search matches the full-name concat (ilike)", async () => {
    const res = await get(staffCookie, { search: `Alice ${nonce}Aardvark`, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(clientA);
  });
});
