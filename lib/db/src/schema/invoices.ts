import {
  pgTable,
  text,
  uuid,
  date,
  numeric,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
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
  submittedByRole: text("submitted_by_role").notNull(), // vendor | parent | staff
  submittedDate: date("submitted_date", { mode: "string" }).notNull(),
  serviceMonth: text("service_month").notNull(), // YYYY-MM
  amountRequested: numeric("amount_requested", {
    precision: 12,
    scale: 2,
  }).notNull(),
  paymentType: text("payment_type").notNull(), // direct_payment | reimbursement
  documentUrl: text("document_url"),
  // pending_review | validated | approved | rejected | duplicate
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
  // Backing indexes for the SQL-WHERE list filtering / role scoping
  // (Prompt 6), following the audit-log indexing pattern.
  clientIdIdx: index("invoices_client_id_idx").on(table.clientId),
  vendorIdIdx: index("invoices_vendor_id_idx").on(table.vendorId),
  statusIdx: index("invoices_status_idx").on(table.status),
  createdAtIdx: index("invoices_created_at_idx").on(table.createdAt.desc()),
}));

export type Invoice = typeof invoicesTable.$inferSelect;
