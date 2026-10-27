import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, clientsTable, authorizationsTable, paymentsTable, paymentAllocationsTable, feesTable,
  altaBillingRowsTable, altaBillingRowLinesTable } from "@workspace/db";
import type { BillingImportResult, BillingRow } from "@workspace/api-zod";
import { parseAltaBillingCsv, billingFingerprint } from "./altaBillingParser";
import { notDeleted } from "./serializers";
import { money } from "./money";
import { audit } from "./auth";

/** Six bounded set reads, then bulk inserts. No query-per-CSV-row matching. */
export async function importBilling(csv: string, mode: "preview" | "commit", userId: string): Promise<BillingImportResult> {
  const parsed = parseAltaBillingCsv(csv);
  return db.transaction(async tx => {
    if (mode === "commit") await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('alta-billing-import', 0))`);
    const ucis = [...new Set(parsed.rows.map(r => r.uciNumber))];
    const authNumbers = [...new Set(parsed.rows.map(r => r.authNumber))];
    const months = [...new Set(parsed.rows.map(r => r.serviceMonth))];
    const fingerprints = parsed.rows.map(billingFingerprint);
    const clients = await tx.select().from(clientsTable).where(and(inArray(clientsTable.uciNumber, ucis), notDeleted(clientsTable)));
    const clientIds = clients.map(c => c.id);
    const auths = clientIds.length ? await tx.select().from(authorizationsTable).where(and(
      inArray(authorizationsTable.clientId, clientIds), inArray(authorizationsTable.authNumber, authNumbers), notDeleted(authorizationsTable))) : [];
    const authIds = auths.map(a => a.id);
    const lines = authIds.length ? await tx.select({
      id: paymentAllocationsTable.id, clientId: paymentsTable.clientId, authorizationId: paymentAllocationsTable.authorizationId,
      serviceMonth: sql<string>`coalesce(${paymentAllocationsTable.serviceMonth}, ${paymentsTable.paymentMonth})`,
      amount: paymentAllocationsTable.amount,
    }).from(paymentAllocationsTable).innerJoin(paymentsTable, eq(paymentsTable.id, paymentAllocationsTable.paymentId))
      .where(and(inArray(paymentAllocationsTable.authorizationId, authIds), notDeleted(paymentsTable),
        inArray(sql`coalesce(${paymentAllocationsTable.serviceMonth}, ${paymentsTable.paymentMonth})`, months))) : [];
    const fees = clientIds.length ? await tx.select().from(feesTable).where(and(inArray(feesTable.clientId, clientIds),
      inArray(feesTable.feeMonth, months), notDeleted(feesTable))) : [];
    const existing = await tx.select({ fingerprint: altaBillingRowsTable.sourceRowFingerprint }).from(altaBillingRowsTable)
      .where(inArray(altaBillingRowsTable.sourceRowFingerprint, fingerprints));
    const previouslyBilled = clientIds.length ? await tx.execute(sql`
      select 'payment_line' as kind, l.payment_allocation_id as id
      from alta_billing_row_lines l join alta_billing_rows b on b.id = l.billing_row_id
      where not b.is_deleted and b.client_id in (${sql.join(clientIds.map(id => sql`${id}`), sql`, `)})
      union select 'fee', b.fee_id from alta_billing_rows b where not b.is_deleted and b.fee_id is not null
        and b.client_id in (${sql.join(clientIds.map(id => sql`${id}`), sql`, `)})`) : { rows: [] };
    const prior = new Set((previouslyBilled.rows as { kind: string; id: string }[]).map(r => `${r.kind}:${r.id}`));
    const seen = new Set(existing.map(e => e.fingerprint));
    const clientMap = new Map(clients.map(c => [c.uciNumber, c]));
    const authMap = new Map(auths.map(a => [`${a.clientId}|${a.authNumber}`, a]));
    const lineMap = new Map<string, typeof lines>();
    for (const l of lines.sort((a, b) => a.id.localeCompare(b.id))) {
      const key = `${l.clientId}|${l.authorizationId}|${l.serviceMonth}`;
      lineMap.set(key, [...(lineMap.get(key) ?? []), l]);
    }
    const feeMap = new Map(fees.map(f => [`${f.clientId}|${f.feeMonth}`, f]));
    const batch = mode === "commit" ? randomUUID() : null;
    const sources: (typeof altaBillingRowsTable.$inferInsert)[] = [];
    const links: (typeof altaBillingRowLinesTable.$inferInsert)[] = [];
    const billedFees: string[] = [];
    const rows: BillingRow[] = [];
    for (const source of parsed.rows) {
      const fingerprint = billingFingerprint(source);
      const client = clientMap.get(source.uciNumber);
      const auth = client ? authMap.get(`${client.id}|${source.authNumber}`) : undefined;
      const untracked = !["024", "459", "490"].includes(source.serviceCode);
      const result: BillingRow = { ...source, clientName: client ? `${client.firstName} ${client.lastName}` : null,
        matchStatus: "unmatched", reviewReason: null, targetCount: 0, rebilled: false, untracked };
      if (seen.has(fingerprint)) {
        rows.push({ ...result, matchStatus: "already_imported", reviewReason: "Already imported." });
        continue;
      }
      seen.add(fingerprint);
      let feeId: string | null = null;
      let matchedLines: typeof lines = [];
      if (untracked) result.reviewReason = `Service code ${source.serviceCode} isn't tracked in the portal`;
      else if (!client) result.reviewReason = "No participant matches this UCI.";
      else if (!auth || auth.serviceCode.padStart(3, "0") !== source.serviceCode) result.reviewReason = "No matching authorization for this participant and service code.";
      else if (source.serviceCode === "490") {
        const fee = feeMap.get(`${client.id}|${source.serviceMonth}`);
        if (!fee || fee.status === "waived") result.reviewReason = fee?.status === "waived" ? "Fee is waived." : "No fee for this participant and service month.";
        else {
          feeId = fee.id; result.targetCount = 1; billedFees.push(fee.id);
          result.rebilled = prior.has(`fee:${fee.id}`);
          result.matchStatus = money(fee.amount).equals(money(source.billedAmount)) ? "matched" : "amount_mismatch";
          if (result.matchStatus === "amount_mismatch") result.reviewReason = `Billed $${source.billedAmount}, fee amount $${money(fee.amount).toFixed(2)}`;
          prior.add(`fee:${fee.id}`);
        }
      } else {
        matchedLines = lineMap.get(`${client.id}|${auth.id}|${source.serviceMonth}`) ?? [];
        result.targetCount = matchedLines.length;
        if (!matchedLines.length) result.reviewReason = "No check lines for this participant, authorization and service month.";
        else {
          const total = matchedLines.reduce((sum, l) => sum.plus(money(l.amount)), money(0));
          result.matchStatus = total.equals(money(source.billedAmount)) ? "matched" : "amount_mismatch";
          if (result.matchStatus === "amount_mismatch") result.reviewReason = `Billed $${source.billedAmount}, check lines total $${total.toFixed(2)}`;
          result.rebilled = matchedLines.some(l => prior.has(`payment_line:${l.id}`));
          for (const l of matchedLines) prior.add(`payment_line:${l.id}`);
        }
      }
      const id = randomUUID();
      sources.push({ id, importBatchId: batch ?? "preview", invoiceNumber: source.invoiceNumber,
        invoiceDate: source.billedAt, clientId: client?.id ?? null, uciNumber: source.uciNumber,
        authNumber: source.authNumber, authorizationId: auth?.id ?? null, serviceCode: source.serviceCode,
        serviceMonth: source.serviceMonth, billedAmount: source.billedAmount, feeId,
        matchStatus: result.matchStatus, reviewReason: result.reviewReason, sourceRowFingerprint: fingerprint, createdBy: userId });
      links.push(...matchedLines.map(l => ({ billingRowId: id, paymentAllocationId: l.id, lineAmount: l.amount })));
      rows.push({ ...result, ...(mode === "commit" ? { id } : {}) });
    }
    const counts = { imported: mode === "commit" ? sources.length : 0, matched: rows.filter(r => r.matchStatus === "matched").length,
      unmatched: rows.filter(r => r.matchStatus === "unmatched").length, amountMismatch: rows.filter(r => r.matchStatus === "amount_mismatch").length,
      alreadyImported: rows.filter(r => r.matchStatus === "already_imported").length,
      rebilled: rows.filter(r => r.rebilled).length,
      untrackedCount: rows.filter(r => r.untracked && r.matchStatus !== "already_imported").length,
      untrackedAmount: rows.filter(r => r.untracked && r.matchStatus !== "already_imported").reduce((sum, r) => sum.plus(money(r.billedAmount)), money(0)).toFixed(2) };
    if (mode === "commit") {
      for (let i = 0; i < sources.length; i += 500) await tx.insert(altaBillingRowsTable).values(sources.slice(i, i + 500));
      for (let i = 0; i < links.length; i += 1000) await tx.insert(altaBillingRowLinesTable).values(links.slice(i, i + 1000));
      if (billedFees.length) await tx.update(feesTable).set({ status: "invoiced" })
        .where(and(inArray(feesTable.id, [...new Set(billedFees)]), eq(feesTable.status, "pending")));
      await audit(userId, "import_alta_billing", "alta_billing", batch!, JSON.stringify({ ...counts, deferred: parsed.deferred }), tx as unknown as typeof db);
    }
    return { mode, headers: parsed.headers, rows, ...counts, deferred: parsed.deferred, importBatchId: batch,
      totalAmount: parsed.rows.reduce((sum, r) => sum.plus(money(r.billedAmount)), money(0)).toFixed(2) };
  });
}
