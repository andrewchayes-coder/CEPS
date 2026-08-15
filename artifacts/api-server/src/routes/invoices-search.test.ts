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
  invoicesTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// Tests for the `search` query param on GET /invoices.
// The search applies ilike subqueries against client name, vendor name, and
// auth number. Wildcard characters must be escaped so they do not break the
// query. Page-reset behaviour is verified by confirming offset still works
// correctly when a search term is active.
const nonce = `ivsrch${Date.now().toString(36)}`;

let staffId: string;
let staffCookie: string;
let vendorId: string;
let otherVendorId: string;
let clientAlpha: string; // "Alpha" client
let clientBeta: string;  // "Beta" client
let authId: string;      // auth_number contains nonce for isolation

const createdInvoiceIds: string[] = [];

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

let monthSeed = 1;
const nextMonth = () => `2025-${String((monthSeed++ % 12) + 1).padStart(2, "0")}`;

async function insertInvoice(opts: {
  clientId: string;
  vendorId?: string | null;
  authorizationId?: string | null;
}) {
  const [i] = await db
    .insert(invoicesTable)
    .values({
      clientId: opts.clientId,
      vendorId: opts.vendorId ?? null,
      authorizationId: opts.authorizationId ?? null,
      submittedByRole: "staff",
      submittedDate: "2025-01-15",
      serviceMonth: nextMonth(),
      amountRequested: "100.00",
      paymentType: "direct_payment",
      status: "pending_review",
    })
    .returning();
  createdInvoiceIds.push(i.id);
  return i;
}

async function get(qs: Record<string, string | number>) {
  return request(app).get("/api/invoices").query(qs).set("Cookie", staffCookie);
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "ISrch Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  staffCookie = await session(staffId);

  // Two vendors with distinct names
  const [v1] = await db.insert(vendorsTable).values({ name: `${nonce}-VendorAlpha` }).returning();
  vendorId = v1.id;
  const [v2] = await db.insert(vendorsTable).values({ name: `${nonce}-VendorBeta` }).returning();
  otherVendorId = v2.id;

  // Two clients: "Alpha Search Client" and "Beta Search Client"
  const [ca] = await db
    .insert(clientsTable)
    .values({ firstName: `${nonce}Alpha`, lastName: "SearchClient", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciA` })
    .returning();
  clientAlpha = ca.id;

  const [cb] = await db
    .insert(clientsTable)
    .values({ firstName: `${nonce}Beta`, lastName: "SearchClient", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciB` })
    .returning();
  clientBeta = cb.id;

  // One authorization with a unique auth number
  const [auth] = await db
    .insert(authorizationsTable)
    .values({
      clientId: clientAlpha,
      authNumber: `SRCH-${nonce}`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2025-01-01",
      servicePeriodEnd: "2027-01-01",
      maxPeriodAmount: "5000.00",
      status: "active",
    })
    .returning();
  authId = auth.id;

  // Invoice matrix:
  //  inv1: clientAlpha + VendorAlpha + auth  (matches on client, vendor, auth number)
  //  inv2: clientAlpha + VendorBeta + no auth (matches on client, vendorBeta)
  //  inv3: clientBeta  + VendorAlpha          (matches on vendorAlpha, clientBeta)
  await insertInvoice({ clientId: clientAlpha, vendorId, authorizationId: authId });
  await insertInvoice({ clientId: clientAlpha, vendorId: otherVendorId });
  await insertInvoice({ clientId: clientBeta, vendorId });
});

afterAll(async () => {
  if (createdInvoiceIds.length) {
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, createdInvoiceIds));
  }
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientAlpha, clientBeta]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientAlpha, clientBeta]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorId, otherVendorId]));
});

describe("GET /invoices ?search — client name", () => {
  it("returns invoices whose client name matches the search term", async () => {
    const res = await get({ search: `${nonce}Alpha`, limit: 1000 });
    expect(res.status).toBe(200);
    // clientAlpha has 2 invoices
    expect(res.body.total).toBe(2);
    for (const inv of res.body.items) expect(inv.clientId).toBe(clientAlpha);
  });

  it("excludes invoices whose client name does not match", async () => {
    const res = await get({ search: `${nonce}Beta`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].clientId).toBe(clientBeta);
  });

  it("returns empty set when client name search matches nothing", async () => {
    const res = await get({ search: `${nonce}NOMATCH_XYZ`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});

describe("GET /invoices ?search — vendor name", () => {
  it("returns invoices whose vendor name matches the search term", async () => {
    const res = await get({ search: `${nonce}-VendorAlpha`, limit: 1000 });
    expect(res.status).toBe(200);
    // VendorAlpha appears on inv1 (clientAlpha) and inv3 (clientBeta)
    expect(res.body.total).toBe(2);
    for (const inv of res.body.items) expect(inv.vendorId).toBe(vendorId);
  });

  it("excludes invoices for a different vendor", async () => {
    const res = await get({ search: `${nonce}-VendorBeta`, limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].vendorId).toBe(otherVendorId);
  });
});

describe("GET /invoices ?search — authorization number", () => {
  it("returns invoices linked to an auth whose number matches the search term", async () => {
    const res = await get({ search: `SRCH-${nonce}`, limit: 1000 });
    expect(res.status).toBe(200);
    // Only inv1 is linked to the auth
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].authorizationId).toBe(authId);
  });
});

describe("GET /invoices ?search — wildcard escaping", () => {
  it("treats % in the search term literally (does not match everything)", async () => {
    const res = await get({ search: "%", limit: 1000 });
    expect(res.status).toBe(200);
    // No client/vendor/auth contains a literal '%', so zero results from our fixture
    expect(res.body.total).toBe(0);
  });

  it("treats _ in the search term literally (does not act as a single-char wildcard)", async () => {
    // A bare underscore would match any single char and could blow up large tables.
    // With proper escaping it should match nothing from our isolated fixture.
    const res = await get({ search: "_", limit: 1000 });
    expect(res.status).toBe(200);
    // None of our fixture client/vendor/auth names contain a literal '_'
    expect(res.body.total).toBe(0);
  });

  it("does not throw a 500 when the search term contains SQL wildcard characters", async () => {
    const res = await get({ search: "% OR 1=1 --", limit: 1000 });
    expect(res.status).toBe(200); // query must not error out
  });
});

describe("GET /invoices ?search — offset interaction (page reset)", () => {
  it("returns matching items at offset 0", async () => {
    const res = await get({ search: `${nonce}Alpha`, limit: 1, offset: 0 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(2);
  });

  it("returns the correct second page for a search term", async () => {
    const first = await get({ search: `${nonce}Alpha`, limit: 1, offset: 0 });
    const second = await get({ search: `${nonce}Alpha`, limit: 1, offset: 1 });
    expect(second.body.total).toBe(2);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it("returns empty items (but correct total) when offset exceeds matches", async () => {
    const res = await get({ search: `${nonce}Alpha`, limit: 10, offset: 100 });
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(2);
  });
});
