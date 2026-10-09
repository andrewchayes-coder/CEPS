import { inArray, eq, and, sql, type Column, type SQL } from "drizzle-orm";
import Decimal from "decimal.js";
import { money } from "./money";
import {
  db,
  clientsTable,
  vendorsTable,
  usersTable,
  authorizationsTable,
  feesTable,
  paymentsTable,
  paymentAllocationsTable,
  type Client,
  type Vendor,
  type Referral,
  type Authorization,
  type Invoice,
  type Payment,
  type Remittance,
  type Fee,
  type User,
} from "@workspace/db";
import { iso } from "./auth";

// Soft-delete guard: `<table>.is_deleted = false`. Works for any table that has
// the isDeleted/deletedAt/deletedBy columns. Passed directly to `.where(...)`,
// or combined with `and(...)`.
export function notDeleted(table: { isDeleted: Column }): SQL {
  return eq(table.isDeleted, false);
}

// Build an audit detail string describing which fields changed, as JSON of
// { field: [before, after] } — used for edit audit trails.
export function diffDetail(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): string | undefined {
  const changes: Record<string, [unknown, unknown]> = {};
  for (const f of fields) {
    if (!(f in after)) continue;
    const b = before[f] ?? null;
    const a = after[f] ?? null;
    if (String(b) !== String(a)) changes[f] = [b, a];
  }
  const keys = Object.keys(changes);
  if (keys.length === 0) return undefined;
  return JSON.stringify(changes);
}

export async function clientNameMap(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: clientsTable.id, firstName: clientsTable.firstName, lastName: clientsTable.lastName })
    .from(clientsTable)
    .where(and(inArray(clientsTable.id, unique), notDeleted(clientsTable)));
  return new Map(rows.map((r) => [r.id, `${r.firstName} ${r.lastName}`]));
}

export async function vendorNameMap(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: vendorsTable.id, name: vendorsTable.name })
    .from(vendorsTable)
    .where(inArray(vendorsTable.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function userNameMap(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(inArray(usersTable.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function authNumberMap(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: authorizationsTable.id, authNumber: authorizationsTable.authNumber })
    .from(authorizationsTable)
    .where(and(inArray(authorizationsTable.id, unique), notDeleted(authorizationsTable)));
  return new Map(rows.map((r) => [r.id, r.authNumber]));
}

export async function userContactMap(
  ids: (string | null)[],
): Promise<Map<string, { name: string; email: string; phone: string | null }>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, phone: usersTable.phone })
    .from(usersTable)
    .where(inArray(usersTable.id, unique));
  return new Map(rows.map((r) => [r.id, { name: r.name, email: r.email, phone: r.phone }]));
}

export function clientJson(
  c: Client,
  coordinatorName?: string | null,
  coordinatorContact?: { email: string; phone: string | null } | null,
) {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    dateOfBirth: c.dateOfBirth,
    uciNumber: c.uciNumber,
    address: c.address,
    phone: c.phone,
    email: c.email,
    status: c.status,
    regionalCenter: c.regionalCenter,
    preferredLanguage: c.preferredLanguage,
    assignedCoordinatorId: c.assignedCoordinatorId,
    assignedCoordinatorName: coordinatorName ?? null,
    assignedCoordinatorEmail: coordinatorContact?.email ?? null,
    assignedCoordinatorPhone: coordinatorContact?.phone ?? null,
    isMinor: c.isMinor,
    familyRepName: c.familyRepName,
    familyRepPhone: c.familyRepPhone,
    familyRepEmail: c.familyRepEmail,
    familyRepAddress: c.familyRepAddress,
    createdAt: iso(c.createdAt),
  };
}

export function referralJson(
  r: Referral,
  clientName?: string | null,
  coordinatorName?: string | null,
  clientIsMinor?: boolean | null,
  recipientEmails?: { participant: string | null; familyRep: string | null } | null,
) {
  return {
    id: r.id,
    clientId: r.clientId,
    clientName: clientName ?? null,
    clientIsMinor: clientIsMinor ?? null,
    participantEmail: recipientEmails?.participant ?? null,
    familyRepEmail: recipientEmails?.familyRep ?? null,
    serviceCoordinatorId: r.serviceCoordinatorId,
    coordinatorReviewStatus: r.coordinatorReviewStatus,
    coordinatorName: coordinatorName ?? null,
    referralDate: r.referralDate,
    status: r.status,
    submittedVia: r.submittedVia,
    intakeFields: r.intakeFields ?? {},
    parentEmail: r.parentEmail,
    intakeSentTo: r.intakeSentTo,
    intakeSentToFamilyRepId: r.intakeSentToFamilyRepId,
    intakeSentAt: iso(r.intakeSentAt),
    parentSignedAt: iso(r.parentSignedAt),
    signedByName: r.signedByName,
    signerRelationship: r.signerRelationship,
    agreementSnapshot: r.agreementSnapshot ?? null,
    altaAuthReceivedAt: iso(r.altaAuthReceivedAt),
    serviceFrequency: r.serviceFrequency,
    cost: r.cost,
    paymentSchedule: r.paymentSchedule,
    paymentTypeRequested: r.paymentTypeRequested,
    supportingDocumentUrl: r.supportingDocumentUrl,
    notes: r.notes,
    createdAt: iso(r.createdAt),
  };
}

