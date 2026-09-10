import { pgTable, text, uuid, numeric, boolean, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { paymentsTable } from "./payments";
import { authorizationsTable } from "./authorizations";
import { usersTable } from "./users";

export const feesTable = pgTable("fees", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clientsTable.id),
  // Trigger payment link for traceability only, not ownership.
  paymentId: uuid("payment_id").references(() => paymentsTable.id),
  authorizationId: uuid("authorization_id").references(
    () => authorizationsTable.id,
  ),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  feeMonth: text("fee_month"), // YYYY-MM; month the fee applies to
  ruleApplied: text("rule_applied"), // e.g. confirmed_flat_160_per_participant_service_month
  status: text("status").notNull().default("pending"), // pending | invoiced | collected | waived
  notes: text("notes"),
  createdBy: uuid("created_by").references(() => usersTable.id),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  activeClientMonthUnique: uniqueIndex("fees_active_client_fee_month_unique")
    .on(table.clientId, table.feeMonth)
    .where(sql`${table.isDeleted} = false AND ${table.feeMonth} IS NOT NULL`),
  validFeeMonth: check("fees_valid_fee_month", sql`${table.feeMonth} IS NULL OR ${table.feeMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
}));

export type Fee = typeof feesTable.$inferSelect;
