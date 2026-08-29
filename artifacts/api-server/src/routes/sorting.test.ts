import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  authorizationsTable,
  clientsTable,
  db,
  invoicesTable,
  paymentsTable,
  referralsTable,
  remittancesTable,
  sessionsTable,
  usersTable,
  vendorsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `sort${Date.now().toString(36)}`;
const soonestEnd = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const latestEnd = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
let userId: string;
let cookie: string;
const clientIds: string[] = [];
const vendorIds: string[] = [];
const referralIds: string[] = [];
const authorizationIds: string[] = [];
const invoiceIds: string[] = [];
const paymentIds: string[] = [];
const remittanceIds: string[] = [];

beforeAll(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({ name: `${nonce} Sort User`, email: `${nonce}@test.local`, role: "staff" })
    .returning();
  userId = user.id;
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  cookie = `ceps_session=${token}`;

  const inserted = await db
    .insert(clientsTable)
    .values([
      { firstName: "Same", lastName: nonce, dateOfBirth: "2001-01-01", uciNumber: `${nonce}-003`, assignedCoordinatorId: userId },
      { firstName: "Same", lastName: nonce, dateOfBirth: "2002-01-01", uciNumber: `${nonce}-001` },
      { firstName: "Same", lastName: nonce, dateOfBirth: "2003-01-01", uciNumber: `${nonce}-002` },
    ])
    .returning();
  clientIds.push(...inserted.map((row) => row.id));

  const vendors = await db.insert(vendorsTable).values([
    { name: `${nonce} Vendor A`, w9Status: "pending" },
    { name: `${nonce} Vendor Z`, w9Status: "pending" },
  ]).returning();
  vendorIds.push(...vendors.map((row) => row.id));
  const referrals = await db.insert(referralsTable).values([
    { clientId: inserted[0].id, serviceCoordinatorId: userId, referralDate: "2026-02-01", status: "pending_auth", intakeFields: { serviceType: "direct_pay_459" } },
    { clientId: inserted[1].id, serviceCoordinatorId: userId, referralDate: "2026-01-01", status: "pending_auth", intakeFields: { serviceType: "reimbursement_024" } },
  ]).returning();
  referralIds.push(...referrals.map((row) => row.id));
  const auths = await db.insert(authorizationsTable).values([
    { clientId: inserted[0].id, vendorId: vendors[0].id, authNumber: `${nonce}-AUTH-A`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: latestEnd, maxPeriodAmount: "200.00", status: "active" },
    { clientId: inserted[1].id, vendorId: vendors[1].id, authNumber: `${nonce}-AUTH-Z`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: soonestEnd, maxPeriodAmount: "100.00", status: "active" },
  ]).returning();
  authorizationIds.push(...auths.map((row) => row.id));
  const invoices = await db.insert(invoicesTable).values([
    { clientId: inserted[0].id, vendorId: vendors[0].id, authorizationId: auths[0].id, submittedByRole: "staff", submittedDate: "2026-02-01", serviceMonth: "2026-02", amountRequested: "20.00", paymentType: "direct_payment", status: "pending_review" },
    { clientId: inserted[1].id, vendorId: vendors[1].id, authorizationId: auths[1].id, submittedByRole: "staff", submittedDate: "2026-01-01", serviceMonth: "2026-01", amountRequested: "10.00", paymentType: "direct_payment", status: "approved" },
  ]).returning();
  invoiceIds.push(...invoices.map((row) => row.id));
  const payments = await db.insert(paymentsTable).values([
    { clientId: inserted[0].id, vendorId: vendors[0].id, authorizationId: auths[0].id, invoiceId: invoices[0].id, qbCheckNumber: `${nonce}-CHECK-A`, checkDate: "2026-02-01", amount: "20.00", paymentType: "direct_payment", source: "manual", loggedBy: userId },
    { clientId: inserted[1].id, vendorId: vendors[1].id, authorizationId: auths[1].id, invoiceId: invoices[1].id, qbCheckNumber: `${nonce}-CHECK-Z`, checkDate: "2026-01-01", amount: "10.00", paymentType: "direct_payment", source: "manual", loggedBy: userId },
  ]).returning();
  paymentIds.push(...payments.map((row) => row.id));
  const remittances = await db.insert(remittancesTable).values([
    { clientId: inserted[0].id, authorizationId: auths[0].id, altaReference: `${nonce}-REM-A`, remittanceDate: "2026-02-01", amount: "20.00", status: "received" },
    { clientId: inserted[1].id, authorizationId: auths[1].id, altaReference: `${nonce}-REM-Z`, remittanceDate: "2026-01-01", amount: "10.00", status: "pending" },
  ]).returning();
  remittanceIds.push(...remittances.map((row) => row.id));
  await db.insert(auditLogTable).values([
    { userId, action: `${nonce}-ACTION-A`, entityType: "sort", createdAt: new Date("2026-01-01T00:00:00Z") },
    { userId, action: `${nonce}-ACTION-Z`, entityType: "sort", createdAt: new Date("2026-02-01T00:00:00Z") },
  ]);
});

