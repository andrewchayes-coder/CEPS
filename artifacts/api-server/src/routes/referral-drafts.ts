import { Router, type IRouter, type RequestHandler } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, referralDraftsTable } from "@workspace/db";
import { CreateReferralDraftBody, UpdateReferralDraftBody, ListReferralDraftsQueryParams } from "@workspace/api-zod";
import { audit, requireAuth } from "../lib/auth";
import { DraftAccessError, draftUci, lockActiveDraftOwner } from "../lib/referralDrafts";
import { normalizeValidateOwnedUploadPath } from "../lib/upload-paths";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const coordinatorOnly: RequestHandler = (req, res, next) => {
  if (req.user?.role !== "service_coordinator") { res.status(404).json({ error: "Draft not found" }); return; }
  next();
};
router.use("/referral-drafts", requireAuth, coordinatorOnly);
const uuid = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(s);
const uniqueError = (e: unknown): boolean => !!e && typeof e === "object" &&
  (("code" in e && e.code === "23505") || ("cause" in e && uniqueError(e.cause)));
const json = (row: typeof referralDraftsTable.$inferSelect, documentRestoreFailed = false) => ({
  ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), documentRestoreFailed,
});

router.get("/referral-drafts", async (req, res): Promise<void> => {
  const query = ListReferralDraftsQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid draft ID" }); return; }
  const conditions = [eq(referralDraftsTable.userId, req.user!.id)];
  if (query.data.id) conditions.push(eq(referralDraftsTable.id, query.data.id));
  const rows = await db.select().from(referralDraftsTable).where(and(...conditions))
    .orderBy(desc(referralDraftsTable.updatedAt), desc(referralDraftsTable.id));
  if (query.data.id && !rows.length) { res.status(404).json({ error: "Draft not found" }); return; }
  const items = [];
  for (const row of rows) {
    let failed = false;
    if (query.data.id && row.supportingDocumentUrl) {
      const path = normalizeValidateOwnedUploadPath(row.supportingDocumentUrl, req.user!.id);
      failed = !path;
      if (path) {
        try { await new ObjectStorageService().getObjectEntityFile(path); }
        catch (e) {
          if (e instanceof ObjectNotFoundError) failed = true;
          else throw e; // A storage outage must not discard an otherwise valid attachment.
        }
      }
      if (failed) {
        await db.update(referralDraftsTable).set({ supportingDocumentUrl: null })
          .where(and(eq(referralDraftsTable.id, row.id), eq(referralDraftsTable.supportingDocumentUrl, row.supportingDocumentUrl)));
        row.supportingDocumentUrl = null;
      }
    }
    items.push(json(row, failed));
  }
  res.json({ items });
});

const save: RequestHandler = async (req, res): Promise<void> => {
  const id = req.method === "PATCH" ? req.params.id : undefined;
  if (id !== undefined && !uuid(id)) { res.status(404).json({ error: "Draft not found" }); return; }
  const parsed = (id ? UpdateReferralDraftBody : CreateReferralDraftBody).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (Buffer.byteLength(JSON.stringify(parsed.data.data), "utf8") >= 200 * 1024) {
    res.status(413).json({ error: "Draft form data must be under 200 KB." }); return;
  }
  const data = parsed.data.data;
  if (data.clientUci != null && typeof data.clientUci !== "string") {
    res.status(400).json({ error: "UCI must be text." }); return;
  }
  const uci = draftUci(data.clientUci);
  const name = [data.clientFirstName, data.clientLastName].filter((v): v is string => typeof v === "string").join(" ").trim();
  const label = uci && name ? name.slice(0, 240) : "Untitled referral";
  try {
    const result = await db.transaction(async tx => {
      const database = tx as unknown as typeof db;
      await lockActiveDraftOwner(database, req.user!.id);
      const [before] = id ? await tx.select().from(referralDraftsTable)
        .where(and(eq(referralDraftsTable.id, id), eq(referralDraftsTable.userId, req.user!.id))).for("update") : [];
      if (id && !before) throw new DraftAccessError();
      const rawPath = parsed.data.supportingDocumentUrl === undefined ? before?.supportingDocumentUrl : parsed.data.supportingDocumentUrl;
      const path = rawPath ? normalizeValidateOwnedUploadPath(rawPath, req.user!.id) : null;
      if (rawPath && !path) throw new DraftAccessError("The attached document does not belong to this coordinator.", 400);
      const fields = { data, currentStep: parsed.data.currentStep, uciNumber: uci, label,
        supportingDocumentUrl: path, updatedAt: new Date() };
      const [row] = id
        ? await tx.update(referralDraftsTable).set(fields).where(and(eq(referralDraftsTable.id, id), eq(referralDraftsTable.userId, req.user!.id))).returning()
        : await tx.insert(referralDraftsTable).values({ ...fields, userId: req.user!.id }).returning();
      if (!id) await audit(req.user!.id, "create_referral_draft", "referral_draft", row.id, "Created referral draft", database);
      return row;
    });
    res.status(id ? 200 : 201).json(json(result));
  } catch (e) {
    if (e instanceof DraftAccessError) { res.status(e.status).json({ error: e.message }); return; }
    if (uniqueError(e)) {
      const [existing] = await db.select({ id: referralDraftsTable.id }).from(referralDraftsTable).where(and(
        eq(referralDraftsTable.userId, req.user!.id),
        uci === null ? isNull(referralDraftsTable.uciNumber) : eq(referralDraftsTable.uciNumber, uci)));
      res.status(409).json({ error: uci ? "You already have a draft referral for this participant. Open it or delete it to start a new one."
        : "You already have an untitled referral draft. Open it or delete it to start a new one.", existingDraftId: existing?.id });
      return;
    }
    throw e;
  }
};
router.post("/referral-drafts", save);
router.patch("/referral-drafts/:id", save);
router.delete("/referral-drafts/:id", async (req, res): Promise<void> => {
  if (!uuid(req.params.id)) { res.status(404).json({ error: "Draft not found" }); return; }
  const removed = await db.transaction(async tx => {
    const [row] = await tx.delete(referralDraftsTable).where(and(eq(referralDraftsTable.id, req.params.id as string),
      eq(referralDraftsTable.userId, req.user!.id))).returning();
    if (row) await audit(req.user!.id, "delete_referral_draft", "referral_draft", row.id, "Deleted referral draft", tx as unknown as typeof db);
    return row;
  });
  if (!removed) { res.status(404).json({ error: "Draft not found" }); return; }
  res.status(204).end();
});
export default router;
