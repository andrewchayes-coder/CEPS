import { pgTable, uuid, timestamp, index, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { messageThreadsTable } from "./messageThreads";

export const messageThreadFamilyMembersTable = pgTable("message_thread_family_members", {
  threadId: uuid("thread_id").notNull(),
  userId: uuid("user_id").notNull(),
  addedBy: uuid("added_by").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.threadId, t.userId] }),
  foreignKey({ name: "msg_family_thread_fk", columns: [t.threadId], foreignColumns: [messageThreadsTable.id] }),
  foreignKey({ name: "msg_family_user_fk", columns: [t.userId], foreignColumns: [usersTable.id] }),
  foreignKey({ name: "msg_family_added_by_fk", columns: [t.addedBy], foreignColumns: [usersTable.id] }),
  index("message_thread_family_user_idx").on(t.userId),
]);
export const insertMessageThreadFamilyMemberSchema = createInsertSchema(messageThreadFamilyMembersTable).omit({ addedAt: true });
export type MessageThreadFamilyMember = typeof messageThreadFamilyMembersTable.$inferSelect;
export type InsertMessageThreadFamilyMember = z.infer<typeof insertMessageThreadFamilyMemberSchema>;
