import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, paymentsTable, clientsTable, remittancesTable, feesTable } from "@workspace/db";
import {
  ListPaymentsQueryParams,
  ListPaymentsResponse,
  CreatePaymentBody,
  CreatePaymentResponse,
  ImportCheckRegisterBody,
  ImportCheckRegisterResponse,
  UpdatePaymentBody,
  UpdatePaymentResponse,
  ListRemittancesQueryParams,
  ListRemittancesResponse,
  CreateRemittanceBody,
  CreateRemittanceResponse,
  UpdateRemittanceBody,
  UpdateRemittanceResponse,
  MatchRemittanceBody,
  MatchRemittanceResponse,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, audit } from "../lib/auth";
import { paymentJson, remittanceJson, clientNameMap, vendorNameMap, authNumberMap, notDeleted, diffDetail } from "../lib/serializers";

const router: IRouter = Router();

// ⚠️ INTERIM PLACEHOLDER — the exact Fee auto-generation trigger/amount rule and
// qualifying service codes are pending confirmation from CEPS (docs/CEPS_OPEN_ITEMS.md #4).
// Until then, every logged payment auto-generates a Fee of 5% of the payment amount,
// status "pending", ruleApplied "interim_flat_percent_5_pending_confirmation".
// This helper is intentionally isolated so the rule can be swapped once CEPS confirms.
const INTERIM_FEE_RULE = "interim_flat_percent_5_pending_confirmation";
const INTERIM_FEE_RATE = 0.05;

async function autoGenerateFee(
  payment: typeof paymentsTable.$inferSelect,
  userId: string,
  tx: typeof db = db,
): Promise<void> {
  const feeAmount = (Number(payment.amount) * INTERIM_FEE_RATE).toFixed(2);
  const [fee] = await tx
    .insert(feesTable)
    .values({
      clientId: payment.clientId,
      paymentId: payment.id,
      authorizationId: payment.authorizationId ?? null,
      amount: feeAmount,
      ruleApplied: INTERIM_FEE_RULE,
      status: "pending",
    })
    .returning();
  await audit(userId, "auto_generate_fee", "fee", fee.id, `Auto-generated $${feeAmount} (${INTERIM_FEE_RULE}) for check ${payment.qbCheckNumber}`);
}

async function enrichPayments(payments: (typeof paymentsTable.$inferSelect)[]) {
  const [clientNames, vendorNames, authNums] = await Promise.all([
    clientNameMap(payments.map((p) => p.clientId)),
    vendorNameMap(payments.map((p) => p.vendorId)),
    authNumberMap(payments.map((p) => p.authorizationId)),
  ]);
  return payments.map((p) =>
    paymentJson(p, {
      clientName: clientNames.get(p.clientId),
      vendorName: p.vendorId ? vendorNames.get(p.vendorId) : null,
      authNumber: p.authorizationId ? authNums.get(p.authorizationId) : null,
    }),
  );
}

router.get("/payments", requireAuth, async (req, res): Promise<void> => {
  const query = ListPaymentsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  let payments = await db
    .select()
    .from(paymentsTable)
    .where(notDeleted(paymentsTable))
    .orderBy(desc(paymentsTable.checkDate));
  const u = req.user!;
  if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    payments = payments.filter((p) => p.vendorId === u.linkedRecordId);
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    payments = payments.filter((p) => p.clientId === u.linkedRecordId);
  }
  if (query.data.clientId) payments = payments.filter((p) => p.clientId === query.data.clientId);
  if (query.data.vendorId) payments = payments.filter((p) => p.vendorId === query.data.vendorId);
  if (query.data.authorizationId) payments = payments.filter((p) => p.authorizationId === query.data.authorizationId);
  res.json(ListPaymentsResponse.parse(await enrichPayments(payments)));
});

