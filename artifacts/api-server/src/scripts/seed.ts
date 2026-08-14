/**
 * Seed dummy data for the CEPS Portal MVP.
 * IMPORTANT: dummy data only — no real client data may ever be seeded.
 * Idempotent: skips if the staff user already exists.
 */
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  vendorsTable,
  referralsTable,
  authorizationsTable,
  invoicesTable,
  paymentsTable,
  remittancesTable,
} from "@workspace/db";
import { hashPassword } from "../lib/auth";
import { logger } from "../lib/logger";

async function main() {
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, "staff@ceps.example"));
  if (existing) {
    logger.info("Seed data already present, skipping");
    return;
  }

  const [staff] = await db
    .insert(usersTable)
    .values({
      name: "Dana Alvarez",
      email: "staff@ceps.example",
      role: "staff",
      passwordHash: hashPassword("ceps-demo-2026"),
      accountCreatedAt: new Date(),
    })
    .returning();

  const [coordinator] = await db
    .insert(usersTable)
    .values({
      name: "Miguel Torres",
      email: "coordinator@alta.example",
      role: "service_coordinator",
      passwordHash: hashPassword("ceps-demo-2026"),
      accountCreatedAt: new Date(),
    })
    .returning();

  const [vendorA] = await db
    .insert(vendorsTable)
    .values({
      name: "Sunrise Music Therapy",
      email: "billing@sunrisemusic.example",
      phone: "(916) 555-0142",
      contactPerson: "Priya Shah",
      serviceAddress: "410 J Street, Sacramento, CA 95814",
      billingAddress: "410 J Street, Sacramento, CA 95814",
      w9Status: "on_file",
      preferred: true,
      ein: "94-0000000",
    })
    .returning();

  const [vendorB] = await db
    .insert(vendorsTable)
    .values({
      name: "Capital City Swim School",
      email: "office@capswim.example",
      phone: "(916) 555-0177",
      serviceAddress: "88 Riverfront Dr, West Sacramento, CA 95605",
      w9Status: "pending",
    })
    .returning();

  const [clientA] = await db
    .insert(clientsTable)
    .values({
      firstName: "Jordan",
      lastName: "Kim",
      dateOfBirth: "2014-03-22",
      uciNumber: "UCI-1000001",
      status: "active",
      regionalCenter: "Alta California Regional Center",
      preferredLanguage: "English",
      isMinor: true,
      familyRepName: "Grace Kim",
      familyRepPhone: "(916) 555-0101",
      familyRepEmail: "parent@family.example",
      familyRepAddress: "2210 Maple Ave, Sacramento, CA 95820",
      assignedCoordinatorId: coordinator.id,
    })
    .returning();

  const [clientB] = await db
    .insert(clientsTable)
    .values({
      firstName: "Alex",
      lastName: "Rivera",
      dateOfBirth: "1998-11-05",
      uciNumber: "UCI-1000002",
      status: "active",
      regionalCenter: "Alta California Regional Center",
      preferredLanguage: "Spanish",
      isMinor: false,
      phone: "(916) 555-0155",
      email: "client@self.example",
      address: "731 Birch Ct, Citrus Heights, CA 95610",
      assignedCoordinatorId: coordinator.id,
    })
    .returning();

  await db.insert(usersTable).values([
    {
      name: "Grace Kim",
      email: "parent@family.example",
      role: "parent_guardian",
      passwordHash: hashPassword("ceps-demo-2026"),
      linkedRecordId: clientA.id,
      linkedRecordType: "client",
      accountCreatedAt: new Date(),
    },
    {
      name: "Priya Shah",
      email: "vendor@sunrisemusic.example",
      role: "vendor",
      passwordHash: hashPassword("ceps-demo-2026"),
      linkedRecordId: vendorA.id,
      linkedRecordType: "vendor",
      accountCreatedAt: new Date(),
    },
  ]);

  const [authA] = await db
    .insert(authorizationsTable)
    .values({
      clientId: clientA.id,
      vendorId: vendorA.id,
      authNumber: "POS-2026-04512",
      serviceCode: "459",
      paymentType: "direct_payment",
      activityDescription: "Weekly adaptive music therapy sessions",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      monthlyAmount: "480.00",
      maxPeriodAmount: "5760.00",
      units: 48,
      status: "active",
      receivedDate: "2025-12-18",
    })
    .returning();

  await db.insert(authorizationsTable).values({
    clientId: clientB.id,
    vendorId: vendorB.id,
    authNumber: "POS-2026-04688",
    serviceCode: "024",
    paymentType: "reimbursement",
    activityDescription: "Adaptive swim lessons — family reimbursement",
    servicePeriodStart: "2026-06-01",
    servicePeriodEnd: "2026-08-31",
    monthlyAmount: "300.00",
    maxPeriodAmount: "900.00",
    status: "active",
    receivedDate: "2026-05-20",
  });

  await db.insert(referralsTable).values([
    {
      clientId: clientA.id,
      serviceCoordinatorId: coordinator.id,
      referralDate: "2025-12-02",
      status: "active",
      submittedVia: "portal",
      parentEmail: "parent@family.example",
      parentSignedAt: new Date("2025-12-05T18:30:00Z"),
      signedByName: "Grace Kim",
      altaAuthReceivedAt: new Date("2025-12-18T17:00:00Z"),
      serviceFrequency: "monthly",
      intakeFields: {
        regionalCenterName: "Alta California Regional Center",
        coordinatorName: "Miguel Torres",
        coordinatorEmail: "coordinator@alta.example",
        vendorAcceptsChecks: true,
        vendorName: "Sunrise Music Therapy",
        serviceType: "direct_pay_459",
        activityDescription: "Weekly adaptive music therapy sessions",
        serviceStartDate: "2026-01-01",
        serviceEndDate: "2026-12-31",
        clientFirstName: "Jordan",
        clientLastName: "Kim",
        clientDob: "2014-03-22",
        clientUci: "UCI-1000001",
        clientIsMinor: true,
        familyRepName: "Grace Kim",
        contactPhone: "(916) 555-0101",
        contactEmail: "parent@family.example",
      },
    },
    {
      clientId: clientB.id,
      serviceCoordinatorId: coordinator.id,
      referralDate: "2026-05-11",
      status: "pending_w9",
      submittedVia: "staff_manual_entry",
      serviceFrequency: "monthly",
      altaAuthReceivedAt: new Date("2026-05-20T16:00:00Z"),
      intakeFields: {
        regionalCenterName: "Alta California Regional Center",
        coordinatorName: "Miguel Torres",
        vendorAcceptsChecks: true,
        vendorName: "Capital City Swim School",
        serviceType: "reimbursement_024",
        activityDescription: "Adaptive swim lessons — family reimbursement",
        serviceStartDate: "2026-06-01",
        serviceEndDate: "2026-08-31",
        clientFirstName: "Alex",
        clientLastName: "Rivera",
        clientDob: "1998-11-05",
        clientUci: "UCI-1000002",
        clientIsMinor: false,
        contactPhone: "(916) 555-0155",
        contactEmail: "client@self.example",
      },
    },
  ]);

  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      clientId: clientA.id,
      authorizationId: authA.id,
      vendorId: vendorA.id,
      submittedByRole: "vendor",
      submittedDate: "2026-07-03",
      serviceMonth: "2026-06",
      amountRequested: "480.00",
      paymentType: "direct_payment",
      status: "approved",
      reviewedBy: staff.id,
      reviewedAt: new Date("2026-07-06T19:00:00Z"),
    })
    .returning();

  await db.insert(invoicesTable).values({
    clientId: clientA.id,
    authorizationId: authA.id,
    vendorId: vendorA.id,
    submittedByRole: "vendor",
    submittedDate: "2026-08-04",
    serviceMonth: "2026-07",
    amountRequested: "480.00",
    paymentType: "direct_payment",
    status: "pending_review",
  });

  const [payment] = await db
    .insert(paymentsTable)
    .values({
      clientId: clientA.id,
      authorizationId: authA.id,
      vendorId: vendorA.id,
      invoiceId: invoice.id,
      qbCheckNumber: "10241",
      checkDate: "2026-07-08",
      amount: "480.00",
      paymentMonth: "2026-06",
      paymentType: "direct_payment",
      source: "manual",
      loggedBy: staff.id,
      remitted: true,
    })
    .returning();

  await db.insert(remittancesTable).values([
    {
      clientId: clientA.id,
      authorizationId: authA.id,
      altaReference: "ALTA-RM-88231",
      remittanceDate: "2026-07-28",
      amount: "480.00",
      paymentMonth: "2026-06",
      status: "matched",
      source: "alta_regional",
      matchedPaymentId: payment.id,
      autoMatched: true,
    },
    {
      clientId: clientA.id,
      authorizationId: authA.id,
      altaReference: "ALTA-RM-88547",
      remittanceDate: "2026-08-10",
      amount: "480.00",
      paymentMonth: "2026-07",
      status: "received",
      source: "alta_regional",
    },
  ]);

  logger.info("Seeded CEPS demo data (dummy data only)");
  logger.info("Demo logins (password ceps-demo-2026): staff@ceps.example, coordinator@alta.example, parent@family.example, vendor@sunrisemusic.example");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Seed failed");
    process.exit(1);
  });
