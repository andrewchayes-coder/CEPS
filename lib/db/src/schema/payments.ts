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
} from "drizzle-orm/pg-core";
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
  loggedBy: uuid("logged_by").references(() => usersTable.id),
  remitted: boolean("remitted").notNull().default(false),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  qbCheckNumberUnique: uniqueIndex("payments_qb_check_number_unique").on(
    table.qbCheckNumber,
  ),
  // Backing indexes for the SQL-WHERE list filtering / role scoping
  // (Prompt 6), following the audit-log indexing pattern.
  checkDateIdx: index("payments_check_date_idx").on(table.checkDate.desc()),
  clientIdIdx: index("payments_client_id_idx").on(table.clientId),
  vendorIdIdx: index("payments_vendor_id_idx").on(table.vendorId),
  authorizationIdIdx: index("payments_authorization_id_idx").on(
    table.authorizationId,
  ),
  paymentTypeIdx: index("payments_payment_type_idx").on(table.paymentType),
}));

export type Payment = typeof paymentsTable.$inferSelect;