afterAll(async () => {
  await db.delete(remittancesTable).where(inArray(remittancesTable.id, remittanceIds));
  await db.delete(paymentsTable).where(inArray(paymentsTable.id, paymentIds));
  await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.id, authorizationIds));
  await db.delete(referralsTable).where(inArray(referralsTable.id, referralIds));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, vendorIds));
  await db.delete(clientsTable).where(inArray(clientsTable.id, clientIds));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, userId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, userId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

describe("paginated API sorting", () => {
  it("sorts an allowlisted field ascending and descending", async () => {
    const asc = await request(app)
      .get("/api/clients")
      .query({ search: nonce, sortBy: "uciNumber", sortDirection: "asc", limit: 10 })
      .set("Cookie", cookie);
    const desc = await request(app)
      .get("/api/clients")
      .query({ search: nonce, sortBy: "uciNumber", sortDirection: "desc", limit: 10 })
      .set("Cookie", cookie);
    expect(asc.status).toBe(200);
    expect(desc.status).toBe(200);
    expect(asc.body.items.map((row: { uciNumber: string }) => row.uciNumber)).toEqual([
      `${nonce}-001`,
      `${nonce}-002`,
      `${nonce}-003`,
    ]);
    expect(desc.body.items.map((row: { uciNumber: string }) => row.uciNumber)).toEqual([
      `${nonce}-003`,
      `${nonce}-002`,
      `${nonce}-001`,
    ]);
  });

  it("uses a unique tie-breaker for stable pagination", async () => {
    const query = { search: nonce, sortBy: "name", sortDirection: "asc", limit: 2 };
    const first = await request(app).get("/api/clients").query({ ...query, offset: 0 }).set("Cookie", cookie);
    const second = await request(app).get("/api/clients").query({ ...query, offset: 2 }).set("Cookie", cookie);
    const repeated = await request(app).get("/api/clients").query({ ...query, offset: 0 }).set("Cookie", cookie);
    expect(first.body.total).toBe(3);
    expect(second.body.total).toBe(3);
    expect(repeated.body.items.map((row: { id: string }) => row.id)).toEqual(
      first.body.items.map((row: { id: string }) => row.id),
    );
    expect(first.body.items.map((row: { id: string }) => row.id)).not.toContain(second.body.items[0].id);
  });

  it("preserves the existing default ordering when sort parameters are omitted", async () => {
    const response = await request(app)
      .get("/api/clients")
      .query({ search: nonce, limit: 10 })
      .set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(3);
    expect(response.body.items.map((row: { id: string }) => row.id)).toEqual(
      [...clientIds].sort((a, b) => b.localeCompare(a)),
    );
  });

  it("keeps null display values last in both directions", async () => {
    for (const sortDirection of ["asc", "desc"]) {
      const response = await request(app)
        .get("/api/clients")
        .query({ search: nonce, sortBy: "assignedCoordinatorName", sortDirection, limit: 10 })
        .set("Cookie", cookie);
      expect(response.status).toBe(200);
      expect(response.body.items[0].assignedCoordinatorName).toBe(`${nonce} Sort User`);
      expect(response.body.items.slice(1).every((row: { assignedCoordinatorName: null }) => row.assignedCoordinatorName === null)).toBe(true);
    }
  });

  const paginatedPaths = [
    "/api/clients",
    "/api/referrals",
    "/api/authorizations",
    "/api/invoices",
    "/api/payments",
    "/api/remittances",
    "/api/vendors",
    "/api/audit-log",
    "/api/reports/pending-authorizations",
    "/api/reports/case-status",
    "/api/reports/missing-documents",
    "/api/reports/expiring-authorizations",
  ];

  for (const path of paginatedPaths) {
    it(`rejects invalid sort values on ${path}`, async () => {
      const invalidField = await request(app)
        .get(path)
        .query({ sortBy: "notAllowed" })
        .set("Cookie", cookie);
      const invalidDirection = await request(app)
        .get(path)
        .query({ sortDirection: "sideways" })
        .set("Cookie", cookie);
      expect(invalidField.status).toBe(400);
      expect(invalidDirection.status).toBe(400);
    });
  }

  it("sorts representative fields asc/desc across every other paginated endpoint", async () => {
    const cases: Array<{
      path: string;
      sortBy: string;
      field: string;
      query?: Record<string, string | number>;
      rows: (body: Record<string, any>) => Record<string, any>[];
      mine: (row: Record<string, any>) => boolean;
    }> = [
      { path: "/api/referrals", sortBy: "referralDate", field: "referralDate", query: { search: nonce }, rows: (b) => b.items, mine: (r) => referralIds.includes(r.id) },
      { path: "/api/authorizations", sortBy: "authNumber", field: "authNumber", query: { search: nonce }, rows: (b) => b.items, mine: (r) => authorizationIds.includes(r.id) },
      { path: "/api/invoices", sortBy: "amountRequested", field: "amountRequested", query: { search: nonce }, rows: (b) => b.items, mine: (r) => invoiceIds.includes(r.id) },
      { path: "/api/payments", sortBy: "amount", field: "amount", query: { search: nonce }, rows: (b) => b.items, mine: (r) => paymentIds.includes(r.id) },
      { path: "/api/remittances", sortBy: "altaReference", field: "altaReference", query: { search: nonce }, rows: (b) => b.items, mine: (r) => remittanceIds.includes(r.id) },
      { path: "/api/vendors", sortBy: "name", field: "name", query: { search: nonce }, rows: (b) => b.items, mine: (r) => vendorIds.includes(r.id) },
      { path: "/api/audit-log", sortBy: "action", field: "action", query: { action: nonce }, rows: (b) => b.entries, mine: (r) => r.action.startsWith(nonce) },
      { path: "/api/reports/pending-authorizations", sortBy: "referralDate", field: "referralDate", query: { search: nonce }, rows: (b) => b.items, mine: (r) => referralIds.includes(r.referralId) },
      { path: "/api/reports/case-status", sortBy: "referralDate", field: "referralDate", query: { search: nonce }, rows: (b) => b.items, mine: (r) => referralIds.includes(r.referralId) },
      { path: "/api/reports/missing-documents", sortBy: "entityName", field: "entityName", query: { docType: "w9" }, rows: (b) => b.items, mine: (r) => vendorIds.includes(r.entityId) },
      { path: "/api/reports/expiring-authorizations", sortBy: "servicePeriodEnd", field: "servicePeriodEnd", query: { withinDays: 30 }, rows: (b) => b.items, mine: (r) => authorizationIds.includes(r.authorizationId) },
    ];
    for (const testCase of cases) {
      const fetch = (sortDirection: "asc" | "desc") =>
        request(app).get(testCase.path).query({ ...testCase.query, sortBy: testCase.sortBy, sortDirection, limit: 1000 }).set("Cookie", cookie);
      const [ascending, descending] = await Promise.all([fetch("asc"), fetch("desc")]);
      expect(ascending.status, `${testCase.path} asc`).toBe(200);
      expect(descending.status, `${testCase.path} desc`).toBe(200);
      const ascValues = testCase.rows(ascending.body).filter(testCase.mine).map((row) => String(row[testCase.field]));
      const descValues = testCase.rows(descending.body).filter(testCase.mine).map((row) => String(row[testCase.field]));
      expect(ascValues, `${testCase.path} asc values`).toEqual([...ascValues].sort());
      expect(descValues, `${testCase.path} desc values`).toEqual([...ascValues].reverse());
      expect(ascValues).toHaveLength(2);
    }
  });

  it("uses the missing-documents default and tie-breaker consistently across pages", async () => {
    const base = { limit: 1 };
    const first = await request(app).get("/api/reports/missing-documents").query({ ...base, offset: 0 }).set("Cookie", cookie);
    const repeated = await request(app).get("/api/reports/missing-documents").query({ ...base, offset: 0 }).set("Cookie", cookie);
    const second = await request(app).get("/api/reports/missing-documents").query({ ...base, offset: 1 }).set("Cookie", cookie);
    expect(first.status).toBe(200);
    expect(first.body.items).toEqual(repeated.body.items);
    expect(first.body.total).toBe(second.body.total);
    expect(first.body.items[0]?.entityId).not.toBe(second.body.items[0]?.entityId);
    const all = await request(app).get("/api/reports/missing-documents").query({ limit: 1000 }).set("Cookie", cookie);
    const keys = all.body.items.map((row: { docType: string; entityType: string; entityId: string }) => `${row.docType}:${row.entityType}:${row.entityId}`);
    expect(keys).toEqual([...keys].sort());
  });

  const validSorts: Array<[string, string]> = [
    ["/api/referrals", "clientName"],
    ["/api/authorizations", "status"],
    ["/api/invoices", "vendorName"],
    ["/api/payments", "amount"],
    ["/api/remittances", "altaReference"],
    ["/api/vendors", "w9Status"],
    ["/api/audit-log", "userName"],
    ["/api/reports/pending-authorizations", "daysWaiting"],
    ["/api/reports/case-status", "coordinatorName"],
    ["/api/reports/missing-documents", "entityName"],
    ["/api/reports/expiring-authorizations", "maxPeriodAmount"],
  ];

  for (const [path, sortBy] of validSorts) {
    it(`executes the allowlisted ${sortBy} ordering on ${path}`, async () => {
      const response = await request(app)
        .get(path)
        .query({ sortBy, sortDirection: "desc", limit: 2 })
        .set("Cookie", cookie);
      expect(response.status).toBe(200);
    });
  }
});