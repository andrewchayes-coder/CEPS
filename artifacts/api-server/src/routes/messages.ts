import { Router, type IRouter, type ErrorRequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { db, messageThreadsTable } from "@workspace/db";
import {
  ListMessageRecipientsParams, ListMessageRecipientsResponse,
  ListMessageThreadsQueryParams, ListMessageThreadsResponse,
  ListClientMessageThreadsParams, ListClientMessageThreadsQueryParams, ListClientMessageThreadsResponse,
  CreateMessageThreadParams, CreateMessageThreadBody, CreateMessageThreadResponse,
  GetMessageThreadParams, GetMessageThreadQueryParams, GetMessageThreadResponse,
  SendMessageParams, SendMessageBody, SendMessageResponse,
  MarkMessageThreadReadParams, MarkMessageThreadReadResponse,
  GetMessagingUnreadCountResponse,
  AddMessageThreadFamilyMembersParams, AddMessageThreadFamilyMembersBody, AddMessageThreadFamilyMembersResponse,
} from "@workspace/api-zod";
import { requireAuth, requireRole, audit } from "../lib/auth";
import { MessageError, messageActor, messageClient, messageScope, messageThread, type MessageDatabase } from "../lib/messageAccess";
import { threadFilters, threadHeaders, threadCount, messageRecipients, messagePage, type MessageFilters } from "../lib/messageQueries";
import { addFamilyMembers, appendMessage, markMessageRead, validateFamilyRecipients } from "../lib/messageMutations";

const router: IRouter = Router();
router.use(["/messages", "/clients/:id/message-threads", "/clients/:id/message-recipients"],
  requireAuth, requireRole("staff", "service_coordinator", "parent_guardian", "self"));

function valid<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new MessageError(400, "Invalid message, recipients, ID or filters");
  return result.data;
}
function trimInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const body = input as Record<string, unknown>;
  return { ...body, ...(typeof body.subject === "string" ? { subject: body.subject.trim() } : {}),
    ...(typeof body.body === "string" ? { body: body.body.trim() } : {}) };
}
function isCalendarDay(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value;
}
function checkDates(filters: MessageFilters) {
  for (const date of [filters.dateFrom, filters.dateTo]) {
    if (date && !isCalendarDay(date)) throw new MessageError(400, "Invalid calendar date");
  }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    throw new MessageError(400, "Date from must not be after date to");
  }
}

router.get("/clients/:id/message-recipients", async (req, res): Promise<void> => {
  const { id } = valid(ListMessageRecipientsParams.safeParse(req.params));
  await messageClient(db, id, req.user!);
  res.json(ListMessageRecipientsResponse.parse(await messageRecipients(db, id)));
});

router.get("/messages/threads", async (req, res): Promise<void> => {
  const filters = valid(ListMessageThreadsQueryParams.safeParse(req.query));
  checkDates(filters);
  const where = threadFilters(req.user!, filters);
  const [items, total] = await Promise.all([
    threadHeaders(db, req.user!, where, filters.limit, filters.offset), threadCount(db, where),
  ]);
  res.json(ListMessageThreadsResponse.parse({ items, total }));
});

router.get("/clients/:id/message-threads", async (req, res): Promise<void> => {
  const { id } = valid(ListClientMessageThreadsParams.safeParse(req.params));
  const filters = valid(ListClientMessageThreadsQueryParams.safeParse(req.query));
  checkDates(filters);
  await messageClient(db, id, req.user!);
  const where = threadFilters(req.user!, { ...filters, clientId: id });
  const [items, total] = await Promise.all([
    threadHeaders(db, req.user!, where, filters.limit, filters.offset), threadCount(db, where),
  ]);
  res.json(ListClientMessageThreadsResponse.parse({ items, total }));
});

router.post("/clients/:id/message-threads", async (req, res): Promise<void> => {
  const { id } = valid(CreateMessageThreadParams.safeParse(req.params));
  const body = valid(CreateMessageThreadBody.safeParse(trimInput(req.body)));
  const result = await db.transaction(async tx => {
    const database = tx as unknown as MessageDatabase;
    const actor = await messageActor(database, req.user!.id);
    const client = await messageClient(database, id, actor, true);
    if (client.isDeleted) throw new MessageError(409, "Participant is deleted");
    const includeCoordinator = actor.role === "service_coordinator" ? true : body.includeCoordinator ?? true;
    const familyIds = [...(body.familyUserIds ?? [])];
    if (actor.role === "parent_guardian" || actor.role === "self") familyIds.push(actor.id);
    const { recipients, userIds } = await validateFamilyRecipients(database, id, familyIds);
    if (actor.role === "staff" && !(includeCoordinator && recipients.coordinator) && userIds.length === 0) {
      throw new MessageError(400, "Choose who this message is to");
    }
    const [thread] = await database.insert(messageThreadsTable).values({
      clientId: id, subject: body.subject, includeCoordinator, createdBy: actor.id,
    }).returning();
    await addFamilyMembers(database, thread.id, userIds, actor.id);
    await appendMessage(database, thread.id, id, actor, body.body);
    const names = [
      ...(includeCoordinator && recipients.coordinator ? [recipients.coordinator.name] : []),
      ...recipients.family.filter(person => userIds.includes(person.userId)).map(person => person.name),
    ];
    await audit(actor.id, "create_message_thread", "message_thread", id,
      `Thread ${thread.id}: ${body.subject}\nTo: ${names.join(", ")}`, database);
    const [header] = await threadHeaders(database, actor, and(messageScope(actor), eq(messageThreadsTable.id, thread.id))!);
    return { thread: header, ...await messagePage(database, thread.id, actor.id) };
  });
  res.status(201).json(CreateMessageThreadResponse.parse(result));
});

