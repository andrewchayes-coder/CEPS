import {
  pgTable,
  text,
  uuid,
  integer,
  numeric,
  timestamp,
  index,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { clientsTable } from "./clients";
import { authorizationsTable } from "./authorizations";

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
  batchId: uuid("batch_id"),
  parseStatus: text("parse_status").notNull().default("parsed"),
  parseError: text("parse_error"),
  reviewStatus: text("review_status").notNull().default("pending"),
  discardReason: text("discard_reason"),
  suggestedAuthorizationId: uuid("suggested_authorization_id"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  resultingAuthorizationId: uuid("resulting_authorization_id"),
  createdBy: uuid("created_by").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  createdAtIdx: index("unmatched_pos_documents_created_at_idx").on(table.createdAt.desc()),
  reviewCreatedIdx: index("upos_review_created_idx").on(table.reviewStatus, table.createdAt),
  uciNumberIdx: index("unmatched_pos_documents_uci_number_idx").on(table.uciNumber),
  parseStatusCheck: check("upos_parse_status_check",
    sql`${table.parseStatus} IN ('queued', 'parsed', 'failed')`),
  reviewStatusCheck: check("upos_review_status_check",
    sql`${table.reviewStatus} IN ('pending', 'confirmed', 'discarded')`),
  suggestedAuthorizationFk: foreignKey({
    name: "upos_suggested_auth_fk",
    columns: [table.suggestedAuthorizationId],
    foreignColumns: [authorizationsTable.id],
  }),
  reviewedByFk: foreignKey({
    name: "upos_reviewed_by_fk",
    columns: [table.reviewedBy],
    foreignColumns: [usersTable.id],
  }),
  resultingAuthorizationFk: foreignKey({
    name: "upos_result_auth_fk",
    columns: [table.resultingAuthorizationId],
    foreignColumns: [authorizationsTable.id],
  }),
  suggestionMethodCheck: check("unmatched_pos_documents_suggestion_method_check",
    sql`${table.suggestionMethod} IS NULL OR ${table.suggestionMethod} IN ('uci', 'name')`),
  suggestionFieldsTogetherCheck: check("unmatched_pos_documents_suggestion_fields_together_check",
    sql`(${table.suggestedClientId} IS NULL AND ${table.suggestionMethod} IS NULL AND ${table.suggestedAt} IS NULL) OR (${table.suggestedClientId} IS NOT NULL AND ${table.suggestionMethod} IS NOT NULL AND ${table.suggestedAt} IS NOT NULL)`),
}));

export type UnmatchedPosDocument = typeof unmatchedPosDocumentsTable.$inferSelect;