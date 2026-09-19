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
  MatchRemittanceBody,
  MatchRemittanceResponse,
  ImportAltaRemittancesBody,
  ImportAltaRemittancesResponse,
  AuditMonthlyFeesResponse,
  RepairMonthlyFeesBody,
  RepairMonthlyFeesResponse,
  ReconcileCheckRunBody,
  ReconcileCheckRunResponse,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, requirePermission, audit } from "../lib/auth";
import { paymentJson, remittanceJson, clientNameMap, vendorNameMap, authNumberMap, notDeleted, diffDetail, effectiveAuthStatus } from "../lib/serializers";
import { checkDuplicatePayment, checkDuplicatePaymentAllocations, lockDuplicatePaymentKey } from "../lib/paymentDuplicateCheck";
import { money } from "../lib/money";
import { parseAltaRemittanceCsv, altaRowFingerprint } from "../lib/altaRemittanceParser";
import { altaFmsPaymentRowFingerprint, parseAltaFmsPaymentWorksheet } from "../lib/altaFmsPaymentParser";
import { sortedOrder } from "../lib/sorting";
import { validateParticipantLinks } from "../lib/participantLinks";
import { isValidIsoDate, parseCheckRunCsv, reconcileCheckRun } from "../lib/checkRunReconciliation";

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
  for (const line of lines) {
    const auth = auths.find((candidate) => candidate.id === line.authorizationId);
    if (!auth) return `Cannot pay line ${line.id}: authorization ${line.authorizationId} is missing`;
    const paid = await tx.select({ total: sql<string>`coalesce(sum(${paymentAllocationsTable.amount}), 0)` })
      .from(paymentAllocationsTable)
      .innerJoin(paymentsTable, eq(paymentsTable.id, paymentAllocationsTable.paymentId))
      .where(and(
        eq(paymentAllocationsTable.authorizationId, auth.id),
        notDeleted(paymentsTable),
        ...(excludePaymentId ? [sql`${paymentsTable.id} <> ${excludePaymentId}`] : []),
      ));
    const current = money(paid[0]?.total ?? 0);
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
    const paid = await tx.select({ total: sql<string>`coalesce(sum(${paymentAllocationsTable.amount}), 0)` })
      .from(paymentAllocationsTable)
      .innerJoin(paymentsTable, eq(paymentsTable.id, paymentAllocationsTable.paymentId))
      .where(and(
        eq(paymentAllocationsTable.authorizationId, auth.id),
        notDeleted(paymentsTable),
        ...(excludePaymentId ? [sql`${paymentsTable.id} <> ${excludePaymentId}`] : []),
      ));
    const current = money(paid[0]?.total ?? 0);
    const status = effectiveAuthStatus(auth, current);
    if (status !== "active") return `Allocation authorization ${auth.authNumber} is ${status} for invoice ${invoiceId}`;
    if (current.plus(incoming.get(auth.id) ?? money(0)).greaterThan(money(auth.maxPeriodAmount))) {
      return `Allocation authorization ${auth.authNumber} would exceed its remaining capacity for invoice ${invoiceId}`;
    }
  }
  return null;
}

