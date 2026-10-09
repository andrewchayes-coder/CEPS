import { Router, type IRouter } from "express";
import { and, eq, desc } from "drizzle-orm";
import { db, referralsTable, clientsTable, usersTable, vendorsTable, auditLogTable } from "@workspace/db";
import { requireAuth, audit } from "../lib/auth";
import { createReferralConfirmationPdf } from "../lib/referral-confirmation-pdf";

const router: IRouter = Router();
router.get("/referrals/:id/confirmation.pdf", requireAuth, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    res.status(404).json({ error: "Referral not found" }); return;
  }
  const user = req.user!;
  // A linked parent/vendor must never acquire this permission through an FK.
  if (user.role !== "staff" && user.role !== "service_coordinator") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const bytes = await db.transaction(async tx => {
    // Lock against reassignment while evaluating download authorization.
    const [referral] = await tx.select().from(referralsTable).where(eq(referralsTable.id, id)).for("share");
    if (!referral) return { status: 404 };
    if (user.role !== "staff" && referral.serviceCoordinatorId !== user.id && referral.submittedByUserId !== user.id) return { status: 403 };
    const [client] = await tx.select().from(clientsTable).where(and(eq(clientsTable.id, referral.clientId), eq(clientsTable.isDeleted, false)));
    if (!client) return { status: 404 };
    const [submitter] = referral.submittedByUserId ? await tx.select({ name: usersTable.name, role: usersTable.role })
      .from(usersTable).where(eq(usersTable.id, referral.submittedByUserId)) : [];
    const [vendor] = referral.vendorId ? await tx.select().from(vendorsTable).where(eq(vendorsTable.id, referral.vendorId)) : [];
    const [upload] = referral.supportingDocumentUrl ? await tx.select({ detail: auditLogTable.detail })
      .from(auditLogTable).where(and(eq(auditLogTable.action, "file.upload_requested"),
        eq(auditLogTable.entityType, "upload"), eq(auditLogTable.entityId, referral.supportingDocumentUrl)))
      .orderBy(desc(auditLogTable.createdAt)).limit(1) : [];
    const filename = upload?.detail?.replace(/ \((?:application\/pdf|image\/png|image\/jpeg), \d+ bytes\)$/, "");
    const pdf = await createReferralConfirmationPdf(referral, client, vendor, submitter, filename);
    await audit(user.id, "download_referral_confirmation", "referral", referral.id, undefined, tx as unknown as typeof db);
    return { pdf };
  });
  if ("status" in bytes) {
    res.status(bytes.status!).json({ error: bytes.status === 403 ? "Forbidden" : "Referral not found" }); return;
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="CEPS-referral-${id.slice(0, 8)}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(bytes.pdf);
});
export default router;
