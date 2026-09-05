import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  clientsTable,
  db,
  magicLinksTable,
  referralsTable,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `sendintake${Date.now().toString(36)}`;
let staffId: string;
let staffCookie: string;
let minorClientId: string;
let adultClientId: string;
let missingEmailClientId: string;
let minorReferralId: string;
let adultReferralId: string;
let missingEmailReferralId: string;

async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `ceps_session=${token}`;
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({
      name: "Send Intake Staff",
      email: `${nonce}-staff@test.local`,
      role: "staff",
    })
    .returning();
  staffId = staff.id;
  staffCookie = await session(staffId);

  const clients = await db
    .insert(clientsTable)
    .values([
      {
        firstName: "Minor",
        lastName: "Signer",
        dateOfBirth: "2015-01-01",
        uciNumber: `${nonce}-minor`,
        isMinor: true,
        email: `${nonce}-minor@test.local`,
        familyRepEmail: `${nonce}-family@test.local`,
      },
      {
        firstName: "Adult",
        lastName: "Signer",
        dateOfBirth: "1990-01-01",
        uciNumber: `${nonce}-adult`,
        isMinor: false,
        email: `${nonce}-adult@test.local`,
      },
      {
        firstName: "Missing",
        lastName: "Email",
        dateOfBirth: "2012-01-01",
        uciNumber: `${nonce}-missing`,
        isMinor: true,
        familyRepEmail: null,
      },
    ])
    .returning();
  [minorClientId, adultClientId, missingEmailClientId] = clients.map(
    (client) => client.id,
  );

  const referrals = await db
    .insert(referralsTable)
    .values([
      {
        clientId: minorClientId,
        referralDate: "2026-09-05",
        status: "intake",
        intakeFields: {},
      },
      {
        clientId: adultClientId,
        referralDate: "2026-09-05",
        status: "intake",
        intakeFields: {},
      },
      {
        clientId: missingEmailClientId,
        referralDate: "2026-09-05",
        status: "intake",
        intakeFields: {},
      },
    ])
    .returning();
  [minorReferralId, adultReferralId, missingEmailReferralId] = referrals.map(
    (referral) => referral.id,
  );
});

afterAll(async () => {
  const referralIds = [minorReferralId, adultReferralId, missingEmailReferralId];
  const clientIds = [minorClientId, adultClientId, missingEmailClientId];
  await db.delete(auditLogTable).where(inArray(auditLogTable.entityId, referralIds));
  await db.delete(magicLinksTable).where(inArray(magicLinksTable.referralId, referralIds));
  await db.delete(referralsTable).where(inArray(referralsTable.id, referralIds));
  await db.delete(clientsTable).where(inArray(clientsTable.id, clientIds));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(usersTable).where(eq(usersTable.id, staffId));
});

describe("POST /referrals/:id/send-intake", () => {
  it("rejects sending a minor's agreement to the participant", async () => {
    const response = await request(app)
      .post(`/api/referrals/${minorReferralId}/send-intake`)
      .set("Cookie", staffCookie)
      .send({ recipient: "participant" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("minor cannot sign for themselves");
  });

  it("sends a minor's agreement to the exact family representative email", async () => {
    const response = await request(app)
      .post(`/api/referrals/${minorReferralId}/send-intake`)
      .set("Cookie", staffCookie)
      .send({ recipient: "family_rep" });

    expect(response.status).toBe(200);
    const [referral] = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.id, minorReferralId));
    expect(referral.parentEmail).toBe(`${nonce}-family@test.local`);
    expect(referral.intakeSentTo).toBe("family_rep");

    const [auditEntry] = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.entityId, minorReferralId));
    expect(auditEntry.detail).toContain(
      `Sent to family rep: ${nonce}-family@test.local`,
    );
  });

  it("rejects a chosen recipient that has no email instead of falling back", async () => {
    const response = await request(app)
      .post(`/api/referrals/${missingEmailReferralId}/send-intake`)
      .set("Cookie", staffCookie)
      .send({ recipient: "family_rep" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("family rep record");
  });

  it("rejects malformed agreement cost before writing", async () => {
    const response = await request(app)
      .post(`/api/referrals/${adultReferralId}/send-intake`)
      .set("Cookie", staffCookie)
      .send({ recipient: "participant", cost: "not-a-cost" });

    expect(response.status).toBe(400);
    const [referral] = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.id, adultReferralId));
    expect(referral.intakeSentAt).toBeNull();
    expect(referral.cost).toBeNull();
  });

  it("stores agreement data, recipient, send time, and advances intake status", async () => {
    const response = await request(app)
      .post(`/api/referrals/${adultReferralId}/send-intake`)
      .set("Cookie", staffCookie)
      .send({
        recipient: "participant",
        serviceFrequency: "monthly",
        cost: "210.00",
        paymentSchedule: "$210 on the 1st of each month",
        paymentTypeRequested: "service_payment",
      });

    expect(response.status).toBe(200);
    expect(response.body.sent).toBe(true);
    expect(response.body.devLink).toContain("/sign/");

    const [referral] = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.id, adultReferralId));
    expect(referral.parentEmail).toBe(`${nonce}-adult@test.local`);
    expect(referral.intakeSentTo).toBe("participant");
    expect(referral.intakeSentAt).toBeInstanceOf(Date);
    expect(referral.status).toBe("pending_signature");
    expect(referral.serviceFrequency).toBe("monthly");
    expect(referral.cost).toBe("210.00");
    expect(referral.paymentSchedule).toBe("$210 on the 1st of each month");
    expect(referral.paymentTypeRequested).toBe("service_payment");
  });

  it("resends without clobbering an existing signature or progress", async () => {
    const signedAt = new Date("2026-09-05T12:00:00.000Z");
    await db
      .update(referralsTable)
      .set({
        parentSignedAt: signedAt,
        signedByName: "Existing Signer",
        signerRelationship: "self",
        status: "pending_auth",
      })
      .where(eq(referralsTable.id, adultReferralId));

    const response = await request(app)
      .post(`/api/referrals/${adultReferralId}/send-intake`)
      .set("Cookie", staffCookie)
      .send({
        recipient: "participant",
        paymentSchedule: "",
      });

    expect(response.status).toBe(200);
    const [referral] = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.id, adultReferralId));
    expect(referral.parentSignedAt?.toISOString()).toBe(signedAt.toISOString());
    expect(referral.signedByName).toBe("Existing Signer");
    expect(referral.signerRelationship).toBe("self");
    expect(referral.status).toBe("pending_auth");
    expect(referral.paymentSchedule).toBeNull();
  });
});