import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogTable, clientsTable, db, referralsTable, sessionsTable, unmatchedPosDocumentsTable,
  usersTable, vendorsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `posalert${Date.now().toString(36)}`;
let staffId: string;
let staffCookie: string;
const userIds: string[] = [];
const clientIds: string[] = [];
const queueIds: string[] = [];
const referralIds: string[] = [];
const vendorNames: string[] = [];

async function cookie(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({ userId, token, expiresAt: new Date(Date.now() + 3600000) });
  return `ceps_session=${token}`;
}
async function queue(values: Partial<typeof unmatchedPosDocumentsTable.$inferInsert>) {
  const [row] = await db.insert(unmatchedPosDocumentsTable).values({
    posPdfUrl: `/objects/${nonce}-${queueIds.length}.pdf`,
    sourceFileName: `${nonce}-${queueIds.length}.pdf`,
    createdBy: staffId,
    ...values,
  }).returning();
  queueIds.push(row.id);
  return row;
}
function intake(uci: string, firstName: string, lastName: string, vendor: string) {
  vendorNames.push(vendor);
  return {
    submittedVia: "staff_manual_entry",
    serviceFrequency: "monthly",
    intakeFields: {
      regionalCenterName: "Alta California Regional Center", coordinatorName: "Coordinator",
      coordinatorEmail: `${nonce}@test.local`, coordinatorPhone: "5551234567",
      vendorAcceptsChecks: true, vendorName: vendor, vendorEmail: `${vendor}@test.local`,
      vendorPhone: "5559876543", vendorServiceStreet: "1 Main St", vendorServiceCity: "Sacramento",
      vendorServiceZip: "95814", vendorServiceState: "CA", vendorBillingDifferent: "no",
      serviceType: "direct_pay_459", activityDescription: "Therapy", serviceStartDate: "2026-01-01",
      serviceEndDate: "2026-12-31", clientFirstName: firstName, clientLastName: lastName,
      clientDob: "2000-01-01", clientUci: uci, preferredLanguage: "English", clientIsMinor: false,
    },
  };
}
async function createReferral(uci: string, first: string, last: string) {
  const response = await request(app).post("/api/referrals").set("Cookie", staffCookie)
    .send(intake(uci, first, last, `${nonce}-vendor-${vendorNames.length}`));
  expect(response.status).toBe(201);
  referralIds.push(response.body.id);
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci));
  clientIds.push(client.id);
  return client;
}

beforeAll(async () => {
  const [staff] = await db.insert(usersTable).values({ name: "POS Alert Staff", email: `${nonce}@test.local`, role: "staff" }).returning();
  staffId = staff.id; userIds.push(staffId); staffCookie = await cookie(staffId);
});
afterAll(async () => {
  await db.delete(unmatchedPosDocumentsTable).where(inArray(unmatchedPosDocumentsTable.id, queueIds));
  await db.delete(referralsTable).where(inArray(referralsTable.id, referralIds));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, userIds));
  await db.delete(vendorsTable).where(inArray(vendorsTable.name, vendorNames));
  await db.delete(clientsTable).where(inArray(clientsTable.id, clientIds));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, userIds));
  await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

