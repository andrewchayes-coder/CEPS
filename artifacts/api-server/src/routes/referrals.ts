import { Router, type IRouter } from "express";
import { eq, and, isNull, gt, desc, count, ilike, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  clientsTable,
  vendorsTable,
  referralsTable,
  magicLinksTable,
  usersTable,
} from "@workspace/db";
import {
  ListReferralsQueryParams,
  ListReferralsResponse,
  CreateReferralBody,
  CreateReferralResponse,
  GetReferralResponse,
  UpdateReferralBody,
  UpdateReferralResponse,
  SendIntakeBody,
  SendIntakeResponse,
  GetSignaturePageResponse,
  SubmitSignatureBody,
  SubmitSignatureResponse,
} from "@workspace/api-zod";
import {
  requireAuth,
  requireStaff,
  requireStaffOrCoordinator,
  audit,
  newToken,
  appBaseUrl,
  hashPassword,
} from "../lib/auth";
import { referralJson, clientNameMap, userNameMap } from "../lib/serializers";
import { sortedOrder } from "../lib/sorting";

const router: IRouter = Router();

async function createSignatureLink(referralId: string, email: string): Promise<string> {
  const token = newToken();
  await db.insert(magicLinksTable).values({
    token,
    email: email.trim().toLowerCase(),
    purpose: "signature",
    referralId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  return `${appBaseUrl()}/sign/${token}`;
}

async function sendIntakeEmail(referralId: string, email: string): Promise<string | null> {
  const link = await createSignatureLink(referralId, email);
  // [CONFIRM] No email provider approved yet. Keep delivery behind this helper
  // so the real provider can replace this development behavior in one place.
  console.info(`[intake-email] Send to ${email.trim().toLowerCase()}: ${link}`);
  return process.env.NODE_ENV === "production" ? null : link;
}

const clean = (value: string | undefined | null): string | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

router.get("/referrals", requireAuth, async (req, res): Promise<void> => {
  const query = ListReferralsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conditions: SQL[] = [];
  // Role scoping — mirrors the audit-log SQL-WHERE pattern:
  // coordinators see only referrals they own; parent/self only their linked
  // client's; vendors see none (forced to an unsatisfiable condition).
  const u = req.user!;
  let vendorEmpty = false;
  if (u.role === "service_coordinator") {
    conditions.push(eq(referralsTable.serviceCoordinatorId, u.id));
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    conditions.push(eq(referralsTable.clientId, u.linkedRecordId ?? ""));
  } else if (u.role === "vendor") {
    vendorEmpty = true;
  }
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  // Query-string filters
  if (query.data.status) conditions.push(eq(referralsTable.status, query.data.status));
  if (query.data.coordinatorId) conditions.push(eq(referralsTable.serviceCoordinatorId, query.data.coordinatorId));
  if (query.data.clientId) conditions.push(eq(referralsTable.clientId, query.data.clientId));
  if (query.data.search) {
    const like = `%${escapeLike(query.data.search)}%`;
    conditions.push(
      or(
        sql`${referralsTable.clientId} in (select id from clients where (first_name || ' ' || last_name) ilike ${like} and is_deleted = false)`,
        sql`${referralsTable.serviceCoordinatorId} in (select id from users where name ilike ${like})`,
      )!,
    );
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
  const offset = Math.max(query.data.offset ?? 0, 0);
  const order = sortedOrder(
    query.data.sortBy,
    query.data.sortDirection,
    {
      referralDate: sql`${referralsTable.referralDate}`,
      clientName: sql`lower((select last_name || ', ' || first_name from clients where id = ${referralsTable.clientId}))`,
      coordinatorName: sql`lower((select name from users where id = ${referralsTable.serviceCoordinatorId}))`,
      serviceType: sql`lower(${referralsTable.intakeFields}->>'serviceType')`,
      status: sql`lower(${referralsTable.status})`,
      createdAt: sql`${referralsTable.createdAt}`,
    },
    sql`${referralsTable.id}`,
    [desc(referralsTable.createdAt), desc(referralsTable.id)],
  );
  if (vendorEmpty) {
    res.json(ListReferralsResponse.parse({ items: [], total: 0 }));
    return;
  }
  const [[{ total }], referrals] = await Promise.all([
    db.select({ total: count() }).from(referralsTable).where(where),
    db
      .select()
      .from(referralsTable)
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
  ]);
  const [clientNames, coordNames] = await Promise.all([
    clientNameMap(referrals.map((r) => r.clientId)),
    userNameMap(referrals.map((r) => r.serviceCoordinatorId)),
  ]);
  res.json(
    ListReferralsResponse.parse({
      items: referrals.map((r) =>
        referralJson(
          r,
          clientNames.get(r.clientId),
          r.serviceCoordinatorId ? coordNames.get(r.serviceCoordinatorId) : null,
        ),
      ),
      total,
    }),
  );
});

router.post("/referrals", requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const parsed = CreateReferralBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const f = parsed.data.intakeFields;
  if (f.vendorAcceptsChecks === false) {
    res.status(400).json({ error: "FMS can only pay vendors who accept checks. This referral cannot be submitted." });
    return;
  }
  if (!f.clientFirstName || !f.clientLastName || !f.clientUci || !f.clientDob) {
    res.status(400).json({ error: "Client first name, last name, DOB and UCI are required" });
    return;
  }

  // Find or create the client by UCI
  let [client] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, f.clientUci));
  if (!client) {
    const contactIsFamily = f.clientIsMinor === true;
    const address = [f.contactStreet, f.contactCity, f.contactState, f.contactZip].filter(Boolean).join(", ");
    [client] = await db
      .insert(clientsTable)
      .values({
        firstName: f.clientFirstName,
        lastName: f.clientLastName,
        dateOfBirth: f.clientDob,
        uciNumber: f.clientUci,
        regionalCenter: f.regionalCenterName,
        preferredLanguage: f.preferredLanguage,
        isMinor: f.clientIsMinor,
        phone: contactIsFamily ? null : f.contactPhone,
        email: contactIsFamily ? null : f.contactEmail,
        address: contactIsFamily ? null : address || null,
        familyRepName: contactIsFamily ? f.familyRepName : null,
        familyRepPhone: contactIsFamily ? f.contactPhone : null,
        familyRepEmail: contactIsFamily ? f.contactEmail : null,
        familyRepAddress: contactIsFamily ? address || null : null,
        assignedCoordinatorId: req.user!.role === "service_coordinator" ? req.user!.id : null,
      })
      .returning();
  }

  // Find or create the vendor by name
  if (f.vendorName) {
    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.name, f.vendorName));
    if (!vendor) {
      const serviceAddress = [f.vendorServiceStreet, f.vendorServiceCity, f.vendorServiceState, f.vendorServiceZip]
        .filter(Boolean)
        .join(", ");
      const billingAddress =
        f.vendorBillingDifferent === "yes"
          ? [f.vendorBillingStreet, f.vendorBillingCity, f.vendorBillingState, f.vendorBillingZip].filter(Boolean).join(", ")
          : serviceAddress;
      await db.insert(vendorsTable).values({
        name: f.vendorName,
        email: f.vendorEmail,
        phone: f.vendorPhone,
        contactPerson: f.vendorContactPerson,
        serviceAddress: serviceAddress || null,
        billingAddress: billingAddress || null,
      });
    }
  }

  // Portal sends '' for untouched optional fields — normalize to null.
  const [referral] = await db
    .insert(referralsTable)
    .values({
      clientId: client.id,
      serviceCoordinatorId: req.user!.role === "service_coordinator" ? req.user!.id : null,
      referralDate: new Date().toISOString().slice(0, 10),
      status: "intake",
      submittedVia: parsed.data.submittedVia ?? "staff_manual_entry",
      intakeFields: f,
      serviceFrequency: parsed.data.serviceFrequency,
      cost: clean(parsed.data.cost),
      paymentSchedule: clean(parsed.data.paymentSchedule),
      paymentTypeRequested: clean(parsed.data.paymentTypeRequested),
      diagnosis: clean(parsed.data.diagnosis),
      eligibilityCategory: clean(parsed.data.eligibilityCategory),
      supportingDocumentUrl: clean(parsed.data.supportingDocumentUrl),
      notes: parsed.data.notes,
    })
    .returning();

  await audit(req.user!.id, "create_referral", "referral", referral.id, `Referral for ${client.firstName} ${client.lastName}`);
  const coordNames = await userNameMap([referral.serviceCoordinatorId]);
  res.status(201).json(
    CreateReferralResponse.parse(
      referralJson(
        referral,
        `${client.firstName} ${client.lastName}`,
        referral.serviceCoordinatorId ? coordNames.get(referral.serviceCoordinatorId) : null,
        client.isMinor,
      ),
    ),
  );
});

