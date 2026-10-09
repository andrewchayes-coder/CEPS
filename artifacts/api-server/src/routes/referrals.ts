import { Router, type IRouter } from "express";
import { referralServiceError, normalizeAuthorizationAmount } from "../lib/referral-service";
import { eq, and, isNull, gt, desc, count, ilike, or, sql, ne, gte, lte, inArray, type SQL } from "drizzle-orm";
import {
  db,
  clientsTable,
  vendorsTable,
  referralsTable,
  magicLinksTable,
  usersTable,
  auditLogTable,
  familyRepresentativesTable,
} from "@workspace/db";
import {
  ListReferralsQueryParams,
  ListReferralsResponse,
  CreateReferralBody,
  CreateReferralResponse,
  GetReferralResponse,
  GetReferralHistoryResponse,
  UpdateReferralBody,
  UpdateReferralResponse,
  SendIntakeBody,
  SendIntakeResponse,
  PreviewIntakeAgreementBody,
  PreviewIntakeAgreementResponse,
  GetSignaturePageResponse,
  SubmitSignatureBody,
  SubmitSignatureResponse,
  GetCoordinatorReviewResponse,
  ReviewCoordinatorReferralBody,
  ReviewCoordinatorReferralResponse,
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
import { referralJson, clientNameMap, userNameMap, userContactMap } from "../lib/serializers";
import { sortedOrder } from "../lib/sorting";
import { logger } from "../lib/logger";
import { suggestUnmatchedPosForClient } from "../lib/posMatching";
import { applyReferralClientUpdates } from "../lib/referralClientUpdates";

// One display-name rule for sorting/search and response enrichment.
const referralVendorNameSql = sql<string | null>`case when ${referralsTable.vendorId} is null
  then ${referralsTable.intakeFields}->>'vendorName'
  else (select name from vendors where id = ${referralsTable.vendorId}) end`;

async function referralMetadata(rows: (typeof referralsTable.$inferSelect)[]) {
  const vendorIds = [...new Set(rows.flatMap(row => row.vendorId ? [row.vendorId] : []))];
  const submitterIds = [...new Set(rows.flatMap(row => row.submittedByUserId ? [row.submittedByUserId] : []))];
  const [vendors, submitters] = await Promise.all([
    vendorIds.length ? db.select({ id: vendorsTable.id, name: vendorsTable.name }).from(vendorsTable)
      .where(inArray(vendorsTable.id, vendorIds)) : [],
    submitterIds.length ? db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role }).from(usersTable)
      .where(inArray(usersTable.id, submitterIds)) : [],
  ]);
  const vendorNames = new Map(vendors.map(vendor => [vendor.id, vendor.name]));
  const people = new Map(submitters.map(person => [person.id, person]));
  return new Map(rows.map(row => [row.id, {
    vendorName: row.vendorId ? vendorNames.get(row.vendorId) ?? null : null,
    submittedByName: row.submittedByUserId ? people.get(row.submittedByUserId)?.name ?? null : null,
    submittedByRole: row.submittedByUserId ? people.get(row.submittedByUserId)?.role ?? null : null,
  }]));
}

class DeletedParticipantError extends Error {
  constructor() {
    super("This participant is deleted and must be restored before creating a referral.");
    this.name = "DeletedParticipantError";
  }
}

const router: IRouter = Router();

async function sendIntakeEmail(
  referralId: string,
  email: string,
  linkUrl: string,
): Promise<string | null> {
  // [CONFIRM] No email provider approved yet. Keep delivery behind this helper
  // so the real provider can replace this development behavior in one place.
  if (process.env.NODE_ENV === "production") {
    logger.info({ referralId }, "Intake signature link prepared");
    return null;
  }
  logger.info(
    { referralId, recipientEmail: email.trim().toLowerCase(), devLink: linkUrl },
    "Development intake signature link prepared",
  );
  return linkUrl;
}

class SignatureSubmissionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const clean = (value: string | undefined | null): string | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const AGREEMENT_TEXT = `1. Purpose of RC Funds
The recipient of RC Funds, herein referred to as the "Participant," acknowledges that the primary purpose of these funds is to empower individuals with developmental disabilities to exercise greater control over their service delivery and to achieve personal outcomes based on their individual needs, preferences, and goals.

2. Eligible Expenditures
The Participant understands that RC Funds can be used for a range of services, supports, and goods that promote community inclusion, enhance quality of life, and facilitate the attainment of personal objectives. These include but are not limited to, services related to education, and social and recreational activities.

3. Budget Development and Approval
The Participant agrees to collaborate with their Service Coordinator to obtain the proper authorization and provide the supporting documentation to obtain the authorization. This includes program invoices or contracts, with the business and/or program name, the contact information for the business/program, and the service that is provided: (Example: Joe's Karate Club, summer program 2 x per week from 7/1-8/31; cost $420.00). The Participant understands that purchases cannot be granted unless CEPS obtains authorization for the item, and CEPS cannot pay outside the authorized amount. The Participant acknowledges the responsibility to utilize RC Funds in accordance with the guidelines and regulations. Any proposed expenditures must be consistent with the Participant's Individual Program Plan (IPP) and must not contravene state and federal laws, regulations, or policies. CEPS does not receive the IPP, but will assume if the Participant receives authorization from the RC, that the services are in line with the IPP as the RC provides the authorization to CEPS.

4. Record Keeping and Documentation
The Participant agrees to provide CEPS with unpaid invoices, bills, or payment requests. The Participant agrees to maintain accurate and detailed records of all expenditures made using RC Funds. This documentation shall include receipts, invoices, and other pertinent information and be made available for inspection upon request.

5. Service Payment and/or Reimbursement Process
Service Payment: The Participant will provide CEPS with the Recreational Activity Service/Program contact information and an invoice, bill or payment request from the vendor a minimum of two weeks prior to the payment due date. The Participant will provide CEPS with the requested payment schedule: (Example: $420.00 to be paid in two payments of $210.00 on the first of each month). CEPS will submit payment to the vendor by check and provide payment confirmation to the Participant.

Reimbursement: Upon the completion of approved expenditures, the Participant will obtain authorization from the RC. The RC will provide CEPS with a copy of the authorization and any supporting documentation. The participant must complete a CEPS invoice and provide supporting documentation such as receipts or invoices for services. CEPS will initiate the reimbursement process for the Participant subsequent to the RC's fulfillment of the expenditure. The disbursement of payment may require a span of 30-45 days from the date of CEPS's formal submission to the RC.

By signing this contract, the Participant affirms their commitment to utilizing RC Funds responsibly and in accordance with the principles and guidelines set forth by the California Department of Developmental Disabilities.

The Parent/Guardian/Conservator is providing an attestation that confirms the participant's receipt of services and their payment for said services. This attestation is corroborated by their submission of the relevant receipt/invoice. Signatures indicate agreement and understanding of the terms outlined in this contract statement.`;

