import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { eq, and, desc, ilike, or, count, sql, inArray, gte, lte, isNull, type SQL } from "drizzle-orm";
import { db, paymentsTable, paymentAllocationsTable, clientsTable, remittancesTable, remittanceAllocationsTable, feesTable, authorizationsTable, invoicesTable, invoiceLineItemsTable, vendorsTable } from "@workspace/db";
import {
  ListPaymentsQueryParams,
  ListPaymentsResponse,
  CreatePaymentBody,
  CreatePaymentResponse,
  GetPaymentResponse,
  ImportAltaFmsPaymentsBody,
  ImportAltaFmsPaymentsResponse,
  UpdatePaymentBody,
  UpdatePaymentResponse,
  ListRemittancesQueryParams,
  ListRemittancesResponse,
  CreateRemittanceBody,
  CreateRemittanceResponse,
  GetRemittanceResponse,
  UpdateRemittanceBody,
  UpdateRemittanceResponse,
  MatchRemittanceResponse,
  ImportAltaRemittancesBody,
  ImportAltaRemittancesResponse,
  AuditMonthlyFeesResponse,
  RepairMonthlyFeesBody,
  RepairMonthlyFeesResponse,
  ReconcileCheckRunBody,
  ReconcileCheckRunResponse,
  AuditAltaFmsPaymentsBody,
  AuditAltaFmsPaymentsResponse,
  type AltaFmsPaymentAuditRow,
  type AltaFmsPaymentAuditRowResult,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, requirePermission, audit } from "../lib/auth";
import { remittanceJson, clientNameMap, vendorNameMap, authNumberMap, notDeleted, diffDetail, effectiveAuthStatus, authorizationTotalsPaid } from "../lib/serializers";
import { checkDuplicatePayment, checkDuplicatePaymentAllocations, lockDuplicatePaymentKey } from "../lib/paymentDuplicateCheck";
import { money } from "../lib/money";
import { allocatedToLine, enrichPayments } from "../lib/paymentSerialization";
import { parseAltaRemittanceCsv, altaRowFingerprint } from "../lib/altaRemittanceParser";
import { altaFmsPaymentRowFingerprint, parseAltaFmsPaymentWorksheet } from "../lib/altaFmsPaymentParser";
import { sortedOrder } from "../lib/sorting";
import { validateParticipantLinks } from "../lib/participantLinks";
import { isValidIsoDate, normalizeVendor, parseCheckRunCsv, reconcileCheckRun } from "../lib/checkRunReconciliation";
import { findFeeAuthorizationForMonth } from "../lib/feeAuthorization";
import { updateFeeCollectionStatus } from "../lib/feeRemittance";

const router: IRouter = Router();

class DuplicateFingerprint extends Error {}

const MONTHLY_FEE_RULE = "flat_160_per_client_month";
const QUALIFYING_FEE_PAYMENT_TYPES = ["direct_payment", "reimbursement"] as const;

/**
 * The single payment authorization gate. This deliberately runs against the
 * transaction passed by the caller so invoice/payment rows and allocations are
 * checked against one consistent snapshot before any write occurs.
 */
async function assertInvoicePayable(
  tx: typeof db,
  invoiceId: string | null,
  incoming: Map<string, ReturnType<typeof money>> = new Map(),
  excludePaymentId?: string,
  allocationAuthorizationIds: string[] = [],
): Promise<string | null> {
  if (!invoiceId) return null;
  const [invoice] = await tx.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoiceId), notDeleted(invoicesTable)));
  if (!invoice) return `Invoice ${invoiceId} was not found or is deleted`;
  if (invoice.status !== "approved") return `Invoice ${invoiceId} must be approved before payment`;
  const lines = await tx.select().from(invoiceLineItemsTable)
    .where(eq(invoiceLineItemsTable.invoiceId, invoiceId));
  const authIds = [...new Set(lines.map((line) => line.authorizationId))];
  const lineAuthIds = new Set(authIds);
  for (const allocationAuthId of allocationAuthorizationIds) {
    if (!lineAuthIds.has(allocationAuthId)) {
      return `Allocation authorization ${allocationAuthId} does not belong to invoice ${invoiceId}`;
    }
  }
  const auths = authIds.length ? await tx.select().from(authorizationsTable).where(inArray(authorizationsTable.id, authIds)) : [];
  const totals = await authorizationTotalsPaid(authIds, tx, excludePaymentId);
  for (const line of lines) {
    const auth = auths.find((candidate) => candidate.id === line.authorizationId);
    if (!auth) return `Cannot pay line ${line.id}: authorization ${line.authorizationId} is missing`;
    if (auth.paymentType === "fee") return "490 is the CEPS fee authorization. Fees are created automatically and can't be paid by check.";
    const current = totals.get(auth.id) ?? money(0);
    const status = effectiveAuthStatus(auth, current);
    if (status !== "active") {
      return `Cannot pay line ${line.id}: authorization ${auth.authNumber} is ${status}`;
    }
    const next = current.plus(incoming.get(auth.id) ?? money(0));
    if (next.greaterThan(money(auth.maxPeriodAmount))) {
      return `Cannot pay line ${line.id}: authorization ${auth.authNumber} would exceed its remaining capacity`;
    }
  }
  for (const allocationAuthId of new Set(allocationAuthorizationIds)) {
    const auth = auths.find((candidate) => candidate.id === allocationAuthId);
    if (!auth) return `Allocation authorization ${allocationAuthId} is missing for invoice ${invoiceId}`;
    const current = totals.get(auth.id) ?? money(0);
    const status = effectiveAuthStatus(auth, current);
    if (status !== "active") return `Allocation authorization ${auth.authNumber} is ${status} for invoice ${invoiceId}`;
    if (current.plus(incoming.get(auth.id) ?? money(0)).greaterThan(money(auth.maxPeriodAmount))) {
      return `Allocation authorization ${auth.authNumber} would exceed its remaining capacity for invoice ${invoiceId}`;
    }
  }
  return null;
}

type MonthlyFeeAuditItem = {
  clientId: string;
  clientName: string;
  feeMonth: string;
  issue: "missing" | "stale" | "obsolete_rule";
  qualifyingPaymentCount: number;
  feeId: string | null;
  feeAmount: string | null;
  feeStatus: string | null;
  feeRuleApplied: string | null;
  protected: boolean;
  repairAction: "create" | "reverse" | "replace" | "none";
  reason: string;
};

function isUntouchedAutomaticFee(fee: typeof feesTable.$inferSelect): boolean {
  return fee.status === "pending" &&
    fee.notes === null &&
    fee.createdBy === null &&
    fee.ruleApplied !== `${MONTHLY_FEE_RULE}_manually_adjusted`;
}

async function feeHasRemittanceAllocations(feeId: string, database: typeof db = db): Promise<boolean> {
  const [allocation] = await database.select({ id: remittanceAllocationsTable.id })
    .from(remittanceAllocationsTable)
    .where(eq(remittanceAllocationsTable.feeId, feeId))
    .limit(1);
  return !!allocation;
}

async function monthlyFeeAudit(database: typeof db = db, clientIds?: string[]) {
  const paymentConditions = [
    inArray(paymentsTable.paymentType, [...QUALIFYING_FEE_PAYMENT_TYPES]),
    sql`${paymentsTable.source} <> 'historical_import'`,
    notDeleted(paymentsTable),
  ];
  const feeConditions = [
    sql`${feesTable.feeMonth} is not null`,
    notDeleted(feesTable),
  ];
  if (clientIds !== undefined) {
    paymentConditions.push(clientIds.length ? inArray(paymentsTable.clientId, clientIds) : sql`false`);
    feeConditions.push(clientIds.length ? inArray(feesTable.clientId, clientIds) : sql`false`);
  }
  const [qualifyingPayments, activeFees] = await Promise.all([
    database
      .select({
        clientId: paymentsTable.clientId,
        clientName: sql<string>`${clientsTable.firstName} || ' ' || ${clientsTable.lastName}`,
        feeMonth: paymentAllocationsTable.serviceMonth,
        fallbackFeeMonth: paymentsTable.paymentMonth,
        paymentId: paymentsTable.id,
      })
      .from(paymentsTable)
      .leftJoin(paymentAllocationsTable, eq(paymentAllocationsTable.paymentId, paymentsTable.id))
      .innerJoin(clientsTable, and(
        eq(clientsTable.id, paymentsTable.clientId),
        notDeleted(clientsTable),
      ))
      .where(and(...paymentConditions)),
    database
      .select({
        fee: feesTable,
        clientName: sql<string>`${clientsTable.firstName} || ' ' || ${clientsTable.lastName}`,
      })
      .from(feesTable)
      .innerJoin(clientsTable, and(
        eq(clientsTable.id, feesTable.clientId),
        notDeleted(clientsTable),
      ))
      .where(and(...feeConditions)),
  ]);

  const months = new Map<string, {
    clientId: string;
    clientName: string;
    feeMonth: string;
    paymentIds: string[];
    fee?: typeof feesTable.$inferSelect;
  }>();
  for (const payment of qualifyingPayments) {
    const feeMonth = payment.feeMonth ?? payment.fallbackFeeMonth;
    if (!feeMonth) continue;
    const key = `${payment.clientId}:${feeMonth}`;
    const row = months.get(key) ?? {
      clientId: payment.clientId,
      clientName: payment.clientName,
      feeMonth,
      paymentIds: [],
    };
    if (!row.paymentIds.includes(payment.paymentId)) row.paymentIds.push(payment.paymentId);
    months.set(key, row);
  }
  for (const { fee, clientName } of activeFees) {
    if (!fee.feeMonth) continue;
    const key = `${fee.clientId}:${fee.feeMonth}`;
    const row = months.get(key) ?? {
      clientId: fee.clientId,
      clientName,
      feeMonth: fee.feeMonth,
      paymentIds: [],
    };
    row.fee = fee;
    months.set(key, row);
  }

  const items: MonthlyFeeAuditItem[] = [];
  for (const row of months.values()) {
    const paymentCount = row.paymentIds.length;
    const fee = row.fee;
    if (!fee) {
      items.push({
        clientId: row.clientId,
        clientName: row.clientName,
        feeMonth: row.feeMonth,
        issue: "missing",
        qualifyingPaymentCount: paymentCount,
        feeId: null,
        feeAmount: null,
        feeStatus: null,
        feeRuleApplied: null,
        protected: false,
        repairAction: "create",
        reason: "A qualifying payment exists, but there is no active monthly fee.",
      });
      continue;
    }

    const matchesConfirmedRule =
      fee.ruleApplied === MONTHLY_FEE_RULE && fee.amount === "160.00";
    if (matchesConfirmedRule && paymentCount > 0) continue;

    const hasRemittanceAllocations = await feeHasRemittanceAllocations(fee.id, database);
    const untouched = isUntouchedAutomaticFee(fee);
    const obsoleteRule = fee.ruleApplied !== MONTHLY_FEE_RULE;
    const protectedFee = !untouched || hasRemittanceAllocations;
    items.push({
      clientId: row.clientId,
      clientName: row.clientName,
      feeMonth: row.feeMonth,
      issue: obsoleteRule ? "obsolete_rule" : "stale",
      qualifyingPaymentCount: paymentCount,
      feeId: fee.id,
      feeAmount: fee.amount,
      feeStatus: fee.status,
      feeRuleApplied: fee.ruleApplied,
      protected: protectedFee,
      repairAction: protectedFee ? "none" : paymentCount > 0 ? "replace" : "reverse",
      reason: hasRemittanceAllocations
        ? "The fee has remittance allocations and must be reviewed before repair."
        : protectedFee
        ? "The fee has progressed or was manually created or adjusted, so it requires staff review."
        : paymentCount > 0
          ? "An untouched obsolete fee must be replaced by the confirmed flat $160 fee."
          : "No qualifying payment remains for this untouched automatic fee.",
    });
  }

  items.sort((a, b) =>
    a.feeMonth.localeCompare(b.feeMonth) ||
    a.clientName.localeCompare(b.clientName) ||
    a.clientId.localeCompare(b.clientId)
  );
  const protectedIssues = items.filter((item) => item.protected).length;
  return {
    generatedAt: new Date().toISOString(),
    ruleApplied: MONTHLY_FEE_RULE,
    flatAmount: "160.00",
    totalIssues: items.length,
    repairableIssues: items.length - protectedIssues,
    protectedIssues,
    items,
  };
}

function qualifiesForMonthlyFee(paymentType: string): boolean {
  return (QUALIFYING_FEE_PAYMENT_TYPES as readonly string[]).includes(paymentType);
}

