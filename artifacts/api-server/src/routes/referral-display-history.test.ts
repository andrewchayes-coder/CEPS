import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, sessionsTable, clientsTable, vendorsTable, referralsTable, auditLogTable,
  staffRolesTable, staffRolePermissionsTable, STAFF_PERMISSIONS } from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `ref-display-${randomUUID()}`;
let staffId: string, oldId: string, newId: string, roleId: string, clientId: string, vendorId: string;
let staffCookie: string, oldCookie: string, newCookie: string;
let staffReferralId: string, coordinatorReferralId: string;
const staffName = `${nonce} Staff`;
const oldName = `${nonce} Original Coordinator`;
const newName = `${nonce} New Coordinator`;
const linkedVendor = `${nonce} Zulu Vendor`;
const enteredVendor = `${nonce} Alpha Vendor`;
async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({ userId, token, expiresAt: new Date(Date.now() + 3600000) });
  return `ceps_session=${token}`;
}
beforeAll(async () => {
  const [role] = await db.insert(staffRolesTable).values({ name: nonce }).returning();
  roleId = role.id;
  await db.insert(staffRolePermissionsTable).values(STAFF_PERMISSIONS.map(permission => ({ roleId, permission })));
  const people = await db.insert(usersTable).values([
    { name: staffName, email: `${nonce}-staff@test.local`, role: "staff", staffRoleId: roleId },
    { name: oldName, email: `${nonce}-old@test.local`, role: "service_coordinator" },
    { name: newName, email: `${nonce}-new@test.local`, role: "service_coordinator" },
  ]).returning();
  [staffId, oldId, newId] = people.map(person => person.id);
  [staffCookie, oldCookie, newCookie] = await Promise.all([session(staffId), session(oldId), session(newId)]);
  const [client] = await db.insert(clientsTable).values({
    firstName: nonce, lastName: "Participant", dateOfBirth: "2000-01-01", uciNumber: nonce, assignedCoordinatorId: oldId,
  }).returning();
  clientId = client.id;
  const [vendor] = await db.insert(vendorsTable).values({ name: linkedVendor }).returning();
  vendorId = vendor.id;
  const rows = await db.insert(referralsTable).values([
    { clientId, vendorId, serviceCoordinatorId: oldId, referralDate: "2026-01-01", status: "intake",
      submittedByUserId: staffId, intakeFields: { vendorName: "Ignored form vendor" } },
    { clientId, serviceCoordinatorId: oldId, referralDate: "2026-01-02", status: "intake",
      submittedByUserId: oldId, intakeFields: { vendorName: enteredVendor } },
  ]).returning();
  [staffReferralId, coordinatorReferralId] = rows.map(row => row.id);
  await db.insert(auditLogTable).values([
    { userId: staffId, action: "create_referral", entityType: "referral", entityId: staffReferralId,
      detail: "Original submission", createdAt: new Date("2026-01-01T00:00:00Z") },
    { userId: staffId, action: "unrelated_referral", entityType: "referral", entityId: randomUUID(), detail: nonce },
    { userId: staffId, action: "unrelated_client", entityType: "client", entityId: staffReferralId, detail: nonce },
  ]);
});
afterAll(async () => {
  const people = [staffId, oldId, newId].filter(Boolean);
  if (people.length) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.userId, people));
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, people));
  }
  if (staffReferralId) await db.delete(referralsTable).where(inArray(referralsTable.id, [staffReferralId, coordinatorReferralId]));
  if (clientId) await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  if (vendorId) await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
  if (people.length) await db.delete(usersTable).where(inArray(usersTable.id, people));
  if (roleId) {
    await db.delete(staffRolePermissionsTable).where(eq(staffRolePermissionsTable.roleId, roleId));
    await db.delete(staffRolesTable).where(eq(staffRolesTable.id, roleId));
  }
});