async function buildAgreementPage(
  referral: typeof referralsTable.$inferSelect,
  recipient: "participant" | "family_rep",
  draft: Partial<{
    serviceFrequency: string | null;
    cost: string | null;
    paymentSchedule: string | null;
    paymentTypeRequested: string | null;
  }> = {},
  familyRepresentativeId?: string | null,
) {
  const f = (referral.intakeFields ?? {}) as Record<string, string | undefined>;
  const [clientNames, coordinatorContacts, clients] = await Promise.all([
    clientNameMap([referral.clientId]),
    userContactMap([referral.serviceCoordinatorId]),
    db.select().from(clientsTable).where(eq(clientsTable.id, referral.clientId)),
  ]);
  const client = clients[0];
  if (!client) return { error: "Participant not found", status: 404 } as const;
  if (recipient === "participant" && client.isMinor !== false) {
    return {
      error: client.isMinor
        ? "A minor cannot sign for themselves — send to the family rep, guardian, or conservator instead"
        : "Confirm that the participant is not a minor before sending the referral agreement to them",
      status: 400,
    } as const;
  }
  const sentToFamily = recipient === "family_rep";
  const selectedRepId = familyRepresentativeId ?? referral.intakeSentToFamilyRepId;
  const [selectedRep] = sentToFamily && selectedRepId
    ? await db.select().from(familyRepresentativesTable).where(and(
      eq(familyRepresentativesTable.id, selectedRepId),
      eq(familyRepresentativesTable.clientId, referral.clientId),
      eq(familyRepresentativesTable.isDeleted, false),
    ))
    : [];
   if (sentToFamily && selectedRepId && !selectedRep) return { error: "The selected family representative no longer exists", status: 400 } as const;
   const selectedEmail = clean(
     sentToFamily
       ? (selectedRep ? selectedRep.email : client.familyRepEmail)
       : client.email,
   );
  if (!selectedEmail) {
    return {
      error: `Add an email to the ${sentToFamily ? "family rep" : "participant"} record before sending the referral agreement`,
      status: 400,
    } as const;
  }
  const coordinator = referral.serviceCoordinatorId
    ? coordinatorContacts.get(referral.serviceCoordinatorId)
    : undefined;
  const participantName = clientNames.get(referral.clientId) ?? "Participant";
   const contactAddress = sentToFamily
     ? (selectedRep ? selectedRep.address : client.familyRepAddress)
     : client.address;
  const fallbackContactAddress = [
    f.contactStreet,
    f.contactCity,
    f.contactState,
    f.contactZip,
  ].filter(Boolean).join(", ");
  const activityMailingAddress = [
    f.vendorServiceStreet,
    f.vendorServiceCity,
    f.vendorServiceState,
    f.vendorServiceZip,
  ].filter(Boolean).join(", ");
  const draftValue = (
    field: keyof typeof draft,
    stored: string | null,
  ) => field in draft ? clean(draft[field]) : stored;

  return {
    selectedEmail,
    data: {
      referralId: referral.id,
      clientName: participantName,
      participantUci: client.uciNumber,
      participantDob: client.dateOfBirth,
      clientIsMinor: client.isMinor === true,
      intakeSentTo: recipient,
      serviceCoordinatorName: coordinator?.name ?? f.coordinatorName ?? null,
      serviceCoordinatorPhone: coordinator?.phone ?? f.coordinatorPhone ?? null,
      regionalCenter: client.regionalCenter ?? f.regionalCenterName ?? null,
        representativeName: sentToFamily
          ? (selectedRep?.name ?? client.familyRepName ?? null)
          : participantName,
        signerRelationship: sentToFamily ? (selectedRep?.relationship ?? null) : null,
       contactPhone: sentToFamily
         ? (selectedRep ? selectedRep.phone : (client.familyRepPhone ?? f.contactPhone))
         : (client.phone ?? f.contactPhone ?? null),
      contactEmail: selectedEmail,
      mailingAddress: contactAddress ?? (fallbackContactAddress || null),
      activityDescription: f.activityDescription ?? null,
      vendorName: f.vendorName ?? null,
      activityContactName: f.vendorContactPerson ?? null,
      activityContactPhone: f.vendorPhone ?? null,
      activityMailingAddress: activityMailingAddress || null,
      serviceStartDate: f.serviceStartDate ?? null,
      serviceEndDate: f.serviceEndDate ?? null,
      serviceType: f.serviceType ?? null,
      serviceFrequency: draftValue("serviceFrequency", referral.serviceFrequency),
      cost: draftValue("cost", referral.cost),
      paymentSchedule: draftValue("paymentSchedule", referral.paymentSchedule),
      paymentTypeRequested: draftValue("paymentTypeRequested", referral.paymentTypeRequested),
      agreementText: AGREEMENT_TEXT,
      alreadySigned: !!referral.parentSignedAt,
    },
  } as const;
}

