import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const auditLogTable = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => usersTable.id),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_log_created_at_idx").on(t.createdAt.desc()),
    index("audit_log_user_id_created_at_idx").on(t.userId, t.createdAt.desc()),
    index("audit_log_action_trgm_idx").using(
      "gin",
      sql`${t.action} gin_trgm_ops`,
    ),
    index("audit_log_entity_type_trgm_idx").using(
      "gin",
      sql`coalesce(${t.entityType}, '') gin_trgm_ops`,
    ),
    index("audit_log_entity_id_trgm_idx").using(
      "gin",
      sql`coalesce(${t.entityId}, '') gin_trgm_ops`,
    ),
    index("audit_log_detail_trgm_idx").using(
      "gin",
      sql`coalesce(${t.detail}, '') gin_trgm_ops`,
    ),
  ],
);

export type AuditLogEntry = typeof auditLogTable.$inferSelect;
