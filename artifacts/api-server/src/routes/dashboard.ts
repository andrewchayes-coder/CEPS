import { Router, type IRouter } from "express";
import { desc, asc, eq, and, or, count, isNull, inArray, lte, gte, sql, type SQL } from "drizzle-orm";
import {
  db,
  clientsTable,
  referralsTable,
  authorizationsTable,
  invoicesTable,
  paymentsTable,
  remittancesTable,
  vendorsTable,
  auditLogTable,
  usersTable,
  unmatchedPosDocumentsTable,
} from "@workspace/db";
import {
  GetDashboardSummaryResponse,
  GetVendorPaymentReportQueryParams,
  GetVendorPaymentReportResponse,
  GetPendingAuthReportQueryParams,
  GetPendingAuthReportResponse,
  GetCaseStatusReportQueryParams,
  GetCaseStatusReportResponse,
  GetMissingDocumentsReportQueryParams,
  GetMissingDocumentsReportResponse,
  GetExpiringAuthReportQueryParams,
  GetExpiringAuthReportResponse,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, requireStaffOrCoordinator, iso } from "../lib/auth";
import { userNameMap, clientNameMap, vendorNameMap, authorizationTotalsPaid, effectiveAuthStatus, notDeleted } from "../lib/serializers";
import { money, sumMoney } from "../lib/money";
import Decimal from "decimal.js";
import { sortedOrder, sortRows } from "../lib/sorting";

const router: IRouter = Router();