router.get("/referrals", requireAuth, async (req, res): Promise<void> => {
  const query = ListReferralsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.startDate && query.data.endDate && query.data.startDate > query.data.endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }
  const conditions: SQL[] = [
    // Referrals for removed participants are not visible through any list or
    // search path, including searches over referral-owned fields.
    sql`${referralsTable.clientId} in (select id from clients where is_deleted = false)`,
  ];
  // Role scoping — mirrors the audit-log SQL-WHERE pattern:
  // coordinators see only referrals they own; parent/self only their linked
  // client's; vendors see none (forced to an unsatisfiable condition).
  const u = req.user!;
  // Do not use zod.coerce.boolean: it treats the string "false" as true.
  const submittedByMe = req.query.submittedByMe === "true";
  if (req.query.submittedByMe !== undefined && req.query.submittedByMe !== "true" && req.query.submittedByMe !== "false") {
    res.status(400).json({ error: "submittedByMe must be true or false" }); return;
  }
  if (submittedByMe) {
    if (u.role !== "service_coordinator") { res.status(403).json({ error: "Forbidden" }); return; }
    const owned = and(...conditions, eq(referralsTable.submittedByUserId, u.id));
    const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 1000);
    const offset = Math.max(query.data.offset ?? 0, 0);
    const [[{ total }], items] = await Promise.all([
      db.select({ total: count() }).from(referralsTable).where(owned),
      db.select({
        id: referralsTable.id, referralDate: referralsTable.referralDate,
        clientName: sql<string>`coalesce(nullif(trim(concat(${referralsTable.intakeFields}->>'clientFirstName', ' ', ${referralsTable.intakeFields}->>'clientLastName')), ''), (select first_name || ' ' || last_name from clients where id = ${referralsTable.clientId}))`,
        status: sql<string>`case when ${referralsTable.coordinatorReviewStatus} = 'pending' then 'pending_review' when ${referralsTable.coordinatorReviewStatus} = 'rejected' then 'review_rejected' else ${referralsTable.status} end`,
      }).from(referralsTable).where(owned).orderBy(desc(referralsTable.createdAt), desc(referralsTable.id)).limit(limit).offset(offset),
    ]);
    res.json(ListReferralsResponse.parse({ items, total })); return;
  }
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
  if (query.data.coordinatorReviewStatus) {
    if (req.user!.role === "staff") {
      conditions.push(eq(referralsTable.coordinatorReviewStatus, query.data.coordinatorReviewStatus));
    }
  }
  if (query.data.coordinatorId) conditions.push(eq(referralsTable.serviceCoordinatorId, query.data.coordinatorId));
  if (query.data.clientId) conditions.push(eq(referralsTable.clientId, query.data.clientId));
  if (query.data.startDate) conditions.push(gte(referralsTable.referralDate, query.data.startDate));
  if (query.data.endDate) conditions.push(lte(referralsTable.referralDate, query.data.endDate));
  if (query.data.search) {
    const like = `%${escapeLike(query.data.search)}%`;
    const normalizedSearch = query.data.search.replace(/[$,]/g, "");
    const numericLike = `%${escapeLike(normalizedSearch)}%`;
    conditions.push(
      or(
        sql`${referralsTable.clientId} in (select id from clients where (first_name || ' ' || last_name) ilike ${like} and is_deleted = false)`,
        sql`${referralsTable.serviceCoordinatorId} in (select id from users where name ilike ${like})`,
        sql`${referralVendorNameSql} ilike ${like}`,
        sql`replace(lower(${referralsTable.status}), '_', ' ') ilike ${like}`,
        sql`replace(lower(${referralsTable.submittedVia}), '_', ' ') ilike ${like}`,
        sql`replace(lower(${referralsTable.intakeSentTo}), '_', ' ') ilike ${like}`,
        ilike(referralsTable.parentEmail, like),
        ilike(referralsTable.signedByName, like),
        sql`replace(lower(${referralsTable.signerRelationship}), '_', ' ') ilike ${like}`,
        sql`replace(lower(${referralsTable.serviceFrequency}), '_', ' ') ilike ${like}`,
        sql`replace(lower(${referralsTable.paymentTypeRequested}), '_', ' ') ilike ${like}`,
        sql`replace(lower(${referralsTable.paymentSchedule}), '_', ' ') ilike ${like}`,
        ilike(referralsTable.notes, like),
        sql`to_char(${referralsTable.referralDate}, 'Mon FMDD, YYYY') ilike ${like}`,
        normalizedSearch ? sql`cast(${referralsTable.cost} as text) ilike ${numericLike}` : sql`false`,
        sql`cast(${referralsTable.intakeSentAt} as text) ilike ${like}`,
        sql`cast(${referralsTable.parentSignedAt} as text) ilike ${like}`,
        sql`cast(${referralsTable.altaAuthReceivedAt} as text) ilike ${like}`,
        sql`replace(lower(coalesce(${referralsTable.intakeFields}->>'serviceType', '')), '_', ' ') ilike ${like}`,
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
      vendorName: sql`lower(${referralVendorNameSql})`,
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
  const [clientNames, coordNames, metadata] = await Promise.all([
    clientNameMap(referrals.map((r) => r.clientId)),
    userNameMap(referrals.map((r) => r.serviceCoordinatorId)),
    referralMetadata(referrals),
  ]);
  res.json(
    ListReferralsResponse.parse({
      items: referrals.map((r) =>
        referralJson(
          r,
          clientNames.get(r.clientId),
          r.serviceCoordinatorId ? coordNames.get(r.serviceCoordinatorId) : null,
          undefined, undefined, metadata.get(r.id),
        ),
      ),
      total,
    }),
  );
});

router.post("/referrals", requireStaffOrCoordinator, async (req, res): Promise<void> => {
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "diagnosis") ||
      Object.prototype.hasOwnProperty.call(req.body ?? {}, "eligibilityCategory")) {
    res.status(400).json({ error: "Diagnosis and eligibility are no longer collected on the referral form" });
    return;
  }
  const parsed = CreateReferralBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const f = parsed.data.intakeFields;
  const serviceError = referralServiceError(f);
  if (serviceError) {
    res.status(400).json({ error: serviceError });
    return;
  }
  f.authAmount = normalizeAuthorizationAmount(f.authAmount!);
  if (parsed.data.serviceFrequency) f.serviceFrequency = parsed.data.serviceFrequency;
  const preferredLanguage = typeof f.preferredLanguage === "string"
    ? f.preferredLanguage.trim()
    : "";
  if (!preferredLanguage) {
    res.status(400).json({ error: "Preferred language is required" });
    return;
  }
  f.preferredLanguage = preferredLanguage;
  if (f.vendorAcceptsChecks === false) {
    res.status(400).json({ error: "FMS can only pay vendors who accept checks. This referral cannot be submitted." });
    return;
  }
  if (!f.clientFirstName || !f.clientLastName || !f.clientUci || !f.clientDob) {
    res.status(400).json({ error: "Client first name, last name, DOB and UCI are required" });
    return;
  }
  if (f.clientIsMinor === true && !clean(f.familyRepName)) {
    res.status(400).json({ error: "Family representative name is required for minors" });
    return;
  }
  const hasAdultRepContactWithoutName = f.clientIsMinor !== true &&
    !clean(f.familyRepName) &&
    [f.familyRepRelationship, f.familyRepPhone, f.familyRepEmail, f.familyRepAddress]
      .some((value) => clean(value) !== null);
  if (hasAdultRepContactWithoutName) {
    res.status(400).json({ error: "Family representative contact details require a family representative name" });
    return;
  }

  const clientUci = f.clientUci;
  const clientFirstName = f.clientFirstName;
  const clientLastName = f.clientLastName;
  const clientDob = f.clientDob;
  const address = [f.contactStreet, f.contactCity, f.contactState, f.contactZip].filter(Boolean).join(", ");
  const contact = {
    phone: clean(f.contactPhone),
    email: clean(f.contactEmail),
    address: clean(address),
  };
  let result;
  try {
    result = await db.transaction(async (tx) => {
    // Lock an existing UCI row so contact and representative reconciliation is
    // atomic with referral creation. A concurrent new-UCI insert is still
    // guarded by the database unique constraint.
    let [client] = await tx.select().from(clientsTable)
      .where(eq(clientsTable.uciNumber, clientUci)).for("update");
    if (client?.isDeleted) throw new DeletedParticipantError();
    let heldForReview = false;
    if (
      client &&
      req.user!.role === "service_coordinator" &&
      client.assignedCoordinatorId !== req.user!.id
    ) {
      // Referral coordinators may differ from the participant's assigned
      // coordinator. Treat any non-closed referral as an active ownership link.
      const [ownedReferral] = await tx.select({ id: referralsTable.id }).from(referralsTable).where(and(
        eq(referralsTable.clientId, client.id),
        eq(referralsTable.serviceCoordinatorId, req.user!.id),
        ne(referralsTable.status, "closed"),
      )).limit(1);
      if (!ownedReferral) heldForReview = true;
    }
    if (!client) {
      const contactIsFamily = f.clientIsMinor === true;
      const [createdClient] = await tx
        .insert(clientsTable)
        .values({
          firstName: clientFirstName,
          lastName: clientLastName,
          dateOfBirth: clientDob,
          uciNumber: clientUci,
          regionalCenter: f.regionalCenterName,
          preferredLanguage: f.preferredLanguage,
          isMinor: f.clientIsMinor,
          phone: contactIsFamily ? null : contact.phone,
          email: contactIsFamily ? null : contact.email,
          address: contactIsFamily ? null : contact.address,
          // These columns are deprecated; canonical representatives are
          // created below for minor referrals.
          familyRepName: null,
          familyRepPhone: null,
          familyRepEmail: null,
          familyRepAddress: null,
          assignedCoordinatorId: req.user!.role === "service_coordinator" ? req.user!.id : null,
        })
        .returning();
      client = createdClient;
    }

    let familyRepresentative: typeof familyRepresentativesTable.$inferSelect | undefined;
    if (!heldForReview) {
      const updates = await applyReferralClientUpdates(
        tx as unknown as typeof db,
        req.user!.id,
        client,
        f as Record<string, unknown>,
        { phone: true, email: true, address: true, preferredLanguage: true, minorStatus: true, familyRepresentative: true },
      );
      client = updates.client;
      familyRepresentative = updates.familyRepresentative;
    }

    // Find or create the vendor by name.
    const vendorName = clean(f.vendorName);
    let vendorId: string | null = null;
    if (vendorName) {
      const findVendorByNormalizedName = () =>
        tx
          .select()
          .from(vendorsTable)
          .where(sql`lower(btrim(${vendorsTable.name})) = lower(btrim(${vendorName}))`)
          .limit(1);
      let [vendor] = await findVendorByNormalizedName();
      if (!vendor) {
        const serviceAddress = [f.vendorServiceStreet, f.vendorServiceCity, f.vendorServiceState, f.vendorServiceZip]
          .filter(Boolean)
          .join(", ");
        const billingAddress =
          f.vendorBillingDifferent === "yes"
            ? [f.vendorBillingStreet, f.vendorBillingCity, f.vendorBillingState, f.vendorBillingZip].filter(Boolean).join(", ")
            : serviceAddress;
        [vendor] = await tx.insert(vendorsTable).values({
          name: vendorName,
          email: f.vendorEmail,
          phone: f.vendorPhone,
          contactPerson: f.vendorContactPerson,
          serviceAddress: serviceAddress || null,
          billingAddress: billingAddress || null,
        }).onConflictDoNothing().returning();
        // Another intake may have inserted the same case-insensitive name
        // after the lookup. Resolve that row rather than leaving the referral
        // without its vendor link.
        if (!vendor) [vendor] = await findVendorByNormalizedName();
        if (!vendor) throw new Error(`Could not resolve vendor "${vendorName}" after insert`);
      }
      vendorId = vendor.id;
    }

    // Portal sends '' for untouched optional fields — normalize to null.
    const [referral] = await tx
      .insert(referralsTable)
      .values({
        clientId: client.id,
        vendorId,
        serviceCoordinatorId: heldForReview ? null : req.user!.role === "service_coordinator" ? req.user!.id : null,
        submittedByUserId: req.user!.id,
        coordinatorReviewStatus: heldForReview ? "pending" : null,
        referralDate: new Date().toISOString().slice(0, 10),
        status: "intake",
        submittedVia: parsed.data.submittedVia ?? "staff_manual_entry",
        intakeFields: f,
        serviceFrequency: parsed.data.serviceFrequency ?? f.serviceFrequency,
        cost: clean(parsed.data.cost),
        paymentSchedule: clean(parsed.data.paymentSchedule),
        paymentTypeRequested: clean(parsed.data.paymentTypeRequested),
        supportingDocumentUrl: clean(parsed.data.supportingDocumentUrl),
        notes: parsed.data.notes,
      })
      .returning();

    await audit(
      req.user!.id,
      heldForReview ? "referral_held_for_coordinator_review" : "create_referral",
      "referral",
      referral.id,
      heldForReview ? undefined : `Referral for ${client.firstName} ${client.lastName}`,
      tx as unknown as typeof db,
    );
      return { client, referral, familyRepresentative, heldForReview };
    });
  } catch (error) {
    if (error instanceof DeletedParticipantError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
  const { client, referral, familyRepresentative, heldForReview } = result;
  // Referral creation has already committed. Suggestions are deliberately
  // best-effort and never auto-resolve a queue row or roll back the referral.
  try {
    await db.transaction(async (tx) => {
      await suggestUnmatchedPosForClient(tx as unknown as typeof db, client.id);
    });
  } catch (error) {
    logger.error({ error, clientId: client.id, referralId: referral.id }, "Unable to suggest unmatched POS matches after referral creation");
  }
  if (heldForReview) {
    res.status(202).json({
      id: referral.id,
      status: "pending_review",
      message: "Referral submitted. CEPS will review it and follow up with you.",
    });
    return;
  }
  const coordNames = await userNameMap([referral.serviceCoordinatorId]);
  res.status(201).json(
    CreateReferralResponse.parse(
      referralJson(
        referral,
        `${client.firstName} ${client.lastName}`,
        referral.serviceCoordinatorId ? coordNames.get(referral.serviceCoordinatorId) : null,
        client.isMinor,
        { participant: client.email, familyRep: familyRepresentative?.email ?? client.familyRepEmail },
        (await referralMetadata([referral])).get(referral.id),
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
      .select({
        isMinor: clientsTable.isMinor,
        email: clientsTable.email,
        familyRepEmail: clientsTable.familyRepEmail,
      })
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
        clients[0]
          ? { participant: clients[0].email, familyRep: clients[0].familyRepEmail }
          : null,
        (await referralMetadata([referral])).get(referral.id),
      ),
    ),
  );
});

router.get("/referrals/:id/coordinator-review", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [referral] = await db.select().from(referralsTable).where(and(
    eq(referralsTable.id, id),
    eq(referralsTable.coordinatorReviewStatus, "pending"),
  ));
  if (!referral) {
    res.status(404).json({ error: "Referral is not awaiting coordinator review" });
    return;
  }
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, referral.clientId));
  const [submitter] = referral.submittedByUserId
    ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, referral.submittedByUserId))
    : [];
  if (!client || !submitter) {
    res.status(404).json({ error: "Referral review details are unavailable" });
    return;
  }
  const representatives = await db.select().from(familyRepresentativesTable).where(and(
    eq(familyRepresentativesTable.clientId, client.id),
    eq(familyRepresentativesTable.isDeleted, false),
  ));
  const f = (referral.intakeFields ?? {}) as Record<string, unknown>;
  const intakeAddress = [f.contactStreet, f.contactCity, f.contactState, f.contactZip]
    .filter((part): part is string => typeof part === "string" && part.length > 0).join(", ");
  const intakeIsMinor = f.clientIsMinor === true;
  const representativeForIntake = f.familyRepName
    ? {
        name: typeof f.familyRepName === "string" ? f.familyRepName : null,
        relationship: typeof f.familyRepRelationship === "string" ? f.familyRepRelationship : null,
        phone: clean(intakeIsMinor ? f.contactPhone as string : f.familyRepPhone as string),
        email: clean(intakeIsMinor ? f.contactEmail as string : f.familyRepEmail as string),
        address: clean(intakeIsMinor
          ? intakeAddress
          : [f.familyRepAddress].filter((value): value is string => typeof value === "string").join(", ")),
      }
    : null;
  res.json(GetCoordinatorReviewResponse.parse({
    referralId: referral.id,
    clientId: client.id,
    status: "pending",
    submittedByName: submitter.name,
    intake: {
      phone: clean(f.contactPhone as string),
      email: clean(f.contactEmail as string),
      address: intakeAddress || null,
      preferredLanguage: clean(f.preferredLanguage as string),
      isMinor: typeof f.clientIsMinor === "boolean" ? f.clientIsMinor : null,
      familyRepresentative: representativeForIntake,
    },
    current: {
      phone: client.phone,
      email: client.email,
      address: client.address,
      preferredLanguage: client.preferredLanguage,
      isMinor: client.isMinor,
      familyRepresentative: client.familyRepName
        ? { name: client.familyRepName, relationship: null, phone: client.familyRepPhone, email: client.familyRepEmail, address: client.familyRepAddress }
        : null,
    },
    currentFamilyRepresentatives: representatives.map((rep) => ({
      name: rep.name,
      relationship: rep.relationship,
      phone: rep.phone,
      email: rep.email,
      address: rep.address,
    })),
    reviewNote: referral.coordinatorReviewNote,
  }));
});

