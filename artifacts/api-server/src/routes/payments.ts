import { Router, type IRouter } from "express";
import { eq, and, desc, ilike, count, sql, type SQL } from "drizzle-orm";
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
import { checkDuplicatePayment, lockDuplicatePaymentKey } from "../lib/paymentDuplicateCheck";
import { money } from "../lib/money";

const router: IRouter = Router();

// ⚠️ INTERIM PLACEHOLDER — the exact Fee auto-generation trigger/amount rule and
// qualifying service codes are pending confirmation from CEPS (docs/CEPS_OPEN_ITEMS.md #4).
// Until then, every logged payment auto-generates a Fee of 5% of the payment amount,
// status "pending", ruleApplied "interim_flat_percent_5_pending_confirmation".
// This helper is intentionally isolated so the rule can be swapped once CEPS confirms.
const INTERIM_FEE_RULE = "interim_flat_percent_5_pending_confirmation";
// Kept as a string so it feeds Decimal math exactly (no binary-float 0.05).
const INTERIM_FEE_RATE = "0.05";

async function autoGenerateFee(
  payment: typeof paymentsTable.$inferSelect,
  userId: string,
  tx: typeof db = db,
): Promise<void> {
  const feeAmount = money(payment.amount).times(INTERIM_FEE_RATE).toFixed(2);
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
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const conditions: SQL[] = [notDeleted(paymentsTable)];
  // Role scoping — mirrors the audit-log SQL-WHERE pattern:
  // vendors see only their own payments; parent/self only their linked client's.
  const u = req.user!;
  if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    conditions.push(eq(paymentsTable.vendorId, u.linkedRecordId ?? ""));
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    conditions.push(eq(paymentsTable.clientId, u.linkedRecordId ?? ""));
  }
  // Query-string filters
  if (query.data.clientId) conditions.push(eq(paymentsTable.clientId, query.data.clientId));
  if (query.data.vendorId) conditions.push(eq(paymentsTable.vendorId, query.data.vendorId));
  if (query.data.authorizationId) conditions.push(eq(paymentsTable.authorizationId, query.data.authorizationId));
  if (query.data.status) conditions.push(eq(paymentsTable.paymentType, query.data.status));
  if (query.data.search) conditions.push(ilike(paymentsTable.qbCheckNumber, `%${escapeLike(query.data.search)}%`));
  const where = and(...conditions);
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const [[{ total }], payments] = await Promise.all([
    db.select({ total: count() }).from(paymentsTable).where(where),
    db
      .select()
      .from(paymentsTable)
      .where(where)
      .orderBy(desc(paymentsTable.checkDate), desc(paymentsTable.id))
      .limit(limit)
      .offset(offset),
  ]);
  res.json(ListPaymentsResponse.parse({ items: await enrichPayments(payments), total }));
});

