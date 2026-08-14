import { inArray, eq } from "drizzle-orm";
import {
  db,
  clientsTable,
  vendorsTable,
  usersTable,
  authorizationsTable,
  paymentsTable,
  type Client,
  type Vendor,
  type Referral,
  type Authorization,
  type Invoice,
  type Payment,
  type Remittance,
  type User,
} from "@workspace/db";
import { iso } from "./auth";

export async function clientNameMap(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: clientsTable.id, firstName: clientsTable.firstName, lastName: clientsTable.lastName })
    .from(clientsTable)
    .where(inArray(clientsTable.id, unique));
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
    .where(inArray(authorizationsTable.id, unique));
  return new Map(rows.map((r) => [r.id, r.authNumber]));
}

export function clientJson(c: Client, coordinatorName?: string | null) {
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
    isMinor: c.isMinor,
    familyRepName: c.familyRepName,
    familyRepPhone: c.familyRepPhone,
    familyRepEmail: c.familyRepEmail,
    familyRepAddress: c.familyRepAddress,
    createdAt: iso(c.createdAt),
  };
}

export function referralJson(r: Referral, clientName?: string | null, coordinatorName?: string | null) {
  return {
    id: r.id,
    clientId: r.clientId,
    clientName: clientName ?? null,
    serviceCoordinatorId: r.serviceCoordinatorId,
    coordinatorName: coordinatorName ?? null,
    referralDate: r.referralDate,
    status: r.status,
    submittedVia: r.submittedVia,
    intakeFields: r.intakeFields ?? {},
    parentEmail: r.parentEmail,
    parentSignedAt: iso(r.parentSignedAt),
    signedByName: r.signedByName,
    altaAuthReceivedAt: iso(r.altaAuthReceivedAt),
    serviceFrequency: r.serviceFrequency,
    notes: r.notes,
    createdAt: iso(r.createdAt),
  };
}

export async function authorizationTotalsPaid(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ authorizationId: paymentsTable.authorizationId, amount: paymentsTable.amount })
    .from(paymentsTable)
    .where(inArray(paymentsTable.authorizationId, ids));
  const map = new Map<string, number>();
  for (const row of rows) {
    if (!row.authorizationId) continue;
    map.set(row.authorizationId, (map.get(row.authorizationId) ?? 0) + Number(row.amount));
  }
  return map;
}

export function effectiveAuthStatus(a: Authorization, totalPaid: number): string {
  if (a.status === "pending") return "pending";
  const today = new Date().toISOString().slice(0, 10);
  if (a.servicePeriodEnd < today) return "expired";
  if (totalPaid >= Number(a.maxPeriodAmount)) return "exhausted";
  return a.status;
}

export function authorizationJson(
  a: Authorization,
  opts: { clientName?: string | null; vendorName?: string | null; totalPaid?: number },
) {
  const totalPaid = opts.totalPaid ?? 0;
  const remaining = Number(a.maxPeriodAmount) - totalPaid;
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
  };
}

export function paymentJson(
  p: Payment,
  opts: { clientName?: string | null; vendorName?: string | null; authNumber?: string | null } = {},
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
    createdAt: iso(p.createdAt),
  };
}

export function remittanceJson(
  r: Remittance,
  opts: { clientName?: string | null; authNumber?: string | null } = {},
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
  };
}

export function vendorJson(v: Vendor) {
  return {
    id: v.id,
    name: v.name,
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

export function userJson(u: User) {
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
  };
}

export async function getClientOr404(id: string): Promise<Client | undefined> {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, id));
  return client;
}
