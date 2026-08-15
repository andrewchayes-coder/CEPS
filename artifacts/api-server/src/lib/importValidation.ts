// ─────────────────────────────────────────────────────────────────────────────
// BULK IMPORT — shared row validation
//
// The SINGLE validation pass used by BOTH the dry-run (POST /validate) and the
// committer (POST /commit). Commit re-runs this exact function and refuses any
// row that now fails (skip-and-report), so the two endpoints can never diverge.
//
// This module is DB-agnostic: it takes the parsed CSV grid plus a ResolveContext
// (lookup maps the route builds once from the DB) and returns, per row, the
// validated insert-values object OR a list of errors/warnings.
// ─────────────────────────────────────────────────────────────────────────────

import {
  type EntityDef,
  type FieldDef,
  type ResolveContext,
  type RawRow,
  parseCell,
  normalizeHeader,
  EXAMPLE_ROW_MARKER,
} from "./importRegistry";

export interface ValidatedRow {
  /** 1-based source row number (accounting for the header row). */
  rowNumber: number;
  /** Validated + FK-resolved insert values, or null when the row has errors. */
  values: Record<string, unknown> | null;
  /**
   * Raw (pre-FK-resolution) trimmed cell text keyed by field key. Used to build
   * natural-key fingerprints from the SAME canonical source strings the Alta
   * flow hashes (e.g. raw UCI / auth number), so identical logical rows dedupe
   * across the generic bulk-import and Alta-import paths.
   */
  raw: RawRow;
  errors: string[];
  warnings: string[];
}

export interface ValidationOutcome {
  /** Set when required columns are missing from the header — no rows processed. */
  headerError: string | null;
  rows: ValidatedRow[];
}

/**
 * Map the CSV header row to field indices. A required field whose column is
 * absent produces a header error (nothing is validated). Optional missing
 * columns are simply skipped.
 */
function mapColumns(def: EntityDef, headers: string[]): { colOf: Map<string, number>; headerError: string | null } {
  const norm = headers.map(normalizeHeader);
  const colOf = new Map<string, number>();
  const missingRequired: string[] = [];
  for (const field of def.fields) {
    const idx = norm.indexOf(normalizeHeader(field.header));
    if (idx !== -1) colOf.set(field.key, idx);
    else if (field.required) missingRequired.push(field.header);
  }
  if (missingRequired.length) {
    return {
      colOf,
      headerError: `Missing required column(s): ${missingRequired.join(", ")}. Download the template for the exact headers. Found: ${headers.map((h) => h.trim()).join(", ")}`,
    };
  }
  return { colOf, headerError: null };
}

/**
 * Validate every data row of a parsed CSV grid against an entity's field
 * registry. Scalar cells are parsed/validated first, then FK fields are
 * resolved (in field order, so a later FK — e.g. auth scoped to client — can
 * read an earlier field's resolved id from the row values). Any field error
 * makes the row invalid (values = null); warnings are non-fatal.
 */
export function validateRows(def: EntityDef, grid: string[][], ctx: ResolveContext): ValidationOutcome {
  if (grid.length < 1) {
    return { headerError: "The CSV appears to be empty (no header row).", rows: [] };
  }
  const { colOf, headerError } = mapColumns(def, grid[0]);
  if (headerError) return { headerError, rows: [] };

  const rows: ValidatedRow[] = [];
  grid.slice(1).forEach((r, i) => {
    const rowNumber = i + 2; // 1-based, header is row 1

    // Guard: the template ships with one hardcoded example row (its first cell
    // carries EXAMPLE_ROW_MARKER). If it's uploaded unedited — with or without
    // the marker — refuse it explicitly instead of importing fake data.
    const cellFor = (field: (typeof def.fields)[number]): string => {
      const idx = colOf.get(field.key);
      let raw = (idx === undefined ? "" : (r[idx] ?? "")).trim();
      if (raw.startsWith(EXAMPLE_ROW_MARKER)) raw = raw.slice(EXAMPLE_ROW_MARKER.length).trim();
      return raw;
    };
    const hasMarker = def.fields.some((field) => {
      const idx = colOf.get(field.key);
      return (idx === undefined ? "" : (r[idx] ?? "")).trim().startsWith(EXAMPLE_ROW_MARKER);
    });
    const isExampleRow =
      hasMarker ||
      (def.fields.every((field) => {
        const raw = cellFor(field);
        return raw === "" || raw === field.example.trim();
      }) &&
        def.fields.some((field) => {
          const raw = cellFor(field);
          return raw !== "" && raw === field.example.trim();
        }));
    if (isExampleRow) {
      rows.push({
        rowNumber,
        values: null,
        raw: {},
        errors: ["This is the template's example row — delete it from your file before importing."],
        warnings: [],
      });
      return;
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};
    // Raw cells keyed by field key — FK resolvers read already-resolved ids
    // (e.g. clientId) from `values`, and raw text from here when needed.
    const rawByKey: RawRow = {};

    // Pass 1: scalar parse/validate for every field (including FK fields, whose
    // scalar step is just presence). FK fields skip scalar type checks below.
    for (const field of def.fields) {
      const idx = colOf.get(field.key);
      const raw = idx === undefined ? "" : (r[idx] ?? "");
      rawByKey[field.key] = raw.trim();
      if (field.resolve) continue; // resolved in pass 2
      const parsed = parseCell(field, raw);
      if (parsed.error) {
        errors.push(`${field.header}: ${parsed.error}`);
      } else {
        if (parsed.value !== undefined) values[field.key] = parsed.value;
        if (parsed.warning) warnings.push(`${field.header}: ${parsed.warning}`);
      }
    }

    // Snapshot the raw source text BEFORE pass 2 mirrors resolved ids into
    // rawByKey — the fingerprint must hash raw natural-key strings, not UUIDs.
    const rawSnapshot: RawRow = { ...rawByKey };

    // Pass 2: FK resolution (order matters — auth depends on client). We write
    // resolved ids into `values` (and mirror into rawByKey so a dependent
    // resolver like auth-scoped-to-client can read the resolved client id).
    for (const field of def.fields) {
      if (!field.resolve) continue;
      const raw = rawByKey[field.key] ?? "";
      // Give the resolver access to already-resolved ids via a merged row.
      const resolveRow: RawRow = { ...rawByKey };
      for (const [k, v] of Object.entries(values)) {
        if (typeof v === "string") resolveRow[k] = v;
      }
      const res = field.resolve(raw, ctx, resolveRow);
      const insertKey = field.insertKey ?? field.key;
      if (res.error) {
        errors.push(`${field.header}: ${res.error === "required" ? "required" : res.error}`);
      } else {
        if (res.value !== undefined) {
          values[insertKey] = res.value;
          if (typeof res.value === "string") rawByKey[insertKey] = res.value;
        }
        if (res.warning) warnings.push(`${field.header}: ${res.warning}`);
      }
    }

    rows.push({ rowNumber, values: errors.length ? null : values, raw: rawSnapshot, errors, warnings });
  });

  return { headerError: null, rows };
}

/** Collect the distinct raw values a given field carries across all data rows. */
export function collectFieldValues(def: EntityDef, grid: string[][], fieldKey: string): string[] {
  if (grid.length < 2) return [];
  const norm = grid[0].map(normalizeHeader);
  const field = def.fields.find((f) => f.key === fieldKey);
  if (!field) return [];
  const idx = norm.indexOf(normalizeHeader(field.header));
  if (idx === -1) return [];
  const out = new Set<string>();
  for (const r of grid.slice(1)) {
    const v = (r[idx] ?? "").trim();
    if (v) out.add(v);
  }
  return [...out];
}
