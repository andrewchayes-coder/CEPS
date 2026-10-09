import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db, clientsTable, unmatchedPosDocumentsTable, usersTable, sessionsTable, auditLogTable,
  staffRolesTable, staffRolePermissionsTable, STAFF_PERMISSIONS,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `pos-refresh-${randomUUID()}`;
let staffId: string;
let roleId: string;
let cookie: string;
const clientIds: string[] = [];
const queueIds: string[] = [];

beforeAll(async () => {
  const [role] = await db.insert(staffRolesTable).values({ name: nonce }).returning();
  roleId = role.id;
  await db.insert(staffRolePermissionsTable).values(STAFF_PERMISSIONS.map(permission => ({ roleId, permission })));
  const [staff] = await db.insert(usersTable).values({
    name: nonce, email: `${nonce}@test.local`, role: "staff", staffRoleId: roleId,
  }).returning();
  staffId = staff.id;
  const token = newToken();
  await db.insert(sessionsTable).values({ userId: staffId, token, expiresAt: new Date(Date.now() + 3600000) });
  cookie = `ceps_session=${token}`;
});

afterAll(async () => {
  if (queueIds.length) await db.delete(unmatchedPosDocumentsTable).where(inArray(unmatchedPosDocumentsTable.id, queueIds));
  if (clientIds.length) await db.delete(clientsTable).where(inArray(clientsTable.id, clientIds));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
  await db.delete(staffRolePermissionsTable).where(eq(staffRolePermissionsTable.roleId, roleId));
  await db.delete(staffRolesTable).where(eq(staffRolesTable.id, roleId));
});

async function queue(fields: Partial<typeof unmatchedPosDocumentsTable.$inferInsert>) {
  const [row] = await db.insert(unmatchedPosDocumentsTable).values({
    posPdfUrl: `/objects/test-${nonce}.pdf`, sourceFileName: `${nonce}.pdf`, ...fields, createdBy: staffId,
  }).returning();
  queueIds.push(row.id);
  return row;
}
async function participant(uciNumber: string, firstName = nonce, lastName = "Participant") {
  const response = await request(app).post("/api/clients").set("Cookie", cookie)
    .send({ firstName, lastName, dateOfBirth: "2000-01-01", uciNumber });
  expect(response.status).toBe(201);
  clientIds.push(response.body.id);
  return response.body;
}
async function storedQueue(id: string) {
  return (await db.select().from(unmatchedPosDocumentsTable).where(eq(unmatchedPosDocumentsTable.id, id)))[0];
}

