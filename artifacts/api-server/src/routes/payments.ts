import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, paymentsTable, clientsTable, remittancesTable } from "@workspace/db";
import {
  ListPaymentsQueryParams,
  ListPaymentsResponse,
  CreatePaymentBody,
  CreatePaymentResponse,
  ImportCheckRegisterBody,
  ImportCheckRegisterResponse,
  ListRemittancesQueryParams,
  ListRemittancesResponse,
  CreateRemittanceBody,
  CreateRemittanceResponse,
  MatchRemittanceBody,
  MatchRemittanceResponse,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, audit } from "../lib/auth";
import { paymentJson, remittanceJson, clientNameMap, vendorNameMap, authNumberMap } from "../lib/serializers";

const router: IRouter = Router();

async function enrichPayments(payments: (typeof paymentsTable.$inferSelect)[]) {
  const [clientNames, vendorNames, authNums] = await Promise.all([
    clientNameMap(payments.map((p) => p.clientId)),
    vendorNameMap(payments.map((p) => p.vendorId)),
    authNumberMap(payments.map((p) => p.authorizationId)),
  ]);
  return payments.map((p) =>
    paymentJson(p, {
      clientName: clientNames.get(p.clientId),
      vendorName: p.vendorId ? vendorNames.get(p.vendorId) : null,
      authNumber: p.authorizationId ? authNums.get(p.authorizationId) : null,
    }),
  );
}

router.get("/payments", requireAuth, async (req, res): Promise<void> => {
  const query = ListPaymentsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  let payments = await db.select().from(paymentsTable).orderBy(desc(paymentsTable.checkDate));
  const u = req.user!;
  if (u.role === "vendor" && u.linkedRecordType === "vendor") {
    payments = payments.filter((p) => p.vendorId === u.linkedRecordId);
  } else if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    payments = payments.filter((p) => p.clientId === u.linkedRecordId);
  }
  if (query.data.clientId) payments = payments.filter((p) => p.clientId === query.data.clientId);
  if (query.data.vendorId) payments = payments.filter((p) => p.vendorId === query.data.vendorId);
  if (query.data.authorizationId) payments = payments.filter((p) => p.authorizationId === query.data.authorizationId);
  res.json(ListPaymentsResponse.parse(await enrichPayments(payments)));
});

router.post("/payments", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreatePaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [payment] = await db
    .insert(paymentsTable)
    .values({ ...parsed.data, source: "manual", loggedBy: req.user!.id })
    .returning();
  // TODO [CONFIRM]: auto-generate the corresponding Fee (service code 490) record.
  // The exact fee trigger/amount rule is pending confirmation from CEPS — see docs/CEPS_OPEN_ITEMS.md.
  await audit(req.user!.id, "create_payment", "payment", payment.id, `Check ${payment.qbCheckNumber} — $${payment.amount}`);
  res.status(201).json(CreatePaymentResponse.parse((await enrichPayments([payment]))[0]));
});

router.post("/payments/import", requireStaff, async (req, res): Promise<void> => {
  const parsed = ImportCheckRegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const clients = await db.select().from(clientsTable);
  const results: { qbCheckNumber: string; outcome: "imported" | "skipped_duplicate" | "unmatched"; message?: string | null; paymentId?: string | null }[] = [];
  let imported = 0;
  let skipped = 0;
  let unmatched = 0;

  for (const row of parsed.data.rows) {
    const [dup] = await db.select().from(paymentsTable).where(eq(paymentsTable.qbCheckNumber, row.qbCheckNumber));
    if (dup) {
      skipped++;
      results.push({ qbCheckNumber: row.qbCheckNumber, outcome: "skipped_duplicate", message: "A payment with this check number already exists.", paymentId: dup.id });
      continue;
    }
    const nameNeedle = (row.clientName ?? "").trim().toLowerCase();
    const client = nameNeedle
      ? clients.find((c) => `${c.firstName} ${c.lastName}`.toLowerCase() === nameNeedle || `${c.lastName}, ${c.firstName}`.toLowerCase() === nameNeedle)
      : undefined;
    if (!client) {
      unmatched++;
      results.push({
        qbCheckNumber: row.qbCheckNumber,
        outcome: "unmatched",
        message: row.clientName ? `No client matched "${row.clientName}". Log this payment manually.` : "No client name in this row. Log this payment manually.",
      });
      continue;
    }
    const [payment] = await db
      .insert(paymentsTable)
      .values({
        clientId: client.id,
        qbCheckNumber: row.qbCheckNumber,
        checkDate: row.checkDate,
        amount: row.amount,
        paymentMonth: row.checkDate.slice(0, 7),
        paymentType: "direct_payment",
        source: "quickbooks",
        loggedBy: req.user!.id,
      })
      .returning();
    imported++;
    results.push({ qbCheckNumber: row.qbCheckNumber, outcome: "imported", message: `Matched to ${client.firstName} ${client.lastName}.`, paymentId: payment.id });
  }
  await audit(req.user!.id, "import_check_register", "payment", undefined, `${imported} imported, ${skipped} skipped, ${unmatched} unmatched`);
  res.json(ImportCheckRegisterResponse.parse({ imported, skipped, unmatched, results }));
});

