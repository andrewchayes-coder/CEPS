/**
 * Run once after the document_type column is live.
 * Preview: pnpm --filter @workspace/scripts exec tsx backfill-invoice-document-type.ts
 * Apply:   pnpm --filter @workspace/scripts exec tsx backfill-invoice-document-type.ts --apply
 * Do not rerun after staff begin making intentional document/payment-type distinctions.
 */
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // This read also fails explicitly if the new column has not been deployed.
  const predicate = sql`payment_type = 'reimbursement' and document_type <> 'receipt'`;
  const pending = await db.execute(sql`select count(*)::int as count from invoices where ${predicate}`);
  console.info(`Reimbursement invoices eligible for one-time receipt classification: ${pending.rows[0]?.count ?? 0}`);
  if (!process.argv.includes("--apply")) {
    console.info("Preview only. Pass --apply to perform the one-time backfill.");
    return;
  }
  const result = await db.execute(sql`update invoices set document_type = 'receipt' where ${predicate}`);
  console.info(`Classified ${result.rowCount ?? 0} reimbursement invoices as receipts.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => pool.end());