// Escape LIKE/ILIKE wildcards so a raw search term matches literally.
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// Parameterized ILIKE over the client's full name (`first_name || ' ' || last_name`).
// Callers must join clientsTable. Value is bound (no interpolation) so it is safe.
function clientNameLike(search: string): SQL {
  const pattern = `%${escapeLike(search)}%`;
  return sql`(${clientsTable.firstName} || ' ' || ${clientsTable.lastName}) ILIKE ${pattern}`;
}

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  let [clients, referrals, auths, invoices, payments, remits, vendors] = await Promise.all([
    db.select().from(clientsTable).where(notDeleted(clientsTable)),
    db.select().from(referralsTable),
    db.select().from(authorizationsTable).where(notDeleted(authorizationsTable)),
    db.select().from(invoicesTable).where(notDeleted(invoicesTable)),
    db.select().from(paymentsTable).where(notDeleted(paymentsTable)),
    db.select().from(remittancesTable).where(notDeleted(remittancesTable)),
    db.select().from(vendorsTable),
  ]);
  const unmatchedPosRows = u.role === "staff"
    ? await db.select().from(unmatchedPosDocumentsTable)
        .where(eq(unmatchedPosDocumentsTable.reviewStatus, "pending"))
        .orderBy(asc(unmatchedPosDocumentsTable.createdAt), asc(unmatchedPosDocumentsTable.id))
    : [];

  // Role scoping
  if (u.role === "service_coordinator") {
    const myClients = new Set(clients.filter((c) => c.assignedCoordinatorId === u.id).map((c) => c.id));
    clients = clients.filter((c) => myClients.has(c.id));
    referrals = referrals.filter((r) => r.serviceCoordinatorId === u.id || myClients.has(r.clientId));
    auths = auths.filter((a) => myClients.has(a.clientId));
    invoices = invoices.filter((i) => myClients.has(i.clientId));
    payments = payments.filter((p) => myClients.has(p.clientId));
    remits = remits.filter((r) => myClients.has(r.clientId));
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    clients = clients.filter((c) => c.id === u.linkedRecordId);
    referrals = referrals.filter((r) => r.clientId === u.linkedRecordId);
    auths = auths.filter((a) => a.clientId === u.linkedRecordId);
    invoices = invoices.filter((i) => i.clientId === u.linkedRecordId);
    payments = payments.filter((p) => p.clientId === u.linkedRecordId);
    remits = remits.filter((r) => r.clientId === u.linkedRecordId);
  } else if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    auths = auths.filter((a) => a.vendorId === u.linkedRecordId);
    invoices = invoices.filter((i) => i.vendorId === u.linkedRecordId);
    payments = payments.filter((p) => p.vendorId === u.linkedRecordId);
    vendors = vendors.filter((v) => v.id === u.linkedRecordId);
    clients = [];
    referrals = [];
    remits = [];
  }

  const totals = await authorizationTotalsPaid(auths.map((a) => a.id));
  const withStatus = auths.map((a) => ({ a, status: effectiveAuthStatus(a, totals.get(a.id) ?? 0) }));

  const statusOrder = ["intake", "pending_signature", "pending_auth", "pending_w9", "pending_invoice", "active", "closed"];
  const referralsByStatus = statusOrder.map((status) => ({
    status,
    count: referrals.filter((r) => r.status === status).length,
  }));

  const thisMonth = new Date().toISOString().slice(0, 7);
  const paymentsThisMonth = sumMoney(
    payments
      .filter((p) => (p.paymentMonth ?? p.checkDate.slice(0, 7)) === thisMonth)
      .map((p) => p.amount),
  );

  const missingW9 = vendors.filter((v) => v.active && v.w9Status !== "on_file");
  const unmatchedRemits = remits.filter((r) => r.status !== "matched");
  const today = new Date().toISOString().slice(0, 10);
  let exhaustedActiveAlerts: {
    kind: string;
    message: string;
    entityType: string;
    entityId: string;
  }[] = [];

  const alerts: { kind: string; message: string; entityType?: string | null; entityId?: string | null }[] = [];
  for (const { a, status } of withStatus) {
    if (status !== "active") continue;
    const end = new Date(`${a.servicePeriodEnd}T00:00:00Z`);
    const days = Math.ceil((end.getTime() - Date.now()) / 86400000);
    if (days >= 0 && days <= 30) {
      alerts.push({
        kind: "expiring_authorization",
        message: `Authorization ${a.authNumber} expires in ${days} day${days === 1 ? "" : "s"} (${a.servicePeriodEnd}).`,
        entityType: "authorization",
        entityId: a.id,
      });
    }
  }
  if (u.role === "staff" || u.role === "service_coordinator") {
    if (u.role === "staff") {
    const recentSignedReferrals = referrals
      .filter((r) => r.parentSignedAt && r.parentSignedAt.getTime() >= Date.now() - 7 * 86400000)
      .sort((a, b) => (b.parentSignedAt?.getTime() ?? 0) - (a.parentSignedAt?.getTime() ?? 0));
    const recentSignedClientNames = await clientNameMap(
      recentSignedReferrals.map((r) => r.clientId),
    );
    alerts.unshift(
      ...recentSignedReferrals.map((r) => ({
        kind: "recently_completed",
        message: `${recentSignedClientNames.get(r.clientId) ?? "A participant"} completed their intake agreement.`,
        entityType: "referral",
        entityId: r.id,
      })),
    );
    }
    const familyUpdates = await db
      .select({
        actorName: sql<string>`${usersTable.name}`,
        participantName: sql<string>`${clientsTable.firstName} || ' ' || ${clientsTable.lastName}`,
        detail: auditLogTable.detail,
        entityId: auditLogTable.entityId,
      })
      .from(auditLogTable)
      .innerJoin(usersTable, eq(auditLogTable.userId, usersTable.id))
      .innerJoin(clientsTable, sql`${auditLogTable.entityId}::uuid = ${clientsTable.id}`)
      .where(and(
        eq(auditLogTable.action, "update_client"),
        sql`${usersTable.role} in ('parent_guardian', 'self')`,
        gte(auditLogTable.createdAt, new Date(Date.now() - 7 * 86400000)),
      ))
      .orderBy(desc(auditLogTable.createdAt));
    alerts.unshift(...familyUpdates.map((entry) => ({
      kind: "family_updated_participant",
      message: `${entry.actorName} updated ${entry.participantName}: ${entry.detail ?? ""}`,
      entityType: "client",
      entityId: entry.entityId,
    })));
    if (u.role === "staff") for (const v of missingW9) {
      alerts.push({ kind: "pending_w9", message: `${v.name} does not have a W-9 on file — payments are blocked.`, entityType: "vendor", entityId: v.id });
    }
    if (u.role === "staff") for (const r of referrals.filter((r) => r.status === "pending_signature")) {
      alerts.push({ kind: "pending_signature", message: "A referral is waiting on a parent/guardian signature.", entityType: "referral", entityId: r.id });
    }
    if (u.role === "staff") for (const r of unmatchedRemits) {
      alerts.push({ kind: "unmatched_remittance", message: `An Alta remittance of $${r.amount} has no matching payment.`, entityType: "remittance", entityId: r.id });
    }
    if (u.role === "staff" && unmatchedPosRows.length > 0) {
      alerts.push({
        kind: "unmatched_pos",
        message: `${unmatchedPosRows.length} POS document${unmatchedPosRows.length === 1 ? "" : "s"} awaiting review.`,
        entityType: "unmatched_pos_document",
        entityId: null,
      });
      const suggestedRows = unmatchedPosRows.filter((row) => row.suggestedClientId);
      const suggestedNames = await clientNameMap(suggestedRows.map((row) => row.suggestedClientId));
      for (const row of suggestedRows) {
        alerts.push({
          kind: "unmatched_pos_possible_match",
          message: `POS ${row.authNumber ?? row.sourceFileName} may match ${suggestedNames.get(row.suggestedClientId!) ?? "a participant"} — confirm the suggested match.`,
          entityType: "unmatched_pos_document",
          entityId: row.id,
        });
      }
    }
    if (u.role === "staff") {
      const exhaustedActive = withStatus.filter(
        ({ a, status }) => status === "exhausted" && a.servicePeriodEnd >= today,
      );
      const exhaustedClientNames = await clientNameMap(exhaustedActive.map(({ a }) => a.clientId));
      exhaustedActiveAlerts = exhaustedActive.map(({ a }) => ({
          kind: "authorization_exhausted_active",
          message: `Authorization ${a.authNumber} for ${exhaustedClientNames.get(a.clientId) ?? "an unnamed participant"} has reached its maximum period amount and needs review.`,
          entityType: "authorization",
          entityId: a.id,
      }));
    }
  }

  let recentActivity: {
    id: string;
    userId: string | null;
    userName: string | null;
    action: string;
    entityType: string | null;
    entityId: string | null;
    detail: string | null;
    createdAt: string | null;
  }[] = [];
  if (u.role === "staff") {
    const entries = await db.select().from(auditLogTable).orderBy(desc(auditLogTable.createdAt)).limit(15);
    const names = await userNameMap(entries.map((e) => e.userId));
    recentActivity = entries.map((e) => ({
      id: e.id,
      userId: e.userId,
      userName: e.userId ? (names.get(e.userId) ?? null) : null,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      detail: e.detail,
      createdAt: iso(e.createdAt),
    }));
  }

  res.json(
    GetDashboardSummaryResponse.parse({
      referralsByStatus,
      totals: {
        activeClients: clients.filter((c) => c.status === "active").length,
        activeAuthorizations: withStatus.filter((x) => x.status === "active").length,
        pendingInvoices: invoices.filter((i) => i.status === "pending_review" || i.status === "validated").length,
        needsEntryInvoices: invoices.filter((i) => i.status === "needs_entry").length,
        vendorsMissingW9: missingW9.length,
        paymentsThisMonth: paymentsThisMonth.toFixed(2),
        unmatchedRemittances: unmatchedRemits.length,
        unmatchedPosDocuments: unmatchedPosRows.length,
        pendingPosReview: unmatchedPosRows.length,
        oldestPendingPosDate: unmatchedPosRows[0]?.createdAt.toISOString() ?? null,
        pendingPosWithoutClient: unmatchedPosRows.filter((row) => row.suggestedClientId === null).length,
      },
      // Keep the existing cap for general alerts while ensuring every
      // exhausted-active authorization remains visible for staff review.
      alerts: [
        ...alerts.filter((alert) => alert.kind === "unmatched_pos" || alert.kind === "unmatched_pos_possible_match"),
        ...alerts.filter((alert) => alert.kind !== "unmatched_pos" && alert.kind !== "unmatched_pos_possible_match").slice(0, 25),
        ...exhaustedActiveAlerts,
      ],
      recentActivity,
    }),
  );
});

