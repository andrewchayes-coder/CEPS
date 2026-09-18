import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  authorizationsTable,
  referralsTable,
  paymentsTable,
  remittancesTable,
  feesTable,
  auditLogTable,
} from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";
import { validateRows } from "../lib/importValidation";
import { getEntityDef, parseCsv, type ResolveContext } from "../lib/importRegistry";

const nonce = `imp${Date.now().toString(36)}`;

let staffId: string;
let coordId: string;
let clientAId: string;
let vendorAId: string;
let authAId: string;
let cookie: string;
let coordinatorCookie: string;

const coordEmail = `${nonce}-coord@test.local`;
const uciA = String(Date.now()).slice(-7);
const vendorAName = `${nonce} Bright Futures`;
const authANumber = `${nonce}-AUTH-A`;

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "Imp Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  const [coord] = await db
    .insert(usersTable)
    .values({ name: "Imp Coord", email: coordEmail, role: "service_coordinator" })
    .returning();
  coordId = coord.id;

  const [clientA] = await db
    .insert(clientsTable)
    .values({ firstName: "Imp", lastName: "ClientA", dateOfBirth: "2015-01-01", uciNumber: uciA })
    .returning();
  clientAId = clientA.id;

  const [vendorA] = await db.insert(vendorsTable).values({ name: vendorAName }).returning();
  vendorAId = vendorA.id;
  // NOTE: a case-insensitive unique index now prevents two vendors sharing a
  // name at the DB level, so the resolver's "ambiguous" path is exercised as a
  // unit test (see below) with a hand-built ResolveContext instead of seeded
  // duplicate rows.

  const [authA] = await db
    .insert(authorizationsTable)
    .values({
      clientId: clientAId,
      authNumber: authANumber,
      serviceCode: "459",
      paymentType: "direct_payment",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-12-31",
      maxPeriodAmount: "10000.00",
    })
    .returning();
  authAId = authA.id;

  const token = newToken();
  await db.insert(sessionsTable).values({ userId: staffId, token, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  cookie = `ceps_session=${token}`;
  const coordinatorToken = newToken();
  await db.insert(sessionsTable).values({ userId: coordId, token: coordinatorToken, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  coordinatorCookie = `ceps_session=${coordinatorToken}`;
});

afterAll(async () => {
  await db.delete(referralsTable).where(eq(referralsTable.clientId, clientAId));
  await db.delete(feesTable).where(inArray(feesTable.clientId, [clientAId]));
  await db.delete(remittancesTable).where(inArray(remittancesTable.clientId, [clientAId]));
  await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, [clientAId]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientAId]));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, coordId]));
  // Clean up any imported clients (by UCI prefix) and vendors (by name prefix).
  const importedClients = await db.select({ id: clientsTable.id }).from(clientsTable).where(inArray(clientsTable.uciNumber, [uciA, `${nonce}-UCI-NEW`]));
  const importedClientIds = importedClients.map((c) => c.id);
  if (importedClientIds.length) {
    await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, importedClientIds));
    await db.delete(clientsTable).where(inArray(clientsTable.id, importedClientIds));
  }
  await db.delete(vendorsTable).where(inArray(vendorsTable.name, [vendorAName, `${nonce} New Vendor`]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, coordId]));
});

// ── Template generation ──────────────────────────────────────────────────────

describe("GET /import/:entity/template", () => {
  it("generates a CSV template from the registry with required fields marked", async () => {
    const res = await request(app).get("/api/import/clients/template").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const [header, example] = res.text.split(/\r?\n/);
    // Required fields get a trailing " *".
    expect(header).toContain("First Name *");
    expect(header).toContain("UCI Number *");
    // Optional fields do NOT.
    expect(header).toContain("Regional Center");
    expect(header).not.toContain("Regional Center *");
    // Example row present and clearly marked as sample data.
    expect(example).toContain("UCI-0001");
    expect(example).toContain("EXAMPLE (delete this row):");
  });

  it("404s on an unknown entity", async () => {
    const res = await request(app).get("/api/import/widgets/template").set("Cookie", cookie);
    expect(res.status).toBe(404);
  });

  it("is staff-only", async () => {
    const res = await request(app).get("/api/import/clients/template");
    expect(res.status).toBe(401);
  });
});

// ── Validate (dry run) ───────────────────────────────────────────────────────