router.get("/messages/threads/:threadId", async (req, res): Promise<void> => {
  const { threadId } = valid(GetMessageThreadParams.safeParse(req.params));
  const query = valid(GetMessageThreadQueryParams.safeParse(req.query));
  if (query.beforeId && !query.before) throw new MessageError(400, "beforeId requires before");
  if (query.before && (!isCalendarDay(query.before.slice(0, 10))
    || !/T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d/.test(query.before)
    || !Number.isFinite(new Date(query.before).getTime()))) {
    throw new MessageError(400, "Invalid message cursor");
  }
  const [thread] = await threadHeaders(db, req.user!, and(messageScope(req.user!), eq(messageThreadsTable.id, threadId))!);
  if (!thread) throw new MessageError(404, "Thread not found");
  res.json(GetMessageThreadResponse.parse({ thread, ...await messagePage(db, threadId, req.user!.id, query.limit, query.before, query.beforeId) }));
});

router.post("/messages/threads/:threadId/messages", async (req, res): Promise<void> => {
  const { threadId } = valid(SendMessageParams.safeParse(req.params));
  const body = valid(SendMessageBody.safeParse(trimInput(req.body)));
  const result = await db.transaction(async tx => {
    const database = tx as unknown as MessageDatabase;
    const actor = await messageActor(database, req.user!.id);
    const { thread, client } = await messageThread(database, threadId, actor, true);
    if (client.isDeleted) throw new MessageError(409, "Participant is deleted");
    await appendMessage(database, threadId, thread.clientId, actor, body.body);
    await audit(actor.id, "send_message", "message_thread", thread.clientId, `Thread ${threadId}\n${body.body}`, database);
    return (await messagePage(database, threadId, actor.id, 1)).messages[0];
  });
  res.status(201).json(SendMessageResponse.parse(result));
});

router.post("/messages/threads/:threadId/read", async (req, res): Promise<void> => {
  const { threadId } = valid(MarkMessageThreadReadParams.safeParse(req.params));
  await db.transaction(async tx => {
    const database = tx as unknown as MessageDatabase;
    const actor = await messageActor(database, req.user!.id);
    await messageThread(database, threadId, actor, true);
    await markMessageRead(database, threadId, actor.id);
  });
  res.json(MarkMessageThreadReadResponse.parse({ success: true }));
});

router.get("/messages/unread-count", async (req, res): Promise<void> => {
  // Exactly one indexed count query, with no header/preview lookups.
  res.json(GetMessagingUnreadCountResponse.parse({ count: await threadCount(db, threadFilters(req.user!, { view: "unread" })) }));
});

router.post("/messages/threads/:threadId/family-members", async (req, res): Promise<void> => {
  const { threadId } = valid(AddMessageThreadFamilyMembersParams.safeParse(req.params));
  const body = valid(AddMessageThreadFamilyMembersBody.safeParse(req.body));
  const result = await db.transaction(async tx => {
    const database = tx as unknown as MessageDatabase;
    const actor = await messageActor(database, req.user!.id);
    const { thread } = await messageThread(database, threadId, actor, true);
    if (actor.role !== "staff" && actor.role !== "service_coordinator") throw new MessageError(403, "Forbidden");
    const { recipients, userIds } = await validateFamilyRecipients(database, thread.clientId, body.userIds);
    await addFamilyMembers(database, threadId, userIds, actor.id);
    await audit(actor.id, "update_message_thread_members", "message_thread", thread.clientId,
      `Thread ${threadId}\nAdded: ${recipients.family.filter(p => userIds.includes(p.userId)).map(p => p.name).join(", ")}`, database);
    return (await threadHeaders(database, actor, and(messageScope(actor), eq(messageThreadsTable.id, threadId))!))[0];
  });
  res.json(AddMessageThreadFamilyMembersResponse.parse(result));
});

const errors: ErrorRequestHandler = (error, _req, res, next) => {
  if (error instanceof MessageError) { res.status(error.status).json({ error: error.message }); return; }
  next(error);
};
router.use(errors);
export default router;
