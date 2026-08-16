import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db, usersTable, sessionsTable, clientsTable, invoicesTable, authorizationsTable, paymentsTable, auditLogTable, vendorsTable } from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `inv${Date.now().toString(36)}`;

let staffId: string;
let clientId: string;
let cookie: string;

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "Inv Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [client] = await db
    .insert(clientsTable)
    .values({ firstName: "Inv", lastName: "Client", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uci` })
    .returning();
  clientId = client.id;

  const token = newToken();
  await db.insert(sessionsTable).values({
    userId: staffId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  cookie = `ceps_session=${token}`;
});

const vendorIds: string[] = [];

afterAll(async () => {
  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, clientId));
  await db.delete(invoicesTable).where(eq(invoicesTable.clientId, clientId));
  await db.delete(authorizationsTable).where(eq(authorizationsTable.clientId, clientId));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  if (vendorIds.length) await db.delete(vendorsTable).where(inArray(vendorsTable.id, vendorIds));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId]));
});

async function makeVendor(active: boolean) {
  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: `${nonce}-vendor-${vendorIds.length}`, active })
    .returning();
  vendorIds.push(vendor.id);
  return vendor;
}

async function makeInvoiceForVendor(authId: string, vendorId: string, amountRequested = "100.00", serviceMonth = "2026-01") {
  const [inv] = await db
    .insert(invoicesTable)
    .values({
      clientId,
      authorizationId: authId,
      vendorId,
      submittedByRole: "staff",
      submittedDate: "2026-01-01",
      serviceMonth,
      amountRequested,
      paymentType: "direct_payment",
      status: "pending_review",
    })
    .returning();
  return inv;
}

let authCounter = 0;

async function makeInvoice(status: string) {
  const [inv] = await db
    .insert(invoicesTable)
    .values({
      clientId,
      submittedByRole: "staff",
      submittedDate: "2026-01-01",
      serviceMonth: "2026-01",
      amountRequested: "100.00",
      paymentType: "direct_payment",
      status,
    })
    .returning();
  return inv;
}

async function makeAuth(opts: { monthlyAmount?: string | null; oneTimeAmount?: string | null; maxPeriodAmount: string }) {
  const [auth] = await db
    .insert(authorizationsTable)
    .values({
      clientId,
      authNumber: `${nonce}-auth-${authCounter++}`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2099-12-31",
      monthlyAmount: opts.monthlyAmount ?? null,
      oneTimeAmount: opts.oneTimeAmount ?? null,
      maxPeriodAmount: opts.maxPeriodAmount,
      status: "active",
    })
    .returning();
  return auth;
}

async function makeInvoiceFor(authId: string, amountRequested: string, serviceMonth = "2026-01") {
  const [inv] = await db
    .insert(invoicesTable)
    .values({
      clientId,
      authorizationId: authId,
      submittedByRole: "staff",
      submittedDate: "2026-01-01",
      serviceMonth,
      amountRequested,
      paymentType: "direct_payment",
      status: "pending_review",
    })
    .returning();
  return inv;
}

// Fetch a specific validation check result by name.
function checkOf(body: { checks: { check: string; passed: boolean; message: string }[] }, name: string) {
  return body.checks.find((c) => c.check === name)!;
}

describe("PATCH /invoices/:id status reset on material edit", () => {
  it("resets a validated invoice to pending_review when amountRequested changes", async () => {
    const inv = await makeInvoice("validated");
    const res = await request(app)
      .patch(`/api/invoices/${inv.id}`)
      .set("Cookie", cookie)
      .send({ amountRequested: "200.00" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending_review");
    expect(res.body.amountRequested).toBe("200.00");
  });

  it("resets when serviceMonth changes on a duplicate invoice", async () => {
    const inv = await makeInvoice("duplicate");
    const res = await request(app)
      .patch(`/api/invoices/${inv.id}`)
      .set("Cookie", cookie)
      .send({ serviceMonth: "2026-02" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending_review");
  });

  it("does NOT reset when a non-material field changes", async () => {
    const inv = await makeInvoice("validated");
    const res = await request(app)
      .patch(`/api/invoices/${inv.id}`)
      .set("Cookie", cookie)
      .send({ notes: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("validated");
  });

  it("does NOT reset when the material value is unchanged", async () => {
    const inv = await makeInvoice("validated");
    const res = await request(app)
      .patch(`/api/invoices/${inv.id}`)
      .set("Cookie", cookie)
      .send({ amountRequested: "100.00" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("validated");
  });

  it("honors an explicit status even when a material field changes", async () => {
    const inv = await makeInvoice("validated");
    const res = await request(app)
      .patch(`/api/invoices/${inv.id}`)
      .set("Cookie", cookie)
      .send({ amountRequested: "300.00", status: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.reviewedBy).toBe(staffId);
  });
});

describe("POST /invoices/:id/validate decimal-safe money math", () => {
  // amount_matches: requested <= authorized, exact to the cent.
  it("passes amount_matches when requested exactly equals a float-drift-prone authorized sum", async () => {
    // 0.1 + 0.2 = 0.30000000000000004 in binary float; stored/authorized is 0.30.
    const auth = await makeAuth({ oneTimeAmount: "0.30", maxPeriodAmount: "1000000.00" });
    const inv = await makeInvoiceFor(auth.id, "0.30");
    const res = await request(app).post(`/api/invoices/${inv.id}/validate`).set("Cookie", cookie).send({});
    expect(res.status).toBe(200);
    expect(checkOf(res.body, "amount_matches").passed).toBe(true);
  });

  it("fails amount_matches when requested exceeds authorized by a single cent", async () => {
    const auth = await makeAuth({ oneTimeAmount: "0.30", maxPeriodAmount: "1000000.00" });
    const inv = await makeInvoiceFor(auth.id, "0.31");
    const res = await request(app).post(`/api/invoices/${inv.id}/validate`).set("Cookie", cookie).send({});
    expect(res.status).toBe(200);
    expect(checkOf(res.body, "amount_matches").passed).toBe(false);
  });

  // within_max_period_amount: SQL SUM of prior payments + this invoice <= max.
  it("passes within_max_period_amount at the exact boundary despite many small uneven prior payments", async () => {
    // 30 payments of 0.10 = exactly 3.00; a naive Number() reduce drifts.
    const auth = await makeAuth({ maxPeriodAmount: "3.10" });
    for (let i = 0; i < 30; i++) {
      await db.insert(paymentsTable).values({
        clientId,
        authorizationId: auth.id,
        qbCheckNumber: `${nonce}-inv-pay-${authCounter}-${i}`,
        checkDate: "2026-01-15",
        amount: "0.10",
        paymentType: "direct_payment",
        source: "manual",
        loggedBy: staffId,
      });
    }
    // 3.00 already paid + 0.10 invoice = 3.10 == max exactly → within.
    const within = await makeInvoiceFor(auth.id, "0.10", "2026-02");
    const resWithin = await request(app).post(`/api/invoices/${within.id}/validate`).set("Cookie", cookie).send({});
    expect(resWithin.status).toBe(200);
    expect(checkOf(resWithin.body, "within_max_period_amount").passed).toBe(true);
    expect(checkOf(resWithin.body, "within_max_period_amount").message).toContain("$3.10");
  });

  it("fails within_max_period_amount when the cumulative sum exceeds the max by a cent", async () => {
    const auth = await makeAuth({ maxPeriodAmount: "3.09" });
    for (let i = 0; i < 30; i++) {
      await db.insert(paymentsTable).values({
        clientId,
        authorizationId: auth.id,
        qbCheckNumber: `${nonce}-inv-pay2-${authCounter}-${i}`,
        checkDate: "2026-01-15",
        amount: "0.10",
        paymentType: "direct_payment",
        source: "manual",
        loggedBy: staffId,
      });
    }
    // 3.00 paid + 0.10 = 3.10 > 3.09 → exceeds.
    const over = await makeInvoiceFor(auth.id, "0.10", "2026-02");
    const resOver = await request(app).post(`/api/invoices/${over.id}/validate`).set("Cookie", cookie).send({});
    expect(resOver.status).toBe(200);
    expect(checkOf(resOver.body, "within_max_period_amount").passed).toBe(false);
  });
});

describe("POST /invoices/:id/validate vendor_active check", () => {
  it("passes vendor_active when the invoice's vendor is active", async () => {
    const auth = await makeAuth({ oneTimeAmount: "100.00", maxPeriodAmount: "1000000.00" });
    const vendor = await makeVendor(true);
    const inv = await makeInvoiceForVendor(auth.id, vendor.id);
    const res = await request(app).post(`/api/invoices/${inv.id}/validate`).set("Cookie", cookie).send({});
    expect(res.status).toBe(200);
    expect(checkOf(res.body, "vendor_active").passed).toBe(true);
  });

  it("fails vendor_active when the invoice's vendor is deactivated", async () => {
    const auth = await makeAuth({ oneTimeAmount: "100.00", maxPeriodAmount: "1000000.00" });
    const vendor = await makeVendor(false);
    const inv = await makeInvoiceForVendor(auth.id, vendor.id);
    const res = await request(app).post(`/api/invoices/${inv.id}/validate`).set("Cookie", cookie).send({});
    expect(res.status).toBe(200);
    const check = checkOf(res.body, "vendor_active");
    expect(check.passed).toBe(false);
    expect(check.message).toContain("deactivated");
    // A deactivated vendor makes the whole validation fail.
    expect(res.body.valid).toBe(false);
  });
});
