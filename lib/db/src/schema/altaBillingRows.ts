import { pgTable, uuid, text, date, numeric, timestamp, boolean, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { authorizationsTable } from "./authorizations";
import { feesTable } from "./fees";
import { usersTable } from "./users";

export const altaBillingRowsTable = pgTable("alta_billing_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  importBatchId: text("import_batch_id").notNull(),
  invoiceNumber: text("invoice_number").notNull(),
  invoiceDate: date("invoice_date", { mode: "string" }).notNull(),
  clientId: uuid("client_id").references(() => clientsTable.id),
  uciNumber: text("uci_number").notNull(),
  authNumber: text("auth_number").notNull(),
  authorizationId: uuid("authorization_id").references(() => authorizationsTable.id),
  serviceCode: text("service_code").notNull(),
  serviceMonth: text("service_month").notNull(),
  billedAmount: numeric("billed_amount", { precision: 12, scale: 2 }).notNull(),
  feeId: uuid("fee_id").references(() => feesTable.id),
  matchStatus: text("match_status").notNull(),
  reviewReason: text("review_reason"),
  sourceRowFingerprint: text("source_row_fingerprint"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => usersTable.id),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by").references(() => usersTable.id),
}, t => ({
  fee: index("alta_billing_rows_fee_idx").on(t.feeId),
  client: index("alta_billing_rows_client_idx").on(t.clientId),
  batch: index("alta_billing_rows_batch_idx").on(t.importBatchId),
  fingerprint: uniqueIndex("alta_billing_rows_fingerprint_unique").on(t.sourceRowFingerprint).where(sql`${t.sourceRowFingerprint} IS NOT NULL`),
  positive: check("alta_billing_rows_positive_amount", sql`${t.billedAmount} > 0 AND ${t.billedAmount} <> 'NaN'::numeric`),
  status: check("alta_billing_rows_match_status", sql`${t.matchStatus} IN ('matched', 'unmatched', 'amount_mismatch')`),
  month: check("alta_billing_rows_valid_month", sql`${t.serviceMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
}));