async function reconcileMonthlyFee(
  clientId: string,
  paymentMonth: string | null,
  userId: string,
  tx: typeof db = db,
): Promise<"created" | "reversed" | "none"> {
  if (!paymentMonth) return "none";

  // Fee reconciliation is keyed by participant + month (not authorization).
  // Serialize that key so concurrent qualifying payments cannot both decide a
  // fee is missing. Sort affected months at call sites to avoid lock inversion.
  const lockKey = `${clientId}:${paymentMonth}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

  const qualifyingRows = await tx
    .select({ payment: paymentsTable, serviceMonth: paymentAllocationsTable.serviceMonth })
    .from(paymentsTable)
    .leftJoin(paymentAllocationsTable, eq(paymentAllocationsTable.paymentId, paymentsTable.id))
    .where(and(
      eq(paymentsTable.clientId, clientId),
      inArray(paymentsTable.paymentType, [...QUALIFYING_FEE_PAYMENT_TYPES]),
      sql`${paymentsTable.source} <> 'historical_import'`,
      notDeleted(paymentsTable),
    ))
    .orderBy(paymentsTable.createdAt, paymentsTable.id);
  const qualifyingPayments = qualifyingRows.filter(({ payment, serviceMonth }) =>
    (serviceMonth ?? payment.paymentMonth) === paymentMonth,
  );

  const [activeFee] = await tx
    .select()
    .from(feesTable)
    .where(and(
      eq(feesTable.clientId, clientId),
      eq(feesTable.feeMonth, paymentMonth),
      notDeleted(feesTable),
    ))
    .limit(1);

  if (qualifyingPayments.length > 0) {
    const feeAuthorizationId = await findFeeAuthorizationForMonth(tx, clientId, paymentMonth);
    if (activeFee) {
      if (activeFee.status === "pending" && activeFee.authorizationId !== feeAuthorizationId) {
        await tx.update(feesTable).set({ authorizationId: feeAuthorizationId }).where(eq(feesTable.id, activeFee.id));
      }
      return "none";
    }
    const trigger = qualifyingPayments[0].payment;
    const [fee] = await tx
    .insert(feesTable)
    .values({
      clientId,
      feeMonth: paymentMonth,
      paymentId: trigger.id,
      authorizationId: feeAuthorizationId,
      amount: "160.00",
      ruleApplied: MONTHLY_FEE_RULE,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning();
    if (fee) {
      await audit(userId, "auto_generate_fee", "fee", fee.id, `Auto-generated $160.00 (${MONTHLY_FEE_RULE}) for client month ${paymentMonth}, triggered by check ${trigger.qbCheckNumber}`, tx);
      return "created";
    }
    return "none";
  }

  // A fee is reversible only while it remains exactly as this rule created it.
  // Progressed fees and rows changed through fee management are intentionally
  // retained even after the final qualifying payment disappears.
  if (
    activeFee &&
    activeFee.status === "pending" &&
    activeFee.ruleApplied === MONTHLY_FEE_RULE &&
    activeFee.amount === "160.00" &&
    activeFee.notes === null &&
    activeFee.createdBy === null &&
    !(await feeHasRemittanceAllocations(activeFee.id, tx))
  ) {
    const reversedAt = new Date();
    const [reversed] = await tx
      .update(feesTable)
      .set({ isDeleted: true, deletedAt: reversedAt, deletedBy: userId })
      .where(and(
        eq(feesTable.id, activeFee.id),
        eq(feesTable.status, "pending"),
        eq(feesTable.ruleApplied, MONTHLY_FEE_RULE),
        eq(feesTable.amount, "160.00"),
        isNull(feesTable.notes),
        isNull(feesTable.createdBy),
        notDeleted(feesTable),
      ))
      .returning();
    if (reversed) {
      await audit(userId, "auto_reverse_fee", "fee", reversed.id, `Auto-reversed $160.00 (${MONTHLY_FEE_RULE}) for client month ${paymentMonth}; no qualifying payments remain`, tx);
      return "reversed";
    }
  }
  return "none";
}

router.get("/payments", requireAuth, async (req, res): Promise<void> => {
  const query = ListPaymentsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.startDate && query.data.endDate && query.data.startDate > query.data.endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const conditions: SQL[] = [
    notDeleted(paymentsTable),
    // Exclude payments belonging to soft-deleted clients regardless of how the
    // query is filtered (check number search, clientId filter, unfiltered list).
    // This mirrors the invoices/authorizations pattern and ensures a client's
    // payments are invisible the moment the client is soft-deleted.
    sql`${paymentsTable.clientId} in (select id from clients where is_deleted = false)`,
    // NOTE: no vendor-active filter here. Historical payments must remain visible
    // in the Payments Log regardless of whether their vendor is later
    // deactivated (active = false). This mirrors the client case-record payments
    // query, which has no vendor-active filter either. Only soft-delete filters
    // and role scoping restrict visibility.
  ];
  // Role scoping — mirrors the invoices/audit-log SQL-WHERE pattern:
  // vendors see only their own payments; parent/self only their linked client's;
  // service coordinators only payments for clients in their caseload
  // (clients.assignedCoordinatorId = their user id).
  const u = req.user!;
  if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    conditions.push(eq(paymentsTable.vendorId, u.linkedRecordId ?? ""));
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    conditions.push(eq(paymentsTable.clientId, u.linkedRecordId ?? ""));
  } else if (u.role === "service_coordinator") {
    conditions.push(
      sql`${paymentsTable.clientId} in (select id from clients where assigned_coordinator_id = ${u.id} and is_deleted = false)`,
    );
  }
  // Query-string filters
  if (query.data.clientId) conditions.push(eq(paymentsTable.clientId, query.data.clientId));
  if (query.data.vendorId) conditions.push(eq(paymentsTable.vendorId, query.data.vendorId));
  if (query.data.authorizationId) conditions.push(sql`${paymentsTable.id} in (select pa_filter.payment_id from payment_allocations pa_filter where pa_filter.authorization_id = ${query.data.authorizationId})`);
  if (query.data.paymentMonth) {
    conditions.push(sql`(
      exists (
        select 1 from payment_allocations pa_month_filter
        where pa_month_filter.payment_id = ${paymentsTable.id}
          and pa_month_filter.service_month = ${query.data.paymentMonth}
      )
      or (
        not exists (
          select 1 from payment_allocations pa_legacy_month_filter
          where pa_legacy_month_filter.payment_id = ${paymentsTable.id}
        )
        and ${paymentsTable.paymentMonth} = ${query.data.paymentMonth}
      )
    )`);
  }
  if (query.data.startDate) conditions.push(gte(paymentsTable.checkDate, query.data.startDate));
  if (query.data.endDate) conditions.push(lte(paymentsTable.checkDate, query.data.endDate));
  // zod.coerce.boolean() treats the literal "false" as truthy; inspect the
  // wire value so picker requests for eligible (unremitted) payments work.
  const rawRemitted = req.query.remitted;
  if (typeof rawRemitted === "string" && (rawRemitted === "true" || rawRemitted === "false")) {
    conditions.push(eq(paymentsTable.remitted, rawRemitted === "true"));
  }
  if (query.data.status) conditions.push(eq(paymentsTable.paymentType, query.data.status));
  if (query.data.search) {
    const like = `%${escapeLike(query.data.search)}%`;
    // Numeric searches are commonly copied from the UI ("$1,234.00").
    // Compare both the entered spelling and a normalized numeric spelling.
    const normalizedSearch = query.data.search.replace(/[$,]/g, "");
    const numericLike = `%${escapeLike(normalizedSearch)}%`;
    conditions.push(
      or(
        ilike(paymentsTable.qbCheckNumber, like),
        sql`${paymentsTable.clientId} in (select id from clients where (first_name || ' ' || last_name) ilike ${like} and is_deleted = false)`,
        sql`${paymentsTable.vendorId} in (select id from vendors where name ilike ${like})`,
        sql`replace(lower(${paymentsTable.paymentType}), '_', ' ') ilike ${like}`,
        sql`case when ${paymentsTable.remitted} then 'remitted' else 'unremitted' end ilike ${like}`,
        sql`case when ${paymentsTable.remitted} then 'allocated' else 'remaining' end ilike ${like}`,
        sql`(
          exists (
            select 1 from payment_allocations pa_month_search
            where pa_month_search.payment_id = ${paymentsTable.id}
              and pa_month_search.service_month ilike ${like}
          )
          or (
            not exists (
              select 1 from payment_allocations pa_legacy_month_search
              where pa_legacy_month_search.payment_id = ${paymentsTable.id}
            )
            and ${paymentsTable.paymentMonth} ilike ${like}
          )
        )`,
        sql`to_char(${paymentsTable.checkDate}, 'Mon FMDD, YYYY') ilike ${like}`,
        sql`cast(${paymentsTable.checkDate} as text) ilike ${like}`,
        normalizedSearch ? sql`cast(${paymentsTable.amount} as text) ilike ${numericLike}` : sql`false`,
        normalizedSearch ? sql`cast(coalesce(
          (select sum(ra.amount) from remittance_allocations ra where ra.payment_id = ${paymentsTable.id}),
          case when ${paymentsTable.remitted} then ${paymentsTable.amount} else 0 end
        ) as text) ilike ${numericLike}` : sql`false`,
        normalizedSearch ? sql`cast(${paymentsTable.amount} - coalesce(
          (select sum(ra.amount) from remittance_allocations ra where ra.payment_id = ${paymentsTable.id}),
          case when ${paymentsTable.remitted} then ${paymentsTable.amount} else 0 end
        ) as text) ilike ${numericLike}` : sql`false`,
        sql`${paymentsTable.id} in (select pa_search.payment_id from payment_allocations pa_search inner join authorizations a_search on a_search.id = pa_search.authorization_id where (a_search.auth_number ilike ${like} or a_search.service_code ilike ${like} or replace(lower(a_search.status), '_', ' ') ilike ${like} or to_char(a_search.service_period_start, 'Mon FMDD, YYYY') ilike ${like} or to_char(a_search.service_period_end, 'Mon FMDD, YYYY') ilike ${like}) and a_search.is_deleted = false)`,
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
      checkDate: sql`${paymentsTable.checkDate}`,
      qbCheckNumber: sql`lower(${paymentsTable.qbCheckNumber})`,
      vendorName: sql`lower((select name from vendors where id = ${paymentsTable.vendorId}))`,
      clientName: sql`lower((select last_name || ', ' || first_name from clients where id = ${paymentsTable.clientId}))`,
      amount: sql`${paymentsTable.amount}`,
      remitted: sql`${paymentsTable.remitted}`,
      paymentType: sql`lower(${paymentsTable.paymentType})`,
      serviceMonth: sql`(select min(coalesce(pa_sort.service_month, p_sort.payment_month)) from payment_allocations pa_sort inner join payments p_sort on p_sort.id = pa_sort.payment_id where pa_sort.payment_id = ${paymentsTable.id})`,
      createdAt: sql`${paymentsTable.createdAt}`,
    },
    sql`${paymentsTable.id}`,
    [desc(paymentsTable.checkDate), desc(paymentsTable.id)],
  );
  const [[{ total }], payments] = await Promise.all([
    db.select({ total: count() }).from(paymentsTable).where(where),
    db
      .select()
      .from(paymentsTable)
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
  ]);
  res.json(ListPaymentsResponse.parse({ items: await enrichPayments(payments, req.user), total }));
});

router.get("/payments/monthly-fees/audit", requireStaff, async (req, res): Promise<void> => {
  const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
  res.json(AuditMonthlyFeesResponse.parse(await monthlyFeeAudit(db, clientId ? [clientId] : undefined)));
});

router.post("/payments/monthly-fees/repair", requireStaff, async (req, res): Promise<void> => {
  const parsed = RepairMonthlyFeesBody.safeParse(req.body);
  if (!parsed.success || parsed.data.confirm !== true) {
    res.status(400).json({ error: "Review the monthly fee audit and set confirm to true before repairing." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('monthly-fee-audit-repair'))`);
    const before = await monthlyFeeAudit(txDb, parsed.data.clientIds);
    let created = 0;
    let reversed = 0;
    let replaced = 0;

    for (const item of before.items) {
      if (item.repairAction === "none") continue;
      if (item.repairAction === "create") {
        const outcome = await reconcileMonthlyFee(item.clientId, item.feeMonth, req.user!.id, txDb);
        if (outcome === "created") created++;
        continue;
      }

      const lockKey = `${item.clientId}:${item.feeMonth}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const [fee] = await tx
        .select()
        .from(feesTable)
        .where(and(
          eq(feesTable.id, item.feeId!),
          notDeleted(feesTable),
        ))
        .limit(1);
      if (!fee || !isUntouchedAutomaticFee(fee) || await feeHasRemittanceAllocations(fee.id, txDb)) continue;

      const deletedAt = new Date();
      const [removed] = await tx
        .update(feesTable)
        .set({ isDeleted: true, deletedAt, deletedBy: req.user!.id })
        .where(and(
          eq(feesTable.id, fee.id),
          eq(feesTable.status, "pending"),
          isNull(feesTable.notes),
          isNull(feesTable.createdBy),
          notDeleted(feesTable),
        ))
        .returning();
      if (!removed) continue;
      await audit(
        req.user!.id,
        "repair_reverse_obsolete_fee",
        "fee",
        removed.id,
        `Monthly fee repair reversed ${removed.amount} (${removed.ruleApplied ?? "no rule"}) for client month ${item.feeMonth}.`,
        txDb,
      );
      if (item.repairAction === "replace") {
        const outcome = await reconcileMonthlyFee(item.clientId, item.feeMonth, req.user!.id, txDb);
        if (outcome === "created") replaced++;
        else reversed++;
      } else {
        reversed++;
      }
    }

    const after = await monthlyFeeAudit(txDb, parsed.data.clientIds);
    await audit(
      req.user!.id,
      "repair_monthly_fees",
      "fee",
      undefined,
      `${created} created, ${reversed} reversed, ${replaced} replaced, ${after.protectedIssues} protected, ${after.totalIssues} remaining.`,
      txDb,
    );
    return {
      created,
      reversed,
      replaced,
      protected: after.protectedIssues,
      remainingIssues: after.totalIssues,
      report: after,
    };
  });

  res.json(RepairMonthlyFeesResponse.parse(result));
});

router.post("/payments/check-run/reconcile", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const parsed = ReconcileCheckRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { csv, startDate, endDate } = parsed.data;
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate) || startDate > endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const parsedCsv = parseCheckRunCsv(csv, startDate, endDate);
  const payments = await db
    .select({
      id: paymentsTable.id,
      vendorName: vendorsTable.name,
      address: vendorsTable.billingAddress,
      amount: paymentsTable.amount,
      checkNumber: paymentsTable.qbCheckNumber,
      checkDate: paymentsTable.checkDate,
    })
    .from(paymentsTable)
    .innerJoin(invoicesTable, eq(invoicesTable.id, paymentsTable.invoiceId))
    .leftJoin(vendorsTable, eq(vendorsTable.id, paymentsTable.vendorId))
    .where(and(
      notDeleted(paymentsTable),
      notDeleted(invoicesTable),
      eq(invoicesTable.status, "approved"),
      gte(paymentsTable.checkDate, startDate),
      lte(paymentsTable.checkDate, endDate),
    ))
    .orderBy(paymentsTable.checkDate, paymentsTable.qbCheckNumber, paymentsTable.id);
  const report = reconcileCheckRun(
    payments.map((payment) => ({
      ...payment,
      vendorName: payment.vendorName ?? "Unknown vendor",
      vendorKey: payment.vendorName ? undefined : "",
    })),
    parsedCsv.rows,
  );
  res.json(ReconcileCheckRunResponse.parse({
    parsedCount: parsedCsv.parsedCount,
    errorCount: parsedCsv.errors.length,
    errors: parsedCsv.errors,
    ...report,
  }));
});

router.post("/payments", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const parsed = CreatePaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues.map(issue => {
        const field = issue.path.join(".") || "Payment";
        const problem = issue.message.includes("received undefined") ? "This field is required."
          : issue.code === "invalid_format" && issue.path.at(-1) === "amount"
            ? "Enter a valid dollar amount, such as 160.00." : issue.message;
        return `${field}: ${problem}`;
      }).join("; "),
    });
    return;
  }
  // Pull the override fields out before they reach the insert values — they are
  // control flags, not payment columns.
  const { overrideDuplicate, overrideJustification, allocations, ...paymentData } = parsed.data;
  const allocationTotal = allocations.reduce((sum, item) => sum.plus(money(item.amount)), money(0)).toFixed(2);
  if (!money(allocationTotal).equals(money(paymentData.amount))) {
    res.status(400).json({ error: "Allocation total must equal payment amount" });
    return;
  }
  const allocationKeys = allocations.map((allocation) => `${allocation.authorizationId}:${allocation.serviceMonth}`);
  if (new Set(allocationKeys).size !== allocationKeys.length) {
    res.status(400).json({ error: "Duplicate payment allocation authorization and service month" });
    return;
  }
  // Normalize empty strings from the form to null for optional/nullable FK columns
  const values = { ...paymentData, source: "manual", loggedBy: req.user!.id } as Record<string, unknown>;
  for (const k of ["authorizationId", "vendorId", "invoiceId", "paymentMonth"] as const) {
    if (values[k] === "") values[k] = null;
  }
  const dupClientId = values.clientId as string;
  // Deprecated parent authorization relationship is never written for new rows.
  values.authorizationId = null;
  const allocationMonths = [...new Set(allocations.map((allocation) => allocation.serviceMonth))].sort();
  // Keep the deprecated payment-level month as a compatibility value only.
  values.paymentMonth = allocationMonths[0] ?? null;

  // Duplicate-payment HARD STOP: no two payments for the same client +
  // authorization + allocation service month without a written override justification.
  const duplicateKeys = [...new Map(allocations.map((allocation) => [
    `${allocation.authorizationId}:${allocation.serviceMonth}`, allocation,
  ])).values()];
  const runDupCheck = duplicateKeys.length > 0;
  const justification = overrideJustification?.trim();

  // Persist the payment and its auto-generated Fee atomically so a payment can
  // never exist without its corresponding fee. The duplicate check runs INSIDE
  // the transaction behind a pg advisory lock so a concurrent insert for the
  // same client + authorization + month can't slip past the SELECT-then-INSERT
  // window (a unique index isn't viable — justified overrides allow duplicates).
  let duplicateBlocked: Awaited<ReturnType<typeof enrichPayments>> | null = null;
  let relationshipError: string | undefined;
  const payment = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    relationshipError = (await validateParticipantLinks(txDb, dupClientId, {
      authorizationId: null,
      invoiceId: values.invoiceId as string | null,
      vendorId: values.vendorId as string | null,
    })).error;
    if (relationshipError) return null;
    for (const allocation of allocations) {
      relationshipError = (await validateParticipantLinks(txDb, dupClientId, {
        authorizationId: allocation.authorizationId,
        serviceAuthorizationOnly: true,
        invoiceId: null,
        vendorId: values.vendorId as string | null,
      })).error;
      if (relationshipError) return null;
    }
    const invoiceIds = values.invoiceId ? [values.invoiceId as string] : [];
    const incoming = new Map<string, ReturnType<typeof money>>();
    for (const allocation of allocations) {
      incoming.set(allocation.authorizationId, (incoming.get(allocation.authorizationId) ?? money(0)).plus(money(allocation.amount)));
    }
    for (const invoiceId of [...new Set(invoiceIds)]) {
      relationshipError = (await assertInvoicePayable(txDb, invoiceId, incoming, undefined, allocations.map((allocation) => allocation.authorizationId))) ?? undefined;
      if (relationshipError) return null;
    }
    if (runDupCheck) {
      for (const allocation of [...duplicateKeys].sort((a, b) =>
        `${a.authorizationId}:${a.serviceMonth}`.localeCompare(`${b.authorizationId}:${b.serviceMonth}`),
      )) {
        await lockDuplicatePaymentKey(txDb, {
          clientId: dupClientId,
          authorizationId: allocation.authorizationId,
          serviceMonth: allocation.serviceMonth,
        });
      }
      const { isDuplicate, existingPayments } = await checkDuplicatePaymentAllocations(txDb, {
        clientId: dupClientId,
        allocations: duplicateKeys,
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
    await tx.insert(paymentAllocationsTable).values(allocations.map((allocation) => ({
      paymentId: p.id,
      authorizationId: allocation.authorizationId,
      serviceMonth: allocation.serviceMonth,
      amount: allocation.amount,
    })));
    if (qualifiesForMonthlyFee(p.paymentType)) {
      for (const month of allocationMonths) await reconcileMonthlyFee(p.clientId, month, req.user!.id, txDb);
    }
    // Record any accepted duplicate override in the same transaction, keyed to
    // the NEW payment's id, so the audit trail can never diverge from the row.
    if (runDupCheck && overrideDuplicate && justification) {
      await audit(req.user!.id, "override_duplicate_payment", "payment", p.id, justification, txDb);
    }
    await audit(req.user!.id, "create_payment", "payment", p.id, `Check ${p.qbCheckNumber} — $${p.amount}`, txDb);
    return p;
  });
  if (!payment) {
    if (relationshipError) {
      res.status(400).json({ error: relationshipError });
      return;
    }
    res.status(409).json({
      error: "A payment already exists for this client, authorization, and service month. This is a hard stop — override requires a written justification.",
      code: "duplicate_payment",
      existingPayments: duplicateBlocked ?? [],
    });
    return;
  }
  res.status(201).json(CreatePaymentResponse.parse((await enrichPayments([payment]))[0]));
});

const ACTIONABLE_AUDIT_RESULTS = new Set<AltaFmsPaymentAuditRowResult>([
  "payee_mismatch", "amount_mismatch", "no_approved_invoice", "already_paid",
]);
const emptyAuditSummary = () => ({
  match: 0,
  payee_mismatch: 0,
  amount_mismatch: 0,
  no_approved_invoice: 0,
  already_paid: 0,
  unknown_client: 0,
  unknown_authorization: 0,
  duplicate_row: 0,
});

async function auditAltaFmsWorksheet(
  worksheetRows: string[][],
  invoiceResolutionByRow: Map<number, string> = new Map(),
) {
  const source = parseAltaFmsPaymentWorksheet(worksheetRows);
  const summary = emptyAuditSummary();
  if (source.headerError) {
    return AuditAltaFmsPaymentsResponse.parse({
      summary, rows: [], parseProblems: [], headerError: source.headerError, ignoredNonCheckRows: 0,
    });
  }

  const chunked = <T>(values: T[], size = 1_000): T[][] => {
    const result: T[][] = [];
    for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
    return result;
  };
  const uciNumbers = [...new Set(source.rows.map((row) => row.uciNumber))];
  const authNumbers = [...new Set(source.rows.map((row) => row.authNumber))];
  const months = [...new Set(source.rows.map((row) => row.serviceMonth))];
  const fingerprints = [...new Set(source.rows.map(altaFmsPaymentRowFingerprint))];
  const clients: (typeof clientsTable.$inferSelect)[] = [];
  for (const chunk of chunked(uciNumbers)) {
    clients.push(...await db.select().from(clientsTable).where(and(
      inArray(clientsTable.uciNumber, chunk), notDeleted(clientsTable),
    )));
  }
  const clientByUci = new Map(clients.map((client) => [client.uciNumber, client]));
  const auths: (typeof authorizationsTable.$inferSelect)[] = [];
  for (const clientChunk of chunked(clients.map((client) => client.id), 500)) {
    for (const authChunk of chunked(authNumbers, 500)) {
      auths.push(...await db.select().from(authorizationsTable).where(and(
        inArray(authorizationsTable.clientId, clientChunk),
        inArray(authorizationsTable.authNumber, authChunk),
        notDeleted(authorizationsTable),
      )));
    }
  }
  const authByClientAndNumber = new Map(auths.map((auth) => [`${auth.clientId}::${auth.authNumber}`, auth]));
  const authIds = [...new Set(auths.map((auth) => auth.id))];
  const storedFingerprints = new Set<string>();
  for (const chunk of chunked(fingerprints)) {
    const existing = await db.select({ fingerprint: paymentsTable.sourceRowFingerprint })
      .from(paymentsTable)
      .where(and(inArray(paymentsTable.sourceRowFingerprint, chunk), notDeleted(paymentsTable)));
    for (const row of existing) if (row.fingerprint) storedFingerprints.add(row.fingerprint);
  }
  type Candidate = {
    invoiceId: string;
    vendorId: string | null;
    vendorName: string | null;
    qbPayeeName: string | null;
    invoiceStatus: string;
    reviewedBy: string | null;
    reviewedAt: Date | null;
    authorizationId: string;
    serviceMonth: string;
    amount: string;
    remaining: string | null;
  };
  const candidateRows = authIds.length && months.length
    ? await db.select({
      line: invoiceLineItemsTable,
      invoice: invoicesTable,
      vendorName: vendorsTable.name,
      qbPayeeName: vendorsTable.qbPayeeName,
    }).from(invoiceLineItemsTable)
      .innerJoin(invoicesTable, eq(invoicesTable.id, invoiceLineItemsTable.invoiceId))
      .leftJoin(vendorsTable, eq(vendorsTable.id, invoicesTable.vendorId))
      .where(and(
        inArray(invoiceLineItemsTable.authorizationId, authIds),
        inArray(invoiceLineItemsTable.serviceMonth, months),
        notDeleted(invoicesTable),
      ))
    : [];
  const invoiceAllocated = new Map<string, ReturnType<typeof money>>();
  const unlinkedAllocated = new Map<string, ReturnType<typeof money>>();
  for (const authChunk of chunked(authIds)) {
    for (const monthChunk of chunked(months)) {
      const allocations = await db.select({
        authorizationId: paymentAllocationsTable.authorizationId,
        serviceMonth: paymentAllocationsTable.serviceMonth,
        amount: paymentAllocationsTable.amount,
        invoiceId: paymentsTable.invoiceId,
      }).from(paymentAllocationsTable)
        .innerJoin(paymentsTable, eq(paymentsTable.id, paymentAllocationsTable.paymentId))
        .where(and(
          inArray(paymentAllocationsTable.authorizationId, authChunk),
          inArray(paymentAllocationsTable.serviceMonth, monthChunk),
          notDeleted(paymentsTable),
        ));
      for (const allocation of allocations) {
        if (!allocation.serviceMonth) continue;
        const key = `${allocation.authorizationId}::${allocation.serviceMonth}`;
        if (allocation.invoiceId) {
          const invoiceKey = `${key}::${allocation.invoiceId}`;
          invoiceAllocated.set(invoiceKey, (invoiceAllocated.get(invoiceKey) ?? money(0)).plus(allocation.amount));
        } else {
          unlinkedAllocated.set(key, (unlinkedAllocated.get(key) ?? money(0)).plus(allocation.amount));
        }
      }
    }
  }
  const approvedCandidateCountByKey = new Map<string, number>();
  for (const selected of candidateRows) {
    if (selected.invoice.status !== "approved") continue;
    const line = selected.line;
    const key = `${selected.invoice.clientId}::${line.authorizationId}::${line.serviceMonth}`;
    approvedCandidateCountByKey.set(key, (approvedCandidateCountByKey.get(key) ?? 0) + 1);
  }
  const candidatesByKey = new Map<string, Candidate[]>();
  for (const selected of candidateRows) {
    const line = selected.line;
    const invoice = selected.invoice;
    const key = `${invoice.clientId}::${line.authorizationId}::${line.serviceMonth}`;
    const allocationKey = `${line.authorizationId}::${line.serviceMonth}`;
    const invoiceAllocationKey = `${allocationKey}::${invoice.id}`;
    let paid = invoiceAllocated.get(invoiceAllocationKey) ?? money(0);
    const unlinked = unlinkedAllocated.get(allocationKey) ?? money(0);
    const remainingIsUncertain = invoice.status === "approved" &&
      approvedCandidateCountByKey.get(key)! > 1 &&
      unlinked.greaterThan(0);
    if (invoice.status === "approved" &&
        approvedCandidateCountByKey.get(key) === 1) {
      paid = paid.plus(unlinked);
    }
    const remaining = money(line.amount).minus(paid);
    const candidate: Candidate = {
      invoiceId: invoice.id,
      vendorId: invoice.vendorId,
      vendorName: selected.vendorName,
      qbPayeeName: selected.qbPayeeName,
      invoiceStatus: invoice.status,
      reviewedBy: invoice.reviewedBy,
      reviewedAt: invoice.reviewedAt,
      authorizationId: line.authorizationId,
      serviceMonth: line.serviceMonth,
      amount: line.amount,
      remaining: remainingIsUncertain
        ? null
        : (remaining.lessThan(0) ? money(0) : remaining).toFixed(2),
    };
    candidatesByKey.set(key, [...(candidatesByKey.get(key) ?? []), candidate]);
  }
  const summaryRows: AltaFmsPaymentAuditRow[] = [];
  const seenFingerprints = new Set<string>();
  for (const row of source.rows) {
    const fingerprint = altaFmsPaymentRowFingerprint(row);
    let result: AltaFmsPaymentAuditRowResult;
    let reason: string;
    let selected: Candidate | undefined;
    let resolutionCandidates: Candidate[] | undefined;
    const client = clientByUci.get(row.uciNumber);
    const authorization = client ? authByClientAndNumber.get(`${client.id}::${row.authNumber}`) : undefined;
    if (storedFingerprints.has(fingerprint) || seenFingerprints.has(fingerprint)) {
      result = "duplicate_row";
      reason = "This Alta FMS line was already imported (matched by source-row fingerprint).";
    } else if (!client) {
      result = "unknown_client";
      reason = `No active client was found for UCI "${row.uciNumber}".`;
    } else if (!authorization) {
      result = "unknown_authorization";
      reason = `Authorization "${row.authNumber}" was not found for this participant.`;
    } else {
      const key = `${client.id}::${authorization.id}::${row.serviceMonth}`;
      const candidates = candidatesByKey.get(key) ?? [];
      const approved = candidates.filter((candidate) => candidate.invoiceStatus === "approved");
      const authMonthKey = `${authorization.id}::${row.serviceMonth}`;
      if (approved.length > 1 && (unlinkedAllocated.get(authMonthKey) ?? money(0)).greaterThan(0)) {
        result = "amount_mismatch";
        reason = "Existing allocations are not linked to a specific invoice and multiple approved lines exist; no invoice was selected because the remaining balance is ambiguous.";
        resolutionCandidates = approved;
      } else
      if (!approved.length) {
        const otherStatuses = [...new Set(candidates.map((candidate) => candidate.invoiceStatus))];
        result = "no_approved_invoice";
        reason = otherStatuses.length
          ? `No approved invoice line exists for this authorization and service month; found but invoice status is ${otherStatuses.join(", ")}.`
          : "No approved invoice line exists for this participant, authorization, and service month.";
      } else {
        const normalizedPayee = normalizeVendor(row.payeeName);
        const payeeMatches = approved.filter((candidate) => normalizedPayee !== "" && (
          normalizedPayee === normalizeVendor(candidate.vendorName ?? "") ||
          normalizedPayee === normalizeVendor(candidate.qbPayeeName ?? "")
        ));
        const amountMatches = approved.filter((candidate) =>
          candidate.remaining !== null && money(candidate.remaining).equals(money(row.amount)),
        );
        const exactMatches = payeeMatches.filter((candidate) => amountMatches.includes(candidate));
        if (payeeMatches.length > 0) {
          if (exactMatches.length === 1) selected = exactMatches[0];
          else if (payeeMatches.length === 1) selected = payeeMatches[0];
        } else if (approved.length === 1) {
          selected = approved[0];
        }

        if (!selected) {
          result = payeeMatches.length === 0 ? "payee_mismatch" : "amount_mismatch";
          reason = payeeMatches.length > 1
            ? `Multiple approved invoice lines match the check payee "${row.payeeName}", and the remaining balance does not identify exactly one line; no invoice was selected.`
            : payeeMatches.length === 0
              ? `No approved invoice vendor matches the check payee "${row.payeeName}"; amount alone is not sufficient to select among multiple invoice lines.`
              : `Multiple approved invoice lines could match this check for ${row.amount}; no invoice was selected because the match is ambiguous.`;
          resolutionCandidates = approved;
        } else {
          const payeeMatchesSelected = normalizedPayee !== "" && (
            normalizedPayee === normalizeVendor(selected.vendorName ?? "") ||
            normalizedPayee === normalizeVendor(selected.qbPayeeName ?? "")
          );
          if (!payeeMatchesSelected) {
            result = "payee_mismatch";
            reason = `Check payee "${row.payeeName}" does not match approved vendor "${selected.vendorName ?? "unknown"}"${selected.qbPayeeName ? ` or QuickBooks payee "${selected.qbPayeeName}"` : ""}.`;
          } else if (money(selected.remaining).isZero()) {
            result = "already_paid";
            reason = `The approved invoice line for ${selected.amount} is already fully covered by payment allocations.`;
          } else if (!money(selected.remaining).equals(money(row.amount))) {
            result = "amount_mismatch";
            reason = `Check amount ${row.amount} differs from the approved line amount ${selected.amount} and remaining unpaid amount ${selected.remaining}.`;
          } else {
            result = "match";
            reason = "Check payee and amount match the approved invoice line's remaining balance.";
          }
        }
      }
    }
    seenFingerprints.add(fingerprint);
    summary[result]++;
    summaryRows.push({
      rowNumber: row.rowNumber,
      checkNumber: row.checkNumber,
      checkDate: row.checkDate,
      uciNumber: row.uciNumber,
      participantName: client ? `${client.firstName} ${client.lastName}` : null,
      payeeName: row.payeeName,
      checkAmount: row.amount,
      authNumber: row.authNumber,
      serviceMonth: row.serviceMonth,
      result,
      reason,
      invoiceId: selected?.invoiceId ?? null,
      invoiceVendor: selected?.vendorName ?? null,
      invoiceVendorId: selected?.vendorId ?? null,
      approvedAmount: selected?.amount ?? null,
      remainingAmount: selected?.remaining ?? null,
      reviewedBy: selected?.reviewedBy ?? null,
      reviewedAt: selected?.reviewedAt?.toISOString() ?? null,
      ...(resolutionCandidates ? {
        candidates: resolutionCandidates.map((candidate) => ({
          invoiceId: candidate.invoiceId,
          vendorName: candidate.vendorName,
          vendorId: candidate.vendorId,
          approvedAmount: candidate.amount,
          remainingAmount: candidate.remaining,
          reviewedBy: candidate.reviewedBy,
          reviewedAt: candidate.reviewedAt?.toISOString() ?? null,
        })),
      } : {}),
    });
    const consumePotentialPayment = (candidate: Candidate) => {
      if (candidate.remaining === null) {
        candidate.remaining = "0.00";
        return;
      }
      const remainingAfterCheck = money(candidate.remaining).minus(row.amount);
      candidate.remaining = (remainingAfterCheck.lessThan(0) ? money(0) : remainingAfterCheck).toFixed(2);
    };
    if (selected) {
      consumePotentialPayment(selected);
    } else if (resolutionCandidates?.length) {
      const acknowledgedCandidate = resolutionCandidates.find((candidate) =>
        candidate.invoiceId === invoiceResolutionByRow.get(row.rowNumber),
      );
      if (acknowledgedCandidate) {
        consumePotentialPayment(acknowledgedCandidate);
      } else {
        // Until an ambiguous row is resolved, reserve its possible consumption
        // against every eligible line so a later row cannot appear safe by
        // choosing the same line or by selecting an amount-only alternative.
        for (const candidate of resolutionCandidates) candidate.remaining = "0.00";
      }
    }
  }
  return AuditAltaFmsPaymentsResponse.parse({
    summary,
    rows: summaryRows,
    parseProblems: source.problems,
    headerError: null,
    ignoredNonCheckRows: source.ignoredNonCheckRows,
  });
}

router.post("/payments/import/audit", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const parsed = AuditAltaFmsPaymentsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(await auditAltaFmsWorksheet(parsed.data.worksheetRows));
});

router.post("/payments/import", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const parsed = ImportAltaFmsPaymentsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const source = parseAltaFmsPaymentWorksheet(parsed.data.worksheetRows);
  const invoiceResolutionByRow = new Map<number, string>();
  for (const acknowledgement of parsed.data.acknowledgements ?? []) {
    if (acknowledgement.invoiceId) invoiceResolutionByRow.set(acknowledgement.rowNumber, acknowledgement.invoiceId);
  }
  const auditReport = await auditAltaFmsWorksheet(parsed.data.worksheetRows, invoiceResolutionByRow);
  if (auditReport.headerError) {
    res.json(ImportAltaFmsPaymentsResponse.parse({
      imported: 0, skippedDuplicate: 0, flaggedDuplicate: 0, errored: 0,
      ignoredNonCheckRows: 0, headerError: auditReport.headerError, parseProblems: [], results: [],
    }));
    return;
  }
  const ackByRow = new Map<number, { note: string; invoiceId?: string }>();
  for (const acknowledgement of parsed.data.acknowledgements ?? []) {
    const note = acknowledgement.note.trim();
    const row = auditReport.rows.find((candidate) => candidate.rowNumber === acknowledgement.rowNumber);
    if (!note || ackByRow.has(acknowledgement.rowNumber) || !row || !ACTIONABLE_AUDIT_RESULTS.has(row.result)) {
      res.status(400).json({ error: `Invalid acknowledgement for worksheet row ${acknowledgement.rowNumber}; a non-empty note is required for an actionable audit exception.` });
      return;
    }
    const requiresInvoiceResolution = (row.candidates?.length ?? 0) > 1 && row.invoiceId === null;
    const candidateInvoiceIds = row.candidates?.map((candidate) => candidate.invoiceId) ?? [];
    if (requiresInvoiceResolution && (!acknowledgement.invoiceId || !candidateInvoiceIds.includes(acknowledgement.invoiceId))) {
      res.status(400).json({ error: `Acknowledgement for worksheet row ${row.rowNumber} must select an invoice from the audit's approved candidates.` });
      return;
    }
    if (acknowledgement.invoiceId &&
        !candidateInvoiceIds.includes(acknowledgement.invoiceId) &&
        acknowledgement.invoiceId !== row.invoiceId) {
      res.status(400).json({ error: `Invoice ${acknowledgement.invoiceId} is not an audited candidate for worksheet row ${row.rowNumber}.` });
      return;
    }
    ackByRow.set(acknowledgement.rowNumber, { note, invoiceId: acknowledgement.invoiceId });
  }
  const unacknowledged = auditReport.rows.filter((row) =>
    ACTIONABLE_AUDIT_RESULTS.has(row.result) && !ackByRow.has(row.rowNumber));
  if (unacknowledged.length) {
    res.status(409).json({
      error: "Import blocked: acknowledge every actionable payment audit exception with a note or correct the worksheet.",
      audit: auditReport,
      unacknowledgedRows: unacknowledged.map((row) => row.rowNumber),
    });
    return;
  }

  // The audit is recomputed above on the import request, before any writes. Only
  // keys in this workbook are preloaded; a row is rechecked under transaction
  // locks immediately before its payment and allocation are inserted.
  const uciNumbers = [...new Set(source.rows.map((row) => row.uciNumber))];
  const authNumbers = [...new Set(source.rows.map((row) => row.authNumber))];
  const clients: (typeof clientsTable.$inferSelect)[] = [];
  for (let index = 0; index < uciNumbers.length; index += 1_000) {
    clients.push(...await db.select().from(clientsTable).where(and(
      inArray(clientsTable.uciNumber, uciNumbers.slice(index, index + 1_000)),
      notDeleted(clientsTable),
    )));
  }
  const clientByUci = new Map(clients.map((client) => [client.uciNumber, client]));
  const auths: (typeof authorizationsTable.$inferSelect)[] = [];
  for (let ci = 0; ci < clients.length; ci += 500) {
    for (let ai = 0; ai < authNumbers.length; ai += 500) {
      auths.push(...await db.select().from(authorizationsTable).where(and(
        inArray(authorizationsTable.clientId, clients.slice(ci, ci + 500).map((client) => client.id)),
        inArray(authorizationsTable.authNumber, authNumbers.slice(ai, ai + 500)),
        notDeleted(authorizationsTable),
      )));
    }
  }
  const authByClientAndNumber = new Map(auths.map((auth) => [`${auth.clientId}::${auth.authNumber}`, auth]));
  const results: { rowNumber: number; uciNumber?: string | null; outcome: "imported" | "skipped_duplicate" | "flagged_duplicate" | "errored"; message?: string | null; paymentId?: string | null }[] = [];
  let imported = 0;
  let skippedDuplicate = 0;
  let flaggedDuplicate = 0;
  let errored = source.problems.length;
  for (const problem of source.problems) {
    const rowNumber = Number(problem.match(/^Row (\d+):/)?.[1]);
    if (rowNumber) results.push({ rowNumber, outcome: "errored", message: problem });
  }

  for (const row of source.rows) {
    const fingerprint = altaFmsPaymentRowFingerprint(row);
    const auditRow = auditReport.rows.find((candidate) => candidate.rowNumber === row.rowNumber)!;
    if (auditRow.result === "duplicate_row") {
      skippedDuplicate++;
      results.push({ rowNumber: row.rowNumber, uciNumber: row.uciNumber, outcome: "skipped_duplicate", message: auditRow.reason });
      continue;
    }
    const client = clientByUci.get(row.uciNumber);
    if (!client) {
      errored++;
      results.push({ rowNumber: row.rowNumber, uciNumber: row.uciNumber, outcome: "errored", message: `No client found for UCI "${row.uciNumber}".` });
      continue;
    }
    const authorization = authByClientAndNumber.get(`${client.id}::${row.authNumber}`);
    if (!authorization) {
      errored++;
      results.push({ rowNumber: row.rowNumber, uciNumber: row.uciNumber, outcome: "errored", message: `Authorization "${row.authNumber}" not found for UCI "${row.uciNumber}".` });
      continue;
    }
    const acknowledgement = ackByRow.get(row.rowNumber);
    const resolvedCandidate = acknowledgement?.invoiceId
      ? auditRow.candidates?.find((candidate) => candidate.invoiceId === acknowledgement.invoiceId)
      : undefined;
    const invoiceId = resolvedCandidate?.invoiceId ?? auditRow.invoiceId;
    const vendorId = resolvedCandidate?.vendorId ?? auditRow.invoiceVendorId;
    const approvedAmount = resolvedCandidate?.approvedAmount ?? auditRow.approvedAmount;
    const auditedRemainingAmount = resolvedCandidate?.remainingAmount ?? auditRow.remainingAmount;
    try {
      const transactionResult = await db.transaction(async (tx) => {
        const txDb = tx as unknown as typeof db;
        let lineRemainingBalance: ReturnType<typeof money> | null = null;
        await lockDuplicatePaymentKey(txDb, {
          clientId: client.id, authorizationId: authorization.id, serviceMonth: row.serviceMonth,
        });
        const [existingSourceRow] = await tx.select({ id: paymentsTable.id })
          .from(paymentsTable)
          .where(and(eq(paymentsTable.sourceRowFingerprint, fingerprint), notDeleted(paymentsTable)))
          .limit(1);
        if (existingSourceRow) return { kind: "source_duplicate" as const };
        const [lockedAuthorization] = await tx.select().from(authorizationsTable)
          .where(and(
            eq(authorizationsTable.id, authorization.id),
            eq(authorizationsTable.clientId, client.id),
            notDeleted(authorizationsTable),
          ))
          .for("update");
        if (!lockedAuthorization) throw new Error("The authorization is no longer active; rerun the audit.");

        if (invoiceId) {
          const [lockedInvoice] = await tx.select().from(invoicesTable)
            .where(and(eq(invoicesTable.id, invoiceId), notDeleted(invoicesTable)))
            .for("update");
          if (!lockedInvoice || lockedInvoice.status !== "approved" ||
              lockedInvoice.clientId !== client.id || lockedInvoice.vendorId !== vendorId) {
            throw new Error("The selected invoice is no longer approved; rerun the audit.");
          }
          const [lockedLine] = await tx.select().from(invoiceLineItemsTable)
            .where(and(
              eq(invoiceLineItemsTable.invoiceId, invoiceId),
              eq(invoiceLineItemsTable.authorizationId, authorization.id),
              eq(invoiceLineItemsTable.serviceMonth, row.serviceMonth),
            ))
            .for("update");
          if (!lockedLine || !money(lockedLine.amount).equals(money(approvedAmount))) {
            throw new Error("The approved invoice line changed after audit; rerun the audit.");
          }
          const approvedLinesNow = await tx.select({ id: invoiceLineItemsTable.id })
            .from(invoiceLineItemsTable)
            .innerJoin(invoicesTable, eq(invoicesTable.id, invoiceLineItemsTable.invoiceId))
            .where(and(
              eq(invoicesTable.clientId, client.id),
              eq(invoicesTable.status, "approved"),
              notDeleted(invoicesTable),
              eq(invoiceLineItemsTable.authorizationId, authorization.id),
              eq(invoiceLineItemsTable.serviceMonth, row.serviceMonth),
            ))
            .for("update");
          const [linkedPaid] = await tx.select({
            total: sql<string>`coalesce(sum(${paymentAllocationsTable.amount}), 0)`,
          }).from(paymentAllocationsTable)
            .innerJoin(paymentsTable, eq(paymentsTable.id, paymentAllocationsTable.paymentId))
            .where(and(
              eq(paymentAllocationsTable.authorizationId, authorization.id),
              eq(paymentAllocationsTable.serviceMonth, row.serviceMonth),
              eq(paymentsTable.invoiceId, invoiceId),
              notDeleted(paymentsTable),
            ));
          const [unlinkedPaid] = await tx.select({
            total: sql<string>`coalesce(sum(${paymentAllocationsTable.amount}), 0)`,
          }).from(paymentAllocationsTable)
            .innerJoin(paymentsTable, eq(paymentsTable.id, paymentAllocationsTable.paymentId))
            .where(and(
              eq(paymentAllocationsTable.authorizationId, authorization.id),
              eq(paymentAllocationsTable.serviceMonth, row.serviceMonth),
              isNull(paymentsTable.invoiceId),
              notDeleted(paymentsTable),
            ));
          const unlinkedTotal = money(unlinkedPaid?.total ?? 0);
          const explicitResolution = Boolean(resolvedCandidate && auditRow.invoiceId === null);
          if (approvedLinesNow.length > 1 && unlinkedTotal.greaterThan(0) && !explicitResolution) {
            throw new Error("Unlinked payment allocations make this invoice line ambiguous; rerun the audit.");
          }
          const paidForLine = money(linkedPaid?.total ?? 0).plus(
            approvedLinesNow.length === 1 || explicitResolution ? unlinkedTotal : money(0),
          );
          const currentRemaining = money(lockedLine.amount).minus(paidForLine);
          const safeRemaining = currentRemaining.lessThan(0) ? money(0) : currentRemaining;
          if (auditedRemainingAmount !== null && !safeRemaining.equals(money(auditedRemainingAmount))) {
            throw new Error("Payments allocated to this invoice line changed after audit; rerun the audit.");
          }
          if (money(row.amount).greaterThan(safeRemaining)) {
            throw new Error("Check amount exceeds the selected invoice line's remaining approved capacity.");
          }
          lineRemainingBalance = safeRemaining;
          const linkValidation = await validateParticipantLinks(txDb, client.id, {
            authorizationId: authorization.id, invoiceId, vendorId,
          });
          if ("error" in linkValidation) throw new Error(linkValidation.error);
          const payableError = await assertInvoicePayable(
            txDb, invoiceId, new Map([[authorization.id, money(row.amount)]],), undefined, [authorization.id],
          );
          if (payableError) throw new Error(payableError);
        } else {
          const linkValidation = await validateParticipantLinks(txDb, client.id, { authorizationId: authorization.id });
          if ("error" in linkValidation) throw new Error(linkValidation.error);
        }

        const duplicate = await checkDuplicatePayment(txDb, {
          clientId: client.id, authorizationId: authorization.id, serviceMonth: row.serviceMonth,
        });
        if (duplicate.isDuplicate) {
          const duplicateCheckNumber = duplicate.existingPayments.find((existing) => existing.qbCheckNumber === row.checkNumber);
          const hasInvoiceCapacity = Boolean(invoiceId) &&
            lineRemainingBalance !== null &&
            lineRemainingBalance.greaterThan(0) &&
            !duplicateCheckNumber;
          if (!hasInvoiceCapacity) {
            const existing = duplicateCheckNumber ?? duplicate.existingPayments[0];
            await audit(
              req.user!.id, "flag_duplicate_payment", "payment", existing.id,
              `Alta FMS row ${row.rowNumber} held back — check ${row.checkNumber} conflicts with existing check ${existing.qbCheckNumber}.`,
              txDb,
            );
            return { kind: "business_duplicate" as const, existing };
          }
        }

        const [inserted] = await tx.insert(paymentsTable).values({
          clientId: client.id,
          authorizationId: null,
          vendorId,
          invoiceId,
          qbCheckNumber: row.checkNumber,
          checkDate: row.checkDate,
          amount: row.amount,
          paymentMonth: row.serviceMonth,
          paymentType: row.paymentType,
          source: "historical_import",
          loggedBy: req.user!.id,
          sourceRowFingerprint: fingerprint,
        }).onConflictDoNothing().returning();
        if (!inserted) return { kind: "source_duplicate" as const };
        await tx.insert(paymentAllocationsTable).values({
          paymentId: inserted.id,
          authorizationId: authorization.id,
          serviceMonth: row.serviceMonth,
          amount: row.amount,
        });
        const paymentLinkValidation = await validateParticipantLinks(txDb, client.id, {
          authorizationId: authorization.id,
          invoiceId,
          paymentId: inserted.id,
          vendorId,
        });
        if ("error" in paymentLinkValidation) throw new Error(paymentLinkValidation.error);
        if (acknowledgement) {
          await audit(
            req.user!.id,
            "acknowledge_check_audit_exception",
            "payment",
            inserted.id,
            `Check ${row.checkNumber}; audit result ${auditRow.result};${resolvedCandidate ? ` selected invoice ${resolvedCandidate.invoiceId};` : ""} note: ${acknowledgement.note}`,
            txDb,
          );
        }
        await audit(req.user!.id, "import_alta_fms_payment", "payment", inserted.id, `Alta FMS historical import — check ${inserted.qbCheckNumber}`, txDb);
        return { kind: "imported" as const, payment: inserted };
      });
      if (transactionResult.kind === "source_duplicate") {
        skippedDuplicate++;
        results.push({ rowNumber: row.rowNumber, uciNumber: row.uciNumber, outcome: "skipped_duplicate", message: "This Alta FMS line was already imported (matched by source-row fingerprint)." });
      } else if (transactionResult.kind === "business_duplicate") {
        flaggedDuplicate++;
        results.push({
          rowNumber: row.rowNumber, uciNumber: row.uciNumber, outcome: "flagged_duplicate",
          paymentId: transactionResult.existing.id,
          message: `Held back: existing check ${transactionResult.existing.qbCheckNumber} already covers this participant, authorization, and service month.`,
        });
      } else {
        imported++;
        results.push({ rowNumber: row.rowNumber, uciNumber: row.uciNumber, outcome: "imported", paymentId: transactionResult.payment.id });
      }
    } catch (error) {
      errored++;
      results.push({ rowNumber: row.rowNumber, uciNumber: row.uciNumber, outcome: "errored", message: error instanceof Error ? error.message : "Insert failed." });
    }
  }
  await audit(req.user!.id, "import_alta_fms_payments", "payment", undefined, `${imported} imported, ${skippedDuplicate} source duplicate, ${flaggedDuplicate} business duplicate, ${errored} errored`);
  res.json(ImportAltaFmsPaymentsResponse.parse({
    imported, skippedDuplicate, flaggedDuplicate, errored,
    ignoredNonCheckRows: source.ignoredNonCheckRows,
    headerError: null, parseProblems: source.problems, results,
  }));
});

