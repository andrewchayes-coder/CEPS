import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

  // An unremitted payment that the first row should AUTO-MATCH (same client,
  // same amount, same month).
  const [pay] = await db
    .insert(paymentsTable)
    .values({
      clientId: clientAId,
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

const CSV_HEADER = "Client UCI Number,Authorization Number,Service Month,Amount,Check/Payment Number,Payment Date";

describe("POST /remittances/import (Alta batch import)", () => {
  it("imports a batch: shared batch id, auto-match runs, unresolvable rows errored, audit logged", async () => {
    const csvText = [
      CSV_HEADER,
      // Row 2: resolves client A + auth A, amount/month match the payment → auto_matched
      `${nonce}-UCI-A,${nonce}-AUTH-A,2026-01,500.00,C1,2026-01-20`,
      // Row 3: resolves client B, no matching payment → needs_manual_match
      `${nonce}-UCI-B,,2026-02,42.00,,2026-02-20`,
      // Row 4: unknown UCI → errored
      `${nonce}-UCI-MISSING,,,10.00,,2026-02-20`,
      // Row 5: known client A but bad auth number scoped to that client → errored
      `${nonce}-UCI-A,AUTH-DOES-NOT-EXIST,,10.00,,2026-02-20`,
    ].join("\n");
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
    expect(byRow.get(2)?.outcome).toBe("auto_matched");
    expect(byRow.get(2)?.matchedPaymentId).toBe(matchPaymentId);
    expect(byRow.get(3)?.outcome).toBe("needs_manual_match");
    expect(byRow.get(4)?.outcome).toBe("errored");
    expect(byRow.get(5)?.outcome).toBe("errored");

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

    // The unmatched-but-imported line is flagged for manual matching.
    const manual = inserted.find((r) => r.matchedPaymentId === null);
    expect(manual?.status).toBe("received");
    expect(manual?.autoMatched).toBe(false);

    // Import run is audit-logged.
    const audits = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.userId, staffId));
    const importAudit = audits.find((a) => a.action === "import_alta_remittances");
    expect(importAudit).toBeTruthy();
    expect(importAudit?.detail).toContain(body.remittanceBatchId);
  });

  it("filters the remittances list by remittanceBatchId", async () => {
    // Import a small batch, then confirm the list endpoint returns only its rows.
    const csvText = [
      CSV_HEADER,
      `${nonce}-UCI-B,,,7.00,,2026-03-01`,
      `${nonce}-UCI-B,,,8.00,,2026-03-01`,
    ].join("\n");
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
    const csvText = [
      CSV_HEADER,
      `${nonce}-UCI-B,,2026-04,11.00,DUP-1,2026-04-01`,
      `${nonce}-UCI-B,,2026-04,12.00,DUP-2,2026-04-01`,
    ].join("\n");

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

    const csvText = [CSV_HEADER, `${nonce}-UCI-B,,2026-05,777.00,RACE-1,2026-05-20`].join("\n");
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
});
