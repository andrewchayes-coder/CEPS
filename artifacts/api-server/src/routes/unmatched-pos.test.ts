import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  authorizationsTable,
  auditLogTable,
  clientsTable,
  db,
  sessionsTable,
  unmatchedPosDocumentsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

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

  it("creates the authorization from stored fields and removes the queue row", async () => {
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
    });
    const [removed] = await db.select().from(unmatchedPosDocumentsTable)
      .where(eq(unmatchedPosDocumentsTable.id, queued.id));
    expect(removed).toBeUndefined();
    const [storedAuth] = await db.select().from(authorizationsTable)
      .where(and(eq(authorizationsTable.id, auth.id), eq(authorizationsTable.clientId, queueClientId)));
    expect(storedAuth.posPdfUrl).toBe(`/objects/uploads/${nonce}-complete.pdf`);
  });
});