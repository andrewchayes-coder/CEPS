import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  authorizationsTable,
  paymentsTable,
  remittancesTable,
  auditLogTable,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `rimp${Date.now().toString(36)}`;

let staffId: string;
let clientAId: string;
let clientBId: string;
let authAId: string;
let authBId: string;
let matchPaymentId: string;
let cookie: string;

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "Rimp Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [clientA] = await db
    .insert(clientsTable)
    .values({ firstName: "Alta", lastName: "One", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-UCI-A` })
    .returning();
  clientAId = clientA.id;
  const [clientB] = await db
    .insert(clientsTable)
    .values({ firstName: "Alta", lastName: "Two", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-UCI-B` })
    .returning();
  clientBId = clientB.id;

  const [authA] = await db
    .insert(authorizationsTable)
    .values({
      clientId: clientAId,
      authNumber: `${nonce}-AUTH-A`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      maxPeriodAmount: "10000.00",
    })
    .returning();
  authAId = authA.id;
  const [authB] = await db
    .insert(authorizationsTable)
    .values({
      clientId: clientBId,
      authNumber: `${nonce}-AUTH-B`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      maxPeriodAmount: "10000.00",
    })
    .returning();
  authBId = authB.id;

  // An unremitted payment that the first row should AUTO-MATCH (same client,
  // same amount, same month).
  const [pay] = await db
    .insert(paymentsTable)
    .values({
      clientId: clientAId,
      authorizationId: authAId,
      qbCheckNumber: `${nonce}-CHK-A`,
      checkDate: "2026-01-15",
      amount: "500.00",
      paymentMonth: "2026-01",
      paymentType: "direct_payment",
      source: "manual",
      remitted: false,
    })
    .returning();
  matchPaymentId = pay.id;

  const token = newToken();
  await db.insert(sessionsTable).values({
    userId: staffId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  cookie = `ceps_session=${token}`;
});

afterAll(async () => {
  await db.delete(remittancesTable).where(inArray(remittancesTable.clientId, [clientAId, clientBId]));
  await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, [clientAId, clientBId]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientAId, clientBId]));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientAId, clientBId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId]));
});

const SUMMARY_HEADER = ["Date", "Units", "Amount", "Reference #"];
const DETAIL_HEADER = ["UCI #", "Consumer Name", "Auth #", "Svc Code", "Sub-Code", "Service M/Y", "Units", "Amount", "Invoice #", "Adj Code", "Inv Amt"];
const altaReport = (reference: string, date: string, lines: { uci: string; auth: string; month: string; amount: string }[]) => [
  SUMMARY_HEADER,
  [date, String(lines.length), lines.reduce((sum, line) => sum + Number(line.amount), 0).toFixed(2), reference],
  DETAIL_HEADER,
  ...lines.map((line) => [line.uci, "Synthetic Person", line.auth, "459", "", `${line.month.slice(5)}/${line.month.slice(0, 4)}`, "1", line.amount, "INV", "", line.amount]),
].map((row) => row.join(",")).join("\n");

