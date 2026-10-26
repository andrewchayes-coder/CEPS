import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, and } from "drizzle-orm";
import {
  db, usersTable, sessionsTable, clientsTable, vendorsTable, authorizationsTable,
  invoicesTable, invoiceLineItemsTable, auditLogTable, staffRolesTable, staffRolePermissionsTable,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";
import { invoiceServiceDatesError } from "../lib/invoice-service-dates";

const nonce = `simple${Date.now().toString(36)}`;
const users = new Map<string, { id: string; cookie: string }>();
let clientId: string, otherClientId: string, vendorId: string, otherVendorId: string, authId: string, roleId: string;
const dates = { serviceStartDate: "2026-09-15", serviceEndDate: "2026-11-02" };
beforeAll(async () => {
  const [role] = await db.insert(staffRolesTable).values({ name: nonce }).returning();
  roleId = role.id;
  await db.insert(staffRolePermissionsTable).values({ roleId, permission: "invoice_log_validate" });
  const [vendor, otherVendor] = await db.insert(vendorsTable).values([
    { name: `${nonce} linked`, w9Status: "on_file" }, { name: `${nonce} other`, ein: "test-other-vendor-private" },
  ]).returning();
  vendorId = vendor.id; otherVendorId = otherVendor.id;
  for (const role of ["staff", "service_coordinator", "parent_guardian", "self", "vendor"] as const) {
    const [user] = await db.insert(usersTable).values({
      name: `${nonce} ${role}`, email: `${nonce}-${role}@test.local`, role,
      ...(role === "staff" ? { staffRoleId: roleId } : {}),
      ...(role === "vendor" ? { linkedRecordType: "vendor", linkedRecordId: vendorId } : {}),
    }).returning();
    const token = newToken();
    await db.insert(sessionsTable).values({ userId: user.id, token, expiresAt: new Date(Date.now() + 3600000) });
    users.set(role, { id: user.id, cookie: `ceps_session=${token}` });
  }
  const clients = await db.insert(clientsTable).values([
    { firstName: nonce, lastName: "Linked", dateOfBirth: "2000-01-01", uciNumber: `${nonce}a`, assignedCoordinatorId: users.get("service_coordinator")!.id },
    { firstName: nonce, lastName: "Other", dateOfBirth: "2000-01-01", uciNumber: `${nonce}b` },
  ]).returning();
  clientId = clients[0].id; otherClientId = clients[1].id;
  await db.update(usersTable).set({ linkedRecordType: "client", linkedRecordId: clientId })
    .where(inArray(usersTable.id, [users.get("parent_guardian")!.id, users.get("self")!.id]));
  const auths = await db.insert(authorizationsTable).values([
    { clientId, vendorId, authNumber: `${nonce}-459`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2027-12-31", maxPeriodAmount: "10000", monthlyAmount: "1000" },
    { clientId: otherClientId, vendorId: otherVendorId, authNumber: `${nonce}-other`, serviceCode: "459", paymentType: "direct_payment", servicePeriodStart: "2026-01-01", servicePeriodEnd: "2027-12-31", maxPeriodAmount: "10000", monthlyAmount: "1000" },
  ]).returning();
  authId = auths[0].id;
});
afterAll(async () => {
  const userIds = [...users.values()].map((u) => u.id);
  if (userIds.length) await db.delete(auditLogTable).where(inArray(auditLogTable.userId, userIds));
  if (clientId) {
    const invoices = await db.select({ id: invoicesTable.id }).from(invoicesTable).where(eq(invoicesTable.clientId, clientId));
    if (invoices.length) {
      await db.delete(invoiceLineItemsTable).where(inArray(invoiceLineItemsTable.invoiceId, invoices.map((i) => i.id)));
      await db.delete(invoicesTable).where(eq(invoicesTable.clientId, clientId));
    }
    await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientId, otherClientId]));
    await db.delete(clientsTable).where(inArray(clientsTable.id, [clientId, otherClientId]));
  }
  if (userIds.length) {
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  if (roleId) await db.delete(staffRolesTable).where(eq(staffRolesTable.id, roleId));
  if (vendorId) await db.delete(vendorsTable).where(inArray(vendorsTable.id, [vendorId, otherVendorId]));
});
function post(role: string, extra: Record<string, unknown> = {}) {
  const user = users.get(role)!;
  return request(app).post("/api/invoices").set("Cookie", user.cookie).send({
    clientId, ...dates, documentType: "receipt",
    documentUrl: `/objects/uploads/${user.id}/${randomUUID()}`, ...extra,
  });
}
function line(month = "2026-10") {
  return { authorizationId: authId, serviceMonth: month, amount: "25.00" };
}
describe("simplified invoice service dates and participant boundaries", () => {
  it.each(["staff", "vendor"])("%s full submission requires an explicit payment type", async role => {
    const missing = await post(role, { lineItems: [line()] });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("paymentType is required");
    const explicit = await post(role, { paymentType: "direct_payment", lineItems: [line()] });
    expect(explicit.status, JSON.stringify(explicit.body)).toBe(201);
    expect(explicit.body.paymentType).toBe("direct_payment");
  });
  it.each(["service_coordinator", "parent_guardian", "self"])("%s simplified submission defaults payment type from document type", async role => {
    for (const documentType of ["invoice", "receipt"]) {
      const response = await post(role, { documentType });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.paymentType).toBe(documentType === "invoice" ? "direct_payment" : "reimbursement");
    }
  });
  it.each(["service_coordinator", "parent_guardian", "self"])("%s requires both dates and creates needs_entry with dates", async (role) => {
    for (const missing of [{ serviceStartDate: undefined }, { serviceEndDate: undefined }]) {
      const response = await post(role, missing);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("Service start date and service end date are required");
    }
    const response = await post(role);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ ...dates, status: "needs_entry", lineItems: [], serviceCodes: [], documentType: "receipt", paymentType: "reimbursement" });
    const detail = await request(app).get(`/api/invoices/${response.body.id}`).set("Cookie", users.get(role)!.cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.serviceStartDate).toBe(dates.serviceStartDate);
    const list = await request(app).get("/api/invoices").set("Cookie", users.get(role)!.cookie).query({ clientId });
    expect(list.status).toBe(200);
    expect(list.body.items.some((i: { id: string; status: string }) => i.id === response.body.id && i.status === "needs_entry")).toBe(true);
  });
  it.each(["service_coordinator", "parent_guardian", "self"])("%s cannot bypass CEPS entry or submit without a document", async (role) => {
    expect((await post(role, { lineItems: [line()] })).status).toBe(400);
    expect((await post(role, { lineItems: [] })).status).toBe(400);
    expect((await post(role, { documentUrl: " " })).status).toBe(400);
  });
  it.each(["parent_guardian", "self"])("%s cannot submit or select a vendor for another participant", async (role) => {
    expect((await post(role, { clientId: otherClientId })).status).toBe(403);
    expect((await post(role, { vendorId: otherVendorId })).status).toBe(400);
  });
  it.each([
    { serviceStartDate: "2026-11-03", serviceEndDate: "2026-11-02" },
    { serviceStartDate: "2026-02-30", serviceEndDate: "2026-03-01" },
    { serviceStartDate: "2026-09-01", serviceEndDate: "2027-09-01" },
  ])("rejects invalid, reversed or overlong date range %j", async (range) => {
    expect((await post("parent_guardian", range)).status).toBe(400);
  });
  it("accepts twelve calendar months and validates leap days exactly", () => {
    expect(invoiceServiceDatesError("2026-01-01", "2026-12-31", true)).toBeNull();
    expect(invoiceServiceDatesError("2028-02-29", "2028-02-29", true)).toBeNull();
    expect(invoiceServiceDatesError("2026-02-29", "2026-03-01", true)).toContain("valid calendar dates");
  });
  it.each(["service_coordinator", "parent_guardian", "self"])("%s retries preserve type and date boundaries", async (role) => {
    const documentUrl = `/objects/uploads/${users.get(role)!.id}/${randomUUID()}`;
    const first = await post(role, { documentUrl });
    const retry = await post(role, { documentUrl });
    expect(first.status).toBe(201); expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect((await post(role, { documentUrl, serviceEndDate: "2026-11-03" })).status).toBe(409);
    expect((await post(role, { documentUrl, serviceStartDate: "2026-09-16" })).status).toBe(409);
    expect((await post(role, { documentUrl, documentType: "invoice", paymentType: "reimbursement" })).status).toBe(409);
  });
  it("serializes concurrent parent upload retries into one invoice", async () => {
    const documentUrl = `/objects/uploads/${users.get("parent_guardian")!.id}/${randomUUID()}`;
    const [a, b] = await Promise.all([post("parent_guardian", { documentUrl }), post("parent_guardian", { documentUrl })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
  });
  it.each(["staff", "vendor"])("%s keeps full line-item submission with optional dates", async (role) => {
    const response = await post(role, { paymentType: "direct_payment", serviceStartDate: undefined, serviceEndDate: undefined, lineItems: [line()] });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ status: "pending_review", serviceStartDate: null, serviceEndDate: null });
    expect(response.body.lineItems).toHaveLength(1);
    expect((await post(role, { serviceStartDate: undefined, serviceEndDate: undefined })).status).toBe(400);
  });
  it("lets staff edit dates with before/after audit, preserves omitted dates and rejects invalid merged ranges", async () => {
    const created = await post("parent_guardian");
    const path = `/api/invoices/${created.body.id}`;
    const staffCookie = users.get("staff")!.cookie;
    const edited = await request(app).patch(path).set("Cookie", staffCookie).send({ serviceStartDate: "2026-09-01", serviceEndDate: "2026-10-31" });
    expect(edited.status).toBe(200);
    expect(edited.body.serviceEndDate).toBe("2026-10-31");
    const audit = await db.select().from(auditLogTable).where(and(eq(auditLogTable.entityId, created.body.id), eq(auditLogTable.action, "update_invoice")));
    expect(audit[0].detail).toContain(dates.serviceStartDate);
    expect(audit[0].detail).toContain("2026-09-01");
    expect(audit[0].detail).toContain(dates.serviceEndDate);
    expect(audit[0].detail).toContain("2026-10-31");
    const unrelated = await request(app).patch(path).set("Cookie", staffCookie).send({ notes: "keep dates" });
    expect(unrelated.body.serviceStartDate).toBe("2026-09-01");
    expect((await request(app).patch(path).set("Cookie", staffCookie).send({ serviceEndDate: "2026-08-31" })).status).toBe(400);
    expect((await request(app).patch(path).set("Cookie", users.get("parent_guardian")!.cookie).send({ serviceEndDate: "2026-10-01" })).status).toBe(403);
    const cleared = await request(app).patch(path).set("Cookie", staffCookie).send({ serviceStartDate: null, serviceEndDate: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.serviceStartDate).toBeNull();
  });
  it("warns about out-of-range months without making the warning a validation failure", async () => {
    const created = await post("parent_guardian", { serviceStartDate: "2026-09-01", serviceEndDate: "2026-10-31" });
    const path = `/api/invoices/${created.body.id}`;
    const cookie = users.get("staff")!.cookie;
    const entered = await request(app).patch(path).set("Cookie", cookie).send({ lineItems: [line("2026-11"), line("2026-09")], status: "pending_review", vendorId });
    expect(entered.status).toBe(200);
    const result = await request(app).post(`${path}/validate`).set("Cookie", cookie).send({});
    expect(result.status).toBe(200);
    const warnings = result.body.checks.filter((c: { warning?: boolean }) => c.warning);
    expect(warnings).toEqual([{
      check: "submitted_service_dates", warning: true, passed: true,
      message: "Line month 11/2026 is outside the submitted service dates 09/01/2026 – 10/31/2026",
    }]);
    expect(result.body.valid).toBe(result.body.checks.filter((c: { warning?: boolean }) => !c.warning).every((c: { passed: boolean }) => c.passed));
    await request(app).patch(path).set("Cookie", cookie).send({ lineItems: [line()], status: "pending_review" });
    const inside = await request(app).post(`${path}/validate`).set("Cookie", cookie).send({});
    expect(inside.body.checks.some((c: { warning?: boolean }) => c.warning)).toBe(false);
  });
});
describe("parent and self vendor access", () => {
  it.each(["parent_guardian", "self"])("%s only sees linked vendors, including direct record reads", async (role) => {
    const cookie = users.get(role)!.cookie;
    for (const params of [{}, { invoiceEligible: "true" }, { clientId }]) {
      const response = await request(app).get("/api/vendors").set("Cookie", cookie).query(params);
      expect(response.status).toBe(200);
      expect(response.body.items.map((v: { id: string }) => v.id)).toEqual([vendorId]);
      expect(JSON.stringify(response.body)).not.toContain("test-other-vendor-private");
    }
    expect((await request(app).get("/api/vendors").set("Cookie", cookie).query({ clientId: otherClientId })).status).toBe(403);
    expect((await request(app).get(`/api/vendors/${vendorId}`).set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).get(`/api/vendors/${otherVendorId}`).set("Cookie", cookie)).status).toBe(404);
    expect((await request(app).get(`/api/vendors/${vendorId}`).set("Cookie", cookie).query({ clientId: otherClientId })).status).toBe(403);
  });
  it("preserves coordinator global vendor search, with an optional participant filter", async () => {
    const cookie = users.get("service_coordinator")!.cookie;
    const all = await request(app).get("/api/vendors").set("Cookie", cookie).query({ search: nonce });
    expect(all.status).toBe(200);
    expect(all.body.items.map((v: { id: string }) => v.id).sort()).toEqual([vendorId, otherVendorId].sort());
    const scoped = await request(app).get("/api/vendors").set("Cookie", cookie).query({ clientId, search: nonce });
    expect(scoped.body.items.map((v: { id: string }) => v.id)).toEqual([vendorId]);
  });
  it("fails closed for parent/self accounts without a linked participant", async () => {
    const parent = users.get("parent_guardian")!;
    await db.update(usersTable).set({ linkedRecordType: null, linkedRecordId: null }).where(eq(usersTable.id, parent.id));
    try {
      expect((await request(app).get("/api/vendors").set("Cookie", parent.cookie)).status).toBe(403);
      expect((await request(app).get(`/api/vendors/${vendorId}`).set("Cookie", parent.cookie)).status).toBe(403);
      expect((await request(app).get("/api/invoices").set("Cookie", parent.cookie)).status).toBe(403);
      expect((await post("parent_guardian")).status).toBe(403);
    } finally {
      await db.update(usersTable).set({ linkedRecordType: "client", linkedRecordId: clientId }).where(eq(usersTable.id, parent.id));
    }
  });
});
