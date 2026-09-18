import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  authorizationVersionsTable,
  authorizationsTable,
  clientsTable,
  db,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `aam${Date.now().toString(36)}`;
let staffId: string;
let nonStaffId: string;
let clientId: string;
let staffCookie: string;
let nonStaffCookie: string;
const authIds: string[] = [];

async function cookie(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 3600000),
  });
  return `ceps_session=${token}`;
}

async function createAuthorization(authNumber: string, extra: Record<string, unknown> = {}) {
  const response = await request(app)
    .post("/api/authorizations")
    .set("Cookie", staffCookie)
    .send({
      clientId,
      authNumber,
      serviceCode: "459",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      maxPeriodAmount: "1200.00",
      status: "active",
      ...extra,
    });
  if (response.body.authorization?.id) authIds.push(response.body.authorization.id);
  return response;
}

beforeAll(async () => {
  const [staff] = await db.insert(usersTable).values({
    name: "Amendment Staff",
    email: `${nonce}-staff@test.local`,
    role: "staff",
  }).returning();
  const [nonStaff] = await db.insert(usersTable).values({
    name: "Amendment Coordinator",
    email: `${nonce}-coordinator@test.local`,
    role: "service_coordinator",
  }).returning();
  const [client] = await db.insert(clientsTable).values({
    firstName: "Amendment",
    lastName: "Client",
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-uci`,
  }).returning();
  staffId = staff.id;
  nonStaffId = nonStaff.id;
  clientId = client.id;
  staffCookie = await cookie(staffId);
  nonStaffCookie = await cookie(nonStaffId);
});

afterAll(async () => {
  await db.delete(authorizationVersionsTable).where(inArray(authorizationVersionsTable.authorizationId, authIds));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [staffId, nonStaffId]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.id, authIds));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, nonStaffId]));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, nonStaffId]));
});

describe("authorization amendment and cancellation workflows", () => {
  it("creates a brand-new exact client/authorization pair", async () => {
    const response = await createAuthorization(`${nonce}-new`);
    expect(response.status).toBe(201);
    expect(response.body.authorization).toMatchObject({
      clientId,
      authNumber: `${nonce}-new`,
      status: "active",
    });
  });

  it("rejects canceled status on generic creation", async () => {
    const response = await createAuthorization(`${nonce}-generic-canceled`, { status: "canceled" });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/canceled|invalid option/i);
  });

  it("returns an existing nondeleted exact pair from lookup and controls duplicate create", async () => {
    const authNumber = `${nonce}-duplicate`;
    const created = await createAuthorization(authNumber);
    const authId = created.body.authorization.id;
    const lookup = await request(app)
      .get("/api/authorizations/lookup")
      .query({ clientId, authNumber })
      .set("Cookie", staffCookie);
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({ exists: true, authorization: { id: authId, authNumber } });
    const spaced = await createAuthorization(` ${authNumber} `);
    expect(spaced.status).toBe(201);
    const duplicate = await createAuthorization(authNumber);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatch(/amend/i);
  });

  it("amends the requested fields, preserves status, and snapshots exactly once", async () => {
    const created = await createAuthorization(`${nonce}-amend`, { status: "pending", posNotes: "original notes", posPdfUrl: "/old.pdf" });
    const authId = created.body.authorization.id;
    const response = await request(app)
      .post(`/api/authorizations/${authId}/amend`)
      .set("Cookie", staffCookie)
      .send({
        servicePeriodStart: "2027-02-01",
        servicePeriodEnd: "2027-12-31",
        monthlyAmount: "250.00",
        maxPeriodAmount: "3000.00",
        posNotes: "  verbatim POS notes \nline two  ",
        posPdfUrl: "/new.pdf",
        confirmed: true,
        acceptMaxAmountWarning: true,
      });
    expect(response.status).toBe(200);
    expect(response.body.authorization.posNotes).toBe("  verbatim POS notes \nline two  ");
    const [live] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.id, authId));
    expect(live).toMatchObject({
      status: "pending",
      servicePeriodStart: "2027-02-01",
      servicePeriodEnd: "2027-12-31",
      monthlyAmount: "250.00",
      maxPeriodAmount: "3000.00",
      posNotes: "  verbatim POS notes \nline two  ",
      posPdfUrl: "/new.pdf",
    });
    const versions = await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, authId));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ status: "pending", posNotes: "original notes", posPdfUrl: "/old.pdf", changedBy: staffId });
    const [audit] = await db.select().from(auditLogTable).where(and(eq(auditLogTable.entityId, authId), eq(auditLogTable.action, "amend_authorization")));
    expect(audit).toBeTruthy();
  });

  it("preserves the existing POS PDF when amendment omits posPdfUrl", async () => {
    const created = await createAuthorization(`${nonce}-pdf-omitted`, { posPdfUrl: "/objects/original.pdf" });
    const authId = created.body.authorization.id;
    const response = await request(app)
      .post(`/api/authorizations/${authId}/amend`)
      .set("Cookie", staffCookie)
      .send({
        servicePeriodStart: "2027-01-01",
        servicePeriodEnd: "2027-12-31",
        maxPeriodAmount: "2400.00",
        posNotes: "updated notes",
        confirmed: true,
      });
    expect(response.status).toBe(200);
    const [live] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.id, authId));
    expect(live.posPdfUrl).toBe("/objects/original.pdf");
    const versions = await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, authId));
    expect(versions).toHaveLength(1);
    expect(versions[0].posPdfUrl).toBe("/objects/original.pdf");
  });

  it("requires explicit confirmation and makes no change or snapshot", async () => {
    const created = await createAuthorization(`${nonce}-confirm`, { posNotes: "before" });
    const authId = created.body.authorization.id;
    const response = await request(app)
      .post(`/api/authorizations/${authId}/amend`)
      .set("Cookie", staffCookie)
      .send({ servicePeriodStart: "2028-01-01", servicePeriodEnd: "2028-12-31", maxPeriodAmount: "99.00", posNotes: "after", confirmed: false });
    expect(response.status).toBe(400);
    expect(await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, authId))).toHaveLength(0);
    const [live] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.id, authId));
    expect(live.posNotes).toBe("before");
  });

  it("does not let a soft-deleted pair block lookup or a fresh create", async () => {
    const authNumber = `${nonce}-soft`;
    const [deleted] = await db.insert(authorizationsTable).values({
      clientId, authNumber, serviceCode: "459", paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01", servicePeriodEnd: "2026-12-31", maxPeriodAmount: "10.00", status: "active", isDeleted: true,
    }).returning();
    authIds.push(deleted.id);
    const lookup = await request(app).get("/api/authorizations/lookup").query({ clientId, authNumber }).set("Cookie", staffCookie);
    expect(lookup.body.exists).toBe(false);
    const created = await createAuthorization(authNumber);
    expect(created.status).toBe(201);
  });

  it("cancels with a trimmed reason, snapshots once, and leaves the row undeleted", async () => {
    const created = await createAuthorization(`${nonce}-cancel`);
    const authId = created.body.authorization.id;
    expect((await request(app).post(`/api/authorizations/${authId}/cancel`).set("Cookie", staffCookie).send({ reason: "   " })).status).toBe(400);
    const response = await request(app).post(`/api/authorizations/${authId}/cancel`).set("Cookie", staffCookie).send({ reason: "  POS withdrawn by regional center  " });
    expect(response.status).toBe(200);
    expect(response.body.authorization.status).toBe("canceled");
    const [live] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.id, authId));
    expect(live).toMatchObject({ status: "canceled", isDeleted: false });
    expect(await db.select().from(authorizationVersionsTable).where(eq(authorizationVersionsTable.authorizationId, authId))).toHaveLength(1);
    const [audit] = await db.select().from(auditLogTable).where(and(eq(auditLogTable.entityId, authId), eq(auditLogTable.action, "cancel_authorization")));
    expect(audit?.detail).toContain("POS withdrawn by regional center");
  });

  it("forbids nonstaff lookup, amendment, and cancellation", async () => {
    const created = await createAuthorization(`${nonce}-forbidden`);
    const authId = created.body.authorization.id;
    expect((await request(app).get("/api/authorizations/lookup").query({ clientId, authNumber: `${nonce}-forbidden` }).set("Cookie", nonStaffCookie)).status).toBe(403);
    expect((await request(app).post(`/api/authorizations/${authId}/amend`).set("Cookie", nonStaffCookie).send({ confirmed: true })).status).toBe(403);
    expect((await request(app).post(`/api/authorizations/${authId}/cancel`).set("Cookie", nonStaffCookie).send({ reason: "no" })).status).toBe(403);
    const list = await request(app).get("/api/authorizations").set("Cookie", nonStaffCookie);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(0);
    expect((await request(app).get(`/api/authorizations/${authId}`).set("Cookie", nonStaffCookie)).status).toBe(403);
  });

  it("returns the parser success contract and extracted POS notes", async () => {
    const create = vi.spyOn(anthropic.messages, "create").mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          clientName: "Amendment Client",
          authNumber: `${nonce}-parsed`,
          serviceCode: "459",
          activityDescription: "Supported employment",
          servicePeriodStart: "2026-01-01",
          servicePeriodEnd: "2026-12-31",
          units: 1,
          monthlyAmount: "100.00",
          maxPeriodAmount: "1200.00",
          caseworkerName: "Worker",
          posNotes: "note from parser",
        }),
      }],
    } as never);
    const response = await request(app)
      .post("/api/authorizations/parse-pdf")
      .set("Cookie", staffCookie)
      .send({ pdfBase64: "JVBERi0xLjQ=", fileName: `${nonce}.pdf` });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, error: null, fields: { posNotes: "note from parser" } });
    expect(JSON.stringify(create.mock.calls[0])).toMatch(/Alta accounting notes/);
    expect(JSON.stringify(create.mock.calls[0])).toMatch(/verbatim/);
    expect(JSON.stringify(create.mock.calls[0])).toMatch(/line breaks/);
    create.mockRestore();
  });
});