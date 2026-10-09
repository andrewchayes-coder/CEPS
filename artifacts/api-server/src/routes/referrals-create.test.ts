import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray, eq, and, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  referralsTable,
  auditLogTable,
  familyRepresentativesTable,
  magicLinksTable,
  unmatchedPosDocumentsTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmationSections } from "../lib/referral-confirmation-pdf";

// POST /referrals — supportingDocumentUrl round-trip.
const nonce = `refcr${Date.now().toString(36)}`;

let staffId: string;
let staffCookie: string;
const createdReferralIds: string[] = [];
const createdClientUcis: string[] = [];
const createdVendorNames: string[] = [];
const createdQueueIds: string[] = [];
const createdLinkedUserIds: string[] = [];

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

function baseIntake(clientUci: string, vendorName: string) {
  return {
    regionalCenterName: "Alta California Regional Center",
    coordinatorName: "Test Coord",
    coordinatorEmail: "coord@test.local",
    coordinatorPhone: "5551234567",
    vendorAcceptsChecks: true,
    vendorName,
    vendorEmail: "vendor@test.local",
    vendorPhone: "5559876543",
    vendorServiceStreet: "1 Main St",
    vendorServiceCity: "Sacramento",
    vendorServiceZip: "95814",
    vendorServiceState: "CA",
    vendorBillingDifferent: "no",
    serviceType: "direct_pay_459",
    activityDescription: "Weekly therapy",
    serviceStartDate: "2026-02-01",
    serviceEndDate: "2026-06-01",
    authAmount: "123.45",
    clientFirstName: "Create",
    clientLastName: "Tester",
    clientDob: "2015-05-05",
    clientUci,
    preferredLanguage: "English",
    clientIsMinor: true,
    familyRepName: "Parent Tester",
    contactPhone: "5550001111",
    contactEmail: "parent@test.local",
    contactStreet: "2 Elm St",
    contactCity: "Sacramento",
    contactZip: "95814",
    contactState: "CA",
  } as Record<string, unknown> & { clientUci: string };
}

it.each([
  { fields: { authAmount: undefined }, error: 'Authorization amount is required' },
  { fields: { authAmount: '0.00' }, error: 'positive authorization amount' },
  { fields: { authAmount: '-1.00' }, error: 'positive authorization amount' },
  { fields: { authAmount: '1.234' }, error: 'two decimal places' },
  { fields: { serviceStartDate: undefined }, error: 'Service start date is required' },
  { fields: { serviceEndDate: undefined }, error: 'Service end date is required' },
  { fields: { serviceEndDate: '2026-01-01' }, error: 'on or after service start date' },
  { fields: { serviceEndDate: '2026-02-30' }, error: 'valid date' },
])('rejects invalid new referral service fields: $error ($fields)', async ({ fields, error }) => {
  const suffix = `${createdClientUcis.length}-invalid-service`;
  const uci = `${nonce}-${suffix}`, vendorName = `${nonce}-${suffix}-vendor`;
  createdClientUcis.push(uci);
  createdVendorNames.push(vendorName);
  const response = await request(app).post('/api/referrals').set('Cookie', staffCookie).send({
    intakeFields: { ...baseIntake(uci, vendorName), ...fields },
  });
  expect(response.status).toBe(400);
  expect(response.body.error).toContain(error);
  expect(await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci))).toHaveLength(0);
});

it('normalizes the amount, accepts equal dates without a POS number, and merges valid staff edits', async () => {
  const uci = `${nonce}-service-edit`, vendorName = `${nonce}-service-edit-vendor`;
  createdClientUcis.push(uci);
  createdVendorNames.push(vendorName);
  const response = await request(app).post('/api/referrals').set('Cookie', staffCookie).send({
    serviceFrequency: 'monthly',
    intakeFields: { ...baseIntake(uci, vendorName), serviceEndDate: '2026-02-01', authAmount: '000123.4' },
  });
  if (response.body.id) createdReferralIds.push(response.body.id);
  expect(response.status).toBe(201);
  expect(response.body.intakeFields).toMatchObject({ authAmount: '123.40', serviceFrequency: 'monthly' });
  const invalid = await request(app).patch(`/api/referrals/${response.body.id}`).set('Cookie', staffCookie)
    .send({ intakeFields: { serviceEndDate: '2026-01-01' } });
  expect(invalid.status).toBe(400);
  const edited = await request(app).patch(`/api/referrals/${response.body.id}`).set('Cookie', staffCookie)
    .send({ intakeFields: { authAmount: '45.6', serviceEndDate: '2026-03-01' } });
  expect(edited.status).toBe(200);
  expect(edited.body.intakeFields).toMatchObject({
    authAmount: '45.60', serviceStartDate: '2026-02-01', serviceEndDate: '2026-03-01', vendorName,
    activityDescription: 'Weekly therapy', serviceFrequency: 'monthly',
  });
  const owner = await makeCoordinator('Service field owner');
  expect((await request(app).patch(`/api/referrals/${response.body.id}`).set('Cookie', staffCookie)
    .send({ serviceCoordinatorId: owner.id })).status).toBe(200);
  expect((await request(app).patch(`/api/referrals/${response.body.id}`).set('Cookie', owner.cookie)
    .send({ intakeFields: { authAmount: '99.00' } })).status).toBe(403);

  const [legacy] = await db.insert(referralsTable).values({
    clientId: response.body.clientId, referralDate: '2026-01-01', status: 'intake', intakeFields: { vendorName },
  }).returning();
  createdReferralIds.push(legacy.id);
  expect((await request(app).get(`/api/referrals/${legacy.id}`).set('Cookie', staffCookie)).status).toBe(200);
  const legacyEdited = await request(app).patch(`/api/referrals/${legacy.id}`).set('Cookie', staffCookie).send({ notes: 'Legacy note' });
  expect(legacyEdited.status).toBe(200);
  expect(legacyEdited.body.intakeFields).toEqual({ vendorName });
});

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "RFCr Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  staffCookie = await session(staffId);
});

