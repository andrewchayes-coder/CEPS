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

// SQL-level list pagination + role scoping for GET /authorizations (Prompt 6).
// The `status` and `expiringWithinDays` filters run against the DERIVED
// effective status / days-until-expiry, replicated in SQL — these tests lock
// that behaviour in.
const nonce = `auls${Date.now().toString(36)}`;

// A fixed "far future" end so an active auth stays active well past the
// expiring-soon window, and a soon-to-expire end ~10 days out from now.
const soonEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

let staffId: string;
let vendorUserId: string;
let parentUserId: string;
let vendorId: string;
let otherVendorId: string;
let clientA: string; // parent user's linked client
let clientB: string; // a different client
let staffCookie: string;
let vendorCookie: string;
let parentCookie: string;

const createdAuthIds: string[] = [];
let authActive: string; // clientA + vendor, active, far-future end
let authExpired: string; // clientA + no vendor, period end in the past
let authPending: string; // clientB + otherVendor, status pending
let authExpiringSoon: string; // clientA + vendor, active, end ~10 days out

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

async function insertAuth(opts: {
  clientId: string;
  vendorId?: string | null;
  status?: string;
  servicePeriodEnd?: string;
}) {
  const [a] = await db
    .insert(authorizationsTable)
    .values({
      clientId: opts.clientId,
      vendorId: opts.vendorId ?? null,
      authNumber: `${nonce}-${createdAuthIds.length}`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: opts.servicePeriodEnd ?? "2027-06-30",
      maxPeriodAmount: "1000.00",
      status: opts.status ?? "active",
    })
    .returning();
  createdAuthIds.push(a.id);
  return a;
}

async function get(cookie: string, qs: Record<string, string | number>) {
  return request(app).get("/api/authorizations").query(qs).set("Cookie", cookie);
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "AU Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor` }).returning();
  vendorId = vendor.id;
  const [otherVendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor2` }).returning();
  otherVendorId = otherVendor.id;

  const [ca] = await db
    .insert(clientsTable)
    .values({ firstName: "AU", lastName: "ClientA", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciA` })
    .returning();
  clientA = ca.id;
  const [cb] = await db
    .insert(clientsTable)
    .values({ firstName: "AU", lastName: "ClientB", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciB` })
    .returning();
  clientB = cb.id;

  const [vendorUser] = await db
    .insert(usersTable)
    .values({
      name: "AU Vendor User",
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
      name: "AU Parent User",
      email: `${nonce}-parentuser@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientA,
    })
    .returning();
  parentUserId = parentUser.id;

  staffCookie = await session(staffId);
  vendorCookie = await session(vendorUserId);
  parentCookie = await session(parentUserId);

  // Auth matrix (all no payments → totalPaid 0, never "exhausted"):
  authActive = (await insertAuth({ clientId: clientA, vendorId, status: "active" })).id;
  authExpired = (await insertAuth({ clientId: clientA, vendorId: null, status: "active", servicePeriodEnd: "2020-01-01" })).id;
  authPending = (await insertAuth({ clientId: clientB, vendorId: otherVendorId, status: "pending" })).id;
  authExpiringSoon = (await insertAuth({ clientId: clientA, vendorId, status: "active", servicePeriodEnd: soonEnd })).id;
});

afterAll(async () => {
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.id, createdAuthIds));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, vendorUserId, parentUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, vendorUserId, parentUserId]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorId, otherVendorId]));
});

describe("GET /authorizations auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/authorizations");
    expect(res.status).toBe(401);
  });
});