describe("referral-driven unmatched POS dashboard suggestions", () => {
  it("A: persists normalized UCI suggestion and a named dashboard alert", async () => {
    const clientUci = `${nonce}-uci  normalized`;
    const row = await queue({ uciNumber: ` ${clientUci.replace("  ", "    ")} `, clientName: "Other Name" });
    const client = await createReferral(clientUci, "Uci", "Winner");
    const [stored] = await db.select().from(unmatchedPosDocumentsTable).where(eq(unmatchedPosDocumentsTable.id, row.id));
    expect(stored).toMatchObject({ suggestedClientId: client.id, suggestionMethod: "uci" });
    expect(stored.suggestedAt).toBeInstanceOf(Date);
    const originalSuggestedAt = stored.suggestedAt;
    await createReferral(clientUci, "Uci", "Winner");
    const [retried] = await db.select().from(unmatchedPosDocumentsTable).where(eq(unmatchedPosDocumentsTable.id, row.id));
    expect(retried).toMatchObject({ suggestedClientId: client.id, suggestionMethod: "uci", suggestedAt: originalSuggestedAt });
    const summary = await request(app).get("/api/dashboard/summary").set("Cookie", staffCookie);
    expect(summary.body.totals.unmatchedPosDocuments).toBeGreaterThanOrEqual(1);
    const alert = summary.body.alerts.find((item: any) => item.kind === "unmatched_pos_possible_match" && item.entityId === row.id);
    expect(alert.message).toContain("Uci Winner");
    expect(alert.entityId).toBe(row.id);
  });
  it("B/C: leaves no-match rows alone and uses normalized name fallback", async () => {
    const noMatch = await queue({ uciNumber: " ", clientName: "Nobody At All" });
    const nameRow = await queue({ uciNumber: `${nonce}-wrong`, clientName: "Name    Fallback" });
    const client = await createReferral(`${nonce}-name-client`, "Name", "Fallback");
    const [untouched, matched] = await Promise.all([
      db.select().from(unmatchedPosDocumentsTable).where(eq(unmatchedPosDocumentsTable.id, noMatch.id)),
      db.select().from(unmatchedPosDocumentsTable).where(eq(unmatchedPosDocumentsTable.id, nameRow.id)),
    ]);
    expect(untouched[0].suggestedClientId).toBeNull();
    expect(matched[0]).toMatchObject({ suggestedClientId: client.id, suggestionMethod: "name" });
  });
  it("D: evaluates UCI before name independently for each row", async () => {
    const uci = `${nonce}-precedence`;
    const uciRow = await queue({ uciNumber: uci, clientName: "Name Only Candidate" });
    const nameRow = await queue({ uciNumber: `${nonce}-different`, clientName: "Precedence Winner" });
    const client = await createReferral(uci, "Precedence", "Winner");
    const rows = await db.select().from(unmatchedPosDocumentsTable)
      .where(inArray(unmatchedPosDocumentsTable.id, [uciRow.id, nameRow.id]));
    expect(rows.find((r) => r.id === uciRow.id)?.suggestedClientId).toBe(client.id);
    expect(rows.find((r) => r.id === nameRow.id)?.suggestionMethod).toBe("name");
  });
  it("E/F: blank values do not match and another client's suggestion is preserved", async () => {
    const other = await createReferral(`${nonce}-other`, "Other", "Client");
    const blank = await queue({ uciNumber: "", clientName: "   " });
    const preserved = await queue({ uciNumber: `${nonce}-preserved`, clientName: "Preserved", suggestedClientId: other.id, suggestionMethod: "uci", suggestedAt: new Date() });
    await createReferral(`${nonce}-preserved`, "New", "Name");
    const rows = await db.select().from(unmatchedPosDocumentsTable).where(and(inArray(unmatchedPosDocumentsTable.id, [blank.id, preserved.id])));
    expect(rows.find((r) => r.id === blank.id)?.suggestedClientId).toBeNull();
    expect(rows.find((r) => r.id === preserved.id)?.suggestedClientId).toBe(other.id);
  });
  it("G: non-staff roles receive no unmatched POS alert kinds", async () => {
    const roles = ["parent_guardian", "vendor", "service_coordinator"] as const;
    const cookies = await Promise.all(roles.map(async (role, i) => {
      const [user] = await db.insert(usersTable).values({ name: `${role} ${nonce}`, email: `${role}-${nonce}@test.local`, role }).returning();
      userIds.push(user.id);
      if (role === "vendor") {
        const roleVendorName = `${nonce}-role-vendor-${i}`;
        vendorNames.push(roleVendorName);
        const [vendor] = await db.insert(vendorsTable).values({ name: roleVendorName, email: `${nonce}-${i}@test.local` }).returning();
        await db.update(usersTable).set({ linkedRecordType: "vendor", linkedRecordId: vendor.id }).where(eq(usersTable.id, user.id));
      }
      return cookie(user.id);
    }));
    for (const session of cookies) {
      const body = (await request(app).get("/api/dashboard/summary").set("Cookie", session)).body;
      expect(body.alerts.some((a: any) => a.kind === "unmatched_pos" || a.kind === "unmatched_pos_possible_match")).toBe(false);
    }
  });
  it("H: dashboard open count is derived live after deletion", async () => {
    const first = await queue({ clientName: `${nonce} live one` });
    const second = await queue({ clientName: `${nonce} live two` });
    const before = await request(app).get("/api/dashboard/summary").set("Cookie", staffCookie);
    expect(before.body.totals.unmatchedPosDocuments).toBe(queueIds.length);
    await db.delete(unmatchedPosDocumentsTable).where(eq(unmatchedPosDocumentsTable.id, first.id));
    const after = await request(app).get("/api/dashboard/summary").set("Cookie", staffCookie);
    expect(after.body.totals.unmatchedPosDocuments).toBe(queueIds.length - 1);
    await db.delete(unmatchedPosDocumentsTable).where(eq(unmatchedPosDocumentsTable.id, second.id));
  });
  it("rejects referral creation for a soft-deleted participant without suggesting rows", async () => {
    const uci = `${nonce}-deleted`;
    const [deleted] = await db.insert(clientsTable).values({
      firstName: "Deleted", lastName: "Participant", dateOfBirth: "2000-01-01", uciNumber: uci, isDeleted: true,
      deletedAt: new Date(), deletedBy: staffId,
    }).returning();
    clientIds.push(deleted.id);
    const row = await queue({ uciNumber: uci, clientName: "Deleted Participant" });
    const response = await request(app).post("/api/referrals").set("Cookie", staffCookie)
      .send(intake(uci, "Deleted", "Participant", `${nonce}-deleted-vendor`));
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("must be restored");
    const [untouched] = await db.select().from(unmatchedPosDocumentsTable).where(eq(unmatchedPosDocumentsTable.id, row.id));
    expect(untouched.suggestedClientId).toBeNull();
    expect(await db.select().from(referralsTable).where(eq(referralsTable.clientId, deleted.id))).toHaveLength(0);
  });
});