import {
  pgTable,
  text,
  uuid,
  date,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

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
  parentSignedAt: timestamp("parent_signed_at", { withTimezone: true }),
  signedByName: text("signed_by_name"),
  signedIp: text("signed_ip"),
  altaAuthReceivedAt: timestamp("alta_auth_received_at", {
    withTimezone: true,
  }),
  serviceFrequency: text("service_frequency"), // one_time | monthly
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Referral = typeof referralsTable.$inferSelect;
