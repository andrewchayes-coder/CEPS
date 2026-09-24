import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  authorizationsTable,
  authorizationVersionsTable,
  auditLogTable,
  clientsTable,
  db,
  pool,
  sessionsTable,
  unmatchedPosDocumentsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";
import { ObjectStorageService } from "../lib/objectStorage";
import { parsePosPdf } from "../lib/posPdfParser";
import { POS_ITEM_LOCK_NAMESPACE } from "../lib/posBatchWorker";

vi.mock("../lib/posPdfParser", () => ({
  parsePosPdf: vi.fn(async () => ({})),
}));

const nonce = `upos${Date.now().toString(36)}`;
let staffId: string;
let nonStaffId: string;
let uciClientId: string;
let otherClientId: string;
let queueClientId: string;
let staffCookie: string;
let nonStaffCookie: string;
const queueIds: string[] = [];
const authIds: string[] = [];

async function cookieFor(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

function mockStoredPdf(metadata = { contentType: "application/pdf", size: "1024" }) {
  return vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockImplementation(async () => ({
    getMetadata: async () => [metadata],
    download: async () => [Buffer.from("%PDF-1.7 mock")],
  } as never));
}

async function waitForParseStatus(ids: string[], status: "parsed" | "failed") {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await db.select().from(unmatchedPosDocumentsTable)
      .where(inArray(unmatchedPosDocumentsTable.id, ids));
    if (rows.length === ids.length && rows.every((row) => row.parseStatus === status)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`POS batch did not reach parse status ${status}.`);
}

beforeAll(async () => {
  const [staff] = await db.insert(usersTable).values({
    name: "Unmatched POS Staff",
    email: `${nonce}-staff@test.local`,
    role: "staff",
  }).returning();
  const [nonStaff] = await db.insert(usersTable).values({
    name: "Unmatched POS Coordinator",
    email: `${nonce}-coord@test.local`,
    role: "service_coordinator",
  }).returning();
  staffId = staff.id;
  nonStaffId = nonStaff.id;
  const [uciClient] = await db.insert(clientsTable).values({
    firstName: "Correct",
    lastName: "Participant",
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-UCI-123`,
  }).returning();
  const [otherClient] = await db.insert(clientsTable).values({
    firstName: "Printed",
    lastName: "Name",
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-UCI-OTHER`,
  }).returning();
  const [queueClient] = await db.insert(clientsTable).values({
    firstName: "Queue",
    lastName: "Participant",
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-UCI-QUEUE`,
  }).returning();
  uciClientId = uciClient.id;
  otherClientId = otherClient.id;
  queueClientId = queueClient.id;
  staffCookie = await cookieFor(staffId);
  nonStaffCookie = await cookieFor(nonStaffId);
});

afterAll(async () => {
  await db.delete(unmatchedPosDocumentsTable).where(inArray(unmatchedPosDocumentsTable.id, queueIds));
  await db.delete(authorizationVersionsTable).where(inArray(authorizationVersionsTable.authorizationId, authIds));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.id, authIds));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [staffId, nonStaffId]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, nonStaffId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, nonStaffId]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [uciClientId, otherClientId, queueClientId]));
});

describe("unmatched POS API", () => {
  it("uses an exact UCI match before name matching", async () => {
    const response = await request(app)
      .post("/api/unmatched-pos/match")
      .set("Cookie", staffCookie)
      .send({
        uciNumber: `  ${nonce}-uci-123 `,
        clientName: "Printed Name",
      });

    expect(response.status).toBe(200);
    expect(response.body.method).toBe("uci");
    expect(response.body.client.id).toBe(uciClientId);
    expect(response.body.client.id).not.toBe(otherClientId);
  });

  it("rejects non-staff access to the unmatched POS workflow", async () => {
    const response = await request(app)
      .get("/api/unmatched-pos")
      .set("Cookie", nonStaffCookie);
    expect(response.status).toBe(403);
  });

  it("persists every parsed field and the original private PDF path when unmatched", async () => {
    const parsed = {
      posPdfUrl: `/objects/uploads/${nonce}-unmatched.pdf`,
      sourceFileName: `${nonce}-unmatched.pdf`,
      clientName: "Not Yet Onboarded",
      clientAddress: "123 Main St",
      clientPhone: "555-0100",
      uciNumber: null,
      authNumber: `${nonce}-POS-001`,
      serviceCode: "459",
      activityDescription: "Supported employment",
      servicePeriodStart: "2026-04-01",
      servicePeriodEnd: "2026-09-30",
      units: 6,
      monthlyAmount: "125.50",
      maxPeriodAmount: "753.00",
      caseworkerName: "Case Worker",
      posNotes: "POS note preserved verbatim",
    };
    const response = await request(app)
      .post("/api/unmatched-pos")
      .set("Cookie", staffCookie)
      .send(parsed);

    expect(response.status).toBe(201);
    queueIds.push(response.body.id);
    expect(response.body).toMatchObject(parsed);
    const [stored] = await db.select().from(unmatchedPosDocumentsTable)
      .where(eq(unmatchedPosDocumentsTable.id, response.body.id));
    expect(stored).toMatchObject(parsed);
  });

  it("queues a batch of PDFs under one batch id and exposes progress", async () => {
    const objectIds = [randomUUID(), randomUUID(), randomUUID()];
    const [existingAuthorization] = await db.insert(authorizationsTable).values({
      clientId: uciClientId,
      authNumber: `${nonce}-POS-BATCH-AMEND`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      maxPeriodAmount: "1000.00",
      status: "active",
    }).returning();
    authIds.push(existingAuthorization.id);
    const pdfSpy = mockStoredPdf();
    vi.mocked(parsePosPdf).mockResolvedValue({
      clientName: "Printed Name",
      uciNumber: `${nonce}-UCI-123`,
      authNumber: existingAuthorization.authNumber,
      serviceCode: "459",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      units: 12,
      monthlyAmount: "83.33",
      maxPeriodAmount: "1000.00",
    });
    const response = await request(app)
      .post("/api/unmatched-pos/batches")
      .set("Cookie", staffCookie)
      .send({
        files: objectIds.map((objectId, index) => ({
          posPdfUrl: `/objects/uploads/${staffId}/${objectId}`,
          sourceFileName: `${nonce}-batch-${index}.pdf`,
        })),
      });
    expect(response.status).toBe(202);
    expect(response.body.queuedCount).toBe(3);
    expect(response.body.items).toHaveLength(3);
    expect(new Set(response.body.items.map((item: { batchId: string }) => item.batchId))).toEqual(
      new Set([response.body.batchId]),
    );
    queueIds.push(...response.body.items.map((item: { id: string }) => item.id));
    const parsedRows = await waitForParseStatus(queueIds.slice(-3), "parsed");
    expect(parsedRows).toHaveLength(3);
    expect(parsedRows[0]).toMatchObject({
      suggestedClientId: uciClientId,
      suggestionMethod: "uci",
      suggestedAuthorizationId: existingAuthorization.id,
    });
    pdfSpy.mockRestore();

    const progress = await request(app)
      .get(`/api/unmatched-pos/batches/${response.body.batchId}`)
      .set("Cookie", staffCookie);
    expect(progress.status).toBe(200);
    expect(progress.body).toMatchObject({ batchId: response.body.batchId, totalCount: 3, parsedCount: 3, pendingCount: 3 });
  });

  it("rejects foreign-owned, non-PDF, and oversized batch objects before inserting rows", async () => {
    const rowsBefore = await db.select().from(unmatchedPosDocumentsTable)
      .where(eq(unmatchedPosDocumentsTable.createdBy, staffId));
    const foreign = await request(app)
      .post("/api/unmatched-pos/batches")
      .set("Cookie", staffCookie)
      .send({ files: [{ posPdfUrl: `/objects/uploads/${nonStaffId}/${randomUUID()}`, sourceFileName: "foreign.pdf" }] });
    expect(foreign.status).toBe(403);
    expect(await db.select().from(unmatchedPosDocumentsTable)
      .where(eq(unmatchedPosDocumentsTable.createdBy, staffId))).toHaveLength(rowsBefore.length);

    const nonPdfSpy = mockStoredPdf({ contentType: "text/plain", size: "100" });
    const nonPdf = await request(app)
      .post("/api/unmatched-pos/batches")
      .set("Cookie", staffCookie)
      .send({ files: [{ posPdfUrl: `/objects/uploads/${staffId}/${randomUUID()}`, sourceFileName: "not-pdf.pdf" }] });
    expect(nonPdf.status).toBe(400);
    nonPdfSpy.mockRestore();

    const missingSpy = vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile")
      .mockRejectedValue(new Error("Object not found"));
    const missing = await request(app)
      .post("/api/unmatched-pos/batches")
      .set("Cookie", staffCookie)
      .send({ files: [{ posPdfUrl: `/objects/uploads/${staffId}/${randomUUID()}`, sourceFileName: "missing.pdf" }] });
    expect(missing.status).toBe(400);
    missingSpy.mockRestore();

    const oversizedSpy = mockStoredPdf({ contentType: "application/pdf", size: String(10 * 1024 * 1024 + 1) });
    const oversized = await request(app)
      .post("/api/unmatched-pos/batches")
      .set("Cookie", staffCookie)
      .send({ files: [{ posPdfUrl: `/objects/uploads/${staffId}/${randomUUID()}`, sourceFileName: "large.pdf" }] });
    expect(oversized.status).toBe(400);
    oversizedSpy.mockRestore();
  });

  it("keeps failed parse items in the pending review queue", async () => {
    const [failed] = await db.insert(unmatchedPosDocumentsTable).values({
      posPdfUrl: `/objects/uploads/${nonce}-failed.pdf`,
      sourceFileName: `${nonce}-failed.pdf`,
      parseStatus: "failed",
      parseError: "Could not extract fields",
      createdBy: staffId,
    }).returning();
    queueIds.push(failed.id);

    const response = await request(app)
      .get(`/api/unmatched-pos/${failed.id}`)
      .set("Cookie", staffCookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: failed.id,
      parseStatus: "failed",
      parseError: "Could not extract fields",
      reviewStatus: "pending",
    });
  });

  it("blocks review transitions while a batch item is still queued", async () => {
    const [queued] = await db.insert(unmatchedPosDocumentsTable).values({
      posPdfUrl: `/objects/uploads/${nonce}-still-queued.pdf`,
      sourceFileName: `${nonce}-still-queued.pdf`,
      parseStatus: "queued",
      createdBy: staffId,
    }).returning();
    queueIds.push(queued.id);
    const workerClaim = await pool.connect();
    await workerClaim.query(
      "SELECT pg_advisory_lock($1::int, hashtext($2::text))",
      [POS_ITEM_LOCK_NAMESPACE, queued.id],
    );

    try {
      const invalidNumbers = await request(app)
        .post(`/api/unmatched-pos/${queued.id}/review`)
        .set("Cookie", staffCookie)
        .send({
          action: "confirm",
          clientId: queueClientId,
          fields: {
            serviceCode: "459",
            servicePeriodStart: "2026-02-30",
            servicePeriodEnd: "2026-06-30",
            maxPeriodAmount: "-1.00",
          },
        });
      expect(invalidNumbers.status).toBe(400);

      const review = await request(app)
        .post(`/api/unmatched-pos/${queued.id}/review`)
        .set("Cookie", staffCookie)
        .send({
          action: "confirm",
          clientId: queueClientId,
          fields: {
            authNumber: `${nonce}-QUEUED-GUARD`,
            serviceCode: "459",
            servicePeriodStart: "2026-06-01",
            servicePeriodEnd: "2026-06-30",
            maxPeriodAmount: "100.00",
          },
        });
      expect(review.status).toBe(409);
      const legacyComplete = await request(app)
        .post(`/api/unmatched-pos/${queued.id}/complete`)
        .set("Cookie", staffCookie)
        .send({ clientId: queueClientId });
      expect(legacyComplete.status).toBe(409);
      const [stillQueued] = await db.select().from(unmatchedPosDocumentsTable)
        .where(eq(unmatchedPosDocumentsTable.id, queued.id));
      expect(stillQueued).toMatchObject({ parseStatus: "queued", reviewStatus: "pending" });
    } finally {
      await workerClaim.query(
        "SELECT pg_advisory_unlock($1::int, hashtext($2::text))",
        [POS_ITEM_LOCK_NAMESPACE, queued.id],
      );
      workerClaim.release();
    }
  });

  it("recovers persisted queued rows through the worker after startup", async () => {
    const objectId = randomUUID();
    const [queued] = await db.insert(unmatchedPosDocumentsTable).values({
      posPdfUrl: `/objects/uploads/${staffId}/${objectId}`,
      sourceFileName: `${nonce}-recover.pdf`,
      parseStatus: "queued",
      createdBy: staffId,
    }).returning();
    queueIds.push(queued.id);
    const pdfSpy = mockStoredPdf();
    vi.mocked(parsePosPdf).mockResolvedValue({
      clientName: "Correct Participant",
      uciNumber: `${nonce}-UCI-123`,
      authNumber: `${nonce}-RECOVERED`,
      serviceCode: "459",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      units: 12,
      monthlyAmount: "20.00",
      maxPeriodAmount: "240.00",
    });
    const { recoverQueuedPosBatches } = await import("../lib/posBatchWorker");
    recoverQueuedPosBatches();
    const [parsed] = await waitForParseStatus([queued.id], "parsed");
    expect(parsed).toMatchObject({ suggestedClientId: uciClientId, suggestionMethod: "uci" });
    pdfSpy.mockRestore();
  });

  it("requires a discard reason and persists discard without creating an authorization", async () => {
    const [queued] = await db.insert(unmatchedPosDocumentsTable).values({
      posPdfUrl: `/objects/uploads/${nonce}-discard.pdf`,
      sourceFileName: `${nonce}-discard.pdf`,
      createdBy: staffId,
    }).returning();
    queueIds.push(queued.id);

    const invalid = await request(app)
      .post(`/api/unmatched-pos/${queued.id}/review`)
      .set("Cookie", staffCookie)
      .send({ action: "discard" });
    expect(invalid.status).toBe(400);

    const response = await request(app)
      .post(`/api/unmatched-pos/${queued.id}/review`)
      .set("Cookie", staffCookie)
      .send({ action: "discard", reason: "Duplicate POS" });
    expect(response.status).toBe(200);
    expect(response.body.reviewStatus).toBe("discarded");
    const [stored] = await db.select().from(unmatchedPosDocumentsTable)
      .where(eq(unmatchedPosDocumentsTable.id, queued.id));
    expect(stored).toMatchObject({ reviewStatus: "discarded", discardReason: "Duplicate POS" });
    expect(stored.resultingAuthorizationId).toBeNull();
  });

  it("confirms a review item exactly once and persists its resulting authorization", async () => {
    const [queued] = await db.insert(unmatchedPosDocumentsTable).values({
      posPdfUrl: `/objects/uploads/${nonce}-review-confirm.pdf`,
      sourceFileName: `${nonce}-review-confirm.pdf`,
      authNumber: `${nonce}-POS-REVIEW-CONFIRM`,
      parseStatus: "failed",
      servicePeriodStart: "2026-05-01",
      servicePeriodEnd: "2026-05-31",
      maxPeriodAmount: "275.00",
      createdBy: staffId,
    }).returning();
    queueIds.push(queued.id);

    const response = await request(app)
      .post(`/api/unmatched-pos/${queued.id}/review`)
      .set("Cookie", staffCookie)
      .send({
        action: "confirm",
        clientId: queueClientId,
        fields: {
          serviceCode: "459",
          unitAmount: "",
          servicePeriodStart: "2026-05-01",
          servicePeriodEnd: "2026-05-31",
          maxPeriodAmount: "275.00",
        },
      });
    expect(response.status).toBe(200);
    expect(response.body.reviewStatus).toBe("confirmed");
    const authId = response.body.resultingAuthorizationId;
    authIds.push(authId);
    const [stored] = await db.select().from(unmatchedPosDocumentsTable)
      .where(eq(unmatchedPosDocumentsTable.id, queued.id));
    expect(stored).toMatchObject({
      reviewStatus: "confirmed",
      reviewedBy: staffId,
      resultingAuthorizationId: authId,
    });

    const repeated = await request(app)
      .post(`/api/unmatched-pos/${queued.id}/review`)
      .set("Cookie", staffCookie)
      .send({ action: "confirm", clientId: queueClientId });
    expect(repeated.status).toBe(409);
  });

  it("amends the suggested authorization and retains an authorization version", async () => {
    const [authorization] = await db.insert(authorizationsTable).values({
      clientId: queueClientId,
      authNumber: `${nonce}-POS-AMEND`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-05-01",
      servicePeriodEnd: "2026-05-31",
      maxPeriodAmount: "200.00",
      status: "active",
    }).returning();
    authIds.push(authorization.id);
    const [queued] = await db.insert(unmatchedPosDocumentsTable).values({
      posPdfUrl: `/objects/uploads/${nonce}-amend.pdf`,
      sourceFileName: `${nonce}-amend.pdf`,
      authNumber: authorization.authNumber,
      suggestedClientId: queueClientId,
      suggestionMethod: "uci",
      suggestedAt: new Date(),
      suggestedAuthorizationId: authorization.id,
      createdBy: staffId,
    }).returning();
    queueIds.push(queued.id);

    const response = await request(app)
      .post(`/api/unmatched-pos/${queued.id}/review`)
      .set("Cookie", staffCookie)
      .send({
        action: "amend",
        clientId: queueClientId,
        paymentType: "reimbursement",
        fields: {
          authNumber: `${nonce}-POS-AMENDED`,
          servicePeriodEnd: "2026-06-30",
          monthlyAmount: "100.00",
          maxPeriodAmount: "200.00",
        },
      });
    expect(response.status).toBe(200);
    expect(response.body.resultingAuthorizationId).toBe(authorization.id);
    const [updated] = await db.select().from(authorizationsTable)
      .where(eq(authorizationsTable.id, authorization.id));
    expect(updated.servicePeriodEnd).toBe("2026-06-30");
    expect(updated.authNumber).toBe(`${nonce}-POS-AMENDED`);
    expect(updated.paymentType).toBe("reimbursement");
    expect(await db.select().from(authorizationVersionsTable)
      .where(eq(authorizationVersionsTable.authorizationId, authorization.id))).toHaveLength(1);
  });

  it("rejects amendment fields that are not supported instead of silently ignoring them", async () => {
    const [authorization] = await db.insert(authorizationsTable).values({
      clientId: queueClientId,
      authNumber: `${nonce}-POS-UNSUPPORTED`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-05-01",
      servicePeriodEnd: "2026-05-31",
      maxPeriodAmount: "200.00",
      status: "active",
    }).returning();
    authIds.push(authorization.id);
    const [queued] = await db.insert(unmatchedPosDocumentsTable).values({
      posPdfUrl: `/objects/uploads/${nonce}-unsupported-amend.pdf`,
      sourceFileName: `${nonce}-unsupported-amend.pdf`,
      authNumber: authorization.authNumber,
      suggestedClientId: queueClientId,
      suggestionMethod: "uci",
      suggestedAt: new Date(),
      suggestedAuthorizationId: authorization.id,
      createdBy: staffId,
    }).returning();
    queueIds.push(queued.id);

    const response = await request(app)
      .post(`/api/unmatched-pos/${queued.id}/review`)
      .set("Cookie", staffCookie)
      .send({
        action: "amend",
        clientId: queueClientId,
        fields: { serviceCode: "024", maxPeriodAmount: "200.00" },
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("serviceCode cannot be changed");
    const [stillPending] = await db.select().from(unmatchedPosDocumentsTable)
      .where(eq(unmatchedPosDocumentsTable.id, queued.id));
    expect(stillPending.reviewStatus).toBe("pending");
  });

  it("cancels the matched authorization and audits the staff reviewer", async () => {
    const [authorization] = await db.insert(authorizationsTable).values({
      clientId: queueClientId,
      authNumber: `${nonce}-POS-CANCEL`,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-05-01",
      servicePeriodEnd: "2026-05-31",
      maxPeriodAmount: "200.00",
      status: "active",
    }).returning();
    authIds.push(authorization.id);
    const [queued] = await db.insert(unmatchedPosDocumentsTable).values({
      posPdfUrl: `/objects/uploads/${nonce}-cancel.pdf`,
      sourceFileName: `${nonce}-cancel.pdf`,
      authNumber: authorization.authNumber,
      suggestedClientId: queueClientId,
      suggestionMethod: "uci",
      suggestedAt: new Date(),
      suggestedAuthorizationId: authorization.id,
      createdBy: staffId,
    }).returning();
    queueIds.push(queued.id);

    const response = await request(app)
      .post(`/api/unmatched-pos/${queued.id}/review`)
      .set("Cookie", staffCookie)
      .send({ action: "cancel", reason: "POS was superseded", clientId: queueClientId });
    expect(response.status).toBe(200);
    const [canceled] = await db.select().from(authorizationsTable)
      .where(eq(authorizationsTable.id, authorization.id));
    expect(canceled.status).toBe("canceled");
    const [auditEntry] = await db.select().from(auditLogTable)
      .where(and(eq(auditLogTable.action, "cancel_unmatched_pos"), eq(auditLogTable.entityId, queued.id)));
    expect(auditEntry).toMatchObject({ userId: staffId, detail: expect.stringContaining("POS was superseded") });
  });

  it("creates the authorization from stored fields and retains the confirmed review row", async () => {
    const [queued] = await db.insert(unmatchedPosDocumentsTable).values({
      posPdfUrl: `/objects/uploads/${nonce}-complete.pdf`,
      sourceFileName: `${nonce}-complete.pdf`,
      clientName: "Queue Participant",
      uciNumber: `${nonce}-uci-queue`,
      authNumber: `${nonce}-POS-COMPLETE`,
      serviceCode: "024",
      activityDescription: "Respite",
      servicePeriodStart: "2026-05-01",
      servicePeriodEnd: "2026-05-31",
      units: 1,
      monthlyAmount: "200.00",
      maxPeriodAmount: "200.00",
      caseworkerName: "Queue Worker",
      posNotes: "queued note",
      createdBy: staffId,
    }).returning();
    queueIds.push(queued.id);

    const response = await request(app)
      .post(`/api/unmatched-pos/${queued.id}/complete`)
      .set("Cookie", staffCookie)
      .send({ clientId: queueClientId, acceptMaxAmountWarning: true });

    expect(response.status).toBe(201);
    expect(response.body.saved).toBe(true);
    const auth = response.body.authorization;
    authIds.push(auth.id);
    expect(auth).toMatchObject({
      clientId: queueClientId,
      authNumber: `${nonce}-POS-COMPLETE`,
      serviceCode: "024",
      paymentType: "reimbursement",
      activityDescription: "Respite",
      servicePeriodStart: "2026-05-01",
      servicePeriodEnd: "2026-05-31",
      monthlyAmount: "200.00",
      maxPeriodAmount: "200.00",
      units: 1,
      posPdfUrl: `/objects/uploads/${nonce}-complete.pdf`,
      posNotes: "queued note",
    });
    const [retained] = await db.select().from(unmatchedPosDocumentsTable)
      .where(eq(unmatchedPosDocumentsTable.id, queued.id));
    expect(retained).toMatchObject({
      reviewStatus: "confirmed",
      reviewedBy: staffId,
      resultingAuthorizationId: auth.id,
    });
    const [storedAuth] = await db.select().from(authorizationsTable)
      .where(and(eq(authorizationsTable.id, auth.id), eq(authorizationsTable.clientId, queueClientId)));
    expect(storedAuth.posPdfUrl).toBe(`/objects/uploads/${nonce}-complete.pdf`);
    expect(storedAuth.posNotes).toBe("queued note");
  });
});