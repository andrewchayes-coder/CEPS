import { Router, type IRouter } from "express";
import { eq, and, desc, sql, count, type SQL } from "drizzle-orm";
import { db, invoicesTable, authorizationsTable, paymentsTable } from "@workspace/db";
import { money } from "../lib/money";
import {
  ListInvoicesQueryParams,
  ListInvoicesResponse,
  CreateInvoiceBody,
  CreateInvoiceResponse,
  GetInvoiceResponse,
  UpdateInvoiceBody,
  UpdateInvoiceResponse,
  ValidateInvoiceBody,
  ValidateInvoiceResponse,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, audit } from "../lib/auth";
import { invoiceJson, clientNameMap, vendorNameMap, authNumberMap, userNameMap, notDeleted, diffDetail } from "../lib/serializers";
import { checkDuplicatePayment } from "../lib/paymentDuplicateCheck";

const router: IRouter = Router();

async function enrich(invoices: (typeof invoicesTable.$inferSelect)[]) {
  const [clientNames, vendorNames, authNums, reviewerNames] = await Promise.all([
    clientNameMap(invoices.map((i) => i.clientId)),
    vendorNameMap(invoices.map((i) => i.vendorId)),
    authNumberMap(invoices.map((i) => i.authorizationId)),
    userNameMap(invoices.map((i) => i.reviewedBy)),
  ]);
  return invoices.map((i) =>
    invoiceJson(i, {
      clientName: clientNames.get(i.clientId),
      vendorName: i.vendorId ? vendorNames.get(i.vendorId) : null,
      authNumber: i.authorizationId ? authNums.get(i.authorizationId) : null,
      reviewedByName: i.reviewedBy ? reviewerNames.get(i.reviewedBy) : null,
    }),
  );
}

router.get("/invoices", requireAuth, async (req, res): Promise<void> => {
  const query = ListInvoicesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conditions: SQL[] = [notDeleted(invoicesTable)];
  // Role scoping — mirrors the payments/audit-log SQL-WHERE pattern:
  // vendors see only their own invoices; parent/self only their linked client's.
  const u = req.user!;
  if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    conditions.push(eq(invoicesTable.vendorId, u.linkedRecordId ?? ""));
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    conditions.push(eq(invoicesTable.clientId, u.linkedRecordId ?? ""));
  }
  // Query-string filters
  if (query.data.status) conditions.push(eq(invoicesTable.status, query.data.status));
  if (query.data.clientId) conditions.push(eq(invoicesTable.clientId, query.data.clientId));
  if (query.data.vendorId) conditions.push(eq(invoicesTable.vendorId, query.data.vendorId));
  const where = and(...conditions);
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const [[{ total }], invoices] = await Promise.all([
    db.select({ total: count() }).from(invoicesTable).where(where),
    db
      .select()
      .from(invoicesTable)
      .where(where)
      .orderBy(desc(invoicesTable.createdAt), desc(invoicesTable.id))
      .limit(limit)
      .offset(offset),
  ]);
  res.json(ListInvoicesResponse.parse({ items: await enrich(invoices), total }));
});

router.post("/invoices", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const u = req.user!;
  const submittedByRole = u.role === "vendor" ? "vendor" : u.role === "parent_guardian" || u.role === "self" ? "parent" : "staff";
  // Non-staff may only submit for their own linked records
  if (submittedByRole === "parent" && parsed.data.clientId !== u.linkedRecordId) {
    res.status(403).json({ error: "You can only submit invoices for your own client record" });
    return;
  }
  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      ...parsed.data,
      vendorId: submittedByRole === "vendor" ? u.linkedRecordId : parsed.data.vendorId,
      submittedByRole,
      submittedDate: new Date().toISOString().slice(0, 10),
    })
    .returning();
  await audit(u.id, "create_invoice", "invoice", invoice.id, `${invoice.serviceMonth} — $${invoice.amountRequested}`);
  res.status(201).json(CreateInvoiceResponse.parse((await enrich([invoice]))[0]));
});

