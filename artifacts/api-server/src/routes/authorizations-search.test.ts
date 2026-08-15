import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray, eq } from "drizzle-orm";
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

// Tests for the `search` query param on GET /authorizations.
// The search applies ilike against authNumber directly, and ilike subqueries
// against client name and vendor name. Wildcard characters must be escaped.
const nonce = `ausrch${Date.now().toString(36)}`;

let staffId: string;
let staffCookie: string;
let vendorAlphaId: string;
let vendorBetaId: string;
let clientAlpha: string;
let clientBeta: string;

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

let authCounter = 0;
async function insertAuth(opts: {
  clientId: string;
  vendorId?: string | null;
  authNumberSuffix?: string;
}) {
  const suffix = opts.authNumberSuffix ?? String(authCounter++);
  const [a] = await db
    .insert(authorizationsTable)
    .values({
      clientId: opts.clientId,
      vendorId: opts.vendorId ?? null,
      authNumber: `${nonce}-${suffix}`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2025-01-01",
      servicePeriodEnd: "2027-01-01",
      maxPeriodAmount: "5000.00",
      status: "active",
    })
    .returning();
  createdAuthIds.push(a.id);
  return a;
}

async function get(qs: Record<string, string | number>) {
  return request(app).get("/api/authorizations").query(qs).set("Cookie", staffCookie);
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "AUSrch Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  staffCookie = await session(staffId);

  const [va] = await db.insert(vendorsTable).values({ name: `${nonce}-VendorAlpha` }).returning();
  vendorAlphaId = va.id;
  const [vb] = await db.insert(vendorsTable).values({ name: `${nonce}-VendorBeta` }).returning();
  vendorBetaId = vb.id;

  const [ca] = await db
    .insert(clientsTable)
    .values({ firstName: `${nonce}Alpha`, lastName: "AuthClient", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciA` })
    .returning();
  clientAlpha = ca.id;

  const [cb] = await db
    .insert(clientsTable)
    .values({ firstName: `${nonce}Beta`, lastName: "AuthClient", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciB` })
    .returning();
  clientBeta = cb.id;

  // Auth matrix:
  //  auth1: clientAlpha + VendorAlpha, authNumber ends in "-alpha-num"
  //  auth2: clientAlpha + VendorBeta,  authNumber ends in "-beta-num"
  //  auth3: clientBeta  + VendorAlpha
  await insertAuth({ clientId: clientAlpha, vendorId: vendorAlphaId, authNumberSuffix: "alpha-num" });
  await insertAuth({ clientId: clientAlpha, vendorId: vendorBetaId,  authNumberSuffix: "beta-num" });
  await insertAuth({ clientId: clientBeta,  vendorId: vendorAlphaId, authNumberSuffix: "other" });
});

afterAll(async () => {
  if (createdAuthIds.length) {
    await db.delete(authorizationsTable).where(inArray(authorizationsTable.id, createdAuthIds));
  }
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientAlpha, clientBeta]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorAlphaId, vendorBetaId]));
});

describe("GET /authorizations ?search — auth number", () => {
  it("returns auths whose auth_number matches the search term", async () => {
    const res = await get({ search: `${nonce}-alpha-num`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].authNumber).toBe(`${nonce}-alpha-num`);
  });

  it("returns all auths whose auth_number contains the prefix", async () => {
    // All three auths share the nonce prefix in their auth number
    const res = await get({ search: nonce, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  it("returns empty set when auth number search matches nothing", async () => {
    const res = await get({ search: `${nonce}-NOMATCH_ZZZ`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});

describe("GET /authorizations ?search — client name", () => {
  it("returns auths whose client name matches the search term", async () => {
    const res = await get({ search: `${nonce}Alpha`, limit: 1000 });
    expect(res.status).toBe(200);
    // clientAlpha has 2 auths
    expect(res.body.total).toBe(2);
    for (const a of res.body.items) expect(a.clientId).toBe(clientAlpha);
  });

  it("excludes auths for a non-matching client", async () => {
    const res = await get({ search: `${nonce}Beta`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].clientId).toBe(clientBeta);
  });
});

describe("GET /authorizations ?search — vendor name", () => {
  it("returns auths whose vendor name matches the search term", async () => {
    const res = await get({ search: `${nonce}-VendorAlpha`, limit: 1000 });
    expect(res.status).toBe(200);
    // VendorAlpha appears in auth1 (clientAlpha) and auth3 (clientBeta)
    expect(res.body.total).toBe(2);
    for (const a of res.body.items) expect(a.vendorId).toBe(vendorAlphaId);
  });

  it("excludes auths for a different vendor", async () => {
    const res = await get({ search: `${nonce}-VendorBeta`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].vendorId).toBe(vendorBetaId);
  });
});

describe("GET /authorizations ?search — wildcard escaping", () => {
  it("treats % in the search term literally (does not match everything)", async () => {
    const res = await get({ search: "%", limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it("treats _ in the search term literally (does not act as single-char wildcard)", async () => {
    const res = await get({ search: "_", limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it("does not throw a 500 when the search term contains SQL wildcard characters", async () => {
    const res = await get({ search: "% OR 1=1 --", limit: 1000 });
    expect(res.status).toBe(200);
  });
});

describe("GET /authorizations ?search — offset interaction (page reset)", () => {
  it("returns matching items at offset 0", async () => {
    // nonce matches all 3 auths (all share the nonce prefix in authNumber)
    const res = await get({ search: nonce, limit: 1, offset: 0 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(3);
  });

  it("returns the correct second page for a search term", async () => {
    const first  = await get({ search: nonce, limit: 1, offset: 0 });
    const second = await get({ search: nonce, limit: 1, offset: 1 });
    expect(second.body.total).toBe(3);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it("returns empty items (but correct total) when offset exceeds matches", async () => {
    const res = await get({ search: nonce, limit: 10, offset: 100 });
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(3);
  });
});

// Soft-delete guard: the client subquery must include `is_deleted = false` so
// that searching by a soft-deleted client's name does not silently return their
// linked authorizations. Vendors have no is_deleted column; their search path
// is unaffected and does not need a separate guard.
describe("GET /authorizations ?search — soft-deleted client", () => {
  beforeAll(async () => {
    // Soft-delete clientAlpha
    await db
      .update(clientsTable)
      .set({ isDeleted: true, deletedAt: new Date() })
      .where(eq(clientsTable.id, clientAlpha));
  });

  afterAll(async () => {
    // Restore clientAlpha so other tests and cleanup are unaffected
    await db
      .update(clientsTable)
      .set({ isDeleted: false, deletedAt: null })
      .where(eq(clientsTable.id, clientAlpha));
  });

  it("returns 0 authorizations when searching by a soft-deleted client's name", async () => {
    // clientAlpha has 2 authorizations but is now soft-deleted; the search
    // subquery must not match soft-deleted clients.
    const res = await get({ search: `${nonce}Alpha`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });

  it("still returns authorizations for non-deleted clients", async () => {
    // clientBeta is not deleted; its authorization should still be found.
    const res = await get({ search: `${nonce}Beta`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].clientId).toBe(clientBeta);
  });

  it("auth-number search is unaffected by client soft-delete", async () => {
    // Searching by auth number does not go through the client subquery, so
    // auths belonging to a soft-deleted client are still findable by auth number.
    const res = await get({ search: `${nonce}-alpha-num`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].authNumber).toBe(`${nonce}-alpha-num`);
  });
});