router.post("/payments", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreatePaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Normalize empty strings from the form to null for optional/nullable FK columns
  const values = { ...parsed.data, source: "manual", loggedBy: req.user!.id } as Record<string, unknown>;
  for (const k of ["authorizationId", "vendorId", "invoiceId", "paymentMonth"] as const) {
    if (values[k] === "") values[k] = null;
  }
  // Persist the payment and its auto-generated Fee atomically so a payment can
  // never exist without its corresponding fee.
  const payment = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(paymentsTable)
      .values(values as typeof paymentsTable.$inferInsert)
      .returning();
    // INTERIM PLACEHOLDER: auto-generate the corresponding Fee record. The real trigger
    // conditions/amount rule are pending CEPS confirmation — see docs/CEPS_OPEN_ITEMS.md #4.
    await autoGenerateFee(p, req.user!.id, tx as unknown as typeof db);
    return p;
  });
  await audit(req.user!.id, "create_payment", "payment", payment.id, `Check ${payment.qbCheckNumber} — $${payment.amount}`);
  res.status(201).json(CreatePaymentResponse.parse((await enrichPayments([payment]))[0]));
});

router.post("/payments/import", requireStaff, async (req, res): Promise<void> => {
  const parsed = ImportCheckRegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const clients = await db.select().from(clientsTable).where(notDeleted(clientsTable));
  const results: { qbCheckNumber: string; outcome: "imported" | "skipped_duplicate" | "unmatched"; message?: string | null; paymentId?: string | null }[] = [];
  let imported = 0;
  let skipped = 0;
  let unmatched = 0;

  for (const row of parsed.data.rows) {
    const [dup] = await db.select().from(paymentsTable).where(and(eq(paymentsTable.qbCheckNumber, row.qbCheckNumber), notDeleted(paymentsTable)));
    if (dup) {
      skipped++;
      results.push({ qbCheckNumber: row.qbCheckNumber, outcome: "skipped_duplicate", message: "A payment with this check number already exists.", paymentId: dup.id });
      continue;
    }
    const nameNeedle = (row.clientName ?? "").trim().toLowerCase();
    const client = nameNeedle
      ? clients.find((c) => `${c.firstName} ${c.lastName}`.toLowerCase() === nameNeedle || `${c.lastName}, ${c.firstName}`.toLowerCase() === nameNeedle)
      : undefined;
    if (!client) {
      unmatched++;
      results.push({
        qbCheckNumber: row.qbCheckNumber,
        outcome: "unmatched",
        message: row.clientName ? `No client matched "${row.clientName}". Log this payment manually.` : "No client name in this row. Log this payment manually.",
      });
      continue;
    }
    // Persist the imported payment and its auto-generated Fee atomically.
    const payment = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(paymentsTable)
        .values({
          clientId: client.id,
          qbCheckNumber: row.qbCheckNumber,
          checkDate: row.checkDate,
          amount: row.amount,
          paymentMonth: row.checkDate.slice(0, 7),
          paymentType: "direct_payment",
          source: "quickbooks",
          loggedBy: req.user!.id,
        })
        .returning();
      // INTERIM PLACEHOLDER: auto-generate the corresponding Fee for imported payments too
      // (rule pending CEPS confirmation — docs/CEPS_OPEN_ITEMS.md #4).
      await autoGenerateFee(p, req.user!.id, tx as unknown as typeof db);
      return p;
    });
    imported++;
    results.push({ qbCheckNumber: row.qbCheckNumber, outcome: "imported", message: `Matched to ${client.firstName} ${client.lastName}.`, paymentId: payment.id });
  }
  await audit(req.user!.id, "import_check_register", "payment", undefined, `${imported} imported, ${skipped} skipped, ${unmatched} unmatched`);
  res.json(ImportCheckRegisterResponse.parse({ imported, skipped, unmatched, results }));
});