describe("POST /import/:entity/validate", () => {
  it("does not expose the retired generic payments validation route", async () => {
    const res = await request(app).post("/api/import/payments/validate").set("Cookie", cookie).send({ csvText: "synthetic" });
    expect(res.status).toBe(404);
  });

  it("rejects the template's unedited example row instead of importing it", async () => {
    const tpl = await request(app).get("/api/import/clients/template").set("Cookie", cookie);
    const res = await request(app)
      .post("/api/import/clients/validate")
      .set("Cookie", cookie)
      .send({ csvText: tpl.text });
    expect(res.status).toBe(200);
    const row = res.body.results[0];
    expect(row.status).toBe("error");
    expect(row.errors.join(" ")).toContain("example row");
  });

  it("reports a header error when a required column is missing", async () => {
    const csv = ["First Name,Last Name,Date of Birth", "A,B,2020-01-01"].join("\n");
    const res = await request(app).post("/api/import/clients/validate").set("Cookie", cookie).send({ csvText: csv });
    expect(res.status).toBe(200);
    expect(res.body.headerError).toContain("UCI Number");
  });
});

// ── Ambiguity (unit) ──────────────────────────────────────────────────────────
// A case-insensitive vendor-name unique index and a (client, auth_number) unique
// index now prevent genuine duplicate natural keys at the DB level, so the
// resolvers' "ambiguous" branches are exercised with a hand-built context.
describe("FK resolvers treat an ambiguous natural key as a hard row error", () => {
  it("errors when a vendor name resolves to more than one vendor", () => {
    const def = getEntityDef("authorizations");
    const grid = parseCsv(
      [
        "Client UCI *,Vendor Name,Auth Number *,Service Code *,Service Period Start *,Service Period End *,Max Period Amount *",
        "UCI-X,Dup Vendor,AUTH-Z,459,2026-01-01,2026-12-31,10.00",
      ].join("\n"),
    );
    const ctx: ResolveContext = {
      usersByEmail: new Map(),
      clientsByUci: new Map([["UCI-X", "client-x"]]),
      vendorsByName: new Map([["dup vendor", "ambiguous"]]),
      authsByClientAndNumber: new Map(),
    };
    const outcome = validateRows(def, grid, ctx);
    expect(outcome.headerError).toBeNull();
    expect(outcome.rows[0].values).toBeNull();
    expect(outcome.rows[0].errors.join(" ")).toContain("Multiple vendors share the name");
  });

  it("errors when a (client, auth number) key resolves to more than one authorization", () => {
    const def = getEntityDef("remittances");
    const grid = parseCsv(
      [
        "Client UCI *,Auth Number,Remittance Date *,Amount *",
        "UCI-X,AUTH-DUP,2026-02-15,10.00",
      ].join("\n"),
    );
    const ctx: ResolveContext = {
      usersByEmail: new Map(),
      clientsByUci: new Map([["UCI-X", "client-x"]]),
      vendorsByName: new Map(),
      authsByClientAndNumber: new Map([["client-x::AUTH-DUP", "ambiguous"]]),
    };
    const outcome = validateRows(def, grid, ctx);
    expect(outcome.headerError).toBeNull();
    expect(outcome.rows[0].values).toBeNull();
    expect(outcome.rows[0].errors.join(" ")).toContain("Multiple authorizations share the number");
  });
});

// ── Commit ───────────────────────────────────────────────────────────────────

describe("POST /import/clients/commit + vendors", () => {
  it("inserts new clients, resolves coordinator email, skips duplicates, audits", async () => {
    const csv = [
      "First Name *,Last Name *,Date of Birth *,UCI Number *,Coordinator Email",
      `New,Client,2016-05-05,${nonce}-UCI-NEW,${coordEmail}`,
      // duplicate of the seeded client (existing UCI) → skipped
      `Dup,Client,2015-01-01,${uciA},`,
    ].join("\n");
    const res = await request(app).post("/api/import/clients/commit").set("Cookie", cookie).send({ csvText: csv });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skippedDuplicate).toBe(1);
    const [inserted] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, `${nonce}-UCI-NEW`));
    expect(inserted).toBeTruthy();
    expect(inserted.assignedCoordinatorId).toBe(coordId);
    const audits = await db
      .select()
      .from(auditLogTable)
      .where(and(eq(auditLogTable.userId, staffId), eq(auditLogTable.action, "import_client")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("skips a duplicate vendor by name and imports a new one", async () => {
    const csv = ["Name *", `${vendorAName}`, `${nonce} New Vendor`].join("\n");
    const res = await request(app).post("/api/import/vendors/commit").set("Cookie", cookie).send({ csvText: csv });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skippedDuplicate).toBe(1);
  });
});

