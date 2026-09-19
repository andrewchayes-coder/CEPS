import {
  pgTable,
  text,
  uuid,
  integer,
  numeric,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { clientsTable } from "./clients";

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
  suggestedClientId: uuid("suggested_client_id").references(() => clientsTable.id),
  suggestionMethod: text("suggestion_method"),
  suggestedAt: timestamp("suggested_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  createdAtIdx: index("unmatched_pos_documents_created_at_idx").on(table.createdAt.desc()),
  uciNumberIdx: index("unmatched_pos_documents_uci_number_idx").on(table.uciNumber),
  suggestionMethodCheck: check("unmatched_pos_documents_suggestion_method_check",
    sql`${table.suggestionMethod} IS NULL OR ${table.suggestionMethod} IN ('uci', 'name')`),
  suggestionFieldsTogetherCheck: check("unmatched_pos_documents_suggestion_fields_together_check",
    sql`(${table.suggestedClientId} IS NULL AND ${table.suggestionMethod} IS NULL AND ${table.suggestedAt} IS NULL) OR (${table.suggestedClientId} IS NOT NULL AND ${table.suggestionMethod} IS NOT NULL AND ${table.suggestedAt} IS NOT NULL)`),
}));

export type UnmatchedPosDocument = typeof unmatchedPosDocumentsTable.$inferSelect;