router.patch("/payments/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdatePaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updates = { ...parsed.data } as Record<string, unknown>;
  for (const k of ["authorizationId", "vendorId", "invoiceId", "paymentMonth"] as const) {
    if (updates[k] === "") updates[k] = null;
  }
  const [before] = await db
    .select()
    .from(paymentsTable)
    .where(and(eq(paymentsTable.id, id), notDeleted(paymentsTable)));
  if (!before) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  // If the amount changed, keep the auto-generated interim fee consistent by
  // recalculating it with the same 5% rule as autoGenerateFee. We only touch
  // fees still on the interim rule and never clobber a waived (manually
  // adjusted) fee. Payment + fee updates run in one transaction.
  const amountChanged =
    "amount" in parsed.data && String(before.amount) !== String(updates.amount);
  const { payment, recalculatedFees } = await db.transaction(async (tx) => {
    const [p] = await tx
      .update(paymentsTable)
      .set(updates)
      .where(and(eq(paymentsTable.id, id), notDeleted(paymentsTable)))
      .returning();
    const recalculated: { id: string; before: string; after: string }[] = [];
    if (amountChanged) {
      const linkedFees = await tx
        .select()
        .from(feesTable)
        .where(and(eq(feesTable.paymentId, p.id), notDeleted(feesTable)));
      const newFeeAmount = (Number(p.amount) * INTERIM_FEE_RATE).toFixed(2);
      for (const fee of linkedFees) {
        if (fee.ruleApplied !== INTERIM_FEE_RULE) continue; // don't clobber manually set fees
        if (fee.status === "waived") continue; // don't clobber a waived fee
        if (String(fee.amount) === newFeeAmount) continue;
        await tx.update(feesTable).set({ amount: newFeeAmount }).where(eq(feesTable.id, fee.id));
        recalculated.push({ id: fee.id, before: String(fee.amount), after: newFeeAmount });
      }
    }
    return { payment: p, recalculatedFees: recalculated };
  });
  await audit(
    req.user!.id,
    "update_payment",
    "payment",
    payment.id,
    diffDetail(before, updates, Object.keys(updates)),
  );
  for (const f of recalculatedFees) {
    await audit(req.user!.id, "update_fee", "fee", f.id, `Auto-recalculated fee $${f.before} → $${f.after} after payment amount change (${INTERIM_FEE_RULE})`);
  }
  res.json(UpdatePaymentResponse.parse((await enrichPayments([payment]))[0]));
});

router.delete("/payments/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const deletedAt = new Date();
  const deletedBy = req.user!.id;
  // Soft-delete the payment and any linked auto-generated fee(s) together so a
  // deleted payment never leaves an orphaned fee behind.
  const { payment, deletedFees } = await db.transaction(async (tx) => {
    const [p] = await tx
      .update(paymentsTable)
      .set({ isDeleted: true, deletedAt, deletedBy })
      .where(and(eq(paymentsTable.id, id), notDeleted(paymentsTable)))
      .returning();
    if (!p) return { payment: undefined, deletedFees: [] as (typeof feesTable.$inferSelect)[] };
    const fees = await tx
      .update(feesTable)
      .set({ isDeleted: true, deletedAt, deletedBy })
      .where(and(eq(feesTable.paymentId, p.id), notDeleted(feesTable)))
      .returning();
    return { payment: p, deletedFees: fees };
  });
  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  await audit(req.user!.id, "delete_payment", "payment", payment.id, `Check ${payment.qbCheckNumber} — $${payment.amount}`);
  for (const fee of deletedFees) {
    await audit(req.user!.id, "delete_fee", "fee", fee.id, `Cascade soft-delete with payment ${payment.qbCheckNumber} — $${fee.amount}`);
  }
  res.json({ ok: true });
});

// --- Remittances ---

async function enrichRemittances(rows: (typeof remittancesTable.$inferSelect)[]) {
  const [clientNames, authNums] = await Promise.all([
    clientNameMap(rows.map((r) => r.clientId)),
    authNumberMap(rows.map((r) => r.authorizationId)),
  ]);
  return rows.map((r) =>
    remittanceJson(r, {
      clientName: clientNames.get(r.clientId),
      authNumber: r.authorizationId ? authNums.get(r.authorizationId) : null,
    }),
  );
}

