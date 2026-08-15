import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  paymentsTable,
  feesTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// SQL-level list pagination + role scoping for GET /payments (Prompt 6).
// Mirrors the audit-log list test conventions: unique per-run nonce, self-
// cleaning, asserts on the { items, total } envelope.
const nonce = `payls${Date.now().toString(36)}`;

let staffId: string;
let vendorUserId: string;
let parentUserId: string;
let vendorId: string;
let otherVendorId: string;
let clientA: string; // the parent user's linked client
let clientB: string; // a different client
let staffCookie: string;
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
}) {
  const [p] = await db
    .insert(paymentsTable)
    .values({
      clientId: opts.clientId,
      vendorId: opts.vendorId ?? null,
      qbCheckNumber: nextCheck(),
      checkDate: "2026-01-15",
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

  const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor` }).returning();
  vendorId = vendor.id;
  const [otherVendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor2` }).returning();
  otherVendorId = otherVendor.id;

  const [ca] = await db
    .insert(clientsTable)
    .values({ firstName: "PL", lastName: "ClientA", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciA` })
    .returning();
  clientA = ca.id;
  const [cb] = await db
    .insert(clientsTable)
    .values({ firstName: "PL", lastName: "ClientB", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciB` })
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
  vendorCookie = await session(vendorUserId);
  parentCookie = await session(parentUserId);

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
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, vendorUserId, parentUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, vendorUserId, parentUserId]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
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
    const res = await get(staffCookie, { search: "ClientA", limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    for (const p of res.body.items) expect(p.clientId).toBe(clientA);
  });
});

describe("GET /payments soft-deleted client filtering", () => {
  // This suite creates its own isolated client + payment so the soft-delete
  // doesn't affect the shared fixtures in the outer beforeAll.
  let sdClientId: string;
  let sdPaymentId: string;

  beforeAll(async () => {
    const [c] = await db
      .insert(clientsTable)
      .values({
        firstName: "SoftDel",
        lastName: `SDClient${nonce}`,
        dateOfBirth: "2000-01-01",
        uciNumber: `${nonce}-uciSD`,
      })
      .returning();
    sdClientId = c.id;

    const [p] = await db
      .insert(paymentsTable)
      .values({
        clientId: sdClientId,
        qbCheckNumber: `${nonce}-sd-chk`,
        checkDate: "2026-01-15",
        amount: "200.00",
        paymentType: "direct_payment",
        source: "manual",
      })
      .returning();
    sdPaymentId = p.id;
  });

  afterAll(async () => {
    await db.delete(feesTable).where(eq(feesTable.clientId, sdClientId));
    await db.delete(paymentsTable).where(eq(paymentsTable.id, sdPaymentId));
    await db.delete(clientsTable).where(eq(clientsTable.id, sdClientId));
  });

  it("payment is found by client name before soft-delete", async () => {
    const res = await get(staffCookie, { search: `SDClient${nonce}`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(sdPaymentId);
  });

  it("soft-deleted client's payments are excluded from all search paths", async () => {
    // Soft-delete the client directly in the DB.
    await db
      .update(clientsTable)
      .set({ isDeleted: true, deletedAt: new Date(), deletedBy: staffId })
      .where(eq(clientsTable.id, sdClientId));

    // 1. Client-name search must return nothing.
    const byName = await get(staffCookie, { search: `SDClient${nonce}`, limit: 1000 });
    expect(byName.status).toBe(200);
    expect(byName.body.total).toBe(0);
    expect(byName.body.items).toEqual([]);

    // 2. Check-number search must also return nothing — the outer active-client
    //    predicate hides the payment regardless of how the filter is expressed.
    const byCheck = await get(staffCookie, { search: `${nonce}-sd-chk`, limit: 1000 });
    expect(byCheck.status).toBe(200);
    expect(byCheck.body.total).toBe(0);
    expect(byCheck.body.items).toEqual([]);

    // 3. Filtering by clientId must return nothing.
    const byClientId = await get(staffCookie, { clientId: sdClientId, limit: 1000 });
    expect(byClientId.status).toBe(200);
    expect(byClientId.body.total).toBe(0);
    expect(byClientId.body.items).toEqual([]);
  });
});
