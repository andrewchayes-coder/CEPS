import { Router, type IRouter } from "express";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db, reviewFlagsTable } from "@workspace/db";
import { ImportAltaBillingBody, ImportAltaBillingResponse, ListBillingRowsQueryParams, ListBillingRowsResponse, GetBillingReportQueryParams, GetBillingReportResponse,
  FlagForReviewBody, FlagForReviewResponse, ResolveReviewFlagBody, ResolveReviewFlagResponse } from "@workspace/api-zod";
import { requirePermission, requireStaff, audit } from "../lib/auth";
import { importBilling } from "../lib/altaBillingImport";
import { billingItemsCte, flagJsonSql, withBillingStatus, type BillingItem } from "../lib/billingStatus";

const router: IRouter = Router();
const asError = (e: unknown) => e instanceof Error ? e.message : "Invalid billing request.";
const reportQuery = GetBillingReportQueryParams;
const validId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const conflict = (e: unknown): boolean => !!e && typeof e === "object" &&
  (("code" in e && e.code === "23505") || ("cause" in e && conflict(e.cause)));

router.post("/billing/import", requirePermission("remittance_entry"), async (req, res): Promise<void> => {
  const body = ImportAltaBillingBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  // Parser errors are business validation, not database failures.
  try {
    const { parseAltaBillingCsv } = await import("../lib/altaBillingParser");
    parseAltaBillingCsv(body.data.csvContent);
  } catch (e) { res.status(400).json({ error: asError(e) }); return; }
  res.json(ImportAltaBillingResponse.parse(await importBilling(body.data.csvContent, body.data.mode, req.user!.id)));
});

router.get("/billing/rows", requirePermission("remittance_entry"), async (req, res): Promise<void> => {
  const query = ListBillingRowsQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  const q = query.data;
  const where = q.matchStatus ? sql`not b.is_deleted and b.match_status = ${q.matchStatus}` : sql`not b.is_deleted`;
  const result = await db.execute(sql`select b.id, b.invoice_number as "invoiceNumber", to_char(b.invoice_date,'YYYY-MM-DD') as "billedAt",
    b.uci_number as "uciNumber", b.auth_number as "authNumber", b.service_month as "serviceMonth", b.service_code as "serviceCode",
    b.billed_amount::text as "billedAmount", b.match_status as "matchStatus", b.review_reason as "reviewReason",
    c.first_name || ' ' || c.last_name as "clientName",
    (case when b.fee_id is not null then 1 else (select count(*)::int from alta_billing_row_lines l where l.billing_row_id = b.id) end) as "targetCount",
    b.service_code not in ('024','459','490') as untracked,
    exists(select 1 from alta_billing_rows older where not older.is_deleted and older.id <> b.id
      and older.created_at < b.created_at and
      ((b.fee_id is not null and older.fee_id = b.fee_id) or exists(
        select 1 from alta_billing_row_lines a join alta_billing_row_lines x on a.payment_allocation_id = x.payment_allocation_id
        where a.billing_row_id = b.id and x.billing_row_id = older.id))) as rebilled
    from alta_billing_rows b left join clients c on c.id = b.client_id where ${where}
    order by b.created_at desc, b.id desc limit ${q.limit} offset ${q.offset}`);
  const total = await db.execute(sql`select count(*)::int as total from alta_billing_rows b where ${where}`);
  res.json(ListBillingRowsResponse.parse({ items: result.rows.map((r, i) => ({ ...r, rowNumber: q.offset + i + 1 })), total: total.rows[0].total }));
});

router.post("/review-flags", requirePermission("remittance_entry"), async (req, res): Promise<void> => {
  const body = FlagForReviewBody.safeParse(req.body);
  if (!body.success || !body.data.reason.trim()) { res.status(400).json({ error: "Choose an item and enter a reason (1–500 characters)." }); return; }
  const b = body.data;
  try {
    const created = await db.transaction(async tx => {
      const target = await tx.execute(sql`${billingItemsCte} select 1 from billing_items where "targetType" = ${b.targetType} and "targetId" = ${b.targetId}`);
      if (!target.rows.length) return null;
      const [flag] = await tx.insert(reviewFlagsTable).values({ targetType: b.targetType,
        paymentAllocationId: b.targetType === "payment_line" ? b.targetId : null,
        feeId: b.targetType === "fee" ? b.targetId : null, reason: b.reason.trim(), flaggedBy: req.user!.id }).returning();
      await audit(req.user!.id, "flag_for_review", b.targetType, b.targetId, b.reason.trim(), tx as unknown as typeof db);
      return flag;
    });
    if (!created) { res.status(404).json({ error: "Item not found." }); return; }
    res.status(201).json(FlagForReviewResponse.parse({ ...created, flaggedAt: created.flaggedAt.toISOString() }));
  } catch (e) {
    if (conflict(e)) { res.status(409).json({ error: "This item already has an open review flag." }); return; }
    throw e;
  }
});

router.post("/review-flags/:id/resolve", requirePermission("remittance_entry"), async (req, res): Promise<void> => {
  const id = req.params.id;
  const body = ResolveReviewFlagBody.safeParse(req.body);
  if (!validId(id) || !body.success || !body.data.note.trim()) { res.status(400).json({ error: "Enter a resolution note (1–500 characters)." }); return; }
  const updated = await db.transaction(async tx => {
    const [flag] = await tx.update(reviewFlagsTable).set({ resolvedAt: new Date(), resolvedBy: req.user!.id, resolutionNote: body.data.note.trim() })
      .where(and(eq(reviewFlagsTable.id, id), isNull(reviewFlagsTable.resolvedAt))).returning();
    if (flag) await audit(req.user!.id, "resolve_review_flag", flag.targetType, flag.paymentAllocationId ?? flag.feeId!,
      body.data.note.trim(), tx as unknown as typeof db);
    return flag;
  });
  if (!updated) { res.status(409).json({ error: "Flag not found or already resolved." }); return; }
  res.json(ResolveReviewFlagResponse.parse({ ...updated, flaggedAt: updated.flaggedAt.toISOString(), resolvedAt: updated.resolvedAt!.toISOString() }));
});

