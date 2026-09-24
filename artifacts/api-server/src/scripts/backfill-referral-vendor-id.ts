import { pathToFileURL } from "node:url";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { db, referralsTable } from "@workspace/db";
import { logger } from "../lib/logger";

export type UnmatchedReferralVendor = {
  id: string;
  vendorName: string | null;
};

export async function backfillReferralVendorIds(referralIds?: readonly string[]): Promise<{
  updatedCount: number;
  unmatched: UnmatchedReferralVendor[];
}> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(712047, 2)`);
    const updated = await tx.execute(sql`
      update referrals r set vendor_id = v.id
      from vendors v
      where r.vendor_id is null
        and (${referralIds === undefined ? sql`true` : referralIds.length ? inArray(sql`r.id`, [...referralIds]) : sql`false`})
        and btrim(coalesce(r.intake_fields->>'vendorName', '')) <> ''
        and lower(btrim(v.name)) = lower(btrim(r.intake_fields->>'vendorName'))
        and (
          select count(*)
          from vendors v2
          where lower(btrim(v2.name)) = lower(btrim(r.intake_fields->>'vendorName'))
        ) = 1
      returning r.id
    `);
    const unmatchedQuery = tx
      .select({
        id: referralsTable.id,
        vendorName: sql<string | null>`${referralsTable.intakeFields}->>'vendorName'`,
      })
      .from(referralsTable)
      .where(referralIds === undefined
        ? isNull(referralsTable.vendorId)
        : sql`${referralsTable.vendorId} is null and ${inArray(referralsTable.id, [...referralIds])}`);
    const unmatched = await unmatchedQuery;

    return {
      updatedCount: updated.rowCount ?? updated.rows.length,
      unmatched,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.NODE_ENV !== "development") {
    logger.error(
      { nodeEnv: process.env.NODE_ENV ?? null },
      "Referral vendor-id backfill requires NODE_ENV=development",
    );
    process.exitCode = 1;
  } else backfillReferralVendorIds()
    .then(({ updatedCount, unmatched }) => {
      logger.info(
        { updatedCount, unmatched },
        "Referral vendor-id development backfill complete",
      );
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, "Referral vendor-id backfill failed");
      process.exitCode = 1;
    });
}