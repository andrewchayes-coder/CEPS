import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db, usersTable, sessionsTable, staffRolesTable, staffRolePermissionsTable, STAFF_PERMISSIONS,
  clientsTable, authorizationsTable, paymentsTable, paymentAllocationsTable, invoicesTable,
  invoiceLineItemsTable, feesTable, auditLogTable, vendorsTable, remittancesTable, remittanceAllocationsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";
import { authorizationTotalsPaid } from "../lib/serializers";

const nonce = `fee-boundary-${Date.now().toString(36)}`;
const clients: string[] = [];
let staffId: string;
let roleId: string;
let vendorId: string;
let cookie: string;
const feeLineError = "490 is the CEPS fee authorization. Fees are created automatically and can't be paid by check.";

beforeAll(async () => {
  const [role] = await db.insert(staffRolesTable).values({ name: nonce }).returning();
  roleId = role.id;
  await db.insert(staffRolePermissionsTable).values(STAFF_PERMISSIONS.map((permission) => ({ roleId, permission })));
  const [staff] = await db.insert(usersTable).values({ name: nonce, email: `${nonce}@test.local`, role: "staff", staffRoleId: roleId }).returning();
  staffId = staff.id;
  const token = newToken();
  await db.insert(sessionsTable).values({ userId: staffId, token, expiresAt: new Date(Date.now() + 3600000) });
  cookie = `ceps_session=${token}`;
  const [vendor] = await db.insert(vendorsTable).values({ name: nonce }).returning();
  vendorId = vendor.id;
});

afterAll(async () => {
  if (clients.length) {
    const remittances = await db.select({ id: remittancesTable.id }).from(remittancesTable).where(inArray(remittancesTable.clientId, clients));
    if (remittances.length) await db.delete(remittanceAllocationsTable).where(inArray(remittanceAllocationsTable.remittanceId, remittances.map(r => r.id)));
    await db.delete(remittancesTable).where(inArray(remittancesTable.clientId, clients));
    await db.delete(feesTable).where(inArray(feesTable.clientId, clients));
    const payments = await db.select({ id: paymentsTable.id }).from(paymentsTable).where(inArray(paymentsTable.clientId, clients));
    if (payments.length) await db.delete(paymentAllocationsTable).where(inArray(paymentAllocationsTable.paymentId, payments.map((p) => p.id)));
    await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, clients));
    const invoices = await db.select({ id: invoicesTable.id }).from(invoicesTable).where(inArray(invoicesTable.clientId, clients));
    if (invoices.length) await db.delete(invoiceLineItemsTable).where(inArray(invoiceLineItemsTable.invoiceId, invoices.map((i) => i.id)));
    await db.delete(invoicesTable).where(inArray(invoicesTable.clientId, clients));
    await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, clients));
    await db.delete(clientsTable).where(inArray(clientsTable.id, clients));
  }
  if (staffId) {
    await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
    await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
    await db.delete(usersTable).where(eq(usersTable.id, staffId));
  }
  if (roleId) {
    await db.delete(staffRolePermissionsTable).where(eq(staffRolePermissionsTable.roleId, roleId));
    await db.delete(staffRolesTable).where(eq(staffRolesTable.id, roleId));
  }
  if (vendorId) await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
});

async function fixture(paymentType = "direct_payment", serviceCode = "459", max = "1000.00") {
  const [client] = await db.insert(clientsTable).values({
    firstName: nonce, lastName: `${clients.length}`, dateOfBirth: "2000-01-01", uciNumber: `${nonce}-${clients.length}`,
  }).returning();
  clients.push(client.id);
  const [auth] = await db.insert(authorizationsTable).values({
    clientId: client.id, vendorId, authNumber: `${nonce}-${clients.length}`, paymentType, serviceCode,
    servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-12-31", maxPeriodAmount: max, oneTimeAmount: "1000.00", status: "active",
  }).returning();
  return { client, auth };
}

async function checkLine(clientId: string, authorizationId: string, amount = "600.00", isDeleted = false) {
  const [payment] = await db.insert(paymentsTable).values({
    clientId, qbCheckNumber: randomUUID(), checkDate: "2026-08-10", amount, paymentType: "direct_payment", source: "manual",
  }).returning();
  // A historical allocation on a 490 remains ignored, without repairing it.
  await db.insert(paymentAllocationsTable).values({ paymentId: payment.id, authorizationId, serviceMonth: "2026-08", amount });
  if (isDeleted) await db.update(paymentsTable).set({ isDeleted: true }).where(eq(paymentsTable.id, payment.id));
  return payment;
}

