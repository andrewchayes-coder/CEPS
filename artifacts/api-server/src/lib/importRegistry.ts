// ─────────────────────────────────────────────────────────────────────────────
// BULK IMPORT — shared field registry
//
// ONE declarative description of every importable entity's CSV fields drives the
// entire import system: the generated template (GET /import/:entity/template),
// the dry-run validator (POST /import/:entity/validate), and the transactional
// committer (POST /import/:entity/commit). Adding/renaming a field is a one-line
// change here — no route logic to touch.
//
// A field describes its CSV header, whether it is required, how to parse/validate
// its raw string cell, and (for foreign keys) how it resolves a human-readable
// value to a database id. FK resolution is done against maps built ONCE per
// import from the values present in the upload, so per-row resolution is
// in-memory. Ambiguity (e.g. duplicate vendor names) is a hard row error — we
// never guess.
// ─────────────────────────────────────────────────────────────────────────────

import { validatePositiveMoney } from "./money";

/** The five entities the bulk-import system covers. */
export const IMPORT_ENTITIES = [
  "clients",
  "vendors",
  "authorizations",
  "payments",
  "remittances",
] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export function isImportEntity(v: string): v is ImportEntity {
  return (IMPORT_ENTITIES as readonly string[]).includes(v);
}

/**
 * Context handed to FK resolvers: pre-built lookup maps keyed by the normalized
 * human-readable value. Resolvers never hit the database themselves — the route
 * loads the needed reference data once per import and populates these maps.
 */
export interface ResolveContext {
  /** lower-cased coordinator/user email → user id */
  usersByEmail: Map<string, string>;
  /** UCI number (trimmed, as stored) → client id */
  clientsByUci: Map<string, string>;
  /** lower-cased vendor name → { id } | "ambiguous" when >1 vendor shares the name */
  vendorsByName: Map<string, { id: string } | "ambiguous">;
  /** `${clientId}::${authNumber}` → { id } | "ambiguous" when >1 auth shares the (client, number) key */
  authsByClientAndNumber: Map<string, { id: string } | "ambiguous">;
}

export type FieldType = "string" | "money" | "date" | "month" | "integer" | "boolean" | "enum";

export interface ParseResult {
  /** Parsed/normalized value ready for insert. `undefined` means "omit column". */
  value?: unknown;
  error?: string;
  warning?: string;
}

export interface FieldDef {
  /** DB column / insert-values key this field maps to (unless purely virtual/FK). */
  key: string;
  /** CSV header (without the " *" required marker). */
  header: string;
  required: boolean;
  type: FieldType;
  /** Allowed values for enum fields. */
  enumValues?: readonly string[];
  /** Example cell value for the template's instruction row. */
  example: string;
  /** Human help text for the instruction row / template. */
  help?: string;
  /**
   * When set, this field is a foreign key resolved from a human-readable value.
   * Returns the resolved id, or an error string, or a warning (with value) for a
   * soft/optional miss. The resolved id is written to `insertKey` if given,
   * otherwise `key`.
   */
  resolve?: (raw: string, ctx: ResolveContext, row: RawRow) => ParseResult;
  /** Insert-values key for a resolved FK when it differs from `key`. */
  insertKey?: string;
}

/** A raw CSV row keyed by header (already trimmed). */
export type RawRow = Record<string, string>;

export interface EntityDef {
  entity: ImportEntity;
  /** DB entity type used in audit-log entries. */
  auditType: string;
  fields: FieldDef[];
  /**
   * Human description of the natural key used for duplicate detection, shown in
   * the template instructions. Duplicate detection itself lives in the route
   * (it needs the DB) but keying is described here for documentation.
   */
  naturalKey: string;
}

// ── Shared cell parsers ──────────────────────────────────────────────────────

function parseString(raw: string, required: boolean): ParseResult {
  const t = raw.trim();
  if (!t) return required ? { error: "required" } : { value: null };
  return { value: t };
}

function parseMoney(raw: string, required: boolean): ParseResult {
  const t = raw.trim();
  if (!t) return required ? { error: "required" } : { value: null };
  const v = validatePositiveMoney(t.replace(/[$,]/g, ""));
  if (v == null) return { error: `"${raw}" is not a valid positive money amount (max 2 decimals)` };
  return { value: v };
}