describe("POST /payments/import", () => {
  const worksheetRows = [
    ["Transaction date", "Transaction type", "Num", "Name", "Description", "Split", "Amount", "Customer"],
    ["03/31/2026", "Check", `${nonce}-HIST`, "Vendor", `Services/Mar 26/${authANumber}`, "", "125.00", `Synthetic ${uciA} (1)`],
    ["04/01/2026", "Check", `${nonce}-HIST`, "Vendor", `Services/Apr 26/${authANumber}`, "", "225.00", `Synthetic ${uciA} (1)`],
    ["04/02/2026", "Check", `${nonce}-UNKNOWN`, "Vendor", "Services/Apr 26/MISSING-AUTH", "", "10.00", "Synthetic 7654321 (1)"],
    ["04/02/2026", "Check", `${nonce}-BAD-AUTH`, "Vendor", "Services/Apr 26/MISSING-AUTH", "", "10.00", `Synthetic ${uciA} (1)`],
    ["04/02/2026", "Check", "", "Vendor", `Services/Apr 26/${authANumber}`, "", "10.00", `Synthetic ${uciA} (1)`],
    ["04/02/2026", "Invoice", "INV-1", "Vendor", "Services/Apr 26/IGNORED", "", "10.00", `Synthetic ${uciA} (1)`],
  ];

  it("is staff-only", async () => {
    const unauthenticated = await request(app).post("/api/payments/import").send({ worksheetRows });
    expect(unauthenticated.status).toBe(401);
    const coordinator = await request(app).post("/api/payments/import").set("Cookie", coordinatorCookie).send({ worksheetRows });
    expect(coordinator.status).toBe(403);
  });

  it("imports valid FMS lines, reports row errors, and skips an identical re-upload", async () => {
    const first = await request(app).post("/api/payments/import").set("Cookie", cookie).send({ worksheetRows });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ imported: 2, errored: 3, ignoredNonCheckRows: 1, skippedDuplicate: 0, headerError: null });
    expect(first.body.results.filter((r: { outcome: string }) => r.outcome === "errored").map((r: { message: string }) => r.message).join(" ")).toContain("No client found");
    expect(first.body.results.filter((r: { outcome: string }) => r.outcome === "errored").map((r: { message: string }) => r.message).join(" ")).toContain("Authorization");
    expect(first.body.results.filter((r: { outcome: string }) => r.outcome === "errored").map((r: { message: string }) => r.message).join(" ")).toContain("malformed Check row");

    const payments = await db.select().from(paymentsTable).where(eq(paymentsTable.qbCheckNumber, `${nonce}-HIST`));
    expect(payments).toHaveLength(2);
    expect(payments.map((payment) => payment.paymentMonth).sort()).toEqual(["2026-03", "2026-04"]);
    expect(payments.every((payment) => payment.authorizationId === authAId && payment.source === "historical_import")).toBe(true);
    const feeRows = await db.select().from(feesTable).where(inArray(feesTable.paymentId, payments.map((payment) => payment.id)));
    expect(feeRows).toHaveLength(0);

    const second = await request(app).post("/api/payments/import").set("Cookie", cookie).send({ worksheetRows });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ imported: 0, skippedDuplicate: 2, errored: 3, ignoredNonCheckRows: 1 });
  });

  it("preserves row outcomes and ordering for a workbook larger than one lookup chunk", async () => {
    const missingClientRows = Array.from({ length: 1_000 }, (_, index) => [
      "05/02/2026",
      "Check",
      `${nonce}-BATCH-NO-CLIENT-${index}`,
      "Vendor",
      `Services/May 26/${authANumber}`,
      "",
      "25.00",
      `Synthetic ${String(8_000_000 + index)} (1)`,
    ]);
    const rows = [
      ["Transaction date", "Transaction type", "Num", "Name", "Description", "Split", "Amount", "Customer"],
      ["05/01/2026", "Check", `${nonce}-BATCH-NEW`, "Vendor", `Services/May 26/${authANumber}`, "", "325.00", `Synthetic ${uciA} (1)`],
      ...missingClientRows,
      ["05/03/2026", "Check", `${nonce}-BATCH-NO-AUTH`, "Vendor", "Services/May 26/NOT-IN-WORKBOOK-SCOPE", "", "25.00", `Synthetic ${uciA} (1)`],
    ];

    const first = await request(app).post("/api/payments/import").set("Cookie", cookie).send({ worksheetRows: rows });
    expect(first.status).toBe(200);
    expect(first.body.results).toHaveLength(1_002);
    expect(first.body.results[0].outcome).toBe("imported");
    expect(first.body.results.slice(1, -1).every((row: { outcome: string }) => row.outcome === "errored")).toBe(true);
    expect(first.body.results.at(-1).outcome).toBe("errored");
    expect(first.body.results.map((row: { rowNumber: number }) => row.rowNumber)).toEqual(
      Array.from({ length: 1_002 }, (_, index) => index + 2),
    );
    expect(first.body).toMatchObject({ imported: 1, skippedDuplicate: 0, flaggedDuplicate: 0, errored: 1_001 });

    const second = await request(app).post("/api/payments/import").set("Cookie", cookie).send({ worksheetRows: rows });
    expect(second.status).toBe(200);
    expect(second.body.results).toHaveLength(1_002);
    expect(second.body.results[0].outcome).toBe("skipped_duplicate");
    expect(second.body.results.slice(1).every((row: { outcome: string }) => row.outcome === "errored")).toBe(true);
    expect(second.body.results.map((row: { rowNumber: number }) => row.rowNumber)).toEqual(
      Array.from({ length: 1_002 }, (_, index) => index + 2),
    );
    expect(second.body).toMatchObject({ imported: 0, skippedDuplicate: 1, flaggedDuplicate: 0, errored: 1_001 });
  });
});

