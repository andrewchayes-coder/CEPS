import { Router, type IRouter } from "express";
import { eq, desc, asc, and, count, sql, ilike, or, lte, gte, inArray, type SQL } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, authorizationsTable, authorizationVersionsTable, paymentsTable, paymentAllocationsTable, usersTable, unmatchedPosDocumentsTable, clientsTable, vendorsTable } from "@workspace/db";
import {
  ListAuthorizationsQueryParams,
  ListAuthorizationsResponse,
  CreateAuthorizationBody,
  CreateAuthorizationResponse,
  GetAuthorizationResponse,
  UpdateAuthorizationBody,
  UpdateAuthorizationResponse,
  ListAuthorizationVersionsResponse,
  ParseAuthorizationPdfBody,
  ParseAuthorizationPdfResponse,
  ListUnmatchedPosQueryParams,
  ListUnmatchedPosResponse,
  SaveUnmatchedPosBody,
  SaveUnmatchedPosResponse,
  MatchPosClientBody,
  MatchPosClientResponse,
  GetUnmatchedPosParams,
  GetUnmatchedPosResponse,
  CompleteUnmatchedPosParams,
  CompleteUnmatchedPosBody,
  CompleteUnmatchedPosResponse,
  LookupAuthorizationQueryParams,
  LookupAuthorizationResponse,
  AmendAuthorizationParams,
  AmendAuthorizationBody,
  AmendAuthorizationResponse,
  CancelAuthorizationParams,
  CancelAuthorizationBody,
  CancelAuthorizationResponse,
  CreateUnmatchedPosBatchBody,
  CreateUnmatchedPosBatchResponse,
  GetUnmatchedPosBatchParams,
  GetUnmatchedPosBatchResponse,
  ReviewUnmatchedPosParams,
  ReviewUnmatchedPosBody,
  ReviewUnmatchedPosResponse,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, audit } from "../lib/auth";
import {
  authorizationJson,
  clientNameMap,
  vendorNameMap,
  authorizationTotalsPaid,
  notDeleted,
  diffDetail,
} from "../lib/serializers";
import { sortedOrder } from "../lib/sorting";
import { softDeleteAuthorization, validateParticipantLinks } from "../lib/participantLinks";
import { advanceReferralForAuthorization } from "../lib/advanceReferralForAuthorization";
import { findPosClient } from "../lib/posMatching";
import { parsePosPdf } from "../lib/posPdfParser";
import { schedulePosBatchProcessing } from "../lib/posBatchWorker";
import { ObjectStorageService } from "../lib/objectStorage";
import { PosUploadValidationError, validatePosBatchFiles } from "../lib/posBatchStorage";

const router: IRouter = Router();
const posBatchStorage = new ObjectStorageService();

// Normalize empty strings from the form to null for optional/numeric columns.
function cleanAuthFields<T extends Record<string, unknown>>(obj: T): T {
  const out = { ...obj };
  for (const k of ["vendorId", "activityDescription", "monthlyAmount", "oneTimeAmount", "receivedDate", "posPdfUrl", "posNotes"] as const) {
    if (out[k] === "") (out as Record<string, unknown>)[k] = null;
  }
  return out;
}

function derivePaymentType(serviceCode: string): "direct_payment" | "reimbursement" | "fee" {
  if (serviceCode === "459") return "direct_payment";
  if (serviceCode === "024") return "reimbursement";
  return "fee"; // 490
}

function maxAmountWarning(data: {
  monthlyAmount?: string | null;
  maxPeriodAmount: string;
  servicePeriodStart: string;
  servicePeriodEnd: string;
}): string | null {
  if (!data.monthlyAmount) return null;
  const start = new Date(`${data.servicePeriodStart}T00:00:00Z`);
  const end = new Date(`${data.servicePeriodEnd}T00:00:00Z`);
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth()) + 1;
  if (months > 1 && Number(data.monthlyAmount) === Number(data.maxPeriodAmount)) {
    return `Possible data-quality issue: the monthly amount ($${data.monthlyAmount}) equals the maximum for the entire ${months}-month period. Verify the POS — the period maximum may be understated.`;
  }
  return null;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validMoney(value: string): boolean {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0;
}

function reviewFieldValidationError(fields: {
  authNumber?: string;
  serviceCode?: string;
  servicePeriodStart?: string;
  servicePeriodEnd?: string;
  unitAmount?: string | null;
  monthlyAmount?: string | null;
  maxPeriodAmount?: string;
  units?: number | null;
}): string | null {
  if (fields.authNumber !== undefined && !fields.authNumber.trim()) return "Authorization number must contain a nonblank value.";
  if (fields.serviceCode !== undefined && !["459", "024", "490"].includes(fields.serviceCode)) {
    return "Service code must be 459, 024, or 490.";
  }
  if (fields.servicePeriodStart !== undefined && !validIsoDate(fields.servicePeriodStart)) {
    return "Service period start must be a valid YYYY-MM-DD date.";
  }
  if (fields.servicePeriodEnd !== undefined && !validIsoDate(fields.servicePeriodEnd)) {
    return "Service period end must be a valid YYYY-MM-DD date.";
  }
  for (const [name, value] of [
    ["unitAmount", fields.unitAmount],
    ["monthlyAmount", fields.monthlyAmount],
    ["maxPeriodAmount", fields.maxPeriodAmount],
  ] as const) {
    if (value !== undefined && value !== null && !validMoney(value)) {
      return `${name} must be a non-negative amount with up to two decimal places.`;
    }
  }
  if (fields.units !== undefined && fields.units !== null &&
    (!Number.isInteger(fields.units) || fields.units < 0 || fields.units > 2_147_483_647)) {
    return "Units must be a non-negative whole number.";
  }
  return null;
}

function unmatchedPosJson(row: typeof unmatchedPosDocumentsTable.$inferSelect, suggestedClientName?: string | null) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    suggestedClientName: suggestedClientName ?? null,
  };
}

