import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import {
  auditLogTable, authorizationsTable, clientsTable, db, feesTable, invoicesTable,
  paymentsTable, paymentAllocationsTable, invoiceLineItemsTable, remittanceAllocationsTable, remittancesTable, sessionsTable, usersTable, vendorsTable, staffPermissionsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `links${Date.now().toString(36)}`;
let staffId: string, clientA: string, clientB: string, deletedClientId: string, authA: string, authB: string, vendorA: string, vendorB: string, invoiceA: string, invoiceB: string, cookie: string;
let check = 0;
const paymentBody = (extra: Record<string, unknown> = {}) => ({
  clientId: clientA, qbCheckNumber: `${nonce}-check-${check++}`, checkDate: "2026-03-15",
  amount: "100.00", paymentMonth: "2026-03", paymentType: "direct_payment",
  allocations: [{ authorizationId: (extra.authorizationId as string | undefined) ?? authA, serviceMonth: "2026-03", amount: "100.00" }], ...extra,
});

beforeAll(async () => {
  const [staff] = await db.insert(usersTable).values({ name: "Link Staff", email: `${nonce}@test.local`, role: "staff" }).returning();
  staffId = staff.id;
  await db.insert(staffPermissionsTable).values({ userId: staffId, permission: "check_writing" });
  const clients = await db.insert(clientsTable).values([
    { firstName: "Link", lastName: "A", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-a` },
    { firstName: "Link", lastName: "B", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-b` },
  ]).returning();
  clientA = clients[0].id; clientB = clients[1].id;
  const vendors = await db.insert(vendorsTable).values([{ name: `${nonce}-a` }, { name: `${nonce}-b` }]).returning();
  vendorA = vendors[0].id; vendorB = vendors[1].id;
  const auths = await db.insert(authorizationsTable).values([
    { clientId: clientA, vendorId: vendorA, authNumber: `${nonce}-auth-a`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01", oneTimeAmount: "100.00", maxPeriodAmount: "1000.00", status: "active" },
    { clientId: clientB, vendorId: vendorB, authNumber: `${nonce}-auth-b`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01", oneTimeAmount: "100.00", maxPeriodAmount: "1000.00", status: "active" },
  ]).returning();
  authA = auths[0].id; authB = auths[1].id;
  const invoices = await db.insert(invoicesTable).values([
    { clientId: clientA, authorizationId: authA, vendorId: vendorA, submittedByRole: "staff", submittedDate: "2026-03-01", serviceMonth: "2026-03", amountRequested: "100.00", paymentType: "direct_payment", status: "approved" },
    { clientId: clientB, authorizationId: authB, vendorId: vendorB, submittedByRole: "staff", submittedDate: "2026-03-01", serviceMonth: "2026-03", amountRequested: "100.00", paymentType: "direct_payment", status: "approved" },
  ]).returning();
  await db.insert(invoiceLineItemsTable).values([
    { invoiceId: invoices[0].id, authorizationId: authA, serviceMonth: "2026-03", amount: "100.00" },
    { invoiceId: invoices[1].id, authorizationId: authB, serviceMonth: "2026-03", amount: "100.00" },
  ]);
  invoiceA = invoices[0].id; invoiceB = invoices[1].id;
  const token = newToken();
  await db.insert(sessionsTable).values({ userId: staffId, token, expiresAt: new Date(Date.now() + 3_600_000) });
  cookie = `ceps_session=${token}`;
});

afterAll(async () => {
  const payments = await db.select({ id: paymentsTable.id }).from(paymentsTable).where(inArray(paymentsTable.clientId, [clientA, clientB]));
  if (payments.length) await db.delete(remittanceAllocationsTable).where(inArray(remittanceAllocationsTable.paymentId, payments.map((p) => p.id)));
  await db.delete(remittanceAllocationsTable).where(inArray(remittanceAllocationsTable.remittanceId, (await db.select({ id: remittancesTable.id }).from(remittancesTable).where(inArray(remittancesTable.clientId, [clientA, clientB]))).map((r) => r.id)));
  await db.delete(remittancesTable).where(inArray(remittancesTable.clientId, [clientA, clientB]));
  await db.delete(feesTable).where(inArray(feesTable.clientId, [clientA, clientB]));
  await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, [clientA, clientB]));
  await db.delete(invoicesTable).where(inArray(invoicesTable.clientId, [clientA, clientB]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientA, clientB]));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB, deletedClientId].filter(Boolean)));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorA, vendorB]));
  await db.delete(staffPermissionsTable).where(eq(staffPermissionsTable.userId, staffId));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
});