router.post("/referrals/:id/coordinator-review", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = ReviewCoordinatorReferralBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const input = parsed.data;
  const note = clean(input.note);
  if (input.decision === "reject" && !note) {
    res.status(400).json({ error: "A note is required when rejecting a referral" });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [referral] = await tx.select().from(referralsTable)
      .where(eq(referralsTable.id, id)).for("update");
    if (!referral) return { error: "Referral not found", status: 404 } as const;
    if (referral.coordinatorReviewStatus !== "pending" || referral.status !== "intake") {
      return { error: "This referral has already been reviewed or is no longer pending review", status: 409 } as const;
    }
    const reviewedAt = new Date();
    if (input.decision === "reject") {
      await tx.update(referralsTable).set({
        coordinatorReviewStatus: "rejected",
        coordinatorReviewedBy: req.user!.id,
        coordinatorReviewedAt: reviewedAt,
        coordinatorReviewNote: note,
        status: "closed",
      }).where(eq(referralsTable.id, referral.id));
      await audit(req.user!.id, "reject_coordinator_referral", "referral", referral.id, note!, tx as unknown as typeof db);
      return { status: "rejected" as const };
    }
    if (!referral.submittedByUserId) {
      return { error: "The original submitting coordinator is unavailable", status: 409 } as const;
    }
    const [coordinator] = await tx.select({ id: usersTable.id }).from(usersTable).where(and(
      eq(usersTable.id, referral.submittedByUserId),
      eq(usersTable.role, "service_coordinator"),
      eq(usersTable.active, true),
    ));
    if (!coordinator) return { error: "The original submitting coordinator is no longer active", status: 409 } as const;
    const [client] = await tx.select().from(clientsTable)
      .where(and(eq(clientsTable.id, referral.clientId), eq(clientsTable.isDeleted, false)))
      .for("update");
    if (!client) return { error: "Participant is deleted or unavailable", status: 409 } as const;
    const fields = (referral.intakeFields ?? {}) as Record<string, unknown>;
    await applyReferralClientUpdates(
      tx as unknown as typeof db,
      req.user!.id,
      client,
      fields,
      {
        phone: input.applyPhone,
        email: input.applyEmail,
        address: input.applyAddress,
        preferredLanguage: input.applyPreferredLanguage,
        minorStatus: input.applyMinorStatus,
        familyRepresentative: input.applyFamilyRepresentative,
      },
        { allowMinorPromotion: true },
    );
    if (input.reassignAsAssignedCoordinator && client.assignedCoordinatorId !== coordinator.id) {
      await tx.update(clientsTable).set({ assignedCoordinatorId: coordinator.id }).where(eq(clientsTable.id, client.id));
      await audit(
        req.user!.id,
        "reassign_client_coordinator",
        "client",
        client.id,
        `assignedCoordinatorId: ${client.assignedCoordinatorId ?? "none"} -> ${coordinator.id} (referral review)`,
        tx as unknown as typeof db,
      );
    }
    await tx.update(referralsTable).set({
      serviceCoordinatorId: coordinator.id,
      coordinatorReviewStatus: "approved",
      coordinatorReviewedBy: req.user!.id,
      coordinatorReviewedAt: reviewedAt,
      coordinatorReviewNote: note,
    }).where(eq(referralsTable.id, referral.id));
    await audit(
      req.user!.id,
      "approve_coordinator_referral",
      "referral",
      referral.id,
      note ?? "Approved held coordinator referral",
      tx as unknown as typeof db,
    );
    return { status: "approved" as const };
  });
  if ("error" in result) {
    res.status(Number(result.status)).json({ error: result.error });
    return;
  }
  res.json(ReviewCoordinatorReferralResponse.parse(result));
});