router.get("/authorizations", requireAuth, async (req, res): Promise<void> => {
  const query = ListAuthorizationsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.startDate && query.data.endDate && query.data.startDate > query.data.endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const conditions: SQL[] = [notDeleted(authorizationsTable)];
  // Role scoping — mirrors the payments/audit-log SQL-WHERE pattern:
  // vendors see only their own vendor's auths; parent/self only their linked
  // client's auths.
  const u = req.user!;
  if (u.role === "staff") {
    // Staff are intentionally unrestricted.
  } else if (u.role === "service_coordinator") {
    conditions.push(sql`${authorizationsTable.clientId} in (select id from clients where assigned_coordinator_id = ${u.id} and is_deleted = false)`);
  } else if (u.role === "vendor" && u.linkedRecordType === "vendor" && u.linkedRecordId) {
    conditions.push(eq(authorizationsTable.vendorId, u.linkedRecordId));
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client" && u.linkedRecordId) {
    conditions.push(eq(authorizationsTable.clientId, u.linkedRecordId ?? ""));
  } else {
    // A malformed linked identity must fail closed rather than returning all rows.
    conditions.push(sql`false`);
  }
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  // Query-string filters on plain columns.
  if (query.data.clientId) conditions.push(eq(authorizationsTable.clientId, query.data.clientId));
  if (query.data.vendorId) conditions.push(eq(authorizationsTable.vendorId, query.data.vendorId));
  // Service-period overlap: rows that began before the requested end and end
  // after the requested start are included (including exact boundaries).
  if (query.data.startDate) conditions.push(gte(authorizationsTable.servicePeriodEnd, query.data.startDate));
  if (query.data.endDate) conditions.push(lte(authorizationsTable.servicePeriodStart, query.data.endDate));
  if (query.data.search) {
    const like = `%${escapeLike(query.data.search)}%`;
    const normalizedSearch = query.data.search.trim().toLowerCase().replace(/\s+/g, "_");
    conditions.push(
      or(
        ilike(authorizationsTable.authNumber, like),
        ilike(authorizationsTable.serviceCode, like),
        ilike(sql`replace(${authorizationsTable.paymentType}, '_', ' ')`, like),
        ilike(sql`coalesce(${authorizationsTable.activityDescription}, '')`, like),
        ilike(sql`${authorizationsTable.servicePeriodStart}::text`, like),
        ilike(sql`${authorizationsTable.servicePeriodEnd}::text`, like),
        ilike(sql`to_char(${authorizationsTable.servicePeriodStart}, 'MM/DD/YYYY')`, like),
        ilike(sql`to_char(${authorizationsTable.servicePeriodEnd}, 'MM/DD/YYYY')`, like),
        ilike(sql`to_char(${authorizationsTable.servicePeriodStart}, 'MM/DD/YY')`, like),
        ilike(sql`to_char(${authorizationsTable.servicePeriodEnd}, 'MM/DD/YY')`, like),
        ilike(sql`to_char(${authorizationsTable.servicePeriodStart}, 'Mon FMDD, YYYY')`, like),
        ilike(sql`to_char(${authorizationsTable.servicePeriodEnd}, 'Mon FMDD, YYYY')`, like),
        ilike(sql`coalesce(${authorizationsTable.monthlyAmount}::text, '')`, like),
        ilike(sql`to_char(${authorizationsTable.monthlyAmount}, 'FM$999,999,999,990.00')`, like),
        ilike(sql`coalesce(${authorizationsTable.oneTimeAmount}::text, '')`, like),
        ilike(sql`to_char(${authorizationsTable.oneTimeAmount}, 'FM$999,999,999,990.00')`, like),
        ilike(sql`${authorizationsTable.maxPeriodAmount}::text`, like),
        ilike(sql`to_char(${authorizationsTable.maxPeriodAmount}, 'FM$999,999,999,990.00')`, like),
        ilike(sql`${authorizationsTable.units}::text`, like),
        ilike(sql`replace(${authorizationsTable.status}, '_', ' ')`, like),
        ilike(sql`coalesce(${authorizationsTable.receivedDate}::text, '')`, like),
        ilike(sql`to_char(${authorizationsTable.receivedDate}, 'MM/DD/YYYY')`, like),
        sql`${authorizationsTable.clientId} in (select id from clients where (first_name || ' ' || last_name) ilike ${like} and is_deleted = false)`,
        sql`${authorizationsTable.clientId} in (select id from clients where uci_number ilike ${like} and is_deleted = false)`,
        sql`${authorizationsTable.vendorId} in (select id from vendors where name ilike ${like})`,
        sql`${authorizationsTable.vendorId} in (select id from vendors where coalesce(alta_vendor_number, '') ilike ${like} or coalesce(contact_person, '') ilike ${like} or coalesce(email, '') ilike ${like})`,
      )!,
    );
    if (normalizedSearch === "direct_payment") {
      conditions.push(eq(authorizationsTable.paymentType, "direct_payment"));
      // Legacy rows with an invalid service code must not make the otherwise
      // valid operational display search fail response-schema validation.
      conditions.push(inArray(authorizationsTable.serviceCode, ["459", "490", "024"]));
    }
    if (normalizedSearch === "reimbursement") conditions.push(eq(authorizationsTable.paymentType, "reimbursement"));
    if (normalizedSearch === "fee") conditions.push(eq(authorizationsTable.paymentType, "fee"));
  }

  // The `status` and `expiringWithinDays` filters operate on the *derived*
  // effective status / days-until-expiry (see effectiveAuthStatus &
  // authorizationJson). We replicate that derivation in SQL so filtering and
  // pagination stay at the DB level with identical semantics.
  //   totalPaid  = coalesce(sum(non-deleted payments for this auth), 0)
  //   effective  = pending | expired (period end past) | exhausted (paid ≥ max) | status
  //   days       = ceil((servicePeriodEnd@00:00Z − now) / 1 day)
  const totalPaidSql = sql`coalesce((select sum(${paymentAllocationsTable.amount}) from ${paymentAllocationsTable} inner join ${paymentsTable} on ${paymentsTable.id} = ${paymentAllocationsTable.paymentId} where ${paymentAllocationsTable.authorizationId} = ${authorizationsTable.id} and ${paymentsTable.isDeleted} = false), 0)`;
  const effectiveStatusSql = sql`case when ${authorizationsTable.status} = 'canceled' then 'canceled' when ${authorizationsTable.servicePeriodStart} > (now() at time zone 'utc')::date then 'pending' when ${authorizationsTable.status} = 'pending' then 'pending' when ${authorizationsTable.servicePeriodEnd} < (now() at time zone 'utc')::date then 'expired' when ${totalPaidSql} >= ${authorizationsTable.maxPeriodAmount} then 'exhausted' else ${authorizationsTable.status} end`;
  const daysUntilExpirySql = sql`ceil(extract(epoch from ((${authorizationsTable.servicePeriodEnd} || 'T00:00:00Z')::timestamptz - now())) / 86400)`;
  if (query.data.status) {
    conditions.push(sql`${effectiveStatusSql} = ${query.data.status}`);
  }
  if (query.data.expiringWithinDays != null) {
    conditions.push(
      sql`${daysUntilExpirySql} >= 0 and ${daysUntilExpirySql} <= ${query.data.expiringWithinDays} and ${effectiveStatusSql} = 'active'`,
    );
  }
  const where = and(...conditions);
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const order = sortedOrder(
    query.data.sortBy,
    query.data.sortDirection,
    {
      authNumber: sql`lower(${authorizationsTable.authNumber})`,
      clientName: sql`lower((select last_name || ', ' || first_name from clients where id = ${authorizationsTable.clientId}))`,
      vendorName: sql`lower((select name from vendors where id = ${authorizationsTable.vendorId}))`,
      servicePeriodStart: sql`${authorizationsTable.servicePeriodStart}`,
      servicePeriodEnd: sql`${authorizationsTable.servicePeriodEnd}`,
      maxPeriodAmount: sql`${authorizationsTable.maxPeriodAmount}`,
      status: effectiveStatusSql,
      createdAt: sql`${authorizationsTable.createdAt}`,
    },
    sql`${authorizationsTable.id}`,
    [desc(authorizationsTable.createdAt), desc(authorizationsTable.id)],
  );
  const [[{ total }], auths] = await Promise.all([
    db.select({ total: count() }).from(authorizationsTable).where(where),
    db
      .select()
      .from(authorizationsTable)
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
  ]);
  const totals = await authorizationTotalsPaid(auths.map((a) => a.id));
  const [clientNames, vendorNames] = await Promise.all([
    clientNameMap(auths.map((a) => a.clientId)),
    vendorNameMap(auths.map((a) => a.vendorId)),
  ]);
  const items = auths.map((a) =>
    authorizationJson(a, {
      clientName: clientNames.get(a.clientId),
      vendorName: a.vendorId ? vendorNames.get(a.vendorId) : null,
      totalPaid: totals.get(a.id) ?? 0,
    }),
  );
  res.json(ListAuthorizationsResponse.parse({ items, total }));
});