router.get("/referrals/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [referral] = await db.select().from(referralsTable).where(eq(referralsTable.id, id));
  if (!referral) {
    res.status(404).json({ error: "Referral not found" });
    return;
  }
  const u = req.user!;
  if (u.role === "service_coordinator" && referral.serviceCoordinatorId !== u.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if ((u.role === "parent_guardian" || u.role === "self") && referral.clientId !== u.linkedRecordId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [clientNames, coordNames, clients] = await Promise.all([
    clientNameMap([referral.clientId]),
    userNameMap([referral.serviceCoordinatorId]),
    db
      .select({ isMinor: clientsTable.isMinor })
      .from(clientsTable)
      .where(eq(clientsTable.id, referral.clientId)),
  ]);
  res.json(
    GetReferralResponse.parse(
      referralJson(
        referral,
        clientNames.get(referral.clientId),
        referral.serviceCoordinatorId ? coordNames.get(referral.serviceCoordinatorId) : null,
        clients[0]?.isMinor,
      ),
    ),
  );
});

router.patch("/referrals/:id", requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateReferralBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { altaAuthReceivedAt, ...rest } = parsed.data;
  const updates: Record<string, unknown> = { ...rest };
  if (altaAuthReceivedAt !== undefined) {
    updates.altaAuthReceivedAt = altaAuthReceivedAt ? new Date(altaAuthReceivedAt) : null;
  }
  // Portal sends '' for untouched optional fields — normalize to null.
  for (const k of ["parentEmail", "cost", "paymentSchedule", "paymentTypeRequested", "diagnosis", "eligibilityCategory", "supportingDocumentUrl"] as const) {
    if (updates[k] === "") updates[k] = null;
  }
  if (updates.parentEmail) updates.parentEmail = String(updates.parentEmail).trim().toLowerCase();
  const [existing] = await db.select().from(referralsTable).where(eq(referralsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Referral not found" });
    return;
  }
  // Coordinators may only edit referrals they own (same rule as the list scoping).
  if (req.user!.role === "service_coordinator" && existing.serviceCoordinatorId !== req.user!.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if ("serviceCoordinatorId" in parsed.data) {
    if (req.user!.role === "service_coordinator") {
      res.status(403).json({ error: "Only staff can reassign a referral" });
      return;
    }
    if (parsed.data.serviceCoordinatorId) {
      const [coordinator] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.id, parsed.data.serviceCoordinatorId),
            eq(usersTable.role, "service_coordinator"),
            eq(usersTable.active, true),
          ),
        );
      if (!coordinator) {
        res.status(400).json({ error: "Service Coordinator must be an active coordinator account" });
        return;
      }
    }
  }
  const [referral] = await db.update(referralsTable).set(updates).where(eq(referralsTable.id, id)).returning();
  if (!referral) {
    res.status(404).json({ error: "Referral not found" });
    return;
  }
  await audit(req.user!.id, "update_referral", "referral", referral.id, parsed.data.status ? `Status: ${parsed.data.status}` : undefined);
  const [clientNames, coordNames] = await Promise.all([
    clientNameMap([referral.clientId]),
    userNameMap([referral.serviceCoordinatorId]),
  ]);
  res.json(
    UpdateReferralResponse.parse(
      referralJson(
        referral,
        clientNames.get(referral.clientId),
        referral.serviceCoordinatorId ? coordNames.get(referral.serviceCoordinatorId) : null,
      ),
    ),
  );
});

