import { Router, type IRouter } from "express";
import { eq, and, ilike, or, asc, desc, count, sql, gte, lte, type SQL } from "drizzle-orm";
import { db, vendorsTable } from "@workspace/db";
import {
  ListVendorsQueryParams,
  ListVendorsResponse,
  CreateVendorBody,
  CreateVendorResponse,
  GetVendorResponse,
  UpdateVendorBody,
  UpdateVendorResponse,
  UploadVendorW9Body,
  UploadVendorW9Response,
  UpdateVendorContactBody,
  UpdateVendorContactResponse,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, audit } from "../lib/auth";
import { vendorJson } from "../lib/serializers";
import { sortedOrder } from "../lib/sorting";

const router: IRouter = Router();

const nullableVendorFields = [
  "altaVendorNumber", "ein", "billingAddress", "serviceAddress",
  "phone", "email", "contactPerson", "w9DocumentUrl",
] as const;

function normalizeVendorData(data: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...data };
  if (typeof normalized.name === "string") normalized.name = normalized.name.trim();
  for (const field of nullableVendorFields) {
    if (typeof normalized[field] === "string" && normalized[field].trim() === "") normalized[field] = null;
  }
  return normalized;
}

function isDuplicateNameError(error: unknown): boolean {
  let current = error as { code?: string; constraint?: string; cause?: unknown } | undefined;
  while (current) {
    if (current.code === "23505" && (current.constraint?.includes("vendors_name_lower_unique") ?? true)) return true;
    current = current.cause as typeof current;
  }
  return false;
}

router.get("/vendors", requireAuth, async (req, res): Promise<void> => {
  const query = ListVendorsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.startDate && query.data.endDate && query.data.startDate > query.data.endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const conditions: SQL[] = [];
  // Role scoping — mirrors the payments/audit-log SQL-WHERE pattern:
  // vendor users only see their own vendor record.
  const u = req.user!;
  if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    conditions.push(eq(vendorsTable.id, u.linkedRecordId ?? ""));
  }
  // Query-string filters
  if (query.data.clientId) {
    conditions.push(sql`exists (
      select 1
      from authorizations
      where authorizations.vendor_id = ${vendorsTable.id}
        and authorizations.client_id = ${query.data.clientId}
        and authorizations.is_deleted = false
      union all
      select 1
      from invoices
      where invoices.vendor_id = ${vendorsTable.id}
        and invoices.client_id = ${query.data.clientId}
        and invoices.is_deleted = false
      union all
      select 1
      from payments
      where payments.vendor_id = ${vendorsTable.id}
        and payments.client_id = ${query.data.clientId}
        and payments.is_deleted = false
    )`);
  }
  if (query.data.search) {
    const like = `%${escapeLike(query.data.search)}%`;
    conditions.push(
      or(
        ilike(vendorsTable.name, like),
        ilike(sql`coalesce(${vendorsTable.altaVendorNumber}, '')`, like),
        ilike(sql`coalesce(${vendorsTable.ein}, '')`, like),
        ilike(sql`coalesce(${vendorsTable.billingAddress}, '')`, like),
        ilike(sql`coalesce(${vendorsTable.serviceAddress}, '')`, like),
        ilike(sql`coalesce(${vendorsTable.phone}, '')`, like),
        ilike(sql`coalesce(${vendorsTable.email}, '')`, like),
        ilike(sql`coalesce(${vendorsTable.contactPerson}, '')`, like),
        ilike(sql`replace(${vendorsTable.w9Status}, '_', ' ')`, like),
        ilike(sql`case when ${vendorsTable.active} then 'active' else 'inactive' end`, like),
        ilike(sql`case when ${vendorsTable.preferred} then 'preferred' else 'not preferred' end`, like),
        sql`${vendorsTable.id} in (select authorizations.vendor_id from authorizations
          where authorizations.is_deleted = false and (
            authorizations.auth_number ilike ${like}
            or coalesce(authorizations.activity_description, '') ilike ${like}
            or authorizations.service_code ilike ${like}
            or replace(authorizations.status, '_', ' ') ilike ${like}
            or authorizations.max_period_amount::text ilike ${like}
          ))`,
        sql`${vendorsTable.id} in (select invoices.vendor_id from invoices
          where invoices.is_deleted = false and (
            invoices.service_month ilike ${like}
            or replace(invoices.status, '_', ' ') ilike ${like}
            or invoices.amount_requested::text ilike ${like}
          ))`,
      )!,
    );
  }
  if (query.data.w9Status) conditions.push(eq(vendorsTable.w9Status, query.data.w9Status));
  if (query.data.startDate) conditions.push(gte(vendorsTable.createdAt, new Date(`${query.data.startDate}T00:00:00.000Z`)));
  if (query.data.endDate) conditions.push(lte(vendorsTable.createdAt, new Date(`${query.data.endDate}T23:59:59.999Z`)));
  if (query.data.active != null) conditions.push(eq(vendorsTable.active, query.data.active === "true"));
  const where = conditions.length ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const order = sortedOrder(
    query.data.sortBy,
    query.data.sortDirection,
    {
      name: sql`lower(${vendorsTable.name})`,
      contactPerson: sql`lower(${vendorsTable.contactPerson})`,
      email: sql`lower(${vendorsTable.email})`,
      w9Status: sql`lower(${vendorsTable.w9Status})`,
      active: sql`${vendorsTable.active}`,
      preferred: sql`${vendorsTable.preferred}`,
      createdAt: sql`${vendorsTable.createdAt}`,
    },
    sql`${vendorsTable.id}`,
    [desc(vendorsTable.preferred), asc(vendorsTable.name), desc(vendorsTable.id)],
  );
  const [[{ total }], vendors] = await Promise.all([
    db.select({ total: count() }).from(vendorsTable).where(where),
    db
      .select()
      .from(vendorsTable)
      .where(where)
      // Preferred vendors first, then alphabetical by name, stable by id.
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
  ]);
  res.json(ListVendorsResponse.parse({ items: vendors.map(vendorJson), total }));
});

