import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, clientsTable, usersTable, sessionsTable, staffRolesTable, staffRolePermissionsTable,
  authorizationsTable, paymentsTable, paymentAllocationsTable, feesTable, altaBillingRowsTable,
  altaBillingRowLinesTable, reviewFlagsTable, auditLogTable, remittancesTable, remittanceAllocationsTable } from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";
import { syntheticBillingCsv } from "./fixtures/altaBillingCsv";
import { billingDetails } from "../lib/billingStatus";
import { updateFeeCollectionStatus } from "../lib/feeRemittance";

const nonce = `bill${Date.now().toString(36)}`;
let staff: string, denied: string, family: string, role: string, client: string, a459: string, a024: string, a490: string;
let fee: string, collected: string, flag: string;
const people: string[] = [], paymentIds: string[] = [], lines: string[] = [];
const uci = `${nonce}-uci`;
async function login(user: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({ userId: user, token, expiresAt: new Date(Date.now() + 3600000) });
  return `ceps_session=${token}`;
}
const bill = (auth: string, amount: string, code = "459", invoice = "INV-ONE", date = "07/30/2026", month = "07/2026") =>
  ({ uci, auth, amount, code, invoice: `${nonce}-${invoice}`, date, month });
const csv = () => syntheticBillingCsv([
  bill(`${nonce}-459`, "100"), bill(`${nonce}-024`, "65", "24", "INV-TWO"), // mismatch: line is $60
  bill(`${nonce}-490`, "160", "490", "INV-FEE"),
  bill(`${nonce}-490`, "160", "490", "INV-COLLECTED", "07/30/2026", "08/2026"),
  bill("MISSING", "20", "459", "INV-NOAUTH"),
  { ...bill("UNKNOWN", "10", "34", "INV-UNTRACKED"), uci: `${nonce}-unknown` },
  { ...bill(`${nonce}-459`, "0"), total: "100" },
]);
const post = (data: string, mode = "commit", cookie = staff) => request(app).post("/api/billing/import").set("Cookie", cookie).send({ csvContent: data, mode });

beforeAll(async () => {
  const [r] = await db.insert(staffRolesTable).values({ name: `${nonce} billing` }).returning(); role = r.id;
  await db.insert(staffRolePermissionsTable).values([
    { roleId: role, permission: "remittance_entry" }, { roleId: role, permission: "check_writing" },
  ]);
  for (const [name, type, staffRoleId] of [["Staff", "staff", role], ["Denied", "staff", null], ["Family", "parent_guardian", null]] as const) {
    const [p] = await db.insert(usersTable).values({ name: `${nonce} ${name}`, email: `${nonce}-${name}@example.test`, role: type, staffRoleId }).returning();
    people.push(p.id);
  }
  [staff, denied, family] = await Promise.all(people.map(login));
  const [c] = await db.insert(clientsTable).values({ firstName: "Synthetic", lastName: nonce, dateOfBirth: "2000-01-01", uciNumber: uci }).returning(); client = c.id;
  for (const [code, paymentType] of [["459", "direct_payment"], ["024", "reimbursement"], ["490", "fee"]] as const) {
    const [a] = await db.insert(authorizationsTable).values({ clientId: client, authNumber: `${nonce}-${code}`, serviceCode: code, paymentType,
      servicePeriodStart: "2026-01-01", servicePeriodEnd: "2026-12-31", maxPeriodAmount: "10000" }).returning();
    if (code === "459") a459 = a.id; else if (code === "024") a024 = a.id; else a490 = a.id;
  }
  for (const [auth, amount] of [[a459, "40"], [a459, "60"], [a024, "60"]]) {
    const [p] = await db.insert(paymentsTable).values({ clientId: client, authorizationId: auth, qbCheckNumber: `${nonce}-${paymentIds.length}`,
      checkDate: "2026-07-10", amount, paymentMonth: "2026-07", paymentType: "direct_payment", source: "manual" }).returning();
    paymentIds.push(p.id);
    const [l] = await db.insert(paymentAllocationsTable).values({ paymentId: p.id, authorizationId: auth, serviceMonth: "2026-07", amount }).returning();
    lines.push(l.id);
  }
  const [f] = await db.insert(feesTable).values({ clientId: client, authorizationId: a490, feeMonth: "2026-07", amount: "160" }).returning(); fee = f.id;
  const [f2] = await db.insert(feesTable).values({ clientId: client, authorizationId: a490, feeMonth: "2026-08", amount: "160", status: "collected" }).returning(); collected = f2.id;
});
afterAll(async () => {
  if (!client) return;
  await db.delete(reviewFlagsTable).where(sql`${reviewFlagsTable.flaggedBy} in (${sql.join(people.map(id => sql`${id}`), sql`, `)})`);
  await db.delete(altaBillingRowLinesTable).where(sql`${altaBillingRowLinesTable.billingRowId} in (select id from alta_billing_rows where created_by = ${people[0]})`);
  await db.delete(altaBillingRowsTable).where(eq(altaBillingRowsTable.createdBy, people[0]));
  await db.delete(remittanceAllocationsTable).where(sql`remittance_id in (select id from remittances where client_id = ${client})`);
  await db.delete(remittancesTable).where(eq(remittancesTable.clientId, client));
  await db.delete(feesTable).where(eq(feesTable.clientId, client));
  await db.delete(paymentAllocationsTable).where(inArray(paymentAllocationsTable.paymentId, paymentIds));
  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, client));
  await db.delete(authorizationsTable).where(eq(authorizationsTable.clientId, client));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, people));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, people));
  await db.delete(clientsTable).where(eq(clientsTable.id, client));
  await db.delete(usersTable).where(inArray(usersTable.id, people));
  await db.delete(staffRolesTable).where(eq(staffRolesTable.id, role));
});

