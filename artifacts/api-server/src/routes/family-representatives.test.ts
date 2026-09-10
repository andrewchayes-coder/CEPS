import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  familyRepresentativesTable,
  auditLogTable,
  magicLinksTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `fr${Date.now().toString(36)}`;
let staffId: string;
let clientA: string;
let clientB: string;
let staffCookie: string;
let parentCookie: string;
let vendorCookie: string;
let parentId: string;
let coordinatorCookie: string;
let coordinatorId: string;
const repIds: string[] = [];
const userIds: string[] = [];

async function login(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({ userId, token, expiresAt: new Date(Date.now() + 3600000) });
  return `ceps_session=${token}`;
}

async function user(values: Record<string, unknown>) {
  const [row] = await db.insert(usersTable).values(values as never).returning();
  userIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const staff = await user({ name: "FR Staff", email: `${nonce}-staff@test.local`, role: "staff" });
  staffId = staff.id;
  const [a] = await db.insert(clientsTable).values({
    firstName: "Family", lastName: "A", dateOfBirth: "2010-01-01", uciNumber: `${nonce}-a`,
  }).returning();
  const [b] = await db.insert(clientsTable).values({
    firstName: "Family", lastName: "B", dateOfBirth: "2010-01-01", uciNumber: `${nonce}-b`,
  }).returning();
  clientA = a.id; clientB = b.id;
  const parent = await user({
    name: "FR Parent", email: `${nonce}-parent@test.local`, role: "parent_guardian",
    linkedRecordType: "client", linkedRecordId: clientA, active: true,
  });
  parentId = parent.id;
  const vendor = await user({ name: "FR Vendor", email: `${nonce}-vendor@test.local`, role: "vendor", active: true });
  const coordinator = await user({ name: "FR Coordinator", email: `${nonce}-coord@test.local`, role: "service_coordinator", active: true });
  coordinatorId = coordinator.id;
  staffCookie = await login(staffId);
  parentCookie = await login(parentId);
  vendorCookie = await login(vendor.id);
  coordinatorCookie = await login(coordinatorId);
});

afterAll(async () => {
  // Respect all foreign keys: links/referrals, reps, sessions/users, then clients.
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [staffId, coordinatorId, parentId, ...userIds]));
  await db.delete(magicLinksTable).where(inArray(magicLinksTable.familyRepresentativeId, repIds));
  await db.delete(familyRepresentativesTable).where(inArray(familyRepresentativesTable.clientId, [clientA, clientB]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, parentId, coordinatorId, ...userIds]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, coordinatorId, ...userIds]));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientA, clientB]));
});

