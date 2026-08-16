import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  paymentsTable,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

// GET /reports/vendor-payments role scoping:
//   - staff: all vendors
//   - vendor user: only their own vendor row (scoped by linkedRecordId)
//   - other roles (parent/guardian): empty report
const nonce = `vpr${Date.now().toString(36)}`;
const year = new Date().getFullYear();

let staffId: string;
let vendorUserAId: string;
let parentUserId: string;
let clientId: string;
let vendorA: string;
let vendorB: string;
let staffCookie: string;
let vendorACookie: string;
let parentCookie: string;
const paymentIds: string[] = [];
let checkCounter = 0;

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

async function insertPayment(vendorId: string, amount: string) {
  const [p] = await db
    .insert(paymentsTable)
    .values({
      clientId,
      vendorId,
      qbCheckNumber: `${nonce}-chk-${checkCounter++}`,
      checkDate: `${year}-03-15`,
      amount,
      paymentType: "direct_payment",
      source: "manual",
    })
    .returning();
  paymentIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "VPR Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [client] = await db
    .insert(clientsTable)
    .values({ firstName: "VPR", lastName: "Client", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uci` })
    .returning();
  clientId = client.id;

  const [vA] = await db
    .insert(vendorsTable)
    .values({ name: `${nonce}-vendorA`, active: true, w9Status: "on_file", ein: "12-3456789" })
    .returning();
  vendorA = vA.id;
  const [vB] = await db
    .insert(vendorsTable)
    .values({ name: `${nonce}-vendorB`, active: true, w9Status: "on_file" })
    .returning();
  vendorB = vB.id;

  const [vendorUser] = await db
    .insert(usersTable)
    .values({
      name: "VPR VendorA User",
      email: `${nonce}-vendorA@test.local`,
      role: "vendor",
      linkedRecordType: "vendor",
      linkedRecordId: vendorA,
    })
    .returning();
  vendorUserAId = vendorUser.id;

  const [parentUser] = await db
    .insert(usersTable)
    .values({
      name: "VPR Parent",
      email: `${nonce}-parent@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientId,
    })
    .returning();
  parentUserId = parentUser.id;

  staffCookie = await session(staffId);
  vendorACookie = await session(vendorUserAId);
  parentCookie = await session(parentUserId);

  // vendorA: two payments; vendorB: one payment.
  await insertPayment(vendorA, "100.00");
  await insertPayment(vendorA, "50.00");
  await insertPayment(vendorB, "999.00");
});

afterAll(async () => {
  if (paymentIds.length) await db.delete(paymentsTable).where(inArray(paymentsTable.id, paymentIds));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, vendorUserAId, parentUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, vendorUserAId, parentUserId]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorA, vendorB]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientId]));
});

describe("GET /reports/vendor-payments role scoping", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/reports/vendor-payments").query({ year });
    expect(res.status).toBe(401);
  });

  it("staff see all vendors", async () => {
    const res = await request(app).get("/api/reports/vendor-payments").query({ year }).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.vendorId);
    expect(ids).toContain(vendorA);
    expect(ids).toContain(vendorB);
  });

  it("a vendor user sees only their own vendor row with correct totals", async () => {
    const res = await request(app).get("/api/reports/vendor-payments").query({ year }).set("Cookie", vendorACookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].vendorId).toBe(vendorA);
    expect(res.body[0].totalPaid).toBe("150.00");
    expect(res.body[0].paymentCount).toBe(2);
    // vendorB never appears for vendorA's user.
    expect(res.body.some((r: any) => r.vendorId === vendorB)).toBe(false);
  });

  it("other roles (parent/guardian) get an empty report", async () => {
    const res = await request(app).get("/api/reports/vendor-payments").query({ year }).set("Cookie", parentCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });
});
