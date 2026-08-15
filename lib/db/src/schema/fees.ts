import { pgTable, text, uuid, numeric, boolean, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { paymentsTable } from "./payments";
import { authorizationsTable } from "./authorizations";
import { usersTable } from "./users";

export const feesTable = pgTable("fees", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clientsTable.id),
  paymentId: uuid("payment_id").references(() => paymentsTable.id),
  authorizationId: uuid("authorization_id").references(
    () => authorizationsTable.id,
  ),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  ruleApplied: text("rule_applied"), // e.g. interim_flat_percent_5_pending_confirmation
  status: text("status").notNull().default("pending"), // pending | invoiced | collected | waived
  notes: text("notes"),
  createdBy: uuid("created_by").references(() => usersTable.id),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Fee = typeof feesTable.$inferSelect;