// The $160 CEPS fee counts only toward its 490 authorization, never toward a 459/024 service authorization (CEPS, 10/9/2026).
// Correlated SQL is shared by list filters, serialized totals and capacity checks.
// PostgreSQL numeric addition preserves cents; an edited check can be excluded.
export function authorizationUsageSql(excludePaymentId?: string): SQL {
  return sql`case when ${authorizationsTable.paymentType} = 'fee' then
    coalesce((select sum(${feesTable.amount}) from ${feesTable}
      where ${feesTable.authorizationId} = ${authorizationsTable.id}
      and ${feesTable.isDeleted} = false and ${feesTable.status} <> 'waived'), 0)
    else coalesce((select sum(${paymentAllocationsTable.amount}) from ${paymentAllocationsTable}
      inner join ${paymentsTable} on ${paymentsTable.id} = ${paymentAllocationsTable.paymentId}
      where ${paymentAllocationsTable.authorizationId} = ${authorizationsTable.id}
      and ${paymentsTable.isDeleted} = false
      and ${excludePaymentId ? sql`${paymentsTable.id} <> ${excludePaymentId}` : sql`true`}), 0) end`;
}

export async function authorizationTotalsPaid(
  ids: string[],
  database: typeof db = db,
  excludePaymentId?: string,
): Promise<Map<string, Decimal>> {
  if (ids.length === 0) return new Map();
  const rows = await database
    .select({
      authorizationId: authorizationsTable.id,
      total: sql<string>`(${authorizationUsageSql(excludePaymentId)})::text`,
    })
    .from(authorizationsTable)
    .where(inArray(authorizationsTable.id, ids));
  return new Map(rows.map((row) => [row.authorizationId, money(row.total)]));
}

export function effectiveAuthStatus(a: Authorization, totalPaid: Decimal | number): string {
  if (a.status === "canceled") return "canceled";
  const today = new Date().toISOString().slice(0, 10);
  if (a.servicePeriodStart > today) return "pending";
  if (a.servicePeriodEnd < today) return "expired";
  if (money(totalPaid).greaterThanOrEqualTo(money(a.maxPeriodAmount))) return "exhausted";
  return "active";
}

// Stored status means canceled or not. Keep this SQL and effectiveAuthStatus
// in lockstep: cancellation, future start, past end, authorization exhaustion, active.
export function effectiveAuthorizationStatusSql(totalUsed: SQL = authorizationUsageSql()): SQL {
  return sql`case
    when ${authorizationsTable.status} = 'canceled' then 'canceled'
    when ${authorizationsTable.servicePeriodStart} > (now() at time zone 'utc')::date then 'pending'
    when ${authorizationsTable.servicePeriodEnd} < (now() at time zone 'utc')::date then 'expired'
    when ${totalUsed} >= ${authorizationsTable.maxPeriodAmount} then 'exhausted'
    else 'active' end`;
}

