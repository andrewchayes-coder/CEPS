import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import {
  auditLogTable, authorizationsTable, clientsTable, db, feesTable,
  paymentsTable, remittanceAllocationsTable, remittancesTable,
  sessionsTable, usersTable, vendorsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";
import { authorizationTotalsPaid, effectiveAuthStatus } from "../lib/serializers";
import { relinkPendingFeesToFeeAuthorizations } from "../lib/feeAuthorization";
import { updateFeeCollectionStatus } from "../lib/feeRemittance";

const nonce = `fees-links-${Date.now().toString(36)}`;
let staffId: string;
let clientA: string;
let clientB: string;
let vendorA: string;
let authA: string;
let authB: string;
let feeAuthA: string;
let paymentA: string;
let paymentB: string;
let deletedAuth: string;
let deletedPayment: string;
let cookie: string;

beforeAll(async () => {
  const [staff] = await db.insert(usersTable).values({
    name: "Fee Link Staff", email: `${nonce}@test.local`, role: "staff",
  }).returning();
  staffId = staff.id;
  const clients = await db.insert(clientsTable).values([
    { firstName: "Fee", lastName: "A", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-a` },
    { firstName: "Fee", lastName: "B", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-b` },
  ]).returning();
  clientA = clients[0].id;
  clientB = clients[1].id;
  const [vendor] = await db.insert(vendorsTable).values({ name: nonce }).returning();
  vendorA = vendor.id;
  const auths = await db.insert(authorizationsTable).values([
    { clientId: clientA, vendorId: vendorA, authNumber: `${nonce}-auth-a`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01", oneTimeAmount: "100.00", maxPeriodAmount: "1000.00", status: "active" },
    { clientId: clientB, vendorId: vendorA, authNumber: `${nonce}-auth-b`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01", oneTimeAmount: "100.00", maxPeriodAmount: "1000.00", status: "active" },
    { clientId: clientA, vendorId: vendorA, authNumber: `${nonce}-auth-deleted`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01", oneTimeAmount: "100.00", maxPeriodAmount: "1000.00", status: "active", isDeleted: true },
    { clientId: clientA, authNumber: `${nonce}-490-a`, serviceCode: "490", paymentType: "fee", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01", maxPeriodAmount: "5000.00", status: "active" },
  ]).returning();
  [authA, authB, deletedAuth] = auths.map((auth) => auth.id);
  feeAuthA = auths[3].id;
  const payments = await db.insert(paymentsTable).values([
    { clientId: clientA, authorizationId: authA, vendorId: vendorA, qbCheckNumber: `${nonce}-a`, checkDate: "2026-03-15", amount: "100.00", paymentMonth: "2026-03", paymentType: "direct_payment", source: "manual" },
    { clientId: clientB, authorizationId: authB, vendorId: vendorA, qbCheckNumber: `${nonce}-b`, checkDate: "2026-03-15", amount: "100.00", paymentMonth: "2026-03", paymentType: "direct_payment", source: "manual" },
    { clientId: clientA, authorizationId: authA, vendorId: vendorA, qbCheckNumber: `${nonce}-deleted`, checkDate: "2026-03-15", amount: "100.00", paymentMonth: "2026-03", paymentType: "direct_payment", source: "manual", isDeleted: true },
  ]).returning();
  [paymentA, paymentB, deletedPayment] = payments.map((payment) => payment.id);
  const token = newToken();
  await db.insert(sessionsTable).values({ userId: staffId, token, expiresAt: new Date(Date.now() + 3_600_000) });
  cookie = `ceps_session=${token}`;
});

afterAll(async () => {
  const testRemittances = await db.select({ id: remittancesTable.id }).from(remittancesTable)
    .where(inArray(remittancesTable.clientId, [clientA, clientB]));
  if (testRemittances.length) {
    await db.delete(remittanceAllocationsTable)
      .where(inArray(remittanceAllocationsTable.remittanceId, testRemittances.map(({ id }) => id)));
    await db.delete(remittancesTable)
      .where(inArray(remittancesTable.id, testRemittances.map(({ id }) => id)));
  }
  await db.delete(feesTable).where(inArray(feesTable.clientId, [clientA, clientB]));
  await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, [clientA, clientB]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientA, clientB]));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorA));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
});

