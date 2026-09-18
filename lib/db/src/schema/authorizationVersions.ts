import { pgTable, text, uuid, date, integer, numeric, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { authorizationsTable } from "./authorizations";
import { clientsTable } from "./clients";
import { vendorsTable } from "./vendors";
import { usersTable } from "./users";

export const authorizationVersionsTable = pgTable("authorization_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  authorizationId: uuid("authorization_id").notNull().references(() => authorizationsTable.id),
  clientId: uuid("client_id").notNull().references(() => clientsTable.id),
  vendorId: uuid("vendor_id").references(() => vendorsTable.id),
  authNumber: text("auth_number").notNull(),
  serviceCode: text("service_code").notNull(),
  paymentType: text("payment_type").notNull(),
  activityDescription: text("activity_description"),
  servicePeriodStart: date("service_period_start", { mode: "string" }).notNull(),
  servicePeriodEnd: date("service_period_end", { mode: "string" }).notNull(),
  monthlyAmount: numeric("monthly_amount", { precision: 12, scale: 2 }),
  oneTimeAmount: numeric("one_time_amount", { precision: 12, scale: 2 }),
  maxPeriodAmount: numeric("max_period_amount", { precision: 12, scale: 2 }).notNull(),
  units: integer("units"),
  status: text("status").notNull(),
  posNotes: text("pos_notes"),
  posPdfUrl: text("pos_pdf_url"),
  receivedDate: date("received_date", { mode: "string" }),
  isDeleted: boolean("is_deleted").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  changedBy: uuid("changed_by").references(() => usersTable.id),
  changedFields: text("changed_fields").array(),
}, (table) => ({
  authorizationChangedAtIdx: index("authorization_versions_auth_changed_at_idx").on(table.authorizationId, table.changedAt.desc()),
}));

export type AuthorizationVersion = typeof authorizationVersionsTable.$inferSelect;