router.get("/payments/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(and(eq(paymentsTable.id, id), notDeleted(paymentsTable)));
  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  // Exclude payments belonging to soft-deleted clients (mirrors GET /payments).
  const [activeClient] = await db
    .select({ id: clientsTable.id, assignedCoordinatorId: clientsTable.assignedCoordinatorId })
    .from(clientsTable)
    .where(and(eq(clientsTable.id, payment.clientId), eq(clientsTable.isDeleted, false)));
  if (!activeClient) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  // Per-role ownership, mirroring the GET /payments list scoping:
  // staff see all; coordinators only payments for clients in their caseload;
  // parent/self only their linked client's payments; vendors only their own
  // vendor's payments.
  const u = req.user!;
  if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    if (payment.vendorId !== u.linkedRecordId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    if (payment.clientId !== u.linkedRecordId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  } else if (u.role === "service_coordinator") {
    if (activeClient.assignedCoordinatorId !== u.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }
  res.json(GetPaymentResponse.parse((await enrichPayments([payment], req.user))[0]));
});

router.patch("/payments/:id", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdatePaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Pull the override control flags out before they reach the update set — they
  // are not payment columns.
  const { overrideDuplicate, overrideJustification, allocations, ...updateData } = parsed.data;
  if (allocations) {
    const total = allocations.reduce((sum, item) => sum.plus(money(item.amount)), money(0)).toFixed(2);
    const requested = "amount" in updateData ? money(updateData.amount as string) : null;
    if (requested !== null && !requested.equals(money(total))) {
      res.status(400).json({ error: "Allocation total must equal payment amount" });
      return;
    }
    if (!("amount" in updateData)) updateData.amount = total;
  }
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
  const effClientId = before.clientId;
  const beforeAllocations = await db.select()
    .from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, id));
  // Keep old clients that patch the deprecated paymentMonth field working by
  // applying it to every allocation. New callers edit serviceMonth per row.
  const legacyMonthMove = !allocations && "paymentMonth" in updateData && beforeAllocations.length > 0;
  if (legacyMonthMove && typeof updates.paymentMonth !== "string") {
    res.status(400).json({ error: "paymentMonth cannot be cleared while payment allocations exist" });
    return;
  }
  const allocationsToPersist = allocations ?? beforeAllocations.map((allocation) => ({
    authorizationId: allocation.authorizationId,
    amount: allocation.amount,
    serviceMonth: legacyMonthMove
      ? (updates.paymentMonth as string)
      : allocation.serviceMonth ?? before.paymentMonth ?? before.checkDate.slice(0, 7),
  }));
  const allocationKeys = allocationsToPersist.map((allocation) => `${allocation.authorizationId}:${allocation.serviceMonth}`);
  if (new Set(allocationKeys).size !== allocationKeys.length) {
    res.status(400).json({ error: "Duplicate payment allocation authorization and service month" });
    return;
  }
  const effectiveMonths = [...new Set(allocationsToPersist.map((allocation) => allocation.serviceMonth))].sort();
  if (allocationsToPersist.length) updates.paymentMonth = effectiveMonths[0];
  const effectiveAllocationAuthorizationIds = [...new Set(allocationsToPersist.map((allocation) => allocation.authorizationId))];
  const effAuthorizationId = effectiveAllocationAuthorizationIds[0] ??
    (("authorizationId" in updates ? updates.authorizationId : before.authorizationId) as string | null);
  const effInvoiceId = ("invoiceId" in updates ? updates.invoiceId : before.invoiceId) as string | null;
  const effVendorId = ("vendorId" in updates ? updates.vendorId : before.vendorId) as string | null;
  const effPaymentMonth = ("paymentMonth" in updates ? updates.paymentMonth : before.paymentMonth) as string | null;
  const beforeKeys = beforeAllocations.map((allocation) =>
    `${allocation.authorizationId}:${allocation.serviceMonth ?? before.paymentMonth ?? before.checkDate.slice(0, 7)}`,
  ).sort();
  const nextKeys = allocationsToPersist.map((allocation) =>
    `${allocation.authorizationId}:${allocation.serviceMonth}`,
  ).sort();
  const allocationPairsChanged = beforeKeys.join("|") !== nextKeys.join("|");
  const dupFieldChanged = allocationPairsChanged ||
    effPaymentMonth !== before.paymentMonth ||
    effAuthorizationId !== before.authorizationId;
  const effectiveDuplicatePairs = allocationsToPersist.length
    ? allocationsToPersist
    : (effAuthorizationId && effPaymentMonth
      ? [{ authorizationId: effAuthorizationId, serviceMonth: effPaymentMonth }]
      : []);
  const runDupCheck = dupFieldChanged && effectiveDuplicatePairs.length > 0;
  const justification = overrideJustification?.trim();
  const effPaymentType = ("paymentType" in updates ? updates.paymentType : before.paymentType) as string;
  const paymentTypeChanged = effPaymentType !== before.paymentType;
  const affectedFeeMonths = [...new Set([
    ...beforeAllocations.map((allocation) => allocation.serviceMonth ?? before.paymentMonth ?? before.checkDate.slice(0, 7)),
    ...(allocationsToPersist.length
      ? allocationsToPersist.map((allocation) => allocation.serviceMonth)
      : [effPaymentMonth].filter((month): month is string => !!month)),
  ])].sort();
  let duplicateBlocked: Awaited<ReturnType<typeof enrichPayments>> | null = null;
  let allocationBlocked = false;
  let relationshipError: string | undefined;
  const { payment } = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    await tx.execute(sql`select id from payments where id = ${id} for update`);
    relationshipError = (await validateParticipantLinks(txDb, effClientId, {
      authorizationId: null,
      invoiceId: effInvoiceId,
      vendorId: effVendorId,
    })).error;
    if (relationshipError) {
      return { payment: null as typeof paymentsTable.$inferSelect | null };
    }
    const incoming = new Map<string, ReturnType<typeof money>>();
    const paymentAllocations = allocationsToPersist;
    for (const allocation of paymentAllocations) {
      incoming.set(allocation.authorizationId, (incoming.get(allocation.authorizationId) ?? money(0)).plus(money(allocation.amount)));
    }
    const effectiveAllocationAuthorizationIdsForInvoice = paymentAllocations.length
      ? paymentAllocations.map((allocation) => allocation.authorizationId)
      : (effAuthorizationId ? [effAuthorizationId] : []);
    relationshipError = (await assertInvoicePayable(txDb, effInvoiceId, incoming, id, effectiveAllocationAuthorizationIdsForInvoice)) ?? undefined;
    if (relationshipError) return { payment: null as typeof paymentsTable.$inferSelect | null };
    if ("amount" in updateData && !allocations) {
      const existingAllocations = await tx.select({ amount: paymentAllocationsTable.amount })
        .from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, id));
      const allocatedTotal = existingAllocations.reduce((sum, row) => sum.plus(money(row.amount)), money(0));
      if (!money(updates.amount as string).equals(allocatedTotal)) {
        relationshipError = "allocations are required when changing amount";
        return { payment: null as typeof paymentsTable.$inferSelect | null };
      }
    }
    if (allocations || legacyMonthMove) {
      for (const allocation of allocationsToPersist) {
        relationshipError = (await validateParticipantLinks(txDb, effClientId, {
          authorizationId: allocation.authorizationId,
          serviceAuthorizationOnly: true,
          invoiceId: null,
          vendorId: effVendorId,
        })).error;
        if (relationshipError) return { payment: null as typeof paymentsTable.$inferSelect | null };
      }
      if (allocations) updates.authorizationId = null;
    }
    if (
      allocations ||
      legacyMonthMove ||
      ("amount" in updateData && String(before.amount) !== String(updates.amount)) ||
      dupFieldChanged
    ) {
      const [allocation] = await tx.select({ id: remittanceAllocationsTable.id })
        .from(remittanceAllocationsTable)
        .where(eq(remittanceAllocationsTable.paymentId, id))
        .limit(1);
      if (allocation) {
        allocationBlocked = true;
        return { payment: null as typeof paymentsTable.$inferSelect | null };
      }
    }
    // Serialize + re-check the duplicate hard stop inside the transaction behind
    // a pg advisory lock so a concurrent write for the same triple can't race
    // past the SELECT-then-UPDATE window.
    if (runDupCheck) {
      for (const allocation of [...effectiveDuplicatePairs].sort((a, b) =>
        `${a.authorizationId}:${a.serviceMonth}`.localeCompare(`${b.authorizationId}:${b.serviceMonth}`),
      )) {
        await lockDuplicatePaymentKey(txDb, {
          clientId: effClientId,
          authorizationId: allocation.authorizationId,
          serviceMonth: allocation.serviceMonth,
        });
      }
      const { isDuplicate, existingPayments } = await checkDuplicatePaymentAllocations(txDb, {
        clientId: effClientId,
        allocations: effectiveDuplicatePairs,
        excludePaymentId: id,
      });
      if (isDuplicate && !(overrideDuplicate && justification)) {
        duplicateBlocked = await enrichPayments(existingPayments);
        return { payment: null as typeof paymentsTable.$inferSelect | null };
      }
    }
    const [p] = await tx
      .update(paymentsTable)
      .set(updates)
      .where(and(eq(paymentsTable.id, id), notDeleted(paymentsTable)))
      .returning();
    if (allocations || legacyMonthMove) {
      await tx.delete(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, id));
      await tx.insert(paymentAllocationsTable).values(allocationsToPersist.map((allocation) => ({
        paymentId: id,
        authorizationId: allocation.authorizationId,
        serviceMonth: allocation.serviceMonth,
        amount: allocation.amount,
      })));
    }
    // Record any accepted duplicate override in the same transaction, keyed to
    // this payment's id, so the audit trail can never diverge from the row.
    if (runDupCheck && overrideDuplicate && justification) {
      await audit(req.user!.id, "override_duplicate_payment", "payment", p.id, justification, txDb);
    }
    if (allocationPairsChanged || effPaymentMonth !== before.paymentMonth || paymentTypeChanged) {
      for (const month of affectedFeeMonths) {
        await reconcileMonthlyFee(p.clientId, month, req.user!.id, txDb);
      }
    }
    await audit(
      req.user!.id,
      "update_payment",
      "payment",
      p.id,
      diffDetail(before, updates, Object.keys(updates)),
      txDb,
    );
    return { payment: p };
  });
  if (!payment) {
    if (relationshipError) {
      res.status(400).json({ error: relationshipError });
      return;
    }
    if (allocationBlocked) {
      res.status(409).json({ error: "Payment allocation lines and payment terms cannot be changed after a remittance allocation" });
      return;
    }
    res.status(409).json({
      error: `A payment already exists for this client, authorization, and month (${effPaymentMonth}). This is a hard stop — override requires a written justification.`,
      code: "duplicate_payment",
      existingPayments: duplicateBlocked ?? [],
    });
    return;
  }
  res.json(UpdatePaymentResponse.parse((await enrichPayments([payment]))[0]));
});