describe("participant changes refresh pending POS suggestions", () => {
  it("proposes a UCI match after POST /clients", async () => {
    const uci = `${nonce}-post`;
    const row = await queue({ uciNumber: uci });
    const client = await participant(uci);
    expect(await storedQueue(row.id)).toMatchObject({ suggestedClientId: client.id, suggestionMethod: "uci", reviewStatus: "pending" });
  });

  it("proposes a UCI match after a client CSV import", async () => {
    const uci = `${nonce}-csv`;
    const row = await queue({ uciNumber: uci });
    const imported = await request(app).post("/api/import/clients/commit").set("Cookie", cookie).send({
      csvText: `First Name *,Last Name *,Date of Birth *,UCI Number *\n${nonce},Imported,2000-01-01,${uci}`,
    });
    expect(imported.status).toBe(200);
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci));
    if (client) clientIds.push(client.id);
    expect(imported.body.imported).toBe(1);
    expect(await storedQueue(row.id)).toMatchObject({ suggestedClientId: client.id, suggestionMethod: "uci" });
  });

  it("rechecks after a UCI edit", async () => {
    const client = await participant(`${nonce}-before`);
    const uci = `${nonce}-after`;
    const row = await queue({ uciNumber: uci, clientName: "Nonmatching printed name" });
    const edited = await request(app).patch(`/api/clients/${client.id}`).set("Cookie", cookie).send({ uciNumber: uci });
    expect(edited.status).toBe(200);
    expect(await storedQueue(row.id)).toMatchObject({ suggestedClientId: client.id, suggestionMethod: "uci" });
  });

  it("rechecks after name edits", async () => {
    const client = await participant(`${nonce}-rename`, nonce, "Before");
    const row = await queue({ clientName: `${nonce} After` });
    const edited = await request(app).patch(`/api/clients/${client.id}`).set("Cookie", cookie).send({ lastName: "After" });
    expect(edited.status).toBe(200);
    expect(await storedQueue(row.id)).toMatchObject({ suggestedClientId: client.id, suggestionMethod: "name" });
  });

  it("upgrades a name-only suggestion to a different participant's UCI match", async () => {
    const uci = `${nonce}-strong`;
    const row = await queue({ uciNumber: uci, clientName: `${nonce} NameOnly` });
    const nameOnly = await participant(`${nonce}-weak`, nonce, "NameOnly");
    expect(await storedQueue(row.id)).toMatchObject({ suggestedClientId: nameOnly.id, suggestionMethod: "name" });
    const exact = await participant(uci, nonce, "Exact");
    expect(await storedQueue(row.id)).toMatchObject({ suggestedClientId: exact.id, suggestionMethod: "uci" });
    await participant(`${nonce}-another`, nonce, "NameOnly");
    expect(await storedQueue(row.id)).toMatchObject({ suggestedClientId: exact.id, suggestionMethod: "uci" });
  });

  it("downgrades or clears stale pending UCI hints after an edit, allowing a new exact match", async () => {
    const uci = `${nonce}-stale-uci`;
    const named = await queue({ uciNumber: uci, clientName: `${nonce} Stale` });
    const unnamed = await queue({ uciNumber: uci, clientName: "Different printed name" });
    const original = await participant(uci, nonce, "Stale");
    expect((await storedQueue(named.id)).suggestionMethod).toBe("uci");
    expect((await storedQueue(unnamed.id)).suggestionMethod).toBe("uci");
    const edited = await request(app).patch(`/api/clients/${original.id}`).set("Cookie", cookie)
      .send({ uciNumber: `${nonce}-corrected-uci` });
    expect(edited.status).toBe(200);
    expect(await storedQueue(named.id)).toMatchObject({ suggestedClientId: original.id, suggestionMethod: "name" });
    expect(await storedQueue(unnamed.id)).toMatchObject({ suggestedClientId: null, suggestionMethod: null, suggestedAt: null });
    const exact = await participant(uci, nonce, "NowExact");
    for (const row of [named, unnamed]) {
      expect(await storedQueue(row.id)).toMatchObject({ suggestedClientId: exact.id, suggestionMethod: "uci" });
    }
  });

  it("never overwrites a staff-confirmed match", async () => {
    const nameOnly = await participant(`${nonce}-confirmed`, nonce, "Confirmed");
    const uci = `${nonce}-confirmed-uci`;
    const row = await queue({
      uciNumber: uci, clientName: `${nonce} Confirmed`, suggestedClientId: nameOnly.id,
      suggestionMethod: "name", suggestedAt: new Date(), reviewStatus: "confirmed", reviewedBy: staffId, reviewedAt: new Date(),
    });
    await participant(uci, nonce, "NewExact");
    expect(await storedQueue(row.id)).toMatchObject({ suggestedClientId: nameOnly.id, suggestionMethod: "name", reviewStatus: "confirmed" });
  });
});

describe("readable API feedback", () => {
  it("POST /payments returns field names and readable problems, not Zod JSON", async () => {
    const invalid = await request(app).post("/api/payments").set("Cookie", cookie).send({});
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("clientId: This field is required.");
    expect(invalid.body.error).not.toContain('"code"');
    expect(invalid.body.error).not.toContain('"path"');
  });

  it("the portal has no direct data.message error reads and each affected screen uses the shared helper", () => {
    const root = resolve(import.meta.dirname, "../../../ceps-portal/src");
    const files = readdirSync(root, { recursive: true }).map(file => file.toString()).filter(file => /\.(tsx?|jsx?)$/.test(file));
    const offenders = files.filter(file => /\bdata(?:\?\.|\.)message\b/.test(readFileSync(resolve(root, file), "utf8")));
    expect(offenders).toEqual([]);
    for (const screen of [
      "invoices/new.tsx", "referrals/new.tsx", "login.tsx", "auth/magic.tsx", "invite/[token].tsx",
      "vendors/[id].tsx", "vendors/new.tsx", "authorizations/unmatched.tsx",
    ]) expect(readFileSync(resolve(root, "pages", screen), "utf8")).toContain("apiErrorMessage(");
  });
});
