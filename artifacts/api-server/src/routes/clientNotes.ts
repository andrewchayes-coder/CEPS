import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, clientsTable, clientNotesTable, usersTable, type User } from "@workspace/db";
import {
  ListClientNotesParams, ListClientNotesResponse,
  CreateClientNoteParams, CreateClientNoteBody, CreateClientNoteResponse,
  UpdateClientNoteParams, UpdateClientNoteBody, UpdateClientNoteResponse,
  DeleteClientNoteParams,
} from "@workspace/api-zod";
import { requireAuth, requireStaffOrCoordinator, audit, getUserPermissions, hasUserPermissionInTransaction } from "../lib/auth";
import { coordinatorCanAccessClient } from "../lib/clientAccess";

const router: IRouter = Router();
const updater = alias(usersTable, "note_updater");
type Database = typeof db;
type Access = { error: string; status: number } | null;

async function access(database: Database, clientId: string, user: User, lock = false): Promise<Access> {
  const query = database.select().from(clientsTable)
    .where(and(eq(clientsTable.id, clientId), eq(clientsTable.isDeleted, false)));
  // Keep assignment/deletion stable until a note mutation and its audit commit.
  const [client] = await (lock ? query.for("share") : query);
  if (!client) return { status: 404, error: "Participant not found" };
  if (!coordinatorCanAccessClient(user, client)) return { status: 403, error: "Forbidden" };
  return null;
}

function readNotes(database: Database, clientId: string, noteId?: string) {
  return database.select({
    id: clientNotesTable.id, body: clientNotesTable.body, createdBy: clientNotesTable.createdBy,
    authorName: usersTable.name, authorRole: usersTable.role,
    createdAt: clientNotesTable.createdAt, updatedAt: clientNotesTable.updatedAt,
    updatedByName: updater.name,
  }).from(clientNotesTable)
    .innerJoin(usersTable, eq(clientNotesTable.createdBy, usersTable.id))
    .leftJoin(updater, eq(clientNotesTable.updatedBy, updater.id))
    .where(and(
      eq(clientNotesTable.clientId, clientId), eq(clientNotesTable.isDeleted, false),
      noteId ? eq(clientNotesTable.id, noteId) : undefined,
    )).orderBy(desc(clientNotesTable.createdAt), desc(clientNotesTable.id));
}

function json(row: Awaited<ReturnType<typeof readNotes>>[number], userId: string, canManage = false) {
  const own = row.createdBy === userId;
  return {
    id: row.id, body: row.body, authorName: row.authorName, authorRole: row.authorRole,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt?.toISOString() ?? null,
    updatedByName: row.updatedByName, canEdit: own, canDelete: own || canManage,
  };
}

const trimmedBody = (body: unknown) => {
  const value = (body as { body?: unknown } | null)?.body;
  return { body: typeof value === "string" ? value.trim() : value };
};

router.get("/clients/:id/notes", requireAuth, requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const params = ListClientNotesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid participant ID" }); return; }
  const denied = await access(db, params.data.id, req.user!);
  if (denied) { res.status(denied.status).json({ error: denied.error }); return; }
  const canManage = req.user!.role === "staff"
    && (await getUserPermissions(req.user!.id, db, req)).includes("manage_users");
  res.json(ListClientNotesResponse.parse((await readNotes(db, params.data.id)).map(n => json(n, req.user!.id, canManage))));
});

router.post("/clients/:id/notes", requireAuth, requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const params = CreateClientNoteParams.safeParse(req.params);
  const body = CreateClientNoteBody.safeParse(trimmedBody(req.body));
  if (!params.success || !body.success) { res.status(400).json({ error: "Note must contain 1–5000 characters and a valid participant ID" }); return; }
  const result = await db.transaction(async tx => {
    const database = tx as unknown as Database;
    const denied = await access(database, params.data.id, req.user!, true);
    if (denied) return denied;
    const [row] = await tx.insert(clientNotesTable).values({
      clientId: params.data.id, body: body.data.body, createdBy: req.user!.id,
    }).returning();
    await audit(req.user!.id, "create_client_note", "client_note", row.clientId,
      `Note ${row.id}\n${row.body}`, database);
    const [note] = await readNotes(database, row.clientId, row.id);
    return { note: json(note, req.user!.id) };
  });
  if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
  res.status(201).json(CreateClientNoteResponse.parse(result.note));
});

router.patch("/clients/:id/notes/:noteId", requireAuth, requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const params = UpdateClientNoteParams.safeParse(req.params);
  const body = UpdateClientNoteBody.safeParse(trimmedBody(req.body));
  if (!params.success || !body.success) { res.status(400).json({ error: "Note must contain 1–5000 characters and valid IDs" }); return; }
  const result = await db.transaction(async tx => {
    const database = tx as unknown as Database;
    const denied = await access(database, params.data.id, req.user!, true);
    if (denied) return denied;
    const [before] = await tx.select().from(clientNotesTable).where(and(
      eq(clientNotesTable.id, params.data.noteId), eq(clientNotesTable.clientId, params.data.id),
      eq(clientNotesTable.isDeleted, false),
    )).for("update");
    if (!before) return { status: 404, error: "Note not found" };
    if (before.createdBy !== req.user!.id) return { status: 403, error: "Only the author can edit this note" };
    await tx.update(clientNotesTable).set({
      body: body.data.body, updatedAt: new Date(), updatedBy: req.user!.id,
    }).where(eq(clientNotesTable.id, before.id));
    await audit(req.user!.id, "update_client_note", "client_note", before.clientId,
      `Note ${before.id}\nBefore: "${before.body}" → After: "${body.data.body}"`, database);
    const [note] = await readNotes(database, before.clientId, before.id);
    return { note: json(note, req.user!.id) };
  });
  if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
  res.json(UpdateClientNoteResponse.parse(result.note));
});

router.delete("/clients/:id/notes/:noteId", requireAuth, requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const params = DeleteClientNoteParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid IDs" }); return; }
  const denied = await db.transaction(async tx => {
    const database = tx as unknown as Database;
    const blocked = await access(database, params.data.id, req.user!, true);
    if (blocked) return blocked;
    const [note] = await tx.select().from(clientNotesTable).where(and(
      eq(clientNotesTable.id, params.data.noteId), eq(clientNotesTable.clientId, params.data.id),
      eq(clientNotesTable.isDeleted, false),
    )).for("update");
    if (!note) return { status: 404, error: "Note not found" };
    const own = note.createdBy === req.user!.id;
    const admin = !own && req.user!.role === "staff"
      && await hasUserPermissionInTransaction(tx, req.user!.id, "manage_users");
    if (!own && !admin) return { status: 403, error: "Only the author or staff with manage-users permission can delete this note" };
    await tx.update(clientNotesTable).set({
      isDeleted: true, deletedAt: new Date(), deletedBy: req.user!.id,
    }).where(eq(clientNotesTable.id, note.id));
    await audit(req.user!.id, "delete_client_note", "client_note", note.clientId,
      `Note ${note.id}\n${note.body}`, database);
    return null;
  });
  if (denied) { res.status(denied.status).json({ error: denied.error }); return; }
  res.sendStatus(204);
});

export default router;
