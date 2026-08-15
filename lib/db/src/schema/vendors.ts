import {
  pgTable,
  text,
  uuid,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const vendorsTable = pgTable("vendors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  altaVendorNumber: text("alta_vendor_number"),
  ein: text("ein"),
  billingAddress: text("billing_address"),
  serviceAddress: text("service_address"),
  phone: text("phone"),
  email: text("email"),
  contactPerson: text("contact_person"),
  w9Status: text("w9_status").notNull().default("pending"), // pending | on_file | expired
  w9DocumentUrl: text("w9_document_url"),
  preferred: boolean("preferred").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  // Backing indexes for the SQL-WHERE list filtering / sorting
  // (Prompt 6), following the audit-log indexing pattern.
  nameIdx: index("vendors_name_idx").on(table.name),
  w9StatusIdx: index("vendors_w9_status_idx").on(table.w9Status),
  activeIdx: index("vendors_active_idx").on(table.active),
}));

export type Vendor = typeof vendorsTable.$inferSelect;
