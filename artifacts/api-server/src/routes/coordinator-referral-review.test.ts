import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  clientsTable,
  db,
  familyRepresentativesTable,
  magicLinksTable,
  referralsTable,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `coordreview${Date.now().toString(36)}`;
let staffId: string;
let staffCookie: string;
let coordinatorId: string;
let coordinatorCookie: string;
let otherCoordinatorId: string;
const clientIds: string[] = [];
const referralIds: string[] = [];

async function makeSession(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

async function makeHeldReferral(label: string) {
  const [client] = await db.insert(clientsTable).values({
    firstName: "Review",
    lastName: label,
    dateOfBirth: "1990-01-01",
    uciNumber: `${nonce}-${label}`,
    isMinor: false,
    preferredLanguage: "English",
    phone: "old-phone",
    email: "old@example.test",
    address: "Old address",
    assignedCoordinatorId: otherCoordinatorId,
  }).returning();
  clientIds.push(client.id);
  const [referral] = await db.insert(referralsTable).values({
    clientId: client.id,
    serviceCoordinatorId: null,
    submittedByUserId: coordinatorId,
    coordinatorReviewStatus: "pending",
    status: "intake",
    referralDate: "2026-01-01",
    intakeSentTo: "participant",
    intakeFields: {
      clientFirstName: "Review",
      clientLastName: label,
      clientUci: `${nonce}-${label}`,
      contactPhone: "new-phone",
      contactEmail: "new@example.test",
      contactStreet: "1 New Street",
      contactCity: "Sacramento",
      contactState: "CA",
      contactZip: "95814",
      preferredLanguage: "Spanish",
      clientIsMinor: false,
      familyRepName: "New Guardian",
      familyRepRelationship: "guardian",
      familyRepPhone: "rep-phone",
      familyRepEmail: "rep@example.test",
      familyRepAddress: "2 Rep Street",
    },
  }).returning();
  referralIds.push(referral.id);
  return { client, referral };
}

function reviewBody(
  decision: "approve" | "reject",
  overrides: Partial<{
    applyPhone: boolean;
    applyEmail: boolean;
    applyAddress: boolean;
    applyPreferredLanguage: boolean;
    applyMinorStatus: boolean;
    applyFamilyRepresentative: boolean;
    reassignAsAssignedCoordinator: boolean;
    note: string;
  }> = {},
) {
  return {
    decision,
    applyPhone: false,
    applyEmail: false,
    applyAddress: false,
    applyPreferredLanguage: false,
    applyMinorStatus: false,
    applyFamilyRepresentative: false,
    reassignAsAssignedCoordinator: false,
    ...overrides,
  };
}

beforeAll(async () => {
  const [staff] = await db.insert(usersTable).values({
    name: `${nonce} Staff`,
    email: `${nonce}-staff@test.local`,
    role: "staff",
  }).returning();
  staffId = staff.id;
  staffCookie = await makeSession(staffId);
  const [coordinator] = await db.insert(usersTable).values({
    name: `${nonce} Submitter`,
    email: `${nonce}-coordinator@test.local`,
    role: "service_coordinator",
  }).returning();
  coordinatorId = coordinator.id;
  coordinatorCookie = await makeSession(coordinatorId);
  const [otherCoordinator] = await db.insert(usersTable).values({
    name: `${nonce} Assigned`,
    email: `${nonce}-assigned@test.local`,
    role: "service_coordinator",
  }).returning();
  otherCoordinatorId = otherCoordinator.id;
});

afterAll(async () => {
  if (referralIds.length) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.entityId, referralIds));
    await db.delete(magicLinksTable).where(inArray(magicLinksTable.referralId, referralIds));
    await db.delete(referralsTable).where(inArray(referralsTable.id, referralIds));
  }
  if (clientIds.length) {
    await db.delete(auditLogTable).where(and(
      eq(auditLogTable.entityType, "client"),
      inArray(auditLogTable.entityId, clientIds),
    ));
    await db.delete(familyRepresentativesTable).where(inArray(familyRepresentativesTable.clientId, clientIds));
    await db.delete(clientsTable).where(inArray(clientsTable.id, clientIds));
  }
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, coordinatorId, otherCoordinatorId]));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [staffId, coordinatorId, otherCoordinatorId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, coordinatorId, otherCoordinatorId]));
});