router.post("/authorizations", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateAuthorizationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  if (!d.authNumber.trim()) {
    res.status(400).json({ error: "authNumber must contain a nonblank value" });
    return;
  }
  if ((d.status as string | undefined) === "canceled") {
    res.status(400).json({ error: "Canceled authorizations must use the dedicated cancellation endpoint." });
    return;
  }
  const existing = await db.select({ id: authorizationsTable.id }).from(authorizationsTable)
    .where(and(eq(authorizationsTable.clientId, d.clientId), eq(authorizationsTable.authNumber, d.authNumber), notDeleted(authorizationsTable))).limit(1);
  if (existing[0]) {
    res.status(409).json({ error: "An authorization with this client and authorization number already exists; amend the existing authorization instead." });
    return;
  }
  const warning = maxAmountWarning(d);
  if (warning && !d.acceptMaxAmountWarning) {
    res.status(200).json(CreateAuthorizationResponse.parse({ saved: false, warnings: [warning] }));
    return;
  }
  const { acceptMaxAmountWarning: _accept, ...values } = d;
  let relationshipError: string | undefined;
  let auth: typeof authorizationsTable.$inferSelect | undefined;
  try {
    auth = await db.transaction(async (tx) => {
      const txDb = tx as unknown as typeof db;
      relationshipError = (await validateParticipantLinks(txDb, d.clientId, {})).error;
      if (relationshipError) return undefined;
      const [created] = await tx
        .insert(authorizationsTable)
        .values({
          ...cleanAuthFields(values),
          paymentType: d.paymentType ?? derivePaymentType(d.serviceCode),
          status: d.status ?? "active",
        })
        .returning();
      if (created) {
        await advanceReferralForAuthorization(txDb, created, req.user!.id);
      }
      return created;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      res.status(409).json({ error: "An authorization with this client and authorization number already exists; amend the existing authorization instead." });
      return;
    }
    throw error;
  }
  if (!auth) {
    res.status(400).json({ error: relationshipError ?? "Invalid participant link" });
    return;
  }

  await audit(req.user!.id, "create_authorization", "authorization", auth.id, `Auth ${auth.authNumber}`);
  const [clientNames, vendorNames] = await Promise.all([
    clientNameMap([auth.clientId]),
    vendorNameMap([auth.vendorId]),
  ]);
  res.status(201).json(
    CreateAuthorizationResponse.parse({
      saved: true,
      warnings: warning ? [warning] : [],
      authorization: authorizationJson(auth, {
        clientName: clientNames.get(auth.clientId),
        vendorName: auth.vendorId ? vendorNames.get(auth.vendorId) : null,
        totalPaid: 0,
      }),
    }),
  );
});

router.get("/authorizations/lookup", requireStaff, async (req, res): Promise<void> => {
  const parsed = LookupAuthorizationQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!parsed.data.authNumber.trim()) {
    res.status(400).json({ error: "authNumber must contain a nonblank value" });
    return;
  }
  const authNumber = parsed.data.authNumber;
  const [auth] = await db.select().from(authorizationsTable).where(and(
    eq(authorizationsTable.clientId, parsed.data.clientId),
    eq(authorizationsTable.authNumber, authNumber),
    notDeleted(authorizationsTable),
  )).limit(1);
  if (!auth) {
    res.json(LookupAuthorizationResponse.parse({ exists: false, authorization: null }));
    return;
  }
  const totals = await authorizationTotalsPaid([auth.id]);
  const [clientNames, vendorNames] = await Promise.all([
    clientNameMap([auth.clientId]),
    vendorNameMap([auth.vendorId]),
  ]);
  res.json(LookupAuthorizationResponse.parse({
    exists: true,
    authorization: authorizationJson(auth, {
      clientName: clientNames.get(auth.clientId),
      vendorName: auth.vendorId ? vendorNames.get(auth.vendorId) : null,
      totalPaid: totals.get(auth.id) ?? 0,
    }),
  }));
});

