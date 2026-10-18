import { pgTable, uuid, text, boolean, integer, timestamp, index, check, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const messageThreadsTable = pgTable("message_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clientsTable.id),
  subject: text("subject").notNull(),
  includeCoordinator: boolean("include_coordinator").notNull().default(true),
  createdBy: uuid("created_by").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  lastMessageBy: uuid("last_message_by").references(() => usersTable.id),
  messageCount: integer("message_count").notNull().default(0),
  assigneeUserId: uuid("assignee_user_id").references(() => usersTable.id),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  assignedBy: uuid("assigned_by").references(() => usersTable.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: uuid("resolved_by"),
}, (t) => [
  foreignKey({ columns: [t.resolvedBy], foreignColumns: [usersTable.id], name: "msg_threads_resolved_by_fk" }),
  index("message_threads_client_last_idx").on(t.clientId, t.lastMessageAt.desc()),
  index("message_threads_last_id_idx").on(t.lastMessageAt.desc(), t.id.desc()),
  index("message_threads_assignee_last_idx").on(t.assigneeUserId, t.lastMessageAt.desc()),
  index("message_threads_subject_trgm_idx").using("gin", t.subject.op("gin_trgm_ops")),
  check("message_threads_subject_length", sql`length(btrim(${t.subject})) between 1 and 200`),
  check("message_threads_count_nonnegative", sql`${t.messageCount} >= 0`),
]);
export const insertMessageThreadSchema = createInsertSchema(messageThreadsTable)
  .omit({ id: true, createdAt: true, lastMessageAt: true, lastMessageBy: true, messageCount: true, assigneeUserId: true, assignedAt: true, assignedBy: true, resolvedAt: true, resolvedBy: true })
  .extend({ subject: z.string().trim().min(1).max(200) });
export type MessageThread = typeof messageThreadsTable.$inferSelect;
export type InsertMessageThread = z.infer<typeof insertMessageThreadSchema>;
