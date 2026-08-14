import {
  pgTable,
  text,
  uuid,
  boolean,
  date,
  timestamp,
} from "drizzle-orm/pg-core";
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
  familyRepName: text("family_rep_name"),
  familyRepPhone: text("family_rep_phone"),
  familyRepEmail: text("family_rep_email"),
  familyRepAddress: text("family_rep_address"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Client = typeof clientsTable.$inferSelect;
