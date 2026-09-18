import { Router, type IRouter } from "express";
import { eq, and, desc, sql, count, ilike, or, gte, lte, inArray, type SQL } from "drizzle-orm";
import { db, invoicesTable, invoiceLineItemsTable, authorizationsTable, paymentsTable, paymentAllocationsTable, vendorsTable } from "@workspace/db";
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
import { sortedOrder } from "../lib/sorting";
import { softDeleteInvoice, validateParticipantLinks } from "../lib/participantLinks";

const router: IRouter = Router();

async function enrich(invoices: (typeof invoicesTable.$inferSelect)[]) {
  const [clientNames, vendorNames, authNums, reviewerNames, lineItems] = await Promise.all([
    clientNameMap(invoices.map((i) => i.clientId)),
    vendorNameMap(invoices.map((i) => i.vendorId)),
    authNumberMap(invoices.map((i) => i.authorizationId)),
    userNameMap(invoices.map((i) => i.reviewedBy)),
    invoices.length ? db.select().from(invoiceLineItemsTable).where(inArray(invoiceLineItemsTable.invoiceId, invoices.map((i) => i.id))) : Promise.resolve([]),
  ]);
  const itemAuths = await authNumberMap(lineItems.map((item) => item.authorizationId));
  const itemsByInvoice = new Map<string, typeof lineItems>();
  for (const item of lineItems) itemsByInvoice.set(item.invoiceId, [...(itemsByInvoice.get(item.invoiceId) ?? []), item]);
  return invoices.map((i) =>
    invoiceJson(i, {
      clientName: clientNames.get(i.clientId),
      vendorName: i.vendorId ? vendorNames.get(i.vendorId) : null,
      authNumber: i.authorizationId ? authNums.get(i.authorizationId) : null,
      reviewedByName: i.reviewedBy ? reviewerNames.get(i.reviewedBy) : null,
      lineItems: (itemsByInvoice.get(i.id) ?? []).map((item) => ({
        id: item.id,
        authorizationId: item.authorizationId,
        authNumber: itemAuths.get(item.authorizationId) ?? null,
        serviceMonth: item.serviceMonth,
        amount: item.amount,
      })),
    }),
  );
}