router.get("/reports/vendor-payments", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const query = GetVendorPaymentReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.startDate && query.data.endDate && query.data.startDate > query.data.endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const allTime = query.data.allTime === "true";
  const isVendorUser = u.role === "vendor" && u.linkedRecordType === "vendor" && !!u.linkedRecordId;
  // Staff see all vendors; a vendor user sees only their own record. Other roles
  // (coordinator/parent/self) have no vendor totals to report — return empty.
  if (u.role !== "staff" && !isVendorUser) {
    res.json(GetVendorPaymentReportResponse.parse([]));
    return;
  }
  const year = query.data.year ?? new Date().getFullYear();
  const conditions: SQL[] = [notDeleted(paymentsTable), sql`${paymentsTable.vendorId} is not null`, notDeleted(clientsTable)];
  if (isVendorUser) conditions.push(eq(paymentsTable.vendorId, u.linkedRecordId!));
  if (query.data.vendorId) conditions.push(eq(paymentsTable.vendorId, query.data.vendorId));
  if (query.data.clientId) conditions.push(eq(paymentsTable.clientId, query.data.clientId));
  if (query.data.coordinatorId) conditions.push(eq(clientsTable.assignedCoordinatorId, query.data.coordinatorId));
  if (query.data.startDate) conditions.push(gte(paymentsTable.checkDate, query.data.startDate));
  if (query.data.endDate) conditions.push(lte(paymentsTable.checkDate, query.data.endDate));
  if (!allTime && !query.data.startDate && !query.data.endDate) {
    conditions.push(sql`extract(year from ${paymentsTable.checkDate}::date) = ${year}`);
  }
  const rows = await db
    .select({
      vendorId: vendorsTable.id,
      vendorName: vendorsTable.name,
      ein: vendorsTable.ein,
      totalPaid: sql<string>`coalesce(sum(${paymentsTable.amount}), 0)`,
      paymentCount: count(paymentsTable.id),
    })
    .from(paymentsTable)
    .innerJoin(vendorsTable, eq(paymentsTable.vendorId, vendorsTable.id))
    .innerJoin(clientsTable, eq(paymentsTable.clientId, clientsTable.id))
    .where(and(...conditions))
    .groupBy(vendorsTable.id, vendorsTable.name, vendorsTable.ein)
    .orderBy(desc(sql`sum(${paymentsTable.amount})`));
  res.json(GetVendorPaymentReportResponse.parse(rows.map((row) => ({
    vendorId: row.vendorId, vendorName: row.vendorName, einOnFile: !!row.ein,
    totalPaid: money(row.totalPaid).toFixed(2), paymentCount: row.paymentCount, year,
  }))));
});

