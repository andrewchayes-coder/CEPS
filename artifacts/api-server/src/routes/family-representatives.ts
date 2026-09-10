import { Router, type IRouter } from "express";
import { and, eq, desc, asc, isNull, gt, inArray, sql } from "drizzle-orm";
import {
  db,
  clientsTable,
  familyRepresentativesTable,
  magicLinksTable,
  usersTable,
  sessionsTable,
  referralsTable,
} from "@workspace/db";
import {
  ListFamilyRepresentativesQueryParams,
  ListFamilyRepresentativesResponse,
  CreateFamilyRepresentativeBody,
  CreateFamilyRepresentativeResponse,
  GetFamilyRepresentativeResponse,
  UpdateFamilyRepresentativeBody,
  UpdateFamilyRepresentativeResponse,
  DeleteFamilyRepresentativeResponse,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, audit } from "../lib/auth";
import { notDeleted, diffDetail } from "../lib/serializers";
import { iso } from "../lib/auth";

const router: IRouter = Router();
const nullable = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;
const json = (r: typeof familyRepresentativesTable.$inferSelect) => ({
  id: r.id, clientId: r.clientId, name: r.name, relationship: r.relationship,
  phone: r.phone, email: r.email, address: r.address, isPrimary: r.isPrimary,
  userId: r.userId, createdBy: r.createdBy, createdAt: iso(r.createdAt),
  hasPortalAccount: !!r.userId, portalAccountStatus: r.userId ? "active" : "none",
});
function permitted(req: { user?: { role: string; linkedRecordType: string | null; linkedRecordId: string | null } }, clientId: string) {
  const u = req.user!;
    return u.role === "staff" || u.role === "service_coordinator"
    || (["parent_guardian", "self"].includes(u.role)
      && u.linkedRecordType === "client"
      && u.linkedRecordId === clientId);
}
async function getRep(id: string) {
  const [row] = await db.select().from(familyRepresentativesTable)
    .where(and(eq(familyRepresentativesTable.id, id), notDeleted(familyRepresentativesTable)));
  return row;
}

