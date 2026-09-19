import { pgTable, uuid, text, numeric, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { invoicesTable } from "./invoices";
import { authorizationsTable } from "./authorizations";

export const invoiceLineItemsTable = pgTable("invoice_line_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoicesTable.id, { onDelete: "cascade" }),
  authorizationId: uuid("authorization_id").notNull().references(() => authorizationsTable.id, { onDelete: "cascade" }),
  serviceMonth: text("service_month").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  documentUrl: text("document_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  invoiceIdx: index("invoice_line_items_invoice_id_idx").on(table.invoiceId),
  authorizationIdx: index("invoice_line_items_authorization_id_idx").on(table.authorizationId),
  pairUnique: uniqueIndex("invoice_line_items_invoice_auth_month_unique").on(table.invoiceId, table.authorizationId, table.serviceMonth),
  positiveAmount: check("invoice_line_items_positive_amount", sql`${table.amount} > 0 AND ${table.amount} <> 'NaN'::numeric`),
  validMonth: check("invoice_line_items_valid_month", sql`${table.serviceMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
}));

export type InvoiceLineItem = typeof invoiceLineItemsTable.$inferSelect;