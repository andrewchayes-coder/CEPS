import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db, pool, usersTable, sessionsTable, clientsTable, authorizationsTable,
  invoicesTable, invoiceLineItemsTable, auditLogTable, staffRolesTable, staffRolePermissionsTable,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `doctype${Date.now().toString(36)}`;
let staffId: string, coordId: string, roleId: string, clientId: string;
let staffCookie: string, coordCookie: string, auth459: string, auth024: string;
let mixedId: string, receiptId: string, pendingId: string;
const invoiceIds: string[] = [];
async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({ userId, token, expiresAt: new Date(Date.now() + 3600000) });
  return `ceps_session=${token}`;
}
beforeAll(async () => {
  const [staff] = await db.insert(usersTable).values({ name: nonce, email: `${nonce}-staff@test.local`, role: "staff" }).returning();
  staffId = staff.id;
  const [role] = await db.insert(staffRolesTable).values({ name: nonce }).returning();
  roleId = role.id;
  await db.insert(staffRolePermissionsTable).values({ roleId, permission: "invoice_log_validate" });
  await db.update(usersTable).set({ staffRoleId: roleId }).where(eq(usersTable.id, staffId));
  const [coord] = await db.insert(usersTable).values({ name: nonce, email: `${nonce}-sc@test.local`, role: "service_coordinator" }).returning();
  coordId = coord.id;
  const [client] = await db.insert(clientsTable).values({
    firstName: nonce, lastName: "Participant", dateOfBirth: "2000-01-01",
    uciNumber: nonce, assignedCoordinatorId: coordId,
  }).returning();
  clientId = client.id;
  for (const code of ["459", "024"]) {
    const [auth] = await db.insert(authorizationsTable).values({
      clientId, authNumber: `${nonce}-${code}`, serviceCode: code,
      paymentType: code === "024" ? "reimbursement" : "direct_payment",
      servicePeriodStart: "2026-01-01", servicePeriodEnd: "2027-12-31", maxPeriodAmount: "10000.00", monthlyAmount: "1000.00",
    }).returning();
    if (code === "459") auth459 = auth.id; else auth024 = auth.id;
  }
  staffCookie = await session(staffId); coordCookie = await session(coordId);
});
afterAll(async () => {
  await db.delete(invoiceLineItemsTable).where(inArray(invoiceLineItemsTable.invoiceId, invoiceIds));
  await db.delete(invoicesTable).where(eq(invoicesTable.clientId, clientId));
  await db.delete(authorizationsTable).where(eq(authorizationsTable.clientId, clientId));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [staffId, coordId]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, coordId]));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, coordId]));
  await db.delete(staffRolesTable).where(eq(staffRolesTable.id, roleId));
});
async function create(data: Record<string, unknown>, coordinator = false) {
  const userId = coordinator ? coordId : staffId;
  const response = await request(app).post("/api/invoices").set("Cookie", coordinator ? coordCookie : staffCookie).send({
    clientId, documentUrl: `/objects/uploads/${userId}/${randomUUID()}`,
    ...(!coordinator ? { lineItems: [{ authorizationId: auth459, serviceMonth: "2026-10", amount: "10.00" }] } : {}),
    ...data,
  });
  if (response.status === 201) invoiceIds.push(response.body.id);
  return response;
}
async function list(params: Record<string, string> = {}) {
  const response = await request(app).get("/api/invoices").set("Cookie", staffCookie).query({ clientId, ...params });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}