router.get("/family-representatives", requireAuth, async (req, res) => {
  const parsed = ListFamilyRepresentativesQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!permitted(req, parsed.data.clientId)) { res.status(403).json({ error: "Forbidden" }); return; }
  const rows = await db.select().from(familyRepresentativesTable).where(and(
    eq(familyRepresentativesTable.clientId, parsed.data.clientId), notDeleted(familyRepresentativesTable),
  ));
  const invites = await db.select({ familyRepresentativeId: magicLinksTable.familyRepresentativeId })
    .from(magicLinksTable)
    .where(and(isNull(magicLinksTable.usedAt), gt(magicLinksTable.expiresAt, new Date())));
  const invited = new Set(invites.map((i) => i.familyRepresentativeId).filter((id): id is string => !!id));
  const payload = rows
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name))
    .map((r) => {
      const portalAccountStatus = r.userId ? "active" : invited.has(r.id) ? "invited" : "none";
      return { ...json(r), hasPortalAccount: portalAccountStatus !== "none", portalAccountStatus };
    });
  res.json(ListFamilyRepresentativesResponse.parse(payload));
});
router.post("/family-representatives", requireStaff, async (req, res) => {
  const parsed = CreateFamilyRepresentativeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const d = parsed.data;
  const name = d.name.trim();
  if (!name) { res.status(400).json({ error: "Name must not be blank" }); return; }
  const result = await db.transaction(async (tx) => {
    const [client] = await tx.select().from(clientsTable)
      .where(and(eq(clientsTable.id, d.clientId), notDeleted(clientsTable)))
      .for("share");
    if (!client) return { error: "Client not found" as const };
    const [row] = await tx.insert(familyRepresentativesTable).values({
      clientId: d.clientId, name, relationship: d.relationship ?? null,
      phone: nullable(d.phone) as string | null, email: nullable(d.email) as string | null,
      address: nullable(d.address) as string | null, isPrimary: d.isPrimary ?? false,
      userId: null, createdBy: req.user!.id,
    }).returning();
    await audit(req.user!.id, "create_family_representative", "family_representative", row.id, `Created ${name}`, tx as unknown as typeof db);
    return { row };
  });
  if ("error" in result) { res.status(400).json({ error: result.error }); return; }
  const { row } = result;
  res.status(201).json(CreateFamilyRepresentativeResponse.parse(json(row)));
});
router.get("/family-representatives/:id", requireAuth, async (req, res) => {
  const row = await getRep(String(req.params.id));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (!permitted(req, row.clientId)) { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(GetFamilyRepresentativeResponse.parse(json(row)));
});
router.patch("/family-representatives/:id", requireAuth, async (req, res) => {
  const parsed = UpdateFamilyRepresentativeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const d = parsed.data;
  const familyUser = req.user!.role === "parent_guardian" || req.user!.role === "self";
  if (req.user!.role !== "staff" && !familyUser) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const disallowed = Object.keys(req.body ?? {}).filter((k) => !["name", "relationship", "phone", "email", "address"].includes(k));
  if (familyUser && disallowed.length > 0) {
    res.status(403).json({ error: `You may only update contact information (not: ${disallowed.join(", ")})` });
    return;
  }
  if (d.name !== undefined && !d.name.trim()) { res.status(400).json({ error: "Name must not be blank" }); return; }
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(familyRepresentativesTable)
      .where(and(eq(familyRepresentativesTable.id, String(req.params.id)), notDeleted(familyRepresentativesTable))).for("update");
    if (!row) return { error: "Family representative not found" as const, status: 404 as const };
    if (familyUser && (row.userId !== req.user!.id || !permitted(req, row.clientId))) {
      return { error: "Forbidden" as const, status: 403 as const };
    }
    const values: Record<string, unknown> = {};
    for (const key of ["name", "relationship", "phone", "email", "address", "isPrimary"] as const) {
      if (key in d) values[key] = key === "name" ? d[key]?.trim() : nullable(d[key]);
    }
    const [updated] = await tx.update(familyRepresentativesTable).set(values).where(eq(familyRepresentativesTable.id, row.id)).returning();
    await audit(req.user!.id, "update_family_representative", "family_representative", row.id, diffDetail(row, updated, Object.keys(values)), tx as unknown as typeof db);
    return { row: updated };
  });
  if ("error" in result) { res.status(result.status ?? 404).json({ error: result.error }); return; }
  const { row: updated } = result;
  res.json(UpdateFamilyRepresentativeResponse.parse(json(updated)));
});
router.delete("/family-representatives/:id", requireStaff, async (req, res) => {
  const result = await db.transaction(async (tx) => {
    const representativeId = String(req.params.id);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${representativeId}))`);
    const [row] = await tx.select().from(familyRepresentativesTable)
      .where(and(eq(familyRepresentativesTable.id, representativeId), notDeleted(familyRepresentativesTable))).for("update");
    if (!row) return false;
    await tx.update(familyRepresentativesTable).set({ isDeleted: true, deletedAt: new Date(), deletedBy: req.user!.id }).where(eq(familyRepresentativesTable.id, row.id));
    // Revoke every outstanding credential that could still provision or reach
    // this representative.  Do this in the same transaction as the soft
    // delete so a concurrently accepted invite cannot recreate access.
    await tx.update(magicLinksTable).set({ usedAt: new Date() }).where(and(
      eq(magicLinksTable.familyRepresentativeId, row.id),
      eq(magicLinksTable.purpose, "invite"),
      isNull(magicLinksTable.usedAt),
    ));
    const targetedReferrals = await tx.select({ id: referralsTable.id })
      .from(referralsTable)
      .where(eq(referralsTable.intakeSentToFamilyRepId, row.id))
      .for("share");
    if (targetedReferrals.length) {
      await tx.update(magicLinksTable).set({ usedAt: new Date() }).where(and(
        eq(magicLinksTable.purpose, "signature"),
        isNull(magicLinksTable.usedAt),
        inArray(magicLinksTable.referralId, targetedReferrals.map((r) => r.id)),
      ));
    }
    await audit(req.user!.id, "delete_family_representative", "family_representative", row.id, `Deleted ${row.name}`, tx as unknown as typeof db);
    if (row.userId) {
      const [user] = await tx.update(usersTable).set({ active: false }).where(eq(usersTable.id, row.userId)).returning();
      await tx.delete(sessionsTable).where(eq(sessionsTable.userId, row.userId));
      if (user) await audit(req.user!.id, "delete_user", "user", user.id, `Deactivated ${user.email}`, tx as unknown as typeof db);
    }
    return true;
  });
  if (!result) { res.status(404).json({ error: "Family representative not found" }); return; }
  res.json(DeleteFamilyRepresentativeResponse.parse({ ok: true }));
});
export default router;