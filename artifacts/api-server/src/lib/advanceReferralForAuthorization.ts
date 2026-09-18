import { and, asc, eq } from "drizzle-orm";
import { db, referralsTable, vendorsTable, type Authorization } from "@workspace/db";
import { audit } from "./auth";
type Database = typeof db;

/**
 * Records receipt of an authorization and advances one matching referral.
 * The caller must invoke this inside the authorization insert transaction.
 */
export async function advanceReferralForAuthorization(
  tx: Database,
  authorization: Authorization,
  userId: string,
): Promise<void> {
  const [referral] = await tx
    .select()
    .from(referralsTable)
    .where(and(
      eq(referralsTable.clientId, authorization.clientId),
      eq(referralsTable.status, "pending_auth"),
    ))
    .orderBy(asc(referralsTable.referralDate), asc(referralsTable.createdAt), asc(referralsTable.id))
    .limit(1)
    .for("update");
  if (!referral) return;

  let nextStatus: "pending_w9" | "pending_invoice" = "pending_w9";
  if (authorization.vendorId) {
    const [vendor] = await tx
      .select({ w9Status: vendorsTable.w9Status })
      .from(vendorsTable)
      .where(eq(vendorsTable.id, authorization.vendorId));
    if (vendor?.w9Status === "on_file") nextStatus = "pending_invoice";
  }

  const [updated] = await tx
    .update(referralsTable)
    .set({ status: nextStatus, altaAuthReceivedAt: referral.altaAuthReceivedAt ?? new Date() })
    .where(and(eq(referralsTable.id, referral.id), eq(referralsTable.status, "pending_auth")))
    .returning();
  if (updated) {
    await audit(
      userId,
      "advance_referral_authorization_received",
      "referral",
      updated.id,
      `Authorization ${authorization.authNumber} received; advanced to ${nextStatus}`,
      tx,
    );
  }
}