router.get("/invoices/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, id), notDeleted(invoicesTable)));
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const u = req.user!;
  if (u.role === "vendor" && invoice.vendorId !== u.linkedRecordId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if ((u.role === "parent_guardian" || u.role === "self") && invoice.clientId !== u.linkedRecordId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(GetInvoiceResponse.parse((await enrich([invoice]))[0]));
});

router.patch("/invoices/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [before] = await db
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, id), notDeleted(invoicesTable)));
  if (!before) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const updates: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.status === "approved" || parsed.data.status === "rejected") {
    updates.reviewedBy = req.user!.id;
    updates.reviewedAt = new Date();
  }
  // A material edit (amount, service month, or authorization) invalidates any
  // prior validation result, so reset the status to pending_review to avoid a
  // stale "validated"/"duplicate" badge — unless the request explicitly sets a
  // status of its own (in which case honor the caller's intent).
  const materialFields = ["amountRequested", "serviceMonth", "authorizationId"] as const;
  const materiallyChanged = materialFields.some(
    (f) => f in parsed.data && String((before as Record<string, unknown>)[f] ?? null) !== String((parsed.data as Record<string, unknown>)[f] ?? null),
  );
  // Treat a status equal to the current one as "not explicitly changed" — the
  // edit dialog always echoes back the current status.
  if (materiallyChanged && (parsed.data.status === undefined || parsed.data.status === before.status)) {
    updates.status = "pending_review";
  }
  const [invoice] = await db
    .update(invoicesTable)
    .set(updates)
    .where(and(eq(invoicesTable.id, id), notDeleted(invoicesTable)))
    .returning();
  await audit(
    req.user!.id,
    "update_invoice",
    "invoice",
    invoice.id,
    diffDetail(before, updates, Object.keys(updates)),
  );
  res.json(UpdateInvoiceResponse.parse((await enrich([invoice]))[0]));
});