describe("fee participant links", () => {
  it("accepts valid same-participant payment and authorization links", async () => {
    const response = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, paymentId: paymentA, authorizationId: feeAuthA, amount: "5.00",
    });
    expect(response.status).toBe(201);
    expect(response.body.paymentId).toBe(paymentA);
    expect(response.body.authorizationId).toBe(feeAuthA);
  });

  it.each([
    ["paymentId", () => paymentB],
    ["authorizationId", () => authB],
  ])("rejects a cross-participant %s without writing a fee or audit", async (field, id) => {
    const beforeFees = await db.select().from(feesTable).where(eq(feesTable.clientId, clientA));
    const beforeAudits = await db.select().from(auditLogTable).where(eq(auditLogTable.userId, staffId));
    const response = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "9.00", [field]: id(),
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(field === "authorizationId" ? "490 fee authorization" : field);
    expect((await db.select().from(feesTable).where(eq(feesTable.clientId, clientA))).length).toBe(beforeFees.length);
    expect((await db.select().from(auditLogTable).where(eq(auditLogTable.userId, staffId))).length).toBe(beforeAudits.length);
  });

  it.each([
    ["paymentId", () => deletedPayment],
    ["authorizationId", () => deletedAuth],
  ])("rejects a deleted %s with a clear error", async (field, id) => {
    const response = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "9.00", [field]: id(),
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(field === "authorizationId" ? "490 fee authorization" : `${field} must reference a non-deleted`);
  });

});

describe("monthly fee CRUD", () => {
  it("round-trips feeMonth on POST and list", async () => {
    const created = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, amount: "160.00", feeMonth: "2026-01",
    });
    expect(created.status).toBe(201);
    expect(created.body.feeMonth).toBe("2026-01");

    const listed = await request(app).get("/api/fees").query({ clientId: clientB, feeMonth: "2026-01" }).set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].feeMonth).toBe("2026-01");
  });

  it("returns 409 for a duplicate active client/month", async () => {
    const first = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2026-02",
    });
    expect(first.status).toBe(201);
    const duplicate = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2026-02",
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toContain("active fee already exists");
  });

  it("allows a different month and recreates a soft-deleted month", async () => {
    const different = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2026-03",
    });
    expect(different.status).toBe(201);

    const deleted = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, amount: "160.00", feeMonth: "2026-04",
    });
    expect(deleted.status).toBe(201);
    const removed = await request(app).delete(`/api/fees/${deleted.body.id}`).set("Cookie", cookie);
    expect(removed.status).toBe(200);
    const recreated = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, amount: "160.00", feeMonth: "2026-04",
    });
    expect(recreated.status).toBe(201);
  });

  it("rejects invalid feeMonth format", async () => {
    const response = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2026-13",
    });
    expect(response.status).toBe(400);
  });

  it("returns 409 on PATCH month conflict without mutation or audit", async () => {
    const first = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, amount: "160.00", feeMonth: "2026-05",
    });
    const second = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, amount: "160.00", feeMonth: "2026-06",
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const beforeAudits = await db.select().from(auditLogTable).where(eq(auditLogTable.userId, staffId));
    const conflict = await request(app).patch(`/api/fees/${second.body.id}`).set("Cookie", cookie).send({
      feeMonth: "2026-05",
    });
    expect(conflict.status).toBe(409);
    const [unchanged] = await db.select().from(feesTable).where(eq(feesTable.id, second.body.id));
    expect(unchanged.feeMonth).toBe("2026-06");
    const afterAudits = await db.select().from(auditLogTable).where(eq(auditLogTable.userId, staffId));
    expect(afterAudits).toHaveLength(beforeAudits.length);
  });
});