afterAll(async () => {
  if (createdQueueIds.length) {
    await db.delete(unmatchedPosDocumentsTable).where(inArray(unmatchedPosDocumentsTable.id, createdQueueIds));
  }
  if (createdReferralIds.length) {
    await db.delete(referralsTable).where(inArray(referralsTable.id, createdReferralIds));
  }
  if (createdClientUcis.length) {
    const referralClients = await db.select({ id: clientsTable.id }).from(clientsTable)
      .where(inArray(clientsTable.uciNumber, createdClientUcis));
    if (referralClients.length) {
      await db.delete(referralsTable).where(inArray(referralsTable.clientId, referralClients.map((c) => c.id)));
    }
  }
  if (createdVendorNames.length) {
    await db.delete(vendorsTable).where(inArray(vendorsTable.name, createdVendorNames));
  }
  if (createdClientUcis.length) {
    const repClients = await db.select({ id: clientsTable.id }).from(clientsTable)
      .where(inArray(clientsTable.uciNumber, createdClientUcis));
    if (repClients.length) {
      await db.delete(familyRepresentativesTable).where(inArray(familyRepresentativesTable.clientId, repClients.map((c) => c.id)));
    }
  }
  if (createdClientUcis.length) {
    await db.delete(clientsTable).where(inArray(clientsTable.uciNumber, createdClientUcis));
  }
  if (createdLinkedUserIds.length) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.userId, createdLinkedUserIds));
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, createdLinkedUserIds));
    await db.delete(usersTable).where(inArray(usersTable.id, createdLinkedUserIds));
  }
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
});

async function makeCoordinator(label: string) {
  const [coordinator] = await db.insert(usersTable).values({
    name: `${nonce} ${label}`,
    email: `${nonce}-${label.toLowerCase().replaceAll(" ", "-")}@test.local`,
    role: "service_coordinator",
  }).returning();
  createdLinkedUserIds.push(coordinator.id);
  return { id: coordinator.id, cookie: await session(coordinator.id) };
}