describe("family representatives API", () => {
  it("creates, lists, gets, and updates representatives", async () => {
    const first = await request(app).post("/api/family-representatives").set("Cookie", staffCookie).send({
      clientId: clientA, name: "  Alex A  ", relationship: "parent",
      phone: "", email: "  ", address: "", isPrimary: true, userId: parentId,
    });
    expect(first.status).toBe(201);
    expect(first.body.name).toBe("Alex A");
    expect(first.body.phone).toBeNull();
    expect(first.body.email).toBeNull();
    expect(first.body.address).toBeNull();
    expect(first.body.userId).toBeNull();
    repIds.push(first.body.id);

    const second = await request(app).post("/api/family-representatives").set("Cookie", staffCookie).send({
      clientId: clientA, name: "Alex B", relationship: "guardian", isPrimary: true,
    });
    expect(second.status).toBe(201);
    repIds.push(second.body.id);
    const list = await request(app).get("/api/family-representatives").query({ clientId: clientA }).set("Cookie", staffCookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    const detail = await request(app).get(`/api/family-representatives/${first.body.id}`).set("Cookie", staffCookie);
    expect(detail.status).toBe(200);
    const patch = await request(app).patch(`/api/family-representatives/${first.body.id}`).set("Cookie", staffCookie)
      .send({ name: "Alex Updated", phone: "555", email: "a@test.local", address: "1 Main", userId: parentId });
    expect(patch.status).toBe(200);
    expect(patch.body.name).toBe("Alex Updated");
    expect(patch.body.userId).toBeNull();
  });

  it("scopes parent/guardian and vendor access", async () => {
    const own = await request(app).get("/api/family-representatives").query({ clientId: clientA }).set("Cookie", parentCookie);
    expect(own.status).toBe(200);
    expect(own.body.length).toBeGreaterThan(0);
    const other = await request(app).get("/api/family-representatives").query({ clientId: clientB }).set("Cookie", parentCookie);
    expect(other.status).toBe(403);
    const id = repIds[0];
    expect((await request(app).get(`/api/family-representatives/${id}`).set("Cookie", parentCookie)).status).toBe(200);
    expect((await request(app).get(`/api/family-representatives/${id}`).set("Cookie", vendorCookie)).status).toBe(403);
    expect((await request(app).get("/api/family-representatives").query({ clientId: clientA }).set("Cookie", vendorCookie)).status).toBe(403);
  });

  it("rejects invalid relationships and blank names", async () => {
    for (const relationship of ["parent", "guardian", "conservator", "other"]) {
      const res = await request(app).post("/api/family-representatives").set("Cookie", staffCookie)
        .send({ clientId: clientB, name: `Valid ${relationship}`, relationship });
      expect(res.status).toBe(201);
      repIds.push(res.body.id);
    }
    for (const body of [{ name: " " }, { name: "\t" }, { name: "Bad", relationship: "uncle" }]) {
      expect((await request(app).post("/api/family-representatives").set("Cookie", staffCookie)
        .send({ clientId: clientA, ...body })).status).toBe(400);
    }
  });

  it("soft deletes, hides deleted reps, and records normal audits", async () => {
    const id = repIds[0];
    const deleted = await request(app).delete(`/api/family-representatives/${id}`).set("Cookie", staffCookie);
    expect(deleted.status).toBe(200);
    expect((await request(app).get("/api/family-representatives").query({ clientId: clientA }).set("Cookie", staffCookie))
      .body.some((r: { id: string }) => r.id === id)).toBe(false);
    expect((await request(app).get(`/api/family-representatives/${id}`).set("Cookie", staffCookie)).status).toBe(404);
    const logs = await db.select().from(auditLogTable).where(and(eq(auditLogTable.userId, staffId), eq(auditLogTable.entityId, id)));
    expect(logs.map((r) => r.action)).toEqual(expect.arrayContaining(["create_family_representative", "update_family_representative", "delete_family_representative"]));
  });

  it("rejects a deleted client", async () => {
    const [deletedClient] = await db.insert(clientsTable).values({
      firstName: "Deleted", lastName: "Client", dateOfBirth: "2010-01-01", uciNumber: `${nonce}-deleted`,
    }).returning();
    await db.update(clientsTable).set({ isDeleted: true, deletedAt: new Date(), deletedBy: staffId })
      .where(eq(clientsTable.id, deletedClient.id));
    const res = await request(app).post("/api/family-representatives").set("Cookie", staffCookie)
      .send({ clientId: deletedClient.id, name: "No Rep" });
    expect(res.status).toBe(400);
    await db.delete(clientsTable).where(eq(clientsTable.id, deletedClient.id));
  });

  it("allows coordinators to query any client and orders primary representatives by name", async () => {
    await request(app).post("/api/family-representatives").set("Cookie", staffCookie)
      .send({ clientId: clientB, name: "Zulu", isPrimary: true });
    await request(app).post("/api/family-representatives").set("Cookie", staffCookie)
      .send({ clientId: clientB, name: "Alpha", isPrimary: true });
    const response = await request(app).get("/api/family-representatives")
      .query({ clientId: clientB }).set("Cookie", coordinatorCookie);
    expect(response.status).toBe(200);
    expect(response.body.slice(0, 2).map((r: { name: string }) => r.name)).toEqual(["Alpha", "Zulu"]);
  });

  it("reports none, invited, and active portal statuses while excluding used or expired invites", async () => {
    const activeUser = await user({ name: "Active Portal", email: `${nonce}-active@test.local`, role: "parent_guardian", active: true });
    const [none, invited, active, expired, used] = await db.insert(familyRepresentativesTable).values([
      { clientId: clientB, name: "Status None", createdBy: staffId },
      { clientId: clientB, name: "Status Invited", createdBy: staffId },
      { clientId: clientB, name: "Status Active", createdBy: staffId, userId: activeUser.id },
      { clientId: clientB, name: "Status Expired", createdBy: staffId },
      { clientId: clientB, name: "Status Used", createdBy: staffId },
    ]).returning();
    repIds.push(...[none, invited, active, expired, used].map((r) => r.id));
    await db.insert(magicLinksTable).values([
      { token: `${nonce}-valid-invite`, email: "invite@test.local", purpose: "invite", familyRepresentativeId: invited.id, expiresAt: new Date(Date.now() + 3600000) },
      { token: `${nonce}-expired-invite`, email: "expired@test.local", purpose: "invite", familyRepresentativeId: expired.id, expiresAt: new Date(Date.now() - 3600000) },
      { token: `${nonce}-used-invite`, email: "used@test.local", purpose: "invite", familyRepresentativeId: used.id, usedAt: new Date(), expiresAt: new Date(Date.now() + 3600000) },
    ]);
    const response = await request(app).get("/api/family-representatives").query({ clientId: clientB }).set("Cookie", staffCookie);
    const byName = new Map<string, { portalAccountStatus: string }>(
      response.body.map((r: { name: string; portalAccountStatus: string }) => [r.name, r]),
    );
    expect(byName.get("Status None")!.portalAccountStatus).toBe("none");
    expect(byName.get("Status Invited")!.portalAccountStatus).toBe("invited");
    expect(byName.get("Status Active")!.portalAccountStatus).toBe("active");
    expect(byName.get("Status Expired")!.portalAccountStatus).toBe("none");
    expect(byName.get("Status Used")!.portalAccountStatus).toBe("none");
  });

  it("enforces family own-row edits and records a field diff", async () => {
    const linked = await user({
      name: "Linked Rep", email: `${nonce}-linked@test.local`, role: "parent_guardian",
      linkedRecordType: "client", linkedRecordId: clientA, active: true,
    });
    const created = await request(app).post("/api/family-representatives").set("Cookie", staffCookie)
      .send({ clientId: clientA, name: "Linked Rep", phone: "old" });
    repIds.push(created.body.id);
    await db.update(familyRepresentativesTable).set({ userId: linked.id }).where(eq(familyRepresentativesTable.id, created.body.id));
    const own = await login(linked.id);
    expect((await request(app).patch(`/api/family-representatives/${created.body.id}`).set("Cookie", own)
      .send({ name: "New Name", phone: "new" })).status).toBe(200);
    expect((await request(app).patch(`/api/family-representatives/${created.body.id}`).set("Cookie", own)
      .send({ isPrimary: true })).status).toBe(403);
    expect((await request(app).patch(`/api/family-representatives/${created.body.id}`).set("Cookie", own)
      .send({ clientId: clientB })).status).toBe(403);
    const logs = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.action, "update_family_representative"),
      eq(auditLogTable.entityId, created.body.id),
    ));
    expect(logs.some((l) => l.detail?.includes("New Name"))).toBe(true);
    expect((await request(app).patch(`/api/family-representatives/${created.body.id}`).set("Cookie", parentCookie)
      .send({ name: "Nope" })).status).toBe(403);
  });

  it("deleting a linked representative deactivates the account and audits both records", async () => {
    const linked = await user({
      name: "Delete Me", email: `${nonce}-delete@test.local`, role: "self",
      linkedRecordType: "client", linkedRecordId: clientA, active: true,
    });
    const [rep] = await db.insert(familyRepresentativesTable).values({
      clientId: clientA, name: "Delete Me", userId: linked.id, createdBy: staffId,
    }).returning();
    repIds.push(rep.id);
    expect((await request(app).delete(`/api/family-representatives/${rep.id}`).set("Cookie", staffCookie)).status).toBe(200);
    const [userRow] = await db.select().from(usersTable).where(eq(usersTable.id, linked.id));
    expect(userRow.active).toBe(false);
    const logs = await db.select().from(auditLogTable).where(eq(auditLogTable.userId, staffId));
    expect(logs.some((l) => l.action === "delete_family_representative" && l.entityId === rep.id)).toBe(true);
    expect(logs.some((l) => l.action === "delete_user" && l.entityId === linked.id)).toBe(true);
  });

});