function reportSql(q: ReturnType<typeof reportQuery.parse>) {
  const conditions: SQL[] = [];
  if (q.clientId) conditions.push(sql`t."clientId" = ${q.clientId}`);
  const date = q.report === "flagged" ? sql`(f.flagged_at at time zone 'America/Los_Angeles')::date` : sql`t."billedAt"::date`;
  if (q.startDate) conditions.push(sql`${date} >= ${q.startDate}::date`);
  if (q.endDate) conditions.push(sql`${date} <= ${q.endDate}::date`);
  if (q.report === "flagged") {
    if (q.status !== "all") conditions.push(q.status === "open" ? sql`f.resolved_at is null` : sql`f.resolved_at is not null`);
  } else {
    conditions.push(sql`t."billedAt" is not null and t."remittedAmount"::numeric < t.amount::numeric and coalesce(t."feeStatus",'') <> 'waived'`);
    conditions.push(sql`not (coalesce(t."feeStatus",'') = 'collected' and t."remittedAmount"::numeric = 0)`);
    if (q.olderThanDays) conditions.push(sql`t."daysSinceBilled" >= ${q.olderThanDays}`);
  }
  return sql`select t."targetType", t."targetId", t."clientId", t."clientName", t.item, t."serviceMonth",
    t.amount, t."feeStatus", t."remittedAmount", t."billedAt", t."billedAmount", t."invoiceNumber", t."billingCount", t."daysSinceBilled",
    ${q.report === "flagged" ? flagJsonSql("f") : sql`t.flag`} as flag
    from billing_items t ${q.report === "flagged" ? sql`join review_flags f on f.target_type = t."targetType"
      and coalesce(f.fee_id,f.payment_allocation_id) = t."targetId"` : sql``}
    where ${conditions.length ? sql.join(conditions, sql` and `) : sql`true`}`;
}

router.get(["/reports/billing", "/reports/billing/export"], requireStaff, async (req, res): Promise<void> => {
  // Numeric literal unions emitted by Orval do not coerce URL strings.
  const query = reportQuery.safeParse({ ...req.query,
    ...(typeof req.query.olderThanDays === "string" && /^(0|30|60|90)$/.test(req.query.olderThanDays)
      ? { olderThanDays: Number(req.query.olderThanDays) } : {}) });
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  const q = query.data;
  const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if ((q.clientId && !validId(q.clientId)) || (q.startDate && !validDate(q.startDate)) || (q.endDate && !validDate(q.endDate))) {
    res.status(400).json({ error: "Invalid participant or date filter." }); return;
  }
  if (q.startDate && q.endDate && q.startDate > q.endDate) { res.status(400).json({ error: "Start date must not follow end date." }); return; }
  const csv = req.path.endsWith("/export");
  const base = reportSql(q);
  const ordering = q.report === "flagged" ? sql`order by (flag->>'flaggedAt') desc, "targetId", (flag->>'id')` : sql`order by "daysSinceBilled" desc, "targetId"`;
  const result = await db.execute(sql`${billingItemsCte} select * from (${base}) report ${ordering} ${csv ? sql`` : sql`limit ${q.limit} offset ${q.offset}`}`);
  const items = (result.rows as unknown as Omit<BillingItem, "billingStatus">[]).map(withBillingStatus);
  if (!csv) {
    const total = await db.execute(sql`${billingItemsCte} select count(*)::int as total from (${base}) report`);
    res.json(GetBillingReportResponse.parse({ items, total: total.rows[0].total })); return;
  }
  const calendar = (s: string | null) => s?.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1") ?? "";
  const month = (s: string | null) => s?.replace(/^(\d{4})-(\d{2})$/, "$2/$1") ?? "";
  const stamp = (s?: string | null) => s ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(s)) : "";
  const cell = (value: unknown) => { const v = String(value ?? ""); return `"${(/^[=+\-@\t\r]/.test(v) ? "'" + v : v).replaceAll('"', '""')}"`; };
  const header = ["Participant", "Item", "Service month", "Amount", "Billed date", "Billed amount", "Invoice #", "Remitted", "Status", "Days since billed",
    "Reason", "Flagged by", "Flagged at", "Resolved at", "Resolution note"];
  const values = items.map(r => [r.clientName, r.item, month(r.serviceMonth), r.amount, calendar(r.billedAt), r.billedAmount,
    r.invoiceNumber, r.remittedAmount, ({ pending: "Pending", billed: "Billed", partially_paid: "Partially paid", paid: "Paid", waived: "Waived" })[r.billingStatus],
    r.daysSinceBilled, r.flag?.reason, r.flag?.flaggedByName, stamp(r.flag?.flaggedAt), stamp(r.flag?.resolvedAt), r.flag?.resolutionNote]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${q.report === "flagged" ? "flagged-for-review" : "billed-not-paid"}.csv"`);
  res.send("\uFEFF" + [header, ...values].map(r => r.map(cell).join(",")).join("\r\n"));
});

export default router;
