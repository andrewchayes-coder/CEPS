import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  authorizationsTable,
  clientsTable,
  db,
  invoicesTable,
  invoiceLineItemsTable,
  referralsTable,
  sessionsTable,
  usersTable,
  vendorsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `clientdocs${Date.now().toString(36)}`;
let staffId: string;
let parentId: string;
let clientId: string;
let vendorId: string;
let referralId: string;
let authorizationId: string;
let invoiceId: string;
let staffCookie: string;
let parentCookie: string;

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

beforeAll(async () => {
  const [staff, parent] = await db
    .insert(usersTable)
    .values([
      { name: "Document Staff", email: `${nonce}-staff@test.local`, role: "staff" },
      { name: "Document Parent", email: `${nonce}-parent@test.local`, role: "parent_guardian" },
    ])
    .returning();
  staffId = staff.id;
  parentId = parent.id;

  const [client] = await db
    .insert(clientsTable)
    .values({
      firstName: "Document",
      lastName: "Participant",
      dateOfBirth: "2000-01-01",
      uciNumber: `${nonce}-uci`,
    })
    .returning();
  clientId = client.id;
  await db
    .update(usersTable)
    .set({ linkedRecordType: "client", linkedRecordId: clientId })
    .where(eq(usersTable.id, parentId));

  const [vendor] = await db
    .insert(vendorsTable)
    .values({
      name: `${nonce} Vendor`,
      w9Status: "on_file",
      w9DocumentUrl: "/objects/uploads/vendor-w9",
    })
    .returning();
  vendorId = vendor.id;

  const [referral] = await db
    .insert(referralsTable)
    .values({
      clientId,
      referralDate: "2026-09-01",
      status: "pending_auth",
      intakeSentAt: new Date("2026-09-02T12:00:00Z"),
      parentSignedAt: new Date("2026-09-03T12:00:00Z"),
      signedByName: "Document Signer",
      signerRelationship: "self",
      supportingDocumentUrl: "/objects/uploads/referral-source",
    })
    .returning();
  referralId = referral.id;

  const [authorization] = await db
    .insert(authorizationsTable)
    .values({
      clientId,
      vendorId,
      authNumber: `${nonce}-pos`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-09-01",
      servicePeriodEnd: "2026-12-31",
      maxPeriodAmount: "1000.00",
      posPdfUrl: "/objects/uploads/pos-source",
      receivedDate: "2026-09-04",
    })
    .returning();
  authorizationId = authorization.id;

  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      clientId,
      vendorId,
      authorizationId,
      submittedByRole: "staff",
      submittedDate: "2026-09-05",
      serviceMonth: "2026-09",
      amountRequested: "100.00",
      paymentType: "direct_payment",
      documentUrl: null,
    })
    .returning();
  invoiceId = invoice.id;
  await db.insert(invoiceLineItemsTable).values({
    invoiceId,
    authorizationId,
    serviceMonth: "2026-09",
    amount: "100.00",
    documentUrl: "/objects/uploads/invoice-line-source",
  });

  staffCookie = await session(staffId);
  parentCookie = await session(parentId);
});

afterAll(async () => {
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, parentId]));
  await db.delete(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  await db.delete(authorizationsTable).where(eq(authorizationsTable.id, authorizationId));
  await db.delete(referralsTable).where(eq(referralsTable.id, referralId));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, parentId]));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
});

describe("GET /clients/:id/case document rollup", () => {
  it("shows staff tracked documents with attachment and signature statuses", async () => {
    const response = await request(app)
      .get(`/api/clients/${clientId}/case`)
      .set("Cookie", staffCookie);

    expect(response.status).toBe(200);
    expect(response.body.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "participant_agreement",
          status: "received",
          signatureStatus: "signed",
        }),
        expect.objectContaining({
          category: "referral_attachment",
          status: "received",
          objectPath: "/objects/uploads/referral-source",
        }),
        expect.objectContaining({
          category: "authorization_pos",
          status: "received",
          objectPath: "/objects/uploads/pos-source",
        }),
        expect.objectContaining({
          category: "invoice",
          status: "pending",
          objectPath: null,
        }),
        expect.objectContaining({
          category: "vendor_w9",
          status: "received",
          objectPath: "/objects/uploads/vendor-w9",
        }),
      ]),
    );
  });

  it("does not expose the staff document rollup to participant accounts", async () => {
    const response = await request(app)
      .get(`/api/clients/${clientId}/case`)
      .set("Cookie", parentCookie);

    expect(response.status).toBe(200);
    expect(response.body.documents).toEqual([]);
  });
});

describe("GET /storage/objects invoice line documents", () => {
  it("allows staff and the linked participant to resolve a line document path", async () => {
    const staffResponse = await request(app)
      .get("/api/storage/objects/uploads/invoice-line-source")
      .set("Cookie", staffCookie);
    const parentResponse = await request(app)
      .get("/api/storage/objects/uploads/invoice-line-source")
      .set("Cookie", parentCookie);

    // The fixture object is not present in object storage; 404 proves both
    // requests passed authorization (unauthorized requests return 403).
    expect(staffResponse.status).toBe(404);
    expect(parentResponse.status).toBe(404);
  });

  it("denies a linked participant an unknown line-document path", async () => {
    const response = await request(app)
      .get("/api/storage/objects/uploads/not-an-invoice-line-document")
      .set("Cookie", parentCookie);
    expect(response.status).toBe(403);
  });
});