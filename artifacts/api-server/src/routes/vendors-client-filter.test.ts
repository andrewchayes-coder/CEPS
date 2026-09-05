import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  authorizationsTable,
  clientsTable,
  db,
  invoicesTable,
  sessionsTable,
  usersTable,
  vendorsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `vendorclient${Date.now().toString(36)}`;
let staffId: string;
let clientId: string;
let otherClientId: string;
let authorizationId: string;
let invoiceId: string;
let cookie: string;
const vendorIds: string[] = [];

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "Vendor Filter Staff", email: `${nonce}@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [client, otherClient] = await db
    .insert(clientsTable)
    .values([
      { firstName: "Linked", lastName: "Participant", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-1` },
      { firstName: "Other", lastName: "Participant", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-2` },
    ])
    .returning();
  clientId = client.id;
  otherClientId = otherClient.id;

  const vendors = await db
    .insert(vendorsTable)
    .values([
      { name: `${nonce} Authorization Vendor` },
      { name: `${nonce} Invoice Vendor` },
      { name: `${nonce} Unrelated Vendor` },
    ])
    .returning();
  vendorIds.push(...vendors.map((vendor) => vendor.id));

  const [authorization] = await db
    .insert(authorizationsTable)
    .values({
      clientId,
      vendorId: vendorIds[0],
      authNumber: `${nonce}-auth`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      maxPeriodAmount: "1000.00",
    })
    .returning();
  authorizationId = authorization.id;

  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      clientId,
      vendorId: vendorIds[1],
      submittedByRole: "staff",
      submittedDate: "2026-09-05",
      serviceMonth: "2026-09",
      amountRequested: "100.00",
      paymentType: "direct_payment",
    })
    .returning();
  invoiceId = invoice.id;

  const token = newToken();
  await db.insert(sessionsTable).values({
    userId: staffId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  cookie = `ceps_session=${token}`;
});

afterAll(async () => {
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  await db.delete(authorizationsTable).where(eq(authorizationsTable.id, authorizationId));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, vendorIds));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientId, otherClientId]));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
});

describe("GET /vendors clientId filter", () => {
  it("returns vendors linked through authorizations or invoices without unrelated vendors", async () => {
    const response = await request(app)
      .get("/api/vendors")
      .query({ clientId, search: nonce, limit: 20 })
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.items.map((vendor: { id: string }) => vendor.id)).toEqual(
      expect.arrayContaining([vendorIds[0], vendorIds[1]]),
    );
    expect(response.body.items.map((vendor: { id: string }) => vendor.id)).not.toContain(vendorIds[2]);
  });

  it("returns no linked vendors for another participant", async () => {
    const response = await request(app)
      .get("/api/vendors")
      .query({ clientId: otherClientId, search: nonce, limit: 20 })
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ items: [], total: 0 });
  });
});