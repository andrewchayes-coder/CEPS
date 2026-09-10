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
  paymentsTable,
  feesTable,
  remittancesTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// SQL-level list pagination + role scoping for GET /payments (Prompt 6).
// Mirrors the audit-log list test conventions: unique per-run nonce, self-
// cleaning, asserts on the { items, total } envelope.
const nonce = `payls${Date.now().toString(36)}`;

let staffId: string;
let coordId: string;
let vendorUserId: string;
let parentUserId: string;
let vendorId: string;
let otherVendorId: string;
let clientA: string; // the parent user's linked client, coordinator's caseload
let clientB: string; // a different client, outside the coordinator's caseload
let staffCookie: string;
let coordCookie: string;
let vendorCookie: string;
let parentCookie: string;

let checkCounter = 0;
const nextCheck = () => `${nonce}-chk-${checkCounter++}`;

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

// Insert a payment row directly (bypasses the fee auto-generation) so we can
// control exactly which client/vendor combinations exist.
async function insertPayment(opts: {
  clientId: string;
  vendorId?: string | null;
  amount?: string;
  checkDate?: string;
}) {
  const [p] = await db
    .insert(paymentsTable)
    .values({
      clientId: opts.clientId,
      vendorId: opts.vendorId ?? null,
      qbCheckNumber: nextCheck(),
      checkDate: opts.checkDate ?? "2026-01-15",
      amount: opts.amount ?? "100.00",
      paymentType: "direct_payment",
      source: "manual",
    })
    .returning();
  return p;
}

async function get(cookie: string, qs: Record<string, string | number>) {
  return request(app).get("/api/payments").query(qs).set("Cookie", cookie);
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "PL Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [coord] = await db
    .insert(usersTable)
    .values({ name: "PL Coord", email: `${nonce}-coord@test.local`, role: "service_coordinator" })
    .returning();
  coordId = coord.id;

  const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor` }).returning();
  vendorId = vendor.id;
  const [otherVendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor2` }).returning();
  otherVendorId = otherVendor.id;

  const [ca] = await db
    .insert(clientsTable)
    .values({ firstName: "PL", lastName: `${nonce}-ClientA`, dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciA`, assignedCoordinatorId: coordId })
    .returning();
  clientA = ca.id;
  const [cb] = await db
    .insert(clientsTable)
    .values({ firstName: "PL", lastName: `${nonce}-ClientB`, dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciB` })
    .returning();
  clientB = cb.id;

  const [vendorUser] = await db
    .insert(usersTable)
    .values({
      name: "PL Vendor User",
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
      name: "PL Parent User",
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

  await db.insert(authorizationsTable).values([
    { clientId: clientA, vendorId, authNumber: `${nonce}-auth-a`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2026-12-31", maxPeriodAmount: "1000.00", status: "active" },
    { clientId: clientB, vendorId, authNumber: `${nonce}-auth-b1`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2026-12-31", maxPeriodAmount: "1000.00", status: "active" },
    { clientId: clientB, vendorId: otherVendorId, authNumber: `${nonce}-auth-b2`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2026-12-31", maxPeriodAmount: "1000.00", status: "active" },
  ]);

  // Payment matrix:
  //  - clientA + our vendor        (visible to parentUser AND vendorUser)
  //  - clientA + no vendor         (visible to parentUser only)
  //  - clientB + our vendor        (visible to vendorUser only)
  //  - clientB + other vendor      (visible to neither parentUser nor vendorUser)
  await insertPayment({ clientId: clientA, vendorId });
  await insertPayment({ clientId: clientA, vendorId: null });
  await insertPayment({ clientId: clientB, vendorId });
  await insertPayment({ clientId: clientB, vendorId: otherVendorId });
});

afterAll(async () => {
  await db.delete(feesTable).where(inArray(feesTable.clientId, [clientA, clientB]));
  await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, [clientA, clientB]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientA, clientB]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, coordId, vendorUserId, parentUserId]));
  // Clients reference the coordinator via assigned_coordinator_id FK, so delete
  // clients before the users they point at.
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, coordId, vendorUserId, parentUserId]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorId, otherVendorId]));
});

describe("GET /payments auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/payments");
    expect(res.status).toBe(401);
  });
});

