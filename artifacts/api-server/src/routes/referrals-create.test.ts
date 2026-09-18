import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray, eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  referralsTable,
  auditLogTable,
  familyRepresentativesTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// POST /referrals — supportingDocumentUrl round-trip.
const nonce = `refcr${Date.now().toString(36)}`;

let staffId: string;
let staffCookie: string;
const createdReferralIds: string[] = [];
const createdClientUcis: string[] = [];
const createdVendorNames: string[] = [];

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

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "RFCr Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  staffCookie = await session(staffId);
});

afterAll(async () => {
  if (createdReferralIds.length) {
    await db.delete(referralsTable).where(inArray(referralsTable.id, createdReferralIds));
  }
  if (createdVendorNames.length) {
    await db.delete(vendorsTable).where(inArray(vendorsTable.name, createdVendorNames));
  }
  if (createdClientUcis.length) {
    const referralClients = await db.select({ id: clientsTable.id }).from(clientsTable)
      .where(inArray(clientsTable.uciNumber, createdClientUcis));
    if (referralClients.length) {
      await db.delete(referralsTable).where(inArray(referralsTable.clientId, referralClients.map((c) => c.id)));
    }
    const repClients = await db.select({ id: clientsTable.id }).from(clientsTable)
      .where(inArray(clientsTable.uciNumber, createdClientUcis));
    if (repClients.length) {
      await db.delete(familyRepresentativesTable).where(inArray(familyRepresentativesTable.clientId, repClients.map((c) => c.id)));
    }
  }
  if (createdClientUcis.length) {
    await db.delete(clientsTable).where(inArray(clientsTable.uciNumber, createdClientUcis));
  }
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
});

describe("POST /referrals supporting documents", () => {
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
});