// "Pending Authorization Tracker" — referrals/cases waiting on POS authorization
// from Alta. Uses the SQL-WHERE + {items,total} pagination pattern. Staff, and
// service coordinators scoped to their own caseload (clients assigned to them).
router.get("/reports/pending-authorizations", requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const query = GetPendingAuthReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.startDate && query.data.endDate && query.data.startDate > query.data.endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const u = req.user!;
  const conditions: SQL[] = [eq(referralsTable.status, "pending_auth")];
  // Coordinators only see cases in their caseload (clients assigned to them);
  // their explicit coordinatorId filter is ignored in favor of the hard scope.
  if (u.role === "service_coordinator") {
    conditions.push(eq(clientsTable.assignedCoordinatorId, u.id));
  } else if (query.data.coordinatorId) {
    conditions.push(eq(referralsTable.serviceCoordinatorId, query.data.coordinatorId));
  }
  if (query.data.clientId) conditions.push(eq(referralsTable.clientId, query.data.clientId));
  if (query.data.startDate) conditions.push(gte(referralsTable.referralDate, query.data.startDate));
  if (query.data.endDate) conditions.push(lte(referralsTable.referralDate, query.data.endDate));
  // Client-name search runs in SQL (ilike over `first_name || ' ' || last_name`)
  // via a join, so limit/offset and the count both reflect the filter.
  if (query.data.search) conditions.push(clientNameLike(query.data.search));
  const where = and(...conditions);
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const order = sortedOrder(
    query.data.sortBy,
    query.data.sortDirection,
    {
      clientName: sql`lower(${clientsTable.lastName} || ', ' || ${clientsTable.firstName})`,
      referralDate: sql`${referralsTable.referralDate}`,
      daysWaiting: sql`(current_date - ${referralsTable.referralDate})`,
      coordinatorName: sql`lower((select name from users where id = ${referralsTable.serviceCoordinatorId}))`,
    },
    sql`${referralsTable.id}`,
    [asc(referralsTable.referralDate), desc(referralsTable.id)],
  );
  const [[{ total }], referrals] = await Promise.all([
    db
      .select({ total: count() })
      .from(referralsTable)
      .innerJoin(clientsTable, eq(referralsTable.clientId, clientsTable.id))
      .where(where),
    db
      .select({ r: referralsTable })
      .from(referralsTable)
      .innerJoin(clientsTable, eq(referralsTable.clientId, clientsTable.id))
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset)
      .then((rows) => rows.map((row) => row.r)),
  ]);
  const [clientNames, coordNames] = await Promise.all([
    clientNameMap(referrals.map((r) => r.clientId)),
    userNameMap(referrals.map((r) => r.serviceCoordinatorId)),
  ]);
  const today = Date.now();
  const items = referrals.map((r) => {
    const start = new Date(`${r.referralDate}T00:00:00Z`).getTime();
    const daysWaiting = Math.max(0, Math.floor((today - start) / 86400000));
    return {
      referralId: r.id,
      clientId: r.clientId,
      clientName: clientNames.get(r.clientId) ?? null,
      referralDate: r.referralDate,
      daysWaiting,
      coordinatorId: r.serviceCoordinatorId,
      coordinatorName: r.serviceCoordinatorId ? (coordNames.get(r.serviceCoordinatorId) ?? null) : null,
    };
  });
  res.json(GetPendingAuthReportResponse.parse({ items, total }));
});

