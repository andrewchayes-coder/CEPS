import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  clientsTable,
  db,
  familyRepresentativesTable,
  magicLinksTable,
  sessionsTable,
  usersTable,
  vendorsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `invite-rep-${Date.now().toString(36)}`;
let staffId: string;
let staffCookie: string;
let clientId: string;
let otherClientId: string;
let vendorId: string;
let repId: string;
let deletedRepId: string;
let duplicateRepId: string;
const userIds: string[] = [];
const linkTokens: string[] = [];

async function cookie(userId: string) {
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
    name: "Invite Regression Staff",
    email: `${nonce}-staff@test.local`,
    role: "staff",
  }).returning();
  staffId = staff.id;
  userIds.push(staffId);
  staffCookie = await cookie(staffId);

  const clients = await db.insert(clientsTable).values([
    { firstName: "Invite", lastName: "Client", dateOfBirth: "2012-01-01", uciNumber: `${nonce}-client`, isMinor: true },
    { firstName: "Other", lastName: "Client", dateOfBirth: "2012-01-01", uciNumber: `${nonce}-other`, isMinor: true },
  ]).returning();
  clientId = clients[0].id;
  otherClientId = clients[1].id;
  const [vendor] = await db.insert(vendorsTable).values({
    name: `${nonce} Vendor`,
    email: `${nonce}-vendor@test.local`,
  }).returning();
  vendorId = vendor.id;
  const reps = await db.insert(familyRepresentativesTable).values([
    { clientId, name: "Invite Parent", relationship: "parent", email: `${nonce}-parent@test.local` },
    { clientId, name: "Deleted Parent", relationship: "guardian", email: `${nonce}-deleted@test.local` },
  ]).returning();
  repId = reps[0].id;
  deletedRepId = reps[1].id;
});

afterAll(async () => {
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, userIds));
  await db.delete(auditLogTable).where(eq(auditLogTable.entityId, clientId));
  await db.delete(magicLinksTable).where(inArray(magicLinksTable.token, linkTokens));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, userIds));
  await db.delete(familyRepresentativesTable).where(inArray(familyRepresentativesTable.id, [repId, deletedRepId, duplicateRepId]));
  await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientId, otherClientId]));
});

async function createInvite(body: Record<string, unknown>) {
  const response = await request(app).post("/api/invites").set("Cookie", staffCookie).send(body);
  const token = response.body.inviteUrl?.split("/").pop();
  if (token) linkTokens.push(token);
  return { response, token };
}

