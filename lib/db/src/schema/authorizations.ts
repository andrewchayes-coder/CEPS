import {
  pgTable,
  text,
  uuid,
  date,
  integer,
  numeric,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { vendorsTable } from "./vendors";

export const authorizationsTable = pgTable("authorizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clientsTable.id),
  vendorId: uuid("vendor_id").references(() => vendorsTable.id),
  authNumber: text("auth_number").notNull(),
  serviceCode: text("service_code").notNull(), // 459 | 024 | 490
  paymentType: text("payment_type").notNull(), // direct_payment | reimbursement | fee
  activityDescription: text("activity_description"),
  servicePeriodStart: date("service_period_start", { mode: "string" }).notNull(),
  servicePeriodEnd: date("service_period_end", { mode: "string" }).notNull(),
  monthlyAmount: numeric("monthly_amount", { precision: 12, scale: 2 }),
  oneTimeAmount: numeric("one_time_amount", { precision: 12, scale: 2 }),
  maxPeriodAmount: numeric("max_period_amount", {
    precision: 12,
    scale: 2,
  }).notNull(),
  units: integer("units"),
  status: text("status").notNull().default("pending"), // active | expired | pending | exhausted
  posPdfUrl: text("pos_pdf_url"),
  receivedDate: date("received_date", { mode: "string" }),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  // Backing indexes for the SQL-WHERE list filtering / role scoping
  // (Prompt 6), following the audit-log indexing pattern.
  clientIdIdx: index("authorizations_client_id_idx").on(table.clientId),
  vendorIdIdx: index("authorizations_vendor_id_idx").on(table.vendorId),
  statusIdx: index("authorizations_status_idx").on(table.status),
  createdAtIdx: index("authorizations_created_at_idx").on(
    table.createdAt.desc(),
  ),
  // Natural-key uniqueness for bulk import: an authorization number is unique
  // WITHIN a client. Partial (WHERE not deleted) so a soft-deleted auth can be
  // re-created and so a race between concurrent imports of the same
  // (client, number) is caught at the DB instead of double-inserting.
  clientAuthNumberUnique: uniqueIndex("authorizations_client_id_auth_number_unique")
    .on(table.clientId, table.authNumber)
    .where(sql`${table.isDeleted} = false`),
}));

export type Authorization = typeof authorizationsTable.$inferSelect;
