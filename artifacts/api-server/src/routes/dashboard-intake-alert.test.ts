import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { inArray, eq } from "drizzle-orm";
import {
  clientsTable,
  db,
  referralsTable,
  sessionsTable,
  usersTable,
  auditLogTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `dashintake${Date.now().toString(36)}`;

let staffId: string;
let recentClientId: string;
let oldClientId: string;
let recentReferralId: string;
let oldReferralId: string;
let staffCookie: string;
let familyId: string;
let coordinatorId: string;
let familyCookie: string;
let coordinatorCookie: string;

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({
      name: "Dashboard Intake Staff",
      email: `${nonce}-staff@test.local`,
      role: "staff",
    })
    .returning();
  staffId = staff.id;
  const [family, coordinator] = await db.insert(usersTable).values([
    { name: "Family Actor", email: `${nonce}-family@test.local`, role: "parent_guardian" },
    { name: "Dashboard Coordinator", email: `${nonce}-coord@test.local`, role: "service_coordinator" },
  ]).returning();
  familyId = family.id;
  coordinatorId = coordinator.id;

  const [recentClient, oldClient] = await db
    .insert(clientsTable)
    .values([
      {
        firstName: "Recent",
        lastName: nonce,
        dateOfBirth: "2000-01-01",
        uciNumber: `${nonce}-recent`,
        status: "active",
      },
      {
        firstName: "Old",
        lastName: nonce,
        dateOfBirth: "2000-01-01",
        uciNumber: `${nonce}-old`,
        status: "active",
      },
    ])
    .returning();
  recentClientId = recentClient.id;
  oldClientId = oldClient.id;
  await db.update(usersTable).set({ linkedRecordType: "client", linkedRecordId: recentClientId }).where(eq(usersTable.id, familyId));
  const familyToken = newToken();
  const coordinatorToken = newToken();
  await db.insert(sessionsTable).values([
    { userId: familyId, token: familyToken, expiresAt: new Date(Date.now() + 3600000) },
    { userId: coordinatorId, token: coordinatorToken, expiresAt: new Date(Date.now() + 3600000) },
  ]);
  familyCookie = `ceps_session=${familyToken}`;
  coordinatorCookie = `ceps_session=${coordinatorToken}`;

  const [recentReferral, oldReferral] = await db
    .insert(referralsTable)
    .values([
      {
        clientId: recentClientId,
        referralDate: "2026-01-01",
        status: "pending_auth",
        parentSignedAt: new Date(Date.now() - 2 * 86400000),
        signedByName: "Recent Signer",
        signerRelationship: "self",
      },
      {
        clientId: oldClientId,
        referralDate: "2026-01-01",
        status: "pending_auth",
        parentSignedAt: new Date(Date.now() - 8 * 86400000),
        signedByName: "Old Signer",
        signerRelationship: "self",
      },
    ])
    .returning();
  recentReferralId = recentReferral.id;
  oldReferralId = oldReferral.id;

  const token = newToken();
  await db.insert(sessionsTable).values({
    userId: staffId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  staffCookie = `ceps_session=${token}`;
});

afterAll(async () => {
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [staffId, familyId, coordinatorId]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, familyId, coordinatorId]));
  await db
    .delete(referralsTable)
    .where(inArray(referralsTable.id, [recentReferralId, oldReferralId]));
  await db
    .delete(clientsTable)
    .where(inArray(clientsTable.id, [recentClientId, oldClientId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, familyId, coordinatorId]));
});

describe("GET /dashboard/summary recently completed intake alerts", () => {
  it("includes signatures from the last 7 days and excludes older signatures", async () => {
    const response = await request(app)
      .get("/api/dashboard/summary")
      .set("Cookie", staffCookie);

    expect(response.status).toBe(200);
    const completed = response.body.alerts.filter(
      (alert: { kind: string }) => alert.kind === "recently_completed",
    );
    expect(completed).toContainEqual({
      kind: "recently_completed",
      message: `Recent ${nonce} completed their intake agreement.`,
      entityType: "referral",
      entityId: recentReferralId,
    });
    expect(completed.some((alert: { entityId: string }) => alert.entityId === oldReferralId)).toBe(
      false,
    );
  });

  it("shows exactly one family update alert to staff and coordinator, excluding staff/old edits and family dashboards", async () => {
    const detail = JSON.stringify({ phone: ["old", "new"] });
    await db.insert(auditLogTable).values([
      { userId: familyId, action: "update_client", entityType: "client", entityId: recentClientId, detail },
      { userId: staffId, action: "update_client", entityType: "client", entityId: recentClientId, detail: "staff edit" },
      { userId: familyId, action: "update_client", entityType: "client", entityId: oldClientId, detail, createdAt: new Date(Date.now() - 8 * 86400000) },
    ]);
    for (const cookie of [staffCookie, coordinatorCookie]) {
      const response = await request(app).get("/api/dashboard/summary").set("Cookie", cookie);
      expect(response.status).toBe(200);
      const alerts = response.body.alerts.filter((a: { kind: string; entityId: string }) =>
        a.kind === "family_updated_participant" && a.entityId === recentClientId);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].message).toBe(`Family Actor updated Recent ${nonce}: ${detail}`);
    }
    const familyResponse = await request(app).get("/api/dashboard/summary").set("Cookie", familyCookie);
    expect(familyResponse.body.alerts.some((a: { kind: string }) => a.kind === "family_updated_participant")).toBe(false);
  });
});