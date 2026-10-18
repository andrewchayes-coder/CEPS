import { eq, sql } from "drizzle-orm";
import { messagesTable, messageThreadsTable, messageThreadReadsTable, messageThreadFamilyMembersTable, type User } from "@workspace/db";
import { MessageError, type MessageDatabase } from "./messageAccess";
import { messageRecipients } from "./messageQueries";

export async function markMessageRead(database: MessageDatabase, threadId: string, userId: string) {
  await database.insert(messageThreadReadsTable).values({ threadId, userId, lastReadAt: sql`clock_timestamp()` })
    .onConflictDoUpdate({
      target: [messageThreadReadsTable.threadId, messageThreadReadsTable.userId],
      set: { lastReadAt: sql`greatest(${messageThreadReadsTable.lastReadAt}, excluded.last_read_at)` },
    });
}

export async function appendMessage(database: MessageDatabase, threadId: string, clientId: string, user: User, body: string) {
  const [message] = await database.insert(messagesTable).values({
    threadId, clientId, authorUserId: user.id, body, createdAt: sql`clock_timestamp()`,
  }).returning({ id: messagesTable.id });
  await database.update(messageThreadsTable).set({
    lastMessageAt: sql`(select created_at from messages where id = ${message.id})`,
    lastMessageBy: user.id, messageCount: sql`${messageThreadsTable.messageCount} + 1`,
  }).where(eq(messageThreadsTable.id, threadId));
  await markMessageRead(database, threadId, user.id);
  return message.id;
}

export async function validateFamilyRecipients(database: MessageDatabase, clientId: string, ids: string[]) {
  const recipients = await messageRecipients(database, clientId, true);
  const unique = [...new Set(ids)];
  if (unique.some(id => !recipients.family.some(person => person.userId === id))) {
    throw new MessageError(400, "Choose active family portal users linked to this participant");
  }
  return { recipients, userIds: unique };
}

export async function addFamilyMembers(database: MessageDatabase, threadId: string, userIds: string[], addedBy: string) {
  if (userIds.length) {
    await database.insert(messageThreadFamilyMembersTable).values(userIds.map(userId => ({ threadId, userId, addedBy })))
      .onConflictDoNothing();
  }
}