describe("Referral confirmation and submission receipts", () => {
  it("does not add unentered optional family contact information from a linked participant", () => {
    const sections = confirmationSections({
      intakeFields: { clientUci: "receipt-uci", clientIsMinor: false },
    } as typeof referralsTable.$inferSelect, {
      familyRepName: "Not entered", familyRepPhone: "Not entered",
      familyRepEmail: "not-entered@example.test", familyRepAddress: "Not entered",
      email: "not-entered@example.test", phone: "Not entered", address: "Not entered",
    } as typeof clientsTable.$inferSelect);
    const family = sections.find(([label]) => label === "Family representative")!;
    expect(family[1].every(([, value]) => value == null)).toBe(true);
    const participant = sections.find(([label]) => label === "Participant")!;
    expect(participant[1].filter(([label]) => ["Contact email", "Contact phone", "Mailing street"].includes(label))
      .every(([, value]) => value == null)).toBe(true);
  });
  it("keeps download-only access after reassignment, generates saved data and audits authorized downloads", async () => {
    const original = await makeCoordinator("Confirmation Original");
    const current = await makeCoordinator("Confirmation Current");
    const other = await makeCoordinator("Confirmation Other");
    const uci = `${nonce}-confirmation`;
    const vendorName = `${nonce}-confirmation-vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const path = `/objects/uploads/${original.id}/${randomUUID()}`;
    await db.insert(auditLogTable).values({
      userId: original.id, action: "file.upload_requested", entityType: "upload", entityId: path,
      detail: "classes-receipt.pdf (application/pdf, 123 bytes)",
    });
    const created = await request(app).post("/api/referrals").set("Cookie", original.cookie).send({
      supportingDocumentUrl: path,
      serviceFrequency: "monthly",
      intakeFields: { ...baseIntake(uci, vendorName), clientLastName: "Tester 李",
        activityDescription: "A long saved activity description. ".repeat(150) },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    createdReferralIds.push(id);
    await db.update(referralsTable).set({ serviceCoordinatorId: current.id }).where(eq(referralsTable.id, id));
    expect((await request(app).get(`/api/referrals/${id}`).set("Cookie", original.cookie)).status).toBe(403);
    const pdfs = [];
    for (const cookie of [staffCookie, original.cookie, current.cookie]) {
      const response = await request(app).get(`/api/referrals/${id}/confirmation.pdf`).set("Cookie", cookie);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toMatch(/^application\/pdf/);
      expect(response.headers["cache-control"]).toContain("no-store");
      expect(Buffer.isBuffer(response.body)).toBe(true);
      pdfs.push(response.body);
    }
    expect((await request(app).get(`/api/referrals/${id}/confirmation.pdf`).set("Cookie", other.cookie)).status).toBe(403);
    for (const role of ["parent_guardian", "vendor", "self"]) {
      const [person] = await db.insert(usersTable).values({
        name: `${nonce} ${role}`, email: `${nonce}-confirmation-${role}@test.local`,
        role, linkedRecordType: "client", linkedRecordId: created.body.clientId,
      }).returning();
      createdLinkedUserIds.push(person.id);
      expect((await request(app).get(`/api/referrals/${id}/confirmation.pdf`).set("Cookie", await session(person.id))).status).toBe(403);
    }
    const events = await db.select().from(auditLogTable).where(and(eq(auditLogTable.entityId, id), eq(auditLogTable.action, "download_referral_confirmation")));
    expect(events).toHaveLength(3);
    const dir = mkdtempSync(join(tmpdir(), "ceps-confirmation-"));
    try {
      const file = join(dir, "confirmation.pdf");
      writeFileSync(file, pdfs[0]);
      const text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
      expect(text).toContain(uci);
      expect(text).toContain("$123.45");
      expect(text).toContain("2026-06-01");
      expect(text.replace(/\s+/g, " ")).toContain("Tester 李");
      expect(text).toContain("classes-receipt.pdf");
      expect(text).toContain("Page 1 of");
      expect(text).toContain("Page 3 of");
      expect(text).toContain("not an authorization or an agreement");
      expect(text).not.toContain("/objects/uploads/");
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const mine = await request(app).get("/api/referrals?submittedByMe=true").set("Cookie", original.cookie);
    expect(mine.status).toBe(200);
    const receipt = mine.body.items.find((item: { id: string }) => item.id === id);
    expect(Object.keys(receipt).sort()).toEqual(["clientName", "id", "referralDate", "status"]);
    expect(receipt.clientName).toBe("Create Tester 李");
    const regular = await request(app).get("/api/referrals?submittedByMe=false").set("Cookie", original.cookie);
    expect(regular.body.items.some((item: { id: string }) => item.id === id)).toBe(false);
    expect((await request(app).get("/api/referrals?submittedByMe=true").set("Cookie", other.cookie)).body.items).toEqual([]);
    expect((await request(app).get("/api/referrals?submittedByMe=true").set("Cookie", staffCookie)).status).toBe(403);
    expect((await request(app).get("/api/referrals?submittedByMe=invalid").set("Cookie", original.cookie)).status).toBe(400);
  });
});

describe("POST /referrals supporting documents", () => {
  it.each([undefined, "", "   "])("rejects a minor without a family representative name (%s)", async familyRepName => {
    const response = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      intakeFields: { ...baseIntake(`${nonce}-missing-parent`, `${nonce}-missing-parent-vendor`), familyRepName },
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Family representative name is required for minors");
  });

  it("reuses a vendor by trimmed case-insensitive name and links it to the referral", async () => {
    const uci = `${nonce}-case-insensitive-vendor`;
    createdClientUcis.push(uci);
    const existingVendorName = `${nonce} Case Reuse Vendor`;
    const [existingVendor] = await db.insert(vendorsTable).values({
      name: existingVendorName,
    }).returning();
    createdVendorNames.push(existingVendorName);

    const response = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: baseIntake(uci, `  ${existingVendorName.toUpperCase()}  `),
    });

    expect(response.status).toBe(201);
    createdReferralIds.push(response.body.id);
    const [referral] = await db.select().from(referralsTable).where(eq(referralsTable.id, response.body.id));
    expect(referral.vendorId).toBe(existingVendor.id);
    const matchingVendors = await db.select().from(vendorsTable)
      .where(eq(vendorsTable.name, existingVendorName));
    expect(matchingVendors).toHaveLength(1);
  });

  it("suggests eligible POS rows with normalized UCI before falling back to normalized name", async () => {
    const uci = `${nonce}-suggest  uci`;
    const vendorName = `${nonce} Suggest Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [uciRow] = await db.insert(unmatchedPosDocumentsTable).values({
      posPdfUrl: `/objects/${nonce}-uci.pdf`, sourceFileName: `${nonce}-uci.pdf`,
      uciNumber: `  ${uci.replace("  ", "     ")} `, clientName: "Different Person", createdBy: staffId,
    }).returning();
    const [nameRow] = await db.insert(unmatchedPosDocumentsTable).values({
      posPdfUrl: `/objects/${nonce}-name.pdf`, sourceFileName: `${nonce}-name.pdf`,
      clientName: "Create   Tester", createdBy: staffId,
    }).returning();
    createdQueueIds.push(uciRow.id, nameRow.id);
    const res = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry", intakeFields: baseIntake(uci, vendorName),
    });
    expect(res.status).toBe(201);
    const rows = await db.select().from(unmatchedPosDocumentsTable)
      .where(inArray(unmatchedPosDocumentsTable.id, [uciRow.id, nameRow.id]));
    expect(rows.find((row) => row.id === uciRow.id)).toMatchObject({
      suggestedClientId: res.body.clientId, suggestionMethod: "uci",
    });
    expect(rows.find((row) => row.id === nameRow.id)).toMatchObject({
      suggestedClientId: res.body.clientId, suggestionMethod: "name",
    });
  });

  it("round-trips supportingDocumentUrl and does not expose deprecated fields", async () => {
    const uci = `${nonce}-uci1`;
    const vendorName = `${nonce} Vendor1`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);

    const res = await request(app)
      .post("/api/referrals")
      .set("Cookie", staffCookie)
      .send({
        submittedVia: "portal",
        serviceFrequency: "monthly",
        parentEmail: "must-not-send@test.local",
        supportingDocumentUrl: "/objects/uploads/doc-123",
        intakeFields: baseIntake(uci, vendorName),
      });

    expect(res.status).toBe(201);
    createdReferralIds.push(res.body.id);
    expect(res.body.supportingDocumentUrl).toBe("/objects/uploads/doc-123");
    expect(res.body).not.toHaveProperty("diagnosis");
    expect(res.body).not.toHaveProperty("eligibilityCategory");
    expect(res.body.status).toBe("intake");
    expect(res.body.parentEmail).toBeNull();
    expect(res.body.intakeSentAt).toBeNull();

    // Fetch it back to confirm persistence.
    const get = await request(app).get(`/api/referrals/${res.body.id}`).set("Cookie", staffCookie);
    expect(get.status).toBe(200);
    expect(get.body.supportingDocumentUrl).toBe("/objects/uploads/doc-123");
    expect(get.body).not.toHaveProperty("diagnosis");
    expect(get.body).not.toHaveProperty("eligibilityCategory");
  });

  it("normalizes '' to null for the optional document field", async () => {
    const uci = `${nonce}-uci2`;
    const vendorName = `${nonce} Vendor2`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);

    const res = await request(app)
      .post("/api/referrals")
      .set("Cookie", staffCookie)
      .send({
        submittedVia: "portal",
        serviceFrequency: "one_time",
        supportingDocumentUrl: "",
        intakeFields: baseIntake(uci, vendorName),
      });

    expect(res.status).toBe(201);
    createdReferralIds.push(res.body.id);
    expect(res.body.supportingDocumentUrl).toBeNull();

    // Confirm the DB row actually stored NULL (not the empty string).
    const [row] = await db.select().from(referralsTable).where(eq(referralsTable.id, res.body.id));
    expect(row.supportingDocumentUrl).toBeNull();
  });

  it("omitting the document field stores null", async () => {
    const uci = `${nonce}-uci3`;
    const vendorName = `${nonce} Vendor3`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);

    const res = await request(app)
      .post("/api/referrals")
      .set("Cookie", staffCookie)
      .send({
        submittedVia: "portal",
        serviceFrequency: "monthly",
        intakeFields: baseIntake(uci, vendorName),
      });

    expect(res.status).toBe(201);
    createdReferralIds.push(res.body.id);
    expect(res.body.supportingDocumentUrl).toBeNull();
  });
});

