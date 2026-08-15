import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  invoicesTable,
} from "@workspace/db";
import app from "../app";
import request from "supertest";
import { newToken } from "../lib/auth";

// SQL-level list pagination + role scoping for GET /invoices (Prompt 6).
// Mirrors payments-list.test.ts: unique per-run nonce, self-cleaning, asserts
// on the { items, total } envelope.
const nonce = `invls${Date.now().toString(36)}`;

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

let monthCounter = 0;
const nextMonth = () => `2026-${String((monthCounter++ % 12) + 1).padStart(2, "0")}`;

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

async function insertInvoice(opts: {
  clientId: string;
  vendorId?: string | null;
  status?: string;
}) {
  const [i] = await db
    .insert(invoicesTable)
    .values({
      clientId: opts.clientId,
      vendorId: opts.vendorId ?? null,
      submittedByRole: "staff",
      submittedDate: "2026-01-15",
      serviceMonth: nextMonth(),
      amountRequested: "100.00",
      paymentType: "direct_payment",
      status: opts.status ?? "pending_review",
    })
    .returning();
  return i;
}

async function get(cookie: string, qs: Record<string, string | number>) {
  return request(app).get("/api/invoices").query(qs).set("Cookie", cookie);
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "IL Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor` }).returning();
  vendorId = vendor.id;
  const [otherVendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor2` }).returning();
  otherVendorId = otherVendor.id;

  const [ca] = await db
    .insert(clientsTable)
    .values({ firstName: "IL", lastName: "ClientA", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciA` })
    .returning();
  clientA = ca.id;
  const [cb] = await db
    .insert(clientsTable)
    .values({ firstName: "IL", lastName: "ClientB", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciB` })
    .returning();
  clientB = cb.id;

  const [vendorUser] = await db
    .insert(usersTable)
    .values({
      name: "IL Vendor User",
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
      name: "IL Parent User",
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

  // Invoice matrix:
  //  - clientA + our vendor    (visible to parentUser AND vendorUser)
  //  - clientA + no vendor     (visible to parentUser only)
  //  - clientB + our vendor    (visible to vendorUser only)
  //  - clientB + other vendor  (visible to neither)
  await insertInvoice({ clientId: clientA, vendorId, status: "approved" });
  await insertInvoice({ clientId: clientA, vendorId: null });
  await insertInvoice({ clientId: clientB, vendorId });
  await insertInvoice({ clientId: clientB, vendorId: otherVendorId });
});

afterAll(async () => {
  await db.delete(invoicesTable).where(inArray(invoicesTable.clientId, [clientA, clientB]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, vendorUserId, parentUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, vendorUserId, parentUserId]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorId, otherVendorId]));
});

describe("GET /invoices auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/invoices");
    expect(res.status).toBe(401);
  });
});

describe("GET /invoices envelope + pagination", () => {
  it("returns an { items, total } envelope", async () => {
    const res = await get(staffCookie, { clientId: clientA, limit: 50 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe("number");
  });

  it("staff sees both invoices per client", async () => {
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

describe("GET /invoices SQL-level role scoping", () => {
  it("vendor users only see invoices for their own vendor", async () => {
    const res = await get(vendorCookie, { limit: 1000 });
    expect(res.status).toBe(200);
    for (const i of res.body.items) expect(i.vendorId).toBe(vendorId);
    const ids = res.body.items.map((i: { clientId: string }) => i.clientId);
    expect(ids).toContain(clientA);
    expect(ids).toContain(clientB);
  });

  it("vendor scoping cannot be widened by a clientId filter", async () => {
    // clientA has a no-vendor invoice, but the vendor user must never see it.
    const res = await get(vendorCookie, { clientId: clientA, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].vendorId).toBe(vendorId);
  });

  it("parent/self users only see their linked client's invoices", async () => {
    const res = await get(parentCookie, { limit: 1000 });
    expect(res.status).toBe(200);
    for (const i of res.body.items) expect(i.clientId).toBe(clientA);
  });

  it("parent scoping cannot be widened by a clientId filter for another client", async () => {
    const res = await get(parentCookie, { clientId: clientB, limit: 1000 });
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});

describe("GET /invoices filters", () => {
  it("filters by vendorId at the SQL level", async () => {
    const res = await get(staffCookie, { vendorId: otherVendorId, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].vendorId).toBe(otherVendorId);
    expect(res.body.items[0].clientId).toBe(clientB);
  });

  it("filters by status at the SQL level", async () => {
    const res = await get(staffCookie, { clientId: clientA, status: "approved", limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].status).toBe("approved");
  });
});
