import { Router, type IRouter } from "express";
import { eq, desc, and, count, sql, ilike, or, lte, gte, inArray, type SQL } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, authorizationsTable, authorizationVersionsTable, paymentsTable, paymentAllocationsTable, usersTable, unmatchedPosDocumentsTable, clientsTable } from "@workspace/db";
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

const router: IRouter = Router();

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

function normalizeMatchValue(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

async function findPosClient(fields: { uciNumber?: string | null; clientName?: string | null }) {
  const uci = normalizeMatchValue(fields.uciNumber);
  if (uci) {
    const [match] = await db.select().from(clientsTable).where(and(
      sql`lower(trim(${clientsTable.uciNumber})) = ${uci}`,
      eq(clientsTable.isDeleted, false),
    )).limit(1);
    if (match) return { method: "uci" as const, client: match };
  }
  const name = normalizeMatchValue(fields.clientName);
  if (name) {
    const [match] = await db.select().from(clientsTable).where(and(
      sql`lower(trim(${clientsTable.firstName} || ' ' || ${clientsTable.lastName})) = ${name}`,
      eq(clientsTable.isDeleted, false),
    )).limit(1);
    if (match) return { method: "name" as const, client: match };
  }
  return { method: "none" as const, client: null };
}

function unmatchedPosJson(row: typeof unmatchedPosDocumentsTable.$inferSelect) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
  const parsed = ListUnmatchedPosQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, limit: rawLimit, offset: rawOffset } = parsed.data;
  const limit = Math.min(Math.max(rawLimit ?? 50, 1), 1000);
  const offset = Math.max(rawOffset ?? 0, 0);
  const conditions: SQL[] = [];
  if (search?.trim()) {
    const like = `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(
      ilike(unmatchedPosDocumentsTable.sourceFileName, like),
      ilike(unmatchedPosDocumentsTable.clientName, like),
      ilike(unmatchedPosDocumentsTable.uciNumber, like),
      ilike(unmatchedPosDocumentsTable.authNumber, like),
    )!);
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(unmatchedPosDocumentsTable).where(where),
    db.select().from(unmatchedPosDocumentsTable).where(where)
      .orderBy(desc(unmatchedPosDocumentsTable.createdAt), desc(unmatchedPosDocumentsTable.id))
      .limit(limit).offset(offset),
  ]);
  res.json(ListUnmatchedPosResponse.parse({ items: rows.map(unmatchedPosJson), total }));
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
  res.json(GetUnmatchedPosResponse.parse(unmatchedPosJson(row)));
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
    await tx.delete(unmatchedPosDocumentsTable).where(eq(unmatchedPosDocumentsTable.id, row.id));
    return { kind: "created" as const, auth };
  });
  if (result.kind === "missing") {
    res.status(404).json({ error: "Unmatched POS not found" });
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

const PARSE_PROMPT = `You are extracting fields from a California Regional Center Purchase of Service (POS) authorization PDF. Carefully inspect the entire document, including Alta accounting notes, footer text, adjustment details, and handwritten or appended notes. Extract those notes into posNotes verbatim: preserve the original wording, punctuation, ordering, and line breaks. Do not interpret, summarize, normalize, or paraphrase notes. Return ONLY a JSON object (no markdown fences, no commentary) with these keys (use null when a value is not present):
{
  "clientName": string|null,
  "clientAddress": string|null,
  "clientPhone": string|null,
  "uciNumber": string|null,
  "authNumber": string|null,
  "serviceCode": string|null,       // usually 459, 024, or 490
  "activityDescription": string|null,
  "servicePeriodStart": string|null, // YYYY-MM-DD
  "servicePeriodEnd": string|null,   // YYYY-MM-DD
  "units": number|null,
  "monthlyAmount": string|null,      // decimal string, no $ sign
  "maxPeriodAmount": string|null,    // decimal string, no $ sign
  "caseworkerName": string|null,
  "posNotes": string|null
}`;

router.post("/authorizations/parse-pdf", requireStaff, async (req, res): Promise<void> => {
  const parsed = ParseAuthorizationPdfBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: parsed.data.pdfBase64 },
            },
            { type: "text", text: PARSE_PROMPT },
          ],
        },
      ],
    });
    const block = message.content[0];
    const text = block?.type === "text" ? block.text : "";
    const jsonText = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
     const fields = JSON.parse(jsonText);
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