router.post("/invoices/:id/validate", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = ValidateInvoiceBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, id), notDeleted(invoicesTable)));
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  const checks: { check: string; passed: boolean; message: string }[] = [];
  const auth = invoice.authorizationId
    ? (await db.select().from(authorizationsTable).where(and(eq(authorizationsTable.id, invoice.authorizationId), notDeleted(authorizationsTable))))[0]
    : undefined;

  // 1. Authorization active and not expired
  const today = new Date().toISOString().slice(0, 10);
  if (!auth) {
    checks.push({ check: "authorization_active", passed: false, message: "No authorization is linked to this invoice." });
  } else if (auth.status === "pending") {
    checks.push({ check: "authorization_active", passed: false, message: `Authorization ${auth.authNumber} is still pending.` });
  } else if (auth.servicePeriodEnd < today) {
    checks.push({ check: "authorization_active", passed: false, message: `Authorization ${auth.authNumber} expired on ${auth.servicePeriodEnd}.` });
  } else {
    checks.push({ check: "authorization_active", passed: true, message: `Authorization ${auth.authNumber} is active through ${auth.servicePeriodEnd}.` });
  }

  // 2. Service month within authorization period
  if (auth) {
    const inPeriod =
      invoice.serviceMonth >= auth.servicePeriodStart.slice(0, 7) && invoice.serviceMonth <= auth.servicePeriodEnd.slice(0, 7);
    checks.push({
      check: "service_month_in_period",
      passed: inPeriod,
      message: inPeriod
        ? `Service month ${invoice.serviceMonth} falls within the authorization period.`
        : `Service month ${invoice.serviceMonth} is outside the authorization period (${auth.servicePeriodStart} to ${auth.servicePeriodEnd}).`,
    });
  } else {
    checks.push({ check: "service_month_in_period", passed: false, message: "Cannot verify the service month without a linked authorization." });
  }

  // 3. Amount matches the authorized amount
  if (auth) {
    const expected = auth.monthlyAmount ?? auth.oneTimeAmount;
    if (expected == null) {
      checks.push({ check: "amount_matches", passed: true, message: "No fixed authorized amount to compare; verify manually." });
    } else {
      const matches = money(invoice.amountRequested).lessThanOrEqualTo(money(expected));
      checks.push({
        check: "amount_matches",
        passed: matches,
        message: matches
          ? `Requested $${invoice.amountRequested} is within the authorized $${expected}.`
          : `Requested $${invoice.amountRequested} exceeds the authorized $${expected}.`,
      });
    }
  } else {
    checks.push({ check: "amount_matches", passed: false, message: "Cannot verify the amount without a linked authorization." });
  }

  // 4. No duplicate payment for client + authorization + month (HARD STOP)
  let duplicatePassed = true;
  if (invoice.authorizationId) {
    const { isDuplicate } = await checkDuplicatePayment(db, {
      clientId: invoice.clientId,
      authorizationId: invoice.authorizationId,
      paymentMonth: invoice.serviceMonth,
    });
    if (isDuplicate) {
      if (parsed.data.overrideDuplicate && parsed.data.overrideJustification?.trim()) {
        checks.push({
          check: "no_duplicate_payment",
          passed: true,
          message: `Duplicate override applied with justification: "${parsed.data.overrideJustification.trim()}"`,
        });
        await audit(req.user!.id, "override_duplicate_invoice", "invoice", invoice.id, parsed.data.overrideJustification.trim());
      } else {
        duplicatePassed = false;
        checks.push({
          check: "no_duplicate_payment",
          passed: false,
          message: `A payment already exists for this client, authorization, and month (${invoice.serviceMonth}). This is a hard stop — override requires a written justification.`,
        });
      }
    } else {
      checks.push({ check: "no_duplicate_payment", passed: true, message: "No duplicate payment found for this client, authorization, and month." });
    }
  } else {
    checks.push({ check: "no_duplicate_payment", passed: true, message: "No authorization linked; duplicate check skipped." });
  }

  // 5. Cumulative payments + this invoice within max period amount
  if (auth) {
    // Sum in SQL — Postgres numeric addition is exact and avoids fetching an
    // unbounded number of payment rows just to total them in JS. COALESCE keeps
    // the result "0" (never null) when there are no payments yet.
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${paymentsTable.amount}), 0)` })
      .from(paymentsTable)
      .where(and(eq(paymentsTable.authorizationId, auth.id), notDeleted(paymentsTable)));
    const totalPaid = money(row?.total);
    const wouldBe = totalPaid.plus(money(invoice.amountRequested));
    const within = wouldBe.lessThanOrEqualTo(money(auth.maxPeriodAmount));
    checks.push({
      check: "within_max_period_amount",
      passed: within,
      message: within
        ? `Cumulative $${wouldBe.toFixed(2)} stays within the period maximum of $${auth.maxPeriodAmount}.`
        : `Paying this invoice would bring cumulative payments to $${wouldBe.toFixed(2)}, exceeding the period maximum of $${auth.maxPeriodAmount}.`,
    });
  } else {
    checks.push({ check: "within_max_period_amount", passed: false, message: "Cannot verify the period maximum without a linked authorization." });
  }

  const valid = checks.every((c) => c.passed);
  const status = valid ? "validated" : duplicatePassed ? "pending_review" : "duplicate";
  await db.update(invoicesTable).set({ status }).where(eq(invoicesTable.id, invoice.id));
  await audit(req.user!.id, "validate_invoice", "invoice", invoice.id, `Result: ${status}`);
  res.json(ValidateInvoiceResponse.parse({ valid, status, checks }));
});

router.delete("/invoices/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [invoice] = await db
    .update(invoicesTable)
    .set({ isDeleted: true, deletedAt: new Date(), deletedBy: req.user!.id })
    .where(and(eq(invoicesTable.id, id), notDeleted(invoicesTable)))
    .returning();
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  await audit(req.user!.id, "delete_invoice", "invoice", invoice.id, `${invoice.serviceMonth} — $${invoice.amountRequested}`);
  res.json({ ok: true });
});

export default router;
