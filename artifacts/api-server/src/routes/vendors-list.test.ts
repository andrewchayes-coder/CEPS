import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db, usersTable, sessionsTable, vendorsTable } from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// SQL-level list pagination + role scoping for GET /vendors (Prompt 6).
const nonce = `vnls${Date.now().toString(36)}`;

let staffId: string;
let vendorUserId: string;
let vendorA: string; // preferred, active, on_file, name "...Alpha"
let vendorB: string; // not preferred, inactive, pending, name "...Bravo"
let vendorC: string; // not preferred, active, pending, name "...Charlie"
let staffCookie: string;
let vendorCookie: string;

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

async function get(cookie: string, qs: Record<string, string | number | boolean>) {
  return request(app).get("/api/vendors").query(qs).set("Cookie", cookie);
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "VN Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [va] = await db
    .insert(vendorsTable)
    .values({ name: `${nonce}Alpha`, preferred: true, active: true, w9Status: "on_file" })
    .returning();
  vendorA = va.id;
  const [vb] = await db
    .insert(vendorsTable)
    .values({ name: `${nonce}Bravo`, preferred: false, active: false, w9Status: "pending" })
    .returning();
  vendorB = vb.id;
  const [vc] = await db
    .insert(vendorsTable)
    .values({ name: `${nonce}Charlie`, preferred: false, active: true, w9Status: "pending" })
    .returning();
  vendorC = vc.id;

  const [vendorUser] = await db
    .insert(usersTable)
    .values({
      name: "VN Vendor User",
      email: `${nonce}-vendoruser@test.local`,
      role: "vendor",
      linkedRecordType: "vendor",
      linkedRecordId: vendorA,
    })
    .returning();
  vendorUserId = vendorUser.id;

  staffCookie = await session(staffId);
  vendorCookie = await session(vendorUserId);
});

afterAll(async () => {
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, vendorUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, vendorUserId]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorA, vendorB, vendorC]));
});

describe("GET /vendors auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/vendors");
    expect(res.status).toBe(401);
  });
});

describe("GET /vendors envelope + pagination", () => {
  it("returns an { items, total } envelope", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 50 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe("number");
  });

  it("staff sees all three of this run's vendors (isolated by search nonce)", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 1000 });
    expect(res.body.total).toBe(3);
  });

  it("paginates with a stable total and SQL limit/offset", async () => {
    const first = await get(staffCookie, { search: nonce, limit: 1, offset: 0 });
    expect(first.body.total).toBe(3);
    expect(first.body.items).toHaveLength(1);
    const second = await get(staffCookie, { search: nonce, limit: 1, offset: 1 });
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it("offset beyond the result set returns empty items but the real total", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 10, offset: 100 });
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(3);
  });

  it("clamps limit to at least 1", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 0 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(3);
  });

  it("clamps negative offset to 0", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 1, offset: -10 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("orders preferred first, then alphabetically by name", async () => {
    const res = await get(staffCookie, { search: nonce, limit: 1000 });
    // Alpha (preferred) first, then Bravo, then Charlie by name.
    expect(res.body.items[0].id).toBe(vendorA);
    expect(res.body.items[1].id).toBe(vendorB);
    expect(res.body.items[2].id).toBe(vendorC);
  });
});

describe("GET /vendors SQL-level role scoping", () => {
  it("vendor users only see their own vendor record", async () => {
    const res = await get(vendorCookie, { search: nonce, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(vendorA);
  });

  it("vendor scoping cannot be widened by a w9Status filter", async () => {
    // vendorB/C are pending, but the vendor user (own record: Alpha) must not see them.
    const res = await get(vendorCookie, { search: nonce, w9Status: "pending", limit: 1000 });
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});

describe("GET /vendors filters", () => {
  it("filters by w9Status at the SQL level", async () => {
    const res = await get(staffCookie, { search: nonce, w9Status: "on_file", limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(vendorA);
  });

  it("filters by active at the SQL level", async () => {
    // NB: the generated ListVendorsQueryParams uses zod.coerce.boolean(), which
    // treats any non-empty string as true — so only `active=true` is expressible
    // over a querystring. It must exclude the inactive vendor (Bravo).
    const res = await get(staffCookie, { search: nonce, active: true, limit: 1000 });
    expect(res.body.total).toBe(2);
    const ids = res.body.items.map((v: { id: string }) => v.id);
    expect(ids).toContain(vendorA);
    expect(ids).toContain(vendorC);
    expect(ids).not.toContain(vendorB);
  });

  it("search matches the vendor name (ilike) at the SQL level", async () => {
    const res = await get(staffCookie, { search: `${nonce}Charlie`, limit: 1000 });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(vendorC);
  });
});