router.delete("/payments/:id", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const deletedAt = new Date();
  const deletedBy = req.user!.id;
  const { payment, financialLinkBlocked } = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from payments where id = ${id} for update`);
    const feeMonths = await tx.select({ serviceMonth: paymentAllocationsTable.serviceMonth })
      .from(paymentAllocationsTable)
      .where(eq(paymentAllocationsTable.paymentId, id));
    const [allocation] = await tx.select({ id: remittanceAllocationsTable.id })
      .from(remittanceAllocationsTable)
      .where(eq(remittanceAllocationsTable.paymentId, id))
      .limit(1);
    const [matchedRemittance] = await tx.select({ id: remittancesTable.id })
      .from(remittancesTable)
      .where(and(eq(remittancesTable.matchedPaymentId, id), notDeleted(remittancesTable)))
      .limit(1);
    if (allocation || matchedRemittance) {
      return { payment: undefined, financialLinkBlocked: true };
    }
    const [p] = await tx
      .update(paymentsTable)
      .set({ isDeleted: true, deletedAt, deletedBy })
      .where(and(eq(paymentsTable.id, id), notDeleted(paymentsTable)))
      .returning();
    if (!p) return { payment: undefined, financialLinkBlocked: false };
    const affectedMonths = [...new Set(
      feeMonths.map((allocation) => allocation.serviceMonth ?? p.paymentMonth ?? p.checkDate.slice(0, 7)),
    )].sort();
    for (const month of affectedMonths) {
      await reconcileMonthlyFee(p.clientId, month, req.user!.id, tx as unknown as typeof db);
    }
    await audit(req.user!.id, "delete_payment", "payment", p.id, `Check ${p.qbCheckNumber} — $${p.amount}`, tx as unknown as typeof db);
    return { payment: p, financialLinkBlocked: false };
  });
  if (!payment) {
    if (financialLinkBlocked) {
      res.status(409).json({ error: "Payment cannot be deleted while it has active remittance links" });
      return;
    }
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  res.json({ ok: true });
});

// --- Remittances ---

// Sentinel thrown inside a row transaction when the source-row fingerprint
// already exists (re-uploaded report row). Throwing aborts the transaction so
// any conditional `remitted` claim made before the conflicting insert is rolled
// back; the caller catches it and reports the row as skipped_duplicate.
type MatchingTarget =
  | { kind: "line"; paymentId: string; paymentAllocationId: string | null }
  | { kind: "fee"; feeId: string }
  | { kind: "ambiguous" };
type AllocatableTarget = Exclude<MatchingTarget, { kind: "ambiguous" }>;

async function allocatedToFee(feeId: string, database: typeof db): Promise<ReturnType<typeof money>> {
  const [row] = await database.select({ total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)` })
    .from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.feeId, feeId));
  return money(row?.total ?? 0);
}

