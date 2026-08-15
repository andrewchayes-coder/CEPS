// ─────────────────────────────────────────────────────────────────────────────
// BULK IMPORT — staff-only, one reusable mechanism for five entities
//
// GET  /import/:entity/template  → CSV generated from the field registry
// POST /import/:entity/validate  → dry-run: per-row validation + FK resolution
// POST /import/:entity/commit    → transactional insert, duplicates skipped
//
// All three share the field registry (importRegistry.ts) and the single
// validation pass (importValidation.ts). Commit RE-VALIDATES every row and
// refuses any that now fail (skip-and-report), and inserts each row in its own
// transaction (Alta-import per-row transaction style).
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, inArray } from "drizzle-orm";
import {
  db,
  clientsTable,
  vendorsTable,
  authorizationsTable,
  paymentsTable,
  remittancesTable,
  usersTable,
} from "@workspace/db";
import {
  ValidateImportBody,
  ValidateImportResponse,
  CommitImportBody,
  CommitImportResponse,
} from "@workspace/api-zod";
import { requireStaff, audit } from "../lib/auth";
import { notDeleted } from "../lib/serializers";
import {
  isImportEntity,
  getEntityDef,
  generateTemplate,
  parseCsv,
  type ImportEntity,
  type EntityDef,
  type ResolveContext,
  type RawRow,
} from "../lib/importRegistry";
import { validateRows, collectFieldValues } from "../lib/importValidation";
import { altaRowFingerprint } from "../lib/altaRemittanceParser";

const router: IRouter = Router();

function derivePaymentType(serviceCode: string): "direct_payment" | "reimbursement" | "fee" {
  if (serviceCode === "459") return "direct_payment";
  if (serviceCode === "024") return "reimbursement";
  return "fee"; // 490
}

/**
 * Build the FK ResolveContext once per import, loading ONLY the reference data
 * referenced by the uploaded CSV (values collected per field). This keeps
 * per-row resolution in-memory and identical between validate and commit.
 */
async function buildResolveContext(def: EntityDef, grid: string[][]): Promise<ResolveContext> {
  const ctx: ResolveContext = {
    usersByEmail: new Map(),
    clientsByUci: new Map(),
    vendorsByName: new Map(),
    authsByClientAndNumber: new Map(),
  };

  // Coordinator emails → users
  const emailField = def.fields.find((f) => f.header === "Coordinator Email");
  if (emailField) {
    const emails = collectFieldValues(def, grid, emailField.key).map((e) => e.toLowerCase());
    if (emails.length) {
      const rows = await db.select({ id: usersTable.id, email: usersTable.email }).from(usersTable).where(inArray(usersTable.email, emails));
      for (const u of rows) ctx.usersByEmail.set(u.email.toLowerCase(), u.id);
    }
  }

  // Client UCIs → clients
  const uciField = def.fields.find((f) => f.header === "Client UCI");
  if (uciField) {
    const ucis = collectFieldValues(def, grid, uciField.key);
    if (ucis.length) {
      const rows = await db
        .select({ id: clientsTable.id, uciNumber: clientsTable.uciNumber })
        .from(clientsTable)
        .where(and(inArray(clientsTable.uciNumber, ucis), notDeleted(clientsTable)));
      for (const c of rows) ctx.clientsByUci.set(c.uciNumber, c.id);
    }
  }

  // Vendor names → vendors (duplicate name = ambiguous)
  const vendorField = def.fields.find((f) => f.header === "Vendor Name");
  if (vendorField) {
    const names = collectFieldValues(def, grid, vendorField.key);
    if (names.length) {
      const lower = names.map((n) => n.toLowerCase());
      const rows = await db.select({ id: vendorsTable.id, name: vendorsTable.name }).from(vendorsTable);
      for (const v of rows) {
        const key = v.name.trim().toLowerCase();
        if (!lower.includes(key)) continue;
        const existing = ctx.vendorsByName.get(key);
        if (existing === undefined) ctx.vendorsByName.set(key, { id: v.id });
        else ctx.vendorsByName.set(key, "ambiguous");
      }
    }
  }

  // Auth numbers scoped per resolved client
  const clientIds = [...new Set(ctx.clientsByUci.values())];
  const hasAuthField = def.fields.some((f) => f.header === "Auth Number" && f.resolve);
  if (hasAuthField && clientIds.length) {
    const rows = await db
      .select({ id: authorizationsTable.id, clientId: authorizationsTable.clientId, authNumber: authorizationsTable.authNumber })
      .from(authorizationsTable)
      .where(and(inArray(authorizationsTable.clientId, clientIds), notDeleted(authorizationsTable)));
    for (const a of rows) {
      const key = `${a.clientId}::${a.authNumber}`;
      const existing = ctx.authsByClientAndNumber.get(key);
      // Ambiguity is a hard row error — never silently overwrite / guess which
      // authorization the row means when the (client, number) key is not unique.
      if (existing === undefined) ctx.authsByClientAndNumber.set(key, { id: a.id });
      else ctx.authsByClientAndNumber.set(key, "ambiguous");
    }
  }

  return ctx;
}