router.post("/vendors", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateVendorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = normalizeVendorData(parsed.data);
  if (!data.name) {
    res.status(400).json({ error: "Business name is required" });
    return;
  }
  let vendor;
  try {
    [vendor] = await db.insert(vendorsTable).values(data as typeof vendorsTable.$inferInsert).returning();
  } catch (error) {
    if (isDuplicateNameError(error)) {
      res.status(409).json({ error: "A vendor with this business name already exists" });
      return;
    }
    throw error;
  }
  await audit(req.user!.id, "create_vendor", "vendor", vendor.id, vendor.name);
  res.status(201).json(CreateVendorResponse.parse(vendorJson(vendor)));
});

router.get("/vendors/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const u = req.user!;
  if (u.role === "vendor" && u.linkedRecordId !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, id));
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  res.json(GetVendorResponse.parse(vendorJson(vendor)));
});

router.patch("/vendors/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateVendorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = normalizeVendorData(parsed.data);
  if ("name" in data && !data.name) {
    res.status(400).json({ error: "Business name cannot be blank" });
    return;
  }
  let vendor;
  try {
    [vendor] = await db.update(vendorsTable).set(data as typeof vendorsTable.$inferInsert).where(eq(vendorsTable.id, id)).returning();
  } catch (error) {
    if (isDuplicateNameError(error)) {
      res.status(409).json({ error: "A vendor with this business name already exists" });
      return;
    }
    throw error;
  }
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  await audit(req.user!.id, "update_vendor", "vendor", vendor.id);
  res.json(UpdateVendorResponse.parse(vendorJson(vendor)));
});

// Attach an uploaded W-9 document. Allowed for staff, or a vendor user on
// their own record. Only touches w9DocumentUrl/w9Status — nothing else.
router.patch("/vendors/:id/w9", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const u = req.user!;
  const isOwnVendor = u.role === "vendor" && u.linkedRecordType === "vendor" && u.linkedRecordId === id;
  if (u.role !== "staff" && !isOwnVendor) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const parsed = UploadVendorW9Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [vendor] = await db
    .update(vendorsTable)
    .set({ w9DocumentUrl: parsed.data.w9DocumentUrl, w9Status: "on_file" })
    .where(eq(vendorsTable.id, id))
    .returning();
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  await audit(req.user!.id, "upload_w9", "vendor", vendor.id, parsed.data.w9DocumentUrl);
  res.json(UploadVendorW9Response.parse(vendorJson(vendor)));
});

// Scoped self-edit: staff, or a vendor user on their own record, may update
// only contact fields (email/phone/contactPerson/billing/service address).
// Nothing else (name, altaVendorNumber, w9Status, flags) is touched here.
router.patch("/vendors/:id/contact", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const u = req.user!;
  const isOwnVendor = u.role === "vendor" && u.linkedRecordType === "vendor" && u.linkedRecordId === id;
  if (u.role !== "staff" && !isOwnVendor) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const parsed = UpdateVendorContactBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [vendor] = await db
    .update(vendorsTable)
    .set(normalizeVendorData(parsed.data) as typeof vendorsTable.$inferInsert)
    .where(eq(vendorsTable.id, id))
    .returning();
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  await audit(u.id, "update_vendor_contact", "vendor", vendor.id);
  res.json(UpdateVendorContactResponse.parse(vendorJson(vendor)));
});

export default router;