function feeAuthorizationCoversMonth(
  authorization: typeof authorizationsTable.$inferSelect,
  clientId: string,
  feeMonth: string | null,
): boolean {
  if (!feeMonth || authorization.clientId !== clientId || authorization.paymentType !== "fee" ||
    authorization.status === "canceled" || authorization.isDeleted) return false;
  const firstDay = `${feeMonth}-01`;
  return authorization.servicePeriodStart <= firstDay && authorization.servicePeriodEnd >= firstDay;
}

async function linkedFeeAuthorizationIsValid(
  fee: typeof feesTable.$inferSelect,
  clientId: string,
  feeMonth: string | null,
  database: typeof db,
): Promise<boolean> {
  if (!fee.authorizationId) return true;
  const [authorization] = await database.select().from(authorizationsTable)
    .where(and(eq(authorizationsTable.id, fee.authorizationId), notDeleted(authorizationsTable)));
  return !!authorization && feeAuthorizationCoversMonth(authorization, clientId, feeMonth);
}

async function findMatchingTarget(
  args: { clientId: string; authorizationId?: string | null; amount: string; serviceMonth?: string | null },
  database: typeof db = db,
): Promise<MatchingTarget | undefined> {
  const auth = args.authorizationId
    ? (await database.select().from(authorizationsTable)
      .where(and(eq(authorizationsTable.id, args.authorizationId), notDeleted(authorizationsTable))))[0]
    : undefined;
  const feeAuth = auth?.paymentType === "fee";
  if (feeAuth && !feeAuthorizationCoversMonth(auth, args.clientId, args.serviceMonth ?? null)) return undefined;
  if (feeAuth || !args.authorizationId) {
    const feeConditions = [
      eq(feesTable.clientId, args.clientId),
      eq(feesTable.status, "pending"),
      notDeleted(feesTable),
      sql`${feesTable.status} <> 'waived'`,
      ...(args.serviceMonth ? [eq(feesTable.feeMonth, args.serviceMonth)] : [sql`false`]),
      ...(feeAuth ? [or(eq(feesTable.authorizationId, auth!.id), isNull(feesTable.authorizationId))!] : []),
    ];
    const fees = await database.select().from(feesTable).where(and(...feeConditions));
    const eligibleFees: MatchingTarget[] = [];
    for (const fee of fees) {
      if (!(await linkedFeeAuthorizationIsValid(fee, args.clientId, args.serviceMonth ?? null, database))) continue;
      const remaining = money(fee.amount).minus(await allocatedToFee(fee.id, database));
      if (remaining.equals(money(args.amount))) eligibleFees.push({ kind: "fee", feeId: fee.id });
    }
    if (feeAuth) return eligibleFees.length === 1 ? eligibleFees[0] : eligibleFees.length > 1 ? { kind: "ambiguous" } : undefined;
    if (eligibleFees.length) {
      // For an unscoped remittance, payment lines have priority. Fees are only
      // considered after confirming that no line can match.
    }
  }
  if (!feeAuth) {
    const payments = await database.select().from(paymentsTable).where(and(
      eq(paymentsTable.clientId, args.clientId),
      notDeleted(paymentsTable),
    ));
    const lines = payments.length
      ? await database.select().from(paymentAllocationsTable)
        .where(inArray(paymentAllocationsTable.paymentId, payments.map((payment) => payment.id)))
      : [];
    const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
    const candidates: MatchingTarget[] = [];
    for (const line of lines) {
      const payment = paymentById.get(line.paymentId);
      if (!payment) continue;
      if (args.authorizationId && line.authorizationId !== args.authorizationId) continue;
      if (args.serviceMonth && line.serviceMonth !== args.serviceMonth) continue;
      const remaining = money(line.amount).minus(await allocatedToLine(line.id, database));
      if (remaining.equals(money(args.amount))) candidates.push({ kind: "line", paymentId: payment.id, paymentAllocationId: line.id });
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return { kind: "ambiguous" };
    if (args.authorizationId) return undefined;
  }
  if (!args.authorizationId && args.serviceMonth) {
    const fees = await database.select().from(feesTable).where(and(
      eq(feesTable.clientId, args.clientId), eq(feesTable.status, "pending"),
      notDeleted(feesTable), sql`${feesTable.status} <> 'waived'`,
      eq(feesTable.feeMonth, args.serviceMonth),
    ));
    const matches: MatchingTarget[] = [];
    for (const fee of fees) {
      if (!(await linkedFeeAuthorizationIsValid(fee, args.clientId, args.serviceMonth, database))) continue;
      if (money(fee.amount).minus(await allocatedToFee(fee.id, database)).equals(money(args.amount))) {
        matches.push({ kind: "fee", feeId: fee.id });
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return { kind: "ambiguous" };
  }
  return undefined;
}

async function recheckMatchingTarget(
  target: AllocatableTarget,
  args: { clientId: string; authorizationId?: string | null; amount: string; serviceMonth?: string | null },
  database: typeof db,
): Promise<{ target?: AllocatableTarget; ambiguous: boolean }> {
  const current = await findMatchingTarget(args, database);
  if (current?.kind === "ambiguous") return { ambiguous: true };
  const same = current?.kind === target.kind &&
    (target.kind === "line"
      ? current.kind === "line" && current.paymentAllocationId === target.paymentAllocationId && current.paymentId === target.paymentId
      : target.kind === "fee" && current.kind === "fee" && current.feeId === target.feeId);
  return { target: same ? target : undefined, ambiguous: false };
}

async function recomputePaymentRemitted(paymentId: string, database: typeof db): Promise<void> {
  const lines = await database.select().from(paymentAllocationsTable)
    .where(eq(paymentAllocationsTable.paymentId, paymentId));
  let complete: boolean;
  if (lines.length) {
    complete = true;
    for (const line of lines) {
      if ((await allocatedToLine(line.id, database)).lessThan(money(line.amount))) complete = false;
    }
  } else {
    const [payment] = await database.select().from(paymentsTable).where(eq(paymentsTable.id, paymentId));
    const [total] = await database.select({ amount: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)` })
      .from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.paymentId, paymentId));
    complete = !!payment && money(total?.amount).greaterThanOrEqualTo(money(payment.amount));
  }
  await database.update(paymentsTable).set({ remitted: complete }).where(eq(paymentsTable.id, paymentId));
}

async function createTargetAllocation(
  remittanceId: string,
  target: AllocatableTarget,
  amount: string,
  autoMatched: boolean,
  userId: string,
  database: typeof db,
): Promise<boolean> {
  if (target.kind === "fee") {
    const [allocation] = await database.insert(remittanceAllocationsTable).values({
      remittanceId, paymentId: null, amount, autoMatched,
      feeId: target.feeId,
    }).onConflictDoNothing().returning({ id: remittanceAllocationsTable.id });
    if (!allocation) return false;
    await updateFeeCollectionStatus(database, target.feeId, userId, remittanceId);
  } else {
    const [allocation] = await database.insert(remittanceAllocationsTable).values({
      remittanceId, paymentId: target.paymentId, amount, autoMatched,
      paymentAllocationId: target.paymentAllocationId,
    }).onConflictDoNothing().returning({ id: remittanceAllocationsTable.id });
    if (!allocation) return false;
    await recomputePaymentRemitted(target.paymentId, database);
  }
  return true;
}

function authorizationExpectedAmount(auth: typeof authorizationsTable.$inferSelect | null | undefined): string | null {
  if (!auth) return null;
  // A one-time authorization has its explicit one-time amount; otherwise a
  // normal recurring authorization is validated against its monthly amount.
  return auth.oneTimeAmount ?? auth.monthlyAmount ?? null;
}

function reviewForMatch(
  auth: typeof authorizationsTable.$inferSelect | null | undefined,
  amount: string,
  hasCandidate: boolean,
): { reviewReason: string | null; expectedAmount: string | null } {
  const expectedAmount = authorizationExpectedAmount(auth);
  if (expectedAmount && !money(expectedAmount).equals(money(amount))) {
    return { reviewReason: "amount_mismatch", expectedAmount };
  }
  return { reviewReason: hasCandidate ? null : "no_eligible_payment", expectedAmount };
}

async function enrichRemittances(rows: (typeof remittancesTable.$inferSelect)[]) {
  const ids = rows.map((r) => r.id);
  const [clientNames, authNums, allocations] = await Promise.all([
    clientNameMap(rows.map((r) => r.clientId)),
    authNumberMap(rows.map((r) => r.authorizationId)),
    ids.length ? db.select().from(remittanceAllocationsTable).where(inArray(remittanceAllocationsTable.remittanceId, ids)) : [],
  ]);
  const byRemittance = new Map<string, typeof allocations>();
  for (const allocation of allocations) {
    const list = byRemittance.get(allocation.remittanceId) ?? [];
    list.push(allocation);
    byRemittance.set(allocation.remittanceId, list);
  }
  const lineIds = [...new Set(allocations.map((allocation) => allocation.paymentAllocationId).filter((value): value is string => !!value))];
  const feeIds = [...new Set(allocations.map((allocation) => allocation.feeId).filter((value): value is string => !!value))];
  const lineRows = lineIds.length ? await db.select().from(paymentAllocationsTable).where(inArray(paymentAllocationsTable.id, lineIds)) : [];
  const paymentIds = [...new Set(lineRows.map((line) => line.paymentId))];
  const payments = paymentIds.length ? await db.select().from(paymentsTable).where(inArray(paymentsTable.id, paymentIds)) : [];
  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  const lineById = new Map(lineRows.map((line) => [line.id, line]));
  const fees = feeIds.length ? await db.select().from(feesTable).where(inArray(feesTable.id, feeIds)) : [];
  const feeById = new Map(fees.map((fee) => [fee.id, fee]));
  const targetAuthIds = [
    ...lineRows.map((line) => line.authorizationId),
    ...fees.map((fee) => fee.authorizationId).filter((value): value is string => !!value),
  ];
  const targetAuthNums = await authNumberMap(targetAuthIds);
  return rows.map((r) =>
    {
      const remittanceAllocations = byRemittance.get(r.id) ?? [];
      const allocatedAmount = remittanceAllocations.length
        ? remittanceAllocations.reduce((sum, a) => sum.plus(a.amount), money(0))
        : money(r.matchedPaymentId ? r.amount : 0);
      return remittanceJson(r, {
      clientName: clientNames.get(r.clientId),
      authNumber: r.authorizationId ? authNums.get(r.authorizationId) : null,
      allocatedAmount: allocatedAmount.toFixed(2),
      remainingAmount: money(r.amount).minus(allocatedAmount).toFixed(2),
      allocations: remittanceAllocations.map((a) => {
        const paymentAllocationId = a.paymentAllocationId;
        const feeId = a.feeId;
        const line = paymentAllocationId ? lineById.get(paymentAllocationId) : undefined;
        const payment = line ? paymentById.get(line.paymentId) : (a.paymentId ? paymentById.get(a.paymentId) : undefined);
        const fee = feeId ? feeById.get(feeId) : undefined;
        return {
          id: a.id,
          targetKind: fee ? "fee" : "line",
          paymentId: fee ? null : payment?.id ?? a.paymentId,
          paymentAllocationId: paymentAllocationId ?? null,
          feeId: feeId ?? null,
          checkNumber: payment?.qbCheckNumber ?? null,
          serviceMonth: line?.serviceMonth ?? payment?.paymentMonth ?? null,
          feeMonth: fee?.feeMonth ?? null,
          authNumber: line ? targetAuthNums.get(line.authorizationId) ?? null : fee?.authorizationId ? targetAuthNums.get(fee.authorizationId) ?? null : null,
          amount: a.amount,
          autoMatched: a.autoMatched,
          createdAt: a.createdAt?.toISOString() ?? null,
        };
      }),
      });
    },
  );
}

router.get("/remittances", requireAuth, async (req, res): Promise<void> => {
  const query = ListRemittancesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.startDate && query.data.endDate && query.data.startDate > query.data.endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const conditions: SQL[] = [
    notDeleted(remittancesTable),
    // Exclude remittances belonging to soft-deleted clients — mirrors the
    // payments route pattern so a client's remittances vanish the moment the
    // client is soft-deleted, regardless of which query-string filter is used.
    sql`${remittancesTable.clientId} in (select id from clients where is_deleted = false)`,
  ];
  // Role scoping — mirrors the payments/invoices SQL-WHERE pattern:
  // parent/self see only their linked client's remittances; service
  // coordinators only remittances for clients in their caseload; vendors see none.
  const u = req.user!;
  if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    conditions.push(eq(remittancesTable.clientId, u.linkedRecordId ?? ""));
  } else if (u.role === "service_coordinator") {
    conditions.push(
      sql`${remittancesTable.clientId} in (select id from clients where assigned_coordinator_id = ${u.id} and is_deleted = false)`,
    );
  } else if (u.role === "vendor") {
    // Vendors have no visibility into remittances — force an empty result set
    // without a JS-level short circuit so pagination/total stay SQL-driven.
    conditions.push(sql`false`);
  }
  // Query-string filters
  if (query.data.clientId) conditions.push(eq(remittancesTable.clientId, query.data.clientId));
  if (query.data.status) conditions.push(eq(remittancesTable.status, query.data.status));
  if (query.data.remittanceBatchId) conditions.push(eq(remittancesTable.remittanceBatchId, query.data.remittanceBatchId));
  if (query.data.startDate) conditions.push(gte(remittancesTable.remittanceDate, query.data.startDate));
  if (query.data.endDate) conditions.push(lte(remittancesTable.remittanceDate, query.data.endDate));
  // Parse the autoMatched flag from the raw query string. The generated zod
  // schema uses zod.coerce.boolean(), which turns any non-empty string
  // (including "false") into true, so we interpret the literal here instead.
  const rawAutoMatched = req.query.autoMatched;
  if (typeof rawAutoMatched === "string" && (rawAutoMatched === "true" || rawAutoMatched === "false")) {
    conditions.push(eq(remittancesTable.autoMatched, rawAutoMatched === "true"));
  }
  if (query.data.search) {
    const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
    const like = `%${escapeLike(query.data.search)}%`;
    const normalizedSearch = query.data.search.replace(/[$,]/g, "");
    const numericLike = `%${escapeLike(normalizedSearch)}%`;
    conditions.push(
      or(
        sql`${remittancesTable.clientId} in (select id from clients where (first_name || ' ' || last_name) ilike ${like} and is_deleted = false)`,
        ilike(remittancesTable.altaReference, like),
        ilike(remittancesTable.reportReference, like),
        ilike(remittancesTable.remittanceBatchId, like),
        sql`replace(lower(${remittancesTable.status}), '_', ' ') ilike ${like}`,
        sql`case when ${remittancesTable.status} = 'matched' then 'allocated' else 'remaining' end ilike ${like}`,
        sql`replace(lower(${remittancesTable.source}), '_', ' ') ilike ${like}`,
        ilike(remittancesTable.paymentMonth, like),
        ilike(remittancesTable.reviewReason, like),
        sql`case when ${remittancesTable.autoMatched} then 'auto matched' else 'unmatched' end ilike ${like}`,
        sql`to_char(${remittancesTable.remittanceDate}, 'Mon FMDD, YYYY') ilike ${like}`,
        sql`cast(${remittancesTable.remittanceDate} as text) ilike ${like}`,
        normalizedSearch ? sql`cast(${remittancesTable.amount} as text) ilike ${numericLike}` : sql`false`,
        normalizedSearch ? sql`cast(${remittancesTable.expectedAmount} as text) ilike ${numericLike}` : sql`false`,
        normalizedSearch ? sql`cast(coalesce(
          (select sum(ra.amount) from remittance_allocations ra where ra.remittance_id = ${remittancesTable.id}),
          case when ${remittancesTable.matchedPaymentId} is not null then ${remittancesTable.amount} else 0 end
        ) as text) ilike ${numericLike}` : sql`false`,
        normalizedSearch ? sql`cast(${remittancesTable.amount} - coalesce(
          (select sum(ra.amount) from remittance_allocations ra where ra.remittance_id = ${remittancesTable.id}),
          case when ${remittancesTable.matchedPaymentId} is not null then ${remittancesTable.amount} else 0 end
        ) as text) ilike ${numericLike}` : sql`false`,
        sql`${remittancesTable.authorizationId} in (select id from authorizations where auth_number ilike ${like} and is_deleted = false)`,
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
      remittanceDate: sql`${remittancesTable.remittanceDate}`,
      altaReference: sql`lower(${remittancesTable.altaReference})`,
      remittanceBatchId: sql`lower(${remittancesTable.remittanceBatchId})`,
      clientName: sql`lower((select last_name || ', ' || first_name from clients where id = ${remittancesTable.clientId}))`,
      authNumber: sql`lower((select auth_number from authorizations where id = ${remittancesTable.authorizationId}))`,
      amount: sql`${remittancesTable.amount}`,
      status: sql`lower(${remittancesTable.status})`,
      createdAt: sql`${remittancesTable.createdAt}`,
    },
    sql`${remittancesTable.id}`,
    [desc(remittancesTable.createdAt), desc(remittancesTable.id)],
  );
  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(remittancesTable).where(where),
    db
      .select()
      .from(remittancesTable)
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
  ]);
  res.json(ListRemittancesResponse.parse({ items: await enrichRemittances(rows), total }));
});

router.post("/remittances", requirePermission("remittance_entry"), async (req, res): Promise<void> => {
  const parsed = CreateRemittanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const values = { ...parsed.data } as Record<string, unknown>;
  for (const key of ["authorizationId", "altaReference", "paymentMonth", "reportReference"] as const) {
    if (values[key] === "") values[key] = null;
  }
  let relationshipError: string | undefined;
  const remittance = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    const authorizationId = values.authorizationId as string | null;
    const validation = await validateParticipantLinks(txDb, parsed.data.clientId, { authorizationId });
    relationshipError = validation.error;
    if (relationshipError) return null;
    const auth = validation.authorization;
    if (authorizationId && !auth) {
      relationshipError = "authorizationId must reference a non-deleted authorization";
      return null;
    }
    const expected = authorizationExpectedAmount(auth);
    const mismatch = !!(expected && !money(expected).equals(money(parsed.data.amount)));
    const serviceMonth = values.paymentMonth as string | null;
    const candidate = mismatch ? undefined : await findMatchingTarget({
      clientId: parsed.data.clientId,
      authorizationId,
      amount: parsed.data.amount,
      serviceMonth,
    }, txDb);
    let ambiguousMatch = candidate?.kind === "ambiguous";
    let match = candidate?.kind === "ambiguous" ? undefined : candidate;
    if (candidate?.kind === "line") {
      const [locked] = await tx.select().from(paymentsTable)
        .where(and(eq(paymentsTable.id, candidate.paymentId), notDeleted(paymentsTable)))
        .for("update");
      if (!locked || locked.remitted) match = undefined;
      else {
        const checked = await recheckMatchingTarget(candidate, {
          clientId: parsed.data.clientId, authorizationId, amount: parsed.data.amount, serviceMonth,
        }, txDb);
        match = checked.target;
        ambiguousMatch = checked.ambiguous;
      }
    } else if (candidate?.kind === "fee") {
      const [fee] = await tx.select().from(feesTable)
        .where(and(eq(feesTable.id, candidate.feeId), notDeleted(feesTable), eq(feesTable.status, "pending")))
        .for("update");
      if (!fee) match = undefined;
      else {
        if (!fee.authorizationId && authorizationId) {
          await tx.update(feesTable).set({ authorizationId }).where(eq(feesTable.id, fee.id));
        }
        const checked = await recheckMatchingTarget(candidate, {
          clientId: parsed.data.clientId, authorizationId, amount: parsed.data.amount, serviceMonth,
        }, txDb);
        match = checked.target;
        ambiguousMatch = checked.ambiguous;
      }
    }
    const review = reviewForMatch(auth, parsed.data.amount, !!match);
    const matchedPaymentId = match?.kind === "line" ? match.paymentId : null;
    const [created] = await tx.insert(remittancesTable).values({
      ...values, source: "manual", status: match ? "matched" : "received",
      matchedPaymentId, autoMatched: !!match,
      reviewReason: ambiguousMatch ? "ambiguous_match" : review.reviewReason, expectedAmount: review.expectedAmount,
    } as typeof remittancesTable.$inferInsert).returning();
    if (match && !(await createTargetAllocation(created.id, match, created.amount, true, req.user!.id, txDb))) {
      throw new Error("Automatic remittance target was allocated concurrently");
    }
    return created;
  });
  if (!remittance) {
    res.status(400).json({ error: relationshipError! });
    return;
  }
  await audit(req.user!.id, "create_remittance", "remittance", remittance.id, remittance.matchedPaymentId ? "Auto-matched to an eligible payment line" : `No automatic match — ${remittance.reviewReason ?? "flagged for review"}`);
  res.status(201).json(CreateRemittanceResponse.parse((await enrichRemittances([remittance]))[0]));
});

router.post("/remittances/:id/match", requirePermission("remittance_entry"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const body = req.body as Record<string, unknown>;
  const targetKeys = ["paymentAllocationId", "feeId", "paymentId"].filter((key) =>
    typeof body[key] === "string" && (body[key] as string).length > 0,
  );
  if (targetKeys.length !== 1 || typeof body.amount !== "string" || !/^\d+(\.\d{1,2})?$/.test(body.amount)) {
    res.status(400).json({ error: "Provide exactly one allocation target and a valid amount" });
    return;
  }
  const amount = body.amount;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from remittances where id = ${id} for update`);
    const [remittance] = await tx.select().from(remittancesTable).where(eq(remittancesTable.id, id));
    if (!remittance || remittance.isDeleted) return { error: "Remittance not found", status: 404 } as const;
    const allocationAmount = money(amount);
    if (!allocationAmount.isPositive()) return { error: "Allocation amount must be greater than zero", status: 400 } as const;
    const [remittanceTotals] = await tx.select({ total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)` }).from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.remittanceId, remittance.id));
    const remittanceRemaining = money(remittance.amount).minus(remittanceTotals.total);
    if (allocationAmount.greaterThan(remittanceRemaining)) return { error: "Allocation exceeds the remittance remaining balance", status: 409 } as const;

    let target: MatchingTarget;
    if (typeof body.feeId === "string") {
      const [fee] = await tx.select().from(feesTable).where(eq(feesTable.id, body.feeId)).for("update");
      if (!fee || fee.isDeleted || fee.status === "waived") return { error: "Fee is not eligible for remittance", status: 400 } as const;
      if (fee.clientId !== remittance.clientId) return { error: "Fee belongs to a different client", status: 400 } as const;
      if (!remittance.paymentMonth) return { error: "A service month is required to allocate a fee", status: 400 } as const;
      if (fee.feeMonth !== remittance.paymentMonth) return { error: "Fee is for a different month", status: 400 } as const;
      if (remittance.authorizationId && fee.authorizationId && fee.authorizationId !== remittance.authorizationId) return { error: "Fee belongs to a different authorization", status: 400 } as const;
      const feeAuthorizationId = remittance.authorizationId ?? fee.authorizationId;
      if (feeAuthorizationId) {
        const [feeAuthorization] = await tx.select().from(authorizationsTable)
          .where(and(eq(authorizationsTable.id, feeAuthorizationId), notDeleted(authorizationsTable)));
        if (!feeAuthorization || !feeAuthorizationCoversMonth(feeAuthorization, remittance.clientId, remittance.paymentMonth)) {
          return { error: "Fee authorization must be active for this client and service month", status: 400 } as const;
        }
      }
      const feeRemaining = money(fee.amount).minus(await allocatedToFee(fee.id, tx as unknown as typeof db));
      if (allocationAmount.greaterThan(feeRemaining)) return { error: "Allocation exceeds the fee remaining balance", status: 409 } as const;
      if (!fee.authorizationId && remittance.authorizationId) {
        await tx.update(feesTable).set({ authorizationId: remittance.authorizationId }).where(eq(feesTable.id, fee.id));
      }
      target = { kind: "fee", feeId: fee.id };
    } else {
      let line: typeof paymentAllocationsTable.$inferSelect | undefined;
      let legacyPaymentId: string | undefined;
      if (typeof body.paymentAllocationId === "string") {
        [line] = await tx.select().from(paymentAllocationsTable)
          .where(eq(paymentAllocationsTable.id, body.paymentAllocationId));
        if (!line) return { error: "Payment line not found", status: 404 } as const;
      } else {
        legacyPaymentId = body.paymentId as string;
        await tx.execute(sql`select id from payments where id = ${legacyPaymentId} for update`);
        const [legacyPayment] = await tx.select().from(paymentsTable).where(eq(paymentsTable.id, legacyPaymentId));
        if (!legacyPayment || legacyPayment.isDeleted) return { error: "Payment not found", status: 404 } as const;
        const lines = await tx.select().from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, legacyPaymentId));
        const eligible = [];
        for (const candidate of lines) {
          const authMatches = !remittance.authorizationId || candidate.authorizationId === remittance.authorizationId;
          const monthMatches = !remittance.paymentMonth || candidate.serviceMonth === remittance.paymentMonth;
          const remaining = money(candidate.amount).minus(await allocatedToLine(candidate.id, tx as unknown as typeof db));
          if (authMatches && monthMatches && remaining.isPositive()) eligible.push(candidate);
        }
        if (eligible.length !== 1) {
          return { error: "Choose which line of this check was remitted", status: 400 } as const;
        }
        line = eligible[0];
      }
      const paymentId = line?.paymentId ?? legacyPaymentId!;
      await tx.execute(sql`select id from payments where id = ${paymentId} for update`);
      const [payment] = await tx.select().from(paymentsTable).where(eq(paymentsTable.id, paymentId));
      if (!payment || payment.isDeleted) return { error: "Payment not found", status: 404 } as const;
      if (line) {
        [line] = await tx.select().from(paymentAllocationsTable)
          .where(eq(paymentAllocationsTable.id, line.id)).for("update");
        if (!line) return { error: "Payment line not found", status: 404 } as const;
      }
      if (payment.clientId !== remittance.clientId) return { error: "Payment belongs to a different client", status: 400 } as const;
      const [auth] = remittance.authorizationId
        ? await tx.select().from(authorizationsTable).where(eq(authorizationsTable.id, remittance.authorizationId))
        : [];
      if (auth?.paymentType === "fee") return { error: "A fee authorization can only be matched to a fee", status: 400 } as const;
      if (line && remittance.authorizationId && line.authorizationId !== remittance.authorizationId) return { error: "Payment line belongs to a different authorization", status: 400 } as const;
      if (line && remittance.paymentMonth && line.serviceMonth !== remittance.paymentMonth) return { error: "Payment line is for a different service month", status: 400 } as const;
      if (!line && remittance.authorizationId && payment.authorizationId !== remittance.authorizationId) return { error: "Payment belongs to a different authorization", status: 400 } as const;
      if (!line && remittance.paymentMonth && payment.paymentMonth !== remittance.paymentMonth) return { error: "Payment is for a different service month", status: 400 } as const;
      const remaining = line
        ? money(line.amount).minus(await allocatedToLine(line.id, tx as unknown as typeof db))
        : money(0);
      if (allocationAmount.greaterThan(remaining)) return { error: "Allocation exceeds the payment line remaining balance", status: 409 } as const;
      target = { kind: "line", paymentId, paymentAllocationId: line?.id ?? null };
    }
    const inserted = await createTargetAllocation(remittance.id, target, allocationAmount.toFixed(2), false, req.user!.id, tx as unknown as typeof db);
    if (!inserted) return { error: "This remittance is already allocated to that target", status: 409 } as const;
    const [newTotals] = await tx.select({ total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)` })
      .from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.remittanceId, remittance.id));
    const remittanceComplete = money(newTotals.total).greaterThanOrEqualTo(money(remittance.amount));
    const [matched] = await tx.update(remittancesTable)
      .set({ status: remittanceComplete ? "matched" : "received", matchedPaymentId: null, autoMatched: false, reviewReason: remittanceComplete ? null : "partially_allocated", expectedAmount: null })
      .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable)))
      .returning();
    if (!matched) throw new Error("Remittance changed while matching");
    return { remittance: matched, target } as const;
  });
  if ("error" in result) {
    res.status(result.status ?? 409).json({ error: result.error });
    return;
  }
  const { remittance, target } = result;
  await audit(req.user!.id, "match_remittance", "remittance", remittance.id, `Allocated $${amount} to ${target.kind === "fee" ? `fee ${target.feeId}` : `payment line ${target.paymentAllocationId ?? target.paymentId}`}`);
  res.json(MatchRemittanceResponse.parse((await enrichRemittances([remittance]))[0]));
});

