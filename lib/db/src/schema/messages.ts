import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { usersTable } from "./users";
import { messageThreadsTable } from "./messageThreads";

export const messagesTable = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => messageThreadsTable.id),
  clientId: uuid("client_id").notNull().references(() => clientsTable.id),
  authorUserId: uuid("author_user_id").notNull().references(() => usersTable.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("messages_thread_created_id_idx").on(t.threadId, t.createdAt.desc(), t.id.desc()),
  index("messages_client_created_idx").on(t.clientId, t.createdAt.desc()),
  index("messages_body_trgm_idx").using("gin", t.body.op("gin_trgm_ops")),
  check("messages_body_length", sql`length(btrim(${t.body})) between 1 and 5000`),
]);
export const insertMessageSchema = createInsertSchema(messagesTable).omit({ id: true, createdAt: true })
  .extend({ body: z.string().trim().min(1).max(5000) });
export type Message = typeof messagesTable.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
