import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  referralsTable,
  magicLinksTable,
  auditLogTable,
} from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// POST /signature/:token — typed-name e-signature, with optional portal account creation.
const nonce = `sigsub${Date.now().toString(36)}`;

let clientId: string; // minor -> signer becomes parent_guardian
let referralId: string;
let tokenWithAccount: string;
let tokenNoAccount: string;
const signerEmail = `${nonce}-parent@test.local`;

async function makeLink(purpose: string, refId: string, email: string) {
  const token = newToken();
  await db.insert(magicLinksTable).values({
    token,
    email,
    purpose,
    referralId: refId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return token;
}

beforeAll(async () => {
  const [c] = await db
    .insert(clientsTable)
    .values({
      firstName: "Sig-Kid",
      lastName: nonce,
      dateOfBirth: "2015-01-01",
      uciNumber: `${nonce}-C`,
      status: "active",
      isMinor: true,
    })
    .returning();
  clientId = c.id;

  const [r] = await db
    .insert(referralsTable)
    .values({
      clientId,
      referralDate: "2026-01-01",
      status: "pending_signature",
      parentEmail: signerEmail,
      intakeFields: { activityDescription: "After-school program" },
    })
    .returning();
  referralId = r.id;
});

afterAll(async () => {
  await db.delete(auditLogTable).where(eq(auditLogTable.entityId, referralId));
  await db.delete(magicLinksTable).where(inArray(magicLinksTable.token, [tokenWithAccount, tokenNoAccount]));
  await db.delete(usersTable).where(eq(usersTable.email, signerEmail));
  await db.delete(referralsTable).where(eq(referralsTable.id, referralId));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
});

describe("POST /signature/:token without account creation", () => {
  it("signs the agreement and does not create a user", async () => {
    tokenNoAccount = await makeLink("signature", referralId, signerEmail);
    const res = await request(app)
      .post(`/api/signature/${tokenNoAccount}`)
      .send({ typedName: "No Account Parent", agreed: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.accountCreated).toBe(false);

    const [ref] = await db.select().from(referralsTable).where(eq(referralsTable.id, referralId));
    expect(ref.parentSignedAt).not.toBeNull();
    expect(ref.signedByName).toBe("No Account Parent");
    expect(ref.status).toBe("pending_auth");

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, signerEmail));
    expect(user).toBeUndefined();
  });
});

describe("POST /signature/:token with account creation", () => {
  it("rejects a password shorter than 8 characters without consuming the token or signing", async () => {
    // Reset the referral first — the earlier no-account sign marked it signed.
    await db
      .update(referralsTable)
      .set({ parentSignedAt: null, signedByName: null, status: "pending_signature" })
      .where(eq(referralsTable.id, referralId));

    const token = await makeLink("signature", referralId, signerEmail);
    const res = await request(app)
      .post(`/api/signature/${token}`)
      .send({ typedName: "Short Pw", agreed: true, createAccount: true, password: "short" });
    expect(res.status).toBe(400);

    // The signature must NOT have been recorded — the referral stays unsigned.
    const [ref] = await db.select().from(referralsTable).where(eq(referralsTable.id, referralId));
    expect(ref.parentSignedAt).toBeNull();
    expect(ref.status).toBe("pending_signature");

    // The token must still be valid (usedAt unset) so the signer can retry.
    const [link] = await db.select().from(magicLinksTable).where(eq(magicLinksTable.token, token));
    expect(link.usedAt).toBeNull();

    // No user should have been created either.
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, signerEmail));
    expect(user).toBeUndefined();

    await db.delete(magicLinksTable).where(eq(magicLinksTable.token, token));
  });

  it("rejects account creation with no password at all without consuming the token or signing", async () => {
    const token = await makeLink("signature", referralId, signerEmail);
    const res = await request(app)
      .post(`/api/signature/${token}`)
      .send({ typedName: "No Pw", agreed: true, createAccount: true });
    expect(res.status).toBe(400);

    const [ref] = await db.select().from(referralsTable).where(eq(referralsTable.id, referralId));
    expect(ref.parentSignedAt).toBeNull();
    expect(ref.status).toBe("pending_signature");

    const [link] = await db.select().from(magicLinksTable).where(eq(magicLinksTable.token, token));
    expect(link.usedAt).toBeNull();

    await db.delete(magicLinksTable).where(eq(magicLinksTable.token, token));
  });

  it("creates a parent_guardian account linked to the client", async () => {
    tokenWithAccount = await makeLink("signature", referralId, signerEmail);
    const res = await request(app)
      .post(`/api/signature/${tokenWithAccount}`)
      .send({
        typedName: "Account Parent",
        agreed: true,
        createAccount: true,
        password: "s3cure-pass",
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.accountCreated).toBe(true);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, signerEmail));
    expect(user).toBeDefined();
    expect(user.name).toBe("Account Parent");
    expect(user.role).toBe("parent_guardian");
    expect(user.linkedRecordType).toBe("client");
    expect(user.linkedRecordId).toBe(clientId);
    expect(user.passwordHash).toBeTruthy();
    expect(user.accountCreatedAt).not.toBeNull();
  });
});

describe("POST /signature/:token account creation when the email already exists", () => {
  // A separate referral + client so a fresh unsigned agreement is available;
  // the shared signerEmail already has a user from the success case above.
  let dupClientId: string;
  let dupReferralId: string;
  let dupToken: string;

  beforeAll(async () => {
    const [c] = await db
      .insert(clientsTable)
      .values({
        firstName: "Sig-Dup",
        lastName: nonce,
        dateOfBirth: "2015-01-01",
        uciNumber: `${nonce}-DUP`,
        status: "active",
        isMinor: true,
      })
      .returning();
    dupClientId = c.id;

    const [r] = await db
      .insert(referralsTable)
      .values({
        clientId: dupClientId,
        referralDate: "2026-01-01",
        status: "pending_signature",
        parentEmail: signerEmail,
        intakeFields: { activityDescription: "After-school program" },
      })
      .returning();
    dupReferralId = r.id;

    dupToken = await makeLink("signature", dupReferralId, signerEmail);
  });

  afterAll(async () => {
    await db.delete(auditLogTable).where(eq(auditLogTable.entityId, dupReferralId));
    await db.delete(magicLinksTable).where(eq(magicLinksTable.token, dupToken));
    await db.delete(referralsTable).where(eq(referralsTable.id, dupReferralId));
    await db.delete(clientsTable).where(eq(clientsTable.id, dupClientId));
  });

  it("signs anyway but reports accountCreated=false and does not add a second user row", async () => {
    // Confirm exactly one user exists for this email before the request.
    const before = await db.select().from(usersTable).where(eq(usersTable.email, signerEmail));
    expect(before).toHaveLength(1);

    const res = await request(app)
      .post(`/api/signature/${dupToken}`)
      .send({
        typedName: "Duplicate Parent",
        agreed: true,
        createAccount: true,
        password: "another-s3cure-pass",
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.accountCreated).toBe(false);

    // The signature is still recorded on the referral.
    const [ref] = await db.select().from(referralsTable).where(eq(referralsTable.id, dupReferralId));
    expect(ref.parentSignedAt).not.toBeNull();
    expect(ref.signedByName).toBe("Duplicate Parent");

    // No second user row was created for this email.
    const after = await db.select().from(usersTable).where(eq(usersTable.email, signerEmail));
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
  });
});