router.delete("/referrals/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [referral] = await db.select().from(referralsTable).where(eq(referralsTable.id, id));
  if (!referral) {
    res.status(404).json({ error: "Referral not found" });
    return;
  }
  // A referral is "converted" once its case has gone active — deleting one at
  // that point would orphan authorizations/invoices/payments. Block it.
  if (referral.status === "active") {
    res.status(409).json({
      error: "This referral has been converted to an active client case and cannot be deleted. Close the case instead.",
    });
    return;
  }
  await db.delete(magicLinksTable).where(eq(magicLinksTable.referralId, id));
  await db.delete(referralsTable).where(eq(referralsTable.id, id));
  await audit(req.user!.id, "delete_referral", "referral", id);
  res.json({ ok: true });
});

router.post("/referrals/:id/send-intake", requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = SendIntakeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [referral] = await db.select().from(referralsTable).where(eq(referralsTable.id, id));
  if (!referral) {
    res.status(404).json({ error: "Referral not found" });
    return;
  }
  if (req.user!.role === "service_coordinator" && referral.serviceCoordinatorId !== req.user!.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, referral.clientId));
  if (!client) {
    res.status(404).json({ error: "Participant not found" });
    return;
  }
  if (parsed.data.recipient === "participant" && client.isMinor) {
    res.status(400).json({
      error: "A minor cannot sign for themselves — send to the family rep, guardian, or conservator instead",
    });
    return;
  }
  const recipientEmail = clean(
    parsed.data.recipient === "participant" ? client.email : client.familyRepEmail,
  );
  if (!recipientEmail) {
    const recipientLabel = parsed.data.recipient === "participant" ? "participant" : "family rep";
    res.status(400).json({
      error: `Add an email to the ${recipientLabel} record before sending the intake agreement`,
    });
    return;
  }
  const updates: Record<string, unknown> = {
    parentEmail: recipientEmail.toLowerCase(),
    intakeSentTo: parsed.data.recipient,
    intakeSentAt: new Date(),
    status: referral.status === "intake" ? "pending_signature" : referral.status,
  };
  for (const field of ["serviceFrequency", "cost", "paymentSchedule", "paymentTypeRequested"] as const) {
    if (parsed.data[field] !== undefined) updates[field] = clean(parsed.data[field]);
  }
  const devLink = await sendIntakeEmail(referral.id, recipientEmail);
  await db.update(referralsTable).set(updates).where(eq(referralsTable.id, referral.id));
  const recipientLabel = parsed.data.recipient === "participant" ? "participant" : "family rep";
  await audit(
    req.user!.id,
    "send_signature_link",
    "referral",
    referral.id,
    `Sent to ${recipientLabel}: ${recipientEmail}`,
  );
  res.json(SendIntakeResponse.parse({ sent: true, devLink }));
});