router.get("/authorizations/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [auth] = await db
    .select()
    .from(authorizationsTable)
    .where(and(eq(authorizationsTable.id, id), notDeleted(authorizationsTable)));
  if (!auth) {
    res.status(404).json({ error: "Authorization not found" });
    return;
  }
  // Per-role ownership, mirroring the GET /authorizations list scoping:
  // staff/coordinator see all; parent/self only their linked client's auths;
  // vendors only their own vendor's auths.
  const u = req.user!;
  if (u.role === "staff") {
    // unrestricted
  } else if (u.role === "service_coordinator") {
    const [caseload] = await db.select({ id: clientsTable.id }).from(clientsTable).where(and(
      eq(clientsTable.id, auth.clientId),
      eq(clientsTable.assignedCoordinatorId, u.id),
      eq(clientsTable.isDeleted, false),
    ));
    if (!caseload) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  } else if (u.role === "vendor") {
    if (u.linkedRecordType !== "vendor" || !u.linkedRecordId || auth.vendorId !== u.linkedRecordId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  } else if (u.role === "parent_guardian" || u.role === "self") {
    if (u.linkedRecordType !== "client" || !u.linkedRecordId || auth.clientId !== u.linkedRecordId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  } else {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const totals = await authorizationTotalsPaid([auth.id]);
  const [clientNames, vendorNames] = await Promise.all([
    clientNameMap([auth.clientId]),
    vendorNameMap([auth.vendorId]),
  ]);
  res.json(
    GetAuthorizationResponse.parse(
      authorizationJson(auth, {
        clientName: clientNames.get(auth.clientId),
        vendorName: auth.vendorId ? vendorNames.get(auth.vendorId) : null,
        totalPaid: totals.get(auth.id) ?? 0,
      }),
    ),
  );
});

router.patch("/authorizations/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateAuthorizationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { acceptMaxAmountWarning: _accept, ...rawUpdates } = parsed.data;
  const updates = cleanAuthFields(rawUpdates);
  const warning = parsed.data.maxPeriodAmount && parsed.data.servicePeriodStart && parsed.data.servicePeriodEnd
    ? maxAmountWarning({
        monthlyAmount: parsed.data.monthlyAmount,
        maxPeriodAmount: parsed.data.maxPeriodAmount,
        servicePeriodStart: parsed.data.servicePeriodStart,
        servicePeriodEnd: parsed.data.servicePeriodEnd,
      })
    : null;
  if (warning && !parsed.data.acceptMaxAmountWarning) {
    res.status(200).json(UpdateAuthorizationResponse.parse({ saved: false, warnings: [warning] }));
    return;
  }
  let before: typeof authorizationsTable.$inferSelect | undefined;
  const auth = await db.transaction(async (tx) => {
    [before] = await tx
      .select()
      .from(authorizationsTable)
      .where(and(eq(authorizationsTable.id, id), notDeleted(authorizationsTable)))
      .for("update");
    if (!before) return undefined;
    const [updated] = await tx
      .update(authorizationsTable)
      .set(updates)
      .where(and(eq(authorizationsTable.id, id), notDeleted(authorizationsTable)))
      .returning();
    if (!updated) return undefined;
    await tx.insert(authorizationVersionsTable).values({
      authorizationId: before.id,
      clientId: before.clientId,
      vendorId: before.vendorId,
      authNumber: before.authNumber,
      serviceCode: before.serviceCode,
      paymentType: before.paymentType,
      activityDescription: before.activityDescription,
      servicePeriodStart: before.servicePeriodStart,
      servicePeriodEnd: before.servicePeriodEnd,
      monthlyAmount: before.monthlyAmount,
      oneTimeAmount: before.oneTimeAmount,
      maxPeriodAmount: before.maxPeriodAmount,
      units: before.units,
      status: before.status,
      posNotes: before.posNotes,
      posPdfUrl: before.posPdfUrl,
      receivedDate: before.receivedDate,
      isDeleted: before.isDeleted,
      deletedAt: before.deletedAt,
      deletedBy: before.deletedBy,
      createdAt: before.createdAt,
      changedBy: req.user!.id,
      changedFields: Object.keys(updates),
    });
    return updated;
  });
  if (!auth) {
    res.status(404).json({ error: "Authorization not found" });
    return;
  }
  if (!before) {
    res.status(404).json({ error: "Authorization not found" });
    return;
  }
  await audit(
    req.user!.id,
    "update_authorization",
    "authorization",
    auth.id,
    diffDetail(before, updates, Object.keys(updates)),
  );
  const totals = await authorizationTotalsPaid([auth.id]);
  const [clientNames, vendorNames] = await Promise.all([
    clientNameMap([auth.clientId]),
    vendorNameMap([auth.vendorId]),
  ]);
  res.json(
    UpdateAuthorizationResponse.parse({
      saved: true,
      authorization: authorizationJson(auth, {
        clientName: clientNames.get(auth.clientId),
        vendorName: auth.vendorId ? vendorNames.get(auth.vendorId) : null,
        totalPaid: totals.get(auth.id) ?? 0,
      }),
    }),
  );
});

router.post("/authorizations/:id/amend", requireStaff, async (req, res): Promise<void> => {
  const params = AmendAuthorizationParams.safeParse(req.params);
  const parsed = AmendAuthorizationBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: !params.success ? params.error.message : "Invalid amendment body" });
    return;
  }
  if (!parsed.data.confirmed) {
    res.status(400).json({ error: "Explicit confirmation is required before applying an amendment." });
    return;
  }
  const warning = maxAmountWarning(parsed.data);
  if (warning && !parsed.data.acceptMaxAmountWarning) {
    res.status(200).json(AmendAuthorizationResponse.parse({ saved: false, warnings: [warning] }));
    return;
  }
  let before: typeof authorizationsTable.$inferSelect | undefined;
  const auth = await db.transaction(async (tx) => {
    [before] = await tx.select().from(authorizationsTable)
      .where(and(eq(authorizationsTable.id, params.data.id), notDeleted(authorizationsTable))).for("update");
    if (!before) return undefined;
    const updates = {
      servicePeriodStart: parsed.data.servicePeriodStart,
      servicePeriodEnd: parsed.data.servicePeriodEnd,
      monthlyAmount: parsed.data.monthlyAmount,
      maxPeriodAmount: parsed.data.maxPeriodAmount,
      posNotes: parsed.data.posNotes,
      ...(parsed.data.posPdfUrl !== undefined ? { posPdfUrl: parsed.data.posPdfUrl } : {}),
    };
    const [updated] = await tx.update(authorizationsTable).set(updates)
      .where(and(eq(authorizationsTable.id, before.id), notDeleted(authorizationsTable))).returning();
    if (!updated) return undefined;
    await tx.insert(authorizationVersionsTable).values({
      authorizationId: before.id, clientId: before.clientId, vendorId: before.vendorId,
      authNumber: before.authNumber, serviceCode: before.serviceCode, paymentType: before.paymentType,
      activityDescription: before.activityDescription, servicePeriodStart: before.servicePeriodStart,
      servicePeriodEnd: before.servicePeriodEnd, monthlyAmount: before.monthlyAmount,
      oneTimeAmount: before.oneTimeAmount, maxPeriodAmount: before.maxPeriodAmount, units: before.units,
      status: before.status, posNotes: before.posNotes, posPdfUrl: before.posPdfUrl,
      receivedDate: before.receivedDate, isDeleted: before.isDeleted, deletedAt: before.deletedAt,
      deletedBy: before.deletedBy, createdAt: before.createdAt, changedBy: req.user!.id,
      changedFields: Object.keys(updates),
    });
    return updated;
  });
  if (!auth || !before) {
    res.status(404).json({ error: "Authorization not found" });
    return;
  }
  await audit(req.user!.id, "amend_authorization", "authorization", auth.id, diffDetail(before, auth, [
    "servicePeriodStart", "servicePeriodEnd", "monthlyAmount", "maxPeriodAmount", "posNotes", "posPdfUrl",
  ]));
  const totals = await authorizationTotalsPaid([auth.id]);
  const [clientNames, vendorNames] = await Promise.all([clientNameMap([auth.clientId]), vendorNameMap([auth.vendorId])]);
  res.json(AmendAuthorizationResponse.parse({ saved: true, warnings: [], authorization: authorizationJson(auth, {
    clientName: clientNames.get(auth.clientId), vendorName: auth.vendorId ? vendorNames.get(auth.vendorId) : null,
    totalPaid: totals.get(auth.id) ?? 0,
  }) }));
});

router.post("/authorizations/:id/cancel", requireStaff, async (req, res): Promise<void> => {
  const params = CancelAuthorizationParams.safeParse(req.params);
  const parsed = CancelAuthorizationBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: !params.success ? params.error.message : "Invalid cancellation body" });
    return;
  }
  if (!parsed.data.reason.trim()) {
    res.status(400).json({ error: "A nonblank cancellation reason is required." });
    return;
  }
  let before: typeof authorizationsTable.$inferSelect | undefined;
  const auth = await db.transaction(async (tx) => {
    [before] = await tx.select().from(authorizationsTable)
      .where(and(eq(authorizationsTable.id, params.data.id), notDeleted(authorizationsTable))).for("update");
    if (!before) return undefined;
    if (before.status === "canceled") return null;
    const [updated] = await tx.update(authorizationsTable).set({ status: "canceled" })
      .where(and(eq(authorizationsTable.id, before.id), notDeleted(authorizationsTable))).returning();
    if (!updated) return undefined;
    await tx.insert(authorizationVersionsTable).values({
      authorizationId: before.id, clientId: before.clientId, vendorId: before.vendorId,
      authNumber: before.authNumber, serviceCode: before.serviceCode, paymentType: before.paymentType,
      activityDescription: before.activityDescription, servicePeriodStart: before.servicePeriodStart,
      servicePeriodEnd: before.servicePeriodEnd, monthlyAmount: before.monthlyAmount,
      oneTimeAmount: before.oneTimeAmount, maxPeriodAmount: before.maxPeriodAmount, units: before.units,
      status: before.status, posNotes: before.posNotes, posPdfUrl: before.posPdfUrl,
      receivedDate: before.receivedDate, isDeleted: before.isDeleted, deletedAt: before.deletedAt,
      deletedBy: before.deletedBy, createdAt: before.createdAt, changedBy: req.user!.id,
      changedFields: ["status"],
    });
    return updated;
  });
  if (auth === null) {
    res.status(400).json({ error: "Authorization is already canceled." });
    return;
  }
  if (!auth || !before) {
    res.status(404).json({ error: "Authorization not found" });
    return;
  }
  await audit(req.user!.id, "cancel_authorization", "authorization", auth.id, parsed.data.reason.trim());
  const totals = await authorizationTotalsPaid([auth.id]);
  const [clientNames, vendorNames] = await Promise.all([clientNameMap([auth.clientId]), vendorNameMap([auth.vendorId])]);
  res.json(CancelAuthorizationResponse.parse({ saved: true, warnings: [], authorization: authorizationJson(auth, {
    clientName: clientNames.get(auth.clientId), vendorName: auth.vendorId ? vendorNames.get(auth.vendorId) : null,
    totalPaid: totals.get(auth.id) ?? 0,
  }) }));
});