describe("cross-participant create validation", () => {
  it("rejects mismatched invoice links and accepts established same-client links", async () => {
    const base = { clientId: clientA, serviceMonth: "2026-04", amountRequested: "100.00", paymentType: "direct_payment", documentUrl: `/objects/uploads/${staffId}/11111111-1111-4111-8111-111111111111`, lineItems: [{ authorizationId: authA, serviceMonth: "2026-04", amount: "100.00" }] };
    const wrongAuth = await request(app).post("/api/invoices").set("Cookie", cookie).send({ ...base, authorizationId: authB, vendorId: vendorA, lineItems: [{ authorizationId: authB, serviceMonth: "2026-04", amount: "100.00" }] });
    expect(wrongAuth.status).toBe(400); expect(wrongAuth.body.error).toContain("authorizationId");
    const wrongVendor = await request(app).post("/api/invoices").set("Cookie", cookie).send({ ...base, vendorId: vendorB });
    expect(wrongVendor.status).toBe(400); expect(wrongVendor.body.error).toContain("vendorId");
    const unknownAuth = await request(app).post("/api/invoices").set("Cookie", cookie).send({ ...base, authorizationId: "00000000-0000-0000-0000-000000000000", lineItems: [{ authorizationId: "00000000-0000-0000-0000-000000000000", serviceMonth: "2026-04", amount: "100.00" }] });
    expect(unknownAuth.status).toBe(400); expect(unknownAuth.body.error).toContain("authorizationId");
    expect((await request(app).post("/api/invoices").set("Cookie", cookie).send({ ...base, authorizationId: authA, vendorId: vendorA })).status).toBe(201);
  });

  it("rejects mismatched payment links without creating payments or fees", async () => {
    const beforePayments = await db.select().from(paymentsTable).where(eq(paymentsTable.clientId, clientA));
    const beforeFees = await db.select().from(feesTable).where(eq(feesTable.clientId, clientA));
    for (const extra of [{ authorizationId: authB }, { invoiceId: invoiceB }, { vendorId: vendorB }]) {
      expect((await request(app).post("/api/payments").set("Cookie", cookie).send(paymentBody(extra))).status).toBe(400);
    }
    expect((await db.select().from(paymentsTable).where(eq(paymentsTable.clientId, clientA))).length).toBe(beforePayments.length);
    expect((await db.select().from(feesTable).where(eq(feesTable.clientId, clientA))).length).toBe(beforeFees.length);
    expect((await request(app).post("/api/payments").set("Cookie", cookie).send(paymentBody({ authorizationId: authA, invoiceId: invoiceA, vendorId: vendorA }))).status).toBe(201);
  });

  it("rejects a mismatched remittance before a payment claim, then accepts a same-client authorization", async () => {
    const [paymentLink] = await db.select({ paymentId: paymentAllocationsTable.paymentId }).from(paymentAllocationsTable).where(eq(paymentAllocationsTable.authorizationId, authA)).limit(1);
    const [payment] = paymentLink ? await db.select().from(paymentsTable).where(eq(paymentsTable.id, paymentLink.paymentId)) : [];
    const base = { clientId: clientA, altaReference: `${nonce}-remit`, remittanceDate: "2026-03-20", amount: "100.00", paymentMonth: "2026-03" };
    expect((await request(app).post("/api/remittances").set("Cookie", cookie).send({ ...base, authorizationId: authB })).status).toBe(400);
    expect((await db.select().from(remittancesTable).where(eq(remittancesTable.clientId, clientA))).length).toBe(0);
    expect((await db.select().from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.paymentId, payment.id))).length).toBe(0);
    expect((await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id)))[0].remitted).toBe(false);
    expect((await request(app).post("/api/remittances").set("Cookie", cookie).send({ ...base, authorizationId: authA })).status).toBe(201);
  });

  it("rejects sequentially soft-deleted related records with field-specific errors and no writes", async () => {
    const [deletedClient] = await db.insert(clientsTable).values({
      firstName: "Deleted", lastName: "Client", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-deleted-client`,
    }).returning();
    deletedClientId = deletedClient.id;
    const [deletedAuth] = await db.insert(authorizationsTable).values({
      clientId: clientA, vendorId: vendorA, authNumber: `${nonce}-deleted-auth`, serviceCode: "459",
      paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2099-01-01",
      oneTimeAmount: "100.00", maxPeriodAmount: "1000.00", status: "active",
    }).returning();
    const [deletedInvoice] = await db.insert(invoicesTable).values({
      clientId: clientA, authorizationId: authA, vendorId: vendorA, submittedByRole: "staff",
      submittedDate: "2026-03-01", serviceMonth: "2026-05", amountRequested: "100.00", paymentType: "direct_payment",
    }).returning();
    await db.insert(invoiceLineItemsTable).values({ invoiceId: deletedInvoice.id, authorizationId: authA, serviceMonth: "2026-05", amount: "100.00" });
    await db.update(clientsTable).set({ isDeleted: true }).where(eq(clientsTable.id, deletedClient.id));
    await db.update(authorizationsTable).set({ isDeleted: true }).where(eq(authorizationsTable.id, deletedAuth.id));
    await db.update(invoicesTable).set({ isDeleted: true }).where(eq(invoicesTable.id, deletedInvoice.id));
    const before = {
      payments: (await db.select().from(paymentsTable).where(eq(paymentsTable.clientId, clientA))).length,
      fees: (await db.select().from(feesTable).where(eq(feesTable.clientId, clientA))).length,
      remittances: (await db.select().from(remittancesTable).where(eq(remittancesTable.clientId, clientA))).length,
      allocations: (await db.select({ id: remittanceAllocationsTable.id })
        .from(remittanceAllocationsTable)
        .innerJoin(paymentsTable, eq(remittanceAllocationsTable.paymentId, paymentsTable.id))
        .where(eq(paymentsTable.clientId, clientA))).length,
    };
    const invoiceDeletedAuth = await request(app).post("/api/invoices").set("Cookie", cookie).send({
      clientId: clientA, authorizationId: deletedAuth.id, vendorId: vendorA, serviceMonth: "2026-06", amountRequested: "100.00", paymentType: "direct_payment",
      documentUrl: `/objects/uploads/${staffId}/11111111-1111-4111-8111-111111111111`,
      lineItems: [{ authorizationId: deletedAuth.id, serviceMonth: "2026-06", amount: "100.00" }],
    });
    expect(invoiceDeletedAuth.status).toBe(400); expect(invoiceDeletedAuth.body.error).toContain("authorizationId");
    const deletedClientResult = await request(app).post("/api/invoices").set("Cookie", cookie).send({
      clientId: deletedClient.id, serviceMonth: "2026-06", amountRequested: "100.00", paymentType: "direct_payment",
      documentUrl: `/objects/uploads/${staffId}/11111111-1111-4111-8111-111111111111`,
      lineItems: [{ authorizationId: authA, serviceMonth: "2026-06", amount: "100.00" }],
    });
    expect(deletedClientResult.status).toBe(400); expect(deletedClientResult.body.error).toContain("clientId");
    const paymentDeletedAuth = await request(app).post("/api/payments").set("Cookie", cookie).send(paymentBody({ authorizationId: deletedAuth.id }));
    expect(paymentDeletedAuth.status).toBe(400); expect(paymentDeletedAuth.body.error).toContain("authorizationId");
    const paymentDeletedInvoice = await request(app).post("/api/payments").set("Cookie", cookie).send(paymentBody({ invoiceId: deletedInvoice.id }));
    expect(paymentDeletedInvoice.status).toBe(400); expect(paymentDeletedInvoice.body.error).toContain("invoiceId");
    const remittanceDeletedAuth = await request(app).post("/api/remittances").set("Cookie", cookie).send({
      clientId: clientA, authorizationId: deletedAuth.id, altaReference: `${nonce}-deleted-remit`,
      remittanceDate: "2026-06-20", amount: "100.00", paymentMonth: "2026-06",
    });
    expect(remittanceDeletedAuth.status).toBe(400); expect(remittanceDeletedAuth.body.error).toContain("authorizationId");
    expect((await db.select().from(paymentsTable).where(eq(paymentsTable.clientId, clientA))).length).toBe(before.payments);
    expect((await db.select().from(feesTable).where(eq(feesTable.clientId, clientA))).length).toBe(before.fees);
    expect((await db.select().from(remittancesTable).where(eq(remittancesTable.clientId, clientA))).length).toBe(before.remittances);
    expect((await db.select({ id: remittanceAllocationsTable.id })
      .from(remittanceAllocationsTable)
      .innerJoin(paymentsTable, eq(remittanceAllocationsTable.paymentId, paymentsTable.id))
      .where(eq(paymentsTable.clientId, clientA))).length).toBe(before.allocations);
  });
});