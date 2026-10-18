import { sql } from "drizzle-orm";
import { messageThreadsTable, type User } from "@workspace/db";
import { messageScope, type MessageDatabase } from "./messageAccess";
import { threadFilters, unreadMessage } from "./messageQueries";

/** One scoped query for badges; non-staff responses never expose staff queues. */
export async function messagingCounts(database: MessageDatabase, user: User) {
  const unread = unreadMessage(user.id);
  const result = await database.execute<{ count: number; assignedToMeUnread: number; unassignedOpen: number }>(sql`
    select count(*) filter (where ${unread})::int as count,
      count(*) filter (where ${unread} and ${messageThreadsTable.assigneeUserId} = ${user.id})::int as "assignedToMeUnread",
      count(*) filter (where ${messageThreadsTable.assigneeUserId} is null)::int as "unassignedOpen"
    from message_threads inner join clients on clients.id = message_threads.client_id
    where ${threadFilters(user)}`);
  const row = result.rows[0];
  return user.role === "staff" ? row : { count: row.count };
}

/** Pending assignment notices are scoped to the current owner, not all staff. */
export async function messageAssignmentAlerts(database: MessageDatabase, user: User) {
  if (user.role !== "staff") return [];
  const counts = await messagingCounts(database, user);
  const result = await database.execute<{ id: string; subject: string; clientName: string; assigner: string }>(sql`
    select message_threads.id, message_threads.subject,
      concat_ws(' ', clients.first_name, clients.last_name) as "clientName",
      coalesce(assigner.name, 'CEPS staff') as assigner
    from message_threads inner join clients on clients.id = message_threads.client_id
    left join users assigner on assigner.id = message_threads.assigned_by
    left join message_thread_reads r on r.thread_id = message_threads.id and r.user_id = ${user.id}
    where ${messageScope(user)} and message_threads.assignee_user_id = ${user.id}
      and message_threads.assigned_at >= current_timestamp - interval '7 days'
      and (r.last_read_at is null or r.last_read_at < message_threads.assigned_at)
    order by message_threads.assigned_at desc, message_threads.id desc limit 25`);
  return [
    ...("assignedToMeUnread" in counts && counts.assignedToMeUnread > 0 ? [{
      kind: "message_assigned_to_you",
      message: `${counts.assignedToMeUnread} message thread(s) assigned to you have unread replies`,
      entityType: "message_thread", entityId: null,
    }] : []),
    ...result.rows.map(row => ({
      kind: "message_assigned_new",
      message: `${row.assigner} assigned you '${row.subject}' (${row.clientName})`,
      entityType: "message_thread", entityId: row.id,
    })),
  ];
}