// "Program-Level Case Status Overview" — cases broken out by status stage as a
// list. SQL-WHERE + {items,total} pagination. Staff only.
router.get("/reports/case-status", requireStaff, async (req, res): Promise<void> => {
  const query = GetCaseStatusReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.startDate && query.data.endDate && query.data.startDate > query.data.endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const conditions: SQL[] = [];
  if (query.data.status) conditions.push(eq(referralsTable.status, query.data.status));
  if (query.data.coordinatorId) conditions.push(eq(referralsTable.serviceCoordinatorId, query.data.coordinatorId));
  if (query.data.clientId) conditions.push(eq(referralsTable.clientId, query.data.clientId));
  if (query.data.startDate) conditions.push(gte(referralsTable.referralDate, query.data.startDate));
  if (query.data.endDate) conditions.push(lte(referralsTable.referralDate, query.data.endDate));
  // Client-name search runs in SQL via the clients join so limit/offset and
  // the count both reflect the filter.
  if (query.data.search) conditions.push(clientNameLike(query.data.search));
  const where = conditions.length ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const order = sortedOrder(
    query.data.sortBy,
    query.data.sortDirection,
    {
      clientName: sql`lower(${clientsTable.lastName} || ', ' || ${clientsTable.firstName})`,
      status: sql`lower(${referralsTable.status})`,
      referralDate: sql`${referralsTable.referralDate}`,
      coordinatorName: sql`lower((select name from users where id = ${referralsTable.serviceCoordinatorId}))`,
      createdAt: sql`${referralsTable.createdAt}`,
    },
    sql`${referralsTable.id}`,
    [desc(referralsTable.createdAt), desc(referralsTable.id)],
  );
  const [[{ total }], referrals] = await Promise.all([
    db
      .select({ total: count() })
      .from(referralsTable)
      .innerJoin(clientsTable, eq(referralsTable.clientId, clientsTable.id))
      .where(where),
    db
      .select({ r: referralsTable })
      .from(referralsTable)
      .innerJoin(clientsTable, eq(referralsTable.clientId, clientsTable.id))
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset)
      .then((rows) => rows.map((row) => row.r)),
  ]);
  const [clientNames, coordNames] = await Promise.all([
    clientNameMap(referrals.map((r) => r.clientId)),
    userNameMap(referrals.map((r) => r.serviceCoordinatorId)),
  ]);
  const items = referrals.map((r) => ({
    referralId: r.id,
    clientId: r.clientId,
    clientName: clientNames.get(r.clientId) ?? null,
    status: r.status,
    referralDate: r.referralDate,
    coordinatorId: r.serviceCoordinatorId,
    coordinatorName: r.serviceCoordinatorId ? (coordNames.get(r.serviceCoordinatorId) ?? null) : null,
    createdAt: iso(r.createdAt),
  }));
  res.json(GetCaseStatusReportResponse.parse({ items, total }));
});

