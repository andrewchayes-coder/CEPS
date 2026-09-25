import { boolean, index, pgTable, text, timestamp, uuid, primaryKey, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const staffRolesTable = pgTable("staff_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  isSystem: boolean("is_system").notNull().default(false),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
}, (table) => ({
  activeNameUnique: uniqueIndex("staff_roles_name_lower_uidx").on(sql`lower(${table.name})`),
  systemIdx: index("staff_roles_is_system_idx").on(table.isSystem),
}));

export const staffRolePermissionsTable = pgTable("staff_role_permissions", {
  roleId: uuid("role_id").notNull().references(() => staffRolesTable.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.roleId, table.permission] }),
  permissionCheck: check(
    "staff_role_permissions_permission_check",
    sql`${table.permission} in ('invoice_log_validate', 'invoice_approve', 'check_writing', 'remittance_entry', 'manage_users')`,
  ),
}));

export type StaffRole = typeof staffRolesTable.$inferSelect;