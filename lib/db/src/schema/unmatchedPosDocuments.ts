import {
  pgTable,
  text,
  uuid,
  integer,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const unmatchedPosDocumentsTable = pgTable("unmatched_pos_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  posPdfUrl: text("pos_pdf_url").notNull(),
  sourceFileName: text("source_file_name").notNull(),
  clientName: text("client_name"),
  clientAddress: text("client_address"),
  clientPhone: text("client_phone"),
  uciNumber: text("uci_number"),
  authNumber: text("auth_number"),
  serviceCode: text("service_code"),
  activityDescription: text("activity_description"),
  servicePeriodStart: text("service_period_start"),
  servicePeriodEnd: text("service_period_end"),
  units: integer("units"),
  monthlyAmount: numeric("monthly_amount", { precision: 12, scale: 2 }),
  maxPeriodAmount: numeric("max_period_amount", { precision: 12, scale: 2 }),
  caseworkerName: text("caseworker_name"),
  posNotes: text("pos_notes"),
  createdBy: uuid("created_by").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  createdAtIdx: index("unmatched_pos_documents_created_at_idx").on(table.createdAt.desc()),
  uciNumberIdx: index("unmatched_pos_documents_uci_number_idx").on(table.uciNumber),
}));

export type UnmatchedPosDocument = typeof unmatchedPosDocumentsTable.$inferSelect;