/** Normalize a date-ish string to ISO YYYY-MM-DD, or null if unparseable. */
export function toIsoDate(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseDate(raw: string, required: boolean): ParseResult {
  const t = raw.trim();
  if (!t) return required ? { error: "required" } : { value: null };
  const iso = toIsoDate(t);
  if (!iso) return { error: `"${raw}" is not a valid date (use YYYY-MM-DD)` };
  return { value: iso };
}

function parseMonth(raw: string, required: boolean): ParseResult {
  const t = raw.trim();
  if (!t) return required ? { error: "required" } : { value: null };
  if (/^\d{4}-\d{2}$/.test(t)) return { value: t };
  const iso = toIsoDate(t);
  if (!iso) return { error: `"${raw}" is not a valid month (use YYYY-MM)` };
  return { value: iso.slice(0, 7) };
}

function parseInteger(raw: string, required: boolean): ParseResult {
  const t = raw.trim();
  if (!t) return required ? { error: "required" } : { value: null };
  if (!/^\d+$/.test(t)) return { error: `"${raw}" is not a whole number` };
  return { value: parseInt(t, 10) };
}

function parseBoolean(raw: string, required: boolean): ParseResult {
  const t = raw.trim().toLowerCase();
  if (!t) return required ? { error: "required" } : { value: undefined };
  if (["true", "yes", "y", "1"].includes(t)) return { value: true };
  if (["false", "no", "n", "0"].includes(t)) return { value: false };
  return { error: `"${raw}" is not a yes/no value` };
}

function parseEnum(raw: string, required: boolean, allowed: readonly string[]): ParseResult {
  const t = raw.trim();
  if (!t) return required ? { error: "required" } : { value: undefined };
  if (!allowed.includes(t)) return { error: `"${raw}" must be one of: ${allowed.join(", ")}` };
  return { value: t };
}

/**
 * Parse+validate a single field cell by its type. FK resolution is handled
 * separately by the route (it needs the ResolveContext); this covers the scalar
 * types only.
 */
export function parseCell(field: FieldDef, raw: string): ParseResult {
  switch (field.type) {
    case "money":
      return parseMoney(raw, field.required);
    case "date":
      return parseDate(raw, field.required);
    case "month":
      return parseMonth(raw, field.required);
    case "integer":
      return parseInteger(raw, field.required);
    case "boolean":
      return parseBoolean(raw, field.required);
    case "enum":
      return parseEnum(raw, field.required, field.enumValues ?? []);
    case "string":
    default:
      return parseString(raw, field.required);
  }
}

// ── FK resolvers ─────────────────────────────────────────────────────────────

const resolveCoordinatorEmail: FieldDef["resolve"] = (raw, ctx) => {
  const t = raw.trim();
  if (!t) return { value: null }; // optional everywhere it's used
  const id = ctx.usersByEmail.get(t.toLowerCase());
  if (!id) return { error: `No user found with email "${raw}"` };
  return { value: id };
};

const resolveClientUci: FieldDef["resolve"] = (raw, ctx) => {
  const t = raw.trim();
  if (!t) return { error: "required" };
  const id = ctx.clientsByUci.get(t);
  if (!id) return { error: `No client found with UCI "${raw}"` };
  return { value: id };
};

const resolveVendorName: FieldDef["resolve"] = (raw, ctx) => {
  const t = raw.trim();
  if (!t) return { value: null }; // vendor is optional on authorizations/payments
  const hit = ctx.vendorsByName.get(t.toLowerCase());
  if (!hit) return { error: `No vendor found with name "${raw}"` };
  if (hit === "ambiguous") return { error: `Multiple vendors share the name "${raw}" — resolve by editing the CSV or de-duplicating vendors` };
  return { value: hit.id };
};

/** Auth number scoped to the row's already-resolved client id (`clientId`). */
function resolveAuthScoped(clientKey: string): FieldDef["resolve"] {
  return (raw, ctx, row) => {
    const t = raw.trim();
    if (!t) return { value: null };
    const clientId = row[clientKey];
    if (!clientId) return { error: "cannot resolve authorization without a resolved client" };
    const hit = ctx.authsByClientAndNumber.get(`${clientId}::${t}`);
    if (!hit) return { error: `Authorization "${raw}" not found for this client` };
    if (hit === "ambiguous") return { error: `Multiple authorizations share the number "${raw}" for this client — resolve by editing the CSV or de-duplicating authorizations` };
    return { value: hit.id };
  };
}

// ── Entity registry ──────────────────────────────────────────────────────────

export const IMPORT_REGISTRY: Record<ImportEntity, EntityDef> = {
  clients: {
    entity: "clients",
    auditType: "client",
    naturalKey: "UCI number (clients.uciNumber)",
    fields: [
      { key: "firstName", header: "First Name", required: true, type: "string", example: "Jordan" },
      { key: "lastName", header: "Last Name", required: true, type: "string", example: "Rivera" },
      { key: "dateOfBirth", header: "Date of Birth", required: true, type: "date", example: "2015-03-22", help: "YYYY-MM-DD" },
      { key: "uciNumber", header: "UCI Number", required: true, type: "string", example: "UCI-0001", help: "Natural key — duplicates are skipped" },
      { key: "status", header: "Status", required: false, type: "enum", enumValues: ["active", "inactive", "closed"], example: "active" },
      { key: "regionalCenter", header: "Regional Center", required: false, type: "string", example: "Alta California" },
      { key: "preferredLanguage", header: "Preferred Language", required: false, type: "string", example: "English" },
      { key: "address", header: "Address", required: false, type: "string", example: "100 Main St, Sacramento CA" },
      { key: "phone", header: "Phone", required: false, type: "string", example: "916-555-0100" },
      { key: "email", header: "Email", required: false, type: "string", example: "family@example.com" },
      { key: "isMinor", header: "Is Minor", required: false, type: "boolean", example: "yes" },
      { key: "familyRepName", header: "Family Rep Name", required: false, type: "string", example: "Maria Rivera" },
      { key: "familyRepPhone", header: "Family Rep Phone", required: false, type: "string", example: "916-555-0101" },
      { key: "familyRepEmail", header: "Family Rep Email", required: false, type: "string", example: "maria@example.com" },
      { key: "familyRepAddress", header: "Family Rep Address", required: false, type: "string", example: "100 Main St" },
      {
        key: "assignedCoordinatorId",
        header: "Coordinator Email",
        required: false,
        type: "string",
        example: "coordinator@ceps.org",
        help: "Resolved to a user by email",
        resolve: resolveCoordinatorEmail,
      },
    ],
  },

  vendors: {
    entity: "vendors",
    auditType: "vendor",
    naturalKey: "Vendor name (vendors.name)",
    fields: [
      { key: "name", header: "Name", required: true, type: "string", example: "Bright Futures Therapy", help: "Natural key — duplicates are skipped" },
      { key: "altaVendorNumber", header: "Alta Vendor Number", required: false, type: "string", example: "V-12345" },
      { key: "ein", header: "EIN", required: false, type: "string", example: "12-3456789" },
      { key: "billingAddress", header: "Billing Address", required: false, type: "string", example: "200 Oak Ave" },
      { key: "serviceAddress", header: "Service Address", required: false, type: "string", example: "200 Oak Ave" },
      { key: "phone", header: "Phone", required: false, type: "string", example: "916-555-0200" },
      { key: "email", header: "Email", required: false, type: "string", example: "billing@vendor.com" },
      { key: "contactPerson", header: "Contact Person", required: false, type: "string", example: "Pat Lee" },
      { key: "w9Status", header: "W9 Status", required: false, type: "enum", enumValues: ["pending", "on_file", "expired"], example: "on_file" },
      { key: "preferred", header: "Preferred", required: false, type: "boolean", example: "no" },
    ],
  },

  authorizations: {
    entity: "authorizations",
    auditType: "authorization",
    naturalKey: "Auth number scoped per client (authorizations.authNumber + clientId)",
    fields: [
      {
        key: "clientId",
        header: "Client UCI",
        required: true,
        type: "string",
        example: "UCI-0001",
        help: "Resolved to a client by UCI",
        resolve: resolveClientUci,
      },
      {
        key: "vendorId",
        header: "Vendor Name",
        required: false,
        type: "string",
        example: "Bright Futures Therapy",
        help: "Resolved to a vendor by name (ambiguous names error)",
        resolve: resolveVendorName,
      },
      { key: "authNumber", header: "Auth Number", required: true, type: "string", example: "POS-2026-001", help: "Natural key (scoped to the client)" },
      { key: "serviceCode", header: "Service Code", required: true, type: "enum", enumValues: ["459", "024", "490"], example: "459" },
      { key: "paymentType", header: "Payment Type", required: false, type: "enum", enumValues: ["direct_payment", "reimbursement", "fee"], example: "direct_payment", help: "Derived from service code when blank" },
      { key: "activityDescription", header: "Activity Description", required: false, type: "string", example: "Respite services" },
      { key: "servicePeriodStart", header: "Service Period Start", required: true, type: "date", example: "2026-01-01" },
      { key: "servicePeriodEnd", header: "Service Period End", required: true, type: "date", example: "2026-12-31" },
      { key: "monthlyAmount", header: "Monthly Amount", required: false, type: "money", example: "500.00" },
      { key: "oneTimeAmount", header: "One Time Amount", required: false, type: "money", example: "" },
      { key: "maxPeriodAmount", header: "Max Period Amount", required: true, type: "money", example: "6000.00" },
      { key: "units", header: "Units", required: false, type: "integer", example: "12" },
      { key: "status", header: "Status", required: false, type: "enum", enumValues: ["active", "expired", "pending", "exhausted"], example: "active" },
      { key: "receivedDate", header: "Received Date", required: false, type: "date", example: "2025-12-15" },
    ],
  },

  payments: {
    entity: "payments",
    auditType: "payment",
    naturalKey: "QuickBooks check number (payments.qbCheckNumber)",
    fields: [
      {
        key: "clientId",
        header: "Client UCI",
        required: true,
        type: "string",
        example: "UCI-0001",
        help: "Resolved to a client by UCI",
        resolve: resolveClientUci,
      },
      {
        key: "vendorId",
        header: "Vendor Name",
        required: false,
        type: "string",
        example: "Bright Futures Therapy",
        help: "Resolved to a vendor by name (ambiguous names error)",
        resolve: resolveVendorName,
      },
      {
        key: "authorizationId",
        header: "Auth Number",
        required: false,
        type: "string",
        example: "POS-2026-001",
        help: "Resolved to an authorization for the row's client",
        resolve: resolveAuthScoped("clientId"),
      },
      { key: "qbCheckNumber", header: "QB Check Number", required: true, type: "string", example: "10234", help: "Natural key — duplicates are skipped" },
      { key: "checkDate", header: "Check Date", required: true, type: "date", example: "2026-02-15" },
      { key: "amount", header: "Amount", required: true, type: "money", example: "500.00" },
      { key: "paymentMonth", header: "Payment Month", required: false, type: "month", example: "2026-02", help: "Derived from check date when blank" },
      { key: "paymentType", header: "Payment Type", required: false, type: "enum", enumValues: ["direct_payment", "reimbursement", "fee"], example: "direct_payment" },
    ],
  },

  remittances: {
    entity: "remittances",
    auditType: "remittance",
    naturalKey: "Source-row fingerprint (uci|auth|month|amount|check|date)",
    fields: [
      {
        key: "clientId",
        header: "Client UCI",
        required: true,
        type: "string",
        example: "UCI-0001",
        help: "Resolved to a client by UCI",
        resolve: resolveClientUci,
      },
      {
        key: "authorizationId",
        header: "Auth Number",
        required: false,
        type: "string",
        example: "POS-2026-001",
        help: "Resolved to an authorization for the row's client",
        resolve: resolveAuthScoped("clientId"),
      },
      { key: "remittanceDate", header: "Remittance Date", required: true, type: "date", example: "2026-03-01" },
      { key: "amount", header: "Amount", required: true, type: "money", example: "500.00" },
      { key: "paymentMonth", header: "Service Month", required: false, type: "month", example: "2026-02" },
      { key: "altaReference", header: "Alta Reference", required: false, type: "string", example: "ALTA-9911", help: "Check / payment reference" },
    ],
  },
};

export function getEntityDef(entity: ImportEntity): EntityDef {
  return IMPORT_REGISTRY[entity];
}

// ── CSV helpers (template generation + parsing) ──────────────────────────────

/**
 * Escape a value for CSV, including formula-injection protection (a leading
 * =,+,-,@ is prefixed with a single quote) — mirrors the portal's shared csv
 * util so a downloaded template can't smuggle a spreadsheet formula.
 */
export function csvEscape(value: string): string {
  let v = value;
  // Formula-injection guard: neutralize cells a spreadsheet would evaluate as a
  // formula (start with = + - @, tab, or CR) — matches the portal's csv util.
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\n\r]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** Build the header row string: required fields get a trailing " *". */
export function templateHeaderRow(def: EntityDef): string {
  return def.fields.map((f) => csvEscape(f.required ? `${f.header} *` : f.header)).join(",");
}

/** Build the example/instruction row string from each field's example. */
export function templateExampleRow(def: EntityDef): string {
  return def.fields.map((f) => csvEscape(f.example)).join(",");
}

/**
 * Generate the full CSV template for an entity AT REQUEST TIME (never a static
 * file): a header row (required fields marked " *") plus an example row and a
 * trailing instructions comment line documenting the natural key.
 */
export function generateTemplate(def: EntityDef): string {
  const lines = [templateHeaderRow(def), templateExampleRow(def)];
  return `${lines.join("\r\n")}\r\n`;
}

/** Minimal RFC-4180-style CSV parser with quoted-field support. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** Normalize a header for matching (lowercase, alphanumerics only, drop " *"). */
export function normalizeHeader(h: string): string {
  return h.replace(/\*/g, "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}
