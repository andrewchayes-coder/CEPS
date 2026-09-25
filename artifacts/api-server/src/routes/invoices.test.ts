import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, inArray, eq } from "drizzle-orm";
import { db, usersTable, sessionsTable, clientsTable, invoicesTable, invoiceLineItemsTable, authorizationsTable, paymentsTable, paymentAllocationsTable, auditLogTable, vendorsTable, referralsTable, staffRolesTable, staffRolePermissionsTable, STAFF_PERMISSIONS } from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `inv${Date.now().toString(36)}`;

let staffId: string;
let otherStaffId: string;
let clientId: string;
let otherClientId: string;
let coordinatorId: string;
let cookie: string;
let otherCookie: string;
let coordinatorCookie: string;
const staffRoleIds: string[] = [];

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "Inv Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  const [otherStaff] = await db
    .insert(usersTable)
    .values({ name: "Other Inv Staff", email: `${nonce}-other-staff@test.local`, role: "staff" })
    .returning();
  otherStaffId = otherStaff.id;
  for (const [userId, suffix] of [[staffId, "staff"], [otherStaffId, "other-staff"]] as const) {
    const [staffRole] = await db.insert(staffRolesTable).values({ name: `${nonce} ${suffix}` }).returning();
    staffRoleIds.push(staffRole.id);
    await db.insert(staffRolePermissionsTable).values(STAFF_PERMISSIONS.map((permission) => ({ roleId: staffRole.id, permission })));
    await db.update(usersTable).set({ staffRoleId: staffRole.id }).where(eq(usersTable.id, userId));
  }

  const [client] = await db
    .insert(clientsTable)
    .values({ firstName: "Inv", lastName: "Client", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uci` })
    .returning();
  clientId = client.id;
  const [otherClient] = await db
    .insert(clientsTable)
    .values({ firstName: "Other", lastName: "Participant", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-other-uci` })
    .returning();
  otherClientId = otherClient.id;
  const [coordinator] = await db.insert(usersTable)
    .values({ name: "Inv Coordinator", email: `${nonce}-coordinator@test.local`, role: "service_coordinator" })
    .returning();
  coordinatorId = coordinator.id;
  await db.update(clientsTable).set({ assignedCoordinatorId: coordinatorId }).where(eq(clientsTable.id, clientId));

  const token = newToken();
  await db.insert(sessionsTable).values({
    userId: staffId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  cookie = `ceps_session=${token}`;
  otherCookie = `ceps_session=${await newToken()}`;
  const otherToken = otherCookie.slice("ceps_session=".length);
  await db.insert(sessionsTable).values({
    userId: otherStaffId,
    token: otherToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const coordinatorToken = newToken();
  coordinatorCookie = `ceps_session=${coordinatorToken}`;
  await db.insert(sessionsTable).values({
    userId: coordinatorId,
    token: coordinatorToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
});

const vendorIds: string[] = [];

afterAll(async () => {
  await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, [clientId, otherClientId]));
  await db.delete(invoicesTable).where(inArray(invoicesTable.clientId, [clientId, otherClientId]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientId, otherClientId]));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [staffId, otherStaffId, coordinatorId]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, otherStaffId, coordinatorId]));
  if (vendorIds.length) await db.delete(vendorsTable).where(inArray(vendorsTable.id, vendorIds));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(clientsTable).where(eq(clientsTable.id, otherClientId));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, otherStaffId, coordinatorId]));
  if (staffRoleIds.length) await db.delete(staffRolesTable).where(inArray(staffRolesTable.id, staffRoleIds));
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
  await db.insert(invoiceLineItemsTable).values({ invoiceId: inv.id, authorizationId: authId, serviceMonth, amount: amountRequested });
  return inv;
}

let authCounter = 0;

async function makeInvoice(status: string) {
  const auth = await makeAuth({ maxPeriodAmount: "10000.00" });
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
  await db.insert(invoiceLineItemsTable).values({ invoiceId: inv.id, authorizationId: auth.id, serviceMonth: "2026-01", amount: "100.00" });
  return { ...inv, testAuthorizationId: auth.id };
}

