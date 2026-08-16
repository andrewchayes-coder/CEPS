import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  referralsTable,
  auditLogTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// POST /referrals — diagnosis / eligibilityCategory / supportingDocumentUrl
// round-trip through create + get, plus '' -> null normalization.
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
    await db.delete(clientsTable).where(inArray(clientsTable.uciNumber, createdClientUcis));
  }
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
});

describe("POST /referrals diagnosis/eligibility/document fields", () => {
  it("round-trips diagnosis, eligibilityCategory and supportingDocumentUrl", async () => {
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
        diagnosis: "Autism Spectrum Disorder",
        eligibilityCategory: "Developmental Disability",
        supportingDocumentUrl: "/objects/uploads/doc-123",
        intakeFields: baseIntake(uci, vendorName),
      });

    expect(res.status).toBe(201);
    createdReferralIds.push(res.body.id);
    expect(res.body.diagnosis).toBe("Autism Spectrum Disorder");
    expect(res.body.eligibilityCategory).toBe("Developmental Disability");
    expect(res.body.supportingDocumentUrl).toBe("/objects/uploads/doc-123");

    // Fetch it back to confirm persistence.
    const get = await request(app).get(`/api/referrals/${res.body.id}`).set("Cookie", staffCookie);
    expect(get.status).toBe(200);
    expect(get.body.diagnosis).toBe("Autism Spectrum Disorder");
    expect(get.body.eligibilityCategory).toBe("Developmental Disability");
    expect(get.body.supportingDocumentUrl).toBe("/objects/uploads/doc-123");
  });

  it("normalizes '' to null for the optional diagnosis/eligibility/document fields", async () => {
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
        diagnosis: "",
        eligibilityCategory: "",
        supportingDocumentUrl: "",
        intakeFields: baseIntake(uci, vendorName),
      });

    expect(res.status).toBe(201);
    createdReferralIds.push(res.body.id);
    expect(res.body.diagnosis).toBeNull();
    expect(res.body.eligibilityCategory).toBeNull();
    expect(res.body.supportingDocumentUrl).toBeNull();

    // Confirm the DB row actually stored NULL (not the empty string).
    const [row] = await db.select().from(referralsTable).where(eq(referralsTable.id, res.body.id));
    expect(row.diagnosis).toBeNull();
    expect(row.eligibilityCategory).toBeNull();
    expect(row.supportingDocumentUrl).toBeNull();
  });

  it("omitting the fields entirely stores null", async () => {
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
    expect(res.body.diagnosis).toBeNull();
    expect(res.body.eligibilityCategory).toBeNull();
    expect(res.body.supportingDocumentUrl).toBeNull();
  });
});