router.post("/payments", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreatePaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Pull the override fields out before they reach the insert values — they are
  // control flags, not payment columns.
  const { overrideDuplicate, overrideJustification, ...paymentData } = parsed.data;
  // Normalize empty strings from the form to null for optional/nullable FK columns
  const values = { ...paymentData, source: "manual", loggedBy: req.user!.id } as Record<string, unknown>;
  for (const k of ["authorizationId", "vendorId", "invoiceId", "paymentMonth"] as const) {
    if (values[k] === "") values[k] = null;
  }
  // Derive the service month server-side from checkDate (YYYY-MM) when it's
  // missing but a checkDate is present, so the duplicate check can't be skipped
  // simply by omitting paymentMonth. The derived month is persisted on the row.
  const dupClientId = values.clientId as string;
  const dupAuthorizationId = values.authorizationId as string | null;
  if ((values.paymentMonth == null || values.paymentMonth === "") && typeof values.checkDate === "string" && values.checkDate.length >= 7) {
    values.paymentMonth = values.checkDate.slice(0, 7);
  }
  const dupPaymentMonth = values.paymentMonth as string | null;

  // Duplicate-payment HARD STOP: no two payments for the same client +
  // authorization + service month without a written override justification.
  // The check only applies when both an authorization and a payment month are
  // present (mirrors invoice validation, which skips the check without an auth);
  // payments genuinely without an authorization skip the check by definition.
  const runDupCheck = !!(dupAuthorizationId && dupPaymentMonth);
  const justification = overrideJustification?.trim();

  // Persist the payment and its auto-generated Fee atomically so a payment can
  // never exist without its corresponding fee. The duplicate check runs INSIDE
  // the transaction behind a pg advisory lock so a concurrent insert for the
  // same client + authorization + month can't slip past the SELECT-then-INSERT
  // window (a unique index isn't viable — justified overrides allow duplicates).
  let duplicateBlocked: Awaited<ReturnType<typeof enrichPayments>> | null = null;
  const payment = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    if (runDupCheck) {
      await lockDuplicatePaymentKey(txDb, {
        clientId: dupClientId,
        authorizationId: dupAuthorizationId,
        paymentMonth: dupPaymentMonth!,
      });
      const { isDuplicate, existingPayments } = await checkDuplicatePayment(txDb, {
        clientId: dupClientId,
        authorizationId: dupAuthorizationId,
        paymentMonth: dupPaymentMonth!,
      });
      if (isDuplicate && !(overrideDuplicate && justification)) {
        duplicateBlocked = await enrichPayments(existingPayments);
        return null;
      }
    }
    const [p] = await tx
      .insert(paymentsTable)
      .values(values as typeof paymentsTable.$inferInsert)
      .returning();
    // INTERIM PLACEHOLDER: auto-generate the corresponding Fee record. The real trigger
    // conditions/amount rule are pending CEPS confirmation — see docs/CEPS_OPEN_ITEMS.md #4.
    await autoGenerateFee(p, req.user!.id, txDb);
    // Record any accepted duplicate override in the same transaction, keyed to
    // the NEW payment's id, so the audit trail can never diverge from the row.
    if (runDupCheck && overrideDuplicate && justification) {
      await audit(req.user!.id, "override_duplicate_payment", "payment", p.id, justification, txDb);
    }
    return p;
  });
  if (!payment) {
    res.status(409).json({
      error: `A payment already exists for this client, authorization, and month (${dupPaymentMonth}). This is a hard stop — override requires a written justification.`,
      code: "duplicate_payment",
      existingPayments: duplicateBlocked ?? [],
    });
    return;
  }
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
  const results: { qbCheckNumber: string; outcome: "imported" | "skipped_duplicate" | "flagged_duplicate" | "unmatched"; message?: string | null; paymentId?: string | null }[] = [];
  let imported = 0;
  let skipped = 0;
  let flagged = 0;
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
    const rowPaymentMonth = row.checkDate.slice(0, 7);
    // Duplicate-payment HARD STOP (same rule as manual entry / invoice validation):
    // a row matching an existing payment for this client + authorization + month
    // must NOT be silently imported. Imported rows carry no authorization, so the
    // shared check matches against existing no-authorization payments for the
    // client + month. There is no override path in bulk import — the row is held
    // back and surfaced for manual review.
    const { isDuplicate, existingPayments } = await checkDuplicatePayment(db, {
      clientId: client.id,
      authorizationId: null,
      paymentMonth: rowPaymentMonth,
    });
    if (isDuplicate) {
      flagged++;
      const existing = existingPayments[0];
      const message = `A payment already exists for ${client.firstName} ${client.lastName} in ${rowPaymentMonth} (check ${existing.qbCheckNumber}, $${existing.amount}). Held back — review and log manually with a justification if this is intentional.`;
      results.push({ qbCheckNumber: row.qbCheckNumber, outcome: "flagged_duplicate", message, paymentId: existing.id });
      await audit(req.user!.id, "flag_duplicate_payment", "payment", existing.id, `Import row check ${row.qbCheckNumber} held back — ${message}`);
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
          paymentMonth: rowPaymentMonth,
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
  await audit(req.user!.id, "import_check_register", "payment", undefined, `${imported} imported, ${skipped} skipped, ${flagged} flagged as duplicate, ${unmatched} unmatched`);
  // The response's `skipped` total counts every held-back row (check-number
  // duplicates + client/auth/month duplicates); the per-row `outcome` field
  // distinguishes skipped_duplicate from flagged_duplicate.
  res.json(ImportCheckRegisterResponse.parse({ imported, skipped: skipped + flagged, unmatched, results }));
});