async function makeAuth(opts: { monthlyAmount?: string | null; oneTimeAmount?: string | null; maxPeriodAmount: string; vendorId?: string | null }) {
  const [auth] = await db
    .insert(authorizationsTable)
    .values({
      clientId,
      vendorId: opts.vendorId ?? null,
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
  await db.insert(invoiceLineItemsTable).values({ invoiceId: inv.id, authorizationId: authId, serviceMonth, amount: amountRequested });
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
      .send({ amountRequested: "200.00", lineItems: [{ authorizationId: inv.testAuthorizationId, serviceMonth: "2026-01", amount: "200.00" }] });
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

  it("rejects approval status in the generic edit endpoint", async () => {
    const inv = await makeInvoice("validated");
    const res = await request(app)
      .patch(`/api/invoices/${inv.id}`)
      .set("Cookie", cookie)
      .send({ amountRequested: "300.00", status: "approved", lineItems: [{ authorizationId: inv.testAuthorizationId, serviceMonth: "2026-01", amount: "300.00" }] });
    expect(res.status).toBe(400);
  });
});

describe("service coordinator invoice submission and CEPS entry", () => {
  it("accepts caseload submissions without line items and creates one needs_entry invoice per document", async () => {
    const vendor = await makeVendor(true);
    await makeAuth({ maxPeriodAmount: "1000.00", vendorId: vendor.id });
    const submit = (fileId: string) => request(app).post("/api/invoices")
      .set("Cookie", coordinatorCookie)
      .send({
        clientId,
        vendorId: vendor.id,
        notes: "Please process these invoices",
        documentUrl: `/objects/uploads/${coordinatorId}/${fileId}`,
      });
    const dashboard = await request(app).get("/api/dashboard/summary").set("Cookie", coordinatorCookie);
    const first = await submit("11111111-1111-4111-8111-111111111111");
    const second = await submit("22222222-2222-4222-8222-222222222222");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    for (const response of [first, second]) {
      expect(response.body.status).toBe("needs_entry");
      expect(response.body.submittedByRole).toBe("service_coordinator");
      expect(response.body.amountRequested).toBe("0.00");
      expect(response.body.lineItems).toEqual([]);
      expect(response.body.vendorId).toBe(vendor.id);
    }
    expect(dashboard.status).toBe(200);
    const refreshedDashboard = await request(app).get("/api/dashboard/summary").set("Cookie", coordinatorCookie);
    expect(refreshedDashboard.body.totals.needsEntryInvoices)
      .toBe(dashboard.body.totals.needsEntryInvoices + 2);

    const outsideCaseload = await request(app).post("/api/invoices")
      .set("Cookie", coordinatorCookie)
      .send({
        clientId: otherClientId,
        documentUrl: `/objects/uploads/${coordinatorId}/33333333-3333-4333-8333-333333333333`,
      });
    expect(outsideCaseload.status).toBe(403);

    const unrelatedVendor = await makeVendor(true);
    const vendorNotLinkedToParticipant = await request(app).post("/api/invoices")
      .set("Cookie", coordinatorCookie)
      .send({
        clientId,
        vendorId: unrelatedVendor.id,
        documentUrl: `/objects/uploads/${coordinatorId}/44444444-4444-4444-8444-444444444444`,
      });
    expect(vendorNotLinkedToParticipant.status).toBe(400);
    expect(vendorNotLinkedToParticipant.body.error).toContain("associated with clientId");

    const documentNotOwned = await request(app).post("/api/invoices")
      .set("Cookie", coordinatorCookie)
      .send({
        clientId,
        documentUrl: `/objects/uploads/${staffId}/77777777-7777-4777-8777-777777777777`,
      });
    expect(documentNotOwned.status).toBe(403);

    const approvedOnly = await request(app).get("/api/invoices?status=approved").set("Cookie", cookie);
    expect(approvedOnly.status).toBe(200);
    expect(approvedOnly.body.items.map((invoice: { id: string }) => invoice.id))
      .not.toContain(first.body.id);
    const checkWritingQueue = await request(app).get("/api/invoices/queues/ready-for-check-writing").set("Cookie", cookie);
    expect(checkWritingQueue.status).toBe(200);
    expect(checkWritingQueue.body.items.map((invoice: { id: string }) => invoice.id))
      .not.toContain(first.body.id);
  });

  it("requires staff line items, allows staff to complete entry, and blocks validation before entry", async () => {
    const staffWithoutLines = await request(app).post("/api/invoices").set("Cookie", cookie).send({
      clientId,
      documentUrl: `/objects/uploads/${staffId}/55555555-5555-4555-8555-555555555555`,
    });
    expect(staffWithoutLines.status).toBe(400);
    expect(staffWithoutLines.body.error).toContain("line item");

    const auth = await makeAuth({ maxPeriodAmount: "1000.00" });
    const awaitingEntry = await request(app).post("/api/invoices").set("Cookie", coordinatorCookie).send({
      clientId,
      documentUrl: `/objects/uploads/${coordinatorId}/66666666-6666-4666-8666-666666666666`,
    });
    expect(awaitingEntry.status).toBe(201);

    const validation = await request(app).post(`/api/invoices/${awaitingEntry.body.id}/validate`).set("Cookie", cookie).send({});
    expect(validation.status).toBe(400);

    const incomplete = await request(app).patch(`/api/invoices/${awaitingEntry.body.id}`).set("Cookie", cookie)
      .send({ status: "pending_review" });
    expect(incomplete.status).toBe(400);

    const completed = await request(app).patch(`/api/invoices/${awaitingEntry.body.id}`).set("Cookie", cookie).send({
      lineItems: [{ authorizationId: auth.id, serviceMonth: "2026-02", amount: "25.00" }],
    });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("pending_review");
    expect(completed.body.amountRequested).toBe("25.00");
    expect(completed.body.lineItems).toHaveLength(1);
  });

  it("returns the original invoice for a retry and rejects retries with changed details", async () => {
    const documentUrl = `/objects/uploads/${coordinatorId}/88888888-8888-4888-8888-888888888888`;
    const payload = { clientId, notes: "Original notes", documentUrl };
    const first = await request(app).post("/api/invoices").set("Cookie", coordinatorCookie).send(payload);
    const retry = await request(app).post("/api/invoices").set("Cookie", coordinatorCookie).send(payload);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);

    const changedNotes = await request(app).post("/api/invoices").set("Cookie", coordinatorCookie)
      .send({ ...payload, notes: "Different notes" });
    expect(changedNotes.status).toBe(409);
    const changedVendor = await request(app).post("/api/invoices").set("Cookie", coordinatorCookie)
      .send({ ...payload, vendorId: "00000000-0000-4000-8000-000000000001" });
    expect(changedVendor.status).toBe(409);

    const audits = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.userId, coordinatorId),
      eq(auditLogTable.action, "create_invoice"),
      eq(auditLogTable.entityId, first.body.id),
    ));
    expect(audits).toHaveLength(1);
  });

  it("serializes concurrent submissions for the same document path", async () => {
    const payload = {
      clientId,
      notes: "Concurrent retry",
      documentUrl: `/objects/uploads/${coordinatorId}/99999999-9999-4999-8999-999999999999`,
    };
    const [left, right] = await Promise.all([
      request(app).post("/api/invoices").set("Cookie", coordinatorCookie).send(payload),
      request(app).post("/api/invoices").set("Cookie", coordinatorCookie).send(payload),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 201]);
    expect(left.body.id).toBe(right.body.id);
    const matchingInvoices = await db.select().from(invoicesTable).where(and(
      eq(invoicesTable.documentUrl, payload.documentUrl),
      eq(invoicesTable.submittedByRole, "service_coordinator"),
    ));
    expect(matchingInvoices).toHaveLength(1);
  });

  it("rejects reuse of a coordinator document for a different participant", async () => {
    const documentUrl = `/objects/uploads/${coordinatorId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    await db.update(clientsTable).set({ assignedCoordinatorId: coordinatorId }).where(eq(clientsTable.id, otherClientId));
    try {
      const first = await request(app).post("/api/invoices").set("Cookie", coordinatorCookie)
        .send({ clientId, documentUrl });
      expect(first.status).toBe(201);
      const otherParticipant = await request(app).post("/api/invoices").set("Cookie", coordinatorCookie)
        .send({ clientId: otherClientId, documentUrl });
      expect(otherParticipant.status).toBe(409);
    } finally {
      await db.update(clientsTable).set({ assignedCoordinatorId: null }).where(eq(clientsTable.id, otherClientId));
    }
  });

  it("keeps referral-only vendors in the default list but excludes them for invoice eligibility", async () => {
    const vendor = await makeVendor(true);
    const [referral] = await db.insert(referralsTable).values({
      clientId,
      vendorId: vendor.id,
      referralDate: "2026-03-01",
    }).returning();
    try {
      const defaultVendors = await request(app).get("/api/vendors").query({ clientId }).set("Cookie", coordinatorCookie);
      expect(defaultVendors.status).toBe(200);
      expect(defaultVendors.body.items.map((item: { id: string }) => item.id)).toContain(vendor.id);

      const invoiceVendors = await request(app).get("/api/vendors")
        .query({ clientId, invoiceEligible: "true" })
        .set("Cookie", coordinatorCookie);
      expect(invoiceVendors.status).toBe(200);
      expect(invoiceVendors.body.items.map((item: { id: string }) => item.id)).not.toContain(vendor.id);

      const submission = await request(app).post("/api/invoices").set("Cookie", coordinatorCookie).send({
        clientId,
        vendorId: vendor.id,
        documentUrl: `/objects/uploads/${coordinatorId}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
      });
      expect(submission.status).toBe(400);
      expect(submission.body.error).toContain("associated with clientId");
    } finally {
      await db.delete(referralsTable).where(eq(referralsTable.id, referral.id));
    }
  });
});