router.get("/invoices", requireAuth, async (req, res): Promise<void> => {
  const query = ListInvoicesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.startDate && query.data.endDate && query.data.startDate > query.data.endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const conditions: SQL[] = [notDeleted(invoicesTable)];
  // Role scoping — mirrors the payments/audit-log SQL-WHERE pattern:
  // vendors see only their own invoices; parent/self only their linked client's;
  // service coordinators only invoices for clients in their caseload
  // (clients.assignedCoordinatorId = their user id).
  const u = req.user!;
  if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    conditions.push(eq(invoicesTable.vendorId, u.linkedRecordId ?? ""));
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    conditions.push(eq(invoicesTable.clientId, u.linkedRecordId ?? ""));
  } else if (u.role === "service_coordinator") {
    conditions.push(
      sql`${invoicesTable.clientId} in (select id from clients where assigned_coordinator_id = ${u.id} and is_deleted = false)`,
    );
  }
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  // Query-string filters
  if (query.data.status) conditions.push(eq(invoicesTable.status, query.data.status));
  if (query.data.clientId) conditions.push(eq(invoicesTable.clientId, query.data.clientId));
  if (query.data.vendorId) conditions.push(eq(invoicesTable.vendorId, query.data.vendorId));
  if (query.data.startDate || query.data.endDate) {
    conditions.push(sql`exists (select 1 from invoice_line_items ili_filter where ili_filter.invoice_id = ${invoicesTable.id}
      ${query.data.startDate ? sql`and ili_filter.service_month >= ${query.data.startDate.slice(0, 7)}` : sql``}
      ${query.data.endDate ? sql`and ili_filter.service_month <= ${query.data.endDate.slice(0, 7)}` : sql``})`);
  }
  if (query.data.search) {
    const like = `%${escapeLike(query.data.search)}%`;
    conditions.push(
      or(
        ilike(sql`replace(${invoicesTable.submittedByRole}, '_', ' ')`, like),
        ilike(sql`${invoicesTable.submittedDate}::text`, like),
        ilike(sql`to_char(${invoicesTable.submittedDate}, 'MM/DD/YYYY')`, like),
        ilike(sql`to_char(${invoicesTable.submittedDate}, 'MM/DD/YY')`, like),
        sql`exists (select 1 from invoice_line_items ili_search where ili_search.invoice_id = ${invoicesTable.id} and (ili_search.service_month ilike ${like} or to_char(to_date(ili_search.service_month || '-01', 'YYYY-MM-DD'), 'Mon YYYY') ilike ${like}))`,
        ilike(sql`${invoicesTable.amountRequested}::text`, like),
        ilike(sql`to_char(${invoicesTable.amountRequested}, 'FM$999,999,999,990.00')`, like),
        ilike(sql`replace(${invoicesTable.paymentType}, '_', ' ')`, like),
        ilike(sql`replace(${invoicesTable.status}, '_', ' ')`, like),
        ilike(sql`coalesce(${invoicesTable.notes}, '')`, like),
        sql`${invoicesTable.clientId} in (select id from clients where (first_name || ' ' || last_name) ilike ${like} and is_deleted = false)`,
        sql`${invoicesTable.clientId} in (select id from clients where uci_number ilike ${like} and is_deleted = false)`,
        sql`${invoicesTable.vendorId} in (select id from vendors where name ilike ${like})`,
        sql`${invoicesTable.vendorId} in (select id from vendors where coalesce(alta_vendor_number, '') ilike ${like} or coalesce(contact_person, '') ilike ${like} or coalesce(email, '') ilike ${like})`,
         sql`exists (select 1 from invoice_line_items ili_auth inner join authorizations a_auth on a_auth.id = ili_auth.authorization_id where ili_auth.invoice_id = ${invoicesTable.id} and a_auth.auth_number ilike ${like})`,
         sql`exists (select 1 from invoice_line_items ili_auth inner join authorizations a_auth on a_auth.id = ili_auth.authorization_id where ili_auth.invoice_id = ${invoicesTable.id} and (a_auth.service_code ilike ${like} or coalesce(a_auth.activity_description, '') ilike ${like}))`,
        sql`${invoicesTable.reviewedBy} in (select id from users where name ilike ${like})`,
      )!,
    );
  }
  const where = and(...conditions);
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const order = sortedOrder(
    query.data.sortBy,
    query.data.sortDirection,
    {
      serviceMonth: sql`(select min(ili_sort.service_month) from invoice_line_items ili_sort where ili_sort.invoice_id = ${invoicesTable.id})`,
      vendorName: sql`lower((select name from vendors where id = ${invoicesTable.vendorId}))`,
      clientName: sql`lower((select last_name || ', ' || first_name from clients where id = ${invoicesTable.clientId}))`,
      authNumber: sql`lower((select min(a_sort.auth_number) from invoice_line_items ili_sort inner join authorizations a_sort on a_sort.id = ili_sort.authorization_id where ili_sort.invoice_id = ${invoicesTable.id}))`,
      amountRequested: sql`${invoicesTable.amountRequested}`,
      status: sql`lower(${invoicesTable.status})`,
      submittedDate: sql`${invoicesTable.submittedDate}`,
      createdAt: sql`${invoicesTable.createdAt}`,
    },
    sql`${invoicesTable.id}`,
    [desc(invoicesTable.createdAt), desc(invoicesTable.id)],
  );
  const [[{ total }], invoices] = await Promise.all([
    db.select({ total: count() }).from(invoicesTable).where(where),
    db
      .select()
      .from(invoicesTable)
      .where(where)
      .orderBy(...order)
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
  const total = parsed.data.lineItems.reduce((sum, item) => sum.plus(money(item.amount)), money(0)).toFixed(2);
  const lineKeys = parsed.data.lineItems.map((item) => `${item.authorizationId}:${item.serviceMonth}`);
  if (new Set(lineKeys).size !== lineKeys.length) {
    res.status(400).json({ error: "Duplicate invoice line authorization and service month" });
    return;
  }
  if (parsed.data.amountRequested !== undefined && !money(parsed.data.amountRequested).equals(money(total))) {
    res.status(400).json({ error: "amountRequested must equal the sum of line item amounts" });
    return;
  }
  const values = {
    clientId: parsed.data.clientId,
    amountRequested: total,
    paymentType: parsed.data.paymentType,
    documentUrl: parsed.data.documentUrl,
    notes: parsed.data.notes,
    // Deprecated relationship columns are intentionally left null.
    authorizationId: null,
    vendorId: (submittedByRole === "vendor" ? u.linkedRecordId : parsed.data.vendorId) || null,
    submittedByRole,
    submittedDate: new Date().toISOString().slice(0, 10),
  };
  let relationshipError: string | undefined;
  const invoice = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    for (const item of parsed.data.lineItems) {
      relationshipError = (await validateParticipantLinks(txDb, values.clientId, {
        authorizationId: item.authorizationId,
        vendorId: values.vendorId,
      })).error;
      if (relationshipError) return null;
    }
    relationshipError = (await validateParticipantLinks(txDb, values.clientId, {
      authorizationId: null,
      vendorId: values.vendorId,
    })).error;
    if (relationshipError) return null;
    const [created] = await tx.insert(invoicesTable).values(values as any).returning();
    await tx.insert(invoiceLineItemsTable).values(parsed.data.lineItems.map((item) => ({
      invoiceId: created.id,
      authorizationId: item.authorizationId,
      serviceMonth: item.serviceMonth,
      amount: item.amount,
    })));
    return created;
  });
  if (!invoice) {
    res.status(400).json({ error: relationshipError! });
    return;
  }
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
  const { lineItems, ...invoicePatch } = parsed.data;
  if (parsed.data.amountRequested !== undefined && !lineItems &&
      !money(parsed.data.amountRequested).equals(money(before.amountRequested))) {
    res.status(400).json({ error: "lineItems are required when changing amountRequested" });
    return;
  }
  const updates: Record<string, unknown> = { ...invoicePatch };
  if (lineItems) {
    const lineKeys = lineItems.map((item) => `${item.authorizationId}:${item.serviceMonth}`);
    if (new Set(lineKeys).size !== lineKeys.length) {
      res.status(400).json({ error: "Duplicate invoice line authorization and service month" });
      return;
    }
    const total = lineItems.reduce((sum, item) => sum.plus(money(item.amount)), money(0)).toFixed(2);
    if (parsed.data.amountRequested !== undefined && !money(parsed.data.amountRequested).equals(money(total))) {
      res.status(400).json({ error: "amountRequested must equal the sum of line item amounts" });
      return;
    }
    updates.amountRequested = total;
    updates.authorizationId = null;
    updates.serviceMonth = null;
  }
  if (parsed.data.status === "approved" || parsed.data.status === "rejected") {
    updates.reviewedBy = req.user!.id;
    updates.reviewedAt = new Date();
  }
  // A material edit (amount, service month, or authorization) invalidates any
  // prior validation result, so reset the status to pending_review to avoid a
  // stale "validated"/"duplicate" badge — unless the request explicitly sets a
  // status of its own (in which case honor the caller's intent).
  const materialFields = ["amountRequested", "serviceMonth", "authorizationId"] as const;
  const materiallyChanged = !!lineItems || materialFields.some(
    (f) => f in parsed.data && String((before as Record<string, unknown>)[f] ?? null) !== String((parsed.data as Record<string, unknown>)[f] ?? null),
  );
  // Treat a status equal to the current one as "not explicitly changed" — the
  // edit dialog always echoes back the current status.
  if (materiallyChanged && (parsed.data.status === undefined || parsed.data.status === before.status)) {
    updates.status = "pending_review";
  }
  const effectiveAuthorizationId = ("authorizationId" in updates ? updates.authorizationId : before.authorizationId) as string | null;
  const effectiveVendorId = ("vendorId" in updates ? updates.vendorId : before.vendorId) as string | null;
  let relationshipError: string | undefined;
  const invoice = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    await tx.execute(sql`select id from invoices where id = ${id} for update`);
    relationshipError = (await validateParticipantLinks(txDb, before.clientId, {
      authorizationId: effectiveAuthorizationId,
      vendorId: effectiveVendorId,
    })).error;
    if (relationshipError) return null;
    if (lineItems) {
      for (const item of lineItems) {
        relationshipError = (await validateParticipantLinks(txDb, before.clientId, {
          authorizationId: item.authorizationId,
          vendorId: effectiveVendorId,
        })).error;
        if (relationshipError) return null;
      }
    }
    const [updated] = await tx
      .update(invoicesTable)
      .set(updates)
      .where(and(eq(invoicesTable.id, id), notDeleted(invoicesTable)))
      .returning();
    if (lineItems) {
      await tx.delete(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, id));
      await tx.insert(invoiceLineItemsTable).values(lineItems.map((item) => ({
        invoiceId: id,
        authorizationId: item.authorizationId,
        serviceMonth: item.serviceMonth,
        amount: item.amount,
      })));
    }
    return updated;
  });
  if (!invoice) {
    res.status(400).json({ error: relationshipError ?? "Invoice not found" });
    return;
  }
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
  const lineItems = await db.select().from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, invoice.id));
  const authorizationIds = [...new Set(lineItems.map((item) => item.authorizationId))];
  const authRows = authorizationIds.length
    ? await db.select().from(authorizationsTable).where(inArray(authorizationsTable.id, authorizationIds))
    : [];
  const authById = new Map(authRows.map((auth) => [auth.id, auth]));

  // 1. Authorization active and not expired
  const today = new Date().toISOString().slice(0, 10);
  if (lineItems.length === 0) {
    checks.push({ check: "authorization_active", passed: false, message: "No authorization is linked to this invoice." });
  } else {
    for (const item of lineItems) {
      const auth = authById.get(item.authorizationId);
      const active = !!auth && !auth.isDeleted && auth.status === "active" && auth.servicePeriodEnd >= today;
      checks.push({ check: "authorization_active", passed: active, message: active
        ? `Authorization ${auth!.authNumber} is active through ${auth!.servicePeriodEnd}.`
        : `Invoice line authorization ${item.authorizationId} is missing, deleted, inactive, or expired.` });
    }
  }

  // 2. Service month within authorization period
  for (const item of lineItems) {
    const auth = authById.get(item.authorizationId);
    const inPeriod = !!auth && item.serviceMonth >= auth.servicePeriodStart.slice(0, 7) && item.serviceMonth <= auth.servicePeriodEnd.slice(0, 7);
    checks.push({ check: "service_month_in_period", passed: inPeriod,
      message: inPeriod ? `Service month ${item.serviceMonth} falls within the authorization period.` : `Service month ${item.serviceMonth} is outside its authorization period.` });
  }
  if (!lineItems.length) {
    checks.push({ check: "service_month_in_period", passed: false, message: "Cannot verify the service month without a linked authorization." });
  }

  // 3. Amount matches the authorized amount
  const amountsByAuth = new Map<string, ReturnType<typeof money>>();
  const amountsByAuthMonth = new Map<string, { authorizationId: string; month: string; amount: ReturnType<typeof money> }>();
  for (const item of lineItems) {
    amountsByAuth.set(item.authorizationId, (amountsByAuth.get(item.authorizationId) ?? money(0)).plus(money(item.amount)));
    const key = `${item.authorizationId}:${item.serviceMonth}`;
    const prior = amountsByAuthMonth.get(key);
    amountsByAuthMonth.set(key, { authorizationId: item.authorizationId, month: item.serviceMonth, amount: (prior?.amount ?? money(0)).plus(money(item.amount)) });
  }
  for (const { authorizationId: authId, month, amount: requested } of amountsByAuthMonth.values()) {
    const auth = authById.get(authId);
    const expected = auth?.monthlyAmount ?? auth?.oneTimeAmount;
    const matches = !!auth && (expected == null || requested.lessThanOrEqualTo(money(expected)));
    checks.push({ check: "amount_matches", passed: matches, message: matches ? `Requested $${requested.toFixed(2)} for ${month} is within its authorization.` : `Requested $${requested.toFixed(2)} for ${month} exceeds its monthly authorization.` });
  }
  if (!lineItems.length) {
    checks.push({ check: "amount_matches", passed: false, message: "Cannot verify the amount without a linked authorization." });
  }

  // 4. No duplicate payment for client + authorization + month (HARD STOP)
  let duplicatePassed = true;
  for (const { authorizationId: authId, month } of amountsByAuthMonth.values()) {
    const { isDuplicate } = await checkDuplicatePayment(db, { clientId: invoice.clientId, authorizationId: authId, paymentMonth: month });
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
          message: `A payment already exists for this client, authorization, and month (${month}). This is a hard stop — override requires a written justification.`,
        });
      }
    } else {
      checks.push({ check: "no_duplicate_payment", passed: true, message: "No duplicate payment found for this client, authorization, and month." });
    }
  }
  if (!lineItems.length) {
    checks.push({ check: "no_duplicate_payment", passed: true, message: "No authorization linked; duplicate check skipped." });
  }

  // 5. Cumulative payments + this invoice within max period amount
  for (const [authId, invoiceForAuth] of amountsByAuth) {
    const auth = authById.get(authId);
    if (!auth) continue;
    // Sum in SQL — Postgres numeric addition is exact and avoids fetching an
    // unbounded number of payment rows just to total them in JS. COALESCE keeps
    // the result "0" (never null) when there are no payments yet.
    const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${paymentAllocationsTable.amount}), 0)` })
        .from(paymentAllocationsTable)
        .innerJoin(paymentsTable, eq(paymentsTable.id, paymentAllocationsTable.paymentId))
        .where(and(eq(paymentAllocationsTable.authorizationId, auth.id), notDeleted(paymentsTable)));
    const totalPaid = money(row?.total);
     const wouldBe = totalPaid.plus(invoiceForAuth);
    const within = wouldBe.lessThanOrEqualTo(money(auth.maxPeriodAmount));
    checks.push({
      check: "within_max_period_amount",
      passed: within,
      message: within
        ? `Cumulative $${wouldBe.toFixed(2)} stays within the period maximum of $${auth.maxPeriodAmount}.`
        : `Paying this invoice would bring cumulative payments to $${wouldBe.toFixed(2)}, exceeding the period maximum of $${auth.maxPeriodAmount}.`,
    });
  }
  if (!lineItems.length) {
    checks.push({ check: "within_max_period_amount", passed: false, message: "Cannot verify the period maximum without a linked authorization." });
  }

  // 6. Vendor is currently active
  const vendor = invoice.vendorId
    ? (await db.select().from(vendorsTable).where(eq(vendorsTable.id, invoice.vendorId)))[0]
    : undefined;
  if (!invoice.vendorId) {
    checks.push({ check: "vendor_active", passed: false, message: "No vendor is linked to this invoice." });
  } else if (!vendor) {
    checks.push({ check: "vendor_active", passed: false, message: "The linked vendor no longer exists." });
  } else if (!vendor.active) {
    checks.push({ check: "vendor_active", passed: false, message: `Vendor ${vendor.name} is deactivated and cannot be paid.` });
  } else {
    checks.push({ check: "vendor_active", passed: true, message: `Vendor ${vendor.name} is active.` });
  }

  const valid = checks.every((c) => c.passed);
  const status = valid ? "validated" : duplicatePassed ? "pending_review" : "duplicate";
  await db.update(invoicesTable).set({ status }).where(eq(invoicesTable.id, invoice.id));
  await audit(req.user!.id, "validate_invoice", "invoice", invoice.id, `Result: ${status}`);
  res.json(ValidateInvoiceResponse.parse({ valid, status, checks }));
});

router.delete("/invoices/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const result = await db.transaction((tx) => softDeleteInvoice(tx as unknown as typeof db, id, req.user!.id));
  if ("notFound" in result) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  if ("conflict" in result) {
    res.status(409).json({ error: result.conflict, blockers: result.blockers });
    return;
  }
  const invoice = result.deleted;
  await audit(req.user!.id, "delete_invoice", "invoice", invoice.id, `${invoice.serviceMonth} — $${invoice.amountRequested}`);
  res.json({ ok: true });
});

export default router;
