import { pgTable, uuid, numeric, index, primaryKey, foreignKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { altaBillingRowsTable } from "./altaBillingRows";
import { paymentAllocationsTable } from "./paymentAllocations";

export const altaBillingRowLinesTable = pgTable("alta_billing_row_lines", {
  billingRowId: uuid("billing_row_id").notNull(),
  paymentAllocationId: uuid("payment_allocation_id").notNull(),
  lineAmount: numeric("line_amount", { precision: 12, scale: 2 }).notNull(),
}, t => ({
  pk: primaryKey({ columns: [t.billingRowId, t.paymentAllocationId] }),
  source: foreignKey({ columns: [t.billingRowId], foreignColumns: [altaBillingRowsTable.id], name: "alta_billing_row_lines_source_fk" }),
  line: foreignKey({ columns: [t.paymentAllocationId], foreignColumns: [paymentAllocationsTable.id], name: "alta_billing_row_lines_line_fk" }),
  lineIdx: index("alta_billing_row_lines_line_idx").on(t.paymentAllocationId),
  positive: check("alta_billing_row_lines_positive_amount", sql`${t.lineAmount} > 0 AND ${t.lineAmount} <> 'NaN'::numeric`),
}));
