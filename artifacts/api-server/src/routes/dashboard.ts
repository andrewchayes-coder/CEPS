import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
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
} from "@workspace/api-zod";
import { requireAuth, requireStaff, iso } from "../lib/auth";
import { userNameMap, authorizationTotalsPaid, effectiveAuthStatus } from "../lib/serializers";

const router: IRouter = Router();

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  let [clients, referrals, auths, invoices, payments, remits, vendors] = await Promise.all([
    db.select().from(clientsTable),
    db.select().from(referralsTable),
    db.select().from(authorizationsTable),
    db.select().from(invoicesTable),
    db.select().from(paymentsTable),
    db.select().from(remittancesTable),
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
  const paymentsThisMonth = payments
    .filter((p) => (p.paymentMonth ?? p.checkDate.slice(0, 7)) === thisMonth)
    .reduce((sum, p) => sum + Number(p.amount), 0);

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

router.get("/reports/vendor-payments", requireStaff, async (req, res): Promise<void> => {
  const query = GetVendorPaymentReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const year = query.data.year ?? new Date().getFullYear();
  const [payments, vendors] = await Promise.all([
    db.select().from(paymentsTable),
    db.select().from(vendorsTable),
  ]);
  const byVendor = new Map<string, { total: number; count: number }>();
  for (const p of payments) {
    if (!p.vendorId) continue;
    if (!p.checkDate.startsWith(String(year))) continue;
    const cur = byVendor.get(p.vendorId) ?? { total: 0, count: 0 };
    cur.total += Number(p.amount);
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
    .sort((a, b) => Number(b.totalPaid) - Number(a.totalPaid));
  res.json(GetVendorPaymentReportResponse.parse(rows));
});

export default router;