describe("staff coordinator referral review", () => {
  it("returns comparison data only to staff and approves only selected updates atomically", async () => {
    const dashboardBefore = await request(app).get("/api/dashboard/summary").set("Cookie", staffCookie);
    const { client, referral } = await makeHeldReferral("approve");
    const dashboardAfter = await request(app).get("/api/dashboard/summary").set("Cookie", staffCookie);
    expect(dashboardAfter.body.totals.pendingCoordinatorReview).toBe(dashboardBefore.body.totals.pendingCoordinatorReview + 1);
    expect(dashboardAfter.body.alerts).toContainEqual(expect.objectContaining({
      kind: "coordinator_review",
      message: expect.stringContaining("awaiting coordinator review"),
    }));
    expect((await request(app).get("/api/referrals").query({
      coordinatorReviewStatus: "pending",
      clientId: client.id,
    }).set("Cookie", staffCookie)).body.total).toBe(1);
    expect((await request(app).get("/api/referrals").query({
      coordinatorReviewStatus: "pending",
      clientId: client.id,
    }).set("Cookie", coordinatorCookie)).body.total).toBe(0);
    const unauthorized = await request(app).get(`/api/referrals/${referral.id}/coordinator-review`).set("Cookie", coordinatorCookie);
    expect(unauthorized.status).toBe(403);
    expect((await request(app).get(`/api/referrals/${referral.id}/coordinator-review`).set("Cookie", staffCookie)).body).toMatchObject({
      submittedByName: `${nonce} Submitter`,
      intake: { phone: "new-phone", preferredLanguage: "Spanish", isMinor: false },
      current: { phone: "old-phone", preferredLanguage: "English", isMinor: false },
    });

    const response = await request(app)
      .post(`/api/referrals/${referral.id}/coordinator-review`)
      .set("Cookie", staffCookie)
      .send(reviewBody("approve", {
        applyPhone: true,
        applyPreferredLanguage: true,
        applyFamilyRepresentative: true,
        reassignAsAssignedCoordinator: true,
      }));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "approved" });
    const [updatedClient] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(updatedClient).toMatchObject({
      phone: "new-phone",
      email: "old@example.test",
      address: "Old address",
      preferredLanguage: "Spanish",
      assignedCoordinatorId: coordinatorId,
    });
    expect(await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId, client.id))).toMatchObject([
      { name: "New Guardian", relationship: "guardian", phone: "rep-phone", email: "rep@example.test", address: "2 Rep Street" },
    ]);
    const [updatedReferral] = await db.select().from(referralsTable).where(eq(referralsTable.id, referral.id));
    expect(updatedReferral).toMatchObject({
      serviceCoordinatorId: coordinatorId,
      coordinatorReviewStatus: "approved",
      coordinatorReviewedBy: staffId,
      status: "intake",
    });
    expect((await request(app).get(`/api/referrals/${referral.id}`).set("Cookie", coordinatorCookie)).status).toBe(200);
  });

  it("requires a rejection note, blocks intake/signature access while pending, and rejects without changing the participant", async () => {
    const { client, referral } = await makeHeldReferral("reject");
    const [link] = await db.insert(magicLinksTable).values({
      token: newToken(),
      email: "old@example.test",
      purpose: "signature",
      referralId: referral.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }).returning();

    const noNote = await request(app)
      .post(`/api/referrals/${referral.id}/coordinator-review`)
      .set("Cookie", staffCookie)
      .send(reviewBody("reject"));
    expect(noNote.status).toBe(400);
    const sendIntake = await request(app)
      .post(`/api/referrals/${referral.id}/send-intake`)
      .set("Cookie", staffCookie)
      .send({ recipient: "participant" });
    expect(sendIntake.status).toBe(409);
    expect(sendIntake.body.error).toContain("awaiting CEPS review");
    expect((await request(app).get(`/api/signature/${link.token}`)).status).toBe(404);
    expect((await request(app).post(`/api/signature/${link.token}`).send({
      typedName: "Signer",
      agreed: true,
      signerRelationship: "self",
    })).status).toBe(404);

    const rejected = await request(app)
      .post(`/api/referrals/${referral.id}/coordinator-review`)
      .set("Cookie", staffCookie)
      .send(reviewBody("reject", { note: "Not assigned to this participant." }));
    expect(rejected.status).toBe(200);
    expect(rejected.body).toEqual({ status: "rejected" });
    const [unchangedClient] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(unchangedClient).toMatchObject({
      phone: "old-phone",
      email: "old@example.test",
      address: "Old address",
      preferredLanguage: "English",
      assignedCoordinatorId: otherCoordinatorId,
    });
    expect(await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId, client.id))).toHaveLength(0);
    const [closedReferral] = await db.select().from(referralsTable).where(eq(referralsTable.id, referral.id));
    expect(closedReferral).toMatchObject({
      status: "closed",
      coordinatorReviewStatus: "rejected",
      coordinatorReviewNote: "Not assigned to this participant.",
    });
    expect((await request(app).post(`/api/referrals/${referral.id}/send-intake`)
      .set("Cookie", staffCookie).send({ recipient: "participant" })).status).toBe(409);
    expect((await request(app).patch(`/api/referrals/${referral.id}`)
      .set("Cookie", staffCookie).send({ status: "active" })).status).toBe(409);
  });

  it("applies an adult-to-minor change only when staff selects minor status", async () => {
    const { client, referral } = await makeHeldReferral("minor");
    await db.update(referralsTable).set({
      intakeFields: {
        clientIsMinor: true,
        preferredLanguage: "Spanish",
        contactPhone: "family-phone",
        familyRepName: "Family Contact",
      },
    }).where(eq(referralsTable.id, referral.id));
    const response = await request(app)
      .post(`/api/referrals/${referral.id}/coordinator-review`)
      .set("Cookie", staffCookie)
      .send(reviewBody("approve", { applyMinorStatus: true }));
    expect(response.status).toBe(200);
    const [updated] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(updated.isMinor).toBe(true);
    expect(updated.phone).toBe("old-phone");
    expect(updated.preferredLanguage).toBe("English");
    expect(await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId, client.id))).toHaveLength(0);
  });

  it("allows only one of two concurrent approval attempts to win", async () => {
    const { referral } = await makeHeldReferral("race");
    const submit = () => request(app)
      .post(`/api/referrals/${referral.id}/coordinator-review`)
      .set("Cookie", staffCookie)
      .send(reviewBody("approve"));
    const [first, second] = await Promise.all([submit(), submit()]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const [stored] = await db.select().from(referralsTable).where(eq(referralsTable.id, referral.id));
    expect(stored.coordinatorReviewStatus).toBe("approved");
  });
});