// Remittance Report batch import. One uploaded report can cover many
// clients/months; every imported line item shares ONE generated
// remittanceBatchId so staff can see which lines came from the same Alta
// payment. Rows are resolved by UCI (client) and, when present, auth number
// scoped to that client — unresolvable rows are reported as row errors, never
// guessed. After insert, each row runs the SAME auto-match logic as manual
// entry (findMatchingTarget) so imported remittances match Payments like
// manual ones. CSV parsing is isolated in src/lib/altaRemittanceParser.ts.
router.post("/remittances/import", requirePermission("remittance_entry"), async (req, res): Promise<void> => {
  const parsed = ImportAltaRemittancesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const remittanceBatchId = randomUUID();
  const reportReference = parsed.data.reportReference?.trim() || null;

  // A header error means the required Alta report sections weren't found —
  // nothing is imported.
  const { rows: parsedRows, problems: parseProblems, headerError } = parseAltaRemittanceCsv(parsed.data.csvText);
  if (headerError) {
    res.json(
      ImportAltaRemittancesResponse.parse({
        remittanceBatchId,
        parsed: 0,
        imported: 0,
        errored: 0,
        autoMatched: 0,
        needsManualMatch: 0,
        skippedDuplicate: 0,
        headerError,
        parseProblems: [],
        results: [],
      }),
    );
    return;
  }

  // Resolve clients by UCI up front (one query), then authorizations for the
  // resolved clients (one query) so per-row resolution is in-memory.
  const uciNeedles = Array.from(new Set(parsedRows.map((r) => r.uciNumber.trim()).filter(Boolean)));
  const clients = uciNeedles.length
    ? await db.select().from(clientsTable).where(and(inArray(clientsTable.uciNumber, uciNeedles), notDeleted(clientsTable)))
    : [];
  const clientByUci = new Map(clients.map((c) => [c.uciNumber, c] as const));
  const clientIds = clients.map((c) => c.id);
  const auths = clientIds.length
    ? await db.select().from(authorizationsTable).where(and(inArray(authorizationsTable.clientId, clientIds), notDeleted(authorizationsTable)))
    : [];
  // Key authorizations by clientId + authNumber so an auth number is only ever
  // resolved within its own client's scope.
  const authByClientAndNumber = new Map(auths.map((a) => [`${a.clientId}::${a.authNumber}`, a] as const));

  const results: {
    rowNumber: number;
    uciNumber?: string | null;
    outcome: "auto_matched" | "needs_manual_match" | "skipped_duplicate" | "errored";
    message?: string | null;
    remittanceId?: string | null;
    matchedPaymentId?: string | null;
  }[] = [];
  let imported = 0;
  let errored = 0;
  let autoMatched = 0;
  let needsManualMatch = 0;
  let skippedDuplicate = 0;

  for (const row of parsedRows) {
    const uci = row.uciNumber.trim();
    const client = clientByUci.get(uci);
    if (!client) {
      errored++;
      results.push({ rowNumber: row.rowNumber, uciNumber: uci, outcome: "errored", message: `No client found for UCI "${uci}". Row not imported.` });
      continue;
    }
    // Resolve authorization (optional) scoped to this client. A provided but
    // unresolvable auth number is a hard row error — never guess.
    let authorizationId: string | null = null;
    let resolvedAuth: typeof authorizationsTable.$inferSelect | null = null;
    const authNeedle = row.authNumber?.trim();
    if (authNeedle) {
      const auth = authByClientAndNumber.get(`${client.id}::${authNeedle}`);
      if (!auth) {
        errored++;
        results.push({
          rowNumber: row.rowNumber,
          uciNumber: uci,
          outcome: "errored",
          message: `Authorization "${authNeedle}" not found for ${client.firstName} ${client.lastName}. Row not imported.`,
        });
        continue;
      }
      authorizationId = auth.id;
      resolvedAuth = auth;
    }

    const paymentMonth = row.serviceMonth?.trim() || null;
    // Idempotency: fingerprint the normalized source row so a re-uploaded report
    // is detected as a duplicate instead of re-inserted (unique partial index on
    // remittances.sourceRowFingerprint enforces this at the DB level too).
    const fingerprint = altaRowFingerprint({
      uciNumber: row.uciNumber,
      authNumber: row.authNumber,
      serviceMonth: row.serviceMonth,
      amount: row.amount,
      checkNumber: row.checkNumber,
      remittanceDate: row.remittanceDate,
    });

    // Insert the remittance and target allocation in one transaction. The
    // balance guards remain the final concurrency boundary.
    const outcome = await db.transaction(async (tx) => {
      const txDb = tx as unknown as typeof db;
      const expectedAmount = authorizationExpectedAmount(resolvedAuth);
      const amountMismatch = !!(expectedAmount && !money(expectedAmount).equals(money(row.amount)));
      const candidate = amountMismatch
        ? undefined
        : await findMatchingTarget({ clientId: client.id, authorizationId, amount: row.amount, serviceMonth: paymentMonth }, txDb);
      let ambiguousMatch = candidate?.kind === "ambiguous";
      let claimedTarget = candidate?.kind === "ambiguous" ? undefined : candidate;
      if (candidate && candidate.kind !== "ambiguous") {
        if (candidate.kind === "line") {
          const [locked] = await tx.select().from(paymentsTable)
            .where(and(eq(paymentsTable.id, candidate.paymentId), notDeleted(paymentsTable)))
            .for("update");
          if (!locked || (candidate.paymentAllocationId === null && locked.remitted)) claimedTarget = undefined;
          else {
            const checked = await recheckMatchingTarget(candidate, {
              clientId: client.id, authorizationId, amount: row.amount, serviceMonth: paymentMonth,
            }, txDb);
            claimedTarget = checked.target;
            ambiguousMatch = checked.ambiguous;
          }
        } else {
          const [fee] = await tx.select().from(feesTable)
            .where(and(eq(feesTable.id, candidate.feeId), notDeleted(feesTable), eq(feesTable.status, "pending")))
            .for("update");
          if (!fee) claimedTarget = undefined;
          else {
            if (!fee.authorizationId && authorizationId) {
              await tx.update(feesTable).set({ authorizationId }).where(eq(feesTable.id, fee.id));
            }
            const checked = await recheckMatchingTarget(candidate, {
              clientId: client.id, authorizationId, amount: row.amount, serviceMonth: paymentMonth,
            }, txDb);
            claimedTarget = checked.target;
            ambiguousMatch = checked.ambiguous;
          }
        }
      }
      const matchedPaymentId = claimedTarget?.kind === "line" ? claimedTarget.paymentId : null;
      const [r] = await tx
        .insert(remittancesTable)
        .values({
          clientId: client.id,
          authorizationId,
          // The CSV row's check/payment number is the payment reference. The
          // upload's report reference is stored separately from the opaque batch.
          altaReference: row.checkNumber?.trim() ?? null,
          remittanceDate: row.remittanceDate,
          amount: row.amount,
          paymentMonth,
          status: claimedTarget ? "matched" : "received",
          source: "alta_regional",
          matchedPaymentId,
          autoMatched: !!claimedTarget,
          remittanceBatchId,
          reportReference,
          reviewReason: amountMismatch
            ? "amount_mismatch"
            : ambiguousMatch
              ? "ambiguous_match"
            : claimedTarget
              ? null
              : candidate
                ? "already_claimed"
                : "no_eligible_payment",
          expectedAmount,
          sourceRowFingerprint: fingerprint,
        })
        // The only unique constraint that can conflict on this insert is the
        // partial fingerprint index; no target is passed because drizzle can't
        // express a partial-index target cleanly and there is no other unique
        // key on remittances to accidentally swallow.
        .onConflictDoNothing()
        .returning();
      if (!r) {
        throw new DuplicateFingerprint();
      }
      if (claimedTarget && !(await createTargetAllocation(r.id, claimedTarget, r.amount, true, req.user!.id, txDb))) {
        throw new Error("Automatic remittance target was allocated concurrently");
      }
      const [matchPayment] = matchedPaymentId ? await tx.select().from(paymentsTable).where(eq(paymentsTable.id, matchedPaymentId)) : [];
      return { remittance: r, match: claimedTarget, payment: matchPayment };
    }).catch((err) => {
      if (err instanceof DuplicateFingerprint) return "duplicate" as const;
      throw err;
    });

    if (outcome === "duplicate") {
      skippedDuplicate++;
      results.push({ rowNumber: row.rowNumber, uciNumber: uci, outcome: "skipped_duplicate", message: "This report row was already imported (matched by source-row fingerprint). Skipped." });
      continue;
    }
    imported++;
    if (outcome.match) {
      autoMatched++;
      results.push({ rowNumber: row.rowNumber, uciNumber: uci, outcome: "auto_matched", message: outcome.match.kind === "fee" ? "Auto-matched to fee." : `Auto-matched to check ${outcome.payment?.qbCheckNumber ?? "payment"}.`, remittanceId: outcome.remittance.id, matchedPaymentId: outcome.match.kind === "line" ? outcome.match.paymentId : null });
    } else {
      needsManualMatch++;
      results.push({ rowNumber: row.rowNumber, uciNumber: uci, outcome: "needs_manual_match", message: "No automatic match — flagged for manual matching.", remittanceId: outcome.remittance.id });
    }
  }

  await audit(
    req.user!.id,
    "import_remittance_report",
    "remittance",
    undefined,
    `Batch ${remittanceBatchId}${reportReference ? ` (${reportReference})` : ""}: ${parsedRows.length} parsed, ${imported} imported, ${errored} errored, ${autoMatched} auto-matched, ${needsManualMatch} need manual match, ${skippedDuplicate} skipped as duplicate`,
  );
  res.json(
    ImportAltaRemittancesResponse.parse({
      remittanceBatchId,
      parsed: parsedRows.length,
      imported,
      errored,
      autoMatched,
      needsManualMatch,
      skippedDuplicate,
      headerError: null,
      parseProblems,
      results,
    }),
  );
});