export function authorizationJson(
  a: Authorization,
  opts: { clientName?: string | null; vendorName?: string | null; totalPaid?: Decimal | number },
) {
  const totalPaid = money(opts.totalPaid ?? 0);
  const remaining = money(a.maxPeriodAmount).minus(totalPaid);
  const end = new Date(`${a.servicePeriodEnd}T00:00:00Z`);
  const daysUntilExpiry = Math.ceil((end.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  return {
    id: a.id,
    clientId: a.clientId,
    clientName: opts.clientName ?? null,
    vendorId: a.vendorId,
    vendorName: opts.vendorName ?? null,
    authNumber: a.authNumber,
    serviceCode: a.serviceCode,
    paymentType: a.paymentType,
    activityDescription: a.activityDescription,
    servicePeriodStart: a.servicePeriodStart,
    servicePeriodEnd: a.servicePeriodEnd,
    monthlyAmount: a.monthlyAmount,
    oneTimeAmount: a.oneTimeAmount,
    maxPeriodAmount: a.maxPeriodAmount,
    units: a.units,
    status: effectiveAuthStatus(a, totalPaid),
    posNotes: a.posNotes,
    posPdfUrl: a.posPdfUrl,
    receivedDate: a.receivedDate,
    totalPaid: totalPaid.toFixed(2),
    remainingAmount: remaining.toFixed(2),
    daysUntilExpiry,
  };
}

export function invoiceJson(
  i: Invoice,
  opts: {
    clientName?: string | null;
    vendorName?: string | null;
    authNumber?: string | null;
    reviewedByName?: string | null;
    lineItems?: { id: string; authorizationId: string; authNumber?: string | null; serviceMonth: string; amount: string }[];
  } = {},
) {
  return {
    id: i.id,
    clientId: i.clientId,
    clientName: opts.clientName ?? null,
    authorizationId: i.authorizationId,
    authNumber: opts.authNumber ?? null,
    vendorId: i.vendorId,
    vendorName: opts.vendorName ?? null,
    submittedByRole: i.submittedByRole,
    submittedDate: i.submittedDate,
    serviceMonth: i.serviceMonth,
    amountRequested: i.amountRequested,
    paymentType: i.paymentType,
    documentUrl: i.documentUrl,
    status: i.status,
    reviewedBy: i.reviewedBy,
    reviewedByName: opts.reviewedByName ?? null,
    reviewedAt: iso(i.reviewedAt),
    notes: i.notes,
    createdAt: iso(i.createdAt),
    lineItems: opts.lineItems ?? [],
  };
}

export function paymentJson(
  p: Payment,
  opts: { clientName?: string | null; vendorName?: string | null; authNumber?: string | null; allocatedAmount?: string; remainingAmount?: string; allocations?: { id: string; authorizationId: string; authNumber?: string | null; serviceMonth: string; amount: string }[] } = {},
) {
  return {
    id: p.id,
    clientId: p.clientId,
    clientName: opts.clientName ?? null,
    authorizationId: p.authorizationId,
    authNumber: opts.authNumber ?? null,
    vendorId: p.vendorId,
    vendorName: opts.vendorName ?? null,
    invoiceId: p.invoiceId,
    qbCheckNumber: p.qbCheckNumber,
    checkDate: p.checkDate,
    amount: p.amount,
    paymentMonth: p.paymentMonth,
    paymentType: p.paymentType,
    source: p.source,
    loggedBy: p.loggedBy,
    remitted: p.remitted,
    allocatedAmount: opts.allocatedAmount ?? (p.remitted ? p.amount : "0.00"),
    remainingAmount: opts.remainingAmount ?? (p.remitted ? "0.00" : p.amount),
    createdAt: iso(p.createdAt),
    allocations: opts.allocations ?? [],
  };
}

export function remittanceJson(
  r: Remittance,
  opts: {
    clientName?: string | null;
    authNumber?: string | null;
    allocatedAmount?: string;
    remainingAmount?: string;
    allocations?: {
      id: string;
      targetKind: "line" | "fee";
      paymentId: string | null;
      paymentAllocationId: string | null;
      feeId: string | null;
      checkNumber: string | null;
      serviceMonth: string | null;
      feeMonth: string | null;
      authNumber: string | null;
      amount: string;
      autoMatched: boolean;
      createdAt: string | null;
    }[];
  } = {},
) {
  return {
    id: r.id,
    clientId: r.clientId,
    clientName: opts.clientName ?? null,
    authorizationId: r.authorizationId,
    authNumber: opts.authNumber ?? null,
    altaReference: r.altaReference,
    remittanceDate: r.remittanceDate,
    amount: r.amount,
    paymentMonth: r.paymentMonth,
    status: r.status,
    source: r.source,
    matchedPaymentId: r.matchedPaymentId,
    autoMatched: r.autoMatched,
    remittanceBatchId: r.remittanceBatchId,
    reportReference: r.reportReference,
    reviewReason: r.reviewReason,
    expectedAmount: r.expectedAmount,
    allocatedAmount: opts.allocatedAmount ?? (r.matchedPaymentId ? r.amount : "0.00"),
    remainingAmount: opts.remainingAmount ?? (r.matchedPaymentId ? "0.00" : r.amount),
    allocations: opts.allocations ?? [],
  };
}

export function feeJson(
  f: Fee,
  opts: { clientName?: string | null; authNumber?: string | null; remittedAmount?: string } = {},
) {
  return {
    id: f.id,
    clientId: f.clientId,
    clientName: opts.clientName ?? null,
    paymentId: f.paymentId,
    authorizationId: f.authorizationId,
    authNumber: opts.authNumber ?? null,
    feeAuthorizationMissing: f.authorizationId === null,
    feeMonth: f.feeMonth,
    amount: f.amount,
    remittedAmount: opts.remittedAmount ?? "0.00",
    ruleApplied: f.ruleApplied,
    status: f.status,
    notes: f.notes,
    waiverReason: f.waiverReason,
    createdBy: f.createdBy,
    createdAt: iso(f.createdAt),
  };
}

export function vendorJson(v: Vendor) {
  return {
    id: v.id,
    name: v.name,
    qbPayeeName: v.qbPayeeName,
    altaVendorNumber: v.altaVendorNumber,
    ein: v.ein,
    billingAddress: v.billingAddress,
    serviceAddress: v.serviceAddress,
    phone: v.phone,
    email: v.email,
    contactPerson: v.contactPerson,
    w9Status: v.w9Status,
    w9DocumentUrl: v.w9DocumentUrl,
    preferred: v.preferred,
    active: v.active,
    createdAt: iso(v.createdAt),
  };
}

export function userJson(u: User, permissions: string[] = []) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    linkedRecordId: u.linkedRecordId,
    linkedRecordType: u.linkedRecordType,
    active: u.active,
    lastLogin: iso(u.lastLogin),
    createdAt: iso(u.createdAt),
    permissions,
  };
}

export async function getClientOr404(id: string): Promise<Client | undefined> {
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(and(eq(clientsTable.id, id), notDeleted(clientsTable)));
  return client;
}