describe("POST /remittances/import (Alta batch import)", () => {
  it("creates a staff manual remittance with required participant and authorization context", async () => {
    const res = await request(app).post("/api/remittances").set("Cookie", cookie).send({
      clientId: clientAId, authorizationId: authAId, altaReference: `${nonce}-MANUAL`,
      remittanceDate: "2026-09-20", amount: "77.00", paymentMonth: "2026-09",
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("manual");
    expect(res.body.authorizationId).toBe(authAId);
    expect(res.body.reviewReason).toBe("no_eligible_payment");
  });

  it("imports a batch: shared batch id, auto-match runs, unresolvable rows errored, audit logged", async () => {
    const csvText = altaReport(`${nonce}-REPORT`, "2026-01-20", [
      { uci: `${nonce}-UCI-A`, auth: `${nonce}-AUTH-A`, month: "2026-01", amount: "500.00" },
      { uci: `${nonce}-UCI-B`, auth: `${nonce}-AUTH-B`, month: "2026-02", amount: "42.00" },
      { uci: `${nonce}-UCI-MISSING`, auth: "UNKNOWN", month: "2026-02", amount: "10.00" },
      { uci: `${nonce}-UCI-A`, auth: "AUTH-DOES-NOT-EXIST", month: "2026-02", amount: "10.00" },
    ]);
    const res = await request(app)
      .post("/api/remittances/import")
      .set("Cookie", cookie)
      .send({ reportReference: `${nonce}-REPORT`, csvText });
    expect(res.status).toBe(200);
    const body = res.body as {
      remittanceBatchId: string;
      parsed: number;
      imported: number;
      errored: number;
      autoMatched: number;
      needsManualMatch: number;
      results: { rowNumber: number; outcome: string; matchedPaymentId?: string | null }[];
    };

    expect(body.remittanceBatchId).toBeTruthy();
    expect(body.parsed).toBe(4);
    expect(body.imported).toBe(2);
    expect(body.errored).toBe(2);
    expect(body.autoMatched).toBe(1);
    expect(body.needsManualMatch).toBe(1);

    // Per-row outcomes
    const byRow = new Map(body.results.map((r) => [r.rowNumber, r]));
    expect(byRow.get(4)?.outcome).toBe("auto_matched");
    expect(byRow.get(4)?.matchedPaymentId).toBe(matchPaymentId);
    expect(byRow.get(5)?.outcome).toBe("needs_manual_match");
    expect(byRow.get(6)?.outcome).toBe("errored");
    expect(byRow.get(7)?.outcome).toBe("errored");

    // All imported line items share ONE batch id.
    const inserted = await db
      .select()
      .from(remittancesTable)
      .where(eq(remittancesTable.remittanceBatchId, body.remittanceBatchId));
    expect(inserted).toHaveLength(2);
    expect(new Set(inserted.map((r) => r.remittanceBatchId)).size).toBe(1);
    expect(inserted.every((r) => r.source === "alta_regional")).toBe(true);

    // Auto-match flipped the payment's remitted flag.
    const [payAfter] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, matchPaymentId));
    expect(payAfter.remitted).toBe(true);
    const matched = inserted.find((r) => r.matchedPaymentId === matchPaymentId);
    expect(matched?.status).toBe("matched");
    expect(matched?.autoMatched).toBe(true);
    expect(matched?.authorizationId).toBe(authAId);
    expect(matched?.altaReference).toBe(`${nonce}-REPORT`);
    expect(matched?.reportReference).toBe(`${nonce}-REPORT`);

    // The unmatched-but-imported line is flagged for manual matching.
    const manual = inserted.find((r) => r.matchedPaymentId === null);
    expect(manual?.status).toBe("received");
    expect(manual?.autoMatched).toBe(false);

    // Import run is audit-logged.
    const audits = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.userId, staffId));
    const importAudit = audits.find((a) => a.action === "import_remittance_report");
    expect(importAudit).toBeTruthy();
    expect(importAudit?.detail).toContain(body.remittanceBatchId);
  });

  it("filters the remittances list by remittanceBatchId", async () => {
    // Import a small batch, then confirm the list endpoint returns only its rows.
    const csvText = altaReport(`${nonce}-LIST`, "2026-03-01", [
      { uci: `${nonce}-UCI-B`, auth: `${nonce}-AUTH-B`, month: "2026-03", amount: "7.00" },
      { uci: `${nonce}-UCI-B`, auth: `${nonce}-AUTH-B`, month: "2026-03", amount: "8.00" },
    ]);
    const res = await request(app)
      .post("/api/remittances/import")
      .set("Cookie", cookie)
      .send({ csvText });
    const batchId = res.body.remittanceBatchId as string;

    const listRes = await request(app)
      .get(`/api/remittances?remittanceBatchId=${batchId}`)
      .set("Cookie", cookie);
    expect(listRes.status).toBe(200);
    expect(listRes.body.total).toBe(2);
    expect(listRes.body.items.every((r: { remittanceBatchId: string }) => r.remittanceBatchId === batchId)).toBe(true);
  });

  it("re-uploading the SAME report skips every row as duplicate (no new rows, new batch id)", async () => {
    const csvText = altaReport(`${nonce}-DUP`, "2026-04-01", [
      { uci: `${nonce}-UCI-B`, auth: `${nonce}-AUTH-B`, month: "2026-04", amount: "11.00" },
      { uci: `${nonce}-UCI-B`, auth: `${nonce}-AUTH-B`, month: "2026-04", amount: "12.00" },
    ]);

    // First upload: both rows import (needs_manual_match — no matching payment).
    const first = await request(app).post("/api/remittances/import").set("Cookie", cookie).send({ csvText });
    expect(first.status).toBe(200);
    expect(first.body.imported).toBe(2);
    expect(first.body.skippedDuplicate).toBe(0);
    const firstBatch = first.body.remittanceBatchId as string;
    const afterFirst = await db.select().from(remittancesTable).where(inArray(remittancesTable.clientId, [clientBId]));
    const countAfterFirst = afterFirst.length;

    // Second upload of the identical report: all rows skipped as duplicate, no
    // new remittances persisted, and a fresh (empty) batch id is returned.
    const second = await request(app).post("/api/remittances/import").set("Cookie", cookie).send({ csvText });
    expect(second.status).toBe(200);
    expect(second.body.imported).toBe(0);
    expect(second.body.skippedDuplicate).toBe(2);
    expect(second.body.errored).toBe(0);
    expect(second.body.remittanceBatchId).not.toBe(firstBatch);
    expect(second.body.results.every((r: { outcome: string }) => r.outcome === "skipped_duplicate")).toBe(true);

    const afterSecond = await db.select().from(remittancesTable).where(inArray(remittancesTable.clientId, [clientBId]));
    expect(afterSecond.length).toBe(countAfterFirst); // no new rows
    // The second (empty) batch persisted nothing.
    const secondBatchRows = await db.select().from(remittancesTable).where(eq(remittancesTable.remittanceBatchId, second.body.remittanceBatchId as string));
    expect(secondBatchRows).toHaveLength(0);
  });

  it("falls back to needs_manual_match when the candidate payment is already claimed (race-safe)", async () => {
    // Seed an unremitted payment, then simulate a concurrent import having
    // already claimed it by pre-flipping remitted=true. The conditional claim
    // (UPDATE ... WHERE remitted=false) must return no row, so the import must
    // NOT match it and instead flag the row for manual matching.
    const [pay] = await db
      .insert(paymentsTable)
      .values({
        clientId: clientBId,
        qbCheckNumber: `${nonce}-RACE`,
        checkDate: "2026-05-15",
        amount: "777.00",
        paymentMonth: "2026-05",
        paymentType: "direct_payment",
        source: "manual",
        remitted: true, // already claimed by a concurrent import
      })
      .returning();

    const csvText = altaReport(`${nonce}-RACE-1`, "2026-05-20", [{ uci: `${nonce}-UCI-B`, auth: `${nonce}-AUTH-B`, month: "2026-05", amount: "777.00" }]);
    const res = await request(app).post("/api/remittances/import").set("Cookie", cookie).send({ csvText });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.autoMatched).toBe(0);
    expect(res.body.needsManualMatch).toBe(1);
    expect(res.body.results[0].outcome).toBe("needs_manual_match");
    expect(res.body.results[0].matchedPaymentId ?? null).toBeNull();

    // The pre-claimed payment stays matched to nothing new here (not double-claimed).
    const inserted = await db.select().from(remittancesTable).where(eq(remittancesTable.remittanceBatchId, res.body.remittanceBatchId as string));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].matchedPaymentId).toBeNull();
    expect(inserted[0].status).toBe("received");
    void pay;
  });

  it("holds an otherwise eligible payment for review when its authorization amount differs", async () => {
    const [auth] = await db.insert(authorizationsTable).values({
      clientId: clientBId, authNumber: `${nonce}-MISMATCH`, serviceCode: "459",
      paymentType: "direct_payment", servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31", monthlyAmount: "100.00", maxPeriodAmount: "1200.00",
    }).returning();
    const [payment] = await db.insert(paymentsTable).values({
      clientId: clientBId, authorizationId: auth.id, qbCheckNumber: `${nonce}-MISMATCH`,
      checkDate: "2026-06-15", paymentMonth: "2026-06", amount: "50.00",
      paymentType: "direct_payment", source: "manual", remitted: false,
    }).returning();
    const csvText = altaReport("CHECK-50", "2026-06-20", [{ uci: `${nonce}-UCI-B`, auth: `${nonce}-MISMATCH`, month: "2026-06", amount: "50.00" }]);
    const res = await request(app).post("/api/remittances/import").set("Cookie", cookie).send({ csvText });
    expect(res.status).toBe(200);
    expect(res.body.autoMatched).toBe(0);
    const [remittance] = await db.select().from(remittancesTable).where(eq(remittancesTable.remittanceBatchId, res.body.remittanceBatchId));
    expect(remittance.status).toBe("received");
    expect(remittance.reviewReason).toBe("amount_mismatch");
    expect(remittance.expectedAmount).toBe("100.00");
    const [unclaimed] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id));
    expect(unclaimed.remitted).toBe(false);
  });

  it("only explicitly matches an exact eligible payment and releases it when the remittance is deleted", async () => {
    const [otherAuth] = await db.insert(authorizationsTable).values({
      clientId: clientAId, authNumber: `${nonce}-OTHER-AUTH`, serviceCode: "459",
      paymentType: "direct_payment", servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31", maxPeriodAmount: "1000.00",
    }).returning();
    const makePayment = (values: Partial<typeof paymentsTable.$inferInsert>) => db.insert(paymentsTable).values({
      clientId: clientAId, authorizationId: authAId, qbCheckNumber: `${nonce}-${randomUUID()}`,
      checkDate: "2026-07-15", paymentMonth: "2026-07", amount: "99.00",
      paymentType: "direct_payment", source: "manual", remitted: false, ...values,
    }).returning();
    const [crossClient] = await makePayment({ clientId: clientBId });
    const [crossAuth] = await makePayment({ authorizationId: otherAuth.id });
    const [crossMonth] = await makePayment({ paymentMonth: "2026-08" });
    const [wrongAmount] = await makePayment({ amount: "98.00" });
    const [valid] = await makePayment({});
    const [remittance] = await db.insert(remittancesTable).values({
      clientId: clientAId, authorizationId: authAId, remittanceDate: "2026-07-20",
      amount: "99.00", paymentMonth: "2026-07", status: "received", source: "manual",
    }).returning();
    for (const payment of [crossClient, crossAuth, crossMonth]) {
      const response = await request(app).post(`/api/remittances/${remittance.id}/match`).set("Cookie", cookie).send({ paymentId: payment.id, amount: "99.00" });
      expect(response.status).toBe(400);
    }
    const tooLargeForPayment = await request(app).post(`/api/remittances/${remittance.id}/match`).set("Cookie", cookie).send({ paymentId: wrongAmount.id, amount: "99.00" });
    expect(tooLargeForPayment.status).toBe(409);
    const success = await request(app).post(`/api/remittances/${remittance.id}/match`).set("Cookie", cookie).send({ paymentId: valid.id, amount: "99.00" });
    expect(success.status).toBe(200);
    const repeated = await request(app).post(`/api/remittances/${remittance.id}/match`).set("Cookie", cookie).send({ paymentId: valid.id, amount: "99.00" });
    expect(repeated.status).toBe(409);
    const deleted = await request(app).delete(`/api/remittances/${remittance.id}`).set("Cookie", cookie);
    expect(deleted.status).toBe(200);
    const [released] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, valid.id));
    expect(released.remitted).toBe(false);

    const [claimed] = await makePayment({ remitted: true });
    const [unmatched] = await db.insert(remittancesTable).values({
      clientId: clientAId, authorizationId: authAId, remittanceDate: "2026-07-21",
      amount: "99.00", paymentMonth: "2026-07", status: "received", source: "manual",
    }).returning();
    const alreadyClaimed = await request(app).post(`/api/remittances/${unmatched.id}/match`).set("Cookie", cookie).send({ paymentId: claimed.id, amount: "99.00" });
    expect(alreadyClaimed.status).toBe(409);
  });

  it("allocates multiple partial remittances without closing the payment early and rejects over-allocation", async () => {
    const makePartialRemittance = async (amount: string, date: string) => {
      const [row] = await db.insert(remittancesTable).values({
        clientId: clientAId,
        authorizationId: authAId,
        remittanceDate: date,
        amount,
        paymentMonth: "2026-09",
        status: "received",
        source: "manual",
      }).returning();
      return row;
    };
    const [payment] = await db.insert(paymentsTable).values({
      clientId: clientAId,
      authorizationId: authAId,
      qbCheckNumber: `${nonce}-PARTIAL`,
      checkDate: "2026-09-15",
      paymentMonth: "2026-09",
      amount: "100.00",
      paymentType: "direct_payment",
      source: "manual",
      remitted: false,
    }).returning();
    const first = await makePartialRemittance("60.00", "2026-09-20");
    const second = await makePartialRemittance("50.00", "2026-09-21");

    const firstAllocation = await request(app)
      .post(`/api/remittances/${first.id}/match`)
      .set("Cookie", cookie)
      .send({ paymentId: payment.id, amount: "60.00" });
    expect(firstAllocation.status).toBe(200);
    expect(firstAllocation.body.allocatedAmount).toBe("60.00");
    expect(firstAllocation.body.remainingAmount).toBe("0.00");
    expect((await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id)))[0].remitted).toBe(false);

    const automaticAfterPartial = await request(app).post("/api/remittances").set("Cookie", cookie).send({
      clientId: clientAId,
      authorizationId: authAId,
      altaReference: `${nonce}-AUTO-AFTER-PARTIAL`,
      remittanceDate: "2026-09-20",
      amount: "100.00",
      paymentMonth: "2026-09",
    });
    expect(automaticAfterPartial.status).toBe(201);
    expect(automaticAfterPartial.body.autoMatched).toBe(false);
    expect(automaticAfterPartial.body.allocatedAmount).toBe("0.00");
    const afterRejectedAutoMatch = await request(app).get(`/api/payments/${payment.id}`).set("Cookie", cookie);
    expect(afterRejectedAutoMatch.body.allocatedAmount).toBe("60.00");
    expect(afterRejectedAutoMatch.body.remainingAmount).toBe("40.00");

    const importAfterPartial = await request(app).post("/api/remittances/import").set("Cookie", cookie).send({
      csvText: altaReport(`${nonce}-IMPORT-AFTER-PARTIAL`, "2026-09-20", [{ uci: `${nonce}-UCI-A`, auth: `${nonce}-AUTH-A`, month: "2026-09", amount: "100.00" }]),
    });
    expect(importAfterPartial.status).toBe(200);
    expect(importAfterPartial.body.autoMatched).toBe(0);
    expect(importAfterPartial.body.needsManualMatch).toBe(1);
    const afterRejectedImportMatch = await request(app).get(`/api/payments/${payment.id}`).set("Cookie", cookie);
    expect(afterRejectedImportMatch.body.allocatedAmount).toBe("60.00");
    expect(afterRejectedImportMatch.body.remainingAmount).toBe("40.00");

    const overAllocation = await request(app)
      .post(`/api/remittances/${second.id}/match`)
      .set("Cookie", cookie)
      .send({ paymentId: payment.id, amount: "50.00" });
    expect(overAllocation.status).toBe(409);

    const finalAllocation = await request(app)
      .post(`/api/remittances/${second.id}/match`)
      .set("Cookie", cookie)
      .send({ paymentId: payment.id, amount: "40.00" });
    expect(finalAllocation.status).toBe(200);
    expect(finalAllocation.body.allocatedAmount).toBe("40.00");
    expect(finalAllocation.body.remainingAmount).toBe("10.00");
    expect((await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id)))[0].remitted).toBe(true);

    const detail = await request(app).get(`/api/payments/${payment.id}`).set("Cookie", cookie);
    expect(detail.body.allocatedAmount).toBe("100.00");
    expect(detail.body.remainingAmount).toBe("0.00");
  });

  it("keeps the payment completion flag consistent when deletion races a new allocation", async () => {
    const [payment] = await db.insert(paymentsTable).values({
      clientId: clientAId,
      authorizationId: authAId,
      qbCheckNumber: `${nonce}-DELETE-RACE`,
      checkDate: "2026-10-15",
      paymentMonth: "2026-10",
      amount: "100.00",
      paymentType: "direct_payment",
      source: "manual",
      remitted: false,
    }).returning();
    const [first, second] = await db.insert(remittancesTable).values([
      {
        clientId: clientAId, authorizationId: authAId, remittanceDate: "2026-10-20",
        amount: "60.00", paymentMonth: "2026-10", status: "received", source: "manual",
      },
      {
        clientId: clientAId, authorizationId: authAId, remittanceDate: "2026-10-21",
        amount: "100.00", paymentMonth: "2026-10", status: "received", source: "manual",
      },
    ]).returning();
    const initial = await request(app)
      .post(`/api/remittances/${first.id}/match`)
      .set("Cookie", cookie)
      .send({ paymentId: payment.id, amount: "60.00" });
    expect(initial.status).toBe(200);

    const [deleted, racedAllocation] = await Promise.all([
      request(app).delete(`/api/remittances/${first.id}`).set("Cookie", cookie),
      request(app)
        .post(`/api/remittances/${second.id}/match`)
        .set("Cookie", cookie)
        .send({ paymentId: payment.id, amount: "100.00" }),
    ]);
    expect(deleted.status).toBe(200);
    expect([200, 409]).toContain(racedAllocation.status);

    const detail = await request(app).get(`/api/payments/${payment.id}`).set("Cookie", cookie);
    const allocated = Number(detail.body.allocatedAmount);
    const remaining = Number(detail.body.remainingAmount);
    expect(allocated + remaining).toBe(100);
    expect(detail.body.remitted).toBe(remaining === 0);
    if (racedAllocation.status === 200) {
      expect(allocated).toBe(100);
    } else {
      expect(allocated).toBe(0);
    }
  });
});
