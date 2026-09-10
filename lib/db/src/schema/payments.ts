import {
  pgTable,
  text,
  uuid,
  date,
  numeric,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { authorizationsTable } from "./authorizations";
import { vendorsTable } from "./vendors";
import { invoicesTable } from "./invoices";
import { usersTable } from "./users";

export const paymentsTable = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clientsTable.id),
  authorizationId: uuid("authorization_id").references(
    () => authorizationsTable.id,
  ),
  vendorId: uuid("vendor_id").references(() => vendorsTable.id),
  invoiceId: uuid("invoice_id").references(() => invoicesTable.id),
  qbCheckNumber: text("qb_check_number").notNull(),
  checkDate: date("check_date", { mode: "string" }).notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  paymentMonth: text("payment_month"), // YYYY-MM
  paymentType: text("payment_type").notNull(), // direct_payment | reimbursement | fee
  source: text("source").notNull(), // quickbooks | manual
  sourceRowFingerprint: text("source_row_fingerprint"),
  loggedBy: uuid("logged_by").references(() => usersTable.id),
  remitted: boolean("remitted").notNull().default(false),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  qbCheckNumberIdx: index("payments_qb_check_number_idx").on(
    table.qbCheckNumber,
  ),
  sourceRowFingerprintUnique: uniqueIndex("payments_source_row_fingerprint_unique")
    .on(table.sourceRowFingerprint)
    .where(sql`${table.sourceRowFingerprint} IS NOT NULL`),
  // Backing indexes for the SQL-WHERE list filtering / role scoping
  // (Prompt 6), following the audit-log indexing pattern.
  checkDateIdx: index("payments_check_date_idx").on(table.checkDate.desc()),
  clientIdIdx: index("payments_client_id_idx").on(table.clientId),
  vendorIdIdx: index("payments_vendor_id_idx").on(table.vendorId),
  authorizationIdIdx: index("payments_authorization_id_idx").on(
    table.authorizationId,
  ),
  paymentTypeIdx: index("payments_payment_type_idx").on(table.paymentType),
  positiveFiniteAmount: check(
    "payments_positive_finite_amount",
    sql`${table.amount} > 0 AND ${table.amount} <> 'NaN'::numeric`,
  ),
  validPaymentMonth: check("payments_valid_payment_month", sql`${table.paymentMonth} IS NULL OR ${table.paymentMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
}));

export type Payment = typeof paymentsTable.$inferSelect;