describe("GET /payments envelope + pagination", () => {
  it("returns an { items, total } envelope", async () => {
    const res = await get(staffCookie, { clientId: clientA, limit: 50 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe("number");
  });

  it("staff sees all four payments across both clients", async () => {
    // Filter by our two clients to isolate this run's rows from shared DB data.
    const a = await get(staffCookie, { clientId: clientA, limit: 1000 });
    const b = await get(staffCookie, { clientId: clientB, limit: 1000 });
    expect(a.body.total).toBe(2);
    expect(b.body.total).toBe(2);
  });

  it("paginates with a stable total and SQL limit/offset", async () => {
    const first = await get(staffCookie, { clientId: clientA, limit: 1, offset: 0 });
    expect(first.body.total).toBe(2);
    expect(first.body.items).toHaveLength(1);
    const second = await get(staffCookie, { clientId: clientA, limit: 1, offset: 1 });
    expect(second.body.total).toBe(2);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it("offset beyond the result set returns empty items but the real total", async () => {
    const res = await get(staffCookie, { clientId: clientA, limit: 10, offset: 100 });
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(2);
  });

  it("clamps limit to at least 1", async () => {
    const res = await get(staffCookie, { clientId: clientA, limit: 0 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(2);
  });

  it("clamps negative offset to 0", async () => {
    const res = await get(staffCookie, { clientId: clientA, limit: 1, offset: -10 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });
});

describe("GET /payments SQL-level role scoping", () => {
  it("vendor users only see payments for their own vendor", async () => {
    const res = await get(vendorCookie, { limit: 1000 });
    expect(res.status).toBe(200);
    for (const p of res.body.items) expect(p.vendorId).toBe(vendorId);
    // The two rows carrying our vendor (clientA + clientB) are visible; the
    // other-vendor and no-vendor rows are not.
    const ids = res.body.items.map((p: { clientId: string }) => p.clientId);
    expect(ids).toContain(clientA);
    expect(ids).toContain(clientB);
  });

  it("vendor scoping cannot be widened by a clientId filter", async () => {
    // clientA has a no-vendor payment, but the vendor user must never see it.
    const res = await get(vendorCookie, { clientId: clientA, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].vendorId).toBe(vendorId);
  });

  it("parent/self users only see their linked client's payments", async () => {
    const res = await get(parentCookie, { limit: 1000 });
    expect(res.status).toBe(200);
    for (const p of res.body.items) expect(p.clientId).toBe(clientA);
  });

  it("parent scoping cannot be widened by a clientId filter for another client", async () => {
    const res = await get(parentCookie, { clientId: clientB, limit: 1000 });
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });

  it("service coordinators only see payments for clients in their caseload", async () => {
    const res = await get(coordCookie, { limit: 1000 });
    expect(res.status).toBe(200);
    // clientA is assigned to the coordinator; clientB is not.
    for (const p of res.body.items) expect(p.clientId).toBe(clientA);
    const ids = res.body.items.map((p: { clientId: string }) => p.clientId);
    expect(ids).not.toContain(clientB);
  });

  it("coordinator scoping cannot be widened by a clientId filter for a client outside the caseload", async () => {
    const res = await get(coordCookie, { clientId: clientB, limit: 1000 });
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});

describe("GET /payments filters", () => {
  it("filters by vendorId at the SQL level", async () => {
    const res = await get(staffCookie, { vendorId: otherVendorId, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].vendorId).toBe(otherVendorId);
    expect(res.body.items[0].clientId).toBe(clientB);
  });

  it("search matches the check number (ilike) at the SQL level", async () => {
    // Grab one of clientA's checks and search for it.
    const all = await get(staffCookie, { clientId: clientA, limit: 1000 });
    const check = all.body.items[0].qbCheckNumber as string;
    const res = await get(staffCookie, { search: check });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].qbCheckNumber).toBe(check);
  });

  it("search matches client name (ilike) at the SQL level", async () => {
    // clientA has payments — searching by the last name portion should find them.
    const res = await get(staffCookie, { search: `${nonce}-ClientA`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    for (const p of res.body.items) expect(p.clientId).toBe(clientA);
  });
});

describe("GET /remittances search by client name", () => {
  // Isolated fixtures so this suite does not interfere with others.
  let srClientId: string;
  let srClientIdB: string;
  let srRemittanceId: string;

  beforeAll(async () => {
    const [ca] = await db
      .insert(clientsTable)
      .values({ firstName: "SRFirst", lastName: `SRMatch${nonce}`, dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciSRA` })
      .returning();
    srClientId = ca.id;

    const [cb] = await db
      .insert(clientsTable)
      .values({ firstName: "SROther", lastName: `SROther${nonce}`, dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciSRB` })
      .returning();
    srClientIdB = cb.id;

    const [r] = await db
      .insert(remittancesTable)
      .values({ clientId: srClientId, amount: "250.00", remittanceDate: "2026-03-01", status: "received", source: "manual" })
      .returning();
    srRemittanceId = r.id;

    // A second remittance for unmatched client — must not appear in search for srClientId.
    await db.insert(remittancesTable).values({ clientId: srClientIdB, amount: "99.00", remittanceDate: "2026-03-01", status: "received", source: "manual" });

  });

  afterAll(async () => {
    await db.delete(remittancesTable).where(inArray(remittancesTable.clientId, [srClientId, srClientIdB]));
    await db.delete(clientsTable).where(inArray(clientsTable.id, [srClientId, srClientIdB]));
  });

  it("search matches client last name (ilike) and returns matching remittances", async () => {
    const res = await request(app)
      .get("/api/remittances")
      .query({ search: `SRMatch${nonce}`, limit: 1000 })
      .set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const ids = res.body.items.map((r: { id: string }) => r.id);
    expect(ids).toContain(srRemittanceId);
    for (const r of res.body.items) expect(r.clientId).toBe(srClientId);
  });

  it("search excludes remittances whose client does not match", async () => {
    const res = await request(app)
      .get("/api/remittances")
      .query({ search: `SRMatch${nonce}`, limit: 1000 })
      .set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(srClientIdB);
  });

});

describe("GET /payments inactive vendor visibility", () => {
  // Isolated vendor + client + payment so deactivating the vendor doesn't
  // affect the shared fixtures in the outer beforeAll. Historical payments must
  // stay visible in the Payments Log regardless of vendor active status.
  let ivVendorId: string;
  let ivClientId: string;
  let ivPaymentId: string;
  let ivAuthorizationId: string;

  beforeAll(async () => {
    const [v] = await db
      .insert(vendorsTable)
      .values({ name: `${nonce}-iv-vendor` })
      .returning();
    ivVendorId = v.id;

    const [c] = await db
      .insert(clientsTable)
      .values({
        firstName: "IVTest",
        lastName: `IVClient${nonce}`,
        dateOfBirth: "2000-01-01",
        uciNumber: `${nonce}-uciIV`,
      })
      .returning();
    ivClientId = c.id;

    const [authorization] = await db.insert(authorizationsTable).values({
      clientId: ivClientId,
      vendorId: ivVendorId,
      authNumber: `${nonce}-iv-auth`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      maxPeriodAmount: "1000.00",
      status: "active",
    }).returning();
    ivAuthorizationId = authorization.id;

    const [p] = await db
      .insert(paymentsTable)
      .values({
        clientId: ivClientId,
        vendorId: ivVendorId,
        qbCheckNumber: `${nonce}-iv-chk`,
        checkDate: "2026-01-15",
        amount: "300.00",
        paymentType: "direct_payment",
        source: "manual",
      })
      .returning();
    ivPaymentId = p.id;
  });

  afterAll(async () => {
    await db.delete(feesTable).where(eq(feesTable.clientId, ivClientId));
    await db.delete(paymentsTable).where(eq(paymentsTable.id, ivPaymentId));
    await db.delete(authorizationsTable).where(eq(authorizationsTable.id, ivAuthorizationId));
    await db.delete(clientsTable).where(eq(clientsTable.id, ivClientId));
    await db.delete(vendorsTable).where(eq(vendorsTable.id, ivVendorId));
  });

  it("payment is visible before vendor is deactivated", async () => {
    const res = await get(staffCookie, { vendorId: ivVendorId, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(ivPaymentId);
  });

  it("staff still sees a deactivated vendor's historical payments across all query paths", async () => {
    // Deactivate the vendor directly in the DB (active = false, NOT soft-deleted).
    await db
      .update(vendorsTable)
      .set({ active: false })
      .where(eq(vendorsTable.id, ivVendorId));

    // 1. vendorId filter must still return the payment.
    const byVendorId = await get(staffCookie, { vendorId: ivVendorId, limit: 1000 });
    expect(byVendorId.status).toBe(200);
    expect(byVendorId.body.total).toBe(1);
    expect(byVendorId.body.items[0].id).toBe(ivPaymentId);

    // 2. clientId filter must still return the payment.
    const byClientId = await get(staffCookie, { clientId: ivClientId, limit: 1000 });
    expect(byClientId.status).toBe(200);
    expect(byClientId.body.total).toBe(1);
    expect(byClientId.body.items[0].id).toBe(ivPaymentId);

    // 3. Unfiltered list must include the payment too.
    const unfiltered = await get(staffCookie, { limit: 1000 });
    expect(unfiltered.status).toBe(200);
    const ids = unfiltered.body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(ivPaymentId);
  });
});

describe("GET /payments date bounds", () => {
  it("includes checkDate boundaries and rejects reversed ranges", async () => {
    const first = await insertPayment({ clientId: clientA, vendorId, checkDate: "2026-05-01" });
    const last = await insertPayment({ clientId: clientA, vendorId, checkDate: "2026-05-31" });
    const res = await get(staffCookie, { startDate: "2026-05-01", endDate: "2026-05-31", limit: 100 });
    expect(res.body.items.map((p: any) => p.id)).toEqual(expect.arrayContaining([first.id, last.id]));
    expect((await get(staffCookie, { startDate: "2026-06-01", endDate: "2026-05-01", limit: 10 })).status).toBe(400);
  });
});
