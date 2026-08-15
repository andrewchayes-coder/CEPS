import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  referralsTable,
  authorizationsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// Module 9 reporting list endpoints:
//   GET /reports/pending-authorizations
//   GET /reports/case-status
//   GET /reports/missing-documents
//   GET /reports/expiring-authorizations
// All are staff-only; these tests lock in the staff gate + SQL filters.
const nonce = `rpts${Date.now().toString(36)}`;

const soonEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const farEnd = "2099-06-30";
const pastEnd = "2000-01-01";

let staffId: string;
let coordId: string;
let otherCoordId: string;
let parentUserId: string;
let clientA: string;
let clientB: string;
let clientC: string; // distinctly-named ("SearchZ") client for cross-page search tests
let vendorMissingW9: string;
let vendorOk: string;
let staffCookie: string;
let coordCookie: string;
let parentCookie: string;

const createdReferralIds: string[] = [];
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

async function insertReferral(opts: {
  clientId: string;
  coordinatorId?: string | null;
  status?: string;
  referralDate?: string;
  parentSignedAt?: Date | null;
}) {
  const [r] = await db
    .insert(referralsTable)
    .values({
      clientId: opts.clientId,
      serviceCoordinatorId: opts.coordinatorId ?? null,
      referralDate: opts.referralDate ?? "2026-01-15",
      status: opts.status ?? "intake",
      parentSignedAt: opts.parentSignedAt ?? null,
    })
    .returning();
  createdReferralIds.push(r.id);
  return r;
}

async function insertAuth(opts: {
  clientId: string;
  vendorId?: string | null;
  status?: string;
  servicePeriodEnd?: string;
  posPdfUrl?: string | null;
}) {
  const [a] = await db
    .insert(authorizationsTable)
    .values({
      clientId: opts.clientId,
      vendorId: opts.vendorId ?? null,
      authNumber: `${nonce}-a${createdAuthIds.length}`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: opts.servicePeriodEnd ?? farEnd,
      maxPeriodAmount: "1000.00",
      status: opts.status ?? "active",
      posPdfUrl: opts.posPdfUrl ?? null,
    })
    .returning();
  createdAuthIds.push(a.id);
  return a;
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "RP Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  const [coord] = await db
    .insert(usersTable)
    .values({ name: "RP Coord", email: `${nonce}-coord@test.local`, role: "service_coordinator" })
    .returning();
  coordId = coord.id;
  const [otherCoord] = await db
    .insert(usersTable)
    .values({ name: "RP OtherCoord", email: `${nonce}-coord2@test.local`, role: "service_coordinator" })
    .returning();
  otherCoordId = otherCoord.id;

  const [ca] = await db
    .insert(clientsTable)
    .values({ firstName: "RP", lastName: "ClientA", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciA` })
    .returning();
  clientA = ca.id;
  const [cb] = await db
    .insert(clientsTable)
    .values({ firstName: "RP", lastName: "ClientB", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciB` })
    .returning();
  clientB = cb.id;
  const [cc] = await db
    .insert(clientsTable)
    .values({ firstName: "RP", lastName: "SearchZ", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciC` })
    .returning();
  clientC = cc.id;

  const [parentUser] = await db
    .insert(usersTable)
    .values({
      name: "RP Parent",
      email: `${nonce}-parent@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientA,
    })
    .returning();
  parentUserId = parentUser.id;

  const [vMissing] = await db
    .insert(vendorsTable)
    .values({ name: `${nonce}-vendorMissing`, active: true, w9Status: "pending" })
    .returning();
  vendorMissingW9 = vMissing.id;
  const [vOk] = await db
    .insert(vendorsTable)
    .values({ name: `${nonce}-vendorOk`, active: true, w9Status: "on_file" })
    .returning();
  vendorOk = vOk.id;

  staffCookie = await session(staffId);
  coordCookie = await session(coordId);
  parentCookie = await session(parentUserId);

  // Referrals:
  //  - clientA, coord, pending_auth  (pending-auth tracker + case status)
  //  - clientB, otherCoord, pending_auth
  //  - clientA, coord, pending_signature, unsigned (missing signature doc)
  //  - clientB, otherCoord, active
  await insertReferral({ clientId: clientA, coordinatorId: coordId, status: "pending_auth", referralDate: "2026-01-10" });
  await insertReferral({ clientId: clientB, coordinatorId: otherCoordId, status: "pending_auth", referralDate: "2026-02-01" });
  await insertReferral({ clientId: clientA, coordinatorId: coordId, status: "pending_signature", parentSignedAt: null });
  await insertReferral({ clientId: clientB, coordinatorId: otherCoordId, status: "active" });

  // clientC ("SearchZ") — three pending_auth referrals with distinct dates so a
  // name search spans more than one page under a small limit. This exercises
  // the SQL-level (not post-limit) search predicate for pending-auth AND
  // case-status. Dates chosen so they sort AFTER clientA/clientB in the
  // pending-auth (asc referralDate) ordering.
  await insertReferral({ clientId: clientC, coordinatorId: coordId, status: "pending_auth", referralDate: "2026-03-01" });
  await insertReferral({ clientId: clientC, coordinatorId: coordId, status: "pending_auth", referralDate: "2026-03-02" });
  await insertReferral({ clientId: clientC, coordinatorId: coordId, status: "pending_auth", referralDate: "2026-03-03" });

  // Authorizations:
  //  - clientA + vendorOk, active, expiring soon (~10 days), has PDF
  //  - clientA + vendorMissingW9, active, far future, NO PDF (missing auth_pdf)
  //  - clientB, active, expired end (excluded from expiring)
  await insertAuth({ clientId: clientA, vendorId: vendorOk, status: "active", servicePeriodEnd: soonEnd, posPdfUrl: "https://x/pdf" });
  await insertAuth({ clientId: clientA, vendorId: vendorMissingW9, status: "active", servicePeriodEnd: farEnd, posPdfUrl: null });
  await insertAuth({ clientId: clientB, vendorId: vendorOk, status: "active", servicePeriodEnd: pastEnd, posPdfUrl: "https://x/pdf" });
});