async function collectFeeForPayment(
  paymentId: string,
  userId: string,
  tx: typeof db,
): Promise<void> {
  const [fee] = await tx
    .update(feesTable)
    .set({ status: "collected" })
    .where(and(
      eq(feesTable.paymentId, paymentId),
      eq(feesTable.status, "pending"),
      notDeleted(feesTable),
    ))
    .returning();
  if (fee) {
    await audit(userId, "collect_fee", "fee", fee.id, `Fee collected when trigger payment ${paymentId} was fully remitted`, tx);
  }
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

async function monthlyFeeAudit(database: typeof db = db, clientIds?: string[]) {
  const paymentConditions = [
    inArray(paymentsTable.paymentType, [...QUALIFYING_FEE_PAYMENT_TYPES]),
    sql`${paymentsTable.source} <> 'historical_import'`,
    sql`${paymentsTable.paymentMonth} is not null`,
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
        feeMonth: paymentsTable.paymentMonth,
        paymentId: paymentsTable.id,
      })
      .from(paymentsTable)
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
    if (!payment.feeMonth) continue;
    const key = `${payment.clientId}:${payment.feeMonth}`;
    const row = months.get(key) ?? {
      clientId: payment.clientId,
      clientName: payment.clientName,
      feeMonth: payment.feeMonth,
      paymentIds: [],
    };
    row.paymentIds.push(payment.paymentId);
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

    const untouched = isUntouchedAutomaticFee(fee);
    const obsoleteRule = fee.ruleApplied !== MONTHLY_FEE_RULE;
    const protectedFee = !untouched;
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
      reason: protectedFee
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

  const qualifyingPayments = await tx
    .select()
    .from(paymentsTable)
    .where(and(
      eq(paymentsTable.clientId, clientId),
      eq(paymentsTable.paymentMonth, paymentMonth),
      inArray(paymentsTable.paymentType, [...QUALIFYING_FEE_PAYMENT_TYPES]),
      sql`${paymentsTable.source} <> 'historical_import'`,
      notDeleted(paymentsTable),
    ))
    .orderBy(paymentsTable.createdAt, paymentsTable.id);

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
    if (activeFee) return "none";
    const trigger = qualifyingPayments[0];
    const [triggerAllocation] = await tx.select({ authorizationId: paymentAllocationsTable.authorizationId })
      .from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, trigger.id)).limit(1);
    const [fee] = await tx
    .insert(feesTable)
    .values({
      clientId,
      feeMonth: paymentMonth,
      paymentId: trigger.id,
      authorizationId: triggerAllocation?.authorizationId ?? null,
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
    activeFee.createdBy === null
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

async function enrichPayments(payments: (typeof paymentsTable.$inferSelect)[]) {
  const ids = payments.map((p) => p.id);
  const [clientNames, vendorNames, authNums, allocationRows, paymentAllocations] = await Promise.all([
    clientNameMap(payments.map((p) => p.clientId)),
    vendorNameMap(payments.map((p) => p.vendorId)),
    authNumberMap(payments.map((p) => p.authorizationId)),
    ids.length ? db.select({
      paymentId: remittanceAllocationsTable.paymentId,
      total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)`,
    }).from(remittanceAllocationsTable).where(inArray(remittanceAllocationsTable.paymentId, ids)).groupBy(remittanceAllocationsTable.paymentId) : [],
    db.select().from(paymentAllocationsTable).where(inArray(paymentAllocationsTable.paymentId, ids)),
  ]);
  const allocationAuthNums = await authNumberMap(paymentAllocations.map((a) => a.authorizationId));
  const allocated = new Map(allocationRows.map((r) => [r.paymentId, money(r.total)]));
  return payments.map((p) =>
    paymentJson(p, {
      clientName: clientNames.get(p.clientId),
      vendorName: p.vendorId ? vendorNames.get(p.vendorId) : null,
      authNumber: p.authorizationId ? authNums.get(p.authorizationId) : null,
      allocatedAmount: (allocated.get(p.id) ?? money(p.remitted ? p.amount : 0)).toFixed(2),
      remainingAmount: money(p.amount).minus(allocated.get(p.id) ?? money(p.remitted ? p.amount : 0)).toFixed(2),
      allocations: paymentAllocations.filter((a) => a.paymentId === p.id).map((a) => ({
        id: a.id,
        authorizationId: a.authorizationId,
        authNumber: allocationAuthNums.get(a.authorizationId) ?? null,
        amount: a.amount,
      })),
    }),
  );
}

router.get("/payments", requireAuth, async (req, res): Promise<void> => {
  const query = ListRemittancesQueryParams.safeParse(req.query);
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
  if (query.data.authorizationId) conditions.push(sql`exists (select 1 from payment_allocations pa_filter where pa_filter.payment_id = ${paymentsTable.id} and pa_filter.authorization_id = ${query.data.authorizationId})`);
  if (query.data.paymentMonth) conditions.push(eq(paymentsTable.paymentMonth, query.data.paymentMonth));
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
  res.json(ListPaymentsResponse.parse({ items: await enrichPayments(payments), total }));
});

router.get("/payments/monthly-fees/audit", requireStaff, async (req, res): Promise<void> => {
  const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
  res.json(AuditMonthlyFeesResponse.parse(await monthlyFeeAudit(db, clientId ? [clientId] : undefined)));
});

router.post("/payments/monthly-fees/repair", requireStaff, async (req, res): Promise<void> => {
  const parsed = UpdateRemittanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
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
    const [remittance] = await tx.update(remittancesTable).set(next)
      .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable))).returning();
    return { before, remittance, updates: next } as const;
  });

  res.json(RepairMonthlyFeesResponse.parse(result));
});

router.post("/payments/check-run/reconcile", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const parsed = UpdateRemittanceBody.safeParse(req.body);
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
  const parsed = UpdateRemittanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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
  // Normalize empty strings from the form to null for optional/nullable FK columns
  const values = { ...parsed.data } as Record<string, unknown>;
  for (const k of ["authorizationId", "vendorId", "invoiceId", "paymentMonth"] as const) {
    if (values[k] === "") values[k] = null;
  }
  // Derive the service month server-side from checkDate (YYYY-MM) when it's
  // missing but a checkDate is present, so the duplicate check can't be skipped
  // simply by omitting paymentMonth. The derived month is persisted on the row.
  const dupClientId = values.clientId as string;
  // Deprecated parent authorization relationship is never written for new rows.
  values.authorizationId = null;
  if ((values.paymentMonth == null || values.paymentMonth === "") && typeof values.checkDate === "string" && values.checkDate.length >= 7) {
    values.paymentMonth = values.checkDate.slice(0, 7);
  }
  const dupPaymentMonth = values.paymentMonth as string | null;

  // Duplicate-payment HARD STOP: no two payments for the same client +
  // authorization + service month without a written override justification.
  // The check only applies when both an authorization and a payment month are
  // present (mirrors invoice validation, which skips the check without an auth);
  // payments genuinely without an authorization skip the check by definition.
  const allocationAuthorizationIds = [...new Set(allocations.map((allocation) => allocation.authorizationId))];
  const runDupCheck = dupFieldChanged && effectiveAllocationAuthorizationIds.length > 0 && !!effPaymentMonth;
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
      for (const authorizationId of allocationAuthorizationIds.sort()) {
        await lockDuplicatePaymentKey(txDb, { clientId: dupClientId, authorizationId, paymentMonth: dupPaymentMonth! });
      }
      const { isDuplicate, existingPayments } = await checkDuplicatePaymentAllocations(txDb, {
        clientId: dupClientId, authorizationIds: allocationAuthorizationIds, paymentMonth: dupPaymentMonth!,
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
      amount: allocation.amount,
    })));
    if (qualifiesForMonthlyFee(p.paymentType)) {
      await reconcileMonthlyFee(p.clientId, p.paymentMonth, req.user!.id, txDb);
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
      error: `A payment already exists for this client, authorization, and month (${dupPaymentMonth}). This is a hard stop — override requires a written justification.`,
      code: "duplicate_payment",
      existingPayments: duplicateBlocked ?? [],
    });
    return;
  }
  res.status(201).json(CreatePaymentResponse.parse((await enrichPayments([payment]))[0]));
});

router.post("/payments/import", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const parsed = UpdateRemittanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const source = parseAltaFmsPaymentWorksheet(parsed.data.worksheetRows);
  if (source.headerError) {
    res.json(ImportAltaFmsPaymentsResponse.parse({ imported: 0, skippedDuplicate: 0, flaggedDuplicate: 0, errored: 0, ignoredNonCheckRows: 0, headerError: source.headerError, parseProblems: [], results: [] }));
    return;
  }
  // Resolve only natural keys present in this workbook. Import history and the
  // participant/authorization tables can grow indefinitely without increasing
  // the preload cost of one monthly file.
  const uciNumbers = [...new Set(source.rows.map((row) => row.uciNumber))];
  const authNumbers = [...new Set(source.rows.map((row) => row.authNumber))];
  const rowFingerprints = [...new Set(source.rows.map(altaFmsPaymentRowFingerprint))];
  const LOOKUP_CHUNK_SIZE = 1_000;
  const chunks = <T>(values: T[], size = LOOKUP_CHUNK_SIZE): T[][] => {
    const result: T[][] = [];
    for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
    return result;
  };
  const clients = uciNeedles.length
    ? await db.select().from(clientsTable).where(and(inArray(clientsTable.uciNumber, uciNeedles), notDeleted(clientsTable)))
    : [];
  for (const uciChunk of chunks(uciNumbers)) {
    clients.push(...await db.select().from(clientsTable).where(and(
      inArray(clientsTable.uciNumber, uciChunk),
      notDeleted(clientsTable),
    )));
  }
  const clientByUci = new Map(clients.map((c) => [c.uciNumber, c] as const));
  const clientIds = clients.map((c) => c.id);
  const auths = clientIds.length
    ? await db.select().from(authorizationsTable).where(and(inArray(authorizationsTable.clientId, clientIds), notDeleted(authorizationsTable)))
    : [];
  // Key authorizations by clientId + authNumber so an auth number is only ever
  // resolved within its own client's scope.
  const authByClientAndNumber = new Map(auths.map((a) => [`${a.clientId}::${a.authNumber}`, a] as const));
  const fingerprints = new Set<string>();
  for (const fingerprintChunk of chunks(rowFingerprints)) {
    const existingFingerprints = await db
      .select({ fingerprint: paymentsTable.sourceRowFingerprint })
      .from(paymentsTable)
      .where(and(
        inArray(paymentsTable.sourceRowFingerprint, fingerprintChunk),
        notDeleted(paymentsTable),
      ));
    for (const row of existingFingerprints) {
      if (row.fingerprint) fingerprints.add(row.fingerprint);
    }
  }
  const results: {
    rowNumber: number;
    uciNumber?: string | null;
    outcome: "auto_matched" | "needs_manual_match" | "skipped_duplicate" | "errored";
    message?: string | null;
    remittanceId?: string | null;
    matchedPaymentId?: string | null;
  }[] = [];
  let imported = 0;
  let skippedDuplicate = 0;
  let flaggedDuplicate = 0;
  let errored = 0;
  for (const problem of source.problems) {
    const rowNumber = Number(problem.match(/^Row (\d+):/)?.[1]);
    if (rowNumber) results.push({ rowNumber, outcome: "errored", message: problem });
  }

  for (const row of source.rows) {
    const fingerprint = altaRowFingerprint({
      uciNumber: row.uciNumber,
      authNumber: row.authNumber,
      serviceMonth: row.serviceMonth,
      amount: row.amount,
      checkNumber: row.checkNumber,
      remittanceDate: row.remittanceDate,
    });
    if (fingerprints.has(fingerprint)) {
      skippedDuplicate++;
      results.push({ rowNumber: row.rowNumber, uciNumber: row.uciNumber, outcome: "skipped_duplicate", message: "This Alta FMS line was already imported (matched by source-row fingerprint)." });
      continue;
    }
    const client = clientByUci.get(uci);
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
    try {
      const transactionResult = await db.transaction(async (tx) => {
        const txDb = tx as unknown as typeof db;
        await lockDuplicatePaymentKey(txDb, {
          clientId: client.id,
          authorizationId: authorization.id,
          paymentMonth: row.serviceMonth,
        });
        const [existingSourceRow] = await tx
          .select({ id: paymentsTable.id })
          .from(paymentsTable)
          .where(eq(paymentsTable.sourceRowFingerprint, fingerprint))
          .limit(1);
        if (existingSourceRow) return { kind: "source_duplicate" as const };

        const duplicate = await checkDuplicatePayment(txDb, {
          clientId: client.id,
          authorizationId: authorization.id,
          paymentMonth: row.serviceMonth,
        });
        if (duplicate.isDuplicate) {
          const existing = duplicate.existingPayments[0];
          await audit(
            req.user!.id,
            "flag_duplicate_payment",
            "payment",
            existing.id,
            `Alta FMS row ${row.rowNumber} held back — check ${row.checkNumber} conflicts with existing check ${existing.qbCheckNumber}.`,
            txDb,
          );
          return { kind: "business_duplicate" as const, existing };
        }

        const [inserted] = await tx.insert(paymentsTable).values({ clientId: client.id, authorizationId: null, qbCheckNumber: row.checkNumber, checkDate: row.checkDate, amount: row.amount, paymentMonth: row.serviceMonth, paymentType: row.paymentType, source: "historical_import", loggedBy: req.user!.id, sourceRowFingerprint: fingerprint } as any).onConflictDoNothing().returning();
        if (!inserted) return { kind: "source_duplicate" as const };
        await tx.insert(paymentAllocationsTable).values({ paymentId: inserted.id, authorizationId: authorization.id, amount: row.amount });
        await audit(req.user!.id, "import_alta_fms_payment", "payment", inserted.id, `Alta FMS historical import — check ${inserted.qbCheckNumber}`, tx as unknown as typeof db);
        return { kind: "imported" as const, payment: inserted };
      });
      if (transactionResult.kind === "source_duplicate") {
        fingerprints.add(fingerprint);
        skippedDuplicate++;
        results.push({ rowNumber: row.rowNumber, uciNumber: row.uciNumber, outcome: "skipped_duplicate", message: "This Alta FMS line was already imported (matched by source-row fingerprint)." });
      } else if (transactionResult.kind === "business_duplicate") {
        flaggedDuplicate++;
        results.push({
          rowNumber: row.rowNumber,
          uciNumber: row.uciNumber,
          outcome: "flagged_duplicate",
          paymentId: transactionResult.existing.id,
          message: `Held back: existing check ${transactionResult.existing.qbCheckNumber} already covers this participant, authorization, and service month.`,
        });
      } else {
        fingerprints.add(fingerprint);
        imported++;
        results.push({ rowNumber: row.rowNumber, uciNumber: row.uciNumber, outcome: "imported", paymentId: transactionResult.payment.id });
      }
    } catch (error) {
      errored++;
      results.push({ rowNumber: row.rowNumber, uciNumber: row.uciNumber, outcome: "errored", message: error instanceof Error ? error.message : "Insert failed." });
    }
  }
  await audit(req.user!.id, "import_alta_fms_payments", "payment", undefined, `${imported} imported, ${skippedDuplicate} source duplicate, ${flaggedDuplicate} business duplicate, ${errored} errored`);
  res.json(ImportAltaFmsPaymentsResponse.parse({ imported, skippedDuplicate, flaggedDuplicate, errored, ignoredNonCheckRows: source.ignoredNonCheckRows, headerError: null, parseProblems: source.problems, results }));
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

router.patch("/remittances/:id", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateRemittanceBody.safeParse(req.body);
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
  const beforeAllocations = await db.select({ authorizationId: paymentAllocationsTable.authorizationId })
    .from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, id));
  const effectiveAllocationAuthorizationIds = allocations
    ? [...new Set(allocations.map((allocation) => allocation.authorizationId))]
    : [...new Set(beforeAllocations.map((allocation) => allocation.authorizationId))];
  const effAuthorizationId = effectiveAllocationAuthorizationIds[0] ??
    (("authorizationId" in updates ? updates.authorizationId : before.authorizationId) as string | null);
  const effInvoiceId = ("invoiceId" in updates ? updates.invoiceId : before.invoiceId) as string | null;
  const effVendorId = ("vendorId" in updates ? updates.vendorId : before.vendorId) as string | null;
  const effPaymentMonth = ("paymentMonth" in updates ? updates.paymentMonth : before.paymentMonth) as string | null;
  const dupFieldChanged = allocations !== undefined ||
    effPaymentMonth !== before.paymentMonth ||
    effAuthorizationId !== before.authorizationId;
  // Re-run the duplicate hard stop only when the patch changes a
  // duplicate-defining field and the resulting triple has both an authorization
  // and a month (mirrors POST /payments). The payment's own row is excluded.
  const runDupCheck = dupFieldChanged && effectiveAllocationAuthorizationIds.length > 0 && !!effPaymentMonth;
  const justification = overrideJustification?.trim();
  const paymentMonthChanged = effPaymentMonth !== before.paymentMonth;
  const effPaymentType = ("paymentType" in updates ? updates.paymentType : before.paymentType) as string;
  const paymentTypeChanged = effPaymentType !== before.paymentType;
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
    const paymentAllocations = allocations ?? await tx.select()
      .from(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, id));
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
    if (allocations) {
      for (const allocation of allocations) {
        relationshipError = (await validateParticipantLinks(txDb, effClientId, {
          authorizationId: allocation.authorizationId,
          invoiceId: null,
          vendorId: effVendorId,
        })).error;
        if (relationshipError) return { payment: null as typeof paymentsTable.$inferSelect | null };
      }
      updates.authorizationId = null;
    }
    if (("amount" in updateData && String(before.amount) !== String(updates.amount)) || dupFieldChanged) {
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
      for (const authorizationId of effectiveAllocationAuthorizationIds.sort()) {
        await lockDuplicatePaymentKey(txDb, { clientId: effClientId, authorizationId, paymentMonth: effPaymentMonth! });
      }
      const { isDuplicate, existingPayments } = await checkDuplicatePaymentAllocations(txDb, {
        clientId: effClientId, authorizationIds: effectiveAllocationAuthorizationIds,
        paymentMonth: effPaymentMonth!, excludePaymentId: id,
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
    if (allocations) {
      await tx.delete(paymentAllocationsTable).where(eq(paymentAllocationsTable.paymentId, id));
      await tx.insert(paymentAllocationsTable).values(allocations.map((allocation) => ({
        paymentId: id,
        authorizationId: allocation.authorizationId,
        amount: allocation.amount,
      })));
    }
    // Record any accepted duplicate override in the same transaction, keyed to
    // this payment's id, so the audit trail can never diverge from the row.
    if (runDupCheck && overrideDuplicate && justification) {
      await audit(req.user!.id, "override_duplicate_payment", "payment", p.id, justification, txDb);
    }
    if (paymentMonthChanged || paymentTypeChanged) {
      const affectedMonths = [...new Set([before.paymentMonth, p.paymentMonth].filter((month): month is string => !!month))].sort();
      for (const month of affectedMonths) {
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
      res.status(409).json({ error: "Amount, authorization, and service month cannot be changed after a remittance allocation" });
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
    await reconcileMonthlyFee(p.clientId, p.paymentMonth, req.user!.id, tx as unknown as typeof db);
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
// Shared auto-match logic (the same rule behind POST /remittances and
// POST /remittances/:id/match): an unremitted payment for the SAME client whose
// amount equals the remittance amount, and — when a service month is provided —
// whose paymentMonth also matches. Extracted so the Alta batch import matches
// imported line items exactly like manually-entered ones (no duplication).
// Pass a `tx` to run inside a transaction. Payments that already have any
// allocation are intentionally excluded: automatic matching is exact/full only,
// while partial payments require an explicit staff allocation.
async function findMatchingPayment(
  args: { clientId: string; authorizationId?: string | null; amount: string; paymentMonth?: string | null },
  database: typeof db = db,
): Promise<typeof paymentsTable.$inferSelect | undefined> {
  const pool = await database
    .select()
    .from(paymentsTable)
    .where(and(
      eq(paymentsTable.clientId, args.clientId),
      eq(paymentsTable.remitted, false),
      notDeleted(paymentsTable),
    ));
  const allocations = await database.select({
    paymentId: paymentAllocationsTable.paymentId,
    authorizationId: paymentAllocationsTable.authorizationId,
    amount: paymentAllocationsTable.amount,
  }).from(paymentAllocationsTable).where(inArray(paymentAllocationsTable.paymentId, pool.map((p) => p.id)));
  const byPayment = new Map<string, typeof allocations>();
  for (const allocation of allocations) byPayment.set(allocation.paymentId, [...(byPayment.get(allocation.paymentId) ?? []), allocation]);
  return pool.find(
    (p) =>
      p.clientId === args.clientId &&
      !p.remitted &&
       (!args.authorizationId || (byPayment.get(p.id)?.some((a) => a.authorizationId === args.authorizationId) ?? p.authorizationId === args.authorizationId)) &&
       money(
         args.authorizationId
           ? (byPayment.get(p.id)?.find((a) => a.authorizationId === args.authorizationId)?.amount ?? p.amount)
           : p.amount,
       ).equals(money(args.amount)) &&
      (!args.paymentMonth || p.paymentMonth === args.paymentMonth),
  );
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
      allocations: remittanceAllocations.map((a) => ({ id: a.id, paymentId: a.paymentId, amount: a.amount, autoMatched: a.autoMatched, createdAt: a.createdAt?.toISOString() ?? null })),
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

router.post("/remittances", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const parsed = UpdateRemittanceBody.safeParse(req.body);
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
    await tx.execute(sql`select id from remittances where id = ${id} for update`);
    const [before] = await tx.select().from(remittancesTable)
      .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable)));
    if (!before) return undefined;

    const allocations = await tx.select().from(remittanceAllocationsTable)
      .where(eq(remittanceAllocationsTable.remittanceId, before.id));
    const paymentIds = [...new Set(allocations.map((allocation) => allocation.paymentId))].sort();
    if (paymentIds.length) {
      await tx.execute(sql`
        select id from payments
        where id in (${sql.join(paymentIds.map((paymentId) => sql`${paymentId}`), sql`, `)})
        order by id
        for update
      `);
    }
    await tx.delete(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.remittanceId, before.id));
    for (const allocation of allocations) {
      const [totals] = await tx.select({ total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)` }).from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.paymentId, allocation.paymentId));
      const [payment] = await tx.select().from(paymentsTable).where(eq(paymentsTable.id, allocation.paymentId));
      if (payment) await tx.update(paymentsTable).set({ remitted: money(totals.total).greaterThanOrEqualTo(payment.amount) }).where(eq(paymentsTable.id, payment.id));
    }

    const [row] = await tx.update(remittancesTable)
      .set({ isDeleted: true, deletedAt: new Date(), deletedBy: req.user!.id })
      .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable))).returning();
    if (row) {
      if (row.matchedPaymentId) {
        await tx.update(paymentsTable).set({ remitted: false })
          .where(and(eq(paymentsTable.id, row.matchedPaymentId), eq(paymentsTable.remitted, true)));
      }
    }
    return row;
  });
  if (!remittance) {
    res.status(400).json({ error: relationshipError! });
    return;
  }
  await audit(req.user!.id, "create_remittance", "remittance", remittance.id, remittance.matchedPaymentId ? "Auto-matched to an eligible payment" : `No automatic match — ${remittance.reviewReason ?? "flagged for review"}`);
  res.status(201).json(CreateRemittanceResponse.parse((await enrichRemittances([remittance]))[0]));
});