describe("POST /referrals client contact and family representative carryover", () => {
  it("holds a coordinator's unrelated existing-client UCI for staff review without exposing or mutating client data", async () => {
    const coordinator = await makeCoordinator("Unauthorized Coordinator");
    const assignedCoordinator = await makeCoordinator("Different Assigned Coordinator");
    const uci = `${nonce}-unauthorized-existing-client`;
    const vendorName = `${nonce} Unauthorized Existing Client Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [client] = await db.insert(clientsTable).values({
      firstName: "Protected",
      lastName: "Participant",
      dateOfBirth: "2015-05-05",
      uciNumber: uci,
      preferredLanguage: "English",
      assignedCoordinatorId: assignedCoordinator.id,
      isMinor: true,
    }).returning();
    const [existingRep] = await db.insert(familyRepresentativesTable).values({
      clientId: client.id,
      name: "Existing Representative",
      relationship: "guardian",
      phone: "555-existing",
      email: "old@example.test",
      address: "Old address",
      createdBy: assignedCoordinator.id,
    }).returning();

    const response = await request(app).post("/api/referrals").set("Cookie", coordinator.cookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        preferredLanguage: "Spanish",
      },
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      id: expect.any(String),
      status: "pending_review",
      message: "Referral submitted. CEPS will review it and follow up with you.",
    });
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await request(app).get(`/api/referrals/${response.body.id}/confirmation.pdf`).set("Cookie", coordinator.cookie)).status).toBe(200);
    const receipts = await request(app).get("/api/referrals?submittedByMe=true").set("Cookie", coordinator.cookie);
    const receipt = receipts.body.items.find((row: { id: string }) => row.id === response.body.id);
    expect(receipt.status).toBe("pending_review");
    expect(Object.keys(receipt).sort()).toEqual(["clientName", "id", "referralDate", "status"]);
    expect(JSON.stringify(response.body)).not.toContain(client.id);
    expect(JSON.stringify(response.body)).not.toContain(uci);
    const [heldReferral] = await db.select().from(referralsTable).where(eq(referralsTable.clientId, client.id));
    createdReferralIds.push(heldReferral.id);
    expect(heldReferral).toMatchObject({
      serviceCoordinatorId: null,
      submittedByUserId: coordinator.id,
      coordinatorReviewStatus: "pending",
      status: "intake",
    });
    const [unchanged] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(unchanged).toMatchObject({
      preferredLanguage: "English",
      phone: null,
      email: null,
      address: null,
      isMinor: true,
      assignedCoordinatorId: assignedCoordinator.id,
    });
    expect(await db.select().from(familyRepresentativesTable).where(
      eq(familyRepresentativesTable.clientId, client.id),
    )).toEqual([expect.objectContaining({ id: existingRep.id })]);
    expect(await db.select().from(vendorsTable).where(eq(vendorsTable.name, vendorName))).toHaveLength(1);
    expect(await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.userId, coordinator.id),
      eq(auditLogTable.action, "referral_held_for_coordinator_review"),
    ))).toHaveLength(1);
    expect(await db.select().from(magicLinksTable).where(eq(magicLinksTable.referralId, heldReferral.id))).toHaveLength(0);
    expect((await request(app).get(`/api/referrals/${heldReferral.id}`).set("Cookie", coordinator.cookie)).status).toBe(403);
    expect((await request(app).get(`/api/clients/${client.id}`).set("Cookie", coordinator.cookie)).status).toBe(403);
    expect((await request(app).get("/api/referrals").query({ search: uci }).set("Cookie", coordinator.cookie)).body.total).toBe(0);
  });

  it("allows a coordinator assigned to an existing client to submit the referral", async () => {
    const coordinator = await makeCoordinator("Assigned Client Coordinator");
    const uci = `${nonce}-assigned-coordinator-client`;
    const vendorName = `${nonce} Assigned Coordinator Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [client] = await db.insert(clientsTable).values({
      firstName: "Assigned",
      lastName: "Participant",
      dateOfBirth: "1990-05-05",
      uciNumber: uci,
      preferredLanguage: "English",
      assignedCoordinatorId: coordinator.id,
      isMinor: false,
    }).returning();

    const response = await request(app).post("/api/referrals").set("Cookie", coordinator.cookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        clientIsMinor: false,
        preferredLanguage: "Spanish",
        familyRepName: "",
        contactPhone: "",
        contactEmail: "",
        contactStreet: "",
        contactCity: "",
        contactState: "",
        contactZip: "",
      },
    });
    expect(response.status).toBe(201);
    const [updated] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(updated.preferredLanguage).toBe("Spanish");
  });

  it("allows a coordinator who owns an active referral even when another coordinator is assigned to the client", async () => {
    const referralOwner = await makeCoordinator("Existing Referral Owner");
    const assignedCoordinator = await makeCoordinator("Referral Owner Different Assignee");
    const uci = `${nonce}-referral-owner-client`;
    const vendorName = `${nonce} Referral Owner Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [client] = await db.insert(clientsTable).values({
      firstName: "Referral",
      lastName: "Owned Participant",
      dateOfBirth: "1990-05-05",
      uciNumber: uci,
      preferredLanguage: "English",
      assignedCoordinatorId: assignedCoordinator.id,
      isMinor: false,
    }).returning();
    const [existingReferral] = await db.insert(referralsTable).values({
      clientId: client.id,
      serviceCoordinatorId: referralOwner.id,
      referralDate: "2026-01-15",
      status: "active",
    }).returning();
    createdReferralIds.push(existingReferral.id);

    const response = await request(app).post("/api/referrals").set("Cookie", referralOwner.cookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        clientIsMinor: false,
        preferredLanguage: "Ukrainian",
        familyRepName: "",
        contactPhone: "",
        contactEmail: "",
        contactStreet: "",
        contactCity: "",
        contactState: "",
        contactZip: "",
      },
    });
    expect(response.status).toBe(201);
    const [updated] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(updated.preferredLanguage).toBe("Ukrainian");
  });

  it("still allows a coordinator to create a new client through referral intake", async () => {
    const coordinator = await makeCoordinator("New Client Intake Coordinator");
    const uci = `${nonce}-coordinator-new-client`;
    const vendorName = `${nonce} Coordinator New Client Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);

    const response = await request(app).post("/api/referrals").set("Cookie", coordinator.cookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: baseIntake(uci, vendorName),
    });
    expect(response.status).toBe(201);
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci));
    expect(client).toMatchObject({
      preferredLanguage: "English",
      assignedCoordinatorId: coordinator.id,
    });
  });

  it("stores the trimmed preferred language for a new client", async () => {
    const uci = `${nonce}-new-language`;
    const vendorName = `${nonce} New Language Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const response = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        preferredLanguage: "  Spanish  ",
      },
    });

    expect(response.status).toBe(201);
    createdReferralIds.push(response.body.id);
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci));
    expect(client.preferredLanguage).toBe("Spanish");
    const [referral] = await db.select().from(referralsTable).where(eq(referralsTable.id, response.body.id));
    expect((referral.intakeFields as Record<string, unknown>).preferredLanguage).toBe("Spanish");
  });

  it("updates an existing adult's preferred language and audits a language-only change", async () => {
    const uci = `${nonce}-adult-language`;
    const vendorName = `${nonce} Adult Language Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [client] = await db.insert(clientsTable).values({
      firstName: "Existing",
      lastName: "Adult Language",
      dateOfBirth: "1990-05-05",
      uciNumber: uci,
      preferredLanguage: "English",
      isMinor: false,
      phone: "555-existing",
      email: "existing@example.test",
      address: "Existing Road",
    }).returning();

    const response = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        clientIsMinor: false,
        preferredLanguage: "  Ukrainian ",
        contactPhone: "",
        contactEmail: "",
        contactStreet: "",
        contactCity: "",
        contactState: "",
        contactZip: "",
      },
    });
    expect(response.status).toBe(201);

    const [updated] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(updated).toMatchObject({
      preferredLanguage: "Ukrainian",
      phone: "555-existing",
      email: "existing@example.test",
      address: "Existing Road",
    });
    const languageAudits = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.userId, staffId),
      eq(auditLogTable.entityId, client.id),
      eq(auditLogTable.action, "update_client_contact_from_referral"),
    ));
    expect(languageAudits).toHaveLength(1);
    expect(languageAudits[0].detail).toContain('preferredLanguage: "English" -> "Ukrainian"');

    const unchangedResponse = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, `${nonce} Unchanged Language Vendor`),
        clientIsMinor: false,
        preferredLanguage: "Ukrainian",
        contactPhone: "",
        contactEmail: "",
        contactStreet: "",
        contactCity: "",
        contactState: "",
        contactZip: "",
      },
    });
    createdVendorNames.push(`${nonce} Unchanged Language Vendor`);
    expect(unchangedResponse.status).toBe(201);
    const sameLanguageAudits = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.userId, staffId),
      eq(auditLogTable.entityId, client.id),
      eq(auditLogTable.action, "update_client_contact_from_referral"),
    ));
    expect(sameLanguageAudits).toHaveLength(1);
  });

  it("updates preferred language on an existing minor when referral contact is a family representative", async () => {
    const uci = `${nonce}-minor-language`;
    const vendorName = `${nonce} Minor Language Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [client] = await db.insert(clientsTable).values({
      firstName: "Existing",
      lastName: "Minor Language",
      dateOfBirth: "2015-05-05",
      uciNumber: uci,
      preferredLanguage: "English",
      isMinor: true,
      phone: "555-participant",
      email: "participant@example.test",
      address: "Participant Road",
    }).returning();

    const response = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        preferredLanguage: "Vietnamese",
        familyRepName: "Language Guardian",
      },
    });
    expect(response.status).toBe(201);

    const [updated] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(updated).toMatchObject({
      preferredLanguage: "Vietnamese",
      phone: "555-participant",
      email: "participant@example.test",
      address: "Participant Road",
    });
    const languageAudits = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.userId, staffId),
      eq(auditLogTable.entityId, client.id),
      eq(auditLogTable.action, "update_client_contact_from_referral"),
    ));
    expect(languageAudits).toHaveLength(1);
    expect(languageAudits[0].detail).toContain('preferredLanguage: "English" -> "Vietnamese"');
  });

  it("rejects missing, empty, or whitespace-only preferred language before writing", async () => {
    for (const [suffix, preferredLanguage] of [
      ["missing", undefined],
      ["empty", ""],
      ["whitespace", " \t\n "],
    ] as const) {
      const uci = `${nonce}-blank-language-${suffix}`;
      const vendorName = `${nonce} Blank Language ${suffix}`;
      createdClientUcis.push(uci);
      const intakeFields = {
        ...baseIntake(uci, vendorName),
        preferredLanguage,
      };
      if (preferredLanguage === undefined) delete (intakeFields as { preferredLanguage?: string }).preferredLanguage;
      const response = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
        submittedVia: "staff_manual_entry",
        intakeFields,
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("Preferred language is required");
      expect(await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci))).toHaveLength(0);
      expect(await db.select().from(vendorsTable).where(eq(vendorsTable.name, vendorName))).toHaveLength(0);
      expect(await db.select().from(referralsTable).where(
        sql`client_id in (select id from clients where uci_number = ${uci})`,
      )).toHaveLength(0);
    }
  });

  it("backfills blank contact fields, overwrites differing values with an audit, and does not erase on blank intake", async () => {
    const uci = `${nonce}-existing-contact`;
    const vendorName = `${nonce} Existing Contact Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [client] = await db.insert(clientsTable).values({
      firstName: "Existing",
      lastName: "Contact",
      dateOfBirth: "2015-05-05",
      uciNumber: uci,
      isMinor: false,
      phone: "555-old",
      email: null,
      address: null,
    }).returning();

    const firstIntake = {
      ...baseIntake(uci, vendorName),
      clientIsMinor: false,
      contactPhone: "555-new",
      contactEmail: "new@example.test",
      contactStreet: "10 New Street",
      contactCity: "Sacramento",
      contactState: "CA",
      contactZip: "95814",
    };
    const first = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: firstIntake,
    });
    expect(first.status).toBe(201);
    const [backfilled] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(backfilled.phone).toBe("555-new");
    expect(backfilled.email).toBe("new@example.test");
    expect(backfilled.address).toBe("10 New Street, Sacramento, CA, 95814");
    const overwriteAudit = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.userId, staffId),
      eq(auditLogTable.entityId, client.id),
      eq(auditLogTable.action, "update_client_contact_from_referral"),
    ));
    expect(overwriteAudit).toHaveLength(1);
    expect(overwriteAudit[0].detail).toContain("phone");
    expect(overwriteAudit[0].detail).toContain("555-old");
    expect(overwriteAudit[0].detail).toContain("555-new");

    const second = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, `${nonce} Blank Contact Vendor`),
        clientIsMinor: false,
        contactPhone: "",
        contactEmail: " ",
        contactStreet: "",
        contactCity: "",
        contactState: "",
        contactZip: "",
      },
    });
    expect(second.status).toBe(201);
    const [unchanged] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(unchanged.phone).toBe("555-new");
    expect(unchanged.email).toBe("new@example.test");
    expect(unchanged.address).toBe("10 New Street, Sacramento, CA, 95814");
  });

  it("creates a canonical representative for a new minor without deprecated client columns or an account link", async () => {
    const uci = `${nonce}-new-minor-rep`;
    const vendorName = `${nonce} New Minor Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const res = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: baseIntake(uci, vendorName),
    });
    expect(res.status).toBe(201);
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci));
    expect(client.familyRepName).toBeNull();
    expect(client.familyRepPhone).toBeNull();
    expect(client.familyRepEmail).toBeNull();
    expect(client.familyRepAddress).toBeNull();
    const [rep] = await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId, client.id));
    expect(rep).toMatchObject({
      name: "Parent Tester",
      relationship: "parent",
      phone: "5550001111",
      email: "parent@test.local",
      address: "2 Elm St, Sacramento, CA, 95814",
      isPrimary: true,
      userId: null,
      createdBy: staffId,
    });
  });

  it("creates a representative for an existing minor and reuses an identical representative on retry", async () => {
    const uci = `${nonce}-existing-minor-rep`;
    const vendorName = `${nonce} Existing Minor Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    await db.insert(clientsTable).values({
      firstName: "Existing",
      lastName: "Minor",
      dateOfBirth: "2015-05-05",
      uciNumber: uci,
      isMinor: true,
    });
    const body = { submittedVia: "staff_manual_entry", intakeFields: baseIntake(uci, vendorName) };
    expect((await request(app).post("/api/referrals").set("Cookie", staffCookie).send(body)).status).toBe(201);
    expect((await request(app).post("/api/referrals").set("Cookie", staffCookie).send(body)).status).toBe(201);
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci));
    const reps = await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId, client.id));
    expect(reps).toHaveLength(1);
    expect(reps[0].isPrimary).toBe(true);
    expect(reps[0].userId).toBeNull();
  });

  it("reclassifies an existing minor on an explicit adult referral and stores contact on the client", async () => {
    const uci = `${nonce}-minor-to-adult`;
    const vendorName = `${nonce} Reclassified Adult Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [client] = await db.insert(clientsTable).values({
      firstName: "Existing",
      lastName: "Participant",
      dateOfBirth: "2000-05-05",
      uciNumber: uci,
      isMinor: true,
      phone: "555-original",
      email: "original@example.test",
      address: "Original Lane",
    }).returning();
    const [rep] = await db.insert(familyRepresentativesTable).values({
      clientId: client.id,
      name: "Existing Guardian",
      relationship: "guardian",
      phone: "555-guardian",
      isPrimary: true,
      createdBy: staffId,
    }).returning();

    const response = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        clientIsMinor: false,
        familyRepName: "",
        contactPhone: "555-adult",
        contactEmail: "adult@example.test",
        contactStreet: "Adult Lane",
      },
    });
    expect(response.status).toBe(201);
    const [updated] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(updated).toMatchObject({
      isMinor: false,
      phone: "555-adult",
      email: "adult@example.test",
      address: "Adult Lane, Sacramento, CA, 95814",
    });
    const reps = await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId, client.id));
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ id: rep.id, phone: "555-guardian", isPrimary: true });
    const statusAudits = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.entityId, client.id),
      eq(auditLogTable.action, "update_client_minor_status_from_referral"),
    ));
    expect(statusAudits).toHaveLength(1);
    expect(statusAudits[0].detail).toContain("true -> false");
  });

  it("keeps an existing primary when adding a different representative for an existing minor", async () => {
    const uci = `${nonce}-existing-minor-secondary-rep`;
    const vendorName = `${nonce} Existing Minor Secondary Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [client] = await db.insert(clientsTable).values({
      firstName: "Existing",
      lastName: "Minor With Rep",
      dateOfBirth: "2015-05-05",
      uciNumber: uci,
      isMinor: true,
    }).returning();
    const [existingPrimary] = await db.insert(familyRepresentativesTable).values({
      clientId: client.id,
      name: "Current Guardian",
      relationship: "guardian",
      phone: "555-current",
      email: "current@example.test",
      address: "1 Existing Road",
      isPrimary: true,
      userId: null,
      createdBy: staffId,
    }).returning();

    const res = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        clientIsMinor: true,
        familyRepName: "New Guardian",
        familyRepRelationship: "guardian",
        contactPhone: "555-new-guardian",
        contactEmail: "new-guardian@example.test",
        contactStreet: "2 New Guardian Road",
      },
    });
    expect(res.status).toBe(201);

    const reps = await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId, client.id));
    expect(reps).toHaveLength(2);
    expect(reps.find((rep) => rep.id === existingPrimary.id)).toMatchObject({
      name: "Current Guardian",
      isPrimary: true,
    });
    expect(reps.find((rep) => rep.name === "New Guardian")?.isPrimary).toBe(false);
    expect(reps.filter((rep) => rep.isPrimary)).toHaveLength(1);
  });

  it("creates an optional adult representative separately from the participant contact", async () => {
    const uci = `${nonce}-adult-with-rep`;
    const vendorName = `${nonce} Adult Rep Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const res = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        clientIsMinor: false,
        familyRepName: "Adult Participant Support",
        familyRepRelationship: "guardian",
        familyRepPhone: "555-family-phone",
        familyRepEmail: "family@example.test",
        familyRepAddress: "22 Family Lane, Sacramento, CA, 95814",
        contactPhone: "555-participant-phone",
        contactEmail: "participant@example.test",
        contactStreet: "10 Participant Street",
        contactCity: "Sacramento",
        contactState: "CA",
        contactZip: "95814",
      },
    });
    expect(res.status).toBe(201);
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci));
    expect(client).toMatchObject({
      isMinor: false,
      phone: "555-participant-phone",
      email: "participant@example.test",
      address: "10 Participant Street, Sacramento, CA, 95814",
    });
    const [rep] = await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId, client.id));
    expect(rep).toMatchObject({
      name: "Adult Participant Support",
      relationship: "guardian",
      phone: "555-family-phone",
      email: "family@example.test",
      address: "22 Family Lane, Sacramento, CA, 95814",
      isPrimary: true,
      userId: null,
    });
  });

  it("does not make a newly added adult representative primary when another representative exists", async () => {
    const uci = `${nonce}-adult-secondary-rep`;
    const vendorName = `${nonce} Adult Secondary Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [client] = await db.insert(clientsTable).values({
      firstName: "Existing",
      lastName: "Adult",
      dateOfBirth: "1990-05-05",
      uciNumber: uci,
      isMinor: false,
    }).returning();
    const [existingRep] = await db.insert(familyRepresentativesTable).values({
      clientId: client.id,
      name: "Existing Primary",
      relationship: "parent",
      isPrimary: true,
      userId: staffId,
      createdBy: staffId,
    }).returning();
    const body = {
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        clientIsMinor: false,
        familyRepName: "Additional Support",
        familyRepRelationship: "other",
        familyRepPhone: "555-secondary",
        familyRepEmail: "secondary@example.test",
        familyRepAddress: "42 Second Street",
      },
    };
    const first = await request(app).post("/api/referrals").set("Cookie", staffCookie).send(body);
    expect(first.status).toBe(201);
    const second = await request(app).post("/api/referrals").set("Cookie", staffCookie).send(body);
    expect(second.status).toBe(201);
    const reps = await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId, client.id));
    expect(reps).toHaveLength(2);
    expect(reps.find((rep) => rep.id === existingRep.id)).toMatchObject({
      name: "Existing Primary",
      userId: staffId,
      isPrimary: true,
    });
    expect(reps.find((rep) => rep.name === "Additional Support")?.isPrimary).toBe(false);
  });

  it("reuses a matching linked representative instead of creating a duplicate", async () => {
    const uci = `${nonce}-linked-rep-match`;
    const vendorName = `${nonce} Linked Rep Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [client] = await db.insert(clientsTable).values({
      firstName: "Existing",
      lastName: "Adult",
      dateOfBirth: "1990-05-05",
      uciNumber: uci,
      isMinor: false,
    }).returning();
    const [linkedUser] = await db.insert(usersTable).values({
      name: "Linked Support",
      email: `${nonce}-linked-rep@test.local`,
      role: "parent_guardian",
    }).returning();
    createdLinkedUserIds.push(linkedUser.id);
    const [linkedRep] = await db.insert(familyRepresentativesTable).values({
      clientId: client.id,
      name: "Linked Support",
      relationship: "guardian",
      phone: "555-linked",
      email: "linked@example.test",
      address: "7 Linked Road",
      isPrimary: true,
      userId: linkedUser.id,
      createdBy: staffId,
    }).returning();
    const res = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        clientIsMinor: false,
        familyRepName: "Linked Support",
        familyRepRelationship: "guardian",
        familyRepPhone: "555-linked",
        familyRepEmail: "linked@example.test",
        familyRepAddress: "7 Linked Road",
      },
    });
    expect(res.status).toBe(201);
    const reps = await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId, client.id));
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ id: linkedRep.id, userId: linkedUser.id, isPrimary: true });
  });

  it("does not copy an existing minor's intake representative contact onto the participant record", async () => {
    const uci = `${nonce}-existing-minor-contact`;
    const vendorName = `${nonce} Existing Minor Contact Vendor`;
    createdClientUcis.push(uci);
    createdVendorNames.push(vendorName);
    const [client] = await db.insert(clientsTable).values({
      firstName: "Existing",
      lastName: "Minor",
      dateOfBirth: "2015-05-05",
      uciNumber: uci,
      isMinor: true,
      phone: "555-participant-old",
      email: "participant-old@example.test",
      address: "1 Participant Road",
    }).returning();
    const res = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, vendorName),
        clientIsMinor: true,
        familyRepName: "New Guardian",
        familyRepRelationship: "guardian",
        contactPhone: "555-guardian",
        contactEmail: "guardian@example.test",
        contactStreet: "2 Guardian Road",
        contactCity: "Sacramento",
        contactState: "CA",
        contactZip: "95814",
      },
    });
    expect(res.status).toBe(201);
    const [savedClient] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(savedClient).toMatchObject({
      phone: "555-participant-old",
      email: "participant-old@example.test",
      address: "1 Participant Road",
    });
    const [rep] = await db.select().from(familyRepresentativesTable).where(eq(familyRepresentativesTable.clientId, client.id));
    expect(rep).toMatchObject({
      name: "New Guardian",
      relationship: "guardian",
      phone: "555-guardian",
      email: "guardian@example.test",
      address: "2 Guardian Road, Sacramento, CA, 95814",
    });
  });

  it("rejects an adult family representative relationship outside the supported values", async () => {
    const uci = `${nonce}-invalid-adult-rep-relationship`;
    const res = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, `${nonce} Invalid Relationship Vendor`),
        clientIsMinor: false,
        familyRepName: "Invalid Relationship Rep",
        familyRepRelationship: "neighbor",
        familyRepPhone: "555-neighbor",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("familyRepRelationship");
    const clients = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci));
    expect(clients).toHaveLength(0);
  });

  it("rejects adult family representative contact details when the name is missing", async () => {
    const uci = `${nonce}-adult-rep-without-name`;
    createdClientUcis.push(uci);
    const res = await request(app).post("/api/referrals").set("Cookie", staffCookie).send({
      submittedVia: "staff_manual_entry",
      intakeFields: {
        ...baseIntake(uci, `${nonce} Missing Rep Name Vendor`),
        clientIsMinor: false,
        familyRepName: "",
        familyRepPhone: "555-missing-name",
        familyRepEmail: "missing-name@example.test",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Family representative contact details require a family representative name");
    const clients = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, uci));
    expect(clients).toHaveLength(0);
  });
});