router.get("/remittances", requireAuth, async (req, res): Promise<void> => {
  const query = ListRemittancesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  let rows = await db
    .select()
    .from(remittancesTable)
    .where(notDeleted(remittancesTable))
    .orderBy(desc(remittancesTable.remittanceDate));
  const u = req.user!;
  if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    rows = rows.filter((r) => r.clientId === u.linkedRecordId);
  } else if (u.role === "vendor") {
    rows = [];
  }
  if (query.data.clientId) rows = rows.filter((r) => r.clientId === query.data.clientId);
  if (query.data.status) rows = rows.filter((r) => r.status === query.data.status);
  res.json(ListRemittancesResponse.parse(await enrichRemittances(rows)));
});

router.post("/remittances", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateRemittanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Auto-match: unremitted payment for the same client with the same amount (and month when provided)
  const candidates = await db
    .select()
    .from(paymentsTable)
    .where(and(eq(paymentsTable.clientId, parsed.data.clientId), eq(paymentsTable.remitted, false), notDeleted(paymentsTable)));
  const match = candidates.find(
    (p) =>
      Number(p.amount) === Number(parsed.data.amount) &&
      (!parsed.data.paymentMonth || p.paymentMonth === parsed.data.paymentMonth),
  );
  const [remittance] = await db
    .insert(remittancesTable)
    .values({
      ...parsed.data,
      status: match ? "matched" : "received",
      matchedPaymentId: match?.id ?? null,
      autoMatched: !!match,
    })
    .returning();
  if (match) {
    await db.update(paymentsTable).set({ remitted: true }).where(eq(paymentsTable.id, match.id));
  }
  await audit(req.user!.id, "create_remittance", "remittance", remittance.id, match ? `Auto-matched to check ${match.qbCheckNumber}` : "No automatic match — flagged for review");
  res.status(201).json(CreateRemittanceResponse.parse((await enrichRemittances([remittance]))[0]));
});

router.post("/remittances/:id/match", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = MatchRemittanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [payment] = await db.select().from(paymentsTable).where(and(eq(paymentsTable.id, parsed.data.paymentId), notDeleted(paymentsTable)));
  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  const [remittance] = await db
    .update(remittancesTable)
    .set({ status: "matched", matchedPaymentId: payment.id, autoMatched: false })
    .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable)))
    .returning();
  if (!remittance) {
    res.status(404).json({ error: "Remittance not found" });
    return;
  }
  await db.update(paymentsTable).set({ remitted: true }).where(eq(paymentsTable.id, payment.id));
  await audit(req.user!.id, "match_remittance", "remittance", remittance.id, `Matched to check ${payment.qbCheckNumber}`);
  res.json(MatchRemittanceResponse.parse((await enrichRemittances([remittance]))[0]));
});

router.patch("/remittances/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateRemittanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updates = { ...parsed.data } as Record<string, unknown>;
  for (const k of ["authorizationId", "altaReference", "paymentMonth", "remittanceBatchId"] as const) {
    if (updates[k] === "") updates[k] = null;
  }
  const [before] = await db
    .select()
    .from(remittancesTable)
    .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable)));
  if (!before) {
    res.status(404).json({ error: "Remittance not found" });
    return;
  }
  const [remittance] = await db
    .update(remittancesTable)
    .set(updates)
    .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable)))
    .returning();
  await audit(
    req.user!.id,
    "update_remittance",
    "remittance",
    remittance.id,
    diffDetail(before, updates, Object.keys(updates)),
  );
  res.json(UpdateRemittanceResponse.parse((await enrichRemittances([remittance]))[0]));
});

router.delete("/remittances/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [remittance] = await db
    .update(remittancesTable)
    .set({ isDeleted: true, deletedAt: new Date(), deletedBy: req.user!.id })
    .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable)))
    .returning();
  if (!remittance) {
    res.status(404).json({ error: "Remittance not found" });
    return;
  }
  await audit(req.user!.id, "delete_remittance", "remittance", remittance.id, `$${remittance.amount}`);
  res.json({ ok: true });
});

export default router;
