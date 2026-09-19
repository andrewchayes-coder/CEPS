import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import {
  db, usersTable, sessionsTable, clientsTable, paymentsTable, feesTable, auditLogTable,
  authorizationsTable, paymentAllocationsTable, invoicesTable, invoiceLineItemsTable, vendorsTable, remittancesTable, staffPermissionsTable,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `pay${Date.now().toString(36)}`;
const MONTHLY_FEE_RULE = "flat_160_per_client_month";

let staffId: string;
let clientId: string;
let otherClientId: string;
let authId: string;
let otherAuthId: string;
let cookie: string;
let checkCounter = 0;

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "Pay Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  await db.insert(staffPermissionsTable).values({ userId: staffId, permission: "check_writing" });

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
  const [auth] = await db.insert(authorizationsTable).values({
    clientId, authNumber: `${nonce}-auth`, serviceCode: "TEST", paymentType: "direct_payment",
    servicePeriodStart: "2026-01-01", servicePeriodEnd: "2029-12-31", maxPeriodAmount: "100000.00", status: "active",
  }).returning();
  authId = auth.id;
  const [otherAuth] = await db.insert(authorizationsTable).values({
    clientId: otherClientId, authNumber: `${nonce}-other-auth`, serviceCode: "TEST", paymentType: "direct_payment",
    servicePeriodStart: "2026-01-01", servicePeriodEnd: "2029-12-31", maxPeriodAmount: "100000.00", status: "active",
  }).returning();
  otherAuthId = otherAuth.id;

  const token = newToken();
  await db.insert(sessionsTable).values({
    userId: staffId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  cookie = `ceps_session=${token}`;
});
afterAll(async () => {
  await db.delete(feesTable).where(inArray(feesTable.clientId, [clientId, otherClientId]));
  await db.delete(remittancesTable).where(inArray(remittancesTable.clientId, [clientId, otherClientId]));
  await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, [clientId, otherClientId]));
  await db.delete(invoicesTable).where(inArray(invoicesTable.clientId, [clientId, otherClientId]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientId, otherClientId]));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(staffPermissionsTable).where(eq(staffPermissionsTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientId, otherClientId]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.name, [`${nonce}-valid-vendor`, `${nonce}-other-vendor`, `${nonce}-other-vendor-2`, `${nonce}-reconcile-vendor`]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId]));
});

async function createPayment(amount: string, checkDate = "2026-01-15", paymentType = "direct_payment", ownerId = clientId) {
  const qb = `${nonce}-chk-${checkCounter++}`;
  const [testAuth] = await db.insert(authorizationsTable).values({
    clientId: ownerId, authNumber: `${nonce}-payment-${checkCounter}`, serviceCode: "TEST",
    paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2029-12-31",
    maxPeriodAmount: "100000.00", status: "active",
  }).returning();
  const res = await request(app)
    .post("/api/payments")
    .set("Cookie", cookie)
    .send({ clientId: ownerId, qbCheckNumber: qb, checkDate, amount, paymentType,
      allocations: [{ authorizationId: testAuth.id, amount }] });
  expect(res.status).toBe(201);
  return res.body as { id: string; amount: string; paymentMonth: string };
}

async function monthlyFees(feeMonth: string, ownerId = clientId) {
  return db
    .select()
    .from(feesTable)
    .where(and(
      eq(feesTable.clientId, ownerId),
      eq(feesTable.feeMonth, feeMonth),
      eq(feesTable.isDeleted, false),
    ));
}