async function invoiceLine(clientId: string, authorizationId: string, status = "validated", amount = "900.00") {
  const [invoice] = await db.insert(invoicesTable).values({
    clientId, vendorId, submittedByRole: "staff", submittedDate: "2026-08-01", paymentType: "direct_payment", amountRequested: amount, status,
  }).returning();
  if (status !== "needs_entry") {
    await db.insert(invoiceLineItemsTable).values({ invoiceId: invoice.id, authorizationId, serviceMonth: "2026-08", amount });
  }
  return invoice;
}

describe("participant case payment response contract", () => {
  it.each(["none", "partial", "full"])("loads participants with %s-remitted payment lines", async state => {
    const { client, auth } = await fixture();
    const payment = await checkLine(client.id, auth.id);
    const [line] = await db.select().from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, payment.id));
    const remittedAmount = state === "none" ? "0.00" : state === "partial" ? "200.00" : "600.00";
    if (state !== "none") {
      const [remittance] = await db.insert(remittancesTable).values({
        clientId: client.id, authorizationId: auth.id, amount: remittedAmount,
        remittanceDate: "2026-08-20", paymentMonth: "2026-08", status: "received",
      }).returning();
      await db.insert(remittanceAllocationsTable).values({
        remittanceId: remittance.id, paymentId: payment.id, paymentAllocationId: line.id, amount: remittedAmount,
      });
    }
    const participant = await request(app).get(`/api/clients/${client.id}/case`).set("Cookie", cookie);
    expect(participant.status).toBe(200);
    expect(participant.body.client.id).toBe(client.id);
    expect(participant.body.payments[0].allocations[0]).toMatchObject({
      id: line.id, authorizationId: auth.id, serviceMonth: "2026-08", amount: "600.00",
      remittedAmount, remitted: state,
    });
    expect(participant.body.payments[0].allocations[0].remittanceLinks).toHaveLength(state === "none" ? 0 : 1);
    const paymentDetail = await request(app).get(`/api/payments/${payment.id}`).set("Cookie", cookie);
    expect(paymentDetail.status).toBe(200);
    expect(participant.body.payments[0].allocations).toEqual(paymentDetail.body.allocations);
  });

  it("loads participants without payments and returns 404 only for a missing participant", async () => {
    const { client } = await fixture();
    const participant = await request(app).get(`/api/clients/${client.id}/case`).set("Cookie", cookie);
    expect(participant.status).toBe(200);
    expect(participant.body.payments).toEqual([]);
    expect((await request(app).get(`/api/clients/${randomUUID()}/case`).set("Cookie", cookie)).status).toBe(404);
  });
});

