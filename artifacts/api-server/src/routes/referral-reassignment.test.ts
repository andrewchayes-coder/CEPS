import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { inArray } from "drizzle-orm";
import {
  db,
  auditLogTable,
  clientsTable,
  referralsTable,
  sessionsTable,
  staffRolesTable,
  staffRolePermissionsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `refassign${Date.now().toString(36)}`;
let staffId: string;
let nonManagerStaffId: string;
let ownerId: string;
let activeCoordinatorId: string;
let inactiveCoordinatorId: string;
let nonCoordinatorId: string;
let clientId: string;
let referralId: string;
let managerRoleId: string;
let nonManagerRoleId: string;
let staffCookie: string;
let nonManagerStaffCookie: string;
let ownerCookie: string;
let otherCoordinatorCookie: string;

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({ userId, token, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  return `ceps_session=${token}`;
}

beforeAll(async () => {
  const [managerRole] = await db.insert(staffRolesTable).values({
    name: `${nonce}-manager`,
  }).returning();
  managerRoleId = managerRole.id;
  const [nonManagerRole] = await db.insert(staffRolesTable).values({
    name: `${nonce}-non-manager`,
  }).returning();
  nonManagerRoleId = nonManagerRole.id;
  await db.insert(staffRolePermissionsTable).values({
    roleId: managerRoleId,
    permission: "manage_users",
  });
  const users = await db.insert(usersTable).values([
    { name: "Assignment Staff", email: `${nonce}-staff@test.local`, role: "staff", staffRoleId: managerRoleId },
    { name: "Non Manager Staff", email: `${nonce}-non-manager@test.local`, role: "staff", staffRoleId: nonManagerRoleId },
    { name: "Owner Coordinator", email: `${nonce}-owner@test.local`, role: "service_coordinator" },
    { name: "Active Coordinator", email: `${nonce}-active@test.local`, role: "service_coordinator" },
    { name: "Inactive Coordinator", email: `${nonce}-inactive@test.local`, role: "service_coordinator", active: false },
    { name: "Not Coordinator", email: `${nonce}-vendor@test.local`, role: "vendor" },
  ]).returning();
  [staffId, nonManagerStaffId, ownerId, activeCoordinatorId, inactiveCoordinatorId, nonCoordinatorId] = users.map((user) => user.id);
  const [client] = await db.insert(clientsTable).values({
    firstName: "Referral",
    lastName: "Assignment",
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-uci`,
    isMinor: true,
  }).returning();
  clientId = client.id;
  const [referral] = await db.insert(referralsTable).values({
    clientId,
    serviceCoordinatorId: ownerId,
    referralDate: "2026-09-04",
    status: "intake",
    intakeFields: {},
    parentEmail: `${nonce}-parent@test.local`,
  }).returning();
  referralId = referral.id;
  staffCookie = await session(staffId);
  nonManagerStaffCookie = await session(nonManagerStaffId);
  ownerCookie = await session(ownerId);
  otherCoordinatorCookie = await session(activeCoordinatorId);
});

afterAll(async () => {
  await db.delete(referralsTable).where(inArray(referralsTable.id, [referralId]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientId]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, nonManagerStaffId, ownerId, activeCoordinatorId]));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [staffId, nonManagerStaffId, ownerId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, nonManagerStaffId, ownerId, activeCoordinatorId, inactiveCoordinatorId, nonCoordinatorId]));
  await db.delete(staffRolePermissionsTable).where(inArray(staffRolePermissionsTable.roleId, [managerRoleId, nonManagerRoleId]));
  await db.delete(staffRolesTable).where(inArray(staffRolesTable.id, [managerRoleId, nonManagerRoleId]));
});

describe("referral coordinator reassignment", () => {
  it("lists only active service coordinators when requested", async () => {
    const response = await request(app)
      .get("/api/users")
      .query({ role: "service_coordinator", active: "true" })
      .set("Cookie", staffCookie);
    expect(response.status).toBe(200);
    expect(response.body.map((user: { id: string }) => user.id)).toEqual(expect.arrayContaining([ownerId, activeCoordinatorId]));
    expect(response.body.map((user: { id: string }) => user.id)).not.toContain(inactiveCoordinatorId);
  });

  it("allows non-manager staff to use the minimal directory while keeping /users forbidden", async () => {
    const directory = await request(app)
      .get("/api/user-directory")
      .query({ role: "service_coordinator", active: "true" })
      .set("Cookie", nonManagerStaffCookie);
    expect(directory.status).toBe(200);
    expect(directory.body.map((entry: { id: string }) => entry.id)).toEqual(expect.arrayContaining([ownerId, activeCoordinatorId]));
    expect(directory.body.map((entry: { id: string }) => entry.id)).not.toContain(inactiveCoordinatorId);
    for (const entry of directory.body) {
      expect(Object.keys(entry).sort()).toEqual(["active", "id", "name", "role"]);
    }

    const users = await request(app)
      .get("/api/users")
      .set("Cookie", nonManagerStaffCookie);
    expect(users.status).toBe(403);
  });

  it("denies the user directory to non-staff users", async () => {
    for (const cookie of [ownerCookie, otherCoordinatorCookie]) {
      const response = await request(app)
        .get("/api/user-directory")
        .set("Cookie", cookie);
      expect(response.status).toBe(403);
    }
  });

  it("allows staff to assign an active coordinator and clear the assignment", async () => {
    const assigned = await request(app)
      .patch(`/api/referrals/${referralId}`)
      .set("Cookie", staffCookie)
      .send({ serviceCoordinatorId: activeCoordinatorId });
    expect(assigned.status).toBe(200);
    expect(assigned.body.serviceCoordinatorId).toBe(activeCoordinatorId);
    expect(assigned.body.coordinatorName).toBe("Active Coordinator");

    const cleared = await request(app)
      .patch(`/api/referrals/${referralId}`)
      .set("Cookie", staffCookie)
      .send({ serviceCoordinatorId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.serviceCoordinatorId).toBeNull();
  });

  it("rejects inactive coordinators and users with another role", async () => {
    for (const serviceCoordinatorId of [inactiveCoordinatorId, nonCoordinatorId]) {
      const response = await request(app)
        .patch(`/api/referrals/${referralId}`)
        .set("Cookie", staffCookie)
        .send({ serviceCoordinatorId });
      expect(response.status).toBe(400);
    }
  });

  it("lets the owning coordinator edit supported fields but not reassign", async () => {
    await request(app)
      .patch(`/api/referrals/${referralId}`)
      .set("Cookie", staffCookie)
      .send({ serviceCoordinatorId: ownerId });

    const notes = await request(app)
      .patch(`/api/referrals/${referralId}`)
      .set("Cookie", ownerCookie)
      .send({ notes: "Coordinator note" });
    expect(notes.status).toBe(200);

    const reassignment = await request(app)
      .patch(`/api/referrals/${referralId}`)
      .set("Cookie", ownerCookie)
      .send({ serviceCoordinatorId: activeCoordinatorId });
    expect(reassignment.status).toBe(403);
  });

  it("prevents another coordinator from viewing or sending a signature link for the referral", async () => {
    const ownerDetail = await request(app)
      .get(`/api/referrals/${referralId}`)
      .set("Cookie", ownerCookie);
    expect(ownerDetail.status).toBe(200);
    expect(ownerDetail.body.clientIsMinor).toBe(true);

    const detail = await request(app)
      .get(`/api/referrals/${referralId}`)
      .set("Cookie", otherCoordinatorCookie);
    expect(detail.status).toBe(403);

    const signatureLink = await request(app)
      .post(`/api/referrals/${referralId}/send-intake`)
      .set("Cookie", otherCoordinatorCookie)
      .send({ recipient: "family_rep" });
    expect(signatureLink.status).toBe(403);
  });
});