describe("fee authorization usage", () => {
  it("links pending fees to the covering 490 authorization and counts non-waived fees as usage", async () => {
    const current = new Date();
    const feeMonth = `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, "0")}`;
    const [fee] = await db.insert(feesTable).values({
      clientId: clientB,
      paymentId: paymentB,
      authorizationId: authB,
      feeMonth,
      amount: "160.00",
      status: "pending",
    }).returning();
    const [feeAuth] = await db.insert(authorizationsTable).values({
      clientId: clientB,
      vendorId: vendorA,
      authNumber: `${nonce}-fee-auth`,
      serviceCode: "490",
      paymentType: "fee",
      servicePeriodStart: `${feeMonth}-01`,
      servicePeriodEnd: "2100-12-31",
      maxPeriodAmount: "160.00",
      status: "active",
    }).returning();

    await db.transaction(async (tx) => {
      await relinkPendingFeesToFeeAuthorizations(tx as unknown as typeof db, clientB);
    });
    const [linkedFee] = await db.select().from(feesTable).where(eq(feesTable.id, fee.id));
    expect(linkedFee.authorizationId).toBe(feeAuth.id);
    const amountUsed = (await authorizationTotalsPaid([feeAuth.id])).get(feeAuth.id)!;
    expect(amountUsed.toFixed(2)).toBe("160.00");
    expect(effectiveAuthStatus(feeAuth, amountUsed)).toBe("exhausted");
    const listed = await request(app).get("/api/fees").query({ clientId: clientB, feeMonth }).set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(listed.body[0]).toMatchObject({
      id: fee.id,
      authNumber: feeAuth.authNumber,
      feeAuthorizationMissing: false,
      remittedAmount: "0.00",
    });
    const authResponse = await request(app).get(`/api/authorizations/${feeAuth.id}`).set("Cookie", cookie);
    expect(authResponse.status).toBe(200);
    expect(authResponse.body).toMatchObject({
      totalPaid: "160.00",
      remainingAmount: "0.00",
      status: "exhausted",
    });

    await db.update(feesTable).set({ status: "waived" }).where(eq(feesTable.id, fee.id));
    expect((await authorizationTotalsPaid([feeAuth.id])).get(feeAuth.id)?.toFixed(2) ?? "0.00").toBe("0.00");
  });
});

