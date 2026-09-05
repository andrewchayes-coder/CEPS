import {
  pgTable,
  text,
  uuid,
  date,
  numeric,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
  // The source report/check batch label is distinct from the opaque generated
  // remittanceBatchId used to group one import run.
  reportReference: text("report_reference"),
  // Stable triage data for received rows that need staff intervention.
  reviewReason: text("review_reason"),
  expectedAmount: numeric("expected_amount", { precision: 12, scale: 2 }),
  // sha256 of the normalized Alta source report row (uci|authNumber|serviceMonth
  // |amount|checkNumber|paymentDate). Lets a re-uploaded report be detected as a
  // duplicate row instead of re-inserted. Null for manually-entered remittances.
  sourceRowFingerprint: text("source_row_fingerprint"),
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
  // Idempotency for Alta report re-uploads: at most one remittance per source
  // report row. Partial (WHERE fingerprint IS NOT NULL) so manually-entered
  // remittances — which carry no fingerprint — are unaffected.
  sourceRowFingerprintUnique: uniqueIndex("remittances_source_row_fingerprint_unique")
    .on(table.sourceRowFingerprint)
    .where(sql`${table.sourceRowFingerprint} IS NOT NULL`),
  positiveFiniteAmount: check(
    "remittances_positive_finite_amount",
    sql`${table.amount} > 0 AND ${table.amount} <> 'NaN'::numeric`,
  ),
}));

export type Remittance = typeof remittancesTable.$inferSelect;

export const remittanceAllocationsTable = pgTable("remittance_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  remittanceId: uuid("remittance_id")
    .notNull()
    .references(() => remittancesTable.id, { onDelete: "cascade" }),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => paymentsTable.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  autoMatched: boolean("auto_matched").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  remittanceIdIdx: index("remittance_allocations_remittance_id_idx").on(table.remittanceId),
  paymentIdIdx: index("remittance_allocations_payment_id_idx").on(table.paymentId),
  pairUnique: uniqueIndex("remittance_allocations_pair_unique").on(table.remittanceId, table.paymentId),
  positiveAmount: check(
    "remittance_allocations_positive_amount",
    sql`${table.amount} > 0 AND ${table.amount} <> 'NaN'::numeric`,
  ),
}));

export type RemittanceAllocation = typeof remittanceAllocationsTable.$inferSelect;