router.patch("/payments/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdatePaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Pull the override control flags out before they reach the update set — they
  // are not payment columns.
  const { overrideDuplicate, overrideJustification, ...updateData } = parsed.data;
  const updates = { ...updateData } as Record<string, unknown>;
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
  // Derive the service month server-side when checkDate changes but paymentMonth
  // is not explicitly part of the patch — same rule as POST /payments (a) — so a
  // month change implied by a new checkDate is folded into the duplicate check
  // and persisted on the row.
  const checkDateChanged = "checkDate" in updateData && typeof updates.checkDate === "string";
  const paymentMonthExplicit = "paymentMonth" in updateData;
  if (checkDateChanged && !paymentMonthExplicit && typeof updates.checkDate === "string" && updates.checkDate.length >= 7) {
    updates.paymentMonth = updates.checkDate.slice(0, 7);
  }
  // Resolve the effective duplicate-defining triple after the patch. clientId is
  // immutable via this endpoint, so it always comes from the existing row.
  const effClientId = before.clientId;
  const effAuthorizationId = ("authorizationId" in updates ? updates.authorizationId : before.authorizationId) as string | null;
  const effPaymentMonth = ("paymentMonth" in updates ? updates.paymentMonth : before.paymentMonth) as string | null;
  const dupFieldChanged =
    effAuthorizationId !== before.authorizationId ||
    effPaymentMonth !== before.paymentMonth;
  // Re-run the duplicate hard stop only when the patch changes a
  // duplicate-defining field and the resulting triple has both an authorization
  // and a month (mirrors POST /payments). The payment's own row is excluded.
  const runDupCheck = dupFieldChanged && !!(effAuthorizationId && effPaymentMonth);
  const justification = overrideJustification?.trim();
  // If the amount changed, keep the auto-generated interim fee consistent by
  // recalculating it with the same 5% rule as autoGenerateFee. We only touch
  // fees still on the interim rule and never clobber a waived (manually
  // adjusted) fee. Payment + fee updates run in one transaction.
  const amountChanged =
    "amount" in updateData && String(before.amount) !== String(updates.amount);
  let duplicateBlocked: Awaited<ReturnType<typeof enrichPayments>> | null = null;
  const { payment, recalculatedFees } = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    // Serialize + re-check the duplicate hard stop inside the transaction behind
    // a pg advisory lock so a concurrent write for the same triple can't race
    // past the SELECT-then-UPDATE window.
    if (runDupCheck) {
      await lockDuplicatePaymentKey(txDb, {
        clientId: effClientId,
        authorizationId: effAuthorizationId,
        paymentMonth: effPaymentMonth!,
      });
      const { isDuplicate, existingPayments } = await checkDuplicatePayment(txDb, {
        clientId: effClientId,
        authorizationId: effAuthorizationId,
        paymentMonth: effPaymentMonth!,
        excludePaymentId: id,
      });
      if (isDuplicate && !(overrideDuplicate && justification)) {
        duplicateBlocked = await enrichPayments(existingPayments);
        return { payment: null as typeof paymentsTable.$inferSelect | null, recalculatedFees: [] as { id: string; before: string; after: string }[] };
      }
    }
    const [p] = await tx
      .update(paymentsTable)
      .set(updates)
      .where(and(eq(paymentsTable.id, id), notDeleted(paymentsTable)))
      .returning();
    // Record any accepted duplicate override in the same transaction, keyed to
    // this payment's id, so the audit trail can never diverge from the row.
    if (runDupCheck && overrideDuplicate && justification) {
      await audit(req.user!.id, "override_duplicate_payment", "payment", p.id, justification, txDb);
    }
    const recalculated: { id: string; before: string; after: string }[] = [];
    if (amountChanged) {
      const linkedFees = await tx
        .select()
        .from(feesTable)
        .where(and(eq(feesTable.paymentId, p.id), notDeleted(feesTable)));
      const newFeeAmount = money(p.amount).times(INTERIM_FEE_RATE).toFixed(2);
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
  if (!payment) {
    res.status(409).json({
      error: `A payment already exists for this client, authorization, and month (${effPaymentMonth}). This is a hard stop — override requires a written justification.`,
      code: "duplicate_payment",
      existingPayments: duplicateBlocked ?? [],
    });
    return;
  }
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
  const conditions: SQL[] = [notDeleted(remittancesTable)];
  // Role scoping — mirrors the payments/audit-log SQL-WHERE pattern:
  // parent/self see only their linked client's remittances; vendors see none.
  const u = req.user!;
  if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    conditions.push(eq(remittancesTable.clientId, u.linkedRecordId ?? ""));
  } else if (u.role === "vendor") {
    // Vendors have no visibility into remittances — force an empty result set
    // without a JS-level short circuit so pagination/total stay SQL-driven.
    conditions.push(sql`false`);
  }
  // Query-string filters
  if (query.data.clientId) conditions.push(eq(remittancesTable.clientId, query.data.clientId));
  if (query.data.status) conditions.push(eq(remittancesTable.status, query.data.status));
  const where = and(...conditions);
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(remittancesTable).where(where),
    db
      .select()
      .from(remittancesTable)
      .where(where)
      .orderBy(desc(remittancesTable.createdAt), desc(remittancesTable.id))
      .limit(limit)
      .offset(offset),
  ]);
  res.json(ListRemittancesResponse.parse({ items: await enrichRemittances(rows), total }));
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
      money(p.amount).equals(money(parsed.data.amount)) &&
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