router.post("/remittances/:id/match", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateRemittanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
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
    const [remittance] = await tx.update(remittancesTable).set(next)
      .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable))).returning();
    return { before, remittance, updates: next } as const;
  });
  if ("error" in result) {
    res.status(result.status ?? 409).json({ error: result.error });
    return;
  }
  const { remittance, payment } = result;
  await audit(req.user!.id, "match_remittance", "remittance", remittance.id, `Allocated $${parsed.data.amount} to check ${payment.qbCheckNumber}`);
  res.json(MatchRemittanceResponse.parse((await enrichRemittances([remittance]))[0]));
});

// Remittance Report batch import. One uploaded report can cover many
// clients/months; every imported line item shares ONE generated
// remittanceBatchId so staff can see which lines came from the same Alta
// payment. Rows are resolved by UCI (client) and, when present, auth number
// scoped to that client — unresolvable rows are reported as row errors, never
// guessed. After insert, each row runs the SAME auto-match logic as manual
// entry (findMatchingPayment) so imported remittances match Payments like
// manual ones. CSV parsing is isolated in src/lib/altaRemittanceParser.ts.
router.post("/remittances/import", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const parsed = UpdateRemittanceBody.safeParse(req.body);
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

    // Insert the remittance + claim its matched payment atomically so a matched
    // remittance and its payment's `remitted` flag can never diverge, and two
    // concurrent imports can't both claim the same payment. Uses the DB unique
    // index (ON CONFLICT DO NOTHING) so a racing duplicate upload is skipped
    // rather than double-inserted.
    const outcome = await db.transaction(async (tx) => {
      const txDb = tx as unknown as typeof db;
      // Race-safe claim: find a candidate, then CONDITIONALLY flip remitted only
      // if it is still false (RETURNING id). A concurrent import that already
      // claimed it gets no row back and this remittance falls back to
      // needs_manual_match rather than double-matching one payment.
      const expectedAmount = authorizationExpectedAmount(resolvedAuth);
      const amountMismatch = !!(expectedAmount && !money(expectedAmount).equals(money(row.amount)));
      const candidate = amountMismatch
        ? undefined
        : await findMatchingPayment({ clientId: client.id, authorizationId, amount: row.amount, paymentMonth }, txDb);
      let claimedPayment: typeof paymentsTable.$inferSelect | undefined;
      if (candidate) {
        const [locked] = await tx.select().from(paymentsTable)
          .where(and(eq(paymentsTable.id, candidate.id), notDeleted(paymentsTable)))
          .for("update");
        if (locked && !locked.remitted) {
          const [paymentAssigned] = await tx.select({ total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)` })
            .from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.paymentId, locked.id));
          const [authCapacity] = authorizationId ? await tx.select({ total: sql<string>`coalesce(sum(${paymentAllocationsTable.amount}), 0)` })
            .from(paymentAllocationsTable).where(and(
              eq(paymentAllocationsTable.paymentId, locked.id),
              eq(paymentAllocationsTable.authorizationId, authorizationId),
            )) : [{ total: locked.amount }];
          const [authAssigned] = authorizationId ? await tx.select({ total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)` })
            .from(remittanceAllocationsTable)
            .innerJoin(remittancesTable, eq(remittancesTable.id, remittanceAllocationsTable.remittanceId))
            .where(and(
              eq(remittanceAllocationsTable.paymentId, locked.id),
              eq(remittancesTable.authorizationId, authorizationId),
            )) : [{ total: "0" }];
          const requested = money(row.amount);
          const fitsPayment = money(locked.amount).minus(money(paymentAssigned.total)).greaterThanOrEqualTo(requested);
          const fitsAuthorization = money(authCapacity.total).minus(money(authAssigned.total)).greaterThanOrEqualTo(requested);
          if (fitsPayment && fitsAuthorization) claimedPayment = locked;
        }
      }
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
          status: claimedPayment ? "matched" : "received",
          source: "alta_regional",
          matchedPaymentId: claimedPayment?.id ?? null,
          autoMatched: !!claimedPayment,
          remittanceBatchId,
          reportReference,
          reviewReason: amountMismatch
            ? "amount_mismatch"
            : claimedPayment
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
      // No row returned → fingerprint conflict → this exact report row already
      // exists. Nothing was claimed inside this tx (the insert never happened
      // after the conflict), but we may have flipped `remitted`; roll that back
      // by throwing so the whole tx aborts, then re-detect as a duplicate.
      if (!r) {
        // The conditional claim above ran before the conflicting insert; abort
        // the transaction so the (unwanted) remitted flip is undone.
        throw new DuplicateFingerprint();
      }
      if (claimedPayment) {
        await tx.insert(remittanceAllocationsTable).values({
          remittanceId: r.id, paymentId: claimedPayment.id, amount: r.amount, autoMatched: true,
        });
        const [paymentTotal] = await tx.select({ total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)` })
          .from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.paymentId, claimedPayment.id));
        const complete = money(paymentTotal.total).equals(money(claimedPayment.amount));
        await tx.update(paymentsTable).set({ remitted: complete }).where(eq(paymentsTable.id, claimedPayment.id));
        if (complete) await collectFeeForPayment(claimedPayment.id, req.user!.id, txDb);
      }
      return { remittance: r, match: claimedPayment };
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
      results.push({ rowNumber: row.rowNumber, uciNumber: uci, outcome: "auto_matched", message: `Auto-matched to check ${outcome.match.qbCheckNumber}.`, remittanceId: outcome.remittance.id, matchedPaymentId: outcome.match.id });
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

router.patch("/remittances/:id", requirePermission("check_writing"), async (req, res): Promise<void> => {
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
    const [remittance] = await tx.update(remittancesTable).set(next)
      .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable))).returning();
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

router.delete("/remittances/:id", requirePermission("check_writing"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const remittance = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from remittances where id = ${id} for update`);
    const [before] = await tx.select().from(remittancesTable)
      .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable)));
    if (!before) return undefined;

    const allocations = await tx.select().from(remittanceAllocationsTable)
      .where(eq(remittanceAllocationsTable.remittanceId, before.id));
    const paymentIds = [...new Set(allocations.map((allocation) => allocation.paymentId))].sort();
    if (paymentIds.length) {
      await tx.execute(sql`
        select id from payments
        where id in (${sql.join(paymentIds.map((paymentId) => sql`${paymentId}`), sql`, `)})
        order by id
        for update
      `);
    }
    await tx.delete(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.remittanceId, before.id));
    for (const allocation of allocations) {
      const [totals] = await tx.select({ total: sql<string>`coalesce(sum(${remittanceAllocationsTable.amount}), 0)` }).from(remittanceAllocationsTable).where(eq(remittanceAllocationsTable.paymentId, allocation.paymentId));
      const [payment] = await tx.select().from(paymentsTable).where(eq(paymentsTable.id, allocation.paymentId));
      if (payment) await tx.update(paymentsTable).set({ remitted: money(totals.total).greaterThanOrEqualTo(payment.amount) }).where(eq(paymentsTable.id, payment.id));
    }

    const [row] = await tx.update(remittancesTable)
      .set({ isDeleted: true, deletedAt: new Date(), deletedBy: req.user!.id })
      .where(and(eq(remittancesTable.id, id), notDeleted(remittancesTable))).returning();
    if (row) {
      if (row.matchedPaymentId) {
        await tx.update(paymentsTable).set({ remitted: false })
          .where(and(eq(paymentsTable.id, row.matchedPaymentId), eq(paymentsTable.remitted, true)));
      }
    }
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