describe("POST /import/authorizations/commit", () => {
  it("advances a matching pending-auth referral through the normal authorization POST", async () => {
    const [referral] = await db.insert(referralsTable).values({
      clientId: clientAId,
      referralDate: "2026-01-02",
      status: "pending_auth",
      submittedVia: "staff_manual_entry",
    }).returning();
    const authNumber = `${nonce}-AUTH-POST-TRANSITION`;
    const res = await request(app).post("/api/authorizations").set("Cookie", cookie).send({
      clientId: clientAId,
      vendorId: vendorAId,
      authNumber,
      serviceCode: "459",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-06-30",
      maxPeriodAmount: "3000.00",
    });
    expect(res.status).toBe(201);
    const [updated] = await db.select().from(referralsTable).where(eq(referralsTable.id, referral.id));
    expect(updated.status).toBe("pending_w9");
    expect(updated.altaAuthReceivedAt).toBeInstanceOf(Date);
  });

  it("uses pending_invoice for W-9 on file and ignores intake and other-client referrals", async () => {
    const [vendor] = await db.insert(vendorsTable).values({
      name: `${nonce} W9 Vendor`,
      w9Status: "on_file",
    }).returning();
    const [otherClient] = await db.insert(clientsTable).values({
      firstName: "Other",
      lastName: "Client",
      dateOfBirth: "2010-01-01",
      uciNumber: `${nonce}-OTHER`,
    }).returning();
    const createdReferrals = await db.insert(referralsTable).values([
      { clientId: clientAId, referralDate: "2026-01-03", status: "pending_auth", submittedVia: "staff_manual_entry" },
      { clientId: clientAId, referralDate: "2026-01-04", status: "intake", submittedVia: "staff_manual_entry" },
      { clientId: otherClient.id, referralDate: "2026-01-01", status: "pending_auth", submittedVia: "staff_manual_entry" },
    ]).returning();
    const res = await request(app).post("/api/authorizations").set("Cookie", cookie).send({
      clientId: clientAId,
      vendorId: vendor.id,
      authNumber: `${nonce}-AUTH-W9-TRANSITION`,
      serviceCode: "024",
      servicePeriodStart: "2026-01-01",
      servicePeriodEnd: "2026-06-30",
      maxPeriodAmount: "3000.00",
    });
    expect(res.status).toBe(201);
    const rows = await db.select().from(referralsTable).where(inArray(referralsTable.clientId, [clientAId, otherClient.id]));
    expect(rows.find((row) => row.id === createdReferrals[0].id)?.status).toBe("pending_invoice");
    expect(rows.find((row) => row.id === createdReferrals[0].id)?.altaAuthReceivedAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.id === createdReferrals[1].id)?.status).toBe("intake");
    expect(rows.find((row) => row.id === createdReferrals[1].id)?.altaAuthReceivedAt).toBeNull();
    await db.delete(authorizationsTable).where(eq(authorizationsTable.authNumber, `${nonce}-AUTH-W9-TRANSITION`));
    expect(rows.filter((row) => row.clientId === otherClient.id)[0].status).toBe("pending_auth");
    expect(rows.filter((row) => row.clientId === otherClient.id)[0].altaAuthReceivedAt).toBeNull();
    await db.delete(referralsTable).where(inArray(referralsTable.clientId, [otherClient.id]));
    await db.delete(clientsTable).where(eq(clientsTable.id, otherClient.id));
    await db.delete(vendorsTable).where(eq(vendorsTable.id, vendor.id));
  });

  it("advances only the matching pending-auth referral when an authorization is imported", async () => {
    const [referral] = await db.insert(referralsTable).values({
      clientId: clientAId,
      referralDate: "2026-01-01",
      status: "pending_auth",
      submittedVia: "staff_manual_entry",
    }).returning();
    const authNumber = `${nonce}-AUTH-TRANSITION`;
    const csv = [
      "Client UCI *,Auth Number *,Service Code *,Service Period Start *,Service Period End *,Max Period Amount *",
      `${uciA},${authNumber},459,2026-01-01,2026-06-30,3000.00`,
    ].join("\n");
    const res = await request(app).post("/api/import/authorizations/commit").set("Cookie", cookie).send({ csvText: csv });
    expect(res.status).toBe(200);
    const [updated] = await db.select().from(referralsTable).where(eq(referralsTable.id, referral.id));
    expect(updated.status).toBe("pending_w9");
    expect(updated.altaAuthReceivedAt).toBeInstanceOf(Date);
  });

  it("imports an authorization, deriving payment type from service code", async () => {
    const csv = [
      "Client UCI *,Auth Number *,Service Code *,Service Period Start *,Service Period End *,Max Period Amount *",
      `${uciA},${nonce}-AUTH-NEW,024,2026-01-01,2026-06-30,3000.00`,
    ].join("\n");
    const res = await request(app).post("/api/import/authorizations/commit").set("Cookie", cookie).send({ csvText: csv });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    const [auth] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.authNumber, `${nonce}-AUTH-NEW`));
    expect(auth.paymentType).toBe("reimbursement"); // derived from 024
  });

  it("skips a duplicate auth number scoped to the same client", async () => {
    const csv = [
      "Client UCI *,Auth Number *,Service Code *,Service Period Start *,Service Period End *,Max Period Amount *",
      `${uciA},${authANumber},459,2026-01-01,2026-06-30,3000.00`,
    ].join("\n");
    const res = await request(app).post("/api/import/authorizations/commit").set("Cookie", cookie).send({ csvText: csv });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skippedDuplicate).toBe(1);
  });
});

