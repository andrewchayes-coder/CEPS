import { sql, type SQL } from "drizzle-orm";
import { clientsTable, messageThreadsTable, type User } from "@workspace/db";
import { messageScope, type MessageDatabase } from "./messageAccess";

export interface MessageFilters {
  clientId?: string; view?: string; search?: string; range?: string; status?: "open" | "resolved" | "all";
  dateFrom?: string; dateTo?: string; limit?: number; offset?: number;
}
export const messageTimestamp = (column: SQL) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Compare the indexed timestamp itself to Pacific midnight bounds (DST-safe). */
function messageDateBounds(column: SQL, filters: MessageFilters): SQL {
  const bounds: SQL[] = [];
  if (filters.dateFrom) bounds.push(sql`${column} >= (${filters.dateFrom}::date)::timestamp at time zone 'America/Los_Angeles'`);
  if (filters.dateTo) bounds.push(sql`${column} < (${filters.dateTo}::date + 1)::timestamp at time zone 'America/Los_Angeles'`);
  return bounds.length ? sql.join(bounds, sql` and `) : sql`true`;
}

export function unreadMessage(userId: string): SQL {
  return sql`(${messageThreadsTable.lastMessageAt} > coalesce(
    (select r.last_read_at from message_thread_reads r
     where r.thread_id = ${messageThreadsTable.id} and r.user_id = ${userId}), '-infinity'::timestamptz)
    and ${messageThreadsTable.lastMessageBy} <> ${userId})`;
}

