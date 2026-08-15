import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  referralsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// SQL-level list pagination + role scoping for GET /referrals (Prompt 6).
const nonce = `refls${Date.now().toString(36)}`;

let staffId: string;
let coordId: string;
let otherCoordId: string;
let parentUserId: string;
let clientA: string; // parent user's linked client (coordA owns its referrals)
let clientB: string; // owned by otherCoord
let staffCookie: string;
let coordCookie: string;
let parentCookie: string;

const createdReferralIds: string[] = [];

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

async function insertReferral(opts: {
  clientId: string;
  coordinatorId?: string | null;
  status?: string;
  createdAt?: Date;
}) {
  const [r] = await db
    .insert(referralsTable)
    .values({
      clientId: opts.clientId,
      serviceCoordinatorId: opts.coordinatorId ?? null,
      referralDate: "2026-01-15",
      status: opts.status ?? "intake",
      createdAt: opts.createdAt ?? new Date(),
    })
    .returning();
  createdReferralIds.push(r.id);
  return r;
}

async function get(cookie: string, qs: Record<string, string | number>) {
  return request(app).get("/api/referrals").query(qs).set("Cookie", cookie);
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "RL Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  const [coord] = await db
    .insert(usersTable)
    .values({ name: "RL Coord", email: `${nonce}-coord@test.local`, role: "service_coordinator" })
    .returning();
  coordId = coord.id;
  const [otherCoord] = await db
    .insert(usersTable)
    .values({ name: "RL OtherCoord", email: `${nonce}-coord2@test.local`, role: "service_coordinator" })
    .returning();
  otherCoordId = otherCoord.id;

  const [ca] = await db
    .insert(clientsTable)
    .values({ firstName: "RL", lastName: "ClientA", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciA` })
    .returning();
  clientA = ca.id;
  const [cb] = await db
    .insert(clientsTable)
    .values({ firstName: "RL", lastName: "ClientB", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciB` })
    .returning();
  clientB = cb.id;

  const [parentUser] = await db
    .insert(usersTable)
    .values({
      name: "RL Parent",
      email: `${nonce}-parent@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientA,
    })
    .returning();
  parentUserId = parentUser.id;

  staffCookie = await session(staffId);
  coordCookie = await session(coordId);
  parentCookie = await session(parentUserId);

  // Referral matrix (distinct createdAt so newest-first ordering is stable):
  //  - clientA, coord, active     (visible to coord + parent + staff)
  //  - clientA, coord, intake     (visible to coord + parent + staff)
  //  - clientB, otherCoord, intake(visible to staff only)
  await insertReferral({ clientId: clientA, coordinatorId: coordId, status: "active", createdAt: new Date("2026-01-03T00:00:00Z") });
  await insertReferral({ clientId: clientA, coordinatorId: coordId, status: "intake", createdAt: new Date("2026-01-02T00:00:00Z") });
  await insertReferral({ clientId: clientB, coordinatorId: otherCoordId, status: "intake", createdAt: new Date("2026-01-01T00:00:00Z") });
});

afterAll(async () => {
  if (createdReferralIds.length) {
    await db.delete(referralsTable).where(inArray(referralsTable.id, createdReferralIds));
  }
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, coordId, parentUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, coordId, otherCoordId, parentUserId]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
});

describe("GET /referrals auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/referrals");
    expect(res.status).toBe(401);
  });
});

describe("GET /referrals envelope + pagination", () => {
  it("returns an { items, total } envelope", async () => {
    const res = await get(coordCookie, { limit: 50 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe("number");
  });

  it("paginates coordinator-owned referrals newest-first with a stable total", async () => {
    const first = await get(coordCookie, { limit: 1, offset: 0 });
    expect(first.body.total).toBe(2);
    expect(first.body.items).toHaveLength(1);
    // Newest first: the active referral (created 01-03) comes before intake (01-02).
    expect(first.body.items[0].status).toBe("active");
    const second = await get(coordCookie, { limit: 1, offset: 1 });
    expect(second.body.total).toBe(2);
    expect(second.body.items[0].status).toBe("intake");
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it("offset beyond the result set returns empty items but the real total", async () => {
    const res = await get(coordCookie, { limit: 10, offset: 100 });
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(2);
  });

  it("clamps limit to at least 1", async () => {
    const res = await get(coordCookie, { limit: 0 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(2);
  });
});

describe("GET /referrals SQL-level role scoping", () => {
  it("coordinators only see referrals they own", async () => {
    const res = await get(coordCookie, { limit: 1000 });
    expect(res.body.total).toBe(2);
    for (const r of res.body.items) expect(r.clientId).toBe(clientA);
  });

  it("parent/self users only see their linked client's referrals", async () => {
    const res = await get(parentCookie, { limit: 1000 });
    expect(res.body.total).toBe(2);
    for (const r of res.body.items) expect(r.clientId).toBe(clientA);
  });

  it("parent scoping cannot be widened by a clientId filter for another client", async () => {
    const res = await get(parentCookie, { clientId: clientB, limit: 1000 });
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});

describe("GET /referrals filters", () => {
  it("filters by status at the SQL level (scoped)", async () => {
    const res = await get(coordCookie, { status: "active", limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].status).toBe("active");
  });

  it("filters by coordinatorId at the SQL level (staff view)", async () => {
    const res = await get(staffCookie, { coordinatorId: otherCoordId, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].clientId).toBe(clientB);
  });
});
