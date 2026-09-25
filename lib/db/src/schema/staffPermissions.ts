import { pgTable, uuid, text, timestamp, primaryKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const STAFF_PERMISSION_CATALOG = [
  { permission: "invoice_log_validate", label: "Log & validate invoices", description: "Log and validate invoices." },
  { permission: "invoice_approve", label: "Approve invoices", description: "Approve invoices." },
  { permission: "check_writing", label: "Write checks / log payments", description: "Write checks, record payments and imports, perform check audits and check-run reconciliation, and use the invoice check-writing queue." },
  { permission: "remittance_entry", label: "Enter & match remittances", description: "Create, import, edit, delete, and match incoming remittances." },
  { permission: "manage_users", label: "Manage users & roles", description: "Manage user accounts, roles, and role permissions." },
] as const;
export const STAFF_PERMISSIONS = STAFF_PERMISSION_CATALOG.map(({ permission }) => permission) as [
  "invoice_log_validate",
  "invoice_approve",
  "check_writing",
  "remittance_entry",
  "manage_users",
];
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export const staffPermissionsTable = pgTable("staff_permissions", {
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.permission] }),
  // Legacy per-user permissions are deprecated; retain the original constraint
  // unchanged while role permissions use the expanded catalog.
  permissionCheck: check("staff_permissions_permission_check", sql`${table.permission} in ('invoice_log_validate', 'invoice_approve', 'check_writing')`),
}));

export type StaffPermissionRow = typeof staffPermissionsTable.$inferSelect;