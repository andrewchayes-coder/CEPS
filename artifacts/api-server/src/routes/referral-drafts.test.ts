import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import request from "supertest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, usersTable, sessionsTable, staffRolesTable, staffRolePermissionsTable, referralDraftsTable,
  clientsTable, referralsTable, vendorsTable, auditLogTable } from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";

const nonce = `draft${Date.now().toString(36)}`;
const ids: Record<string, string> = {}, cookies: Record<string, string> = {};
let role: string, draftId: string, clientId: string;
const body = (uci = "", step = 2) => ({ data: { clientUci: uci, clientFirstName: "Synthetic", clientLastName: "Example" },
  currentStep: step, supportingDocumentUrl: null });
const create = (data = body(), who = "coordinator") => request(app).post("/api/referral-drafts").set("Cookie", cookies[who]).send(data);
const list = (who = "coordinator", id?: string) => request(app).get(`/api/referral-drafts${id ? `?id=${id}` : ""}`).set("Cookie", cookies[who]);
const intake = (uci: string) => ({
  regionalCenterName: "Synthetic center", coordinatorName: "Synthetic Coordinator", coordinatorEmail: "coordinator@example.test",
  coordinatorPhone: "5551234567", vendorAcceptsChecks: true, vendorName: `${nonce}-vendor`, vendorEmail: "vendor@example.test",
  vendorPhone: "5559876543", vendorServiceStreet: "1 Example St", vendorServiceCity: "Example", vendorServiceZip: "95814",
  vendorServiceState: "CA", vendorBillingDifferent: "no", serviceType: "direct_pay_459", activityDescription: "Test activity",
  serviceStartDate: "2026-01-01", serviceEndDate: "2026-12-31", authAmount: "500",
  clientFirstName: "Synthetic", clientLastName: "Example", clientDob: "2000-01-01", clientUci: uci, clientIsMinor: false,
  preferredLanguage: "English", contactPhone: "5550001111", contactStreet: "2 Example St", contactCity: "Example",
  contactZip: "95814", contactState: "CA",
});
beforeAll(async () => {
  const [r] = await db.insert(staffRolesTable).values({ name: `${nonce}-manager` }).returning(); role = r.id;
  await db.insert(staffRolePermissionsTable).values({ roleId: role, permission: "manage_users" });
  for (const [key, userRole] of Object.entries({ staff: "staff", coordinator: "service_coordinator", other: "service_coordinator",
    deactivatePatch: "service_coordinator", deactivateDelete: "service_coordinator", family: "parent_guardian" })) {
    const [u] = await db.insert(usersTable).values({ name: `${nonce}-${key}`, email: `${nonce}-${key}@example.test`, role: userRole,
      staffRoleId: key === "staff" ? role : null }).returning();
    ids[key] = u.id;
    const token = newToken();
    await db.insert(sessionsTable).values({ userId: u.id, token, expiresAt: new Date(Date.now() + 3600000) });
    cookies[key] = `ceps_session=${token}`;
  }
  const [c] = await db.insert(clientsTable).values({ firstName: "Synthetic", lastName: "Draft", dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-assigned`, assignedCoordinatorId: ids.coordinator }).returning(); clientId = c.id;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  const people = Object.values(ids);
  await db.delete(referralDraftsTable).where(inArray(referralDraftsTable.userId, people));
  const clients = await db.select({ id: clientsTable.id }).from(clientsTable).where(like(clientsTable.uciNumber, `${nonce}%`));
  if (clients.length) {
    await db.delete(referralsTable).where(inArray(referralsTable.clientId, clients.map(c => c.id)));
    await db.delete(clientsTable).where(inArray(clientsTable.id, clients.map(c => c.id)));
  }
  await db.delete(vendorsTable).where(eq(vendorsTable.name, `${nonce}-vendor`));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, people));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, people));
  await db.delete(usersTable).where(inArray(usersTable.id, people));
  await db.delete(staffRolesTable).where(eq(staffRolesTable.id, role));
});

describe("private coordinator referral drafts", () => {
  it("stores incomplete forms and derives UCI/label on the server", async () => {
    const r = await create({ ...body(` ${nonce}-first `), label: "Untrusted label", uciNumber: "Untrusted UCI" } as ReturnType<typeof body>);
    expect(r.status, JSON.stringify(r.body)).toBe(201); draftId = r.body.id;
    expect(r.body).toMatchObject({ uciNumber: `${nonce}-first`, label: "Synthetic Example", currentStep: 2, supportingDocumentUrl: null });
    expect((await list()).body.items.map((d: { id: string }) => d.id)).toContain(draftId);
  });
  it("returns 404 to staff, family and other coordinators without leaking draft data", async () => {
    for (const who of ["staff", "family", "other"]) {
      expect((await list(who, draftId)).status).toBe(404);
      expect((await request(app).patch(`/api/referral-drafts/${draftId}`).set("Cookie", cookies[who]).send(body())).status).toBe(404);
      expect((await request(app).delete(`/api/referral-drafts/${draftId}`).set("Cookie", cookies[who])).status).toBe(404);
    }
    expect((await list("other")).body.items).toEqual([]);
    expect((await create(body(), "staff")).status).toBe(404);
    expect((await list("staff")).status).toBe(404);
  });
  it("enforces one draft per owner/UCI and one untitled, including concurrent saves", async () => {
    const dup = await create(body(`${nonce}-first`));
    expect(dup.status).toBe(409); expect(dup.body.existingDraftId).toBe(draftId);
    const other = await create(body(`${nonce}-first`), "other"); expect(other.status).toBe(201);
    const untitled = await Promise.all([create(body()), create(body("   "))]);
    expect(untitled.map(r => r.status).sort()).toEqual([201, 409]);
    const [saved] = untitled.filter(r => r.status === 201);
    const clash = await request(app).patch(`/api/referral-drafts/${saved.body.id}`).set("Cookie", cookies.coordinator).send(body(`${nonce}-first`));
    expect(clash.status).toBe(409); expect(clash.body.existingDraftId).toBe(draftId);
    await request(app).delete(`/api/referral-drafts/${saved.body.id}`).set("Cookie", cookies.coordinator).expect(204);
  });
  it("round-trips every saved field and step without auditing every update", async () => {
    const b = { ...body(`${nonce}-first`, 4), data: { ...body(`${nonce}-first`).data, vendorName: "Changed",
      activityDescription: "Draft only", clientIsMinor: false, familyRepName: "", authAmount: "", contactState: "NV" } };
    const r = await request(app).patch(`/api/referral-drafts/${draftId}`).set("Cookie", cookies.coordinator).send(b);
    expect(r.status).toBe(200);
    const restore = await list("coordinator", draftId);
    expect(restore.body.items[0]).toMatchObject({ data: b.data, currentStep: 4 });
    const audits = await db.select().from(auditLogTable).where(and(eq(auditLogTable.entityId, draftId), eq(auditLogTable.action, "create_referral_draft")));
    expect(audits).toHaveLength(1);
    expect(await db.select().from(auditLogTable).where(and(eq(auditLogTable.entityId, draftId), eq(auditLogTable.action, "update_referral_draft")))).toHaveLength(0);
  });
  it("rejects oversized data and invalid steps", async () => {
    expect((await create({ ...body(`${nonce}-big`), data: { text: "x".repeat(200 * 1024) } } as unknown as ReturnType<typeof body>)).status).toBe(413);
    expect((await create(body(`${nonce}-step`, 6))).status).toBe(400);
  });
  it("validates upload ownership on creation and every update", async () => {
    const foreign = `/objects/uploads/${ids.other}/00000000-0000-4000-8000-000000000001`;
    expect((await create({ ...body(`${nonce}-document`), supportingDocumentUrl: foreign } as unknown as ReturnType<typeof body>)).status).toBe(400);
    expect((await request(app).patch(`/api/referral-drafts/${draftId}`).set("Cookie", cookies.coordinator)
      .send({ ...body(`${nonce}-first`), supportingDocumentUrl: foreign })).status).toBe(400);
    const path = `/objects/uploads/${ids.coordinator}/00000000-0000-4000-8000-000000000001`;
    await request(app).patch(`/api/referral-drafts/${draftId}`).set("Cookie", cookies.coordinator)
      .send({ ...body(`${nonce}-first`), supportingDocumentUrl: path }).expect(200);
    const lookup = vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue({} as never);
    const restored = await list("coordinator", draftId);
    expect(restored.body.items[0]).toMatchObject({ supportingDocumentUrl: path, documentRestoreFailed: false });
    expect(lookup).toHaveBeenCalledWith(path);
  });
  it("drops missing or foreign document paths on restore, but not on transient storage errors", async () => {
    const path = `/objects/uploads/${ids.coordinator}/00000000-0000-4000-8000-000000000001`;
    const lookup = vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockRejectedValue(new ObjectNotFoundError());
    const missing = await list("coordinator", draftId);
    expect(missing.body.items[0]).toMatchObject({ supportingDocumentUrl: null, documentRestoreFailed: true });
    const foreign = `/objects/uploads/${ids.other}/00000000-0000-4000-8000-000000000001`;
    await db.update(referralDraftsTable).set({ supportingDocumentUrl: foreign }).where(eq(referralDraftsTable.id, draftId));
    lookup.mockClear();
    expect((await list("coordinator", draftId)).body.items[0].documentRestoreFailed).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    await db.update(referralDraftsTable).set({ supportingDocumentUrl: path }).where(eq(referralDraftsTable.id, draftId));
    lookup.mockRejectedValue(new Error("Temporary storage outage"));
    expect((await list("coordinator", draftId)).status).toBe(500);
    expect((await db.select().from(referralDraftsTable).where(eq(referralDraftsTable.id, draftId)))[0].supportingDocumentUrl).toBe(path);
    await db.update(referralDraftsTable).set({ supportingDocumentUrl: null }).where(eq(referralDraftsTable.id, draftId));
  });
  it("deletes the old coordinator's participant draft on reassignment", async () => {
    const d = await create(body(`${nonce}-assigned`)); expect(d.status).toBe(201);
    const other = await create(body(`${nonce}-assigned`), "other"); expect(other.status).toBe(201);
    const reassigned = await request(app).patch(`/api/clients/${clientId}`).set("Cookie", cookies.staff)
      .send({ assignedCoordinatorId: ids.other });
    expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);
    expect((await list("coordinator", d.body.id)).status).toBe(404);
    expect((await list("other", other.body.id)).status).toBe(200);
  });
  it.each([["deactivatePatch", "patch"], ["deactivateDelete", "delete"]])("deletes all drafts when %s is deactivated", async (who, method) => {
    expect((await create(body(`${nonce}-${who}`), who)).status).toBe(201);
    const r = method === "patch"
      ? await request(app).patch(`/api/users/${ids[who]}`).set("Cookie", cookies.staff).send({ active: false })
      : await request(app).delete(`/api/users/${ids[who]}`).set("Cookie", cookies.staff);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await db.select().from(referralDraftsTable).where(eq(referralDraftsTable.userId, ids[who]))).toHaveLength(0);
    expect((await create(body(`${nonce}-late-save`), who)).status).not.toBe(201);
  });
  it("submits an owned draft atomically and preserves it when submission is rejected", async () => {
    const uci = `${nonce}-submit`;
    const d = await create(body(uci));
    expect(d.status).toBe(201);
    const invalid = await request(app).post("/api/referrals").set("Cookie", cookies.coordinator).send({ draftId: d.body.id, intakeFields: {} });
    expect(invalid.status).toBe(400); expect((await list("coordinator", d.body.id)).status).toBe(200);
    const wrong = await request(app).post("/api/referrals").set("Cookie", cookies.other)
      .send({ draftId: d.body.id, intakeFields: intake(uci) });
    expect(wrong.status).toBe(404);
    const created = await request(app).post("/api/referrals").set("Cookie", cookies.coordinator)
      .send({ draftId: d.body.id, submittedVia: "portal", intakeFields: intake(uci) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await list("coordinator", d.body.id)).status).toBe(404);
  });
  it("also cleans up on pending-review submission and staff-approved reassignment", async () => {
    const uci = `${nonce}-assigned`;
    const d = await create(body(uci)); expect(d.status).toBe(201);
    const submitted = await request(app).post("/api/referrals").set("Cookie", cookies.coordinator)
      .send({ draftId: d.body.id, submittedVia: "portal", intakeFields: intake(uci) });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    expect((await list("coordinator", d.body.id)).status).toBe(404);
    const reviewed = await request(app).post(`/api/referrals/${submitted.body.id}/coordinator-review`).set("Cookie", cookies.staff)
      .send({ decision: "approve", applyPhone: false, applyEmail: false, applyAddress: false, applyPreferredLanguage: false,
        applyMinorStatus: false, applyFamilyRepresentative: false, reassignAsAssignedCoordinator: true });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expect((await list("other")).body.items.some((d: { uciNumber: string }) => d.uciNumber === uci)).toBe(false);
  });
});