describe("billing import and staff follow-up", () => {
  it("preview is read-only, links all monthly lines, shows mismatch/unmatched/untracked", async () => {
    const r = await post(csv(), "preview"); expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ imported: 0, matched: 3, amountMismatch: 1, unmatched: 2, deferred: 1, untrackedCount: 1, untrackedAmount: "10.00" });
    expect(r.body.rows[0].targetCount).toBe(2);
    expect(r.body.rows[1].serviceCode).toBe("024");
    expect(r.body.rows[1].reviewReason).toBe("Billed $65.00, check lines total $60.00");
    expect(r.body.rows[5].reviewReason).toBe("Service code 034 isn't tracked in the portal");
    expect(await db.select().from(altaBillingRowsTable).where(eq(altaBillingRowsTable.createdBy, people[0]))).toHaveLength(0);
  });
  it("commits once per source row, never uncollects fees, dedupes and audits once per import", async () => {
    const r = await post(csv()); expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.imported).toBe(6);
    expect(await db.select().from(altaBillingRowLinesTable).where(inArray(altaBillingRowLinesTable.paymentAllocationId, lines))).toHaveLength(3);
    expect((await db.select().from(feesTable).where(eq(feesTable.id, fee)))[0].status).toBe("invoiced");
    expect((await db.select().from(feesTable).where(eq(feesTable.id, collected)))[0].status).toBe("collected");
    const dup = await post(csv()); expect(dup.body).toMatchObject({ imported: 0, alreadyImported: 6 });
    const audit = await db.select().from(auditLogTable).where(and(eq(auditLogTable.userId, people[0]), eq(auditLogTable.action, "import_alta_billing")));
    expect(audit).toHaveLength(2);
  });
  it("re-bills all existing lines, preserves old links, displays latest invoice date and count", async () => {
    const r = await post(syntheticBillingCsv([bill(`${nonce}-459`, "100", "459", "INV-REBILL", "09/30/2026")]));
    expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.rebilled).toBe(1); expect(r.body.rows[0].targetCount).toBe(2);
    const meta = await billingDetails("payment_line", lines);
    expect(meta.get(lines[0])).toMatchObject({ billingStatus: "billed", billedAt: "2026-09-30", billingCount: 2, billedAmount: "40.00" });
    // Importing an older invoice later must not regress the displayed date.
    await post(syntheticBillingCsv([bill(`${nonce}-459`, "100", "459", "INV-OLD", "08/30/2026")]));
    expect((await billingDetails("payment_line", lines)).get(lines[0])).toMatchObject({ billedAt: "2026-09-30", billingCount: 3 });
    const api = await request(app).get(`/api/payments?clientId=${client}`).set("Cookie", staff);
    expect(api.status).toBe(200);
    expect(api.body.items.flatMap((p: { allocations: unknown[] }) => p.allocations)).toEqual(expect.arrayContaining([expect.objectContaining({ id: lines[0], billingCount: 3, billedAt: "2026-09-30" })]));
  });
  it("supports partial remittances without losing fee billing state", async () => {
    const [r] = await db.insert(remittancesTable).values({ clientId: client, authorizationId: a490, remittanceDate: "2026-10-01", paymentMonth: "2026-07", amount: "40", status: "received" }).returning();
    await db.transaction(async tx => {
      await tx.insert(remittanceAllocationsTable).values({ remittanceId: r.id, feeId: fee, amount: "40" });
      await updateFeeCollectionStatus(tx as unknown as typeof db, fee, people[0], r.id);
    });
    expect((await billingDetails("fee", [fee])).get(fee)).toMatchObject({ billingStatus: "partially_paid", remittedAmount: "40.00", billedAt: "2026-07-30" });
    expect((await db.select().from(feesTable).where(eq(feesTable.id, fee)))[0].status).toBe("invoiced");
  });
  it("flags exactly once while open, resolves with note, and permits re-flag", async () => {
    const create = () => request(app).post("/api/review-flags").set("Cookie", staff).send({ targetType: "payment_line", targetId: lines[0], reason: "Alta skipped this check" });
    const r = await create(); expect(r.status, JSON.stringify(r.body)).toBe(201); flag = r.body.id;
    expect((await create()).status).toBe(409);
    const report = await request(app).get(`/api/reports/billing?report=flagged&clientId=${client}`).set("Cookie", staff);
    expect(report.status, JSON.stringify(report.body)).toBe(200); expect(report.body.total).toBe(1);
    expect(report.body.items[0].flag.reason).toBe("Alta skipped this check");
    const resolved = await request(app).post(`/api/review-flags/${flag}/resolve`).set("Cookie", staff).send({ note: "Followed up with Alta" });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const history = await request(app).get(`/api/reports/billing?report=flagged&status=resolved&clientId=${client}`).set("Cookie", staff);
    expect(history.body.items[0].flag.resolutionNote).toBe("Followed up with Alta");
    expect((await create()).status).toBe(201);
  });
  it("fee flags are unique under concurrent requests and are included in fee responses", async () => {
    const create = () => request(app).post("/api/review-flags").set("Cookie", staff).send({ targetType: "fee", targetId: fee, reason: "Fee payment short" });
    const results = await Promise.all([create(), create()]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    const id = results.find(r => r.status === 201)!.body.id;
    const listed = await request(app).get(`/api/fees?clientId=${client}`).set("Cookie", staff);
    expect(listed.status).toBe(200);
    expect(listed.body.find((f: { id: string }) => f.id === fee)).toMatchObject({ billingStatus: "partially_paid", flag: { id, reason: "Fee payment short" } });
    const resolved = await request(app).post(`/api/review-flags/${id}/resolve`).set("Cookie", staff).send({ note: "Confirmed balance with Alta" });
    expect(resolved.status).toBe(200);
  });
  it("does not replace check-line identities that have billing history", async () => {
    const r = await request(app).patch(`/api/payments/${paymentIds[0]}`).set("Cookie", staff)
      .send({ allocations: [{ authorizationId: a459, serviceMonth: "2026-07", amount: "40" }] });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error).toMatch(/history.*preserved/);
    expect(await db.select().from(paymentAllocationsTable).where(eq(paymentAllocationsTable.id, lines[0]))).toHaveLength(1);
  });
  it("both reports filter and export full CSV rather than a single page", async () => {
    const unpaid = await request(app).get(`/api/reports/billing?report=unpaid&clientId=${client}&limit=1`).set("Cookie", staff);
    expect(unpaid.status, JSON.stringify(unpaid.body)).toBe(200); expect(unpaid.body.total).toBe(4); // 3 lines + partially paid fee; legacy collected is already Paid.
    expect(unpaid.body.items).toHaveLength(1);
    const aged = await request(app).get(`/api/reports/billing?report=unpaid&clientId=${client}&olderThanDays=90`).set("Cookie", staff);
    expect(aged.status, JSON.stringify(aged.body)).toBe(200);
    expect(aged.body.items.every((r: { daysSinceBilled: number }) => r.daysSinceBilled >= 90)).toBe(true);
    for (const report of ["flagged", "unpaid"]) {
      const r = await request(app).get(`/api/reports/billing/export?report=${report}&status=all&clientId=${client}`).set("Cookie", staff);
      expect(r.status, r.text).toBe(200); expect(r.headers["content-type"]).toMatch(/text\/csv/);
      expect(r.text).toContain("Participant"); expect(r.text).toContain("07/2026");
      if (report === "unpaid") expect(r.text.split("\r\n")).toHaveLength(5);
      else expect(r.text).toContain("Followed up with Alta");
    }
    const filter = await request(app).get(`/api/reports/billing?report=unpaid&clientId=${client}&startDate=2030-01-01`).set("Cookie", staff);
    expect(filter.body.total).toBe(0);
  });
  it("handles 1,350 synthetic source rows in batched preview and import", async () => {
    const large = syntheticBillingCsv(Array.from({ length: 1350 }, (_, i) =>
      bill(`${nonce}-459`, "100", "459", `SCALE-${i}`, "07/30/2026")));
    const startPreview = performance.now();
    const preview = await post(large, "preview");
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.rows).toHaveLength(1350);
    expect(preview.body.rows.every((r: { targetCount: number }) => r.targetCount === 2)).toBe(true);
    expect(performance.now() - startPreview).toBeLessThan(5000);
    const startCommit = performance.now();
    const committed = await post(large);
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect(committed.body.imported).toBe(1350);
    expect(performance.now() - startCommit).toBeLessThan(5000);
    // Billing never records or changes payments.
    expect((await db.select().from(paymentsTable).where(inArray(paymentsTable.id, paymentIds))).every(p => !p.remitted)).toBe(true);
  });
  it("requires remittance_entry for mutations/import; staff-only reports; validates notes and wrong files", async () => {
    for (const cookie of [denied, family]) {
      expect((await post(csv(), "preview", cookie)).status).toBe(403);
      expect((await request(app).post("/api/review-flags").set("Cookie", cookie).send({ targetType: "fee", targetId: fee, reason: "Problem" })).status).toBe(403);
      expect((await request(app).post(`/api/review-flags/${flag}/resolve`).set("Cookie", cookie).send({ note: "Resolved" })).status).toBe(403);
    }
    expect((await request(app).get("/api/reports/billing?report=flagged").set("Cookie", family)).status).toBe(403);
    const familyFees = await request(app).get(`/api/fees?clientId=${client}`).set("Cookie", family);
    expect(familyFees.body).toEqual([]);
    expect((await request(app).post("/api/review-flags").set("Cookie", staff).send({ targetType: "fee", targetId: fee, reason: " " })).status).toBe(400);
    expect((await request(app).post(`/api/review-flags/${flag}/resolve`).set("Cookie", staff).send({ note: "" })).status).toBe(400);
    expect((await post(syntheticBillingCsv([{ ...bill(`${nonce}-459`, "20"), total: "50" }]))).status).toBe(400);
    expect((await post("UCI #,Client Name,Auth #,Service M/Y,Amount\n1,Test,A,07/2026,100")).status).toBe(400);
  });
});