// ── Duplicate detection (natural keys) ───────────────────────────────────────

interface DupIndex {
  /** Returns a duplicate detail string when the validated row is a duplicate. */
  isDuplicate(values: Record<string, unknown>, raw: RawRow): string | null;
  /** Record a just-committed row so intra-file duplicates are also caught. */
  record(values: Record<string, unknown>, raw: RawRow): void;
}

async function buildDupIndex(entity: ImportEntity): Promise<DupIndex> {
  switch (entity) {
    case "clients": {
      const rows = await db.select({ uciNumber: clientsTable.uciNumber }).from(clientsTable).where(notDeleted(clientsTable));
      const seen = new Set(rows.map((r) => r.uciNumber));
      return {
        isDuplicate: (v) => (typeof v.uciNumber === "string" && seen.has(v.uciNumber) ? `A client with UCI "${v.uciNumber}" already exists.` : null),
        record: (v) => typeof v.uciNumber === "string" && seen.add(v.uciNumber),
      };
    }
    case "vendors": {
      const rows = await db.select({ name: vendorsTable.name }).from(vendorsTable);
      const seen = new Set(rows.map((r) => r.name.trim().toLowerCase()));
      return {
        isDuplicate: (v) => (typeof v.name === "string" && seen.has(v.name.trim().toLowerCase()) ? `A vendor named "${v.name}" already exists.` : null),
        record: (v) => typeof v.name === "string" && seen.add(v.name.trim().toLowerCase()),
      };
    }
    case "authorizations": {
      const rows = await db
        .select({ clientId: authorizationsTable.clientId, authNumber: authorizationsTable.authNumber })
        .from(authorizationsTable)
        .where(notDeleted(authorizationsTable));
      const key = (v: Record<string, unknown>) => `${v.clientId}::${v.authNumber}`;
      const seen = new Set(rows.map((r) => `${r.clientId}::${r.authNumber}`));
      return {
        isDuplicate: (v) => (seen.has(key(v)) ? `Authorization "${v.authNumber}" already exists for this client.` : null),
        record: (v) => seen.add(key(v)),
      };
    }
    case "payments": {
      const rows = await db.select({ qbCheckNumber: paymentsTable.qbCheckNumber }).from(paymentsTable).where(notDeleted(paymentsTable));
      const seen = new Set(rows.map((r) => r.qbCheckNumber));
      return {
        isDuplicate: (v) => (typeof v.qbCheckNumber === "string" && seen.has(v.qbCheckNumber) ? `A payment with check number "${v.qbCheckNumber}" already exists.` : null),
        record: (v) => typeof v.qbCheckNumber === "string" && seen.add(v.qbCheckNumber),
      };
    }
    case "remittances": {
      // Natural key: the Alta source-row fingerprint (reused pattern).
      const rows = await db
        .select({ fp: remittancesTable.sourceRowFingerprint })
        .from(remittancesTable)
        .where(notDeleted(remittancesTable));
      const seen = new Set(rows.map((r) => r.fp).filter((f): f is string => !!f));
      return {
        isDuplicate: (v, raw) => {
          const fp = remittanceFingerprint(v, raw);
          return seen.has(fp) ? "This remittance row was already imported (matched by source-row fingerprint)." : null;
        },
        record: (v, raw) => seen.add(remittanceFingerprint(v, raw)),
      };
    }
  }
}

/**
 * Fingerprint a remittance row from the SAME canonical pre-resolution
 * natural-key values the Alta import hashes: raw UCI + raw auth-number strings
 * (NOT resolved UUIDs), normalized service month, validated amount, raw check
 * reference, and ISO remittance date. This guarantees an identical logical row
 * hashes the same whether it arrives via the Alta flow or the generic bulk
 * import, so cross-path dedupe works.
 */
