import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  clientsTable,
  vendorsTable,
  authorizationsTable,
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

const coordEmail = `${nonce}-coord@test.local`;
const uciA = `${nonce}-UCI-A`;
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
});

afterAll(async () => {
  await db.delete(feesTable).where(inArray(feesTable.clientId, [clientAId]));
  await db.delete(remittancesTable).where(inArray(remittancesTable.clientId, [clientAId]));
  await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, [clientAId]));
  await db.delete(authorizationsTable).where(inArray(authorizationsTable.clientId, [clientAId]));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
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
  it("catches bad rows, missing FKs, and ambiguity without writing", async () => {
    const csv = [
      "Client UCI *,Vendor Name,Auth Number,QB Check Number *,Check Date *,Amount *,Payment Month,Payment Type",
      // valid — resolves client + vendor + auth
      `${uciA},${vendorAName},${authANumber},${nonce}-CHK-1,2026-02-15,500.00,,`,
      // bad amount
      `${uciA},,,${nonce}-CHK-2,2026-02-15,not-a-number,,`,
      // unknown UCI
      `${nonce}-UCI-MISSING,,,${nonce}-CHK-3,2026-02-15,10.00,,`,
      // unknown vendor
      `${uciA},${nonce}-NO-SUCH-VENDOR,,${nonce}-CHK-4,2026-02-15,10.00,,`,
      // bad auth scoped to client
      `${uciA},,NOPE-AUTH,${nonce}-CHK-5,2026-02-15,10.00,,`,
    ].join("\n");
    const res = await request(app).post("/api/import/payments/validate").set("Cookie", cookie).send({ csvText: csv });
    expect(res.status).toBe(200);
    const body = res.body as {
      totalRows: number;
      validRows: number;
      errorRows: number;
      results: { rowNumber: number; status: string; errors?: string[] }[];
    };
    expect(body.totalRows).toBe(5);
    expect(body.validRows).toBe(1);
    expect(body.errorRows).toBe(4);
    const byRow = new Map(body.results.map((r) => [r.rowNumber, r]));
    expect(byRow.get(2)!.status).toBe("valid");
    expect(byRow.get(3)!.status).toBe("error"); // bad amount
    expect(byRow.get(4)!.errors!.join(" ")).toContain("No client found");
    expect(byRow.get(5)!.errors!.join(" ")).toContain("No vendor found");
    expect(byRow.get(6)!.errors!.join(" ")).toContain("Authorization");
    // No writes happened.
    const [dup] = await db.select().from(paymentsTable).where(eq(paymentsTable.qbCheckNumber, `${nonce}-CHK-1`));
    expect(dup).toBeUndefined();
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
    const def = getEntityDef("payments");
    const grid = parseCsv(
      [
        "Client UCI *,Vendor Name,QB Check Number *,Check Date *,Amount *",
        `UCI-X,Dup Vendor,CHK-Z,2026-02-15,10.00`,
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
    const def = getEntityDef("payments");
    const grid = parseCsv(
      [
        "Client UCI *,Auth Number,QB Check Number *,Check Date *,Amount *",
        `UCI-X,AUTH-DUP,CHK-Z,2026-02-15,10.00`,
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

describe("POST /import/payments/commit", () => {
  it("imports historical payments tagged source=historical_import with NO auto-generated fee", async () => {
    const csv = [
      "Client UCI *,Auth Number,QB Check Number *,Check Date *,Amount *",
      `${uciA},${authANumber},${nonce}-HIST-1,2026-03-15,750.00`,
    ].join("\n");
    const res = await request(app).post("/api/import/payments/commit").set("Cookie", cookie).send({ csvText: csv });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    const [pay] = await db.select().from(paymentsTable).where(eq(paymentsTable.qbCheckNumber, `${nonce}-HIST-1`));
    expect(pay).toBeTruthy();
    expect(pay.source).toBe("historical_import");
    expect(pay.paymentMonth).toBe("2026-03"); // derived from check date
    expect(pay.authorizationId).toBe(authAId);
    // Critically: NO fee was auto-generated for this historical import.
    const fees = await db.select().from(feesTable).where(eq(feesTable.paymentId, pay.id));
    expect(fees.length).toBe(0);
  });

  it("skips a duplicate check number", async () => {
    const csv = [
      "Client UCI *,QB Check Number *,Check Date *,Amount *",
      `${uciA},${nonce}-HIST-1,2026-04-15,100.00`,
    ].join("\n");
    const res = await request(app).post("/api/import/payments/commit").set("Cookie", cookie).send({ csvText: csv });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skippedDuplicate).toBe(1);
  });

  it("a bulk-imported historical payment is returned by GET /payments (response validation passes)", async () => {
    // Regression: Payment.source spec enum must include "historical_import",
    // otherwise ListPaymentsResponse.parse throws on any historical row.
    const res = await request(app)
      .get("/api/payments")
      .query({ search: `${nonce}-HIST-1`, limit: 50, offset: 0 })
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    const found = (res.body.items as { qbCheckNumber: string; source: string }[]).find(
      (p) => p.qbCheckNumber === `${nonce}-HIST-1`,
    );
    expect(found).toBeTruthy();
    expect(found!.source).toBe("historical_import");
  });
});

describe("POST /import/authorizations/commit", () => {
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
      "Client UCI Number,Authorization Number,Payment Date,Amount,Service Month,Check Number",
      `${uciA},${authANumber},2026-06-01,321.00,2026-05,XREF-1`,
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
