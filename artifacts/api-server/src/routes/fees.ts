import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, feesTable } from "@workspace/db";
import {
  ListFeesQueryParams,
  ListFeesResponse,
  CreateFeeBody,
  CreateFeeResponse,
  UpdateFeeBody,
  UpdateFeeResponse,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, audit } from "../lib/auth";
import { feeJson, clientNameMap, notDeleted, diffDetail } from "../lib/serializers";

const router: IRouter = Router();

async function enrichFees(fees: (typeof feesTable.$inferSelect)[]) {
  const clientNames = await clientNameMap(fees.map((f) => f.clientId));
  return fees.map((f) => feeJson(f, { clientName: clientNames.get(f.clientId) }));
}

router.get("/fees", requireAuth, async (req, res): Promise<void> => {
  const query = ListFeesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  let fees = await db.select().from(feesTable).where(notDeleted(feesTable)).orderBy(desc(feesTable.createdAt));
  const u = req.user!;
  if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    fees = fees.filter((f) => f.clientId === u.linkedRecordId);
  } else if (u.role === "vendor") {
    fees = [];
  }
  if (query.data.clientId) fees = fees.filter((f) => f.clientId === query.data.clientId);
  if (query.data.status) fees = fees.filter((f) => f.status === query.data.status);
  res.json(ListFeesResponse.parse(await enrichFees(fees)));
});

router.post("/fees", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateFeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [fee] = await db
    .insert(feesTable)
    .values({ ...parsed.data, createdBy: req.user!.id })
    .returning();
  await audit(req.user!.id, "create_fee", "fee", fee.id, `$${fee.amount}${fee.ruleApplied ? ` (${fee.ruleApplied})` : ""}`);
  res.status(201).json(CreateFeeResponse.parse((await enrichFees([fee]))[0]));
});

router.patch("/fees/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateFeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [before] = await db
    .select()
    .from(feesTable)
    .where(and(eq(feesTable.id, id), notDeleted(feesTable)));
  if (!before) {
    res.status(404).json({ error: "Fee not found" });
    return;
  }
  const [fee] = await db
    .update(feesTable)
    .set(parsed.data)
    .where(and(eq(feesTable.id, id), notDeleted(feesTable)))
    .returning();
  await audit(
    req.user!.id,
    "update_fee",
    "fee",
    fee.id,
    diffDetail(before, parsed.data, Object.keys(parsed.data)),
  );
  res.json(UpdateFeeResponse.parse((await enrichFees([fee]))[0]));
});

router.delete("/fees/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [fee] = await db
    .update(feesTable)
    .set({ isDeleted: true, deletedAt: new Date(), deletedBy: req.user!.id })
    .where(and(eq(feesTable.id, id), notDeleted(feesTable)))
    .returning();
  if (!fee) {
    res.status(404).json({ error: "Fee not found" });
    return;
  }
  await audit(req.user!.id, "delete_fee", "fee", fee.id, `$${fee.amount}`);
  res.json({ ok: true });
});

export default router;
