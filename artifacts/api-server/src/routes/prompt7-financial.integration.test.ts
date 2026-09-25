import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db, clientsTable, authorizationsTable, invoicesTable, invoiceLineItemsTable,
  paymentsTable, paymentAllocationsTable, usersTable, sessionsTable,
  vendorsTable, remittancesTable, remittanceAllocationsTable,
  staffRolesTable,
  staffRolePermissionsTable,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const staffRoleIds: string[] = [];
const staffUserIds: string[] = [];

async function assignStaffRole(userId: string, permissions = ["check_writing", "invoice_log_validate"]) {
  const [role] = await db.insert(staffRolesTable).values({ name: `p7 role ${userId}` }).returning();
  staffRoleIds.push(role.id);
  staffUserIds.push(userId);
  if (permissions.length) {
    await db.insert(staffRolePermissionsTable).values(permissions.map((permission) => ({ roleId: role.id, permission })));
  }
  await db.update(usersTable).set({ staffRoleId: role.id }).where(eq(usersTable.id, userId));
}

afterAll(async () => {
  if (staffUserIds.length) await db.update(usersTable).set({ staffRoleId: null }).where(inArray(usersTable.id, staffUserIds));
  if (staffRoleIds.length) await db.delete(staffRolesTable).where(inArray(staffRolesTable.id, staffRoleIds));
});

