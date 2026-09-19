import {
  pgTable,
  text,
  uuid,
  boolean,
  date,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const clientsTable = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  dateOfBirth: date("date_of_birth", { mode: "string" }).notNull(),
  // [CONFIRM] exact UCI format/uniqueness rules with CEPS — free text, unique for now
  uciNumber: text("uci_number").notNull().unique(),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  status: text("status").notNull().default("active"), // active | inactive | closed
  regionalCenter: text("regional_center"),
  preferredLanguage: text("preferred_language"),
  assignedCoordinatorId: uuid("assigned_coordinator_id").references(
    () => usersTable.id,
  ),
  isMinor: boolean("is_minor"),
  /** @deprecated Use familyRepresentativesTable. */
  familyRepName: text("family_rep_name"),
  /** @deprecated Use familyRepresentativesTable. */
  familyRepPhone: text("family_rep_phone"),
  /** @deprecated Use familyRepresentativesTable. */
  familyRepEmail: text("family_rep_email"),
  /** @deprecated Use familyRepresentativesTable. */
  familyRepAddress: text("family_rep_address"),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  // Backing indexes for the SQL-WHERE list filtering / role scoping
  // (Prompt 6), following the audit-log indexing pattern.
  lastNameIdx: index("clients_last_name_idx").on(table.lastName),
  statusIdx: index("clients_status_idx").on(table.status),
  assignedCoordinatorIdIdx: index("clients_assigned_coordinator_id_idx").on(
    table.assignedCoordinatorId,
  ),
  firstNameTrgmIdx: index("clients_first_name_trgm_idx").using(
    "gin",
    sql`${table.firstName} gin_trgm_ops`,
  ),
  lastNameTrgmIdx: index("clients_last_name_trgm_idx").using(
    "gin",
    sql`${table.lastName} gin_trgm_ops`,
  ),
  uciNumberTrgmIdx: index("clients_uci_number_trgm_idx").using(
    "gin",
    sql`${table.uciNumber} gin_trgm_ops`,
  ),
  fullNameTrgmIdx: index("clients_full_name_trgm_idx").using(
    "gin",
    sql`(${table.firstName} || ' ' || ${table.lastName}) gin_trgm_ops`,
  ),
}));

export type Client = typeof clientsTable.$inferSelect;