describe("fee lifecycle actions", () => {
  it("edits a legacy fee with a deleted trigger check and clears that check only on authorization relink", async () => {
    const auths = await db.insert(authorizationsTable).values(["05", "06"].map(month => ({
      clientId: clientB, authNumber: `${nonce}-legacy-edit-${month}`, serviceCode: "490", paymentType: "fee",
      servicePeriodStart: `2097-${month}-01`, servicePeriodEnd: `2097-${month}-30`,
      maxPeriodAmount: "160.00", status: "active",
    }))).returning();
    const [check] = await db.insert(paymentsTable).values({
      clientId: clientB, qbCheckNumber: `${nonce}-legacy-trigger`, checkDate: "2097-05-15",
      amount: "100.00", paymentType: "direct_payment", source: "manual",
    }).returning();
    const created = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, paymentId: check.id, feeMonth: "2097-05", amount: "160.00",
    });
    expect(created.status).toBe(201);
    await db.update(paymentsTable).set({ isDeleted: true }).where(eq(paymentsTable.id, check.id));
    for (const edit of [{ notes: "Legacy fee correction" }, { amount: "180.00" }]) {
      const edited = await request(app).patch(`/api/fees/${created.body.id}`).set("Cookie", cookie).send(edit);
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body).toMatchObject({ ...edit, paymentId: check.id, authorizationId: auths[0].id });
    }
    const changedMonth = await request(app).patch(`/api/fees/${created.body.id}`).set("Cookie", cookie)
      .send({ feeMonth: "2097-06" });
    expect(changedMonth.status, JSON.stringify(changedMonth.body)).toBe(200);
    expect(changedMonth.body).toMatchObject({
      feeMonth: "2097-06", amount: "180.00", paymentId: null, authorizationId: auths[1].id,
      notes: "Legacy fee correction",
    });
    const [stored] = await db.select().from(feesTable).where(eq(feesTable.id, created.body.id));
    expect(stored).toMatchObject({ paymentId: null, authorizationId: auths[1].id });
    const audits = await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, created.body.id));
    expect(audits.some(audit => audit.detail?.includes(`cleared link to deleted check #${check.qbCheckNumber}`))).toBe(true);
    expect((await db.select().from(paymentsTable).where(eq(paymentsTable.id, check.id)))[0].isDeleted).toBe(true);
  });

  it.each(["client", "authorization", "payment"])("maps the remaining active %s guard to 409 with its message", async parent => {
    const message = `Active fee must reference an active ${parent}`;
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce({
      cause: { code: "23503", constraint: `fees_active_${parent}_link`, message },
    });
    try {
      const response = await request(app).patch(`/api/fees/${clientA}`).set("Cookie", cookie).send({ notes: "Guard test" });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe(message);
    } finally {
      transaction.mockRestore();
    }
  });

  it("recalculates collected and pending fees after amount edits, and blocks matched month changes", async () => {
    const [feeAuth] = await db.insert(authorizationsTable).values({
      clientId: clientA, authNumber: `${nonce}-fee-edit`, serviceCode: "490", paymentType: "fee",
      servicePeriodStart: "2098-01-01", servicePeriodEnd: "2098-12-31", maxPeriodAmount: "1920.00", status: "active",
    }).returning();
    for (const [month, remitted, initialStatus, newAmount, expectedStatus] of [
      ["2098-01", "160.00", "collected", "200.00", "pending"],
      ["2098-02", "80.00", "pending", "80.00", "collected"],
    ]) {
      const created = await request(app).post("/api/fees").set("Cookie", cookie).send({
        clientId: clientA, amount: "160.00", feeMonth: month,
      });
      expect(created.status).toBe(201);
      const feeId = created.body.id;
      const [remittance] = await db.insert(remittancesTable).values({
        clientId: clientA, authorizationId: feeAuth.id, remittanceDate: `${month}-20`,
        amount: remitted, paymentMonth: month, status: "received",
      }).returning();
      await db.insert(remittanceAllocationsTable).values({
        remittanceId: remittance.id, paymentId: null, feeId, amount: remitted,
      });
      await db.update(feesTable).set({ status: initialStatus }).where(eq(feesTable.id, feeId));
      const edited = await request(app).patch(`/api/fees/${feeId}`).set("Cookie", cookie).send({ amount: newAmount });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({ amount: newAmount, status: expectedStatus, remittedAmount: remitted, authorizationId: feeAuth.id });
      const [stored] = await db.select().from(feesTable).where(eq(feesTable.id, feeId));
      expect(stored.status).toBe(expectedStatus);
      const changedMonth = await request(app).patch(`/api/fees/${feeId}`).set("Cookie", cookie).send({ feeMonth: "2098-03", amount: "250.00" });
      expect(changedMonth.status).toBe(400);
      expect(changedMonth.body.error).toBe("Unmatch this fee's remittances before changing its month");
      const [unchanged] = await db.select().from(feesTable).where(eq(feesTable.id, feeId));
      expect(unchanged).toMatchObject({ amount: newAmount, feeMonth: month, status: expectedStatus, authorizationId: feeAuth.id });
      // Supplying the same month is not a month change, even when matched.
      expect((await request(app).patch(`/api/fees/${feeId}`).set("Cookie", cookie).send({ feeMonth: month })).status).toBe(200);
    }
  });

  it("relinks an unallocated fee to the 490 for its new month, or clears a missing match", async () => {
    const auths = await db.insert(authorizationsTable).values(["03", "04"].map(month => ({
      clientId: clientB, authNumber: `${nonce}-fee-edit-${month}`, serviceCode: "490", paymentType: "fee",
      servicePeriodStart: `2098-${month}-01`, servicePeriodEnd: `2098-${month}-30`,
      maxPeriodAmount: "160.00", status: "active",
    }))).returning();
    const created = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientB, amount: "160.00", feeMonth: "2098-03",
    });
    expect(created.status).toBe(201);
    expect(created.body.authorizationId).toBe(auths[0].id);
    const updated = await request(app).patch(`/api/fees/${created.body.id}`).set("Cookie", cookie).send({ feeMonth: "2098-04" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ feeMonth: "2098-04", authorizationId: auths[1].id, status: "pending" });
    const unmatched = await request(app).patch(`/api/fees/${created.body.id}`).set("Cookie", cookie).send({ feeMonth: "2101-05" });
    expect(unmatched.status).toBe(200);
    expect(unmatched.body.authorizationId).toBeNull();
  });

  it("requires and stores a waiver reason, and prevents routine status updates", async () => {
    const created = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2099-01",
    });
    expect(created.status).toBe(201);
    const deniedStatus = await request(app).patch(`/api/fees/${created.body.id}`).set("Cookie", cookie).send({ status: "collected" });
    expect(deniedStatus.status).toBe(400);
    const missingReason = await request(app).post(`/api/fees/${created.body.id}/waive`).set("Cookie", cookie).send({ reason: " " });
    expect(missingReason.status).toBe(400);
    const waived = await request(app).post(`/api/fees/${created.body.id}/waive`).set("Cookie", cookie).send({ reason: "Participant opted out" });
    expect(waived.status).toBe(200);
    expect(waived.body.status).toBe("waived");
    expect(waived.body.waiverReason).toBe("Participant opted out");
    const audits = await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, created.body.id));
    expect(audits.some((audit) => audit.action === "waive_fee" && audit.detail === "Participant opted out")).toBe(true);
  });

  it("requires a reason for collected-fee correction and audits the correction", async () => {
    const created = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2099-02",
    });
    await db.update(feesTable).set({ status: "collected" }).where(eq(feesTable.id, created.body.id));
    expect((await request(app).post(`/api/fees/${created.body.id}/correct-collection`).set("Cookie", cookie).send({ reason: "" })).status).toBe(400);
    const corrected = await request(app).post(`/api/fees/${created.body.id}/correct-collection`).set("Cookie", cookie).send({ reason: "Matched to wrong check" });
    expect(corrected.status).toBe(200);
    expect(corrected.body.status).toBe("pending");
    const audits = await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, created.body.id));
    expect(audits.some((audit) => audit.action === "correct_fee_collection")).toBe(true);
  });

  it("rejects waiving or deleting a fee while it has remittance allocations", async () => {
    const created = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2099-04",
    });
    expect(created.status).toBe(201);
    const [remittance] = await db.insert(remittancesTable).values({
      clientId: clientA,
      remittanceDate: "2099-04-20",
      amount: "80.00",
      paymentMonth: "2099-04",
      status: "received",
    }).returning();
    await db.insert(remittanceAllocationsTable).values({
      remittanceId: remittance.id,
      paymentId: null,
      feeId: created.body.id,
      amount: "80.00",
    });

    const waive = await request(app).post(`/api/fees/${created.body.id}/waive`)
      .set("Cookie", cookie).send({ reason: "Should be blocked while allocated" });
    expect(waive.status).toBe(400);
    expect(waive.body.error).toContain("Remove remittance allocations");
    const remove = await request(app).delete(`/api/fees/${created.body.id}`).set("Cookie", cookie);
    expect(remove.status).toBe(409);
    expect(remove.body.error).toContain("Remove remittance allocations");
    const [unchanged] = await db.select().from(feesTable).where(eq(feesTable.id, created.body.id));
    expect(unchanged.status).toBe("pending");
    expect(unchanged.isDeleted).toBe(false);
  });

  it("uses the exact decimal allocation sum and returns affected remittances to received on correction", async () => {
    const created = await request(app).post("/api/fees").set("Cookie", cookie).send({
      clientId: clientA, amount: "160.00", feeMonth: "2099-03",
    });
    expect(created.status).toBe(201);
    const remittances = await db.insert(remittancesTable).values([
      {
        clientId: clientA, remittanceDate: "2099-03-20", amount: "60.00",
        paymentMonth: "2099-03", status: "matched",
      },
      {
        clientId: clientA, remittanceDate: "2099-03-21", amount: "100.00",
        paymentMonth: "2099-03", status: "matched",
      },
    ]).returning();
    await db.insert(remittanceAllocationsTable).values([
      { remittanceId: remittances[0].id, paymentId: null, feeId: created.body.id, amount: "60.00" },
      { remittanceId: remittances[1].id, paymentId: null, feeId: created.body.id, amount: "100.00" },
    ]);
    await db.transaction(async (tx) => {
      await updateFeeCollectionStatus(tx as unknown as typeof db, created.body.id, staffId, remittances[0].id);
    });
    const [collected] = await db.select().from(feesTable).where(eq(feesTable.id, created.body.id));
    expect(collected.status).toBe("collected");

    const corrected = await request(app)
      .post(`/api/fees/${created.body.id}/correct-collection`)
      .set("Cookie", cookie)
      .send({ reason: "Two remittance lines were assigned to the wrong fee" });
    expect(corrected.status).toBe(200);
    expect(corrected.body.status).toBe("pending");
    expect((await db.select().from(remittanceAllocationsTable)
      .where(inArray(remittanceAllocationsTable.feeId, [created.body.id])))).toHaveLength(0);
    const affectedRemittances = await db.select().from(remittancesTable)
      .where(inArray(remittancesTable.id, remittances.map(({ id }) => id)));
    expect(affectedRemittances.map(({ status }) => status)).toEqual(["received", "received"]);
    expect(affectedRemittances.every((remittance) =>
      remittance.matchedPaymentId === null &&
      remittance.autoMatched === false &&
      remittance.reviewReason === null,
    )).toBe(true);
    const audits = await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, created.body.id));
    expect(audits.some((audit) =>
      audit.action === "collect_fee" && audit.detail?.includes(`Remittance ${remittances[0].id}`),
    )).toBe(true);
    expect(audits.some((audit) =>
      audit.action === "uncollect_fee" &&
      remittances.some(({ id }) => audit.detail?.includes(`Remittance ${id}`)),
    )).toBe(true);
  });
});