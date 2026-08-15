import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  remittancesTable,
} from "@workspace/db";
import app from "../app";
import request from "supertest";
import { newToken } from "../lib/auth";

// SQL-level list pagination + role scoping for GET /remittances (Prompt 6).
// Mirrors payments-list.test.ts. Vendors have no visibility into remittances.
const nonce = `remls${Date.now().toString(36)}`;

let staffId: string;
let vendorUserId: string;
let parentUserId: string;
let vendorId: string;
let clientA: string; // the parent user's linked client
let clientB: string; // a different client
let staffCookie: string;
let vendorCookie: string;
let parentCookie: string;

let refCounter = 0;
const nextRef = () => `${nonce}-ref-${refCounter++}`;

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

async function insertRemittance(opts: { clientId: string; status?: string }) {
  const [r] = await db
    .insert(remittancesTable)
    .values({
      clientId: opts.clientId,
      altaReference: nextRef(),
      remittanceDate: "2026-01-15",
      amount: "100.00",
      status: opts.status ?? "received",
      source: "manual",
    })
    .returning();
  return r;
}

async function get(cookie: string, qs: Record<string, string | number>) {
  return request(app).get("/api/remittances").query(qs).set("Cookie", cookie);
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "RL Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor` }).returning();
  vendorId = vendor.id;

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

  const [vendorUser] = await db
    .insert(usersTable)
    .values({
      name: "RL Vendor User",
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
      name: "RL Parent User",
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

  // Remittance matrix:
  //  - clientA x2 (one matched)  (visible to parentUser)
  //  - clientB x2                (visible to neither parent nor vendor)
  await insertRemittance({ clientId: clientA, status: "matched" });
  await insertRemittance({ clientId: clientA, status: "received" });
  await insertRemittance({ clientId: clientB, status: "received" });
  await insertRemittance({ clientId: clientB, status: "received" });
});

afterAll(async () => {
  await db.delete(remittancesTable).where(inArray(remittancesTable.clientId, [clientA, clientB]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, vendorUserId, parentUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, vendorUserId, parentUserId]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorId]));
});

describe("GET /remittances auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/remittances");
    expect(res.status).toBe(401);
  });
});

describe("GET /remittances envelope + pagination", () => {
  it("returns an { items, total } envelope", async () => {
    const res = await get(staffCookie, { clientId: clientA, limit: 50 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe("number");
  });

  it("staff sees both remittances per client", async () => {
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

describe("GET /remittances SQL-level role scoping", () => {
  it("vendor users see no remittances even with a clientId filter", async () => {
    const res = await get(vendorCookie, { limit: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
    const scoped = await get(vendorCookie, { clientId: clientA, limit: 1000 });
    expect(scoped.body.total).toBe(0);
    expect(scoped.body.items).toEqual([]);
  });

  it("parent/self users only see their linked client's remittances", async () => {
    const res = await get(parentCookie, { limit: 1000 });
    expect(res.status).toBe(200);
    for (const r of res.body.items) expect(r.clientId).toBe(clientA);
  });

  it("parent scoping cannot be widened by a clientId filter for another client", async () => {
    const res = await get(parentCookie, { clientId: clientB, limit: 1000 });
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});

describe("GET /remittances filters", () => {
  it("filters by status at the SQL level", async () => {
    const res = await get(staffCookie, { clientId: clientA, status: "matched", limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].status).toBe("matched");
  });
});
