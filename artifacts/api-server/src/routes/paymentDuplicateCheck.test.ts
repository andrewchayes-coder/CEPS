import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  authorizationsTable,
  paymentsTable,
  feesTable,
  auditLogTable,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";
import { checkDuplicatePayment } from "../lib/paymentDuplicateCheck";

const nonce = `dup${Date.now().toString(36)}`;

let staffId: string;
let clientId: string;
let authId: string;
let cookie: string;
let checkCounter = 0;

const nextCheck = () => `${nonce}-chk-${checkCounter++}`;

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "Dup Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [client] = await db
    .insert(clientsTable)
    .values({ firstName: "Dup", lastName: "Client", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uci` })
    .returning();
  clientId = client.id;

  const [auth] = await db
    .insert(authorizationsTable)
    .values({
      clientId,
      authNumber: `${nonce}-auth`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      maxPeriodAmount: "10000.00",
      status: "active",
    })
    .returning();
  authId = auth.id;

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
  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, clientId));
  await db.delete(authorizationsTable).where(eq(authorizationsTable.clientId, clientId));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId]));
});

// Insert a payment directly (bypassing the route's duplicate guard) so tests
// can set up a pre-existing "blocking" payment.
async function seedPayment(paymentMonth: string, authorizationId: string | null) {
  const [p] = await db
    .insert(paymentsTable)
    .values({
      clientId,
      authorizationId,
      qbCheckNumber: nextCheck(),
      checkDate: `${paymentMonth}-15`,
      amount: "100.00",
      paymentMonth,
      paymentType: "direct_payment",
      source: "manual",
      loggedBy: staffId,
    })
    .returning();
  return p;
}

describe("checkDuplicatePayment (shared function)", () => {
  it("returns isDuplicate=false with no existing payments", async () => {
    const res = await checkDuplicatePayment(db, { clientId, authorizationId: authId, paymentMonth: "2026-02" });
    expect(res.isDuplicate).toBe(false);
    expect(res.existingPayments).toEqual([]);
  });

  it("returns isDuplicate=true and the existing payment for a matching triple", async () => {
    const seeded = await seedPayment("2026-03", authId);
    const res = await checkDuplicatePayment(db, { clientId, authorizationId: authId, paymentMonth: "2026-03" });
    expect(res.isDuplicate).toBe(true);
    expect(res.existingPayments.map((p) => p.id)).toContain(seeded.id);
  });

  it("does not match a payment in a different month", async () => {
    await seedPayment("2026-04", authId);
    const res = await checkDuplicatePayment(db, { clientId, authorizationId: authId, paymentMonth: "2026-05" });
    expect(res.isDuplicate).toBe(false);
  });

  it("matches no-authorization payments when authorizationId is null", async () => {
    const seeded = await seedPayment("2026-06", null);
    const res = await checkDuplicatePayment(db, { clientId, authorizationId: null, paymentMonth: "2026-06" });
    expect(res.isDuplicate).toBe(true);
    expect(res.existingPayments.map((p) => p.id)).toContain(seeded.id);
  });

  it("ignores soft-deleted payments", async () => {
    const seeded = await seedPayment("2026-07", authId);
    await db.update(paymentsTable).set({ isDeleted: true }).where(eq(paymentsTable.id, seeded.id));
    const res = await checkDuplicatePayment(db, { clientId, authorizationId: authId, paymentMonth: "2026-07" });
    expect(res.isDuplicate).toBe(false);
  });

  it("excludes the payment's own id via excludePaymentId", async () => {
    const seeded = await seedPayment("2030-01", authId);
    // Without exclusion the row matches itself.
    const included = await checkDuplicatePayment(db, { clientId, authorizationId: authId, paymentMonth: "2030-01" });
    expect(included.isDuplicate).toBe(true);
    // Excluding its own id makes it a non-duplicate.
    const excluded = await checkDuplicatePayment(db, {
      clientId,
      authorizationId: authId,
      paymentMonth: "2030-01",
      excludePaymentId: seeded.id,
    });
    expect(excluded.isDuplicate).toBe(false);
  });
});

describe("POST /payments duplicate hard stop", () => {
  it("blocks a manual entry with 409 and returns the existing payment(s)", async () => {
    const first = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2026-08-15",
        amount: "100.00",
        paymentMonth: "2026-08",
        paymentType: "direct_payment",
      });
    expect(first.status).toBe(201);

    const dup = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2026-08-20",
        amount: "200.00",
        paymentMonth: "2026-08",
        paymentType: "direct_payment",
      });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate_payment");
    expect(Array.isArray(dup.body.existingPayments)).toBe(true);
    expect(dup.body.existingPayments[0].id).toBe(first.body.id);
    // The blocked payment must NOT have been inserted.
    const rows = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.qbCheckNumber, dup.body.existingPayments[0].qbCheckNumber));
    expect(rows.length).toBe(1);
  });

  it("inserts when overrideDuplicate + justification are provided, and audit-logs the override", async () => {
    await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2026-09-15",
        amount: "100.00",
        paymentMonth: "2026-09",
        paymentType: "direct_payment",
      });

    const overrideCheck = nextCheck();
    const overridden = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: overrideCheck,
        checkDate: "2026-09-20",
        amount: "250.00",
        paymentMonth: "2026-09",
        paymentType: "direct_payment",
        overrideDuplicate: true,
        overrideJustification: "Second authorized service in the same month per CEPS.",
      });
    expect(overridden.status).toBe(201);
    expect(overridden.body.qbCheckNumber).toBe(overrideCheck);

    const auditRows = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.userId, staffId));
    const overrideEntry = auditRows.find((a) => a.action === "override_duplicate_payment");
    expect(overrideEntry).toBeTruthy();
    expect(overrideEntry?.detail).toContain("Second authorized service");
  });

  it("rejects an override with an empty justification (still 409)", async () => {
    await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2026-10-15",
        amount: "100.00",
        paymentMonth: "2026-10",
        paymentType: "direct_payment",
      });

    const res = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2026-10-20",
        amount: "100.00",
        paymentMonth: "2026-10",
        paymentType: "direct_payment",
        overrideDuplicate: true,
        overrideJustification: "   ",
      });
    expect(res.status).toBe(409);
  });

  it("allows a first payment when no duplicate exists", async () => {
    const res = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2026-11-15",
        amount: "100.00",
        paymentMonth: "2026-11",
        paymentType: "direct_payment",
      });
    expect(res.status).toBe(201);
  });

  it("derives paymentMonth from checkDate so the check can't be skipped by omitting the month", async () => {
    // First payment WITH an explicit month.
    const first = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2026-12-15",
        amount: "100.00",
        paymentMonth: "2026-12",
        paymentType: "direct_payment",
      });
    expect(first.status).toBe(201);
    // Server derives 2026-12 from checkDate even though the month is omitted.
    expect(first.body.paymentMonth).toBe("2026-12");

    // Second payment OMITS the month — must still be blocked as a duplicate.
    const dup = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2026-12-20",
        amount: "200.00",
        paymentType: "direct_payment",
      });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate_payment");
  });

  it("keys the POST override audit entry to the NEW payment id (not the client id)", async () => {
    const auth2 = (
      await db
        .insert(authorizationsTable)
        .values({
          clientId,
          authNumber: `${nonce}-auth2`,
          serviceCode: "459",
          paymentType: "direct_payment",
          servicePeriodStart: "2026-01-01",
          servicePeriodEnd: "2026-12-31",
          maxPeriodAmount: "10000.00",
          status: "active",
        })
        .returning()
    )[0];
    await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: auth2.id,
        qbCheckNumber: nextCheck(),
        checkDate: "2028-01-15",
        amount: "100.00",
        paymentMonth: "2028-01",
        paymentType: "direct_payment",
      });
    const overridden = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: auth2.id,
        qbCheckNumber: nextCheck(),
        checkDate: "2028-01-20",
        amount: "250.00",
        paymentMonth: "2028-01",
        paymentType: "direct_payment",
        overrideDuplicate: true,
        overrideJustification: "Second authorized service — audit keyed to payment.",
      });
    expect(overridden.status).toBe(201);
    const [entry] = await db
      .select()
      .from(auditLogTable)
      .where(and(eq(auditLogTable.entityType, "payment"), eq(auditLogTable.entityId, overridden.body.id)));
    // The override audit must exist AND be keyed to the new payment id.
    const overrideRows = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.entityId, overridden.body.id));
    expect(overrideRows.some((a) => a.action === "override_duplicate_payment" && a.detail?.includes("Second authorized service"))).toBe(true);
    expect(entry).toBeTruthy();
  });
});

describe("PATCH /payments/:id duplicate hard stop", () => {
  it("blocks a patch that would create a duplicate (auth+month), excluding the row's own id", async () => {
    // Two payments in DIFFERENT months so neither blocks the other on create.
    const a = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2029-01-15",
        amount: "100.00",
        paymentMonth: "2029-01",
        paymentType: "direct_payment",
      });
    expect(a.status).toBe(201);
    const b = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2029-02-15",
        amount: "100.00",
        paymentMonth: "2029-02",
        paymentType: "direct_payment",
      });
    expect(b.status).toBe(201);

    // Patch B's month to collide with A → 409.
    const collide = await request(app)
      .patch(`/api/payments/${b.body.id}`)
      .set("Cookie", cookie)
      .send({ paymentMonth: "2029-01" });
    expect(collide.status).toBe(409);
    expect(collide.body.code).toBe("duplicate_payment");
    expect(collide.body.existingPayments[0].id).toBe(a.body.id);

    // A no-op patch on A itself (excluding own id) must NOT be blocked.
    const noop = await request(app)
      .patch(`/api/payments/${a.body.id}`)
      .set("Cookie", cookie)
      .send({ paymentMonth: "2029-01" });
    expect(noop.status).toBe(200);
  });

  it("derives the month from a changed checkDate for the PATCH duplicate check", async () => {
    const a = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2029-05-15",
        amount: "100.00",
        paymentMonth: "2029-05",
        paymentType: "direct_payment",
      });
    const b = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2029-06-15",
        amount: "100.00",
        paymentMonth: "2029-06",
        paymentType: "direct_payment",
      });
    // Change only checkDate (month implied) so B lands in A's month → 409.
    const collide = await request(app)
      .patch(`/api/payments/${b.body.id}`)
      .set("Cookie", cookie)
      .send({ checkDate: "2029-05-20" });
    expect(collide.status).toBe(409);
    expect(collide.body.existingPayments[0].id).toBe(a.body.id);
  });

  it("allows the patch with overrideDuplicate + justification and audits it keyed to the payment", async () => {
    const a = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2029-09-15",
        amount: "100.00",
        paymentMonth: "2029-09",
        paymentType: "direct_payment",
      });
    const b = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2029-10-15",
        amount: "100.00",
        paymentMonth: "2029-10",
        paymentType: "direct_payment",
      });
    expect(a.status).toBe(201);

    const overridden = await request(app)
      .patch(`/api/payments/${b.body.id}`)
      .set("Cookie", cookie)
      .send({
        paymentMonth: "2029-09",
        overrideDuplicate: true,
        overrideJustification: "PATCH override justification per CEPS.",
      });
    expect(overridden.status).toBe(200);
    expect(overridden.body.paymentMonth).toBe("2029-09");

    const rows = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.entityId, b.body.id));
    expect(rows.some((a) => a.action === "override_duplicate_payment" && a.detail?.includes("PATCH override justification"))).toBe(true);
  });
});

describe("POST /payments/import duplicate flagging", () => {
  it("flags a row as flagged_duplicate rather than inserting it", async () => {
    // Seed a no-authorization payment for the client in a specific month; import
    // rows carry no authorization, so the check matches on client + month.
    const existing = await seedPayment("2027-01", null);

    const res = await request(app)
      .post("/api/payments/import")
      .set("Cookie", cookie)
      .send({
        rows: [
          {
            qbCheckNumber: nextCheck(),
            checkDate: "2027-01-20",
            amount: "500.00",
            clientName: "Dup Client",
          },
        ],
      });
    expect(res.status).toBe(200);
    const row = res.body.results[0];
    expect(row.outcome).toBe("flagged_duplicate");
    expect(row.paymentId).toBe(existing.id);
    expect(row.message).toContain(existing.qbCheckNumber);
    // The flagged row must NOT have been inserted.
    const inserted = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.qbCheckNumber, row.qbCheckNumber));
    expect(inserted.length).toBe(0);

    // The hold-back must be audit-logged.
    const auditRows = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.userId, staffId));
    expect(auditRows.some((a) => a.action === "flag_duplicate_payment")).toBe(true);
  });

  it("imports a non-duplicate row normally", async () => {
    const res = await request(app)
      .post("/api/payments/import")
      .set("Cookie", cookie)
      .send({
        rows: [
          {
            qbCheckNumber: nextCheck(),
            checkDate: "2027-02-20",
            amount: "500.00",
            clientName: "Dup Client",
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].outcome).toBe("imported");
    expect(res.body.imported).toBe(1);
  });
});
