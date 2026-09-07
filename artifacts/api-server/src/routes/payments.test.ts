import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import {
  db, usersTable, sessionsTable, clientsTable, paymentsTable, feesTable, auditLogTable,
  authorizationsTable, invoicesTable, vendorsTable, remittancesTable,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `pay${Date.now().toString(36)}`;
const INTERIM_FEE_RULE = "interim_flat_percent_5_pending_confirmation";

let staffId: string;
let clientId: string;
let otherClientId: string;
let cookie: string;
let checkCounter = 0;

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "Pay Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [client] = await db
    .insert(clientsTable)
    .values({ firstName: "Pay", lastName: "Client", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uci` })
    .returning();
  clientId = client.id;
  const [otherClient] = await db
    .insert(clientsTable)
    .values({ firstName: "Other", lastName: "Participant", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-other-uci` })
    .returning();
  otherClientId = otherClient.id;

  const token = newToken();
  await db.insert(sessionsTable).values({
    userId: staffId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  cookie = `ceps_session=${token}`;
});

afterAll(async () => {
  await db.delete(feesTable).where(eq(feesTable.clientId, clientId));
  await db.delete(remittancesTable).where(inArray(remittancesTable.clientId, [clientId, otherClientId]));
  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, clientId));
  await db.delete(invoicesTable).where(inArray(invoicesTable.clientId, [clientId, otherClientId]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientId, otherClientId]));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientId, otherClientId]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.name, [`${nonce}-valid-vendor`, `${nonce}-other-vendor`, `${nonce}-other-vendor-2`]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId]));
});

// Create a payment via the API so its interim fee is auto-generated.
async function createPayment(amount: string) {
  const qb = `${nonce}-chk-${checkCounter++}`;
  const res = await request(app)
    .post("/api/payments")
    .set("Cookie", cookie)
    .send({ clientId, qbCheckNumber: qb, checkDate: "2026-01-15", amount, paymentType: "direct_payment" });
  expect(res.status).toBe(201);
  return res.body as { id: string; amount: string };
}

async function linkedFees(paymentId: string) {
  return db
    .select()
    .from(feesTable)
    .where(and(eq(feesTable.paymentId, paymentId), eq(feesTable.isDeleted, false)));
}

describe("PATCH /payments/:id fee recalculation", () => {
  it("recalculates the interim fee when the amount changes", async () => {
    const p = await createPayment("100.00");
    const [feeBefore] = await linkedFees(p.id);
    expect(feeBefore.amount).toBe("5.00");
    expect(feeBefore.ruleApplied).toBe(INTERIM_FEE_RULE);

    const res = await request(app)
      .patch(`/api/payments/${p.id}`)
      .set("Cookie", cookie)
      .send({ amount: "200.00" });
    expect(res.status).toBe(200);
    const [feeAfter] = await linkedFees(p.id);
    expect(feeAfter.amount).toBe("10.00");
  });

  it("does NOT recalculate a waived fee", async () => {
    const p = await createPayment("100.00");
    const [fee] = await linkedFees(p.id);
    await db.update(feesTable).set({ status: "waived", amount: "0.00" }).where(eq(feesTable.id, fee.id));

    const res = await request(app)
      .patch(`/api/payments/${p.id}`)
      .set("Cookie", cookie)
      .send({ amount: "400.00" });
    expect(res.status).toBe(200);
    const [feeAfter] = await linkedFees(p.id);
    expect(feeAfter.amount).toBe("0.00");
  });

  it("does NOT touch a fee on a non-interim rule", async () => {
    const p = await createPayment("100.00");
    const [fee] = await linkedFees(p.id);
    await db.update(feesTable).set({ ruleApplied: "manual_override", amount: "42.00" }).where(eq(feesTable.id, fee.id));

    const res = await request(app)
      .patch(`/api/payments/${p.id}`)
      .set("Cookie", cookie)
      .send({ amount: "500.00" });
    expect(res.status).toBe(200);
    const [feeAfter] = await linkedFees(p.id);
    expect(feeAfter.amount).toBe("42.00");
  });
});