export function threadFilters(user: User, filters: MessageFilters = {}): SQL {
  const conditions: SQL[] = [messageScope(user)];
  if (filters.clientId) conditions.push(sql`${messageThreadsTable.clientId} = ${filters.clientId}`);
  if (filters.view === "unread") conditions.push(unreadMessage(user.id));
  if (filters.view === "assigned_to_me") conditions.push(sql`${messageThreadsTable.assigneeUserId} = ${user.id}`);
  if (filters.view === "unassigned") conditions.push(sql`${messageThreadsTable.assigneeUserId} is null`);
  const status = filters.status ?? (filters.view === "assigned_to_me" || filters.view === "unassigned" ? "open" : "all");
  if (status === "open") conditions.push(sql`${messageThreadsTable.resolvedAt} is null`);
  if (status === "resolved") conditions.push(sql`${messageThreadsTable.resolvedAt} is not null`);
  if (filters.dateFrom || filters.dateTo) {
    conditions.push(sql`exists (select 1 from messages range_message
      where range_message.thread_id = ${messageThreadsTable.id}
        and ${messageDateBounds(sql`range_message.created_at`, filters)})`);
  } else {
    conditions.push(filters.range === "archive"
      ? sql`${messageThreadsTable.lastMessageAt} < current_timestamp - interval '183 days'`
      : sql`${messageThreadsTable.lastMessageAt} >= current_timestamp - interval '183 days'`);
  }
  if (filters.search?.trim()) {
    const pattern = `%${filters.search.trim().replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(sql`(${messageThreadsTable.subject} ilike ${pattern}
      or concat_ws(' ', ${clientsTable.firstName}, ${clientsTable.lastName}) ilike ${pattern}
      or exists (select 1 from messages search_message
        where search_message.thread_id = ${messageThreadsTable.id} and search_message.body ilike ${pattern}))`);
  }
  return sql.join(conditions.map(c => sql`(${c})`), sql` and `);
}

const threadFrom = sql`from ${messageThreadsTable}
  inner join ${clientsTable} on ${clientsTable.id} = ${messageThreadsTable.clientId}`;

/** One SQL page query: latest message via indexed LATERAL, never an N+1. */
export async function threadHeaders(database: MessageDatabase, user: User, where: SQL, limit = 50, offset = 0, filters: MessageFilters = {}) {
  const ranged = !!(filters.dateFrom || filters.dateTo);
  const result = await database.execute(sql`select
    ${messageThreadsTable.id} as "id", ${messageThreadsTable.clientId} as "clientId",
    concat_ws(' ', ${clientsTable.firstName}, ${clientsTable.lastName}) as "clientName",
    ${messageThreadsTable.subject} as "subject",
    ${messageTimestamp(sql`${messageThreadsTable.lastMessageAt}`)} as "lastMessageAt",
    coalesce(latest.preview, '') as "lastMessagePreview", last_author.name as "lastMessageByName",
    ${messageThreadsTable.messageCount} as "messageCount", coalesce(${unreadMessage(user.id)}, false) as "unread",
    ${ranged ? sql`range_stats.message_count` : sql`null::int`} as "rangeMessageCount",
    ${ranged ? messageTimestamp(sql`range_stats.latest_at`) : sql`null::text`} as "rangeLatestAt",
    ${messageThreadsTable.includeCoordinator} as "includeCoordinator",
    case when ${messageThreadsTable.includeCoordinator} then coordinator.name else null end as "coordinatorName",
    coalesce((select array_agg(coalesce(rep.name, family_user.name) order by coalesce(rep.name, family_user.name), family_user.id)
      from message_thread_family_members fm inner join users family_user on family_user.id = fm.user_id
      left join family_representatives rep on rep.user_id = family_user.id
        and rep.client_id = ${messageThreadsTable.clientId} and rep.is_deleted = false
      where fm.thread_id = ${messageThreadsTable.id}), array[]::text[]) as "familyMemberNames",
    case when assignee.id is null then null else jsonb_build_object('userId', assignee.id, 'name', assignee.name) end as "assignee",
     ${messageTimestamp(sql`${messageThreadsTable.assignedAt}`)} as "assignedAt",
     case when assigner.id is null then null else jsonb_build_object('userId', assigner.id, 'name', assigner.name) end as "assignedBy",
     ${messageTimestamp(sql`${messageThreadsTable.resolvedAt}`)} as "resolvedAt",
     case when resolver.id is null then null else jsonb_build_object('userId', resolver.id, 'name', resolver.name) end as "resolvedBy",
    ${messageTimestamp(sql`${messageThreadsTable.createdAt}`)} as "createdAt"
    ${threadFrom}
    left join users last_author on last_author.id = ${messageThreadsTable.lastMessageBy}
    left join users coordinator on coordinator.id = ${clientsTable.assignedCoordinatorId}
      and coordinator.role = 'service_coordinator' and coordinator.active = true
    left join users assignee on assignee.id = ${messageThreadsTable.assigneeUserId}
     left join users assigner on assigner.id = ${messageThreadsTable.assignedBy}
     left join users resolver on resolver.id = ${messageThreadsTable.resolvedBy}
    left join lateral (select left(m.body, 140) as preview from messages m
      where m.thread_id = ${messageThreadsTable.id} order by m.created_at desc, m.id desc limit 1) latest on true
    ${ranged ? sql`left join lateral (
      select count(*)::int as message_count, max(range_message.created_at) as latest_at
      from messages range_message where range_message.thread_id = ${messageThreadsTable.id}
        and ${messageDateBounds(sql`range_message.created_at`, filters)}
    ) range_stats on true` : sql``}
    where ${where} order by ${messageThreadsTable.lastMessageAt} desc, ${messageThreadsTable.id} desc
    limit ${limit} offset ${offset}`);
  return result.rows;
}
export async function threadCount(database: MessageDatabase, where: SQL): Promise<number> {
  const result = await database.execute<{ total: number }>(sql`select count(*)::int as total ${threadFrom} where ${where}`);
  return result.rows[0].total;
}

export async function messageRecipients(database: MessageDatabase, clientId: string, lockUsers = false) {
  const coordinator = await database.execute<{ userId: string; name: string }>(sql`
    select u.id as "userId", u.name from users u inner join clients c on c.assigned_coordinator_id = u.id
    where c.id = ${clientId} and u.active = true and u.role = 'service_coordinator'
    ${lockUsers ? sql`for share of u` : sql``}`);
  const family = await database.execute<{ userId: string; name: string; role: string; relationship: string | null }>(sql`
    select u.id as "userId", coalesce(rep.name, u.name) as name, u.role, rep.relationship
    from users u left join family_representatives rep on rep.user_id = u.id and rep.client_id = ${clientId} and rep.is_deleted = false
    where u.active = true and u.role in ('parent_guardian', 'self')
      and u.linked_record_type = 'client' and u.linked_record_id = ${clientId}
    order by coalesce(rep.name, u.name), u.id ${lockUsers ? sql`for share of u` : sql``}`);
  const without = await database.execute<{ familyRepresentativeId: string; name: string }>(sql`
    select id as "familyRepresentativeId", name from family_representatives
    where client_id = ${clientId} and user_id is null and is_deleted = false order by name, id`);
  return { coordinator: coordinator.rows[0] ?? null, family: family.rows, familyWithoutPortal: without.rows };
}

export async function messagePage(database: MessageDatabase, threadId: string, userId: string,
  limit = 50, before?: string, beforeId?: string, untilDate?: string) {
  const cursor = before
    ? beforeId ? sql`and (m.created_at, m.id) < (${before}::timestamptz, ${beforeId}::uuid)`
      : sql`and m.created_at < ${before}::timestamptz`
    : untilDate ? sql`and ${messageDateBounds(sql`m.created_at`, { dateTo: untilDate })}` : sql``;
  const result = await database.execute<{ id: string; body: string; createdAt: string; author: { userId: string; name: string; role: string }; isMine: boolean }>(sql`
    select m.id, m.body, ${messageTimestamp(sql`m.created_at`)} as "createdAt",
      jsonb_build_object('userId', u.id, 'name', u.name, 'role', u.role) as author,
      m.author_user_id = ${userId} as "isMine"
    from messages m inner join users u on u.id = m.author_user_id where m.thread_id = ${threadId} ${cursor}
    order by m.created_at desc, m.id desc limit ${limit + 1}`);
  const hasMore = result.rows.length > limit, messages = result.rows.slice(0, limit), oldest = messages.at(-1);
  const newest = messages[0];
  const newer = await database.execute<{ hasNewer: boolean }>(sql`select exists(
    select 1 from messages m where m.thread_id = ${threadId}
      ${newest ? sql`and (m.created_at, m.id) > (${newest.createdAt}::timestamptz, ${newest.id}::uuid)` : sql``}
  ) as "hasNewer"`);
  return { messages, hasMore, hasNewer: newer.rows[0].hasNewer,
    nextCursor: hasMore && oldest ? { before: oldest.createdAt, beforeId: oldest.id } : null };
}
