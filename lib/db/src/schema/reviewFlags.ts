import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { paymentAllocationsTable } from "./paymentAllocations";
import { feesTable } from "./fees";
import { usersTable } from "./users";

export const reviewFlagsTable = pgTable("review_flags", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetType: text("target_type").notNull(),
  paymentAllocationId: uuid("payment_allocation_id").references(() => paymentAllocationsTable.id),
  feeId: uuid("fee_id").references(() => feesTable.id),
  reason: text("reason").notNull(),
  flaggedBy: uuid("flagged_by").notNull().references(() => usersTable.id),
  flaggedAt: timestamp("flagged_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: uuid("resolved_by").references(() => usersTable.id),
  resolutionNote: text("resolution_note"),
}, t => ({
  openLine: uniqueIndex("review_flags_open_line_unique").on(t.paymentAllocationId).where(sql`${t.resolvedAt} IS NULL AND ${t.paymentAllocationId} IS NOT NULL`),
  openFee: uniqueIndex("review_flags_open_fee_unique").on(t.feeId).where(sql`${t.resolvedAt} IS NULL AND ${t.feeId} IS NOT NULL`),
  date: index("review_flags_flagged_at_idx").on(t.flaggedAt),
  target: check("review_flags_valid_target", sql`(${t.targetType} = 'payment_line' AND ${t.paymentAllocationId} IS NOT NULL AND ${t.feeId} IS NULL) OR (${t.targetType} = 'fee' AND ${t.feeId} IS NOT NULL AND ${t.paymentAllocationId} IS NULL)`),
  reason: check("review_flags_reason_length", sql`length(btrim(${t.reason})) BETWEEN 1 AND 500`),
  resolution: check("review_flags_resolution", sql`(${t.resolvedAt} IS NULL AND ${t.resolvedBy} IS NULL AND ${t.resolutionNote} IS NULL) OR (${t.resolvedAt} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL AND length(btrim(${t.resolutionNote})) BETWEEN 1 AND 500)`),
}));