// --- Public signature endpoints (tokened, no session) ---

async function loadSignatureLink(token: string) {
  const [link] = await db
    .select()
    .from(magicLinksTable)
    .where(
      and(
        eq(magicLinksTable.token, token),
        eq(magicLinksTable.purpose, "signature"),
        gt(magicLinksTable.expiresAt, new Date()),
      ),
    );
  return link;
}

router.get("/signature/:token", async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  const link = await loadSignatureLink(token);
  if (!link || !link.referralId) {
    res.status(404).json({ error: "This signature link is invalid or has expired" });
    return;
  }
  const [referral] = await db.select().from(referralsTable).where(eq(referralsTable.id, link.referralId));
  if (!referral) {
    res.status(404).json({ error: "Referral not found" });
    return;
  }
  const f = (referral.intakeFields ?? {}) as Record<string, string | undefined>;
  const clientNames = await clientNameMap([referral.clientId]);
  res.json(
    GetSignaturePageResponse.parse({
      referralId: referral.id,
      clientName: clientNames.get(referral.clientId) ?? "Client",
      activityDescription: f.activityDescription ?? null,
      vendorName: f.vendorName ?? null,
      serviceStartDate: f.serviceStartDate ?? null,
      serviceEndDate: f.serviceEndDate ?? null,
      serviceType: f.serviceType ?? null,
      alreadySigned: !!referral.parentSignedAt || !!link.usedAt,
    }),
  );
});

