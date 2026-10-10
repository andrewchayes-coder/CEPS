import { pgTable, uuid, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const clientNotesTable = pgTable("client_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clientsTable.id),
  body: text("body").notNull(),
  createdBy: uuid("created_by").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  updatedBy: uuid("updated_by").references(() => usersTable.id),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by").references(() => usersTable.id),
}, (t) => [index("client_notes_client_id_created_at_idx").on(t.clientId, t.createdAt.desc())]);

export const insertClientNoteSchema = createInsertSchema(clientNotesTable).omit({
  id: true, createdAt: true, updatedAt: true, updatedBy: true,
  isDeleted: true, deletedAt: true, deletedBy: true,
}).extend({ body: z.string().trim().min(1).max(5000) });
export type ClientNote = typeof clientNotesTable.$inferSelect;
export type InsertClientNote = z.infer<typeof insertClientNoteSchema>;
