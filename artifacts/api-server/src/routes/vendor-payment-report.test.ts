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
let coordinatorId: string;
let otherClientId: string;
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

async function insertPayment(vendorId: string, amount: string, opts: { clientId?: string; checkDate?: string } = {}) {
  const [p] = await db
    .insert(paymentsTable)
    .values({
      clientId: opts.clientId ?? clientId,
      vendorId,
      qbCheckNumber: `${nonce}-chk-${checkCounter++}`,
      checkDate: opts.checkDate ?? `${year}-03-15`,
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
  const [coordinator] = await db.insert(usersTable).values({ name: "VPR Coordinator", email: `${nonce}-coordinator@test.local`, role: "service_coordinator" }).returning();
  coordinatorId = coordinator.id;
  await db.update(clientsTable).set({ assignedCoordinatorId: coordinatorId }).where(inArray(clientsTable.id, [clientId]));
  const [otherClient] = await db.insert(clientsTable).values({ firstName: "VPR", lastName: "Other", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uci-other` }).returning();
  otherClientId = otherClient.id;

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
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorA, vendorB]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientId, otherClientId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, vendorUserAId, parentUserId, coordinatorId]));
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

  it("applies vendor, date, client, and coordinator filters before SQL aggregation", async () => {
    await insertPayment(vendorA, "25.00", { checkDate: `${year}-05-01` });
    await insertPayment(vendorA, "75.00", { clientId: otherClientId, checkDate: `${year}-05-15` });
    const res = await request(app).get("/api/reports/vendor-payments")
      .query({ vendorId: vendorA, clientId, coordinatorId, startDate: `${year}-05-01`, endDate: `${year}-05-31` })
      .set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ vendorId: vendorA, totalPaid: "25.00", paymentCount: 1 });
  });

  it("uses allTime to include payment history outside the default current year", async () => {
    await insertPayment(vendorA, "200.00", { checkDate: `${year - 1}-03-15` });

    const ytd = await request(app).get("/api/reports/vendor-payments")
      .query({ vendorId: vendorA, clientId })
      .set("Cookie", staffCookie);
    expect(ytd.status).toBe(200);
    expect(ytd.body).toHaveLength(1);
    expect(ytd.body[0]).toMatchObject({ vendorId: vendorA, totalPaid: "175.00", paymentCount: 3 });

    const allTime = await request(app).get("/api/reports/vendor-payments")
      .query({ vendorId: vendorA, clientId, allTime: "true" })
      .set("Cookie", staffCookie);
    expect(allTime.status).toBe(200);
    expect(allTime.body).toHaveLength(1);
    expect(allTime.body[0]).toMatchObject({ vendorId: vendorA, totalPaid: "375.00", paymentCount: 4 });
  });
});
