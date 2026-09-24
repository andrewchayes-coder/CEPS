import { pgTable, uuid, text, numeric, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { paymentsTable } from "./payments";
import { authorizationsTable } from "./authorizations";

export const paymentAllocationsTable = pgTable("payment_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id").notNull().references(() => paymentsTable.id, { onDelete: "cascade" }),
  authorizationId: uuid("authorization_id").notNull().references(() => authorizationsTable.id, { onDelete: "cascade" }),
  serviceMonth: text("service_month"),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  paymentIdx: index("payment_allocations_payment_id_idx").on(table.paymentId),
  authorizationIdx: index("payment_allocations_authorization_id_idx").on(table.authorizationId),
  pairUnique: uniqueIndex("payment_allocations_payment_authorization_service_month_unique").on(table.paymentId, table.authorizationId, table.serviceMonth),
  validServiceMonth: check("payment_allocations_valid_service_month", sql`${table.serviceMonth} IS NULL OR ${table.serviceMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  positiveAmount: check("payment_allocations_positive_amount", sql`${table.amount} > 0 AND ${table.amount} <> 'NaN'::numeric`),
}));

export type PaymentAllocation = typeof paymentAllocationsTable.$inferSelect;