router.get("/authorizations/:id/versions", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [authorization] = await db.select({ id: authorizationsTable.id }).from(authorizationsTable)
    .where(and(eq(authorizationsTable.id, id), notDeleted(authorizationsTable)));
  if (!authorization) {
    res.status(404).json({ error: "Authorization not found" });
    return;
  }
  const versions = await db
    .select()
    .from(authorizationVersionsTable)
    .where(eq(authorizationVersionsTable.authorizationId, id))
    .orderBy(desc(authorizationVersionsTable.changedAt));
  const names = new Map<string, string>();
  const userIds = versions.map((v) => v.changedBy).filter((v): v is string => Boolean(v));
  if (userIds.length) {
    const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, userIds));
    for (const user of users) names.set(user.id, user.name);
  }
  res.json(ListAuthorizationVersionsResponse.parse(versions.map((v) => ({
    ...v,
    changedByName: v.changedBy ? names.get(v.changedBy) ?? null : null,
    changedAt: v.changedAt.toISOString(),
  }))));
});

router.delete("/authorizations/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const result = await db.transaction((tx) => softDeleteAuthorization(tx as unknown as typeof db, id, req.user!.id));
  if ("notFound" in result) {
    res.status(404).json({ error: "Authorization not found" });
    return;
  }
  if ("conflict" in result) {
    res.status(409).json({ error: result.conflict, blockers: result.blockers });
    return;
  }
  const auth = result.deleted;
  await audit(req.user!.id, "delete_authorization", "authorization", auth.id, `Auth ${auth.authNumber}`);
  res.json({ ok: true });
});