describe("POST /import/remittances/commit", () => {
  it("imports a remittance and skips a re-upload via source-row fingerprint", async () => {
    const csv = [
      "Client UCI *,Remittance Date *,Amount *,Service Month,Alta Reference",
      `${uciA},2026-05-01,500.00,2026-04,REF-1`,
    ].join("\n");
    const first = await request(app).post("/api/import/remittances/commit").set("Cookie", cookie).send({ csvText: csv });
    expect(first.status).toBe(200);
    expect(first.body.imported).toBe(1);
    // Re-upload the identical row → skipped as duplicate (fingerprint).
    const second = await request(app).post("/api/import/remittances/commit").set("Cookie", cookie).send({ csvText: csv });
    expect(second.status).toBe(200);
    expect(second.body.imported).toBe(0);
    expect(second.body.skippedDuplicate).toBe(1);
  });

  it("dedupes across paths: an Alta-imported row then the same logical row via bulk import is skipped", async () => {
    // Same logical remittance row expressed for BOTH import paths. The two paths
    // must hash it to the SAME source-row fingerprint (raw UCI/auth/check +
    // normalized amount/month/date), so the second import is skipped.
    const altaCsv = [
      "Date,Units,Amount,Reference #",
      "2026-06-01,1,321.00,XREF-1",
      "UCI #,Consumer Name,Auth #,Svc Code,Sub-Code,Service M/Y,Units,Amount,Invoice #,Adj Code,Inv Amt",
      `${uciA},Synthetic Person,${authANumber},459,,05/2026,1,321.00,INV,,321.00`,
    ].join("\n");
    const alta = await request(app).post("/api/remittances/import").set("Cookie", cookie).send({ csvText: altaCsv });
    expect(alta.status).toBe(200);
    expect(alta.body.imported).toBe(1);

    // Same row via the generic bulk-import path (different header names, same values).
    const bulkCsv = [
      "Client UCI *,Auth Number,Remittance Date *,Amount *,Service Month,Alta Reference",
      `${uciA},${authANumber},2026-06-01,321.00,2026-05,XREF-1`,
    ].join("\n");
    const bulk = await request(app).post("/api/import/remittances/commit").set("Cookie", cookie).send({ csvText: bulkCsv });
    expect(bulk.status).toBe(200);
    expect(bulk.body.imported).toBe(0);
    expect(bulk.body.skippedDuplicate).toBe(1);
  });
});