describe("GET /authorizations envelope + pagination", () => {
  it("returns an { items, total } envelope", async () => {
    const res = await get(staffCookie, { clientId: clientA, limit: 50 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe("number");
  });

  it("staff sees this run's auths (isolated by clientId)", async () => {
    const a = await get(staffCookie, { clientId: clientA, limit: 1000 });
    const b = await get(staffCookie, { clientId: clientB, limit: 1000 });
    expect(a.body.total).toBe(3);
    expect(b.body.total).toBe(1);
  });

  it("paginates with a stable total and SQL limit/offset", async () => {
    const first = await get(staffCookie, { clientId: clientA, limit: 1, offset: 0 });
    expect(first.body.total).toBe(3);
    expect(first.body.items).toHaveLength(1);
    const second = await get(staffCookie, { clientId: clientA, limit: 1, offset: 1 });
    expect(second.body.total).toBe(3);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it("offset beyond the result set returns empty items but the real total", async () => {
    const res = await get(staffCookie, { clientId: clientA, limit: 10, offset: 100 });
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(3);
  });

  it("clamps limit to at least 1", async () => {
    const res = await get(staffCookie, { clientId: clientA, limit: 0 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(3);
  });

  it("clamps negative offset to 0", async () => {
    const res = await get(staffCookie, { clientId: clientA, limit: 1, offset: -10 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });
});

describe("GET /authorizations SQL-level role scoping", () => {
  it("vendor users only see their own vendor's auths", async () => {
    const res = await get(vendorCookie, { limit: 1000 });
    expect(res.status).toBe(200);
    for (const a of res.body.items) expect(a.vendorId).toBe(vendorId);
    const ids = res.body.items.map((a: { id: string }) => a.id);
    expect(ids).toContain(authActive);
    expect(ids).toContain(authExpiringSoon);
    expect(ids).not.toContain(authExpired); // no-vendor
    expect(ids).not.toContain(authPending); // other vendor
  });

  it("vendor scoping cannot be widened by a clientId filter", async () => {
    // clientA has a no-vendor auth (authExpired), but the vendor user must not see it.
    const res = await get(vendorCookie, { clientId: clientA, limit: 1000 });
    expect(res.body.total).toBe(2);
    for (const a of res.body.items) expect(a.vendorId).toBe(vendorId);
  });

  it("parent/self users only see their linked client's auths", async () => {
    const res = await get(parentCookie, { limit: 1000 });
    expect(res.status).toBe(200);
    for (const a of res.body.items) expect(a.clientId).toBe(clientA);
    expect(res.body.total).toBe(3);
  });

  it("parent scoping cannot be widened by a clientId filter for another client", async () => {
    const res = await get(parentCookie, { clientId: clientB, limit: 1000 });
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});

describe("GET /authorizations derived filters", () => {
  it("filters by vendorId at the SQL level", async () => {
    const res = await get(staffCookie, { vendorId: otherVendorId, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(authPending);
  });

  it("status filter matches the DERIVED effective status (expired via period end)", async () => {
    const res = await get(staffCookie, { clientId: clientA, status: "expired", limit: 1000 });
    const ids = res.body.items.map((a: { id: string }) => a.id);
    expect(ids).toContain(authExpired);
    expect(ids).not.toContain(authActive);
    expect(ids).not.toContain(authExpiringSoon);
  });

  it("status filter matches active (derived) auths only", async () => {
    const res = await get(staffCookie, { clientId: clientA, status: "active", limit: 1000 });
    const ids = res.body.items.map((a: { id: string }) => a.id);
    expect(ids).toContain(authActive);
    expect(ids).toContain(authExpiringSoon);
    expect(ids).not.toContain(authExpired);
  });

  it("status filter matches pending (derived) auths", async () => {
    const res = await get(staffCookie, { clientId: clientB, status: "pending", limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(authPending);
  });

  it("expiringWithinDays only returns active auths inside the window", async () => {
    const res = await get(staffCookie, { clientId: clientA, expiringWithinDays: 30, limit: 1000 });
    const ids = res.body.items.map((a: { id: string }) => a.id);
    // ~10 days out → in window; far-future active → out; expired → excluded.
    expect(ids).toContain(authExpiringSoon);
    expect(ids).not.toContain(authActive);
    expect(ids).not.toContain(authExpired);
  });
});
