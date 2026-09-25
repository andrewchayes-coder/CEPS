import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  authorizationsTable,
  paymentsTable,
  paymentAllocationsTable,
  feesTable,
  auditLogTable,
  staffPermissionsTable,
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
const uciNumber = String(1_000_000 + (Date.now() % 9_000_000));

const nextCheck = () => `${nonce}-chk-${checkCounter++}`;

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "Dup Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  await db.insert(staffPermissionsTable).values({ userId: staffId, permission: "check_writing" });

  const [client] = await db
    .insert(clientsTable)
    .values({ firstName: "Dup", lastName: "Client", dateOfBirth: "2000-01-01", uciNumber })
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
  await db.delete(staffPermissionsTable).where(eq(staffPermissionsTable.userId, staffId));
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
  if (authorizationId) {
    await db.insert(paymentAllocationsTable).values({ paymentId: p.id, authorizationId, serviceMonth: paymentMonth, amount: "100.00" });
  }
  return p;
}

describe("checkDuplicatePayment (shared function)", () => {
  it("returns isDuplicate=false with no existing payments", async () => {
    const res = await checkDuplicatePayment(db, { clientId, authorizationId: authId, serviceMonth: "2026-02" });
    expect(res.isDuplicate).toBe(false);
    expect(res.existingPayments).toEqual([]);
  });

  it("returns isDuplicate=true and the existing payment for a matching triple", async () => {
    const seeded = await seedPayment("2026-03", authId);
    const res = await checkDuplicatePayment(db, { clientId, authorizationId: authId, serviceMonth: "2026-03" });
    expect(res.isDuplicate).toBe(true);
    expect(res.existingPayments.map((p) => p.id)).toContain(seeded.id);
  });

  it("does not match a payment in a different month", async () => {
    await seedPayment("2026-04", authId);
    const res = await checkDuplicatePayment(db, { clientId, authorizationId: authId, serviceMonth: "2026-05" });
    expect(res.isDuplicate).toBe(false);
  });

  it("uses the allocation service month and retains the parent-only legacy fallback", async () => {
    const [allocationMonthPayment] = await db.insert(paymentsTable).values({
      clientId,
      authorizationId: null,
      qbCheckNumber: nextCheck(),
      checkDate: "2037-02-15",
      amount: "100.00",
      paymentMonth: "2037-01",
      paymentType: "direct_payment",
      source: "manual",
      loggedBy: staffId,
    }).returning();
    await db.insert(paymentAllocationsTable).values({
      paymentId: allocationMonthPayment.id,
      authorizationId: authId,
      serviceMonth: "2037-02",
      amount: "100.00",
    });
    expect((await checkDuplicatePayment(db, {
      clientId, authorizationId: authId, serviceMonth: "2037-02",
    })).isDuplicate).toBe(true);
    expect((await checkDuplicatePayment(db, {
      clientId, authorizationId: authId, serviceMonth: "2037-01",
    })).isDuplicate).toBe(false);

    const [parentOnlyPayment] = await db.insert(paymentsTable).values({
      clientId,
      authorizationId: authId,
      qbCheckNumber: nextCheck(),
      checkDate: "2037-03-15",
      amount: "100.00",
      paymentMonth: "2037-03",
      paymentType: "direct_payment",
      source: "manual",
      loggedBy: staffId,
    }).returning();
    expect((await checkDuplicatePayment(db, {
      clientId, authorizationId: authId, serviceMonth: "2037-03",
    })).existingPayments.map((payment) => payment.id)).toContain(parentOnlyPayment.id);
  });

  it("matches no-authorization payments when authorizationId is null", async () => {
    const seeded = await seedPayment("2026-06", null);
    const res = await checkDuplicatePayment(db, { clientId, authorizationId: null, serviceMonth: "2026-06" });
    expect(res.isDuplicate).toBe(true);
    expect(res.existingPayments.map((p) => p.id)).toContain(seeded.id);
  });

  it("ignores soft-deleted payments", async () => {
    const seeded = await seedPayment("2026-07", authId);
    await db.update(paymentsTable).set({ isDeleted: true }).where(eq(paymentsTable.id, seeded.id));
    const res = await checkDuplicatePayment(db, { clientId, authorizationId: authId, serviceMonth: "2026-07" });
    expect(res.isDuplicate).toBe(false);
  });

  it("excludes the payment's own id via excludePaymentId", async () => {
    const seeded = await seedPayment("2030-01", authId);
    // Without exclusion the row matches itself.
    const included = await checkDuplicatePayment(db, { clientId, authorizationId: authId, serviceMonth: "2030-01" });
    expect(included.isDuplicate).toBe(true);
    // Excluding its own id makes it a non-duplicate.
    const excluded = await checkDuplicatePayment(db, {
      clientId,
      authorizationId: authId,
      serviceMonth: "2030-01",
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
        allocations: [{ authorizationId: authId, serviceMonth: "2026-08", amount: "100.00" }],
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
        allocations: [{ authorizationId: authId, serviceMonth: "2026-08", amount: "200.00" }],
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
        allocations: [{ authorizationId: authId, serviceMonth: "2026-09", amount: "100.00" }],
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
        allocations: [{ authorizationId: authId, serviceMonth: "2026-09", amount: "250.00" }],
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
        allocations: [{ authorizationId: authId, serviceMonth: "2026-10", amount: "100.00" }],
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
        allocations: [{ authorizationId: authId, serviceMonth: "2026-10", amount: "100.00" }],
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
        allocations: [{ authorizationId: authId, serviceMonth: "2026-11", amount: "100.00" }],
        paymentMonth: "2026-11",
        paymentType: "direct_payment",
      });
    expect(res.status).toBe(201);
  });

  it("derives paymentMonth from allocations instead of the check date", async () => {
    const first = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2026-12-15",
        amount: "100.00",
        allocations: [{ authorizationId: authId, serviceMonth: "2026-02", amount: "100.00" }],
        paymentType: "direct_payment",
      });
    expect(first.status).toBe(201);
    expect(first.body.paymentMonth).toBe("2026-02");

    const dup = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2027-01-20",
        amount: "200.00",
        allocations: [{ authorizationId: authId, serviceMonth: "2026-02", amount: "200.00" }],
        paymentType: "direct_payment",
      });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate_payment");
  });

  it("allows multiple allocation months for one authorization but rejects the same auth-month pair across payments", async () => {
    const [multiMonthAuth] = await db.insert(authorizationsTable).values({
      clientId,
      authNumber: `${nonce}-multi-month`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2036-12-31",
      maxPeriodAmount: "10000.00",
      status: "active",
    }).returning();
    const response = await request(app).post("/api/payments").set("Cookie", cookie).send({
      clientId,
      qbCheckNumber: nextCheck(),
      checkDate: "2035-04-15",
      amount: "30.00",
      paymentType: "direct_payment",
      allocations: [
        { authorizationId: multiMonthAuth.id, serviceMonth: "2035-01", amount: "10.00" },
        { authorizationId: multiMonthAuth.id, serviceMonth: "2035-02", amount: "10.00" },
        { authorizationId: multiMonthAuth.id, serviceMonth: "2035-03", amount: "10.00" },
      ],
    });
    expect(response.status).toBe(201);
    expect(response.body.paymentMonth).toBe("2035-01");
    expect(response.body.allocations.map((allocation: { serviceMonth: string }) => allocation.serviceMonth).sort())
      .toEqual(["2035-01", "2035-02", "2035-03"]);

    const duplicateLine = await request(app).post("/api/payments").set("Cookie", cookie).send({
      clientId,
      qbCheckNumber: nextCheck(),
      checkDate: "2035-12-15",
      amount: "10.00",
      paymentType: "direct_payment",
      allocations: [
        { authorizationId: multiMonthAuth.id, serviceMonth: "2035-05", amount: "5.00" },
        { authorizationId: multiMonthAuth.id, serviceMonth: "2035-05", amount: "5.00" },
      ],
    });
    expect(duplicateLine.status).toBe(400);

    const duplicate = await request(app).post("/api/payments").set("Cookie", cookie).send({
      clientId,
      qbCheckNumber: nextCheck(),
      checkDate: "2035-12-15",
      amount: "10.00",
      paymentType: "direct_payment",
      allocations: [{ authorizationId: multiMonthAuth.id, serviceMonth: "2035-02", amount: "10.00" }],
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("duplicate_payment");

    const anotherMonth = await request(app).post("/api/payments").set("Cookie", cookie).send({
      clientId,
      qbCheckNumber: nextCheck(),
      checkDate: "2035-12-15",
      amount: "10.00",
      paymentType: "direct_payment",
      allocations: [{ authorizationId: multiMonthAuth.id, serviceMonth: "2035-04", amount: "10.00" }],
    });
    expect(anotherMonth.status).toBe(201);
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
        allocations: [{ authorizationId: auth2.id, serviceMonth: "2028-01", amount: "100.00" }],
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
        allocations: [{ authorizationId: auth2.id, serviceMonth: "2028-01", amount: "250.00" }],
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
        allocations: [{ authorizationId: authId, serviceMonth: "2029-01", amount: "100.00" }],
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
        allocations: [{ authorizationId: authId, serviceMonth: "2029-02", amount: "100.00" }],
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

  it("keeps allocation service month independent from check date and checks PATCH allocation months", async () => {
    const a = await request(app)
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({
        clientId,
        authorizationId: authId,
        qbCheckNumber: nextCheck(),
        checkDate: "2029-05-15",
        amount: "100.00",
        allocations: [{ authorizationId: authId, serviceMonth: "2029-05", amount: "100.00" }],
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
        allocations: [{ authorizationId: authId, serviceMonth: "2029-06", amount: "100.00" }],
        paymentMonth: "2029-06",
        paymentType: "direct_payment",
      });
    const changedCheckDate = await request(app)
      .patch(`/api/payments/${b.body.id}`)
      .set("Cookie", cookie)
      .send({ checkDate: "2029-05-20" });
    expect(changedCheckDate.status).toBe(200);
    expect(changedCheckDate.body.paymentMonth).toBe("2029-06");

    const collide = await request(app)
      .patch(`/api/payments/${b.body.id}`)
      .set("Cookie", cookie)
      .send({
        allocations: [{ authorizationId: authId, serviceMonth: "2029-05", amount: "100.00" }],
      });
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
        allocations: [{ authorizationId: authId, serviceMonth: "2029-09", amount: "100.00" }],
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
        allocations: [{ authorizationId: authId, serviceMonth: "2029-10", amount: "100.00" }],
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
    const existing = await seedPayment("2027-01", authId);
    const incomingCheck = nextCheck();

    const res = await request(app)
      .post("/api/payments/import")
      .set("Cookie", cookie)
      .send({
        worksheetRows: [
          ["Transaction date", "Transaction type", "Num", "Name", "Description", "Split", "Amount", "Customer"],
          [
            "01/20/2027",
            "Check",
            incomingCheck,
            "Synthetic Vendor",
            `Services/Jan 27/${nonce}-auth`,
            "",
            "500.00",
            `Synthetic, Participant ${uciNumber} (1)`,
          ],
        ],
        acknowledgements: [{ rowNumber: 2, note: "Existing duplicate test fixture has no invoice." }],
      });
    expect(res.status).toBe(200);
    const row = res.body.results[0];
    expect(row.outcome).toBe("flagged_duplicate");
    expect(res.body.flaggedDuplicate).toBe(1);
    expect(row.paymentId).toBe(existing.id);
    expect(row.message).toContain(existing.qbCheckNumber);
    // The flagged row must NOT have been inserted.
    const inserted = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.qbCheckNumber, incomingCheck));
    expect(inserted.length).toBe(0);

    // The hold-back must be audit-logged.
    const auditRows = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.userId, staffId));
    expect(auditRows.some((a) => a.action === "flag_duplicate_payment")).toBe(true);
  });

  it("imports a non-duplicate row normally", async () => {
    const incomingCheck = nextCheck();
    const res = await request(app)
      .post("/api/payments/import")
      .set("Cookie", cookie)
      .send({
        worksheetRows: [
          ["Transaction date", "Transaction type", "Num", "Name", "Description", "Split", "Amount", "Customer"],
          [
            "02/20/2027",
            "Check",
            incomingCheck,
            "Synthetic Vendor",
            `Services/Feb 27/${nonce}-auth`,
            "",
            "500.00",
            `Synthetic, Participant ${uciNumber} (1)`,
          ],
        ],
        acknowledgements: [{ rowNumber: 2, note: "Existing import test fixture has no invoice." }],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].outcome).toBe("imported");
    expect(res.body.imported).toBe(1);
  });
});