function remittanceFingerprint(values: Record<string, unknown>, raw: RawRow): string {
  return altaRowFingerprint({
    // Natural-key STRINGS come from the raw source cells (pre-resolution), matching
    // the Alta flow which hashes UCI / auth number / check ref as typed by the user.
    uciNumber: String(raw.clientId ?? "").trim(),
    authNumber: raw.authorizationId ? String(raw.authorizationId).trim() || null : null,
    checkNumber: raw.altaReference ? String(raw.altaReference).trim() || null : null,
    // Normalized scalars come from the parsed values, which apply the SAME
    // normalization Alta does (money → fixed(2), month → YYYY-MM, date → ISO).
    amount: String(values.amount ?? "").trim(),
    serviceMonth: values.paymentMonth != null && values.paymentMonth !== "" ? String(values.paymentMonth) : null,
    remittanceDate: String(values.remittanceDate ?? "").trim(),
  });
}

/** True when an insert failed because of a unique-constraint / natural-key race. */
function isDuplicateInsertError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === "duplicate_fingerprint") return true;
  const code = (err as { code?: string }).code;
  if (code === "23505") return true; // Postgres unique_violation
  return /unique|duplicate key/i.test(err.message);
}

// ── Per-entity insert (transactional, applies entity-specific defaults) ──────