describe("invoice document type and line authorization codes", () => {
  it("defaults receipt payment type to reimbursement, including coordinator submission", async () => {
    const staff = await create({ documentType: "receipt", lineItems: [{ authorizationId: auth024, serviceMonth: "2026-10", amount: "10.00" }] });
    expect(staff.status, JSON.stringify(staff.body)).toBe(201);
    expect(staff.body).toMatchObject({ documentType: "receipt", paymentType: "reimbursement", serviceCodes: ["024"] });
    receiptId = staff.body.id;
    const coord = await create({ documentType: "receipt" }, true);
    expect(coord.status).toBe(201);
    expect(coord.body).toMatchObject({ documentType: "receipt", paymentType: "reimbursement", status: "needs_entry", serviceCodes: [], lineItems: [] });
    pendingId = coord.body.id;
  });
  it("defaults omitted document type to invoice and preserves explicit payment overrides", async () => {
    const omitted = await create({});
    expect(omitted.status).toBe(201);
    expect(omitted.body).toMatchObject({ documentType: "invoice", paymentType: "direct_payment" });
    const override = await create({ documentType: "receipt", paymentType: "direct_payment" });
    expect(override.status).toBe(201);
    expect(override.body).toMatchObject({ documentType: "receipt", paymentType: "direct_payment" });
  });
  it("returns distinct sorted codes from mixed line authorizations and their auth numbers", async () => {
    const response = await create({
      documentType: "invoice",
      lineItems: [
        { authorizationId: auth459, serviceMonth: "2026-10", amount: "20.00" },
        { authorizationId: auth024, serviceMonth: "2026-10", amount: "30.00" },
        { authorizationId: auth459, serviceMonth: "2026-11", amount: "40.00" },
      ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    mixedId = response.body.id;
    expect(response.body.serviceCodes).toEqual(["024", "459"]);
    expect(response.body.lineItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorizationId: auth459, serviceCode: "459", authNumber: `${nonce}-459` }),
      expect.objectContaining({ authorizationId: auth024, serviceCode: "024", authNumber: `${nonce}-024` }),
    ]));
    const detail = await request(app).get(`/api/invoices/${mixedId}`).set("Cookie", staffCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.serviceCodes).toEqual(["024", "459"]);
  });
  it("enriches all list lines and authorization numbers/codes in one joined query", async () => {
    const spy = vi.spyOn(pool, "query");
    let queries: string[] = [];
    try {
      const response = await list();
      expect(response.items.find((i: { id: string }) => i.id === mixedId).serviceCodes).toEqual(["024", "459"]);
      queries = spy.mock.calls.map(call => {
        const input = call[0] as unknown as string | { text?: string };
        return typeof input === "string" ? input : input.text ?? "";
      });
    } finally { spy.mockRestore(); }
    const joined = queries.filter(text => text.includes('from "invoice_line_items" left join "authorizations"'));
    expect(joined).toHaveLength(1);
    expect(joined[0]).toContain('"authorizations"."service_code"');
    expect(joined[0]).toContain('"authorizations"."auth_number"');
  });
  it("filters document type and ANY matching line code with accurate totals", async () => {
    const receipts = await list({ documentType: "receipt" });
    expect(receipts.total).toBe(receipts.items.length);
    expect(receipts.items.every((i: { documentType: string }) => i.documentType === "receipt")).toBe(true);
    const code024 = await list({ serviceCode: "024" });
    expect(code024.items.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([mixedId, receiptId]));
    expect(code024.items.map((i: { id: string }) => i.id)).not.toContain(pendingId);
    const combined = await list({ documentType: "invoice", serviceCode: "024" });
    expect(combined.items.map((i: { id: string }) => i.id)).toEqual([mixedId]);
    expect(combined.total).toBe(1);
  });
  it.each(["asc", "desc"])("sorts type and min line code %s with no-line invoices last", async direction => {
    const typed = await list({ sortBy: "documentType", sortDirection: direction });
    const types = typed.items.map((i: { documentType: string }) => i.documentType);
    expect(types).toEqual([...types].sort((a, b) => direction === "asc" ? a.localeCompare(b) : b.localeCompare(a)));
    const coded = await list({ sortBy: "serviceCode", sortDirection: direction });
    expect(coded.items.at(-1).id).toBe(pendingId);
    const minima = coded.items.filter((i: { serviceCodes: string[] }) => i.serviceCodes.length).map((i: { serviceCodes: string[] }) => i.serviceCodes[0]);
    expect(minima).toEqual([...minima].sort((a, b) => direction === "asc" ? a.localeCompare(b) : b.localeCompare(a)));
  });
  it("searches document type and authorization service code", async () => {
    const receipts = await list({ search: "receipt" });
    expect(receipts.items.length).toBeGreaterThan(0);
    expect(receipts.items.every((i: { documentType: string }) => i.documentType === "receipt")).toBe(true);
    const coded = await list({ search: "024" });
    expect(coded.items.map((i: { id: string }) => i.id)).toContain(mixedId);
  });
  it("audits type changes and leaves receipt unchanged on an unrelated PATCH", async () => {
    const change = await request(app).patch(`/api/invoices/${mixedId}`).set("Cookie", staffCookie).send({ documentType: "receipt" });
    expect(change.status).toBe(200);
    expect(change.body.documentType).toBe("receipt");
    const entries = await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, mixedId));
    const edit = entries.find(entry => entry.action === "update_invoice" && entry.detail?.includes("documentType"));
    expect(edit?.detail).toContain("invoice");
    expect(edit?.detail).toContain("receipt");
    const unrelated = await request(app).patch(`/api/invoices/${mixedId}`).set("Cookie", staffCookie).send({ notes: "Leave type alone" });
    expect(unrelated.status).toBe(200);
    expect(unrelated.body.documentType).toBe("receipt");
  });
  it("permits a document/payment mismatch when saving CEPS entry", async () => {
    const response = await request(app).patch(`/api/invoices/${pendingId}`).set("Cookie", staffCookie).send({
      documentType: "receipt", paymentType: "direct_payment",
      lineItems: [{ authorizationId: auth459, serviceMonth: "2026-10", amount: "25.00" }],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ documentType: "receipt", paymentType: "direct_payment", serviceCodes: ["459"] });
  });
  it("includes document type in coordinator duplicate-upload comparisons", async () => {
    const path = `/objects/uploads/${coordId}/${randomUUID()}`;
    const first = await create({ documentType: "invoice", paymentType: "direct_payment", documentUrl: path }, true);
    const retry = await create({ documentType: "invoice", paymentType: "direct_payment", documentUrl: path }, true);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    const changed = await create({ documentType: "receipt", paymentType: "direct_payment", documentUrl: path }, true);
    expect(changed.status).toBe(409); // same payment type: conflict is specifically documentType
  });
  it("rejects invalid type on create, edit, and list", async () => {
    expect((await create({ documentType: "other" })).status).toBe(400);
    expect((await request(app).patch(`/api/invoices/${mixedId}`).set("Cookie", staffCookie).send({ documentType: "other" })).status).toBe(400);
    expect((await request(app).get("/api/invoices").set("Cookie", staffCookie).query({ documentType: "other" })).status).toBe(400);
  });
});
