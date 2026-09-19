import {
  pgTable,
  text,
  uuid,
  date,
  jsonb,
  timestamp,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { usersTable } from "./users";
import { familyRepresentativesTable } from "./familyRepresentatives";

export const referralsTable = pgTable("referrals", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clientsTable.id),
  serviceCoordinatorId: uuid("service_coordinator_id").references(
    () => usersTable.id,
  ),
  referralDate: date("referral_date", { mode: "string" }).notNull(),
  // intake | pending_signature | pending_auth | pending_w9 | pending_invoice | active | closed
  status: text("status").notNull().default("intake"),
  submittedVia: text("submitted_via"), // portal | staff_manual_entry
  intakeFields: jsonb("intake_fields"),
  parentEmail: text("parent_email"),
  intakeSentTo: text("intake_sent_to"), // participant | family_rep
  intakeSentToFamilyRepId: uuid("intake_sent_to_family_rep_id").references(
    () => familyRepresentativesTable.id,
  ),
  intakeSentAt: timestamp("intake_sent_at", { withTimezone: true }),
  parentSignedAt: timestamp("parent_signed_at", { withTimezone: true }),
  signedByName: text("signed_by_name"),
  signerRelationship: text("signer_relationship"), // self | parent | guardian | conservator
  signedIp: text("signed_ip"),
  agreementSnapshot: jsonb("agreement_snapshot"),
  altaAuthReceivedAt: timestamp("alta_auth_received_at", {
    withTimezone: true,
  }),
  serviceFrequency: text("service_frequency"), // one_time | monthly
  cost: numeric("cost", { precision: 12, scale: 2 }),
  paymentSchedule: text("payment_schedule"),
  paymentTypeRequested: text("payment_type_requested"), // service_payment | reimbursement
  // Diagnosis / eligibility (optional, staff- or coordinator-supplied)
  diagnosis: text("diagnosis"),
  eligibilityCategory: text("eligibility_category"),
  // Single supporting-document URL, mirroring invoices.documentUrl
  supportingDocumentUrl: text("supporting_document_url"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  // Backing indexes for the SQL-WHERE list filtering / role scoping
  // (Prompt 6), following the audit-log indexing pattern.
  createdAtIdx: index("referrals_created_at_idx").on(table.createdAt.desc()),
  clientIdIdx: index("referrals_client_id_idx").on(table.clientId),
  serviceCoordinatorIdIdx: index("referrals_service_coordinator_id_idx").on(
    table.serviceCoordinatorId,
  ),
  statusIdx: index("referrals_status_idx").on(table.status),
  parentEmailTrgmIdx: index("referrals_parent_email_trgm_idx").using(
    "gin",
    sql`coalesce(${table.parentEmail}, '') gin_trgm_ops`,
  ),
  intakeSentToTrgmIdx: index("referrals_intake_sent_to_trgm_idx").using(
    "gin",
    sql`coalesce(${table.intakeSentTo}, '') gin_trgm_ops`,
  ),
  diagnosisTrgmIdx: index("referrals_diagnosis_trgm_idx").using(
    "gin",
    sql`coalesce(${table.diagnosis}, '') gin_trgm_ops`,
  ),
  eligibilityCategoryTrgmIdx: index("referrals_eligibility_category_trgm_idx").using(
    "gin",
    sql`coalesce(${table.eligibilityCategory}, '') gin_trgm_ops`,
  ),
  notesTrgmIdx: index("referrals_notes_trgm_idx").using(
    "gin",
    sql`coalesce(${table.notes}, '') gin_trgm_ops`,
  ),
}));

export type Referral = typeof referralsTable.$inferSelect;
