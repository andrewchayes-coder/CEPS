import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db, usersTable, sessionsTable, clientsTable, referralsTable,
  unmatchedPosDocumentsTable, auditLogTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";
import { suggestUnmatchedPosForClient } from "../lib/posMatching";
import { logger } from "../lib/logger";

vi.mock("../lib/posMatching", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/posMatching")>();
  return { ...actual, suggestUnmatchedPosForClient: vi.fn(actual.suggestUnmatchedPosForClient) };
});
const actualMatching = await vi.importActual<typeof import("../lib/posMatching")>("../lib/posMatching");
const nonce = `carry${Date.now().toString(36)}`;
let staffId: string;
let cookie: string;
const clientIds: string[] = [];
const referralIds: string[] = [];
const queueIds: string[] = [];
const warn = vi.spyOn(logger, "warn");

beforeAll(async () => {
  const [user] = await db.insert(usersTable).values({
    name: "Carry-over regression staff", email: `${nonce}@test.local`, role: "staff",
  }).returning();
  staffId = user.id;
  const token = newToken();
  await db.insert(sessionsTable).values({ userId: staffId, token, expiresAt: new Date(Date.now() + 3600000) });
  cookie = `ceps_session=${token}`;
});
beforeEach(() => {
  vi.mocked(suggestUnmatchedPosForClient).mockReset().mockImplementation(actualMatching.suggestUnmatchedPosForClient);
  warn.mockClear();
});
afterAll(async () => {
  await db.delete(unmatchedPosDocumentsTable).where(inArray(unmatchedPosDocumentsTable.id, queueIds));
  await db.delete(referralsTable).where(inArray(referralsTable.id, referralIds));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(clientsTable).where(inArray(clientsTable.id, clientIds));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
  warn.mockRestore();
});
async function storedClient(uci: string) {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci));
  if (client && !clientIds.includes(client.id)) clientIds.push(client.id);
  return client;
}
async function createClient(uci: string) {
  const response = await request(app).post("/api/clients").set("Cookie", cookie)
    .send({ firstName: "Carry", lastName: "Over", dateOfBirth: "2000-01-01", uciNumber: uci });
  const client = await storedClient(uci);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(client).toBeDefined();
  return client!;
}
async function queue(uci: string) {
  const [row] = await db.insert(unmatchedPosDocumentsTable).values({
    posPdfUrl: `/test/${nonce}.pdf`, sourceFileName: `${nonce}.pdf`,
    uciNumber: uci, createdBy: staffId,
  }).returning();
  queueIds.push(row.id);
  return row.id;
}
async function expectSuggestion(queueId: string, clientId: string) {
  const [row] = await db.select().from(unmatchedPosDocumentsTable).where(eq(unmatchedPosDocumentsTable.id, queueId));
  expect(row).toMatchObject({ reviewStatus: "pending", suggestedClientId: clientId, suggestionMethod: "uci" });
}

