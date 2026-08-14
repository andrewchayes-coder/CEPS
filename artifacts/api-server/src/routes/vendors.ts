import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, vendorsTable } from "@workspace/db";
import {
  ListVendorsQueryParams,
  ListVendorsResponse,
  CreateVendorBody,
  CreateVendorResponse,
  GetVendorResponse,
  UpdateVendorBody,
  UpdateVendorResponse,
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
  let vendors = await db.select().from(vendorsTable);
  const u = req.user!;
  if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    vendors = vendors.filter((v) => v.id === u.linkedRecordId);
  }
  if (query.data.search) {
    const s = query.data.search.toLowerCase();
    vendors = vendors.filter((v) => v.name.toLowerCase().includes(s));
  }
  if (query.data.w9Status) vendors = vendors.filter((v) => v.w9Status === query.data.w9Status);
  if (query.data.active != null) vendors = vendors.filter((v) => v.active === query.data.active);
  // Preferred vendors sort first, then alphabetical
  vendors.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.name.localeCompare(b.name));
  res.json(ListVendorsResponse.parse(vendors.map(vendorJson)));
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

export default router;