router.get("/referrals/:id/history", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [referral] = await db.select({ id: referralsTable.id }).from(referralsTable).where(and(
    eq(referralsTable.id, id),
    sql`${referralsTable.clientId} in (select id from clients where is_deleted = false)`,
  ));
  if (!referral) {
    res.status(404).json({ error: "Referral not found" });
    return;
  }
  const rows = await db.select({
    id: auditLogTable.id, userId: auditLogTable.userId, userName: usersTable.name,
    action: auditLogTable.action, entityType: auditLogTable.entityType, entityId: auditLogTable.entityId,
    detail: auditLogTable.detail, createdAt: auditLogTable.createdAt,
  }).from(auditLogTable).leftJoin(usersTable, eq(auditLogTable.userId, usersTable.id))
    .where(and(eq(auditLogTable.entityType, "referral"), eq(auditLogTable.entityId, id)))
    .orderBy(desc(auditLogTable.createdAt), desc(auditLogTable.id));
  res.json(GetReferralHistoryResponse.parse(rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }))));
});

router.patch("/referrals/:id", requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "diagnosis") ||
      Object.prototype.hasOwnProperty.call(req.body ?? {}, "eligibilityCategory")) {
    res.status(400).json({ error: "Diagnosis and eligibility are no longer collected on the referral form" });
    return;
  }
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
  for (const k of ["parentEmail", "cost", "paymentSchedule", "paymentTypeRequested", "supportingDocumentUrl"] as const) {
    if (updates[k] === "") updates[k] = null;
  }
  if (updates.parentEmail) updates.parentEmail = String(updates.parentEmail).trim().toLowerCase();
  const result: { referral: typeof referralsTable.$inferSelect } | { error: string; status: number } = await db.transaction(async tx => {
    const [existing] = await tx.select().from(referralsTable).where(eq(referralsTable.id, id)).for("update");
    if (!existing) {
      return { error: "Referral not found", status: 404 };
    }
    if (parsed.data.intakeFields && Object.keys(parsed.data.intakeFields).length) {
      if (req.user!.role !== "staff") return { error: "Only staff can edit referral service dates and authorization amount", status: 403 };
      const fields = { ...(existing.intakeFields as Record<string, unknown> ?? {}), ...parsed.data.intakeFields };
      const serviceError = referralServiceError(fields);
      if (serviceError) return { error: serviceError, status: 400 };
      fields.authAmount = normalizeAuthorizationAmount(fields.authAmount as string);
      updates.intakeFields = fields;
    } else {
      delete updates.intakeFields;
    }
    if (existing.coordinatorReviewStatus === "pending") {
      return { error: "This referral is awaiting CEPS review and cannot be changed until approved", status: 409 };
    }
    if (existing.coordinatorReviewStatus === "rejected" && parsed.data.status && parsed.data.status !== "closed") {
      return { error: "This referral was rejected and cannot be advanced", status: 409 };
    }
    // Check ownership under the same lock as the write, including concurrent reassignment.
    if (req.user!.role === "service_coordinator" && existing.serviceCoordinatorId !== req.user!.id) {
      return { error: "Forbidden", status: 403 };
    }
    if ("serviceCoordinatorId" in parsed.data) {
      if (req.user!.role === "service_coordinator") {
        return { error: "Only staff can reassign a referral", status: 403 };
      }
      if (parsed.data.serviceCoordinatorId) {
        const [coordinator] = await tx.select({ id: usersTable.id }).from(usersTable).where(and(
          eq(usersTable.id, parsed.data.serviceCoordinatorId),
          eq(usersTable.role, "service_coordinator"),
          eq(usersTable.active, true),
        ));
        if (!coordinator) {
          return { error: "Service Coordinator must be an active coordinator account", status: 400 };
        }
      }
    }
    const detail: string[] = [];
    if ("serviceCoordinatorId" in parsed.data && existing.serviceCoordinatorId !== parsed.data.serviceCoordinatorId) {
      const ids = [existing.serviceCoordinatorId, parsed.data.serviceCoordinatorId].filter((value): value is string => !!value);
      const people = ids.length ? await tx.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, ids)) : [];
      const names = new Map(people.map(person => [person.id, person.name]));
      const oldName = existing.serviceCoordinatorId ? names.get(existing.serviceCoordinatorId) ?? "none" : "none";
      const newName = parsed.data.serviceCoordinatorId ? names.get(parsed.data.serviceCoordinatorId) ?? "none" : "none";
      detail.push(`Coordinator reassigned: ${oldName} → ${newName}`);
    }
    if (parsed.data.status) detail.push(`Status: ${parsed.data.status}`);
    const [referral] = await tx.update(referralsTable).set(updates).where(eq(referralsTable.id, id)).returning();
    await audit(req.user!.id, "update_referral", "referral", referral.id, detail.join("; ") || undefined, tx as unknown as typeof db);
    return { referral };
  });
  if ("error" in result) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const { referral } = result;
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
        undefined, undefined, (await referralMetadata([referral])).get(referral.id),
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
  if (referral.coordinatorReviewStatus === "pending") {
    res.status(409).json({ error: "This referral is awaiting CEPS review and cannot be deleted" });
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
  const agreementUpdates: Record<string, unknown> = {};
  for (const field of ["serviceFrequency", "cost", "paymentSchedule", "paymentTypeRequested"] as const) {
    if (parsed.data[field] !== undefined) agreementUpdates[field] = clean(parsed.data[field]);
  }
  const delivery = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${referral.id}))`);
    const [currentReferral] = await tx
      .select({ status: referralsTable.status, coordinatorReviewStatus: referralsTable.coordinatorReviewStatus })
      .from(referralsTable)
      .where(eq(referralsTable.id, referral.id))
      .for("update");
    if (currentReferral?.coordinatorReviewStatus === "pending") {
      return { error: "This referral is awaiting CEPS review and cannot be sent until approved", status: 409 } as const;
    }
    if (currentReferral?.coordinatorReviewStatus === "rejected") {
      return { error: "This referral was rejected and cannot be sent", status: 409 } as const;
    }
    const [currentClient] = await tx
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, referral.clientId))
      .for("update");
    if (!currentClient) {
      return { error: "Participant not found", status: 404 } as const;
    }
    if (parsed.data.recipient === "participant" && currentClient.isMinor !== false) {
      return {
        error: currentClient.isMinor
          ? "A minor cannot sign for themselves — send to the family rep, guardian, or conservator instead"
          : "Confirm that the participant is not a minor before sending the referral agreement to them",
        status: 400,
      } as const;
    }
    let selectedRep: typeof familyRepresentativesTable.$inferSelect | undefined;
    if (parsed.data.recipient === "family_rep") {
      if (!parsed.data.familyRepresentativeId) return { error: "familyRepresentativeId is required", status: 400 } as const;
      [selectedRep] = await tx.select().from(familyRepresentativesTable).where(and(
        eq(familyRepresentativesTable.id, parsed.data.familyRepresentativeId),
        eq(familyRepresentativesTable.clientId, referral.clientId),
        eq(familyRepresentativesTable.isDeleted, false),
      )).for("update");
      if (!selectedRep) return { error: "Family representative not found for this client", status: 400 } as const;
    }
    const recipientEmail = clean(parsed.data.recipient === "participant" ? currentClient.email : selectedRep?.email);
    if (!recipientEmail) {
      const recipientLabel = parsed.data.recipient === "participant" ? "participant" : "family rep";
      return {
        error: `Add an email to the ${recipientLabel} record before sending the referral agreement`,
        status: 400,
      } as const;
    }
    const token = newToken();
    const [newLink] = await tx
      .insert(magicLinksTable)
      .values({
        token,
        email: recipientEmail.toLowerCase(),
        purpose: "signature",
        referralId: referral.id,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: magicLinksTable.id });
    const linkUrl = `${appBaseUrl()}/sign/${token}`;
    const deliveredDevLink = await sendIntakeEmail(referral.id, recipientEmail, linkUrl);
    await tx
      .update(magicLinksTable)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(magicLinksTable.referralId, referral.id),
          eq(magicLinksTable.purpose, "signature"),
          ne(magicLinksTable.id, newLink.id),
          isNull(magicLinksTable.usedAt),
        ),
      );
    await tx
      .update(referralsTable)
      .set({
        ...agreementUpdates,
        parentEmail: recipientEmail.toLowerCase(),
        intakeSentTo: parsed.data.recipient,
        intakeSentToFamilyRepId: parsed.data.recipient === "family_rep" ? selectedRep!.id : null,
        intakeSentAt: new Date(),
        status: currentReferral?.status === "intake" ? "pending_signature" : currentReferral?.status,
      })
      .where(eq(referralsTable.id, referral.id));
    return { devLink: deliveredDevLink, recipientEmail } as const;
  });
  if ("error" in delivery) {
    res.status(delivery.status ?? 500).json({ error: delivery.error });
    return;
  }
  const recipientLabel = parsed.data.recipient === "participant" ? "participant" : "family rep";
  await audit(
    req.user!.id,
    "send_signature_link",
    "referral",
    referral.id,
    `Sent to ${recipientLabel}: ${delivery.recipientEmail}`,
  );
  res.json(SendIntakeResponse.parse({ sent: true, devLink: delivery.devLink }));
});

router.post("/referrals/:id/agreement-preview", requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = PreviewIntakeAgreementBody.safeParse(req.body);
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
  if (referral.coordinatorReviewStatus === "pending") {
    res.status(409).json({ error: "This referral is awaiting CEPS review and cannot be previewed until approved" });
    return;
  }
  const preview = await buildAgreementPage(referral, parsed.data.recipient, {
    serviceFrequency: parsed.data.serviceFrequency,
    cost: parsed.data.cost,
    paymentSchedule: parsed.data.paymentSchedule,
    paymentTypeRequested: parsed.data.paymentTypeRequested,
  }, parsed.data.familyRepresentativeId);
  if ("error" in preview) {
    res.status(preview.status ?? 500).json({ error: preview.error });
    return;
  }
  res.json(PreviewIntakeAgreementResponse.parse(preview.data));
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
  if (!link || !link.referralId || link.usedAt) {
    res.status(404).json({ error: "This signature link is invalid or has expired" });
    return;
  }
  const [referral] = await db.select().from(referralsTable).where(eq(referralsTable.id, link.referralId));
  if (!referral) {
    res.status(404).json({ error: "Referral not found" });
    return;
  }
  if (referral.intakeSentTo !== "participant" && referral.intakeSentTo !== "family_rep") {
    res.status(404).json({ error: "This signature link is no longer valid" });
    return;
  }
  if (referral.coordinatorReviewStatus === "pending") {
    res.status(404).json({ error: "This signature link is no longer valid" });
    return;
  }
  const page = await buildAgreementPage(referral, referral.intakeSentTo);
  if (
    "error" in page ||
    page.selectedEmail.toLowerCase() !== link.email.trim().toLowerCase()
  ) {
    res.status(404).json({ error: "This signature link is no longer valid" });
    return;
  }
  res.json(GetSignaturePageResponse.parse(page.data));
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
  const passwordHash =
    parsed.data.createAccount && parsed.data.password
      ? hashPassword(parsed.data.password)
      : null;
  try {
    const outcome = await db.transaction(async (tx) => {
      const signedAt = new Date();
      const [candidateLink] = await tx
        .select({ referralId: magicLinksTable.referralId })
        .from(magicLinksTable)
        .where(and(
          eq(magicLinksTable.token, token),
          eq(magicLinksTable.purpose, "signature"),
        ));
      if (candidateLink?.referralId) {
        const [candidateReferral] = await tx
          .select({ familyRepresentativeId: referralsTable.intakeSentToFamilyRepId })
          .from(referralsTable)
          .where(eq(referralsTable.id, candidateLink.referralId));
        if (candidateReferral?.familyRepresentativeId) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${candidateReferral.familyRepresentativeId}))`);
        }
      }
      const [link] = await tx
        .update(magicLinksTable)
        .set({ usedAt: signedAt })
        .where(
          and(
            eq(magicLinksTable.token, token),
            eq(magicLinksTable.purpose, "signature"),
            gt(magicLinksTable.expiresAt, signedAt),
            isNull(magicLinksTable.usedAt),
          ),
        )
        .returning();
      if (!link?.referralId) {
        throw new SignatureSubmissionError(
          404,
          "This signature link is invalid, expired, or already used",
        );
      }
      const [referral] = await tx
        .select()
        .from(referralsTable)
        .where(eq(referralsTable.id, link.referralId))
        .for("update");
      if (!referral) {
        throw new SignatureSubmissionError(404, "Referral not found");
      }
      if (referral.coordinatorReviewStatus === "pending") {
        throw new SignatureSubmissionError(404, "This signature link is no longer valid");
      }
      if (referral.parentSignedAt) {
        throw new SignatureSubmissionError(409, "This agreement has already been signed");
      }
      const [signingClient] = await tx
        .select()
        .from(clientsTable)
        .where(eq(clientsTable.id, referral.clientId))
        .for("update");
      let selectedRepresentative: typeof familyRepresentativesTable.$inferSelect | undefined;
      if (referral.intakeSentTo === "family_rep" && referral.intakeSentToFamilyRepId) {
        [selectedRepresentative] = await tx
          .select()
          .from(familyRepresentativesTable)
          .where(and(
            eq(familyRepresentativesTable.id, referral.intakeSentToFamilyRepId),
            eq(familyRepresentativesTable.clientId, referral.clientId),
            eq(familyRepresentativesTable.isDeleted, false),
          ))
          .for("update");
      }
      const selectedEmail =
        referral.intakeSentTo === "participant"
          ? signingClient?.email
          : referral.intakeSentTo === "family_rep"
            // A referral with an explicit representative is bound to that
            // record for its entire signing lifecycle.  Falling back to the
            // deprecated client contact fields here could let a deleted or
            // cross-client representative's link be replayed by someone else.
            ? referral.intakeSentToFamilyRepId
              ? selectedRepresentative?.email
              : signingClient?.familyRepEmail
            : null;
      if (
        (referral.intakeSentTo === "participant" && signingClient?.isMinor !== false) ||
        !selectedEmail ||
        selectedEmail.trim().toLowerCase() !== link.email.trim().toLowerCase()
      ) {
        throw new SignatureSubmissionError(404, "This signature link is no longer valid");
      }
      if (
        (referral.intakeSentTo === "participant" && parsed.data.signerRelationship !== "self") ||
        (referral.intakeSentTo === "family_rep" && parsed.data.signerRelationship === "self")
      ) {
        throw new SignatureSubmissionError(
          400,
          "Select the relationship that matches the referral agreement recipient",
        );
      }

      const agreementRecipient =
        referral.intakeSentTo === "participant" || referral.intakeSentTo === "family_rep"
          ? referral.intakeSentTo
          : null;
      if (!agreementRecipient) {
        throw new SignatureSubmissionError(404, "This signature link is no longer valid");
      }
      const agreement = await buildAgreementPage(referral, agreementRecipient);
      if ("error" in agreement) {
        throw new SignatureSubmissionError(agreement.status ?? 500, agreement.error ?? "Unable to preserve agreement");
      }

      let accountCreated = false;
      let accountCreationError: string | null = null;
      if (passwordHash) {
        const inserted = await tx
          .insert(usersTable)
          .values({
            name: parsed.data.typedName,
            email: link.email,
            role: parsed.data.signerRelationship === "self" ? "self" : "parent_guardian",
            passwordHash,
            linkedRecordId: referral.clientId,
            linkedRecordType: "client",
            accountCreatedAt: signedAt,
          })
          .onConflictDoNothing({ target: usersTable.email })
          .returning({ id: usersTable.id });
        accountCreated = inserted.length === 1;
        if (!accountCreated) {
          accountCreationError =
            "An account with this email already exists. Use Forgot password to sign in, or contact CEPS for help.";
        }
        // Only an account belonging to this client and an appropriate portal
        // role may be attached to the selected representative.  This guards
        // against linking an email that already belongs to another client
        // (including when two signature requests race to create an account).
        const [account] = await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.email, link.email))
          .for("update");
        const [existingRepresentativeLink] = account
          ? await tx
              .select({ id: familyRepresentativesTable.id })
              .from(familyRepresentativesTable)
              .where(eq(familyRepresentativesTable.userId, account.id))
              .limit(1)
          : [];
        if (
          account &&
          account.active &&
          selectedRepresentative &&
          (account.role === "parent_guardian" || account.role === "self") &&
          account.linkedRecordType === "client" &&
          account.linkedRecordId === referral.clientId &&
          (!existingRepresentativeLink || existingRepresentativeLink.id === selectedRepresentative.id) &&
          (!selectedRepresentative.userId || selectedRepresentative.userId === account.id)
        ) {
          await tx.update(familyRepresentativesTable)
            .set({ userId: account.id })
            .where(and(
              eq(familyRepresentativesTable.id, selectedRepresentative.id),
              eq(familyRepresentativesTable.clientId, referral.clientId),
              eq(familyRepresentativesTable.isDeleted, false),
              isNull(familyRepresentativesTable.userId),
            ));
        }
      }

      await tx
        .update(referralsTable)
        .set({
          parentSignedAt: signedAt,
          signedByName: parsed.data.typedName,
          signerRelationship: parsed.data.signerRelationship,
          signedIp: req.ip ?? null,
          agreementSnapshot: {
            ...agreement.data,
            recipientEmail: link.email.trim().toLowerCase(),
            signedByName: parsed.data.typedName,
            signerRelationship: parsed.data.signerRelationship,
            signedAt: signedAt.toISOString(),
          },
          status:
            referral.status === "pending_signature" || referral.status === "intake"
              ? "pending_auth"
              : referral.status,
        })
        .where(and(eq(referralsTable.id, referral.id), isNull(referralsTable.parentSignedAt)));
      await tx.insert(auditLogTable).values({
        userId: null,
        action: "signature_submitted",
        entityType: "referral",
        entityId: referral.id,
        detail: `Signed by ${parsed.data.typedName}`,
      });
      return { accountCreated, accountCreationError };
    });
    res.json(SubmitSignatureResponse.parse({ ok: true, ...outcome }));
  } catch (error) {
    if (error instanceof SignatureSubmissionError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

export default router;
