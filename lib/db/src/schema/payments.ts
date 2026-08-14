import {
  pgTable,
  text,
  uuid,
  date,
  numeric,
  boolean,
  timestamp,
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Payment = typeof paymentsTable.$inferSelect;
