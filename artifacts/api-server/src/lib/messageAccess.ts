import { and, eq, sql, type SQL } from "drizzle-orm";
import { db, clientsTable, messageThreadsTable, usersTable, type User } from "@workspace/db";
import { coordinatorCanAccessClient } from "./clientAccess";

export type MessageDatabase = typeof db;
export class MessageError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Always AND this predicate with caller filters; filters cannot expand access. */
export function messageScope(user: User): SQL {
  // Deleted-participant history remains available to staff only.
  if (user.role === "staff") return sql`true`;
  if (user.role === "service_coordinator") {
    // Intentional: reassignment transfers history to the CURRENT coordinator.
    return and(eq(clientsTable.isDeleted, false), eq(messageThreadsTable.includeCoordinator, true),
      eq(clientsTable.assignedCoordinatorId, user.id))!;
  }
  if (user.role === "parent_guardian" || user.role === "self") {
    return sql`${clientsTable.isDeleted} = false
      and exists (select 1 from message_thread_family_members fm
        inner join users family_user on family_user.id = fm.user_id
        where fm.thread_id = ${messageThreadsTable.id} and fm.user_id = ${user.id}
        and family_user.active = true and family_user.role in ('parent_guardian', 'self')
        and family_user.linked_record_type = 'client'
        and family_user.linked_record_id = ${messageThreadsTable.clientId})`;
  }
  return sql`false`;
}

export async function messageActor(database: MessageDatabase, userId: string): Promise<User> {
  const [user] = await database.select().from(usersTable).where(eq(usersTable.id, userId)).for("share");
  if (!user?.active || !["staff", "service_coordinator", "parent_guardian", "self"].includes(user.role)) {
    throw new MessageError(403, "Forbidden");
  }
  return user;
}

export async function messageClient(database: MessageDatabase, id: string, user: User, lock = false) {
  const query = database.select().from(clientsTable).where(eq(clientsTable.id, id));
  const [client] = await (lock ? query.for("update") : query);
  if (!client || (client.isDeleted && user.role !== "staff")
    || !coordinatorCanAccessClient(user, client)
    || (user.role !== "staff" && user.role !== "service_coordinator"
      && (!user.active || user.linkedRecordType !== "client" || user.linkedRecordId !== id))) {
    throw new MessageError(404, "Participant not found");
  }
  return client;
}

export async function messageThread(database: MessageDatabase, id: string, user: User, lock = false) {
  const query = database.select({ thread: messageThreadsTable, client: clientsTable })
    .from(messageThreadsTable).innerJoin(clientsTable, eq(clientsTable.id, messageThreadsTable.clientId))
    .where(and(eq(messageThreadsTable.id, id), messageScope(user)));
  // Lock both the thread and client: include-coordinator and current assignment
  // cannot change between authorization, recipient validation and commit.
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new MessageError(404, "Thread not found");
  return row;
}
