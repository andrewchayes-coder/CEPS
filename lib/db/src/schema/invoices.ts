import {
  pgTable,
  text,
  uuid,
  date,
  numeric,
  boolean,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { authorizationsTable } from "./authorizations";
import { vendorsTable } from "./vendors";
import { usersTable } from "./users";

export const invoicesTable = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clientsTable.id),
  authorizationId: uuid("authorization_id").references(
    () => authorizationsTable.id,
  ),
  vendorId: uuid("vendor_id").references(() => vendorsTable.id),
  submittedByRole: text("submitted_by_role").notNull(), // vendor | parent | staff | service_coordinator
  submittedDate: date("submitted_date", { mode: "string" }).notNull(),
  serviceMonth: text("service_month"), // Deprecated compatibility column; use invoice_line_items.service_month.
  amountRequested: numeric("amount_requested", {
    precision: 12,
    scale: 2,
  }).notNull(),
  paymentType: text("payment_type").notNull(), // direct_payment | reimbursement
  documentType: text("document_type").notNull().default("invoice"),
  serviceStartDate: date("service_start_date", { mode: "string" }),
  serviceEndDate: date("service_end_date", { mode: "string" }),
  documentUrl: text("document_url"),
  // needs_entry | pending_review | validated | approved | rejected | duplicate
  status: text("status").notNull().default("pending_review"),
  reviewedBy: uuid("reviewed_by").references(() => usersTable.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  notes: text("notes"),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  documentTypeCheck: check("invoices_document_type_check", sql`${table.documentType} in ('invoice', 'receipt')`),
  serviceDatesCheck: check("invoices_service_dates_check", sql`${table.serviceStartDate} is null or ${table.serviceEndDate} is null or ${table.serviceStartDate} <= ${table.serviceEndDate}`),
  // Backing indexes for the SQL-WHERE list filtering / role scoping
  // (Prompt 6), following the audit-log indexing pattern.
  clientIdIdx: index("invoices_client_id_idx").on(table.clientId),
  vendorIdIdx: index("invoices_vendor_id_idx").on(table.vendorId),
  statusIdx: index("invoices_status_idx").on(table.status),
  createdAtIdx: index("invoices_created_at_idx").on(table.createdAt.desc()),
  serviceMonthTrgmIdx: index("invoices_service_month_trgm_idx").using(
    "gin",
    sql`coalesce(${table.serviceMonth}, '') gin_trgm_ops`,
  ),
  notesTrgmIdx: index("invoices_notes_trgm_idx").using(
    "gin",
    sql`coalesce(${table.notes}, '') gin_trgm_ops`,
  ),
}));

export type Invoice = typeof invoicesTable.$inferSelect;