it("returns, sorts and searches linked vendor names and the unlinked form-name fallback", async () => {
  for (const cookie of [staffCookie, oldCookie]) {
    const asc = await request(app).get("/api/referrals").query({ clientId, sortBy: "vendorName", sortDirection: "asc" }).set("Cookie", cookie);
    expect(asc.status).toBe(200);
    expect(asc.body.items.map((row: { vendorName: string }) => row.vendorName)).toEqual([enteredVendor, linkedVendor]);
    const desc = await request(app).get("/api/referrals").query({ clientId, sortBy: "vendorName", sortDirection: "desc" }).set("Cookie", cookie);
    expect(desc.body.items.map((row: { vendorName: string }) => row.vendorName)).toEqual([linkedVendor, enteredVendor]);
    for (const [search, id] of [[linkedVendor, staffReferralId], [enteredVendor, coordinatorReferralId]]) {
      const found = await request(app).get("/api/referrals").query({ clientId, search }).set("Cookie", cookie);
      expect(found.body.items.map((row: { id: string }) => row.id)).toEqual([id]);
    }
    const ignored = await request(app).get("/api/referrals").query({ clientId, search: "Ignored form vendor" }).set("Cookie", cookie);
    expect(ignored.body.items).toEqual([]);
  }
});

it("returns original staff and coordinator submitters separately from the current assignment", async () => {
  for (const [id, submittedByUserId, submittedByName, submittedByRole] of [
    [staffReferralId, staffId, staffName, "staff"], [coordinatorReferralId, oldId, oldName, "service_coordinator"],
  ]) {
    const response = await request(app).get(`/api/referrals/${id}`).set("Cookie", staffCookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ submittedByUserId, submittedByName, submittedByRole, serviceCoordinatorId: oldId });
  }
});

it("records old → new reassignment, preserves the submitter and keeps existing coordinator access rules", async () => {
  const edited = await request(app).patch(`/api/referrals/${staffReferralId}`).set("Cookie", staffCookie)
    .send({ serviceCoordinatorId: newId });
  expect(edited.status).toBe(200);
  expect(edited.body).toMatchObject({ submittedByUserId: staffId, submittedByName: staffName, serviceCoordinatorId: newId });
  const history = await request(app).get(`/api/referrals/${staffReferralId}/history`).set("Cookie", staffCookie);
  expect(history.status).toBe(200);
  expect(history.body).toHaveLength(2);
  expect(history.body[0]).toMatchObject({ userName: staffName, action: "update_referral",
    detail: `Coordinator reassigned: ${oldName} → ${newName}` });
  expect(history.body[1].action).toBe("create_referral");
  expect((await request(app).get(`/api/referrals/${staffReferralId}`).set("Cookie", oldCookie)).status).toBe(403);
  expect((await request(app).get(`/api/referrals/${staffReferralId}`).set("Cookie", newCookie)).status).toBe(200);
  expect((await request(app).get(`/api/referrals/${staffReferralId}/history`).set("Cookie", newCookie)).status).toBe(403);
  const oldList = await request(app).get("/api/referrals").query({ clientId }).set("Cookie", oldCookie);
  expect(oldList.body.items.map((row: { id: string }) => row.id)).not.toContain(staffReferralId);
});

it("records assignment to/from none but not an unchanged assignment", async () => {
  for (const [serviceCoordinatorId, detail] of [
    [null, `Coordinator reassigned: ${newName} → none`], [oldId, `Coordinator reassigned: none → ${oldName}`],
  ]) {
    const response = await request(app).patch(`/api/referrals/${staffReferralId}`).set("Cookie", staffCookie).send({ serviceCoordinatorId });
    expect(response.status).toBe(200);
    const history = await request(app).get(`/api/referrals/${staffReferralId}/history`).set("Cookie", staffCookie);
    expect(history.body[0].detail).toBe(detail);
  }
  await request(app).patch(`/api/referrals/${staffReferralId}`).set("Cookie", staffCookie).send({ serviceCoordinatorId: oldId, notes: "Unchanged assignment" });
  const history = await request(app).get(`/api/referrals/${staffReferralId}/history`).set("Cookie", staffCookie);
  expect(history.body[0].detail ?? "").not.toContain("Coordinator reassigned:");
});

it("does not grant a former coordinator referral access just because they originally submitted it", async () => {
  const response = await request(app).patch(`/api/referrals/${coordinatorReferralId}`).set("Cookie", staffCookie)
    .send({ serviceCoordinatorId: newId });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ submittedByUserId: oldId, submittedByName: oldName, submittedByRole: "service_coordinator" });
  expect((await request(app).get(`/api/referrals/${coordinatorReferralId}`).set("Cookie", oldCookie)).status).toBe(403);
  const accessible = await request(app).get(`/api/referrals/${coordinatorReferralId}`).set("Cookie", newCookie);
  expect(accessible.status).toBe(200);
  expect(accessible.body).toMatchObject({ submittedByName: oldName, coordinatorName: newName });
});