describe("CEPS fee counts only against the 490 authorization", () => {
  it.each([["direct_payment", "459"], ["reimbursement", "024"]])("ignores a mislinked fee for %s in every authorization response", async (paymentType, serviceCode) => {
    const { client, auth } = await fixture(paymentType, serviceCode);
    await checkLine(client.id, auth.id);
    await checkLine(client.id, auth.id, "50.00", true);
    const [fee] = await db.insert(feesTable).values({ clientId: client.id, authorizationId: auth.id, feeMonth: "2026-08", amount: "160.00", status: "pending" }).returning();
    expect((await authorizationTotalsPaid([auth.id])).get(auth.id)?.toFixed(2)).toBe("600.00");
    const list = await request(app).get("/api/authorizations").query({ clientId: client.id, status: "active" }).set("Cookie", cookie);
    expect(list.status).toBe(200);
    const detail = await request(app).get(`/api/authorizations/${auth.id}`).set("Cookie", cookie);
    expect(detail.status).toBe(200);
    const participant = await request(app).get(`/api/clients/${client.id}/case`).set("Cookie", cookie);
    expect(participant.status, participant.text).toBe(200);
    for (const response of [list.body.items[0], detail.body, participant.body.authorizations[0]]) {
      expect(response.totalPaid).toBe("600.00");
      expect(response.remainingAmount).toBe("400.00");
      expect(response.status).toBe("active");
    }
    // Reading and calculating must not relink historical fees.
    expect((await db.select().from(feesTable).where(eq(feesTable.id, fee.id)))[0].authorizationId).toBe(auth.id);
  });

  it("exhausts a 490 at its billed-fee max, excluding waived/deleted fees and checks", async () => {
    const { client, auth } = await fixture("fee", "490", "480.00");
    await db.insert(feesTable).values([
      { clientId: client.id, authorizationId: auth.id, feeMonth: "2026-06", amount: "160.00", status: "pending" },
      { clientId: client.id, authorizationId: auth.id, feeMonth: "2026-07", amount: "160.00", status: "collected" },
      { clientId: client.id, authorizationId: auth.id, feeMonth: "2026-08", amount: "160.00", status: "pending" },
      { clientId: client.id, authorizationId: auth.id, feeMonth: "2026-09", amount: "160.00", status: "waived" },
      { clientId: client.id, authorizationId: auth.id, feeMonth: "2026-10", amount: "160.00", status: "pending", isDeleted: true },
    ]);
    await checkLine(client.id, auth.id, "50.00");
    expect((await authorizationTotalsPaid([auth.id])).get(auth.id)?.toFixed(2)).toBe("480.00");
    const list = await request(app).get("/api/authorizations").query({ clientId: client.id, status: "exhausted" }).set("Cookie", cookie);
    const detail = await request(app).get(`/api/authorizations/${auth.id}`).set("Cookie", cookie);
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    for (const response of [list.body.items[0], detail.body]) {
      expect(response.totalPaid).toBe("480.00");
      expect(response.remainingAmount).toBe("0.00");
      expect(response.status).toBe("exhausted");
    }
    const dashboard = await request(app).get("/api/dashboard/summary").set("Cookie", cookie);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.alerts.some((alert: { entityId: string; kind: string }) => alert.entityId === auth.id && alert.kind === "authorization_exhausted_active")).toBe(true);
  });

  it("keeps generating monthly fees after the covering 490 is exhausted", async () => {
    const { client, auth } = await fixture("direct_payment", "459", "1000.00");
    const [feeAuth] = await db.insert(authorizationsTable).values({
      clientId: client.id, authNumber: randomUUID(), serviceCode: "490", paymentType: "fee",
      servicePeriodStart: auth.servicePeriodStart, servicePeriodEnd: auth.servicePeriodEnd,
      maxPeriodAmount: "160.00", status: "active",
    }).returning();
    for (const month of ["2026-08", "2026-09"]) {
      const paid = await request(app).post("/api/payments").set("Cookie", cookie).send({
        clientId: client.id, qbCheckNumber: randomUUID(), checkDate: `${month}-10`,
        amount: "100.00", paymentType: "direct_payment",
        allocations: [{ authorizationId: auth.id, serviceMonth: month, amount: "100.00" }],
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      const feeStatus = await request(app).get(`/api/authorizations/${feeAuth.id}`).set("Cookie", cookie);
      expect(feeStatus.body.status).toBe("exhausted");
    }
    const fees = await db.select().from(feesTable).where(eq(feesTable.clientId, client.id));
    expect(fees).toHaveLength(2);
    expect(fees.every(fee => fee.authorizationId === feeAuth.id && fee.amount === "160.00" && !fee.isDeleted)).toBe(true);
    expect((await authorizationTotalsPaid([feeAuth.id])).get(feeAuth.id)?.toFixed(2)).toBe("320.00");
  });

  it("approves and logs a $900 invoice against a $900 service max despite its fee", async () => {
    const { client, auth } = await fixture("direct_payment", "459", "900.00");
    // A stale stored status must not block validation, approval or payment.
    await db.update(authorizationsTable).set({ status: "pending" }).where(eq(authorizationsTable.id, auth.id));
    await db.insert(feesTable).values({ clientId: client.id, authorizationId: auth.id, feeMonth: "2026-08", amount: "160.00", status: "pending" });
    const invoice = await invoiceLine(client.id, auth.id);
    const validated = await request(app).post(`/api/invoices/${invoice.id}/validate`).set("Cookie", cookie).send({});
    expect(validated.status).toBe(200);
    expect(validated.body.checks.find((check: { check: string }) => check.check === "within_max_period_amount").passed).toBe(true);
    const approved = await request(app).post(`/api/invoices/${invoice.id}/decision`).set("Cookie", cookie).send({ status: "approved" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const payment = await request(app).post("/api/payments").set("Cookie", cookie).send({
      clientId: client.id, invoiceId: invoice.id, qbCheckNumber: randomUUID(), checkDate: "2026-08-10", amount: "900.00", paymentType: "direct_payment",
      allocations: [{ authorizationId: auth.id, serviceMonth: "2026-08", amount: "900.00" }],
    });
    expect(payment.status).toBe(201);
    expect((await authorizationTotalsPaid([auth.id])).get(auth.id)?.toFixed(2)).toBe("900.00");
    const edited = await request(app).patch(`/api/payments/${payment.body.id}`).set("Cookie", cookie).send({
      allocations: [{ authorizationId: auth.id, serviceMonth: "2026-08", amount: "900.00" }],
    });
    expect(edited.status).toBe(200);
  });

  it("rejects service, deleted and cross-participant fee authorizations and auto-links an omitted one", async () => {
    const { client, auth } = await fixture();
    const other = await fixture("fee", "490");
    const [feeAuth] = await db.insert(authorizationsTable).values({
      clientId: client.id, authNumber: randomUUID(), paymentType: "fee", serviceCode: "490",
      servicePeriodStart: "2026-08-01", servicePeriodEnd: "2026-08-31", maxPeriodAmount: "160.00", status: "active",
    }).returning();
    const [deleted] = await db.insert(authorizationsTable).values({
      clientId: client.id, authNumber: randomUUID(), paymentType: "fee", serviceCode: "490",
      servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01", maxPeriodAmount: "160.00", status: "active", isDeleted: true,
    }).returning();
    for (const authorizationId of [auth.id, other.auth.id, deleted.id, randomUUID(), "", "not-a-uuid"]) {
      const rejected = await request(app).post("/api/fees").set("Cookie", cookie).send({ clientId: client.id, authorizationId, amount: "160.00", feeMonth: "2026-08" });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe("Fees can only be linked to the participant's 490 fee authorization");
    }
    const created = await request(app).post("/api/fees").set("Cookie", cookie).send({ clientId: client.id, amount: "160.00", feeMonth: "2026-08" });
    expect(created.status).toBe(201);
    expect(created.body.authorizationId).toBe(feeAuth.id);
  });

  it("rejects 490 check allocations on both create and edit without changing the original line", async () => {
    const { client, auth } = await fixture("fee", "490");
    const [service] = await db.insert(authorizationsTable).values({
      clientId: client.id, authNumber: randomUUID(), paymentType: "direct_payment", serviceCode: "459",
      servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01", maxPeriodAmount: "1000.00", status: "active",
    }).returning();
    const existing = await checkLine(client.id, service.id);
    const allocations = [{ authorizationId: auth.id, serviceMonth: "2026-08", amount: "600.00" }];
    const created = await request(app).post("/api/payments").set("Cookie", cookie).send({
      clientId: client.id, qbCheckNumber: randomUUID(), checkDate: "2026-08-10", amount: "600.00", paymentType: "direct_payment", allocations,
    });
    const edited = await request(app).patch(`/api/payments/${existing.id}`).set("Cookie", cookie).send({ allocations });
    for (const response of [created, edited]) {
      expect(response.status).toBe(400);
      expect(response.body.error).toBe(feeLineError);
    }
    expect((await db.select().from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, existing.id)))[0].authorizationId).toBe(service.id);
  });

  it("rejects 490 invoice lines on create, edit and needs_entry completion", async () => {
    const { client, auth } = await fixture("fee", "490");
    const lines = [{ authorizationId: auth.id, serviceMonth: "2026-08", amount: "100.00" }];
    const created = await request(app).post("/api/invoices").set("Cookie", cookie).send({
      clientId: client.id, paymentType: "direct_payment", lineItems: lines, documentUrl: `/objects/uploads/${staffId}/${randomUUID()}`,
    });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe(feeLineError);
    for (const status of ["pending_review", "needs_entry"]) {
      const existing = await invoiceLine(client.id, auth.id, status, "100.00");
      const edited = await request(app).patch(`/api/invoices/${existing.id}`).set("Cookie", cookie).send({ lineItems: lines, paymentType: "direct_payment" });
      expect(edited.status).toBe(400);
      expect(edited.body.error).toBe(feeLineError);
    }
  });
});