describe("POS re-check after committed participant saves", () => {
  it("create succeeds and persists when re-check throws, with a clientId warning", async () => {
    vi.mocked(suggestUnmatchedPosForClient).mockRejectedValue(new Error("forced POS error"));
    const client = await createClient(`${nonce}-create-error`);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ clientId: client.id }), expect.any(String));
  });
  it("update succeeds and persists when re-check throws", async () => {
    const client = await createClient(`${nonce}-update-error`);
    vi.mocked(suggestUnmatchedPosForClient).mockRejectedValue(new Error("forced POS error"));
    const response = await request(app).patch(`/api/clients/${client.id}`).set("Cookie", cookie).send({ firstName: "Saved" });
    expect(response.status).toBe(200);
    expect((await storedClient(client.uciNumber))?.firstName).toBe("Saved");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ clientId: client.id }), expect.any(String));
  });
  it("bulk import saves every row before sequential re-checks and survives failures", async () => {
    const ucis = [`${nonce}-import-error-1`, `${nonce}-import-error-2`];
    let active = 0;
    let maxActive = 0;
    const observedCommittedCounts: number[] = [];
    vi.mocked(suggestUnmatchedPosForClient).mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        const saved = await db.select().from(clientsTable).where(inArray(clientsTable.uciNumber, ucis));
        observedCommittedCounts.push(saved.length);
      } finally {
        active--;
      }
      throw new Error("forced POS error");
    });
    const response = await request(app).post("/api/import/clients/commit").set("Cookie", cookie).send({
      csvText: `First Name,Last Name,Date of Birth,UCI Number\nBulk,One,2000-01-01,${ucis[0]}\nBulk,Two,2000-01-01,${ucis[1]}`,
    });
    const clients = await Promise.all(ucis.map(storedClient));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ imported: 2, errored: 0 });
    expect(clients.every(Boolean)).toBe(true);
    expect(suggestUnmatchedPosForClient).toHaveBeenCalledTimes(2);
    // Assert outside the best-effort callback, which intentionally catches errors.
    expect(observedCommittedCounts).toEqual([2, 2]);
    expect(maxActive).toBe(1);
  });
  it("referral creation also persists its participant when re-check throws", async () => {
    vi.mocked(suggestUnmatchedPosForClient).mockRejectedValue(new Error("forced POS error"));
    const uci = `${nonce}-referral-error`;
    const response = await request(app).post("/api/referrals").set("Cookie", cookie).send({
      intakeFields: {
        clientFirstName: "Referral", clientLastName: "Saved", clientUci: uci, clientDob: "2000-01-01",
        clientIsMinor: false, preferredLanguage: "English", serviceType: "direct_pay_459",
        serviceFrequency: "monthly", serviceStartDate: "2026-01-01", serviceEndDate: "2026-12-31", authAmount: "100.00",
      },
    });
    const client = await storedClient(uci);
    if (response.body.id) referralIds.push(response.body.id);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(client).toBeDefined();
    const [referral] = await db.select().from(referralsTable).where(eq(referralsTable.id, response.body.id));
    expect(referral.clientId).toBe(client!.id);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ clientId: client!.id }), expect.any(String));
  });
  it("working create, update and import still suggest matching pending POS", async () => {
    const createUci = `${nonce}-create-ok`;
    const createQueue = await queue(createUci);
    const client = await createClient(createUci);
    await expectSuggestion(createQueue, client.id);
    const updateUci = `${nonce}-update-ok`;
    const updateQueue = await queue(updateUci);
    const updated = await request(app).patch(`/api/clients/${client.id}`).set("Cookie", cookie).send({ uciNumber: updateUci });
    expect(updated.status).toBe(200);
    await expectSuggestion(updateQueue, client.id);
    const importUci = `${nonce}-import-ok`;
    const importQueue = await queue(importUci);
    const imported = await request(app).post("/api/import/clients/commit").set("Cookie", cookie).send({
      csvText: `First Name,Last Name,Date of Birth,UCI Number\nBulk,Match,2000-01-01,${importUci}`,
    });
    const importedClient = await storedClient(importUci);
    expect(imported.body).toMatchObject({ imported: 1, errored: 0 });
    await expectSuggestion(importQueue, importedClient!.id);
  });
});

describe("legacy referral output versus strict new inputs", () => {
  let referralId: string;
  it("lists and opens legacy intake enums, empty strings and null without a 500", async () => {
    const client = await createClient(`${nonce}-legacy`);
    const [referral] = await db.insert(referralsTable).values({
      clientId: client.id, referralDate: "2026-10-09", status: "intake",
      intakeFields: {
        serviceType: "legacy_service", serviceFrequency: "", familyRepRelationship: "Mother",
        vendorBillingDifferent: null, serviceStartDate: "2026-01-01", serviceEndDate: "2026-12-31", authAmount: "100.00",
      },
    }).returning();
    referralId = referral.id; referralIds.push(referralId);
    const list = await request(app).get("/api/referrals").query({ clientId: client.id }).set("Cookie", cookie);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const item = list.body.items.find((r: { id: string }) => r.id === referralId);
    expect(item.intakeFields).toMatchObject({ serviceFrequency: "", familyRepRelationship: "Mother", serviceType: "legacy_service", vendorBillingDifferent: null });
    const detail = await request(app).get(`/api/referrals/${referralId}`).set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.intakeFields).toEqual(item.intakeFields);
    const edit = await request(app).patch(`/api/referrals/${referralId}`).set("Cookie", cookie).send({ notes: "Safe unrelated edit" });
    expect(edit.status).toBe(200);
    expect(edit.body.intakeFields.familyRepRelationship).toBe("Mother");
  });
  it.each([
    ["serviceType", "legacy_service"], ["serviceFrequency", ""],
    ["familyRepRelationship", "Mother"], ["vendorBillingDifferent", "Maybe"],
  ])("rejects new invalid %s on create and edit", async (field, value) => {
    const create = await request(app).post("/api/referrals").set("Cookie", cookie).send({ intakeFields: { [field]: value } });
    expect(create.status).toBe(400);
    const edit = await request(app).patch(`/api/referrals/${referralId}`).set("Cookie", cookie).send({ intakeFields: { [field]: value } });
    expect(edit.status).toBe(400);
  });
  it("keeps send-intake frequency strict", async () => {
    const response = await request(app).post(`/api/referrals/${referralId}/send-intake`).set("Cookie", cookie)
      .send({ recipient: "participant", serviceFrequency: "Legacy monthly" });
    expect(response.status).toBe(400);
  });
  it("allows a valid correction without rewriting other legacy fields", async () => {
    const response = await request(app).patch(`/api/referrals/${referralId}`).set("Cookie", cookie)
      .send({ intakeFields: { familyRepRelationship: "parent" } });
    expect(response.status).toBe(200);
    expect(response.body.intakeFields).toMatchObject({ familyRepRelationship: "parent", serviceFrequency: "", serviceType: "legacy_service" });
  });
});