describe("family representative invite linkage", () => {
  it("validates representative role, record type, ownership, and deletion", async () => {
    for (const body of [
      { role: "vendor", linkedRecordType: "client", linkedRecordId: clientId },
      { role: "parent_guardian", linkedRecordType: "vendor", linkedRecordId: vendorId },
      { role: "parent_guardian", linkedRecordType: "client", linkedRecordId: otherClientId },
    ] as Record<string, unknown>[]) {
      const { response } = await createInvite({
        email: `${nonce}-${Math.random()}@test.local`,
        ...body,
        ...(body.familyRepresentativeId ? {} : { familyRepresentativeId: repId }),
      });
      expect(response.status).toBe(400);
    }
  });

  it("stores the selected representative and links it atomically on acceptance", async () => {
    const { response, token } = await createInvite({
      email: `${nonce}-accepted@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientId,
      familyRepresentativeId: repId,
    });
    expect(response.status).toBe(201);
    const [link] = await db.select().from(magicLinksTable).where(eq(magicLinksTable.token, token!));
    expect(link.familyRepresentativeId).toBe(repId);
    const accepted = await request(app).post(`/api/invites/${token}/accept`).send({
      name: "Accepted Representative",
      password: "valid-password",
    });
    expect(accepted.status).toBe(200);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, `${nonce}-accepted@test.local`));
    const [rep] = await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.id, repId));
    const [used] = await db.select().from(magicLinksTable).where(eq(magicLinksTable.token, token!));
    userIds.push(user.id);
    expect(rep.userId).toBe(user.id);
    expect(used.usedAt).toBeInstanceOf(Date);
    const duplicateInvite = await createInvite({
      email: `${nonce}-already-linked@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientId,
      familyRepresentativeId: repId,
    });
    expect(duplicateInvite.response.status).toBe(409);
  });

  it("allows only one of two invites for the same representative to be accepted", async () => {
    const [rep] = await db.insert(familyRepresentativesTable).values({
      clientId,
      name: "Concurrent Invite Rep",
      relationship: "parent",
      email: `${nonce}-concurrent-rep@test.local`,
    }).returning();
    duplicateRepId = rep.id;
    const first = await createInvite({
      email: `${nonce}-duplicate-one@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientId,
      familyRepresentativeId: duplicateRepId,
    });
    const second = await createInvite({
      email: `${nonce}-duplicate-two@test.local`,
      role: "parent_guardian",
      linkedRecordType: "client",
      linkedRecordId: clientId,
      familyRepresentativeId: duplicateRepId,
    });
    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(201);
    const results = await Promise.all([
      request(app).post(`/api/invites/${first.token}/accept`).send({ password: "valid-password" }),
      request(app).post(`/api/invites/${second.token}/accept`).send({ password: "valid-password" }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const [repAfter] = await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.id, duplicateRepId));
    const linkedUsers = await db.select().from(usersTable).where(eq(usersTable.email, `${nonce}-duplicate-one@test.local`));
    const linkedUsersTwo = await db.select().from(usersTable).where(eq(usersTable.email, `${nonce}-duplicate-two@test.local`));
    expect(linkedUsers.length + linkedUsersTwo.length).toBe(1);
    expect(repAfter.userId).toBe((linkedUsers[0] ?? linkedUsersTwo[0]).id);
    const [loser] = await db.select().from(magicLinksTable).where(
      eq(magicLinksTable.token, results[0].status === 409 ? first.token! : second.token!),
    );
    expect(loser.usedAt).toBeNull();
    userIds.push((linkedUsers[0] ?? linkedUsersTwo[0]).id);
  });

  it("leaves plain parent and vendor invites unlinked", async () => {
    const parent = await createInvite({
      email: `${nonce}-plain@test.local`, role: "self", linkedRecordType: "client", linkedRecordId: clientId,
    });
    const vendor = await createInvite({
      email: `${nonce}-vendor-user@test.local`, role: "vendor", linkedRecordType: "vendor", linkedRecordId: vendorId,
    });
    for (const item of [parent, vendor]) {
      const accepted = await request(app).post(`/api/invites/${item.token}/accept`).send({ password: "valid-password" });
      expect(accepted.status).toBe(200);
      const [user] = await db.select().from(usersTable).where(eq(
        usersTable.email,
        item === parent ? `${nonce}-plain@test.local` : `${nonce}-vendor-user@test.local`,
      ));
      userIds.push(user.id);
    }
    const [rep] = await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.id, repId));
    expect(rep.userId).not.toBeNull();
  });

  it("rejects a deleted representative at acceptance without partial writes", async () => {
    const email = `${nonce}-stale@test.local`;
    const { token } = await createInvite({
      email, role: "parent_guardian", linkedRecordType: "client", linkedRecordId: clientId, familyRepresentativeId: deletedRepId,
    });
    await db.update(familyRepresentativesTable).set({ isDeleted: true, deletedAt: new Date() }).where(eq(familyRepresentativesTable.id, deletedRepId));
    const accepted = await request(app).post(`/api/invites/${token}/accept`).send({ password: "valid-password" });
    expect(accepted.status).toBe(404);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));
    const [link] = await db.select().from(magicLinksTable).where(eq(magicLinksTable.token, token!));
    expect(user).toBeUndefined();
    expect(link).toBeDefined();
    expect(link.usedAt).toBeNull();
  });
});