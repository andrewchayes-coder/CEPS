import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  authorizationsTable,
  paymentsTable,
  remittancesTable,
  feesTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// GET-by-id detail endpoints for authorizations, payments, and remittances,
// including per-role ownership scoping that mirrors each list route. Follows the
// clients-family-edit / payments-list fixture conventions: unique per-run nonce,
// self-cleaning, direct-DB inserts.
const nonce = `detget${Date.now().toString(36)}`;

let staffId: string;
let coordId: string;
let vendorUserId: string;
let otherVendorUserId: string;
let parentUserId: string;
let otherParentUserId: string;

let vendorId: string;
let otherVendorId: string;
let clientA: string; // parent user's linked client, coordinator's caseload
let clientB: string; // a different client (other parent's linked client)

let authAId: string; // clientA + our vendor
let paymentAId: string; // clientA + our vendor
let remittanceAId: string; // clientA
let paymentBId: string; // clientB + other vendor
let remittanceBId: string; // clientB

let staffCookie: string;
let coordCookie: string;
let vendorCookie: string;
let otherVendorCookie: string;
let parentCookie: string;
let otherParentCookie: string;

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "DG Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [coord] = await db
    .insert(usersTable)
    .values({ name: "DG Coord", email: `${nonce}-coord@test.local`, role: "service_coordinator" })
    .returning();
  coordId = coord.id;

  const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor` }).returning();
  vendorId = vendor.id;
  const [otherVendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor2` }).returning();
  otherVendorId = otherVendor.id;

  const [ca] = await db
    .insert(clientsTable)
    .values({
      firstName: "DG",
      lastName: "ClientA",
      dateOfBirth: "2000-01-01",
      uciNumber: `${nonce}-uciA`,
      assignedCoordinatorId: coordId,
    })
    .returning();
  clientA = ca.id;
  const [cb] = await db
    .insert(clientsTable)
    .values({ firstName: "DG", lastName: "ClientB", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uciB` })
    .returning();
  clientB = cb.id;

  const [vendorUser] = await db
    .insert(usersTable)
    .values({
      name: "DG Vendor User",
      email: `${nonce}-vendoruser@test.local`,
      role: "vendor",
      linkedRecordType: "vendor",
      linkedRecordId: vendorId,
    })
    .returning();
  vendorUserId = vendorUser.id;

  const [otherVendorUser] = await db
    .insert(usersTable)
    .values({
      name: "DG Other Vendor User",
      email: `${nonce}-vendoruser2@test.local`,
      role: "vendor",
      linkedRecordType: "vendor",
      linkedRecordId: otherVendorId,
    })
    .returning();
  otherVendorUserId = otherVendorUser.id;

  const [parentUser] = await db
    .insert(usersTable)
    .values({
      name: "DG Parent User",
      email: `${nonce}-parentuser@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientA,
    })
    .returning();
  parentUserId = parentUser.id;

  const [otherParentUser] = await db
    .insert(usersTable)
    .values({
      name: "DG Other Parent User",
      email: `${nonce}-parentuser2@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientB,
    })
    .returning();
  otherParentUserId = otherParentUser.id;

  const [authA] = await db
    .insert(authorizationsTable)
    .values({
      clientId: clientA,
      vendorId,
      authNumber: `${nonce}-authA`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      maxPeriodAmount: "1000.00",
    })
    .returning();
  authAId = authA.id;

  const [paymentA] = await db
    .insert(paymentsTable)
    .values({
      clientId: clientA,
      vendorId,
      qbCheckNumber: `${nonce}-chkA`,
      checkDate: "2026-01-15",
      amount: "100.00",
      paymentType: "direct_payment",
      source: "manual",
    })
    .returning();
  paymentAId = paymentA.id;

  const [paymentB] = await db
    .insert(paymentsTable)
    .values({
      clientId: clientB,
      vendorId: otherVendorId,
      qbCheckNumber: `${nonce}-chkB`,
      checkDate: "2026-01-15",
      amount: "200.00",
      paymentType: "direct_payment",
      source: "manual",
    })
    .returning();
  paymentBId = paymentB.id;

  const [remittanceA] = await db
    .insert(remittancesTable)
    .values({ clientId: clientA, amount: "100.00", remittanceDate: "2026-01-20", status: "received", source: "alta_regional" })
    .returning();
  remittanceAId = remittanceA.id;

  const [remittanceB] = await db
    .insert(remittancesTable)
    .values({ clientId: clientB, amount: "200.00", remittanceDate: "2026-01-20", status: "received", source: "alta_regional" })
    .returning();
  remittanceBId = remittanceB.id;

  staffCookie = await session(staffId);
  coordCookie = await session(coordId);
  vendorCookie = await session(vendorUserId);
  otherVendorCookie = await session(otherVendorUserId);
  parentCookie = await session(parentUserId);
  otherParentCookie = await session(otherParentUserId);
});

afterAll(async () => {
  await db.delete(feesTable).where(inArray(feesTable.clientId, [clientA, clientB]));
  await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, [clientA, clientB]));
  await db.delete(remittancesTable).where(inArray(remittancesTable.clientId, [clientA, clientB]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientA, clientB]));
  await db
    .delete(sessionsTable)
    .where(inArray(sessionsTable.userId, [staffId, coordId, vendorUserId, otherVendorUserId, parentUserId, otherParentUserId]));
  // Clients reference the coordinator via assigned_coordinator_id FK, so delete
  // clients before the users they point at.
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
  await db
    .delete(usersTable)
    .where(inArray(usersTable.id, [staffId, coordId, vendorUserId, otherVendorUserId, parentUserId, otherParentUserId]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorId, otherVendorId]));
});

describe("GET /authorizations/:id", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get(`/api/authorizations/${authAId}`);
    expect(res.status).toBe(401);
  });

  it("staff sees the authorization with utilization + names", async () => {
    const res = await request(app).get(`/api/authorizations/${authAId}`).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(authAId);
    expect(res.body.clientId).toBe(clientA);
    expect(res.body.vendorId).toBe(vendorId);
    expect(res.body.clientName).toBe("DG ClientA");
    expect(typeof res.body.totalPaid).toBe("string");
  });

  it("coordinator can see an authorization for a client in their caseload", async () => {
    const res = await request(app).get(`/api/authorizations/${authAId}`).set("Cookie", coordCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(authAId);
  });

  it("the linked parent can see their client's authorization", async () => {
    const res = await request(app).get(`/api/authorizations/${authAId}`).set("Cookie", parentCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(authAId);
  });

  it("a different parent cannot see another client's authorization (403)", async () => {
    const res = await request(app).get(`/api/authorizations/${authAId}`).set("Cookie", otherParentCookie);
    expect(res.status).toBe(403);
  });

  it("the owning vendor can see the authorization", async () => {
    const res = await request(app).get(`/api/authorizations/${authAId}`).set("Cookie", vendorCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(authAId);
  });

  it("a different vendor cannot see the authorization (403)", async () => {
    const res = await request(app).get(`/api/authorizations/${authAId}`).set("Cookie", otherVendorCookie);
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app).get(`/api/authorizations/${randomUUID()}`).set("Cookie", staffCookie);
    expect(res.status).toBe(404);
  });
});

describe("GET /payments/:id", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get(`/api/payments/${paymentAId}`);
    expect(res.status).toBe(401);
  });

  it("staff sees the payment with enriched names", async () => {
    const res = await request(app).get(`/api/payments/${paymentAId}`).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(paymentAId);
    expect(res.body.clientId).toBe(clientA);
    expect(res.body.vendorId).toBe(vendorId);
    expect(res.body.clientName).toBe("DG ClientA");
  });

  it("coordinator can see a payment for a client in their caseload", async () => {
    const res = await request(app).get(`/api/payments/${paymentAId}`).set("Cookie", coordCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(paymentAId);
  });

  it("coordinator cannot see a payment for a client outside their caseload (403)", async () => {
    const res = await request(app).get(`/api/payments/${paymentBId}`).set("Cookie", coordCookie);
    expect(res.status).toBe(403);
  });

  it("the linked parent can see their client's payment", async () => {
    const res = await request(app).get(`/api/payments/${paymentAId}`).set("Cookie", parentCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(paymentAId);
  });

  it("a different parent cannot see another client's payment (403)", async () => {
    const res = await request(app).get(`/api/payments/${paymentAId}`).set("Cookie", otherParentCookie);
    expect(res.status).toBe(403);
  });

  it("the owning vendor can see the payment", async () => {
    const res = await request(app).get(`/api/payments/${paymentAId}`).set("Cookie", vendorCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(paymentAId);
  });

  it("a different vendor cannot see the payment (403)", async () => {
    const res = await request(app).get(`/api/payments/${paymentAId}`).set("Cookie", otherVendorCookie);
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app).get(`/api/payments/${randomUUID()}`).set("Cookie", staffCookie);
    expect(res.status).toBe(404);
  });
});

describe("GET /remittances/:id", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get(`/api/remittances/${remittanceAId}`);
    expect(res.status).toBe(401);
  });

  it("staff sees the remittance with enriched client name", async () => {
    const res = await request(app).get(`/api/remittances/${remittanceAId}`).set("Cookie", staffCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(remittanceAId);
    expect(res.body.clientId).toBe(clientA);
    expect(res.body.clientName).toBe("DG ClientA");
  });

  it("coordinator can see a remittance for a client in their caseload", async () => {
    const res = await request(app).get(`/api/remittances/${remittanceAId}`).set("Cookie", coordCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(remittanceAId);
  });

  it("coordinator cannot see a remittance for a client outside their caseload (403)", async () => {
    const res = await request(app).get(`/api/remittances/${remittanceBId}`).set("Cookie", coordCookie);
    expect(res.status).toBe(403);
  });

  it("the linked parent can see their client's remittance", async () => {
    const res = await request(app).get(`/api/remittances/${remittanceAId}`).set("Cookie", parentCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(remittanceAId);
  });

  it("a different parent cannot see another client's remittance (403)", async () => {
    const res = await request(app).get(`/api/remittances/${remittanceAId}`).set("Cookie", otherParentCookie);
    expect(res.status).toBe(403);
  });

  it("vendors have no visibility into remittances (403)", async () => {
    const res = await request(app).get(`/api/remittances/${remittanceAId}`).set("Cookie", vendorCookie);
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app).get(`/api/remittances/${randomUUID()}`).set("Cookie", staffCookie);
    expect(res.status).toBe(404);
  });
});