afterAll(async () => {
  if (createdReferralIds.length) {
    await db.delete(referralsTable).where(inArray(referralsTable.id, createdReferralIds));
  }
  if (createdAuthIds.length) {
    await db.delete(authorizationsTable).where(inArray(authorizationsTable.id, createdAuthIds));
  }
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, coordId, parentUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, coordId, otherCoordId, parentUserId]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorMissingW9, vendorOk]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB, clientC]));
});

describe("reports endpoints are staff-only", () => {
  const paths = [
    "/api/reports/pending-authorizations",
    "/api/reports/case-status",
    "/api/reports/missing-documents",
    "/api/reports/expiring-authorizations",
  ];
  for (const p of paths) {
    it(`rejects unauthenticated ${p}`, async () => {
      const res = await request(app).get(p);
      expect(res.status).toBe(401);
    });
    it(`rejects non-staff ${p}`, async () => {
      const res = await request(app).get(p).set("Cookie", coordCookie);
      expect(res.status).toBe(403);
      const res2 = await request(app).get(p).set("Cookie", parentCookie);
      expect(res2.status).toBe(403);
    });
  }
});

describe("GET /reports/pending-authorizations", () => {
  it("returns an { items, total } envelope of only pending_auth referrals", async () => {
    const res = await request(app).get("/api/reports/pending-authorizations").query({ limit: 1000 }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    // Only our two pending_auth referrals belong to this nonce; assert they are present.
    const mine = res.body.items.filter((r: any) => [clientA, clientB].includes(r.clientId));
    expect(mine.length).toBe(2);
    for (const r of mine) {
      expect(typeof r.daysWaiting).toBe("number");
      expect(r.daysWaiting).toBeGreaterThanOrEqual(0);
    }
  });

  it("filters by coordinatorId at the SQL level", async () => {
    const res = await request(app).get("/api/reports/pending-authorizations").query({ coordinatorId: otherCoordId, limit: 1000 }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    for (const r of res.body.items) expect(r.coordinatorId).toBe(otherCoordId);
    expect(res.body.items.some((r: any) => r.clientId === clientB)).toBe(true);
  });

  it("filters by client-name search", async () => {
    const res = await request(app).get("/api/reports/pending-authorizations").query({ search: "ClientB", limit: 1000 }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].clientId).toBe(clientB);
  });

  // Regression for the review finding: name search must run in SQL (before
  // limit/offset). SearchZ has three pending_auth cases; a search paged with a
  // small limit must yield the correct total and the right row on page 2.
  it("client-name search is applied in SQL across pages with a correct total", async () => {
    const p1 = await request(app)
      .get("/api/reports/pending-authorizations")
      .query({ search: "SearchZ", limit: 2, offset: 0 })
      .set("Cookie", staffCookie);
    expect(p1.status).toBe(200);
    expect(p1.body.total).toBe(3);
    expect(p1.body.items.length).toBe(2);
    for (const r of p1.body.items) expect(r.clientId).toBe(clientC);
    // asc(referralDate): 2026-03-01 then 2026-03-02 on page 1.
    expect(p1.body.items[0].referralDate).toBe("2026-03-01");
    expect(p1.body.items[1].referralDate).toBe("2026-03-02");

    const p2 = await request(app)
      .get("/api/reports/pending-authorizations")
      .query({ search: "SearchZ", limit: 2, offset: 2 })
      .set("Cookie", staffCookie);
    expect(p2.status).toBe(200);
    expect(p2.body.total).toBe(3);
    expect(p2.body.items.length).toBe(1);
    expect(p2.body.items[0].clientId).toBe(clientC);
    expect(p2.body.items[0].referralDate).toBe("2026-03-03");
  });
});

describe("GET /reports/case-status", () => {
  it("returns an { items, total } envelope with status stages", async () => {
    const res = await request(app).get("/api/reports/case-status").query({ limit: 1000 }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    expect(typeof res.body.total).toBe("number");
    const mine = res.body.items.filter((r: any) => [clientA, clientB].includes(r.clientId));
    expect(mine.length).toBe(4);
  });

  it("filters by status at the SQL level", async () => {
    const res = await request(app).get("/api/reports/case-status").query({ status: "pending_auth", coordinatorId: coordId, limit: 1000 }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    for (const r of res.body.items) {
      expect(r.status).toBe("pending_auth");
      expect(r.coordinatorId).toBe(coordId);
    }
    // coordId owns clientA's one pending_auth + clientC's three = 4.
    const mine = res.body.items.filter((r: any) => [clientA, clientC].includes(r.clientId));
    expect(mine.length).toBe(4);
  });

  // Regression for the review finding: name search must run in SQL (before
  // limit/offset), so total + rows are correct even when matches fall on page 2.
  it("client-name search is applied in SQL across pages with a correct total", async () => {
    // limit 2 puts SearchZ's 3 pending_auth cases across two pages.
    const p1 = await request(app)
      .get("/api/reports/case-status")
      .query({ status: "pending_auth", search: "SearchZ", limit: 2, offset: 0 })
      .set("Cookie", staffCookie);
    expect(p1.status).toBe(200);
    expect(p1.body.total).toBe(3);
    expect(p1.body.items.length).toBe(2);
    for (const r of p1.body.items) expect(r.clientId).toBe(clientC);

    const p2 = await request(app)
      .get("/api/reports/case-status")
      .query({ status: "pending_auth", search: "SearchZ", limit: 2, offset: 2 })
      .set("Cookie", staffCookie);
    expect(p2.status).toBe(200);
    expect(p2.body.total).toBe(3);
    expect(p2.body.items.length).toBe(1);
    expect(p2.body.items[0].clientId).toBe(clientC);
    // The row on page 2 is distinct from page 1.
    const p1Ids = p1.body.items.map((r: any) => r.referralId);
    expect(p1Ids).not.toContain(p2.body.items[0].referralId);
  });
});

describe("GET /reports/missing-documents", () => {
  it("lists w9, signature, and auth_pdf gaps", async () => {
    const res = await request(app).get("/api/reports/missing-documents").query({ limit: 1000 }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    const kinds = new Set(res.body.items.map((r: any) => r.docType));
    expect(kinds.has("w9")).toBe(true);
    expect(kinds.has("signature")).toBe(true);
    expect(kinds.has("auth_pdf")).toBe(true);
    // Our missing-W9 vendor appears; the on_file vendor does not.
    const w9Ids = res.body.items.filter((r: any) => r.docType === "w9").map((r: any) => r.entityId);
    expect(w9Ids).toContain(vendorMissingW9);
    expect(w9Ids).not.toContain(vendorOk);
  });

  it("filters by docType=w9", async () => {
    const res = await request(app).get("/api/reports/missing-documents").query({ docType: "w9", limit: 1000 }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    for (const r of res.body.items) expect(r.docType).toBe("w9");
  });

  it("filters by docType=auth_pdf and includes the no-PDF auth", async () => {
    const res = await request(app).get("/api/reports/missing-documents").query({ docType: "auth_pdf", limit: 1000 }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    for (const r of res.body.items) expect(r.docType).toBe("auth_pdf");
    expect(res.body.items.some((r: any) => createdAuthIds.includes(r.entityId))).toBe(true);
  });
});

describe("GET /reports/expiring-authorizations", () => {
  it("includes an active auth expiring within the window and excludes expired ones", async () => {
    const res = await request(app).get("/api/reports/expiring-authorizations").query({ withinDays: 30, limit: 1000 }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    const mine = res.body.items.filter((r: any) => createdAuthIds.includes(r.authorizationId));
    // Only the soon-expiring (10d) auth qualifies; far-future and expired do not.
    expect(mine.length).toBe(1);
    expect(mine[0].daysUntilExpiry).toBeLessThanOrEqual(30);
    expect(mine[0].daysUntilExpiry).toBeGreaterThanOrEqual(0);
  });

  it("a tiny window excludes the ~10-day-out auth", async () => {
    const res = await request(app).get("/api/reports/expiring-authorizations").query({ withinDays: 3, limit: 1000 }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    const mine = res.body.items.filter((r: any) => createdAuthIds.includes(r.authorizationId));
    expect(mine.length).toBe(0);
  });
});
