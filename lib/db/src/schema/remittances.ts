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
import { paymentsTable } from "./payments";

export const remittancesTable = pgTable("remittances", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clientsTable.id),
  authorizationId: uuid("authorization_id").references(
    () => authorizationsTable.id,
  ),
  altaReference: text("alta_reference"),
  remittanceDate: date("remittance_date", { mode: "string" }).notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  paymentMonth: text("payment_month"), // YYYY-MM
  status: text("status").notNull().default("pending"), // pending | received | matched
  source: text("source").notNull().default("manual"), // alta_regional | manual
  matchedPaymentId: uuid("matched_payment_id").references(
    () => paymentsTable.id,
  ),
  autoMatched: boolean("auto_matched").notNull().default(false),
  remittanceBatchId: text("remittance_batch_id"),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  // Backing indexes for the SQL-WHERE list filtering / role scoping
  // (Prompt 6), following the audit-log indexing pattern.
  clientIdIdx: index("remittances_client_id_idx").on(table.clientId),
  statusIdx: index("remittances_status_idx").on(table.status),
  createdAtIdx: index("remittances_created_at_idx").on(table.createdAt.desc()),
}));

export type Remittance = typeof remittancesTable.$inferSelect;
