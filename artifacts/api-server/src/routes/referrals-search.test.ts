import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  referralsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// Tests for the `search` query param on GET /referrals.
// The search applies ilike subqueries against client name (first || ' ' || last)
// and coordinator name. Wildcard characters must be escaped.
const nonce = `refsrch${Date.now().toString(36)}`;

let staffId: string;
let coordAlphaId: string;
let coordBetaId: string;
let clientAlpha: string;
let clientBeta: string;
let staffCookie: string;

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
}) {
  const [r] = await db
    .insert(referralsTable)
    .values({
      clientId: opts.clientId,
      serviceCoordinatorId: opts.coordinatorId ?? null,
      referralDate: "2025-01-15",
      status: opts.status ?? "intake",
    })
    .returning();
  createdReferralIds.push(r.id);
  return r;
}

async function get(qs: Record<string, string | number>) {
  return request(app).get("/api/referrals").query(qs).set("Cookie", staffCookie);
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "RFSrch Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  staffCookie = await session(staffId);

  // Two coordinators with distinct names — the `name` column is what the
  // referrals search subquery matches against.
  const [coa] = await db
    .insert(usersTable)
    .values({ name: `${nonce} CoordAlpha`, email: `${nonce}-coordA@test.local`, role: "service_coordinator" })
    .returning();
  coordAlphaId = coa.id;

  const [cob] = await db
    .insert(usersTable)
    .values({ name: `${nonce} CoordBeta`, email: `${nonce}-coordB@test.local`, role: "service_coordinator" })
    .returning();
  coordBetaId = cob.id;

  // Two clients with distinct first names
  const [ca] = await db
    .insert(clientsTable)
    .values({ firstName: `${nonce}Alpha`, lastName: "RefClient", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciA` })
    .returning();
  clientAlpha = ca.id;

  const [cb] = await db
    .insert(clientsTable)
    .values({ firstName: `${nonce}Beta`, lastName: "RefClient", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciB` })
    .returning();
  clientBeta = cb.id;

  // Referral matrix:
  //  ref1: clientAlpha + CoordAlpha  (matches on clientAlpha name and coordAlpha name)
  //  ref2: clientBeta  + CoordAlpha  (matches on coordAlpha name and clientBeta name)
  //  ref3: clientBeta  + CoordBeta   (matches on coordBeta name and clientBeta name)
  await insertReferral({ clientId: clientAlpha, coordinatorId: coordAlphaId });
  await insertReferral({ clientId: clientBeta,  coordinatorId: coordAlphaId });
  await insertReferral({ clientId: clientBeta,  coordinatorId: coordBetaId  });
});

afterAll(async () => {
  if (createdReferralIds.length) {
    await db.delete(referralsTable).where(inArray(referralsTable.id, createdReferralIds));
  }
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, coordAlphaId, coordBetaId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, coordAlphaId, coordBetaId]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientAlpha, clientBeta]));
});

describe("GET /referrals ?search — client name", () => {
  it("returns referrals whose client name matches the search term", async () => {
    const res = await get({ search: `${nonce}Alpha`, limit: 1000 });
    expect(res.status).toBe(200);
    // Only ref1 belongs to clientAlpha
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].clientId).toBe(clientAlpha);
  });

  it("excludes referrals for a non-matching client", async () => {
    const res = await get({ search: `${nonce}Beta`, limit: 1000 });
    expect(res.status).toBe(200);
    // ref2 and ref3 belong to clientBeta
    expect(res.body.total).toBe(2);
    for (const r of res.body.items) expect(r.clientId).toBe(clientBeta);
  });

  it("returns empty set when client name search matches nothing", async () => {
    const res = await get({ search: `${nonce}NOMATCH_ZZZ`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});

describe("GET /referrals ?search — coordinator name", () => {
  it("returns referrals whose coordinator name matches the search term", async () => {
    const res = await get({ search: `${nonce} CoordAlpha`, limit: 1000 });
    expect(res.status).toBe(200);
    // ref1 and ref2 are owned by CoordAlpha
    expect(res.body.total).toBe(2);
    for (const r of res.body.items) expect(r.serviceCoordinatorId).toBe(coordAlphaId);
  });

  it("excludes referrals for a different coordinator", async () => {
    const res = await get({ search: `${nonce} CoordBeta`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].serviceCoordinatorId).toBe(coordBetaId);
  });
});

describe("GET /referrals ?search — wildcard escaping", () => {
  it("treats % in the search term literally (does not match everything)", async () => {
    const res = await get({ search: "%", limit: 1000 });
    expect(res.status).toBe(200);
    // None of our fixture client/coordinator names contain a literal '%'
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

describe("GET /referrals ?search — offset interaction (page reset)", () => {
  it("returns matching items at offset 0", async () => {
    // CoordAlpha matches ref1 + ref2; also matches via the nonce prefix in
    // coordinator name — use the full name to be precise.
    const res = await get({ search: `${nonce} CoordAlpha`, limit: 1, offset: 0 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(2);
  });

  it("returns the correct second page for a search term", async () => {
    const first  = await get({ search: `${nonce} CoordAlpha`, limit: 1, offset: 0 });
    const second = await get({ search: `${nonce} CoordAlpha`, limit: 1, offset: 1 });
    expect(second.body.total).toBe(2);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it("returns empty items (but correct total) when offset exceeds matches", async () => {
    const res = await get({ search: `${nonce} CoordAlpha`, limit: 10, offset: 100 });
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(2);
  });
});

describe("GET /referrals ?search — soft-deleted client excluded", () => {
  const nonceDel = `refdel${Date.now().toString(36)}`;
  let deletedClientId: string;
  let deletedReferralId: string;

  beforeAll(async () => {
    const [client] = await db
      .insert(clientsTable)
      .values({
        firstName: `${nonceDel}Gone`,
        lastName: "SoftDel",
        dateOfBirth: "2000-06-15",
        uciNumber: `${nonceDel}-uci`,
      })
      .returning();
    deletedClientId = client.id;

    const [referral] = await db
      .insert(referralsTable)
      .values({
        clientId: deletedClientId,
        serviceCoordinatorId: null,
        referralDate: "2025-03-01",
        status: "intake",
      })
      .returning();
    deletedReferralId = referral.id;

    // Soft-delete the client
    await db
      .update(clientsTable)
      .set({ isDeleted: true })
      .where(eq(clientsTable.id, deletedClientId));
  });

  afterAll(async () => {
    await db.delete(referralsTable).where(eq(referralsTable.id, deletedReferralId));
    await db.delete(clientsTable).where(eq(clientsTable.id, deletedClientId));
  });

  it("does not return referrals for a soft-deleted client when searching by name", async () => {
    const res = await get({ search: `${nonceDel}Gone`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});