describe("invoice line-item document attachments", () => {
  it("requires an invoice document for staff and coordinators, but not a linked parent", async () => {
    const auth = await makeAuth({ maxPeriodAmount: "1000.00" });
    const body = { clientId, paymentType: "direct_payment", lineItems: [{ authorizationId: auth.id, serviceMonth: "2026-07", amount: "10.00" }] };
    for (const documentUrl of [undefined, "", "   "]) {
      const response = await request(app).post("/api/invoices").set("Cookie", cookie).send({ ...body, documentUrl });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("An invoice document is required");
    }

    const [coordinator, parent] = await db.insert(usersTable).values([
      { name: "Inv Coordinator", email: `${nonce}-document-coordinator@test.local`, role: "service_coordinator" },
      { name: "Inv Parent", email: `${nonce}-parent@test.local`, role: "parent_guardian", linkedRecordType: "client", linkedRecordId: clientId },
    ]).returning();
    let parentInvoiceId: string | undefined;
    const coordinatorToken = newToken();
    const parentToken = newToken();
    try {
      await db.update(clientsTable).set({ assignedCoordinatorId: coordinator.id }).where(eq(clientsTable.id, clientId));
      await db.insert(sessionsTable).values([
        { userId: coordinator.id, token: coordinatorToken, expiresAt: new Date(Date.now() + 3600000) },
        { userId: parent.id, token: parentToken, expiresAt: new Date(Date.now() + 3600000) },
      ]);
      const restricted = await request(app).post("/api/invoices").set("Cookie", `ceps_session=${coordinatorToken}`).send({
        clientId,
        paymentType: "direct_payment",
      });
      expect(restricted.status).toBe(400);
      expect(restricted.body.error).toBe("An invoice document is required");
      const allowed = await request(app).post("/api/invoices").set("Cookie", `ceps_session=${parentToken}`).send(body);
      expect(allowed.status).toBe(201);
      parentInvoiceId = allowed.body.id;
    } finally {
      if (parentInvoiceId) await db.delete(invoicesTable).where(eq(invoicesTable.id, parentInvoiceId));
      await db.update(clientsTable).set({ assignedCoordinatorId: coordinatorId }).where(eq(clientsTable.id, clientId));
      await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [coordinator.id, parent.id]));
      await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [coordinator.id, parent.id]));
      await db.delete(usersTable).where(inArray(usersTable.id, [coordinator.id, parent.id]));
    }
  });

  it("requires canonical owner-bound upload paths before creating an invoice", async () => {
    const auth = await makeAuth({ maxPeriodAmount: "1000.00" });
    const base = {
      clientId,
      paymentType: "direct_payment",
      lineItems: [{ authorizationId: auth.id, serviceMonth: "2026-06", amount: "10.00" }],
    };
    const crossUser = await request(app).post("/api/invoices").set("Cookie", otherCookie).send({
      ...base,
      documentUrl: `/objects/uploads/${staffId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    });
    expect(crossUser.status).toBe(403);
    const malformed = await request(app).post("/api/invoices").set("Cookie", otherCookie).send({
      ...base,
      documentUrl: `/objects/uploads/${otherStaffId}/dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
      lineItems: [{ ...base.lineItems[0], documentUrl: "https://attacker.example/file.pdf" }],
    });
    expect(malformed.status).toBe(403);
    const own = await request(app).post("/api/invoices").set("Cookie", otherCookie).send({
      ...base,
      documentUrl: `/objects/uploads/${otherStaffId}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
      lineItems: [{ ...base.lineItems[0], documentUrl: `/objects/uploads/${otherStaffId}/cccccccc-cccc-4ccc-8ccc-cccccccccccc` }],
    });
    expect(own.status).toBe(201);
    expect(own.body.documentUrl).toContain(`/objects/uploads/${otherStaffId}/`);
  });

  it("persists independent documents per line and reloads them by authorization", async () => {
    const first = await makeAuth({ maxPeriodAmount: "1000.00" });
    const second = await makeAuth({ maxPeriodAmount: "1000.00" });
    const response = await request(app).post("/api/invoices").set("Cookie", cookie).send({
      clientId,
      paymentType: "direct_payment",
      documentUrl: `/objects/uploads/${staffId}/11111111-1111-4111-8111-111111111111`,
      amountRequested: "150.00",
      lineItems: [
        { authorizationId: first.id, serviceMonth: "2026-03", amount: "100.00", documentUrl: `  /objects/uploads/${staffId}/22222222-2222-4222-8222-222222222222  ` },
        { authorizationId: second.id, serviceMonth: "2026-03", amount: "50.00", documentUrl: `/objects/uploads/${staffId}/33333333-3333-4333-8333-333333333333` },
      ],
    });
    expect(response.status).toBe(201);
    expect(response.body.documentUrl).toBe(`/objects/uploads/${staffId}/11111111-1111-4111-8111-111111111111`);
    expect(response.body.lineItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorizationId: first.id, documentUrl: `/objects/uploads/${staffId}/22222222-2222-4222-8222-222222222222` }),
      expect.objectContaining({ authorizationId: second.id, documentUrl: `/objects/uploads/${staffId}/33333333-3333-4333-8333-333333333333` }),
    ]));

    const reloaded = await request(app).get(`/api/invoices/${response.body.id}`).set("Cookie", cookie);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.lineItems.find((item: { authorizationId: string }) => item.authorizationId === first.id).documentUrl)
       .toBe(`/objects/uploads/${staffId}/22222222-2222-4222-8222-222222222222`);
    expect(reloaded.body.lineItems.find((item: { authorizationId: string }) => item.authorizationId === second.id).documentUrl)
       .toBe(`/objects/uploads/${staffId}/33333333-3333-4333-8333-333333333333`);
  });

  it("keeps invoice-level-only attachments and normalizes empty line documents", async () => {
    const first = await makeAuth({ maxPeriodAmount: "1000.00" });
    const response = await request(app).post("/api/invoices").set("Cookie", cookie).send({
      clientId,
      paymentType: "direct_payment",
      documentUrl: `/objects/uploads/${staffId}/44444444-4444-4444-8444-444444444444`,
      lineItems: [{ authorizationId: first.id, serviceMonth: "2026-04", amount: "25.00", documentUrl: "" }],
    });
    expect(response.status).toBe(201);
    expect(response.body.documentUrl).toBe(`/objects/uploads/${staffId}/44444444-4444-4444-8444-444444444444`);
    expect(response.body.lineItems[0].documentUrl).toBeNull();
  });

  it("keeps an existing line document when omitted on edit and allows explicit replacement", async () => {
    const first = await makeAuth({ maxPeriodAmount: "1000.00" });
    const second = await makeAuth({ maxPeriodAmount: "1000.00" });
    const created = await request(app).post("/api/invoices").set("Cookie", cookie).send({
      clientId,
      paymentType: "direct_payment",
      documentUrl: `/objects/uploads/${staffId}/55555555-5555-4555-8555-555555555555`,
      lineItems: [
        { authorizationId: first.id, serviceMonth: "2026-05", amount: "10.00", documentUrl: `/objects/uploads/${staffId}/66666666-6666-4666-8666-666666666666` },
        { authorizationId: second.id, serviceMonth: "2026-05", amount: "20.00", documentUrl: `/objects/uploads/${staffId}/77777777-7777-4777-8777-777777777777` },
      ],
    });
    const patched = await request(app).patch(`/api/invoices/${created.body.id}`).set("Cookie", cookie).send({
      amountRequested: "30.00",
      lineItems: [
        { authorizationId: first.id, serviceMonth: "2026-05", amount: "10.00", documentUrl: `/objects/uploads/${staffId}/88888888-8888-4888-8888-888888888888` },
        { id: created.body.lineItems.find((item: { authorizationId: string }) => item.authorizationId === second.id).id, authorizationId: second.id, serviceMonth: "2026-06", amount: "20.00" },
      ],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.documentUrl).toBe(`/objects/uploads/${staffId}/55555555-5555-4555-8555-555555555555`);
    expect(patched.body.lineItems.find((item: { authorizationId: string }) => item.authorizationId === first.id).documentUrl)
       .toBe(`/objects/uploads/${staffId}/88888888-8888-4888-8888-888888888888`);
    expect(patched.body.lineItems.find((item: { authorizationId: string }) => item.authorizationId === second.id).documentUrl)
      .toBe(`/objects/uploads/${staffId}/77777777-7777-4777-8777-777777777777`);
    expect(patched.body.lineItems.find((item: { authorizationId: string }) => item.authorizationId === second.id).serviceMonth)
      .toBe("2026-06");
  });
});

describe("PATCH /invoices/:id participant links", () => {
  it("accepts an authorization belonging to the invoice participant", async () => {
    const auth = await makeAuth({ maxPeriodAmount: "1000.00" });
    const inv = await makeInvoice("validated");
    const res = await request(app).patch(`/api/invoices/${inv.id}`).set("Cookie", cookie).send({ authorizationId: auth.id });
    expect(res.status).toBe(200);
    expect(res.body.authorizationId).toBe(auth.id);
    expect(res.body.status).toBe("pending_review");
  });

  it("rejects a deleted authorization without changing invoice status", async () => {
    const auth = await makeAuth({ maxPeriodAmount: "1000.00" });
    await db.update(authorizationsTable).set({ isDeleted: true }).where(eq(authorizationsTable.id, auth.id));
    const inv = await makeInvoice("validated");
    const res = await request(app).patch(`/api/invoices/${inv.id}`).set("Cookie", cookie).send({ authorizationId: auth.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("non-deleted authorization");
    const [unchanged] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, inv.id));
    expect(unchanged.authorizationId).toBeNull();
    expect(unchanged.status).toBe("validated");
  });

  it("rejects an authorization belonging to another participant", async () => {
    const [auth] = await db.insert(authorizationsTable).values({
      clientId: otherClientId,
      authNumber: `${nonce}-other-auth`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2099-12-31",
      maxPeriodAmount: "1000.00",
      status: "active",
    }).returning();
    const inv = await makeInvoice("validated");
    const res = await request(app).patch(`/api/invoices/${inv.id}`).set("Cookie", cookie).send({ authorizationId: auth.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("belong to clientId");
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
      const [payment] = await db.insert(paymentsTable).values({
        clientId,
        authorizationId: auth.id,
        qbCheckNumber: `${nonce}-inv-pay-${authCounter}-${i}`,
        checkDate: "2026-01-15",
        amount: "0.10",
        paymentType: "direct_payment",
        source: "manual",
        loggedBy: staffId,
      }).returning();
      await db.insert(paymentAllocationsTable).values({ paymentId: payment.id, authorizationId: auth.id, amount: "0.10" });
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
      const [payment] = await db.insert(paymentsTable).values({
        clientId,
        authorizationId: auth.id,
        qbCheckNumber: `${nonce}-inv-pay2-${authCounter}-${i}`,
        checkDate: "2026-01-15",
        amount: "0.10",
        paymentType: "direct_payment",
        source: "manual",
        loggedBy: staffId,
      }).returning();
      await db.insert(paymentAllocationsTable).values({ paymentId: payment.id, authorizationId: auth.id, amount: "0.10" });
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
    const vendor = await makeVendor(true);
    const auth = await makeAuth({ oneTimeAmount: "100.00", maxPeriodAmount: "1000000.00", vendorId: vendor.id });
    const inv = await makeInvoiceForVendor(auth.id, vendor.id);
    const res = await request(app).post(`/api/invoices/${inv.id}/validate`).set("Cookie", cookie).send({});
    expect(res.status).toBe(200);
    expect(checkOf(res.body, "vendor_active").passed).toBe(true);
  });

  it("fails vendor_active when the invoice's vendor is deactivated", async () => {
    const vendor = await makeVendor(false);
    const auth = await makeAuth({ oneTimeAmount: "100.00", maxPeriodAmount: "1000000.00", vendorId: vendor.id });
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