router.get("/remittances/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [remittance] = await db
    .select()
    .from(remittancesTable)
    .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable)));
  if (!remittance) {
    res.status(404).json({ error: "Remittance not found" });
    return;
  }
  // Exclude remittances belonging to soft-deleted clients (mirrors GET /remittances).
  const [activeClient] = await db
    .select({ id: clientsTable.id, assignedCoordinatorId: clientsTable.assignedCoordinatorId })
    .from(clientsTable)
    .where(and(eq(clientsTable.id, remittance.clientId), eq(clientsTable.isDeleted, false)));
  if (!activeClient) {
    res.status(404).json({ error: "Remittance not found" });
    return;
  }
  // Per-role ownership, mirroring the GET /remittances list scoping:
  // staff see all; coordinators only remittances for clients in their caseload;
  // parent/self only their linked client's; vendors have no visibility.
  const u = req.user!;
  if (u.role === "vendor") {
    res.status(403).json({ error: "Forbidden" });
    return;
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    if (remittance.clientId !== u.linkedRecordId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  } else if (u.role === "service_coordinator") {
    if (activeClient.assignedCoordinatorId !== u.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }
  res.json(GetRemittanceResponse.parse((await enrichRemittances([remittance]))[0]));
});

router.patch("/remittances/:id", requirePermission("remittance_entry"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateRemittanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updates = { ...parsed.data } as Record<string, unknown>;
  for (const k of ["authorizationId", "altaReference", "paymentMonth"] as const) {
    if (updates[k] === "") updates[k] = null;
  }
  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    await tx.execute(sql`select id from remittances where id = ${id} for update`);
    const [before] = await tx.select().from(remittancesTable).where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable)));
    if (!before) return { error: "Remittance not found", status: 404 } as const;
    const effectiveAuthId = ("authorizationId" in updates ? updates.authorizationId : before.authorizationId) as string | null;
    const validation = await validateParticipantLinks(txDb, before.clientId, { authorizationId: effectiveAuthId });
    if (validation.error) return { error: validation.error, status: 400 } as const;
    const reconciliationChanged = ["authorizationId", "amount", "paymentMonth"].some((key) => key in updates);
    const [allocation] = await tx.select({ id: remittanceAllocationsTable.id }).from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.remittanceId, id)).limit(1);
    if ((before.matchedPaymentId || allocation) && reconciliationChanged) {
      return { error: "Authorization, amount, and service month cannot be changed after matching", status: 409 } as const;
    }
    const auth = validation.authorization ?? null;
    const next = { ...updates } as Record<string, unknown>;
    if (!before.matchedPaymentId && !allocation && reconciliationChanged) {
      const amount = ("amount" in next ? next.amount : before.amount) as string;
      const review = reviewForMatch(auth, amount, false);
      next.reviewReason = review.reviewReason;
      next.expectedAmount = review.expectedAmount;
    }
    let [remittance] = await tx.update(remittancesTable).set(next)
      .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable))).returning();
    if (!before.matchedPaymentId && !allocation && reconciliationChanged) {
      const candidate = await findMatchingTarget({
        clientId: before.clientId,
        authorizationId: effectiveAuthId,
        amount: remittance.amount,
        serviceMonth: remittance.paymentMonth,
      }, txDb);
      let ambiguousMatch = candidate?.kind === "ambiguous";
      let target = candidate?.kind === "ambiguous" ? undefined : candidate;
      if (candidate?.kind === "line") {
        const [locked] = await tx.select().from(paymentsTable)
          .where(and(eq(paymentsTable.id, candidate.paymentId), notDeleted(paymentsTable))).for("update");
        if (!locked || (candidate.paymentAllocationId === null && locked.remitted)) target = undefined;
        else {
          const checked = await recheckMatchingTarget(candidate, {
            clientId: before.clientId, authorizationId: effectiveAuthId,
            amount: remittance.amount, serviceMonth: remittance.paymentMonth,
          }, txDb);
          target = checked.target;
          ambiguousMatch = checked.ambiguous;
        }
      } else if (candidate?.kind === "fee") {
        const [fee] = await tx.select().from(feesTable)
          .where(and(eq(feesTable.id, candidate.feeId), notDeleted(feesTable), eq(feesTable.status, "pending"))).for("update");
        if (!fee) target = undefined;
        else {
          if (!fee.authorizationId && effectiveAuthId) {
            await tx.update(feesTable).set({ authorizationId: effectiveAuthId }).where(eq(feesTable.id, fee.id));
          }
          const checked = await recheckMatchingTarget(candidate, {
            clientId: before.clientId, authorizationId: effectiveAuthId,
            amount: remittance.amount, serviceMonth: remittance.paymentMonth,
          }, txDb);
          target = checked.target;
          ambiguousMatch = checked.ambiguous;
        }
      }
      const review = reviewForMatch(auth, remittance.amount, !!target);
      await tx.update(remittancesTable).set({
        status: target ? "matched" : "received",
        matchedPaymentId: target?.kind === "line" ? target.paymentId : null,
        autoMatched: !!target,
        reviewReason: ambiguousMatch ? "ambiguous_match" : review.reviewReason,
        expectedAmount: review.expectedAmount,
      }).where(eq(remittancesTable.id, remittance.id));
      if (target && !(await createTargetAllocation(remittance.id, target, remittance.amount, true, req.user!.id, txDb))) {
        throw new Error("Automatic remittance target was allocated concurrently");
      }
      [remittance] = await tx.select().from(remittancesTable).where(eq(remittancesTable.id, remittance.id));
    }
    return { before, remittance, updates: next } as const;
  });
  if ("error" in result) {
    res.status(result.status ?? 409).json({ error: result.error });
    return;
  }
  const { before, remittance } = result;
  await audit(
    req.user!.id,
    "update_remittance",
    "remittance",
    remittance.id,
    diffDetail(before, result.updates, Object.keys(result.updates)),
  );
  res.json(UpdateRemittanceResponse.parse((await enrichRemittances([remittance]))[0]));
});