// "Missing Document Alerts" — no W-9 (vendors), no parent signature (referrals),
// no auth PDF (authorizations). Assembled across tables, filterable by docType,
// then paginated in-memory over the combined set. Staff only.
router.get("/reports/missing-documents", requireStaff, async (req, res): Promise<void> => {
  const query = GetMissingDocumentsReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.startDate && query.data.endDate && query.data.startDate > query.data.endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const docType = query.data.docType ?? null;
  const clientId = query.data.clientId ?? null;
  const coordinatorId = query.data.coordinatorId ?? null;
  const startDate = query.data.startDate ?? null;
  const endDate = query.data.endDate ?? null;
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  // One SQL relation guarantees filters apply before the global count and page.
  // Values are bound; only this fixed whitelist can affect ORDER BY.
  const alerts = sql`
    with alerts as (
      select 'w9'::text doc_type, 'vendor'::text entity_type, v.id::text entity_id, v.name entity_name,
        ('No W-9 on file (status: ' || v.w9_status || ') — payments are blocked.') description,
        null::text client_id, null::text client_name
      from vendors v
      where (${docType}::text is null or ${docType} = 'w9') and ${clientId}::text is null and ${coordinatorId}::text is null
        and v.active and (v.w9_status is null or v.w9_status in ('pending', 'expired'))
        and (${startDate}::text is null or v.created_at >= ${startDate}::date)
        and (${endDate}::text is null or v.created_at < (${endDate}::date + interval '1 day'))
      union all
      select 'signature', 'referral', r.id::text, coalesce(c.first_name || ' ' || c.last_name, r.id::text),
        'Waiting on parent/guardian e-signature.', r.client_id::text, c.first_name || ' ' || c.last_name
      from referrals r join clients c on c.id = r.client_id
      where (${docType}::text is null or ${docType} = 'signature') and r.status = 'pending_signature' and r.parent_signed_at is null
        and (${clientId}::text is null or r.client_id = ${clientId}::uuid)
        and (${coordinatorId}::text is null or c.assigned_coordinator_id = ${coordinatorId}::uuid)
        and (${startDate}::text is null or r.referral_date >= ${startDate}::date) and (${endDate}::text is null or r.referral_date <= ${endDate}::date)
      union all
      select 'auth_pdf', 'authorization', a.id::text, a.auth_number,
        ('Authorization ' || a.auth_number || coalesce(' (' || v.name || ')', '') || ' has no POS PDF attached.'),
        a.client_id::text, c.first_name || ' ' || c.last_name
      from authorizations a join clients c on c.id = a.client_id left join vendors v on v.id = a.vendor_id
      where (${docType}::text is null or ${docType} = 'auth_pdf') and not a.is_deleted and (a.pos_pdf_url is null or a.pos_pdf_url = '')
        and (${clientId}::text is null or a.client_id = ${clientId}::uuid)
        and (${coordinatorId}::text is null or c.assigned_coordinator_id = ${coordinatorId}::uuid)
        and (${startDate}::text is null or coalesce(a.received_date, a.service_period_start) >= ${startDate}::date)
        and (${endDate}::text is null or coalesce(a.received_date, a.service_period_start) <= ${endDate}::date)
    )`;
  const sortColumn = { docType: sql`doc_type`, entityType: sql`entity_type`, entityName: sql`entity_name`, description: sql`description`, clientName: sql`client_name` }[query.data.sortBy ?? "docType"]!;
  const direction = query.data.sortDirection === "desc" ? sql`desc` : sql`asc`;
  const [countResult, pageResult] = await Promise.all([
    db.execute(sql`${alerts} select count(*)::int total from alerts`),
    db.execute(sql`${alerts} select doc_type "docType", entity_type "entityType", entity_id "entityId", entity_name "entityName", description, client_id "clientId", client_name "clientName" from alerts order by ${sortColumn} ${direction}, entity_type, entity_id limit ${limit} offset ${offset}`),
  ]);
  const total = Number((countResult.rows[0] as { total: number }).total);
  const items = pageResult.rows;
  res.json(GetMissingDocumentsReportResponse.parse({ items, total }));
});