describe("Prompt 7 financial child rows (database)", () => {
  it("persists three invoice lines and split payment allocations with exact aggregates", async () => {
    const nonce = `p7-${Date.now()}-${Math.random()}`;
    const [client] = await db.insert(clientsTable).values({
      firstName: "Prompt", lastName: "Seven", dateOfBirth: "2000-01-01", uciNumber: nonce,
    }).returning();
    const [authA, authB] = await db.insert(authorizationsTable).values([
      { clientId: client.id, authNumber: `${nonce}-a`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2025-01-01", servicePeriodEnd: "2025-12-31", maxPeriodAmount: "100.00", status: "active" },
      { clientId: client.id, authNumber: `${nonce}-b`, serviceCode: "490", paymentType: "direct_payment", servicePeriodStart: "2025-01-01", servicePeriodEnd: "2025-12-31", maxPeriodAmount: "100.00", status: "active" },
    ] as any).returning();
    const [staff] = await db.insert(usersTable).values({ name: "Prompt 7 Staff", email: `${nonce}@test.local`, role: "staff" }).returning();
    await assignStaffRole(staff.id);
    const token = newToken();
    await db.insert(sessionsTable).values({ userId: staff.id, token, expiresAt: new Date(Date.now() + 3600000) });
    const [invoice] = await db.insert(invoicesTable).values({
      clientId: client.id, submittedByRole: "staff", submittedDate: "2025-01-01",
      amountRequested: "100.00", paymentType: "direct_payment", status: "pending_review",
    } as any).returning();
    await db.insert(invoiceLineItemsTable).values([
      { invoiceId: invoice.id, authorizationId: authA.id, serviceMonth: "2025-01", amount: "20.00" },
      { invoiceId: invoice.id, authorizationId: authA.id, serviceMonth: "2025-02", amount: "30.00" },
      { invoiceId: invoice.id, authorizationId: authB.id, serviceMonth: "2025-01", amount: "50.00" },
    ]);
    const [payment] = await db.insert(paymentsTable).values({
      clientId: client.id, qbCheckNumber: `${nonce}-check`, checkDate: "2025-02-01",
      amount: "80.00", paymentType: "direct_payment", source: "manual",
    } as any).returning();
    await db.insert(paymentAllocationsTable).values([
      { paymentId: payment.id, authorizationId: authA.id, amount: "60.00" },
      { paymentId: payment.id, authorizationId: authB.id, amount: "20.00" },
    ]);
    const created = await request(app).post("/api/invoices").set("Cookie", `ceps_session=${token}`).send({
      clientId: client.id, paymentType: "direct_payment",
      documentUrl: `/objects/uploads/${staff.id}/11111111-1111-4111-8111-111111111111`,
      lineItems: [{ authorizationId: authA.id, serviceMonth: "2025-03", amount: "10.00" }],
    });
    expect(created.status).toBe(201);
    const reloaded = await request(app).get(`/api/invoices/${created.body.id}`).set("Cookie", `ceps_session=${token}`);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.lineItems).toHaveLength(1);
    expect(reloaded.body.amountRequested).toBe("10.00");
    const [invoiceTotal] = await db.select({ total: sql<string>`sum(${invoiceLineItemsTable.amount})` })
      .from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, invoice.id));
    const totals = await db.select({ authorizationId: paymentAllocationsTable.authorizationId, total: sql<string>`sum(${paymentAllocationsTable.amount})` })
      .from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, payment.id))
      .groupBy(paymentAllocationsTable.authorizationId);
    expect(invoiceTotal.total).toBe("100.00");
    expect(new Map(totals.map((row) => [row.authorizationId, row.total])).get(authA.id)).toBe("60.00");
    expect(new Map(totals.map((row) => [row.authorizationId, row.total])).get(authB.id)).toBe("20.00");
  });

  it("exposes split authorization totals and rejects claimed/child mismatches", async () => {
    const nonce = `p7-totals-${Date.now()}-${Math.random()}`;
    const [client] = await db.insert(clientsTable).values({ firstName: "Totals", lastName: "Prompt7", dateOfBirth: "2000-01-01", uciNumber: nonce }).returning();
    const [a, b] = await db.insert(authorizationsTable).values([
      { clientId: client.id, authNumber: `${nonce}-a`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2020-01-01", servicePeriodEnd: "2099-12-31", maxPeriodAmount: "50.00", status: "active" },
      { clientId: client.id, authNumber: `${nonce}-b`, serviceCode: "490", paymentType: "direct_payment", servicePeriodStart: "2020-01-01", servicePeriodEnd: "2099-12-31", maxPeriodAmount: "50.00", status: "active" },
    ] as any).returning();
    const [staff] = await db.insert(usersTable).values({ name: "Prompt7 totals", email: `${nonce}@test.local`, role: "staff" }).returning();
    await assignStaffRole(staff.id);
    const token = newToken();
    await db.insert(sessionsTable).values({ userId: staff.id, token, expiresAt: new Date(Date.now() + 3600000) });
    const [payment] = await db.insert(paymentsTable).values({ clientId: client.id, qbCheckNumber: `${nonce}-check`, checkDate: "2025-02-01", amount: "60.00", paymentType: "direct_payment", source: "manual" } as any).returning();
    await db.insert(paymentAllocationsTable).values([
      { paymentId: payment.id, authorizationId: a.id, amount: "50.00" },
      { paymentId: payment.id, authorizationId: b.id, amount: "10.00" },
    ]);
    const authResponse = await request(app).get(`/api/authorizations/${a.id}`).set("Cookie", `ceps_session=${token}`);
    expect(authResponse.status).toBe(200);
    expect(authResponse.body.totalPaid).toBe("50.00");
    expect(authResponse.body.remainingAmount).toBe("0.00");
    expect(authResponse.body.status).toBe("exhausted");
    const listResponse = await request(app).get("/api/authorizations").query({ clientId: client.id }).set("Cookie", `ceps_session=${token}`);
    expect(listResponse.status).toBe(200);
    const listedA = listResponse.body.items.find((item: { id: string }) => item.id === a.id);
    expect(listedA.totalPaid).toBe("50.00");
    expect(listedA.remainingAmount).toBe("0.00");
    expect(listedA.status).toBe("exhausted");

    const badInvoice = await request(app).post("/api/invoices").set("Cookie", `ceps_session=${token}`).send({
      clientId: client.id, amountRequested: "12.00", paymentType: "direct_payment",
      documentUrl: `/objects/uploads/${staff.id}/11111111-1111-4111-8111-111111111111`,
      lineItems: [{ authorizationId: a.id, serviceMonth: "2025-03", amount: "11.00" }],
    });
    expect(badInvoice.status).toBe(400);
    const badPayment = await request(app).post("/api/payments").set("Cookie", `ceps_session=${token}`).send({
      clientId: client.id, qbCheckNumber: `${nonce}-bad`, checkDate: "2025-03-01", amount: "12.00", paymentType: "direct_payment",
      allocations: [{ authorizationId: a.id, serviceMonth: "2025-03", amount: "11.00" }],
    });
    expect(badPayment.status).toBe(400);
  });

  it("rejects cross-participant children and validates every invoice line", async () => {
    const nonce = `p7-lines-${Date.now()}-${Math.random()}`;
    const [one, two] = await db.insert(clientsTable).values([
      { firstName: "One", lastName: "P7", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-1` },
      { firstName: "Two", lastName: "P7", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-2` },
    ]).returning();
    const [authOne, authTwo] = await db.insert(authorizationsTable).values([
      { clientId: one.id, authNumber: `${nonce}-one`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2020-01-01", servicePeriodEnd: "2099-12-31", maxPeriodAmount: "100.00", status: "active" },
      { clientId: two.id, authNumber: `${nonce}-two`, serviceCode: "490", paymentType: "direct_payment", servicePeriodStart: "2020-01-01", servicePeriodEnd: "2099-12-31", maxPeriodAmount: "100.00", status: "active" },
    ] as any).returning();
    const [staff] = await db.insert(usersTable).values({ name: "Prompt7 lines", email: `${nonce}@test.local`, role: "staff" }).returning();
    await assignStaffRole(staff.id);
    const token = newToken();
    await db.insert(sessionsTable).values({ userId: staff.id, token, expiresAt: new Date(Date.now() + 3600000) });
    const crossInvoice = await request(app).post("/api/invoices").set("Cookie", `ceps_session=${token}`).send({
      clientId: one.id, paymentType: "direct_payment", documentUrl: `/objects/uploads/${staff.id}/11111111-1111-4111-8111-111111111111`, lineItems: [{ authorizationId: authTwo.id, serviceMonth: "2025-01", amount: "10.00" }],
    });
    expect(crossInvoice.status).toBe(400);
    const crossPayment = await request(app).post("/api/payments").set("Cookie", `ceps_session=${token}`).send({
      clientId: one.id, qbCheckNumber: `${nonce}-cross`, checkDate: "2025-01-01", amount: "10.00", paymentType: "direct_payment",
      allocations: [{ authorizationId: authTwo.id, serviceMonth: "2025-01", amount: "10.00" }],
    });
    expect(crossPayment.status).toBe(400);
    const [invoice] = await db.insert(invoicesTable).values({ clientId: one.id, amountRequested: "30.00", paymentType: "direct_payment", submittedByRole: "staff", submittedDate: "2025-01-01", status: "pending_review" } as any).returning();
    await db.insert(invoiceLineItemsTable).values([
      { invoiceId: invoice.id, authorizationId: authOne.id, serviceMonth: "2025-01", amount: "10.00" },
      { invoiceId: invoice.id, authorizationId: authOne.id, serviceMonth: "2025-02", amount: "10.00" },
      { invoiceId: invoice.id, authorizationId: authOne.id, serviceMonth: "2025-03", amount: "10.00" },
    ]);
    const validation = await request(app).post(`/api/invoices/${invoice.id}/validate`).set("Cookie", `ceps_session=${token}`).send({});
    expect(validation.status).toBe(200);
    expect(validation.body.checks.some((check: { check: string; passed: boolean }) => check.check === "within_max_period_amount")).toBe(true);
  });

  it("matches a split payment by the selected authorization and rejects a wrong authorization", async () => {
    const nonce = `p7-remit-${Date.now()}-${Math.random()}`;
    const [client] = await db.insert(clientsTable).values({ firstName: "Remit", lastName: "P7", dateOfBirth: "2000-01-01", uciNumber: nonce }).returning();
    const [otherClient] = await db.insert(clientsTable).values({ firstName: "Other", lastName: "P7", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-other` }).returning();
    const [a, b] = await db.insert(authorizationsTable).values([
      { clientId: client.id, authNumber: `${nonce}-a`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2020-01-01", servicePeriodEnd: "2099-12-31", maxPeriodAmount: "100.00", status: "active" },
      { clientId: client.id, authNumber: `${nonce}-b`, serviceCode: "490", paymentType: "direct_payment", servicePeriodStart: "2020-01-01", servicePeriodEnd: "2099-12-31", maxPeriodAmount: "100.00", status: "active" },
    ] as any).returning();
    const [wrongAuth] = await db.insert(authorizationsTable).values({
      clientId: otherClient.id, authNumber: `${nonce}-wrong`, serviceCode: "459", paymentType: "direct_payment",
      servicePeriodStart: "2020-01-01", servicePeriodEnd: "2099-12-31", maxPeriodAmount: "100.00", status: "active",
    } as any).returning();
    const [staff] = await db.insert(usersTable).values({ name: "Prompt7 remittance", email: `${nonce}@test.local`, role: "staff" }).returning();
    await assignStaffRole(staff.id, ["check_writing", "invoice_log_validate", "remittance_entry"]);
    const token = newToken();
    await db.insert(sessionsTable).values({ userId: staff.id, token, expiresAt: new Date(Date.now() + 3600000) });
    const [payment] = await db.insert(paymentsTable).values({ clientId: client.id, qbCheckNumber: `${nonce}-check`, checkDate: "2025-04-01", amount: "30.00", paymentMonth: "2025-04", paymentType: "direct_payment", source: "manual" } as any).returning();
    await db.insert(paymentAllocationsTable).values([
      { paymentId: payment.id, authorizationId: a.id, amount: "20.00" },
      { paymentId: payment.id, authorizationId: b.id, amount: "10.00" },
    ]);
    const wrong = await request(app).post("/api/remittances").set("Cookie", `ceps_session=${token}`).send({
      clientId: client.id, authorizationId: wrongAuth.id, altaReference: `${nonce}-wrong`, remittanceDate: "2025-04-15", amount: "20.00", paymentMonth: "2025-04",
    });
    expect(wrong.status).toBe(400);
    const matched = await request(app).post("/api/remittances").set("Cookie", `ceps_session=${token}`).send({
      clientId: client.id, authorizationId: a.id, altaReference: `${nonce}-right`, remittanceDate: "2025-04-15", amount: "20.00", paymentMonth: "2025-04",
    });
    expect(matched.status).toBe(201);
    const [saved] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id));
    expect(saved.remitted).toBe(false);
    const second = await request(app).post("/api/remittances").set("Cookie", `ceps_session=${token}`).send({
      clientId: client.id, authorizationId: b.id, altaReference: `${nonce}-second`, remittanceDate: "2025-04-16", amount: "10.00", paymentMonth: "2025-04",
    });
    expect(second.status).toBe(201);
    const [completed] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id));
    expect(completed.remitted).toBe(true);
  });

  it("preserves one allocation for a historical/Alta imported payment", async () => {
    const nonce = `p7-import-${Date.now()}-${Math.random()}`;
    const [client] = await db.insert(clientsTable).values({ firstName: "Import", lastName: "P7", dateOfBirth: "2000-01-01", uciNumber: nonce }).returning();
    const [auth] = await db.insert(authorizationsTable).values({
      clientId: client.id, authNumber: `${nonce}-auth`, serviceCode: "459", paymentType: "direct_payment",
      servicePeriodStart: "2020-01-01", servicePeriodEnd: "2099-12-31", maxPeriodAmount: "100.00", status: "active",
    } as any).returning();
    const [payment] = await db.insert(paymentsTable).values({
      clientId: client.id, qbCheckNumber: `${nonce}-ALTA`, checkDate: "2025-05-01", amount: "25.00",
      paymentType: "direct_payment", source: "historical_import",
    } as any).returning();
    const [allocation] = await db.insert(paymentAllocationsTable).values({ paymentId: payment.id, authorizationId: auth.id, amount: "25.00" }).returning();
    expect(allocation.paymentId).toBe(payment.id);
    expect(allocation.authorizationId).toBe(auth.id);
    expect(allocation.amount).toBe("25.00");
    expect((await db.select().from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, payment.id))).length).toBe(1);
  });

  it("validates duplicate payments by every authorization-month and permits independent monthly caps", async () => {
    const nonce = `p7-months-${Date.now()}-${Math.random()}`;
    const [client] = await db.insert(clientsTable).values({ firstName: "Months", lastName: "P7", dateOfBirth: "2000-01-01", uciNumber: nonce }).returning();
    const [vendor] = await db.insert(vendorsTable).values({ name: `${nonce}-vendor` }).returning();
    const [auth] = await db.insert(authorizationsTable).values({
      clientId: client.id, vendorId: vendor.id, authNumber: `${nonce}-auth`, serviceCode: "459",
      paymentType: "direct_payment", servicePeriodStart: "2025-01-01", servicePeriodEnd: "2099-12-31",
      monthlyAmount: "50.00", maxPeriodAmount: "200.00", status: "active",
    } as any).returning();
    const [staff] = await db.insert(usersTable).values({ name: "P7 month staff", email: `${nonce}@test.local`, role: "staff" }).returning();
    await assignStaffRole(staff.id);
    const token = newToken();
    await db.insert(sessionsTable).values({ userId: staff.id, token, expiresAt: new Date(Date.now() + 3600000) });
    const [payment] = await db.insert(paymentsTable).values({
      clientId: client.id, paymentMonth: "2025-01", qbCheckNumber: `${nonce}-payment`,
      checkDate: "2025-02-15", amount: "20.00", paymentType: "direct_payment", source: "manual",
    } as any).returning();
    await db.insert(paymentAllocationsTable).values({
      paymentId: payment.id,
      authorizationId: auth.id,
      serviceMonth: "2025-02",
      amount: "20.00",
    });
    const [duplicateInvoice] = await db.insert(invoicesTable).values({
      clientId: client.id, vendorId: vendor.id, amountRequested: "40.00", paymentType: "direct_payment",
      submittedByRole: "staff", submittedDate: "2025-01-01", status: "pending_review",
    } as any).returning();
    await db.insert(invoiceLineItemsTable).values([
      { invoiceId: duplicateInvoice.id, authorizationId: auth.id, serviceMonth: "2025-01", amount: "20.00" },
      { invoiceId: duplicateInvoice.id, authorizationId: auth.id, serviceMonth: "2025-02", amount: "20.00" },
    ]);
    const duplicateResult = await request(app).post(`/api/invoices/${duplicateInvoice.id}/validate`).set("Cookie", `ceps_session=${token}`).send({});
    expect(duplicateResult.status).toBe(200);
    expect(duplicateResult.body.valid).toBe(false);
    expect(duplicateResult.body.checks.some((check: { check: string; passed: boolean; message: string }) =>
      check.check === "no_duplicate_payment" && !check.passed && check.message.includes("2025-02"))).toBe(true);

    const [validInvoice] = await db.insert(invoicesTable).values({
      clientId: client.id, vendorId: vendor.id, amountRequested: "80.00", paymentType: "direct_payment",
      submittedByRole: "staff", submittedDate: "2025-01-01", status: "pending_review",
    } as any).returning();
    await db.insert(invoiceLineItemsTable).values([
      { invoiceId: validInvoice.id, authorizationId: auth.id, serviceMonth: "2025-03", amount: "40.00" },
      { invoiceId: validInvoice.id, authorizationId: auth.id, serviceMonth: "2025-04", amount: "40.00" },
    ]);
    const validResult = await request(app).post(`/api/invoices/${validInvoice.id}/validate`).set("Cookie", `ceps_session=${token}`).send({});
    expect(validResult.status).toBe(200);
    expect(validResult.body.valid).toBe(true);
  });

  it("serializes concurrent automatic remittance matching within authorization capacity", async () => {
    const nonce = `p7-auto-race-${Date.now()}-${Math.random()}`;
    const [client] = await db.insert(clientsTable).values({ firstName: "Auto", lastName: "Race", dateOfBirth: "2000-01-01", uciNumber: nonce }).returning();
    const [auth] = await db.insert(authorizationsTable).values({
      clientId: client.id, authNumber: `${nonce}-auth`, serviceCode: "459", paymentType: "direct_payment",
      servicePeriodStart: "2025-01-01", servicePeriodEnd: "2025-12-31", monthlyAmount: "10.00",
      maxPeriodAmount: "100.00", status: "active",
    } as any).returning();
    const [staff] = await db.insert(usersTable).values({ name: "P7 auto staff", email: `${nonce}@test.local`, role: "staff" }).returning();
    await assignStaffRole(staff.id, ["check_writing", "invoice_log_validate", "remittance_entry"]);
    const token = newToken();
    await db.insert(sessionsTable).values({ userId: staff.id, token, expiresAt: new Date(Date.now() + 3600000) });
    const [payment] = await db.insert(paymentsTable).values({
      clientId: client.id, paymentMonth: "2025-06", qbCheckNumber: `${nonce}-payment`,
      checkDate: "2025-06-15", amount: "10.00", paymentType: "direct_payment", source: "manual",
    } as any).returning();
    await db.insert(paymentAllocationsTable).values({
      paymentId: payment.id,
      authorizationId: auth.id,
      serviceMonth: "2025-06",
      amount: "10.00",
    });
    const [first, second] = await db.insert(remittancesTable).values([
      { clientId: client.id, authorizationId: auth.id, altaReference: `${nonce}-1`, remittanceDate: "2025-06-20", amount: "10.00", paymentMonth: "2025-06", status: "received", source: "manual" },
      { clientId: client.id, authorizationId: auth.id, altaReference: `${nonce}-2`, remittanceDate: "2025-06-21", amount: "10.00", paymentMonth: "2025-06", status: "received", source: "manual" },
    ] as any).returning();
    const results = await Promise.all([first, second].map((row) => request(app).post("/api/remittances").set("Cookie", `ceps_session=${token}`).send({
      clientId: client.id, authorizationId: auth.id, altaReference: row.altaReference, remittanceDate: row.remittanceDate,
      amount: row.amount, paymentMonth: row.paymentMonth,
    })));
    expect(results.every((result) => result.status === 201)).toBe(true);
    const [totals] = await db.select({
      allocationTotal: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)`,
    }).from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.paymentId, payment.id));
    expect(totals.allocationTotal).toBe("10.00");
    const [savedPayment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, payment.id));
    expect(savedPayment.remitted).toBe(true);
  });
});