import { Router, type IRouter } from "express";
import { eq, desc, and, ne } from "drizzle-orm";
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
import { validateParticipantLinks } from "../lib/participantLinks";

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
  const filters = [notDeleted(feesTable)];
  if (query.data.clientId) filters.push(eq(feesTable.clientId, query.data.clientId));
  if (query.data.status) filters.push(eq(feesTable.status, query.data.status));
  if (query.data.feeMonth) filters.push(eq(feesTable.feeMonth, query.data.feeMonth));
  let fees = await db.select().from(feesTable).where(and(...filters)).orderBy(desc(feesTable.createdAt));
  const u = req.user!;
  if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    fees = fees.filter((f) => f.clientId === u.linkedRecordId);
  } else if (u.role === "vendor") {
    fees = [];
  }
  res.json(ListFeesResponse.parse(await enrichFees(fees)));
});

router.post("/fees", requireStaff, async (req, res): Promise<void> => {
  const body = { ...req.body, ...(req.body?.feeMonth === "" ? { feeMonth: null } : {}) };
  const parsed = CreateFeeBody.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  let relationshipError: string | undefined;
  const fee = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    relationshipError = (await validateParticipantLinks(txDb, parsed.data.clientId, {
      paymentId: parsed.data.paymentId,
      authorizationId: parsed.data.authorizationId,
    })).error;
    if (relationshipError) return null;
    try {
      const [created] = await tx
        .insert(feesTable)
        .values({ ...parsed.data, createdBy: req.user!.id })
        .returning();
      await audit(req.user!.id, "create_fee", "fee", created.id, `$${created.amount}${created.ruleApplied ? ` (${created.ruleApplied})` : ""}`, txDb);
      return created;
    } catch (error) {
      if (isFeeMonthConflict(error)) return "conflict" as const;
      throw error;
    }
  });
  if (fee === "conflict") {
    res.status(409).json({ error: "An active fee already exists for this client and month" });
    return;
  }
  if (!fee) {
    res.status(400).json({ error: relationshipError });
    return;
  }
  res.status(201).json(CreateFeeResponse.parse((await enrichFees([fee]))[0]));
});

router.patch("/fees/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const body = { ...req.body, ...(req.body?.feeMonth === "" ? { feeMonth: null } : {}) };
  const parsed = UpdateFeeBody.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  let relationshipError: string | undefined;
  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    const [before] = await tx
      .select()
      .from(feesTable)
      .where(and(eq(feesTable.id, id), notDeleted(feesTable)))
      .for("update");
    if (!before) return { kind: "not_found" as const };
    relationshipError = (await validateParticipantLinks(txDb, before.clientId, {
      paymentId: before.paymentId,
      authorizationId: before.authorizationId,
      allowDeletedPayment: true,
    })).error;
    if (relationshipError) return { kind: "invalid_link" as const };
    const finalFeeMonth = parsed.data.feeMonth === undefined ? before.feeMonth : parsed.data.feeMonth;
    if (finalFeeMonth !== null) {
      const [conflict] = await tx.select({ id: feesTable.id }).from(feesTable).where(and(
        eq(feesTable.clientId, before.clientId),
        eq(feesTable.feeMonth, finalFeeMonth),
        ne(feesTable.id, id),
        notDeleted(feesTable),
      )).limit(1);
      if (conflict) return { kind: "conflict" as const };
    }
    let fee: typeof before;
    try {
      [fee] = await tx
        .update(feesTable)
        .set(parsed.data)
        .where(and(eq(feesTable.id, id), notDeleted(feesTable)))
        .returning();
    } catch (error) {
      if (isFeeMonthConflict(error)) return { kind: "conflict" as const };
      throw error;
    }
    await audit(
      req.user!.id,
      "update_fee",
      "fee",
      fee.id,
      diffDetail(before, parsed.data, Object.keys(parsed.data)),
      txDb,
    );
    return { kind: "updated" as const, fee };
  });
  if (result.kind === "not_found") {
    res.status(404).json({ error: "Fee not found" });
    return;
  }
  if (result.kind === "invalid_link") {
    res.status(400).json({ error: relationshipError });
    return;
  }
  if (result.kind === "conflict") {
    res.status(409).json({ error: "An active fee already exists for this client and month" });
    return;
  }
  res.json(UpdateFeeResponse.parse((await enrichFees([result.fee]))[0]));
});

function isFeeMonthConflict(error: unknown): boolean {
  let current = error as { code?: string; constraint?: string; cause?: unknown } | undefined;
  while (current) {
    if (
      current.code === "23505" &&
      current.constraint === "fees_active_client_fee_month_unique"
    ) {
      return true;
    }
    current = current.cause as typeof current;
  }
  return false;
}

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
