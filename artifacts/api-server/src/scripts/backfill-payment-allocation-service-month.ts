import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger";

export async function backfillPaymentAllocationServiceMonths() {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(712047, 1)`);
    const updated = await tx.execute(sql`
      update payment_allocations pa
      set service_month = coalesce(
        case when p.payment_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then p.payment_month end,
        to_char(p.check_date, 'YYYY-MM')
      )
      from payments p
      where p.id = pa.payment_id
        and pa.service_month is null
    `);
    return updated.rowCount ?? 0;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  backfillPaymentAllocationServiceMonths()
    .then((count) => logger.info({ count }, "Payment allocation service-month backfill complete"))
    .catch((error: unknown) => {
      logger.error({ err: error }, "Payment allocation service-month backfill failed");
      process.exitCode = 1;
    });
}