// --- Remittances ---

async function enrichRemittances(rows: (typeof remittancesTable.$inferSelect)[]) {
  const [clientNames, authNums] = await Promise.all([
    clientNameMap(rows.map((r) => r.clientId)),
    authNumberMap(rows.map((r) => r.authorizationId)),
  ]);
  return rows.map((r) =>
    remittanceJson(r, {
      clientName: clientNames.get(r.clientId),
      authNumber: r.authorizationId ? authNums.get(r.authorizationId) : null,
    }),
  );
}

router.get("/remittances", requireAuth, async (req, res): Promise<void> => {
  const query = ListRemittancesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  let rows = await db.select().from(remittancesTable).orderBy(desc(remittancesTable.remittanceDate));
  const u = req.user!;
  if ((u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client") {
    rows = rows.filter((r) => r.clientId === u.linkedRecordId);
  } else if (u.role === "vendor") {
    rows = [];
  }
  if (query.data.clientId) rows = rows.filter((r) => r.clientId === query.data.clientId);
  if (query.data.status) rows = rows.filter((r) => r.status === query.data.status);
  res.json(ListRemittancesResponse.parse(await enrichRemittances(rows)));
});

router.post("/remittances", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateRemittanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Auto-match: unremitted payment for the same client with the same amount (and month when provided)
  const candidates = await db
    .select()
    .from(paymentsTable)
    .where(and(eq(paymentsTable.clientId, parsed.data.clientId), eq(paymentsTable.remitted, false)));
  const match = candidates.find(
    (p) =>
      Number(p.amount) === Number(parsed.data.amount) &&
      (!parsed.data.paymentMonth || p.paymentMonth === parsed.data.paymentMonth),
  );
  const [remittance] = await db
    .insert(remittancesTable)
    .values({
      ...parsed.data,
      status: match ? "matched" : "received",
      matchedPaymentId: match?.id ?? null,
      autoMatched: !!match,
    })
    .returning();
  if (match) {
    await db.update(paymentsTable).set({ remitted: true }).where(eq(paymentsTable.id, match.id));
  }
  await audit(req.user!.id, "create_remittance", "remittance", remittance.id, match ? `Auto-matched to check ${match.qbCheckNumber}` : "No automatic match — flagged for review");
  res.status(201).json(CreateRemittanceResponse.parse((await enrichRemittances([remittance]))[0]));
});

router.post("/remittances/:id/match", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = MatchRemittanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, parsed.data.paymentId));
  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  const [remittance] = await db
    .update(remittancesTable)
    .set({ status: "matched", matchedPaymentId: payment.id, autoMatched: false })
    .where(eq(remittancesTable.id, id))
    .returning();
  if (!remittance) {
    res.status(404).json({ error: "Remittance not found" });
    return;
  }
  await db.update(paymentsTable).set({ remitted: true }).where(eq(paymentsTable.id, payment.id));
  await audit(req.user!.id, "match_remittance", "remittance", remittance.id, `Matched to check ${payment.qbCheckNumber}`);
  res.json(MatchRemittanceResponse.parse((await enrichRemittances([remittance]))[0]));
});

export default router;
