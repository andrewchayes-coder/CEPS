import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { clientsTable, db, referralsTable, vendorsTable } from "@workspace/db";
import { backfillReferralVendorIds } from "./backfill-referral-vendor-id";

const nonce = `refvendbf${Date.now().toString(36)}`;
let clientId: string;
let existingVendorId: string;
const referralIds: string[] = [];
let unmatchedReferralId: string;

beforeAll(async () => {
  const [client] = await db.insert(clientsTable).values({
    firstName: "Referral Vendor Backfill",
    lastName: "Test",
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-client`,
  }).returning();
  clientId = client.id;

  const [vendor] = await db.insert(vendorsTable).values({
    name: `${nonce} Existing Vendor`,
  }).returning();
  existingVendorId = vendor.id;

  const [matched, unmatched] = await db.insert(referralsTable).values([
    {
      clientId,
      referralDate: "2026-09-05",
      intakeFields: { vendorName: `  ${vendor.name.toUpperCase()}  ` },
    },
    {
      clientId,
      referralDate: "2026-09-05",
      intakeFields: { vendorName: `${nonce} Missing Vendor` },
    },
  ]).returning();
  referralIds.push(matched.id, unmatched.id);
  unmatchedReferralId = unmatched.id;
});

afterAll(async () => {
  if (referralIds.length) {
    await db.delete(referralsTable).where(inArray(referralsTable.id, referralIds));
  }
  if (existingVendorId) await db.delete(vendorsTable).where(eq(vendorsTable.id, existingVendorId));
  if (clientId) await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
});

describe("backfill referral vendor IDs", () => {
  it("links a uniquely matched case-insensitive vendor and leaves unmatched names null", async () => {
    const result = await backfillReferralVendorIds(referralIds);
    expect(result.updatedCount).toBe(1);
    expect(result.unmatched).toEqual([
      expect.objectContaining({
        id: unmatchedReferralId,
        vendorName: `${nonce} Missing Vendor`,
      }),
    ]);

    const [matched] = await db.select().from(referralsTable).where(eq(referralsTable.id, referralIds[0]));
    const [unmatched] = await db.select().from(referralsTable).where(eq(referralsTable.id, unmatchedReferralId));
    expect(matched.vendorId).toBe(existingVendorId);
    expect(unmatched.vendorId).toBeNull();

    const repeated = await backfillReferralVendorIds(referralIds);
    expect(repeated.updatedCount).toBe(0);
    expect(repeated.unmatched).toEqual(result.unmatched);
  });
});