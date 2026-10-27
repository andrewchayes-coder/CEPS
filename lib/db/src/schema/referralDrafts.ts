import { pgTable, uuid, text, integer, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const referralDraftsTable = pgTable("referral_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => usersTable.id),
  uciNumber: text("uci_number"),
  label: text("label").notNull(),
  currentStep: integer("current_step").notNull().default(0),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  supportingDocumentUrl: text("supporting_document_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("referral_drafts_owner_uci_unique").on(t.userId, t.uciNumber).where(sql`${t.uciNumber} is not null`),
  uniqueIndex("referral_drafts_owner_untitled_unique").on(t.userId).where(sql`${t.uciNumber} is null`),
  index("referral_drafts_owner_updated_idx").on(t.userId, t.updatedAt.desc()),
  check("referral_drafts_valid_step", sql`${t.currentStep} between 0 and 5`),
  check("referral_drafts_data_object", sql`jsonb_typeof(${t.data}) = 'object'`),
]);