describe("monthly payment fees", () => {
  it("creates one flat monthly fee with trigger traceability and an audit entry", async () => {
    const payment = await createPayment("100.00", "2026-03-15");
    const fees = await monthlyFees("2026-03");
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({
      amount: "160.00",
      ruleApplied: MONTHLY_FEE_RULE,
      feeMonth: "2026-03",
      paymentId: payment.id,
    });
    const feeAudits = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.userId, staffId),
      eq(auditLogTable.action, "auto_generate_fee"),
      eq(auditLogTable.entityId, fees[0].id),
    ));
    expect(feeAudits).toHaveLength(1);
  });

  it("keeps one fee and the original trigger for a second same-month payment", async () => {
    const first = await createPayment("100.00", "2026-04-15");
    const second = await createPayment("200.00", "2026-04-20");
    const fees = await monthlyFees("2026-04");
    expect(fees).toHaveLength(1);
    expect(fees[0].paymentId).toBe(first.id);
    expect(second.id).not.toBe(first.id);
  });

  it("qualifies reimbursements but excludes fee-type payments", async () => {
    await createPayment("100.00", "2026-05-15");
    await createPayment("100.00", "2026-06-15", "reimbursement");
    await createPayment("160.00", "2026-12-15", "fee");
    expect(await monthlyFees("2026-05")).toHaveLength(1);
    expect(await monthlyFees("2026-06")).toHaveLength(1);
    expect(await monthlyFees("2026-12")).toHaveLength(0);
  });

  it("does not reconcile an existing fee when a fee-type payment is created", async () => {
    const qualifying = await createPayment("100.00", "2027-05-15");
    const [existingFee] = await monthlyFees("2027-05");
    await db.update(paymentsTable).set({
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: staffId,
    }).where(eq(paymentsTable.id, qualifying.id));

    await createPayment("160.00", "2027-05-20", "fee");
    const fees = await monthlyFees("2027-05");
    expect(fees).toHaveLength(1);
    expect(fees[0].id).toBe(existingFee.id);
  });

  it("does not change the monthly fee when payment amount changes", async () => {
    const payment = await createPayment("100.00", "2026-07-15");
    const before = await monthlyFees("2026-07");
    const [allocation] = await db.select().from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, payment.id));
    const res = await request(app).patch(`/api/payments/${payment.id}`)
      .set("Cookie", cookie).send({ amount: "900.00", allocations: [{ authorizationId: allocation.authorizationId, amount: "900.00" }] });
    expect(res.status).toBe(200);
    expect(await monthlyFees("2026-07")).toEqual(before);
  });

  it("moves the fee when the only qualifying payment moves months", async () => {
    const payment = await createPayment("100.00", "2026-08-15");
    const res = await request(app).patch(`/api/payments/${payment.id}`)
      .set("Cookie", cookie).send({ paymentMonth: "2026-09" });
    expect(res.status).toBe(200);
    expect(await monthlyFees("2026-08")).toHaveLength(0);
    expect(await monthlyFees("2026-09")).toHaveLength(1);
  });

  it("reverses the fee when the only qualifying payment changes to fee type", async () => {
    const payment = await createPayment("100.00", "2026-10-15");
    const res = await request(app).patch(`/api/payments/${payment.id}`)
      .set("Cookie", cookie).send({ paymentType: "fee" });
    expect(res.status).toBe(200);
    expect(await monthlyFees("2026-10")).toHaveLength(0);
  });

  it("reverses the fee when the last qualifying payment is deleted", async () => {
    const payment = await createPayment("100.00", "2027-01-15");
    const res = await request(app).delete(`/api/payments/${payment.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(await monthlyFees("2027-01")).toHaveLength(0);
    const [reversed] = await db.select().from(feesTable).where(and(
      eq(feesTable.clientId, clientId),
      eq(feesTable.feeMonth, "2027-01"),
      eq(feesTable.isDeleted, true),
    ));
    const reversalAudits = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.action, "auto_reverse_fee"),
      eq(auditLogTable.entityId, reversed.id),
    ));
    expect(reversalAudits).toHaveLength(1);
  });

  it("keeps the fee while another qualifying payment remains", async () => {
    const first = await createPayment("100.00", "2027-02-15");
    const second = await createPayment("200.00", "2027-02-20");
    expect((await request(app).delete(`/api/payments/${first.id}`).set("Cookie", cookie)).status).toBe(200);
    const fees = await monthlyFees("2027-02");
    expect(fees).toHaveLength(1);
    expect(fees[0].paymentId).toBe(first.id);
    expect(second.id).not.toBe(first.id);
  });

  it("does not reverse progressed or manually adjusted fees", async () => {
    const progressedPayment = await createPayment("100.00", "2027-03-15");
    const [progressedFee] = await monthlyFees("2027-03");
    await db.update(feesTable).set({ status: "invoiced" }).where(eq(feesTable.id, progressedFee.id));
    expect((await request(app).delete(`/api/payments/${progressedPayment.id}`).set("Cookie", cookie)).status).toBe(200);
    expect(await monthlyFees("2027-03")).toHaveLength(1);

    const adjustedPayment = await createPayment("100.00", "2027-04-15");
    const [adjustedFee] = await monthlyFees("2027-04");
    await db.update(feesTable).set({ amount: "150.00" }).where(eq(feesTable.id, adjustedFee.id));
    expect((await request(app).delete(`/api/payments/${adjustedPayment.id}`).set("Cookie", cookie)).status).toBe(200);
    expect((await monthlyFees("2027-04"))[0].amount).toBe("150.00");
  });

  it("does not reverse an automatic fee after staff move it to another month", async () => {
    const payment = await createPayment("100.00", "2027-06-15");
    const [fee] = await monthlyFees("2027-06");
    const corrected = await request(app).patch(`/api/fees/${fee.id}`)
      .set("Cookie", cookie).send({ feeMonth: "2027-07" });
    expect(corrected.status).toBe(200);
    expect(corrected.body.ruleApplied).toBe("flat_160_per_client_month_manually_adjusted");

    const movedPayment = await request(app).patch(`/api/payments/${payment.id}`)
      .set("Cookie", cookie).send({ paymentMonth: "2027-07" });
    expect(movedPayment.status).toBe(200);
    expect((await request(app).delete(`/api/payments/${payment.id}`).set("Cookie", cookie)).status).toBe(200);

    const fees = await monthlyFees("2027-07");
    expect(fees).toHaveLength(1);
    expect(fees[0].id).toBe(fee.id);
  });

  it("concurrently creates one fee for same client and month", async () => {
    const checkDate = "2026-11-15";
    const [left, right] = await Promise.all([
      createPayment("100.00", checkDate),
      createPayment("200.00", checkDate),
    ]);
    expect(left.id).not.toBe(right.id);
    expect(await monthlyFees("2026-11")).toHaveLength(1);
  });

  it("audits and idempotently repairs missing, obsolete, and protected monthly fees", async () => {
    const missingPayment = await createPayment("100.00", "2031-01-15", "direct_payment", otherClientId);
    const [missingFee] = await monthlyFees("2031-01", otherClientId);
    await db.delete(feesTable).where(eq(feesTable.id, missingFee.id));

    await createPayment("100.00", "2031-02-15", "direct_payment", otherClientId);
    const [obsoleteFee] = await monthlyFees("2031-02", otherClientId);
    await db.update(feesTable).set({
      amount: "10.00",
      ruleApplied: "legacy_ten_percent_per_payment",
    }).where(eq(feesTable.id, obsoleteFee.id));

    const stalePayment = await createPayment("100.00", "2031-03-15", "direct_payment", otherClientId);
    const [staleFee] = await monthlyFees("2031-03", otherClientId);
    await db.update(feesTable).set({ status: "invoiced" }).where(eq(feesTable.id, staleFee.id));
    await db.update(paymentsTable).set({
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: staffId,
    }).where(eq(paymentsTable.id, stalePayment.id));

    await createPayment("100.00", "2031-04-15");
    const [unselectedFee] = await monthlyFees("2031-04");
    await db.delete(feesTable).where(eq(feesTable.id, unselectedFee.id));

    const auditReport = await request(app)
      .get(`/api/payments/monthly-fees/audit?clientId=${otherClientId}`)
      .set("Cookie", cookie);
    expect(auditReport.status).toBe(200);
    expect(auditReport.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ feeMonth: "2031-01", issue: "missing", repairAction: "create", protected: false }),
      expect.objectContaining({ feeMonth: "2031-02", issue: "obsolete_rule", repairAction: "replace", protected: false }),
      expect.objectContaining({ feeMonth: "2031-03", issue: "stale", repairAction: "none", protected: true }),
    ]));

    const unconfirmed = await request(app)
      .post("/api/payments/monthly-fees/repair")
      .set("Cookie", cookie)
      .send({ confirm: false, clientIds: [otherClientId] });
    expect(unconfirmed.status).toBe(400);

    const emptyScope = await request(app)
      .post("/api/payments/monthly-fees/repair")
      .set("Cookie", cookie)
      .send({ confirm: true, clientIds: [] });
    expect(emptyScope.status).toBe(400);
    expect(await monthlyFees("2031-04")).toHaveLength(0);

    const repaired = await request(app)
      .post("/api/payments/monthly-fees/repair")
      .set("Cookie", cookie)
      .send({ confirm: true, clientIds: [otherClientId] });
    expect(repaired.status).toBe(200);
    expect(repaired.body).toMatchObject({
      created: 1,
      replaced: 1,
      reversed: 0,
      protected: 1,
      remainingIssues: 1,
    });
    expect((await monthlyFees("2031-01", otherClientId))[0]).toMatchObject({
      paymentId: missingPayment.id,
      amount: "160.00",
      ruleApplied: MONTHLY_FEE_RULE,
    });
    expect((await monthlyFees("2031-02", otherClientId))[0]).toMatchObject({
      amount: "160.00",
      ruleApplied: MONTHLY_FEE_RULE,
    });
    expect((await monthlyFees("2031-03", otherClientId))[0]).toMatchObject({
      id: staleFee.id,
      status: "invoiced",
    });
    expect(await monthlyFees("2031-04")).toHaveLength(0);

    const repeated = await request(app)
      .post("/api/payments/monthly-fees/repair")
      .set("Cookie", cookie)
      .send({ confirm: true, clientIds: [otherClientId] });
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({
      created: 0,
      replaced: 0,
      reversed: 0,
      protected: 1,
      remainingIssues: 1,
    });

    const repairAudits = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.userId, staffId),
      eq(auditLogTable.action, "repair_monthly_fees"),
    ));
    expect(repairAudits).toHaveLength(2);
  });
});

describe("payment month validation", () => {
  it("rejects malformed months on create and update while accepting YYYY-MM", async () => {
    for (const paymentMonth of ["2026-13", "2026-2", "not-a-month"]) {
      const response = await request(app)
        .post("/api/payments")
        .set("Cookie", cookie)
        .send({
          clientId,
          qbCheckNumber: `${nonce}-invalid-${paymentMonth}`,
          checkDate: "2026-01-15",
          amount: "25.00",
          paymentMonth,
          paymentType: "direct_payment",
        });
      expect(response.status).toBe(400);
    }

    const created = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        qbCheckNumber: `${nonce}-valid-month`,
        checkDate: "2026-01-15",
        amount: "25.00",
         allocations: [{ authorizationId: authId, amount: "25.00" }],
        paymentMonth: "2026-02",
        paymentType: "direct_payment",
      });
    expect(created.status).toBe(201);
    expect(created.body.paymentMonth).toBe("2026-02");

    for (const paymentMonth of ["2026-13", "2026-2", "not-a-month"]) {
      const response = await request(app)
        .patch(`/api/payments/${created.body.id}`)
        .set("Cookie", cookie)
        .send({ paymentMonth });
      expect(response.status).toBe(400);
    }
    const updated = await request(app)
      .patch(`/api/payments/${created.body.id}`)
      .set("Cookie", cookie)
      .send({ paymentMonth: "2026-03" });
    expect(updated.status).toBe(200);
    expect(updated.body.paymentMonth).toBe("2026-03");
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
      paymentType: "direct_payment", status: "approved",
    }).returning();
    await db.insert(invoiceLineItemsTable).values({
      invoiceId: invoice.id, authorizationId: auth.id, serviceMonth: "2026-01", amount: "100.00",
    });
    const [payment] = await db.insert(paymentsTable).values({
      clientId, qbCheckNumber: `${nonce}-legacy-link-${checkCounter++}`, checkDate: "2026-01-15",
      paymentMonth: "2026-01", paymentType: "direct_payment", amount: "100.00", source: "manual",
    } as any).returning();
    const res = await request(app).patch(`/api/payments/${payment.id}`).set("Cookie", cookie)
      .send({ authorizationId: auth.id, invoiceId: invoice.id, vendorId: vendor.id });
    expect(res.status, `${res.text} ${JSON.stringify(res.body)}`).toBe(200);
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
    const [feeBefore] = await monthlyFees(payment.paymentMonth);
    const res = await request(app).patch(`/api/payments/${payment.id}`).set("Cookie", cookie)
      .send({ authorizationId: auth.id, invoiceId: invoice.id, vendorId: vendor.id, amount: "200.00" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("belong to clientId");
    const [unchanged] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id));
    const [feeAfter] = await monthlyFees(payment.paymentMonth);
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

  it("reconciles only approved invoice payments without writing any rows", async () => {
    const vendor = await db.insert(vendorsTable).values({ name: `${nonce}-reconcile-vendor`, billingAddress: "10 Check Street" }).returning().then((rows) => rows[0]);
    const auth = await makeAuthorization(clientId, vendor.id);
    const invoice = await db.insert(invoicesTable).values({
      clientId, vendorId: vendor.id, authorizationId: auth.id, submittedByRole: "staff",
      submittedDate: "2099-01-10", serviceMonth: "2099-01", amountRequested: "100.00",
      paymentType: "direct_payment", status: "approved",
    }).returning().then((rows) => rows[0]);
    await db.insert(invoiceLineItemsTable).values({ invoiceId: invoice.id, authorizationId: auth.id, serviceMonth: "2099-01", amount: "100.00" });
    const payment = await db.insert(paymentsTable).values({
      clientId, vendorId: vendor.id, invoiceId: invoice.id, qbCheckNumber: `${nonce}-reconcile-check`,
      checkDate: "2099-01-15", amount: "100.00", paymentType: "direct_payment", source: "manual",
    }).returning().then((rows) => rows[0]);
    const excludedStatuses = ["pending_review", "validated", "rejected"] as const;
    for (const status of excludedStatuses) {
      const excludedInvoice = await db.insert(invoicesTable).values({
        clientId, vendorId: vendor.id, authorizationId: auth.id, submittedByRole: "staff",
        submittedDate: "2099-01-10", serviceMonth: "2099-01", amountRequested: "100.00",
        paymentType: "direct_payment", status,
      }).returning().then((rows) => rows[0]);
      await db.insert(paymentsTable).values({
        clientId, vendorId: vendor.id, invoiceId: excludedInvoice.id, qbCheckNumber: `${nonce}-${status}`,
        checkDate: "2099-01-15", amount: "100.00", paymentType: "direct_payment", source: "manual",
      });
    }
    const outOfRangeInvoice = await db.insert(invoicesTable).values({
      clientId, vendorId: vendor.id, authorizationId: auth.id, submittedByRole: "staff",
      submittedDate: "2099-01-10", serviceMonth: "2099-01", amountRequested: "100.00",
      paymentType: "direct_payment", status: "approved",
    }).returning().then((rows) => rows[0]);
    await db.insert(paymentsTable).values({
      clientId, vendorId: vendor.id, invoiceId: outOfRangeInvoice.id, qbCheckNumber: `${nonce}-before`,
      checkDate: "2098-12-31", amount: "100.00", paymentType: "direct_payment", source: "manual",
    });
    const deletedPaymentInvoice = await db.insert(invoicesTable).values({
      clientId, vendorId: vendor.id, authorizationId: auth.id, submittedByRole: "staff",
      submittedDate: "2099-01-10", serviceMonth: "2099-01", amountRequested: "100.00",
      paymentType: "direct_payment", status: "approved", isDeleted: true,
    }).returning().then((rows) => rows[0]);
    // The database trigger disallows creating an active payment against a deleted invoice;
    // create it while active, then soft-delete the parent to exercise reconciliation filtering.
    await db.update(invoicesTable).set({ isDeleted: false }).where(eq(invoicesTable.id, deletedPaymentInvoice.id));
    await db.insert(paymentsTable).values({
      clientId, vendorId: vendor.id, invoiceId: deletedPaymentInvoice.id, qbCheckNumber: `${nonce}-deleted-invoice`,
      checkDate: "2099-01-15", amount: "100.00", paymentType: "direct_payment", source: "manual", isDeleted: true,
    });
    await db.update(invoicesTable).set({ isDeleted: true }).where(eq(invoicesTable.id, deletedPaymentInvoice.id));
    await db.insert(paymentsTable).values({
      clientId, vendorId: vendor.id, invoiceId: invoice.id, qbCheckNumber: `${nonce}-deleted-payment`,
      checkDate: "2099-01-15", amount: "100.00", paymentType: "direct_payment", source: "manual", isDeleted: true,
    });
    const unknownInvoice = await db.insert(invoicesTable).values({
      clientId, authorizationId: auth.id, submittedByRole: "staff", submittedDate: "2099-01-10",
      serviceMonth: "2099-01", amountRequested: "75.00", paymentType: "direct_payment", status: "approved",
    }).returning().then((rows) => rows[0]);
    await db.insert(paymentsTable).values({
      clientId, invoiceId: unknownInvoice.id, qbCheckNumber: `${nonce}-unknown-vendor`,
      checkDate: "2099-01-15", amount: "75.00", paymentType: "direct_payment", source: "manual",
    });
    const beforePayments = (await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id))).length;
    const beforeInvoices = (await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoice.id))).length;
    const beforePaymentRows = await db.select().from(paymentsTable).where(eq(paymentsTable.clientId, clientId));
    const beforeInvoiceRows = await db.select().from(invoicesTable).where(eq(invoicesTable.clientId, clientId));
    const beforeVendorRows = await db.select().from(vendorsTable).where(eq(vendorsTable.id, vendor.id));
    const beforeAllocationRows = await db.select().from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, payment.id));
    const beforeAuditRows = await db.select().from(auditLogTable).where(eq(auditLogTable.userId, staffId));
    const res = await request(app).post("/api/payments/check-run/reconcile").set("Cookie", cookie).send({
      csv: "Vendor Name,Address,Amount,Check Number,Check Date\n" +
        `${vendor.name},10 Check Street,100.00,${payment.qbCheckNumber},2099-01-15`,
      startDate: "2099-01-01",
      endDate: "2099-01-31",
    });
    expect(res.status).toBe(200);
    expect(res.body.matched).toHaveLength(1);
    expect(res.body.paymentsWithoutChecks).toHaveLength(1);
    expect(res.body.paymentsWithoutChecks[0].payment.vendorName).toBe("Unknown vendor");
    expect(res.body.checksWithoutPayments).toHaveLength(0);
    expect(res.body.matched[0].addressMatch).toBe(true);
    expect(res.body.matched[0].payment.address).toBe("10 Check Street");
    const reversed = await request(app).post("/api/payments/check-run/reconcile").set("Cookie", cookie).send({
      csv: "Vendor,Address,Amount,Check Number,Date\nV,Address,1,C,2099-01-15", startDate: "2099-02-01", endDate: "2099-01-01",
    });
    expect(reversed.status).toBe(400);
    const malformedDate = await request(app).post("/api/payments/check-run/reconcile").set("Cookie", cookie).send({
      csv: "Vendor,Address,Amount,Check Number,Date\nV,Address,1,C,2099-01-15", startDate: "not-a-date", endDate: "2099-01-31",
    });
    expect(malformedDate.status).toBe(400);
    const malformedCsv = await request(app).post("/api/payments/check-run/reconcile").set("Cookie", cookie).send({
      csv: "not the required headers", startDate: "2099-01-01", endDate: "2099-01-31",
    });
    expect(malformedCsv.status).toBe(200);
    expect(malformedCsv.body.errors[0]).toContain("Missing required column");
    expect((await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id))).length).toBe(beforePayments);
    expect((await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoice.id))).length).toBe(beforeInvoices);
    expect(await db.select().from(paymentsTable).where(eq(paymentsTable.clientId, clientId))).toEqual(beforePaymentRows);
    expect(await db.select().from(invoicesTable).where(eq(invoicesTable.clientId, clientId))).toEqual(beforeInvoiceRows);
    expect(await db.select().from(vendorsTable).where(eq(vendorsTable.id, vendor.id))).toEqual(beforeVendorRows);
    expect(await db.select().from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, payment.id))).toEqual(beforeAllocationRows);
    expect(await db.select().from(auditLogTable).where(eq(auditLogTable.userId, staffId))).toEqual(beforeAuditRows);
    for (const role of ["staff", "participant"] as const) {
      const deniedUser = await db.insert(usersTable).values({ name: `Denied ${role}`, email: `${nonce}-${role}-denied@test.local`, role }).returning().then((rows) => rows[0]);
      const deniedToken = newToken();
      await db.insert(sessionsTable).values({ userId: deniedUser.id, token: deniedToken, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
      const denied = await request(app).post("/api/payments/check-run/reconcile").set("Cookie", `ceps_session=${deniedToken}`).send({ csv: "", startDate: "2099-01-01", endDate: "2099-01-31" });
      expect(denied.status).toBe(403);
      await db.delete(sessionsTable).where(eq(sessionsTable.userId, deniedUser.id));
      await db.delete(usersTable).where(eq(usersTable.id, deniedUser.id));
    }
  });
});