describe("financial PATCH participant links", () => {
  async function makeAuthorization(ownerId: string, vendorId?: string) {
    const [auth] = await db.insert(authorizationsTable).values({
      clientId: ownerId,
      vendorId: vendorId ?? null,
      authNumber: `${nonce}-auth-${checkCounter++}`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2099-12-31",
      maxPeriodAmount: "1000.00",
      status: "active",
    }).returning();
    return auth;
  }

  it("accepts valid effective payment links", async () => {
    const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-valid-vendor`, active: true }).returning();
    const auth = await makeAuthorization(clientId, vendor.id);
    const [invoice] = await db.insert(invoicesTable).values({
      clientId, authorizationId: auth.id, vendorId: vendor.id, submittedByRole: "staff",
      submittedDate: "2026-01-01", serviceMonth: "2026-01", amountRequested: "100.00",
      paymentType: "direct_payment", status: "pending_review",
    }).returning();
    const payment = await createPayment("100.00");
    const res = await request(app).patch(`/api/payments/${payment.id}`).set("Cookie", cookie)
      .send({ authorizationId: auth.id, invoiceId: invoice.id, vendorId: vendor.id });
    expect(res.status).toBe(200);
    expect(res.body.authorizationId).toBe(auth.id);
    expect(res.body.invoiceId).toBe(invoice.id);
    expect(res.body.vendorId).toBe(vendor.id);
  });

  it("rejects cross-participant payment links before changing the payment or fee", async () => {
    const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-other-vendor-2`, active: true }).returning();
    const auth = await makeAuthorization(otherClientId, vendor.id);
    const [invoice] = await db.insert(invoicesTable).values({
      clientId: otherClientId, authorizationId: auth.id, vendorId: vendor.id, submittedByRole: "staff",
      submittedDate: "2026-01-01", serviceMonth: "2026-01", amountRequested: "100.00",
      paymentType: "direct_payment", status: "pending_review",
    }).returning();
    const payment = await createPayment("100.00");
    const [feeBefore] = await linkedFees(payment.id);
    const res = await request(app).patch(`/api/payments/${payment.id}`).set("Cookie", cookie)
      .send({ authorizationId: auth.id, invoiceId: invoice.id, vendorId: vendor.id, amount: "200.00" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("belong to clientId");
    const [unchanged] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id));
    const [feeAfter] = await linkedFees(payment.id);
    expect(unchanged.amount).toBe("100.00");
    expect(unchanged.authorizationId).toBeNull();
    expect(feeAfter.amount).toBe(feeBefore.amount);
  });

  it("rejects a cross-participant invoice when the authorization is unchanged", async () => {
    const auth = await makeAuthorization(otherClientId);
    const [invoice] = await db.insert(invoicesTable).values({
      clientId: otherClientId, authorizationId: auth.id, submittedByRole: "staff",
      submittedDate: "2026-01-01", serviceMonth: "2026-01", amountRequested: "100.00",
      paymentType: "direct_payment", status: "pending_review",
    }).returning();
    const payment = await createPayment("100.00");
    const res = await request(app).patch(`/api/payments/${payment.id}`).set("Cookie", cookie)
      .send({ invoiceId: invoice.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invoiceId must belong to clientId");
  });

  it("rejects a vendor associated only with another participant", async () => {
    const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-other-vendor`, active: true }).returning();
    await makeAuthorization(otherClientId, vendor.id);
    const payment = await createPayment("100.00");
    const res = await request(app).patch(`/api/payments/${payment.id}`).set("Cookie", cookie)
      .send({ vendorId: vendor.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("vendorId must already be associated with clientId");
  });

  it("validates the effective remittance authorization", async () => {
    const ownAuth = await makeAuthorization(clientId);
    const otherAuth = await makeAuthorization(otherClientId);
    const [remittance] = await db.insert(remittancesTable).values({
      clientId, authorizationId: ownAuth.id, remittanceDate: "2026-01-15",
      amount: "100.00", status: "received", source: "manual",
    }).returning();
    const valid = await request(app).patch(`/api/remittances/${remittance.id}`).set("Cookie", cookie)
      .send({ authorizationId: ownAuth.id, altaReference: "valid-edit" });
    expect(valid.status).toBe(200);
    const invalid = await request(app).patch(`/api/remittances/${remittance.id}`).set("Cookie", cookie)
      .send({ authorizationId: otherAuth.id, amount: "200.00" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("belong to clientId");
    const [unchanged] = await db.select().from(remittancesTable).where(eq(remittancesTable.id, remittance.id));
    expect(unchanged.authorizationId).toBe(ownAuth.id);
    expect(unchanged.amount).toBe("100.00");
  });
});

describe("autoGenerateFee decimal-safe 5% calculation", () => {
  // Numbers chosen so Number(amount) * 0.05 drifts off the exact cent value.
  it("computes the fee exactly for a float-drift-prone amount (0.10)", async () => {
    // 0.10 * 0.05 = 0.005 → rounds to 0.01; naive float gives 0.005000000...
    const p = await createPayment("0.10");
    const [fee] = await linkedFees(p.id);
    expect(fee.amount).toBe("0.01");
  });

  it("computes the fee exactly for 20.15 (float product = 1.0074999999...)", async () => {
    // 20.15 * 0.05 = 1.0075 → half-up rounds to 1.01; binary float underflows to 1.007499...
    const p = await createPayment("20.15");
    const [fee] = await linkedFees(p.id);
    expect(fee.amount).toBe("1.01");
  });

  it("recalculates the fee exactly on a float-drift-prone amount change", async () => {
    const p = await createPayment("100.00");
    const [feeBefore] = await linkedFees(p.id);
    expect(feeBefore.amount).toBe("5.00");

    const res = await request(app)
      .patch(`/api/payments/${p.id}`)
      .set("Cookie", cookie)
      .send({ amount: "20.15" });
    expect(res.status).toBe(200);
    const [feeAfter] = await linkedFees(p.id);
    expect(feeAfter.amount).toBe("1.01");
  });
});

describe("DELETE /payments/:id cascade soft-delete", () => {
  it("soft-deletes the linked fee alongside the payment", async () => {
    const p = await createPayment("100.00");
    expect((await linkedFees(p.id)).length).toBe(1);

    const res = await request(app).delete(`/api/payments/${p.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect((await linkedFees(p.id)).length).toBe(0);
    const [feeRow] = await db.select().from(feesTable).where(eq(feesTable.paymentId, p.id));
    expect(feeRow.isDeleted).toBe(true);
    expect(feeRow.deletedBy).toBe(staffId);
  });
});
