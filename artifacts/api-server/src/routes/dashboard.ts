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
  if (u.role === "staff") {
    for (const v of missingW9) {
      alerts.push({ kind: "pending_w9", message: `${v.name} does not have a W-9 on file — payments are blocked.`, entityType: "vendor", entityId: v.id });
    }
    for (const r of referrals.filter((r) => r.status === "pending_signature")) {
      alerts.push({ kind: "pending_signature", message: "A referral is waiting on a parent/guardian signature.", entityType: "referral", entityId: r.id });
    }
    for (const r of unmatchedRemits) {
      alerts.push({ kind: "unmatched_remittance", message: `An Alta remittance of $${r.amount} has no matching payment.`, entityType: "remittance", entityId: r.id });
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
        vendorsMissingW9: missingW9.length,
        paymentsThisMonth: paymentsThisMonth.toFixed(2),
        unmatchedRemittances: unmatchedRemits.length,
      },
      alerts: alerts.slice(0, 25),
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
  const isVendorUser = u.role === "vendor" && u.linkedRecordType === "vendor" && !!u.linkedRecordId;
  // Staff see all vendors; a vendor user sees only their own record. Other roles
  // (coordinator/parent/self) have no vendor totals to report — return empty.
  if (u.role !== "staff" && !isVendorUser) {
    res.json(GetVendorPaymentReportResponse.parse([]));
    return;
  }
  const year = query.data.year ?? new Date().getFullYear();
  let [payments, vendors] = await Promise.all([
    db.select().from(paymentsTable).where(notDeleted(paymentsTable)),
    db.select().from(vendorsTable),
  ]);
  if (isVendorUser) {
    payments = payments.filter((p) => p.vendorId === u.linkedRecordId);
    vendors = vendors.filter((v) => v.id === u.linkedRecordId);
  }
  const byVendor = new Map<string, { total: Decimal; count: number }>();
  for (const p of payments) {
    if (!p.vendorId) continue;
    if (!p.checkDate.startsWith(String(year))) continue;
    const cur = byVendor.get(p.vendorId) ?? { total: new Decimal(0), count: 0 };
    cur.total = cur.total.plus(money(p.amount));
    cur.count += 1;
    byVendor.set(p.vendorId, cur);
  }
  const rows = vendors
    .filter((v) => byVendor.has(v.id))
    .map((v) => {
      const agg = byVendor.get(v.id)!;
      return {
        vendorId: v.id,
        vendorName: v.name,
        einOnFile: !!v.ein,
        totalPaid: agg.total.toFixed(2),
        paymentCount: agg.count,
        year,
      };
    })
    .sort((a, b) => money(b.totalPaid).comparedTo(money(a.totalPaid)));
  res.json(GetVendorPaymentReportResponse.parse(rows));
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
  const u = req.user!;
  const conditions: SQL[] = [eq(referralsTable.status, "pending_auth")];
  // Coordinators only see cases in their caseload (clients assigned to them);
  // their explicit coordinatorId filter is ignored in favor of the hard scope.
  if (u.role === "service_coordinator") {
    conditions.push(eq(clientsTable.assignedCoordinatorId, u.id));
  } else if (query.data.coordinatorId) {
    conditions.push(eq(referralsTable.serviceCoordinatorId, query.data.coordinatorId));
  }
  // Client-name search runs in SQL (ilike over `first_name || ' ' || last_name`)
  // via a join, so limit/offset and the count both reflect the filter.
  if (query.data.search) conditions.push(clientNameLike(query.data.search));
  const where = and(...conditions);
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
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
      .orderBy(asc(referralsTable.referralDate), desc(referralsTable.id))
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
  const conditions: SQL[] = [];
  if (query.data.status) conditions.push(eq(referralsTable.status, query.data.status));
  if (query.data.coordinatorId) conditions.push(eq(referralsTable.serviceCoordinatorId, query.data.coordinatorId));
  // Client-name search runs in SQL via the clients join so limit/offset and
  // the count both reflect the filter.
  if (query.data.search) conditions.push(clientNameLike(query.data.search));
  const where = conditions.length ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
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
      .orderBy(desc(referralsTable.createdAt), desc(referralsTable.id))
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
  const docType = query.data.docType;
  const rows: {
    docType: "w9" | "signature" | "auth_pdf";
    entityType: string;
    entityId: string;
    entityName: string;
    description: string;
    clientId: string | null;
    clientName: string | null;
  }[] = [];

  if (!docType || docType === "w9") {
    const vendors = await db
      .select()
      .from(vendorsTable)
      .where(and(eq(vendorsTable.active, true), or(isNull(vendorsTable.w9Status), eq(vendorsTable.w9Status, "pending"), eq(vendorsTable.w9Status, "expired"))!));
    for (const v of vendors) {
      rows.push({
        docType: "w9",
        entityType: "vendor",
        entityId: v.id,
        entityName: v.name,
        description: `No W-9 on file (status: ${v.w9Status}) — payments are blocked.`,
        clientId: null,
        clientName: null,
      });
    }
  }

  if (!docType || docType === "signature") {
    const referrals = await db
      .select()
      .from(referralsTable)
      .where(and(eq(referralsTable.status, "pending_signature"), isNull(referralsTable.parentSignedAt)));
    const clientNames = await clientNameMap(referrals.map((r) => r.clientId));
    for (const r of referrals) {
      rows.push({
        docType: "signature",
        entityType: "referral",
        entityId: r.id,
        entityName: clientNames.get(r.clientId) ?? r.id,
        description: "Waiting on parent/guardian e-signature.",
        clientId: r.clientId,
        clientName: clientNames.get(r.clientId) ?? null,
      });
    }
  }

  if (!docType || docType === "auth_pdf") {
    const auths = await db
      .select()
      .from(authorizationsTable)
      .where(and(notDeleted(authorizationsTable), or(isNull(authorizationsTable.posPdfUrl), eq(authorizationsTable.posPdfUrl, ""))!));
    const [clientNames, vendorNames] = await Promise.all([
      clientNameMap(auths.map((a) => a.clientId)),
      vendorNameMap(auths.map((a) => a.vendorId)),
    ]);
    for (const a of auths) {
      rows.push({
        docType: "auth_pdf",
        entityType: "authorization",
        entityId: a.id,
        entityName: a.authNumber,
        description: `Authorization ${a.authNumber}${a.vendorId ? ` (${vendorNames.get(a.vendorId) ?? "vendor"})` : ""} has no POS PDF attached.`,
        clientId: a.clientId,
        clientName: clientNames.get(a.clientId) ?? null,
      });
    }
  }

  const total = rows.length;
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const items = rows.slice(offset, offset + limit);
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
  const u = req.user!;
  const withinDays = Math.min(Math.max(query.data.withinDays ?? 30, 0), 3650);
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + withinDays * 86400000).toISOString().slice(0, 10);
  const conditions: SQL[] = [
    notDeleted(authorizationsTable),
    gte(authorizationsTable.servicePeriodEnd, today),
    lte(authorizationsTable.servicePeriodEnd, horizon),
  ];
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
  const total = rows.length;
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const items = rows.slice(offset, offset + limit);
  res.json(GetExpiringAuthReportResponse.parse({ items, total }));
});

export default router;