async function insertRow(entity: ImportEntity, values: Record<string, unknown>, raw: RawRow, userId: string): Promise<string> {
  // Each row commits (insert + its audit entry) in ONE transaction, mirroring
  // the Alta import's per-row transaction style: a row either lands with its
  // audit trail or not at all, and a failed row never taints the others.
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;
    switch (entity) {
      case "clients": {
        const [row] = await tx.insert(clientsTable).values(values as typeof clientsTable.$inferInsert).returning();
        await audit(userId, "import_client", "client", row.id, `Bulk import — UCI ${row.uciNumber}`, txDb);
        return row.id;
      }
      case "vendors": {
        const [row] = await tx.insert(vendorsTable).values(values as typeof vendorsTable.$inferInsert).returning();
        await audit(userId, "import_vendor", "vendor", row.id, `Bulk import — ${row.name}`, txDb);
        return row.id;
      }
      case "authorizations": {
        const v = { ...values };
        if (v.paymentType == null && typeof v.serviceCode === "string") v.paymentType = derivePaymentType(v.serviceCode);
        const [row] = await tx.insert(authorizationsTable).values(v as typeof authorizationsTable.$inferInsert).returning();
        await audit(userId, "import_authorization", "authorization", row.id, `Bulk import — auth ${row.authNumber}`, txDb);
        return row.id;
      }
      case "payments": {
        const v = { ...values };
        // Derive service month from check date when blank so it is always set.
        if ((v.paymentMonth == null || v.paymentMonth === "") && typeof v.checkDate === "string" && v.checkDate.length >= 7) {
          v.paymentMonth = v.checkDate.slice(0, 7);
        }
        if (v.paymentType == null) v.paymentType = "direct_payment";
        // Historical imports are tagged and MUST NOT auto-generate a Fee (that
        // trigger lives only in POST /payments — this path never calls it).
        v.source = "historical_import";
        v.loggedBy = userId;
        const [row] = await tx.insert(paymentsTable).values(v as typeof paymentsTable.$inferInsert).returning();
        await audit(userId, "import_payment", "payment", row.id, `Bulk import (historical, no fee) — check ${row.qbCheckNumber}`, txDb);
        return row.id;
      }
      case "remittances": {
        const v = { ...values };
        v.source = "alta_regional";
        v.status = "received";
        v.sourceRowFingerprint = remittanceFingerprint(values, raw);
        const [row] = await tx
          .insert(remittancesTable)
          .values(v as typeof remittancesTable.$inferInsert)
          .onConflictDoNothing()
          .returning();
        if (!row) throw new Error("duplicate_fingerprint");
        await audit(userId, "import_remittance", "remittance", row.id, `Bulk import — $${row.amount} on ${row.remittanceDate}`, txDb);
        return row.id;
      }
    }
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

function resolveEntity(raw: string | string[] | undefined): ImportEntity | null {
  const entity = Array.isArray(raw) ? raw[0] : raw;
  return entity && isImportEntity(entity) ? entity : null;
}

router.get("/import/:entity/template", requireStaff, async (req, res): Promise<void> => {
  const entity = resolveEntity(req.params.entity);
  if (!entity) {
    res.status(404).json({ error: "Unknown import entity" });
    return;
  }
  const def = getEntityDef(entity);
  const csv = generateTemplate(def);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${entity}-import-template.csv"`);
  res.send(csv);
});

router.post("/import/:entity/validate", requireStaff, async (req, res): Promise<void> => {
  const entity = resolveEntity(req.params.entity);
  if (!entity) {
    res.status(404).json({ error: "Unknown import entity" });
    return;
  }
  const parsed = ValidateImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const def = getEntityDef(entity);
  const grid = parseCsv(parsed.data.csvText);
  if (grid.length < 2) {
    res.json(
      ValidateImportResponse.parse({
        entity,
        headerError: "The CSV appears to be empty (no data rows found under the header).",
        totalRows: 0,
        validRows: 0,
        errorRows: 0,
        duplicateRows: 0,
        results: [],
      }),
    );
    return;
  }
  const ctx = await buildResolveContext(def, grid);
  const outcome = validateRows(def, grid, ctx);
  if (outcome.headerError) {
    res.json(
      ValidateImportResponse.parse({ entity, headerError: outcome.headerError, totalRows: 0, validRows: 0, errorRows: 0, duplicateRows: 0, results: [] }),
    );
    return;
  }
  const dup = await buildDupIndex(entity);
  let validRows = 0;
  let errorRows = 0;
  let duplicateRows = 0;
  const results = outcome.rows.map((r) => {
    if (r.errors.length || !r.values) {
      errorRows++;
      return { rowNumber: r.rowNumber, status: "error" as const, errors: r.errors, warnings: r.warnings };
    }
    const dupMsg = dup.isDuplicate(r.values, r.raw);
    if (dupMsg) {
      duplicateRows++;
      dup.record(r.values, r.raw); // catch intra-file duplicates too
      return { rowNumber: r.rowNumber, status: "duplicate" as const, errors: [], warnings: r.warnings, message: dupMsg };
    }
    dup.record(r.values, r.raw);
    validRows++;
    return { rowNumber: r.rowNumber, status: "valid" as const, errors: [], warnings: r.warnings };
  });
  res.json(
    ValidateImportResponse.parse({
      entity,
      headerError: null,
      totalRows: outcome.rows.length,
      validRows,
      errorRows,
      duplicateRows,
      results,
    }),
  );
});

router.post("/import/:entity/commit", requireStaff, async (req, res): Promise<void> => {
  const entity = resolveEntity(req.params.entity);
  if (!entity) {
    res.status(404).json({ error: "Unknown import entity" });
    return;
  }
  const parsed = CommitImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const def = getEntityDef(entity);
  const grid = parseCsv(parsed.data.csvText);
  if (grid.length < 2) {
    res.status(400).json({ error: "The CSV appears to be empty (no data rows found under the header)." });
    return;
  }
  const ctx = await buildResolveContext(def, grid);
  // Commit RE-VALIDATES — never trust the client's earlier dry-run.
  const outcome = validateRows(def, grid, ctx);
  if (outcome.headerError) {
    res.status(400).json({ error: outcome.headerError });
    return;
  }
  const dup = await buildDupIndex(entity);
  const userId = req.user!.id;

  let imported = 0;
  let skippedDuplicate = 0;
  let errored = 0;
  const results: {
    rowNumber: number;
    status: "imported" | "skipped_duplicate" | "error";
    id?: string | null;
    message?: string | null;
    errors?: string[];
  }[] = [];

  for (const r of outcome.rows) {
    if (r.errors.length || !r.values) {
      errored++;
      results.push({ rowNumber: r.rowNumber, status: "error", errors: r.errors, message: "Row failed validation — not imported." });
      continue;
    }
    const dupMsg = dup.isDuplicate(r.values, r.raw);
    if (dupMsg) {
      skippedDuplicate++;
      results.push({ rowNumber: r.rowNumber, status: "skipped_duplicate", message: dupMsg });
      continue;
    }
    try {
      const id = await insertRow(entity, r.values, r.raw, userId);
      dup.record(r.values, r.raw);
      imported++;
      results.push({ rowNumber: r.rowNumber, status: "imported", id });
    } catch (err) {
      // A unique-constraint conflict (race / fingerprint) surfaces as a skipped
      // duplicate rather than a hard error, matching the Alta import behaviour.
      // Postgres reports unique violations with SQLSTATE 23505; the sentinel
      // "duplicate_fingerprint" covers the remittance ON CONFLICT path.
      if (isDuplicateInsertError(err)) {
        skippedDuplicate++;
        dup.record(r.values, r.raw);
        results.push({ rowNumber: r.rowNumber, status: "skipped_duplicate", message: "Already exists (detected at insert time). Skipped." });
      } else {
        errored++;
        results.push({ rowNumber: r.rowNumber, status: "error", message: err instanceof Error ? err.message : "Insert failed." });
      }
    }
  }

  await audit(userId, `import_${entity}_commit`, def.auditType, undefined, `Bulk import: ${imported} imported, ${skippedDuplicate} skipped (duplicate), ${errored} errored`);
  res.json(
    CommitImportResponse.parse({ entity, imported, skippedDuplicate, errored, results }),
  );
});

export default router;
