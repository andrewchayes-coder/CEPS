import { Router, type IRouter } from "express";
import { eq, and, ilike, asc, desc, count, sql, type SQL } from "drizzle-orm";
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

const router: IRouter = Router();

router.get("/vendors", requireAuth, async (req, res): Promise<void> => {
  const query = ListVendorsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
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
  if (query.data.search) conditions.push(ilike(vendorsTable.name, `%${escapeLike(query.data.search)}%`));
  if (query.data.w9Status) conditions.push(eq(vendorsTable.w9Status, query.data.w9Status));
  if (query.data.active != null) conditions.push(eq(vendorsTable.active, query.data.active));
  const where = conditions.length ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const [[{ total }], vendors] = await Promise.all([
    db.select({ total: count() }).from(vendorsTable).where(where),
    db
      .select()
      .from(vendorsTable)
      .where(where)
      // Preferred vendors first, then alphabetical by name, stable by id.
      .orderBy(desc(vendorsTable.preferred), asc(vendorsTable.name), desc(vendorsTable.id))
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
  const [vendor] = await db.insert(vendorsTable).values(parsed.data).returning();
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
  const [vendor] = await db.update(vendorsTable).set(parsed.data).where(eq(vendorsTable.id, id)).returning();
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
    .set(parsed.data)
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