router.delete("/remittances/:id", requirePermission("remittance_entry"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const remittance = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from remittances where id = ${id} for update`);
    const [before] = await tx.select().from(remittancesTable)
      .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable)));
    if (!before) return undefined;

    const allocations = await tx.select().from(remittanceAllocationsTable)
      .where(eq(remittanceAllocationsTable.remittanceId, before.id));
    const paymentIds = [...new Set(allocations.map((allocation) => allocation.paymentId).filter((value): value is string => !!value))].sort();
    const feeIds = [...new Set(allocations.map((allocation) => allocation.feeId).filter((value): value is string => !!value))].sort();
    if (paymentIds.length) {
      await tx.execute(sql`
        select id from payments
        where id in (${sql.join(paymentIds.map((paymentId) => sql`${paymentId}`), sql`, `)})
        order by id
        for update
      `);
    }
    if (feeIds.length) {
      await tx.execute(sql`
        select id from fees
        where id in (${sql.join(feeIds.map((feeId) => sql`${feeId}`), sql`, `)})
        order by id
        for update
      `);
    }
    await tx.delete(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.remittanceId, before.id));
    for (const paymentId of paymentIds) await recomputePaymentRemitted(paymentId, tx as unknown as typeof db);
    for (const feeId of feeIds) await updateFeeCollectionStatus(tx as unknown as typeof db, feeId, req.user!.id, before.id);

    const [row] = await tx.update(remittancesTable)
      .set({ isDeleted: true, deletedAt: new Date(), deletedBy: req.user!.id })
      .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable))).returning();
    return row;
  });
  if (!remittance) {
    res.status(404).json({ error: "Remittance not found" });
    return;
  }
  await audit(req.user!.id, "delete_remittance", "remittance", remittance.id, `$${remittance.amount}`);
  res.json({ ok: true });
});

export default router;