// "Expiring Authorization Alerts" — active authorizations whose service period
// ends within `withinDays` (default 30). Date window filtered in SQL; effective
// status computed with payment totals so exhausted/expired are excluded. Staff only.
router.get("/reports/expiring-authorizations", requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const query = GetExpiringAuthReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.startDate && query.data.endDate && query.data.startDate > query.data.endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const u = req.user!;
  const withinDays = Math.min(Math.max(query.data.withinDays ?? 30, 0), 3650);
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + withinDays * 86400000).toISOString().slice(0, 10);
  const conditions: SQL[] = [notDeleted(authorizationsTable)];
  if (query.data.startDate || query.data.endDate) {
    if (query.data.startDate) conditions.push(gte(authorizationsTable.servicePeriodEnd, query.data.startDate));
    if (query.data.endDate) conditions.push(lte(authorizationsTable.servicePeriodEnd, query.data.endDate));
  } else {
    conditions.push(gte(authorizationsTable.servicePeriodEnd, today), lte(authorizationsTable.servicePeriodEnd, horizon));
  }
  if (query.data.clientId) conditions.push(eq(authorizationsTable.clientId, query.data.clientId));
  // Coordinators only see authorizations for clients in their caseload.
  if (u.role === "service_coordinator") {
    const myClients = await db
      .select({ id: clientsTable.id })
      .from(clientsTable)
      .where(and(eq(clientsTable.assignedCoordinatorId, u.id), notDeleted(clientsTable)));
    const ids = myClients.map((c) => c.id);
    if (ids.length === 0) {
      res.json(GetExpiringAuthReportResponse.parse({ items: [], total: 0 }));
      return;
    }
    conditions.push(inArray(authorizationsTable.clientId, ids));
  } else if (query.data.coordinatorId) {
    conditions.push(sql`${authorizationsTable.clientId} in (select id from clients where assigned_coordinator_id = ${query.data.coordinatorId} and is_deleted = false)`);
  }
  const where = and(...conditions);
  const auths = await db
    .select()
    .from(authorizationsTable)
    .where(where)
    .orderBy(asc(authorizationsTable.servicePeriodEnd), asc(authorizationsTable.id));
  const totals = await authorizationTotalsPaid(auths.map((a) => a.id));
  // Only truly active authorizations (not pending/exhausted) count as "expiring".
  const active = auths.filter((a) => effectiveAuthStatus(a, totals.get(a.id) ?? 0) === "active");
  const [clientNames, vendorNames] = await Promise.all([
    clientNameMap(active.map((a) => a.clientId)),
    vendorNameMap(active.map((a) => a.vendorId)),
  ]);
  const now = Date.now();
  const rows = active.map((a) => {
    const end = new Date(`${a.servicePeriodEnd}T00:00:00Z`).getTime();
    return {
      authorizationId: a.id,
      authNumber: a.authNumber,
      clientId: a.clientId,
      clientName: clientNames.get(a.clientId) ?? null,
      vendorId: a.vendorId,
      vendorName: a.vendorId ? (vendorNames.get(a.vendorId) ?? null) : null,
      serviceCode: a.serviceCode,
      servicePeriodEnd: a.servicePeriodEnd,
      daysUntilExpiry: Math.ceil((end - now) / 86400000),
      maxPeriodAmount: a.maxPeriodAmount,
    };
  });
  const orderedRows = sortRows(
    rows,
    query.data.sortBy,
    query.data.sortDirection,
    (row, key) => {
      const raw = row[key as keyof typeof row];
      return key === "maxPeriodAmount" ? Number(raw) : raw as string | number | null;
    },
    (row) => row.authorizationId,
  );
  const total = orderedRows.length;
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const items = orderedRows.slice(offset, offset + limit);
  res.json(GetExpiringAuthReportResponse.parse({ items, total }));
});

export default router;
