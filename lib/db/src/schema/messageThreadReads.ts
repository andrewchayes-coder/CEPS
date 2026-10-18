import { pgTable, uuid, timestamp, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { messageThreadsTable } from "./messageThreads";

export const messageThreadReadsTable = pgTable("message_thread_reads", {
  threadId: uuid("thread_id").notNull(),
  userId: uuid("user_id").notNull(),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.threadId, t.userId] }),
  foreignKey({ name: "msg_reads_thread_fk", columns: [t.threadId], foreignColumns: [messageThreadsTable.id] }),
  foreignKey({ name: "msg_reads_user_fk", columns: [t.userId], foreignColumns: [usersTable.id] }),
]);
export const insertMessageThreadReadSchema = createInsertSchema(messageThreadReadsTable);
export type MessageThreadRead = typeof messageThreadReadsTable.$inferSelect;
export type InsertMessageThreadRead = z.infer<typeof insertMessageThreadReadSchema>;