router.get("/unmatched-pos", requireStaff, async (req, res): Promise<void> => {
  const parsed = ListUnmatchedPosQueryParams.safeParse({
    ...req.query,
    ...(req.query.pendingOnly === "false" ? { pendingOnly: false } : {}),
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, batchId, pendingOnly = true, limit: rawLimit, offset: rawOffset } = parsed.data;
  const limit = Math.min(Math.max(rawLimit ?? 50, 1), 1000);
  const offset = Math.max(rawOffset ?? 0, 0);
  const conditions: SQL[] = [];
  if (pendingOnly) conditions.push(eq(unmatchedPosDocumentsTable.reviewStatus, "pending"));
  if (batchId) conditions.push(eq(unmatchedPosDocumentsTable.batchId, batchId));
  if (search?.trim()) {
    const like = `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(
      ilike(unmatchedPosDocumentsTable.sourceFileName, like),
      ilike(unmatchedPosDocumentsTable.clientName, like),
      ilike(unmatchedPosDocumentsTable.uciNumber, like),
      ilike(unmatchedPosDocumentsTable.authNumber, like),
    )!);
  }
  const where = and(...conditions);
  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(unmatchedPosDocumentsTable).where(where),
    db.select().from(unmatchedPosDocumentsTable).where(where)
      .orderBy(asc(unmatchedPosDocumentsTable.createdAt), asc(unmatchedPosDocumentsTable.id))
      .limit(limit).offset(offset),
  ]);
  const suggestedNames = await clientNameMap(rows.map((row) => row.suggestedClientId));
  res.json(ListUnmatchedPosResponse.parse({ items: rows.map((row) => unmatchedPosJson(row, row.suggestedClientId ? suggestedNames.get(row.suggestedClientId) : null)), total }));
});

router.post("/unmatched-pos/match", requireStaff, async (req, res): Promise<void> => {
  const parsed = MatchPosClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const match = await findPosClient(parsed.data);
  res.json(MatchPosClientResponse.parse({
    method: match.method,
    client: match.client ? {
      id: match.client.id,
      firstName: match.client.firstName,
      lastName: match.client.lastName,
      uciNumber: match.client.uciNumber,
    } : null,
  }));
});

router.post("/unmatched-pos", requireStaff, async (req, res): Promise<void> => {
  const parsed = SaveUnmatchedPosBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const match = await findPosClient(parsed.data);
  if (match.client) {
    res.status(409).json({ error: `POS matches participant ${match.client.firstName} ${match.client.lastName}; save it after selecting that participant.` });
    return;
  }
  const [created] = await db.insert(unmatchedPosDocumentsTable).values({
    ...parsed.data,
    createdBy: req.user!.id,
  }).returning();
  res.status(201).json(SaveUnmatchedPosResponse.parse(unmatchedPosJson(created)));
});

router.post("/unmatched-pos/batches", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateUnmatchedPosBatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  let validatedFiles: Awaited<ReturnType<typeof validatePosBatchFiles>>;
  try {
    validatedFiles = await validatePosBatchFiles(posBatchStorage, req.user!.id, parsed.data.files);
  } catch (error) {
    if (error instanceof PosUploadValidationError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "POS batch upload validation failed");
    res.status(400).json({ error: "Unable to validate one or more uploaded POS PDFs." });
    return;
  }
  const batchId = randomUUID();
  const rows = await db.insert(unmatchedPosDocumentsTable).values(validatedFiles.map((file) => ({
    ...file,
    batchId,
    parseStatus: "queued" as const,
    reviewStatus: "pending" as const,
    createdBy: req.user!.id,
  }))).returning();
  schedulePosBatchProcessing();
  res.status(202).json(CreateUnmatchedPosBatchResponse.parse({
    batchId,
    items: rows.map((row) => unmatchedPosJson(row)),
    queuedCount: rows.length,
  }));
});

router.get("/unmatched-pos/batches/:batchId", requireStaff, async (req, res): Promise<void> => {
  const parsed = GetUnmatchedPosBatchParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const items = await db.select().from(unmatchedPosDocumentsTable)
    .where(eq(unmatchedPosDocumentsTable.batchId, parsed.data.batchId))
    .orderBy(asc(unmatchedPosDocumentsTable.createdAt), asc(unmatchedPosDocumentsTable.id));
  if (!items.length) {
    res.status(404).json({ error: "POS batch not found" });
    return;
  }
  const suggestedNames = await clientNameMap(items.map((row) => row.suggestedClientId));
  res.json(GetUnmatchedPosBatchResponse.parse({
    batchId: parsed.data.batchId,
    totalCount: items.length,
    queuedCount: items.filter((row) => row.parseStatus === "queued").length,
    parsedCount: items.filter((row) => row.parseStatus === "parsed").length,
    failedCount: items.filter((row) => row.parseStatus === "failed").length,
    pendingCount: items.filter((row) => row.reviewStatus === "pending").length,
    confirmedCount: items.filter((row) => row.reviewStatus === "confirmed").length,
    discardedCount: items.filter((row) => row.reviewStatus === "discarded").length,
    items: items.map((row) => unmatchedPosJson(
      row,
      row.suggestedClientId ? suggestedNames.get(row.suggestedClientId) : null,
    )),
  }));
});

router.get("/unmatched-pos/:id", requireStaff, async (req, res): Promise<void> => {
  const parsed = GetUnmatchedPosParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.select().from(unmatchedPosDocumentsTable)
    .where(eq(unmatchedPosDocumentsTable.id, parsed.data.id));
  if (!row) {
    res.status(404).json({ error: "Unmatched POS not found" });
    return;
  }
  const suggestedNames = row.suggestedClientId ? await clientNameMap([row.suggestedClientId]) : new Map<string, string>();
  res.json(GetUnmatchedPosResponse.parse(unmatchedPosJson(row, row.suggestedClientId ? suggestedNames.get(row.suggestedClientId) : null)));
});

router.post("/unmatched-pos/:id/complete", requireStaff, async (req, res): Promise<void> => {
  const params = CompleteUnmatchedPosParams.safeParse(req.params);
  const body = CompleteUnmatchedPosBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  let relationshipError: string | undefined;
  let warning: string | null = null;
  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    const [row] = await tx.select().from(unmatchedPosDocumentsTable)
      .where(eq(unmatchedPosDocumentsTable.id, params.data.id)).for("update");
    if (!row) return { kind: "missing" as const };
    if (row.parseStatus === "queued") return { kind: "queued" as const };
    if (row.reviewStatus !== "pending") return { kind: "not-pending" as const };
    const [client] = await tx.select().from(clientsTable)
      .where(and(eq(clientsTable.id, body.data.clientId), eq(clientsTable.isDeleted, false)));
    if (!client) return { kind: "client-missing" as const };
    if (!row.authNumber || !row.serviceCode || !row.servicePeriodStart || !row.servicePeriodEnd || !row.maxPeriodAmount) {
      return { kind: "incomplete" as const };
    }
    relationshipError = (await validateParticipantLinks(txDb, body.data.clientId, {})).error;
    if (relationshipError) return { kind: "relationship" as const };
    warning = maxAmountWarning({
      monthlyAmount: row.monthlyAmount,
      maxPeriodAmount: row.maxPeriodAmount,
      servicePeriodStart: row.servicePeriodStart,
      servicePeriodEnd: row.servicePeriodEnd,
    });
    if (warning && !body.data.acceptMaxAmountWarning) return { kind: "warning" as const };
    const serviceCode = row.serviceCode as "459" | "024" | "490";
    const [auth] = await tx.insert(authorizationsTable).values({
      clientId: body.data.clientId,
      vendorId: body.data.vendorId ?? null,
      authNumber: row.authNumber,
      serviceCode,
      paymentType: body.data.paymentType ?? derivePaymentType(serviceCode),
      activityDescription: row.activityDescription,
      posNotes: row.posNotes,
      servicePeriodStart: row.servicePeriodStart,
      servicePeriodEnd: row.servicePeriodEnd,
      monthlyAmount: row.monthlyAmount,
      oneTimeAmount: null,
      maxPeriodAmount: row.maxPeriodAmount,
      units: row.units,
      posPdfUrl: row.posPdfUrl,
      status: "active",
    }).returning();
    await advanceReferralForAuthorization(txDb, auth, req.user!.id);
    await tx.update(unmatchedPosDocumentsTable).set({
      reviewStatus: "confirmed",
      reviewedBy: req.user!.id,
      reviewedAt: new Date(),
      resultingAuthorizationId: auth.id,
      updatedAt: new Date(),
    }).where(and(
      eq(unmatchedPosDocumentsTable.id, row.id),
      eq(unmatchedPosDocumentsTable.reviewStatus, "pending"),
    ));
    return { kind: "created" as const, auth };
  });
  if (result.kind === "missing") {
    res.status(404).json({ error: "Unmatched POS not found" });
    return;
  }
  if (result.kind === "not-pending") {
    res.status(409).json({ error: "POS review item has already been completed." });
    return;
  }
  if (result.kind === "queued") {
    res.status(409).json({ error: "POS parsing is still in progress; review it after parsing finishes." });
    return;
  }
  if (result.kind === "client-missing") {
    res.status(404).json({ error: "Participant not found" });
    return;
  }
  if (result.kind === "incomplete") {
    res.status(400).json({ error: "The queued POS is missing required authorization fields." });
    return;
  }
  if (result.kind === "relationship") {
    res.status(400).json({ error: relationshipError ?? "Invalid participant link" });
    return;
  }
  if (result.kind === "warning") {
    res.status(200).json(CompleteUnmatchedPosResponse.parse({ saved: false, warnings: [warning] }));
    return;
  }
  await audit(req.user!.id, "create_authorization", "authorization", result.auth.id, `Auth ${result.auth.authNumber} from unmatched POS`);
  await audit(req.user!.id, "confirm_unmatched_pos", "unmatched_pos_document", params.data.id, `Created authorization ${result.auth.id}`);
  const [clientNames, vendorNames] = await Promise.all([
    clientNameMap([result.auth.clientId]),
    vendorNameMap([result.auth.vendorId]),
  ]);
  res.status(201).json(CompleteUnmatchedPosResponse.parse({
    saved: true,
    warnings: warning ? [warning] : [],
    authorization: authorizationJson(result.auth, {
      clientName: clientNames.get(result.auth.clientId),
      vendorName: result.auth.vendorId ? vendorNames.get(result.auth.vendorId) : null,
      totalPaid: 0,
    }),
  }));
});

router.post("/unmatched-pos/:id/review", requireStaff, async (req, res): Promise<void> => {
  const params = ReviewUnmatchedPosParams.safeParse(req.params);
  const body = ReviewUnmatchedPosBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const fields = { ...(body.data.fields ?? {}) };
  if (typeof fields.unitAmount === "string" && !fields.unitAmount.trim()) fields.unitAmount = undefined;
  if (typeof fields.monthlyAmount === "string" && !fields.monthlyAmount.trim()) fields.monthlyAmount = undefined;
  const fieldError = body.data.action === "confirm" || body.data.action === "amend"
    ? reviewFieldValidationError(fields)
    : null;
  if (fieldError) {
    res.status(400).json({ error: fieldError });
    return;
  }
  const action = body.data.action;
  if ((action === "discard" || action === "cancel") && !body.data.reason?.trim()) {
    res.status(400).json({ error: `A nonblank ${action} reason is required.` });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(unmatchedPosDocumentsTable)
      .where(eq(unmatchedPosDocumentsTable.id, params.data.id)).for("update");
    if (!row) return { kind: "missing" as const };
    if (row.parseStatus === "queued") return { kind: "queued" as const };
    if (row.reviewStatus !== "pending") return { kind: "not-pending" as const };
    const now = new Date();

    if (action === "discard") {
      await tx.update(unmatchedPosDocumentsTable).set({
        reviewStatus: "discarded",
        discardReason: body.data.reason!.trim(),
        reviewedBy: req.user!.id,
        reviewedAt: now,
        updatedAt: now,
      }).where(and(
        eq(unmatchedPosDocumentsTable.id, row.id),
        eq(unmatchedPosDocumentsTable.reviewStatus, "pending"),
      ));
      return { kind: "reviewed" as const, reviewStatus: "discarded" as const, authorization: null };
    }

    const clientId = body.data.clientId ?? row.suggestedClientId ?? null;
    let auth:
      | typeof authorizationsTable.$inferSelect
      | undefined;

    if (action === "amend" || action === "cancel") {
      if (row.suggestedAuthorizationId) {
        [auth] = await tx.select().from(authorizationsTable)
          .where(and(eq(authorizationsTable.id, row.suggestedAuthorizationId), notDeleted(authorizationsTable)))
          .for("update");
      } else if (clientId && (fields.authNumber ?? row.authNumber)) {
        [auth] = await tx.select().from(authorizationsTable).where(and(
          eq(authorizationsTable.clientId, clientId),
          eq(authorizationsTable.authNumber, fields.authNumber ?? row.authNumber!),
          notDeleted(authorizationsTable),
        )).for("update");
      }
      if (!auth) return { kind: "authorization-missing" as const };
      if (clientId && auth.clientId !== clientId) return { kind: "participant-mismatch" as const };
    }

    if (action === "cancel") {
      if (auth!.status === "canceled") return { kind: "already-canceled" as const };
      const [before] = await tx.select().from(authorizationsTable)
        .where(eq(authorizationsTable.id, auth!.id)).for("update");
      if (!before || before.status === "canceled") return { kind: "already-canceled" as const };
      const [updated] = await tx.update(authorizationsTable).set({ status: "canceled" })
        .where(and(eq(authorizationsTable.id, before.id), notDeleted(authorizationsTable))).returning();
      if (!updated) return { kind: "authorization-missing" as const };
      await tx.insert(authorizationVersionsTable).values({
        authorizationId: before.id, clientId: before.clientId, vendorId: before.vendorId,
        authNumber: before.authNumber, serviceCode: before.serviceCode, paymentType: before.paymentType,
        activityDescription: before.activityDescription, servicePeriodStart: before.servicePeriodStart,
        servicePeriodEnd: before.servicePeriodEnd, monthlyAmount: before.monthlyAmount,
        oneTimeAmount: before.oneTimeAmount, maxPeriodAmount: before.maxPeriodAmount, units: before.units,
        status: before.status, posNotes: before.posNotes, posPdfUrl: before.posPdfUrl,
        receivedDate: before.receivedDate, isDeleted: before.isDeleted, deletedAt: before.deletedAt,
        deletedBy: before.deletedBy, createdAt: before.createdAt, changedBy: req.user!.id,
        changedFields: ["status"],
      });
      await tx.update(unmatchedPosDocumentsTable).set({
        reviewStatus: "confirmed", reviewedBy: req.user!.id, reviewedAt: now,
        resultingAuthorizationId: updated.id, updatedAt: now,
      }).where(and(
        eq(unmatchedPosDocumentsTable.id, row.id),
        eq(unmatchedPosDocumentsTable.reviewStatus, "pending"),
      ));
      return { kind: "reviewed" as const, reviewStatus: "confirmed" as const, authorization: updated };
    }

    if (action === "amend") {
      const start = fields.servicePeriodStart ?? auth!.servicePeriodStart;
      const end = fields.servicePeriodEnd ?? auth!.servicePeriodEnd;
      const monthlyAmount = fields.monthlyAmount !== undefined ? fields.monthlyAmount : auth!.monthlyAmount;
      const maxPeriodAmount = fields.maxPeriodAmount ?? auth!.maxPeriodAmount;
      if (!start || !end || start > end || !maxPeriodAmount) return { kind: "incomplete" as const };
      if (fields.serviceCode !== undefined && fields.serviceCode !== auth!.serviceCode) {
        return { kind: "unsupported-amendment-field" as const, field: "serviceCode" };
      }
      const nextAuthNumber = fields.authNumber?.trim() ?? auth!.authNumber;
      const [duplicate] = await tx.select({ id: authorizationsTable.id }).from(authorizationsTable).where(and(
        eq(authorizationsTable.clientId, auth!.clientId),
        eq(authorizationsTable.authNumber, nextAuthNumber),
        eq(authorizationsTable.isDeleted, false),
      )).limit(1);
      if (duplicate && duplicate.id !== auth!.id) return { kind: "duplicate" as const };
      const warning = maxAmountWarning({
        monthlyAmount,
        maxPeriodAmount,
        servicePeriodStart: start,
        servicePeriodEnd: end,
      });
      if (warning && !body.data.acceptMaxAmountWarning) return { kind: "warning" as const, warning };
      const updates = {
        authNumber: nextAuthNumber,
        servicePeriodStart: start,
        servicePeriodEnd: end,
        monthlyAmount,
        maxPeriodAmount,
        ...(fields.unitAmount != null ? { oneTimeAmount: fields.unitAmount } : {}),
        ...(fields.units !== undefined ? { units: fields.units } : {}),
        ...(fields.activityDescription !== undefined ? { activityDescription: fields.activityDescription } : {}),
        ...(fields.notes !== undefined ? { posNotes: fields.notes } : {}),
        ...(body.data.vendorId !== undefined ? { vendorId: body.data.vendorId } : {}),
        ...(body.data.paymentType !== undefined && body.data.paymentType !== null
          ? { paymentType: body.data.paymentType }
          : {}),
        posPdfUrl: row.posPdfUrl,
      };
      if (body.data.vendorId) {
        const [vendor] = await tx.select({ id: vendorsTable.id }).from(vendorsTable)
          .where(eq(vendorsTable.id, body.data.vendorId));
        if (!vendor) return { kind: "vendor-missing" as const };
      }
      const [updated] = await tx.update(authorizationsTable).set(updates)
        .where(and(eq(authorizationsTable.id, auth!.id), notDeleted(authorizationsTable))).returning();
      if (!updated) return { kind: "authorization-missing" as const };
      await tx.insert(authorizationVersionsTable).values({
        authorizationId: auth!.id, clientId: auth!.clientId, vendorId: auth!.vendorId,
        authNumber: auth!.authNumber, serviceCode: auth!.serviceCode, paymentType: auth!.paymentType,
        activityDescription: auth!.activityDescription, servicePeriodStart: auth!.servicePeriodStart,
        servicePeriodEnd: auth!.servicePeriodEnd, monthlyAmount: auth!.monthlyAmount,
        oneTimeAmount: auth!.oneTimeAmount, maxPeriodAmount: auth!.maxPeriodAmount, units: auth!.units,
        status: auth!.status, posNotes: auth!.posNotes, posPdfUrl: auth!.posPdfUrl,
        receivedDate: auth!.receivedDate, isDeleted: auth!.isDeleted, deletedAt: auth!.deletedAt,
        deletedBy: auth!.deletedBy, createdAt: auth!.createdAt, changedBy: req.user!.id,
        changedFields: Object.keys(updates),
      });
      await tx.update(unmatchedPosDocumentsTable).set({
        reviewStatus: "confirmed", reviewedBy: req.user!.id, reviewedAt: now,
        resultingAuthorizationId: updated.id, updatedAt: now,
      }).where(and(
        eq(unmatchedPosDocumentsTable.id, row.id),
        eq(unmatchedPosDocumentsTable.reviewStatus, "pending"),
      ));
      return { kind: "reviewed" as const, reviewStatus: "confirmed" as const, authorization: updated };
    }

    const selectedClientId = clientId;
    const authNumber = fields.authNumber ?? row.authNumber;
    const serviceCode = fields.serviceCode ?? row.serviceCode;
    const servicePeriodStart = fields.servicePeriodStart ?? row.servicePeriodStart;
    const servicePeriodEnd = fields.servicePeriodEnd ?? row.servicePeriodEnd;
    const maxPeriodAmount = fields.maxPeriodAmount ?? row.maxPeriodAmount;
    if (!selectedClientId || !authNumber?.trim() || !serviceCode || !servicePeriodStart ||
      !servicePeriodEnd || servicePeriodStart > servicePeriodEnd || !maxPeriodAmount) {
      return { kind: "incomplete" as const };
    }
    if (!["459", "024", "490"].includes(serviceCode)) return { kind: "invalid-service-code" as const };
    const [client] = await tx.select().from(clientsTable)
      .where(and(eq(clientsTable.id, selectedClientId), eq(clientsTable.isDeleted, false)));
    if (!client) return { kind: "client-missing" as const };
    const relationshipError = (await validateParticipantLinks(tx as unknown as typeof db, selectedClientId, {})).error;
    if (relationshipError) return { kind: "relationship" as const, relationshipError };

    const monthlyAmount = fields.monthlyAmount !== undefined ? fields.monthlyAmount : row.monthlyAmount;
    const warning = maxAmountWarning({
      monthlyAmount,
      maxPeriodAmount,
      servicePeriodStart,
      servicePeriodEnd,
    });
    if (warning && !body.data.acceptMaxAmountWarning) return { kind: "warning" as const, warning };
    const [duplicate] = await tx.select({ id: authorizationsTable.id }).from(authorizationsTable)
      .where(and(
        eq(authorizationsTable.clientId, selectedClientId),
        eq(authorizationsTable.authNumber, authNumber.trim()),
        notDeleted(authorizationsTable),
      )).limit(1);
    if (duplicate) return { kind: "duplicate" as const };
    const [created] = await tx.insert(authorizationsTable).values({
      clientId: selectedClientId,
      vendorId: body.data.vendorId ?? null,
      authNumber: authNumber.trim(),
      serviceCode: serviceCode as "459" | "024" | "490",
      paymentType: body.data.paymentType ?? derivePaymentType(serviceCode),
      activityDescription: fields.activityDescription !== undefined ? fields.activityDescription : row.activityDescription,
      servicePeriodStart,
      servicePeriodEnd,
      monthlyAmount,
      oneTimeAmount: fields.unitAmount ?? null,
      maxPeriodAmount,
      units: fields.units !== undefined ? fields.units : row.units,
      posPdfUrl: row.posPdfUrl,
      posNotes: fields.notes !== undefined ? fields.notes : row.posNotes,
      status: "active",
    }).returning();
    await advanceReferralForAuthorization(tx as unknown as typeof db, created, req.user!.id);
    await tx.update(unmatchedPosDocumentsTable).set({
      reviewStatus: "confirmed", reviewedBy: req.user!.id, reviewedAt: now,
      resultingAuthorizationId: created.id, updatedAt: now,
    }).where(and(
      eq(unmatchedPosDocumentsTable.id, row.id),
      eq(unmatchedPosDocumentsTable.reviewStatus, "pending"),
    ));
    return { kind: "reviewed" as const, reviewStatus: "confirmed" as const, authorization: created };
  });

  if (outcome.kind === "missing") {
    res.status(404).json({ error: "POS review item not found." });
    return;
  }
  if (outcome.kind === "not-pending") {
    res.status(409).json({ error: "POS review item has already been completed." });
    return;
  }
  if (outcome.kind === "queued") {
    res.status(409).json({ error: "POS parsing is still in progress; review it after parsing finishes." });
    return;
  }
  if (outcome.kind === "authorization-missing") {
    res.status(404).json({ error: "Matching authorization not found." });
    return;
  }
  if (outcome.kind === "client-missing") {
    res.status(404).json({ error: "Participant not found." });
    return;
  }
  if (outcome.kind === "participant-mismatch") {
    res.status(400).json({ error: "Selected participant does not own the matching authorization." });
    return;
  }
  if (outcome.kind === "unsupported-amendment-field") {
    res.status(400).json({ error: `${outcome.field} cannot be changed when amending an existing authorization.` });
    return;
  }
  if (outcome.kind === "vendor-missing") {
    res.status(404).json({ error: "Vendor not found." });
    return;
  }
  if (outcome.kind === "already-canceled") {
    res.status(409).json({ error: "Authorization is already canceled." });
    return;
  }
  if (outcome.kind === "incomplete") {
    res.status(400).json({ error: "The POS is missing required authorization fields." });
    return;
  }
  if (outcome.kind === "invalid-service-code") {
    res.status(400).json({ error: "Service code must be 459, 024, or 490." });
    return;
  }
  if (outcome.kind === "relationship") {
    res.status(400).json({ error: outcome.relationshipError });
    return;
  }
  if (outcome.kind === "duplicate") {
    res.status(409).json({ error: "This participant already has that authorization number; amend the matching authorization instead." });
    return;
  }
  if (outcome.kind === "warning") {
    res.json(ReviewUnmatchedPosResponse.parse({
      saved: false,
      warnings: [outcome.warning],
      reviewStatus: "pending",
      resultingAuthorizationId: null,
    }));
    return;
  }
  const actionLabel = action === "discard" ? "discard" : action;
  await audit(
    req.user!.id,
    `${actionLabel}_unmatched_pos`,
    "unmatched_pos_document",
    params.data.id,
    action === "discard"
      ? body.data.reason!.trim()
      : action === "cancel"
        ? `${body.data.reason!.trim()} · ${outcome.authorization ? `Authorization ${outcome.authorization.authNumber} (${outcome.authorization.id})` : ""}`
      : outcome.authorization
        ? `Authorization ${outcome.authorization.authNumber} (${outcome.authorization.id})`
        : "",
  );
  const result = ReviewUnmatchedPosResponse.parse({
    saved: true,
    warnings: [],
    reviewStatus: outcome.reviewStatus,
    resultingAuthorizationId: outcome.authorization?.id ?? null,
  });
  res.json(result);
});

router.post("/authorizations/parse-pdf", requireStaff, async (req, res): Promise<void> => {
  const parsed = ParseAuthorizationPdfBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const fields = await parsePosPdf(parsed.data.pdfBase64);
    await audit(req.user!.id, "parse_pos_pdf", "authorization", undefined, parsed.data.fileName);
    res.json(ParseAuthorizationPdfResponse.parse({ success: true, error: null, fields }));
  } catch (err) {
    req.log.error({ err }, "POS PDF parse failed");
    res.json(
      ParseAuthorizationPdfResponse.parse({
        success: false,
        error: "Could not extract fields from this PDF. Please enter the authorization manually.",
      }),
    );
  }
});

export default router;
