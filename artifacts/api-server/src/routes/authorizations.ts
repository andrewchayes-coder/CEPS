import { Router, type IRouter } from "express";
import { eq, desc, and, count, sql, type SQL } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, authorizationsTable, referralsTable, vendorsTable, paymentsTable } from "@workspace/db";
import {
  ListAuthorizationsQueryParams,
  ListAuthorizationsResponse,
  CreateAuthorizationBody,
  CreateAuthorizationResponse,
  GetAuthorizationResponse,
  UpdateAuthorizationBody,
  UpdateAuthorizationResponse,
  ParseAuthorizationPdfBody,
  ParseAuthorizationPdfResponse,
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

const router: IRouter = Router();

// Normalize empty strings from the form to null for optional/numeric columns.
function cleanAuthFields<T extends Record<string, unknown>>(obj: T): T {
  const out = { ...obj };
  for (const k of ["vendorId", "activityDescription", "monthlyAmount", "oneTimeAmount", "receivedDate", "posPdfUrl"] as const) {
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

router.get("/authorizations", requireAuth, async (req, res): Promise<void> => {
  const query = ListAuthorizationsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conditions: SQL[] = [notDeleted(authorizationsTable)];
  // Role scoping — mirrors the payments/audit-log SQL-WHERE pattern:
  // vendors see only their own vendor's auths; parent/self only their linked
  // client's auths.
  const u = req.user!;
  if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    conditions.push(eq(authorizationsTable.vendorId, u.linkedRecordId ?? ""));
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    conditions.push(eq(authorizationsTable.clientId, u.linkedRecordId ?? ""));
  }
  // Query-string filters on plain columns.
  if (query.data.clientId) conditions.push(eq(authorizationsTable.clientId, query.data.clientId));
  if (query.data.vendorId) conditions.push(eq(authorizationsTable.vendorId, query.data.vendorId));

  // The `status` and `expiringWithinDays` filters operate on the *derived*
  // effective status / days-until-expiry (see effectiveAuthStatus &
  // authorizationJson). We replicate that derivation in SQL so filtering and
  // pagination stay at the DB level with identical semantics.
  //   totalPaid  = coalesce(sum(non-deleted payments for this auth), 0)
  //   effective  = pending | expired (period end past) | exhausted (paid ≥ max) | status
  //   days       = ceil((servicePeriodEnd@00:00Z − now) / 1 day)
  const totalPaidSql = sql`coalesce((select sum(${paymentsTable.amount}) from ${paymentsTable} where ${paymentsTable.authorizationId} = ${authorizationsTable.id} and ${paymentsTable.isDeleted} = false), 0)`;
  const effectiveStatusSql = sql`case when ${authorizationsTable.status} = 'pending' then 'pending' when ${authorizationsTable.servicePeriodEnd} < (now() at time zone 'utc')::date then 'expired' when ${totalPaidSql} >= ${authorizationsTable.maxPeriodAmount} then 'exhausted' else ${authorizationsTable.status} end`;
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
  const [[{ total }], auths] = await Promise.all([
    db.select({ total: count() }).from(authorizationsTable).where(where),
    db
      .select()
      .from(authorizationsTable)
      .where(where)
      .orderBy(desc(authorizationsTable.createdAt), desc(authorizationsTable.id))
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
  const warning = maxAmountWarning(d);
  if (warning && !d.acceptMaxAmountWarning) {
    res.status(200).json(CreateAuthorizationResponse.parse({ saved: false, warnings: [warning] }));
    return;
  }
  const { acceptMaxAmountWarning: _accept, ...values } = d;
  const [auth] = await db
    .insert(authorizationsTable)
    .values({
      ...cleanAuthFields(values),
      paymentType: d.paymentType ?? derivePaymentType(d.serviceCode),
      status: d.status ?? "active",
    })
    .returning();

  // Advance the client's referral: pending_auth -> pending_w9 (or pending_invoice if W-9 on file)
  const referrals = await db.select().from(referralsTable).where(eq(referralsTable.clientId, auth.clientId));
  const pending = referrals.find((r) => r.status === "pending_auth" || r.status === "intake");
  if (pending) {
    let next = "pending_w9";
    if (auth.vendorId) {
      const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, auth.vendorId));
      if (vendor?.w9Status === "on_file") next = "pending_invoice";
    }
    await db
      .update(referralsTable)
      .set({ status: next, altaAuthReceivedAt: new Date() })
      .where(eq(referralsTable.id, pending.id));
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
  if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    if (auth.vendorId !== u.linkedRecordId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    if (auth.clientId !== u.linkedRecordId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
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
  const [before] = await db
    .select()
    .from(authorizationsTable)
    .where(and(eq(authorizationsTable.id, id), notDeleted(authorizationsTable)));
  if (!before) {
    res.status(404).json({ error: "Authorization not found" });
    return;
  }
  const [auth] = await db
    .update(authorizationsTable)
    .set(updates)
    .where(and(eq(authorizationsTable.id, id), notDeleted(authorizationsTable)))
    .returning();
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

router.delete("/authorizations/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [auth] = await db
    .update(authorizationsTable)
    .set({ isDeleted: true, deletedAt: new Date(), deletedBy: req.user!.id })
    .where(and(eq(authorizationsTable.id, id), notDeleted(authorizationsTable)))
    .returning();
  if (!auth) {
    res.status(404).json({ error: "Authorization not found" });
    return;
  }
  await audit(req.user!.id, "delete_authorization", "authorization", auth.id, `Auth ${auth.authNumber}`);
  res.json({ ok: true });
});

const PARSE_PROMPT = `You are extracting fields from a California Regional Center Purchase of Service (POS) authorization PDF. Return ONLY a JSON object (no markdown fences, no commentary) with these keys (use null when a value is not present):
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
  "caseworkerName": string|null
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
