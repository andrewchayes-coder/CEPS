import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "migrations");

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/**
 * Databases provisioned via `drizzle-kit push` (e.g. the dev DB) carry the full
 * schema but never populate drizzle's migration journal
 * (drizzle.__drizzle_migrations). Running `migrate()` against such a database
 * would replay 0000_baseline's CREATE TABLE statements and fail on the tables
 * that already exist.
 *
 * To make the runner safe for those push-built databases we stamp a baseline:
 * if the journal table is absent/empty AND a sentinel core table (users) already
 * exists, we insert the journal row for the 0000 migration ourselves — using the
 * exact hash scheme drizzle uses (sha256 of the migration SQL text) and the
 * journal's `when` value as created_at — so drizzle then skips 0000 and applies
 * only the newer migrations. An empty database has no sentinel table, so nothing
 * is stamped and plain migrate() creates everything from scratch.
 */
async function stampBaselineIfNeeded(
  db: ReturnType<typeof drizzle>,
): Promise<void> {
  // drizzle keeps its journal in the `drizzle` schema.
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const existing = await db.execute(
    sql`SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations"`,
  );
  const migrationCount = Number((existing.rows[0] as { count: number }).count);
  if (migrationCount > 0) {
    // Journal already populated — this DB is managed by the migration runner.
    return;
  }

  // No journal rows. Only stamp a baseline if the schema was already built by
  // push — detect that via a sentinel core table (users).
  const sentinel = await db.execute(sql`SELECT to_regclass('public.users') AS reg`);
  const sentinelExists = (sentinel.rows[0] as { reg: string | null }).reg !== null;
  if (!sentinelExists) {
    // Empty database — let plain migrate() run everything from 0000 onward.
    return;
  }

  // Load the journal so we stamp the exact baseline entry (0000) using drizzle's
  // hashing scheme: sha256 of the raw migration SQL text, created_at = `when`.
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };
  const baseline = journal.entries.find((e) => e.idx === 0);
  if (!baseline) {
    throw new Error("Cannot bootstrap baseline: no idx=0 entry in _journal.json");
  }
  const baselineSql = fs.readFileSync(
    path.join(migrationsFolder, `${baseline.tag}.sql`),
    "utf8",
  );
  const hash = crypto.createHash("sha256").update(baselineSql).digest("hex");

  await db.execute(sql`
    INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
    VALUES (${hash}, ${baseline.when})
  `);
  console.log(
    `Bootstrap: existing push-built database detected (sentinel table 'users' present, empty journal). ` +
      `Stamped baseline migration '${baseline.tag}' (hash ${hash.slice(0, 12)}…, created_at ${baseline.when}). ` +
      `Only migrations after the baseline will be applied.`,
  );
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  try {
    await stampBaselineIfNeeded(db);
    console.log(`Running migrations from ${migrationsFolder} ...`);
    await migrate(db, { migrationsFolder });
    console.log("Migrations applied successfully.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