router.post("/signature/:token", async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  const parsed = SubmitSignatureBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!parsed.data.agreed) {
    res.status(400).json({ error: "You must agree to the service terms to sign" });
    return;
  }
  // Conditional requirement OpenAPI can't fully express (documented on the
  // SignatureInput schema): when opting into account creation the signer must
  // supply a password of at least 8 characters. Reject BEFORE loading/consuming
  // the token or recording the signature so the link stays valid for a retry.
  if (parsed.data.createAccount && (!parsed.data.password || parsed.data.password.length < 8)) {
    res.status(400).json({
      error: "To create a portal account you must set a password of at least 8 characters.",
    });
    return;
  }
  const link = await loadSignatureLink(token);
  if (!link || !link.referralId || link.usedAt) {
    res.status(404).json({ error: "This signature link is invalid, expired, or already used" });
    return;
  }
  const [referral] = await db.select().from(referralsTable).where(eq(referralsTable.id, link.referralId));
  if (!referral) {
    res.status(404).json({ error: "Referral not found" });
    return;
  }
  if (referral.parentSignedAt) {
    res.status(409).json({ error: "This agreement has already been signed" });
    return;
  }
  await db
    .update(referralsTable)
    .set({
      parentSignedAt: new Date(),
      signedByName: parsed.data.typedName,
      ...(parsed.data.signerRelationship
        ? { signerRelationship: parsed.data.signerRelationship }
        : {}),
      signedIp: req.ip ?? null,
      status: referral.status === "pending_signature" || referral.status === "intake" ? "pending_auth" : referral.status,
    })
    .where(eq(referralsTable.id, referral.id));
  await db.update(magicLinksTable).set({ usedAt: new Date() }).where(eq(magicLinksTable.id, link.id));

  // Optional account creation for the signer. The signature is already recorded
  // above; if a user with this email already exists we do NOT silently skip —
  // we sign anyway and report accountCreated=false with an explicit reason so
  // the UI can be honest with the signer.
  let accountCreated = false;
  let accountCreationError: string | null = null;
  if (parsed.data.createAccount && parsed.data.password) {
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, link.email));
    if (existing) {
      accountCreationError =
        "An account with this email already exists. Use Forgot password to sign in, or contact CEPS for help.";
    } else {
      const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, referral.clientId));
      await db.insert(usersTable).values({
        name: parsed.data.typedName,
        email: link.email,
        role: client?.isMinor === false ? "self" : "parent_guardian",
        passwordHash: hashPassword(parsed.data.password),
        linkedRecordId: referral.clientId,
        linkedRecordType: "client",
        accountCreatedAt: new Date(),
      });
      accountCreated = true;
    }
  }
  await audit(null, "signature_submitted", "referral", referral.id, `Signed by ${parsed.data.typedName}`);
  res.json(SubmitSignatureResponse.parse({ ok: true, accountCreated, accountCreationError }));
});

export default router;
