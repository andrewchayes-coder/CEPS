import {
  pgTable,
  text,
  uuid,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { familyRepresentativesTable } from "./familyRepresentatives";

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone"),
  role: text("role").notNull(), // staff | service_coordinator | parent_guardian | self | vendor
  passwordHash: text("password_hash"),
  linkedRecordId: uuid("linked_record_id"),
  linkedRecordType: text("linked_record_type"), // client | vendor
  active: boolean("active").notNull().default(true),
  lastLogin: timestamp("last_login", { withTimezone: true }),
  accountCreatedAt: timestamp("account_created_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  nameFtsIdx: index("users_name_fts_idx").using(
    "gin",
    sql`to_tsvector('simple', ${table.name})`,
  ),
  emailFtsIdx: index("users_email_fts_idx").using(
    "gin",
    sql`to_tsvector('simple', regexp_replace(${table.email}, '[^a-zA-Z0-9]+', ' ', 'g'))`,
  ),
}));

export type User = typeof usersTable.$inferSelect;

export const sessionsTable = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Session = typeof sessionsTable.$inferSelect;

// Magic links: a login link (email-based), a referral e-signature link, or a
// portal invite (staff-issued account provisioning for vendors/parents/self).
export const magicLinksTable = pgTable("magic_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  token: text("token").notNull().unique(),
  email: text("email").notNull(),
  purpose: text("purpose").notNull(), // login | signature | invite
  referralId: uuid("referral_id"),
  familyRepresentativeId: uuid("family_representative_id").references(
    () => familyRepresentativesTable.id,
  ),
  // Invite-only fields: the role and linked record the accepted account gets.
  inviteRole: text("invite_role"), // vendor | parent_guardian | self
  linkedRecordType: text("linked_record_type"), // client | vendor
  linkedRecordId: uuid("linked_record_id"),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type MagicLink = typeof magicLinksTable.$inferSelect;
