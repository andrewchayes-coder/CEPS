import {
  pgTable,
  text,
  uuid,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const familyRepresentativesTable = pgTable(
  "family_representatives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clientsTable.id),
    name: text("name").notNull(),
    relationship: text("relationship"), // parent | guardian | conservator | other
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    isPrimary: boolean("is_primary").notNull().default(false),
    userId: uuid("user_id").references(() => usersTable.id),
    createdBy: uuid("created_by").references(() => usersTable.id),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    clientIdIdx: index("family_representatives_client_id_idx").on(table.clientId),
    userIdUnique: uniqueIndex("family_representatives_user_id_unique")
      .on(table.userId)
      .where(sql`${table.userId} is not null`),
    relationshipCheck: check(
      "family_representatives_relationship_check",
      sql`${table.relationship} is null or ${table.relationship} in ('parent', 'guardian', 'conservator', 'other')`,
    ),
  }),
);

export type FamilyRepresentative = typeof familyRepresentativesTable.$inferSelect;