import { pgTable, uuid, text, timestamp, primaryKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const STAFF_PERMISSIONS = ["invoice_log_validate", "invoice_approve", "check_writing"] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export const staffPermissionsTable = pgTable("staff_permissions", {
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.permission] }),
  permissionCheck: check("staff_permissions_permission_check", sql`${table.permission} in ('invoice_log_validate', 'invoice_approve', 'check_writing')`),
}));

export type StaffPermissionRow = typeof staffPermissionsTable.$inferSelect;