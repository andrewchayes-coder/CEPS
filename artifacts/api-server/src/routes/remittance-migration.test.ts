import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const migrationPath = fileURLToPath(
  new URL("../../../../lib/db/migrations/0007_omniscient_ken_ellis.sql", import.meta.url),
);
const migrationStatements = readFileSync(migrationPath, "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

const balanceMigrationPath = fileURLToPath(
  new URL("../../../../lib/db/migrations/0010_cold_nemesis.sql", import.meta.url),
);
const balanceMigrationStatements = readFileSync(balanceMigrationPath, "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

const targetSchemaMigrationPath = fileURLToPath(
  new URL("../../../../lib/db/migrations/0035_remittance_line_and_fee_targets.sql", import.meta.url),
);
const targetSchemaMigrationStatements = readFileSync(targetSchemaMigrationPath, "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

const targetGuardMigrationPath = fileURLToPath(
  new URL("../../../../lib/db/migrations/0036_remittance_target_guards.sql", import.meta.url),
);
const targetGuardMigrationStatements = readFileSync(targetGuardMigrationPath, "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

const optionABackfillPath = fileURLToPath(
  new URL("../../../../scripts/remittance-backfill-option-a-production.sql", import.meta.url),
);
const optionABackfillStatements = readFileSync(optionABackfillPath, "utf8")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

const optionACheckPath = fileURLToPath(
  new URL("../../../../scripts/remittance-backfill-check.sql", import.meta.url),
);
const optionACheckStatements = readFileSync(optionACheckPath, "utf8")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

const schemasToDrop: string[] = [];

afterAll(async () => {
  for (const schema of schemasToDrop) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
});

describe("migration 0007 remittance allocation backfill", () => {
  it("preserves production-shaped legacy matches without duplicates, drift, or over-allocation", async () => {
    const schema = `migration_0007_${randomUUID().replaceAll("-", "")}`;
    schemasToDrop.push(schema);
    const client = await pool.connect();

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE payments (
          id uuid PRIMARY KEY,
          amount numeric(12, 2) NOT NULL
        );
        CREATE TABLE remittances (
          id uuid PRIMARY KEY,
          matched_payment_id uuid REFERENCES payments(id),
          amount numeric(12, 2) NOT NULL,
          auto_matched boolean NOT NULL DEFAULT false,
          is_deleted boolean NOT NULL DEFAULT false
        )
      `);

      const ids = {
        matchedPayment: randomUUID(),
        alreadyAllocatedPayment: randomUUID(),
        unmatchedPayment: randomUUID(),
        deletedPayment: randomUUID(),
        matchedRemittance: randomUUID(),
        alreadyAllocatedRemittance: randomUUID(),
        unmatchedRemittance: randomUUID(),
        deletedRemittance: randomUUID(),
      };
      await client.query(
        `INSERT INTO payments (id, amount) VALUES ($1, 125.37), ($2, 80.05), ($3, 10.00), ($4, 22.22)`,
        [ids.matchedPayment, ids.alreadyAllocatedPayment, ids.unmatchedPayment, ids.deletedPayment],
      );
      await client.query(
        `INSERT INTO remittances (id, matched_payment_id, amount, auto_matched, is_deleted)
         VALUES ($1, $2, 125.37, true, false),
                ($3, $4, 80.05, false, false),
                ($5, NULL, 10.00, false, false),
                ($6, $7, 22.22, true, true)`,
        [
          ids.matchedRemittance,
          ids.matchedPayment,
          ids.alreadyAllocatedRemittance,
          ids.alreadyAllocatedPayment,
          ids.unmatchedRemittance,
          ids.deletedRemittance,
          ids.deletedPayment,
        ],
      );

      const schemaMigration = migrationStatements.map((statement) =>
        statement.replaceAll('"public".', `"${schema}".`),
      );
      for (const statement of schemaMigration.slice(0, -1)) {
        await client.query(statement);
      }

      // Represents a pair already written by an earlier reconciliation attempt.
      await client.query(
        `INSERT INTO remittance_allocations (remittance_id, payment_id, amount, auto_matched)
         VALUES ($1, $2, 80.05, false)`,
        [ids.alreadyAllocatedRemittance, ids.alreadyAllocatedPayment],
      );

      const pre = await client.query(`
        SELECT
          count(*) FILTER (WHERE matched_payment_id IS NOT NULL AND is_deleted = false)::int AS eligible,
          coalesce(sum(amount) FILTER (WHERE matched_payment_id IS NOT NULL AND is_deleted = false), 0)::text AS eligible_amount
        FROM remittances
      `);
      expect(pre.rows[0]).toEqual({ eligible: 2, eligible_amount: "205.42" });

      const backfill = schemaMigration.at(-1);
      expect(backfill).toBeTruthy();
      await client.query(backfill!);
      await client.query(backfill!);

      const post = await client.query(`
        SELECT
          count(*)::int AS allocation_count,
          count(DISTINCT (remittance_id, payment_id))::int AS distinct_pair_count,
          sum(amount)::text AS allocation_amount
        FROM remittance_allocations
      `);
      expect(post.rows[0]).toEqual({
        allocation_count: 2,
        distinct_pair_count: 2,
        allocation_amount: "205.42",
      });

      const balances = await client.query(`
        SELECT
          bool_and(remittance_allocated <= remittance_amount) AS no_remittance_overallocation,
          bool_and(payment_allocated <= payment_amount) AS no_payment_overallocation,
          sum(remittance_amount - remittance_allocated)::text AS remittance_remaining,
          sum(payment_amount - payment_allocated)::text AS payment_remaining
        FROM (
          SELECT
            r.id,
            r.amount AS remittance_amount,
            coalesce(sum(ra.amount), 0) AS remittance_allocated,
            p.amount AS payment_amount,
            coalesce(sum(ra.amount), 0) AS payment_allocated
          FROM remittances r
          JOIN payments p ON p.id = r.matched_payment_id
          LEFT JOIN remittance_allocations ra ON ra.remittance_id = r.id AND ra.payment_id = p.id
          WHERE r.is_deleted = false
          GROUP BY r.id, r.amount, p.amount
        ) reconciled
      `);
      expect(balances.rows[0]).toEqual({
        no_remittance_overallocation: true,
        no_payment_overallocation: true,
        remittance_remaining: "0.00",
        payment_remaining: "0.00",
      });

      const excluded = await client.query(
        `SELECT count(*)::int AS count
         FROM remittance_allocations
         WHERE remittance_id IN ($1, $2)`,
        [ids.unmatchedRemittance, ids.deletedRemittance],
      );
      expect(excluded.rows[0].count).toBe(0);
    } finally {
      client.release();
    }
  });
});

describe("migration 0010 remittance allocation balance guards", () => {
  it("refuses to install over invalid existing allocation totals", async () => {
    const schema = `migration_0009_preflight_${randomUUID().replaceAll("-", "")}`;
    schemasToDrop.push(schema);
    const client = await pool.connect();
    const remittanceId = randomUUID();
    const paymentId = randomUUID();

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE payments (id uuid PRIMARY KEY, amount numeric(12, 2) NOT NULL);
        CREATE TABLE remittances (id uuid PRIMARY KEY, amount numeric(12, 2) NOT NULL);
        CREATE TABLE remittance_allocations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          remittance_id uuid NOT NULL REFERENCES remittances(id),
          payment_id uuid NOT NULL REFERENCES payments(id),
          amount numeric(12, 2) NOT NULL
        )
      `);
      await client.query(`INSERT INTO remittances (id, amount) VALUES ($1, 50.00)`, [remittanceId]);
      await client.query(`INSERT INTO payments (id, amount) VALUES ($1, 100.00)`, [paymentId]);
      await client.query(
        `INSERT INTO remittance_allocations (remittance_id, payment_id, amount)
         VALUES ($1, $2, 60.00)`,
        [remittanceId, paymentId],
      );

      const preflight = balanceMigrationStatements.find((statement) =>
        statement.startsWith("DO $$"),
      );
      expect(preflight).toBeTruthy();
      await expect(client.query(preflight!)).rejects.toMatchObject({
        message: expect.stringContaining(`over-allocated remittance ids: ${remittanceId}`),
      });
    } finally {
      client.release();
    }
  });

  it("rejects invalid direct writes while preserving partial many-to-many allocations", async () => {
    const schema = `migration_0009_${randomUUID().replaceAll("-", "")}`;
    schemasToDrop.push(schema);
    const client = await pool.connect();

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE payments (
          id uuid PRIMARY KEY,
          amount numeric(12, 2) NOT NULL
        );
        CREATE TABLE remittances (
          id uuid PRIMARY KEY,
          amount numeric(12, 2) NOT NULL
        );
        CREATE TABLE remittance_allocations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          remittance_id uuid NOT NULL REFERENCES remittances(id),
          payment_id uuid NOT NULL REFERENCES payments(id),
          amount numeric(12, 2) NOT NULL,
          auto_matched boolean NOT NULL DEFAULT false,
          created_at timestamp with time zone NOT NULL DEFAULT now(),
          UNIQUE (remittance_id, payment_id)
        )
      `);

      await client.query("BEGIN");
      for (const statement of balanceMigrationStatements) await client.query(statement);
      await client.query("COMMIT");

      const ids = {
        remittanceA: randomUUID(),
        remittanceB: randomUUID(),
        paymentA: randomUUID(),
        paymentB: randomUUID(),
      };
      await client.query(
        `INSERT INTO remittances (id, amount) VALUES ($1, 100.00), ($2, 100.00)`,
        [ids.remittanceA, ids.remittanceB],
      );
      await client.query(
        `INSERT INTO payments (id, amount) VALUES ($1, 120.00), ($2, 60.00)`,
        [ids.paymentA, ids.paymentB],
      );

      // One remittance may fund multiple payments, and one payment may be funded
      // by multiple remittances, with balances left partially allocated.
      await client.query(
        `INSERT INTO remittance_allocations (remittance_id, payment_id, amount)
         VALUES ($1, $2, 40.00), ($1, $3, 50.00), ($4, $2, 70.00)`,
        [ids.remittanceA, ids.paymentA, ids.paymentB, ids.remittanceB],
      );

      await expect(client.query(
        `INSERT INTO remittance_allocations (remittance_id, payment_id, amount)
         VALUES ($1, $2, 0)`,
        [ids.remittanceB, ids.paymentB],
      )).rejects.toMatchObject({ code: "23514" });

      await expect(client.query(
        `INSERT INTO remittance_allocations (remittance_id, payment_id, amount)
         VALUES ($1, $2, 'NaN')`,
        [ids.remittanceB, ids.paymentB],
      )).rejects.toMatchObject({ code: "23514" });

      await expect(client.query(
        `UPDATE remittance_allocations
         SET amount = 61.00
         WHERE remittance_id = $1 AND payment_id = $2`,
        [ids.remittanceA, ids.paymentB],
      )).rejects.toMatchObject({
        code: "23514",
        constraint: "remittance_allocations_remittance_balance",
      });

      await expect(client.query(
        `UPDATE remittance_allocations
         SET amount = 81.00
         WHERE remittance_id = $1 AND payment_id = $2`,
        [ids.remittanceB, ids.paymentA],
      )).rejects.toMatchObject({
        code: "23514",
        constraint: "remittance_allocations_payment_balance",
      });

      await expect(client.query(
        `UPDATE remittances SET amount = 89.99 WHERE id = $1`,
        [ids.remittanceA],
      )).rejects.toMatchObject({
        code: "23514",
        constraint: "remittances_amount_covers_allocations",
      });

      await expect(client.query(
        `UPDATE payments SET amount = 109.99 WHERE id = $1`,
        [ids.paymentA],
      )).rejects.toMatchObject({
        code: "23514",
        constraint: "payments_amount_covers_allocations",
      });

      await expect(client.query(
        `UPDATE remittances SET amount = 'NaN' WHERE id = $1`,
        [ids.remittanceA],
      )).rejects.toMatchObject({
        code: "23514",
        constraint: "remittances_positive_finite_amount",
      });

      await expect(client.query(
        `UPDATE payments SET amount = 'NaN' WHERE id = $1`,
        [ids.paymentA],
      )).rejects.toMatchObject({
        code: "23514",
        constraint: "payments_positive_finite_amount",
      });

      const totals = await client.query(`
        SELECT
          (SELECT sum(amount)::text FROM remittance_allocations WHERE remittance_id = $1) AS remittance_a,
          (SELECT sum(amount)::text FROM remittance_allocations WHERE remittance_id = $2) AS remittance_b,
          (SELECT sum(amount)::text FROM remittance_allocations WHERE payment_id = $3) AS payment_a,
          (SELECT sum(amount)::text FROM remittance_allocations WHERE payment_id = $4) AS payment_b
      `, [ids.remittanceA, ids.remittanceB, ids.paymentA, ids.paymentB]);
      expect(totals.rows[0]).toEqual({
        remittance_a: "90.00",
        remittance_b: "70.00",
        payment_a: "110.00",
        payment_b: "50.00",
      });
    } finally {
      client.release();
    }
  });
});

describe("migration 0035/0036 remittance line targets and Option A backfill", () => {
  it("backfills a unique eligible line, leaves ambiguous history unresolved, and reports it", async () => {
    const schema = `migration_remittance_targets_${randomUUID().replaceAll("-", "")}`;
    schemasToDrop.push(schema);
    const client = await pool.connect();

    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE authorizations (
          id uuid PRIMARY KEY,
          client_id uuid NOT NULL,
          payment_type text NOT NULL,
          is_deleted boolean NOT NULL DEFAULT false,
          status text NOT NULL,
          service_period_start date NOT NULL,
          service_period_end date NOT NULL
        );
        CREATE TABLE payments (
          id uuid PRIMARY KEY,
          client_id uuid NOT NULL,
          amount numeric(12, 2) NOT NULL,
          is_deleted boolean NOT NULL DEFAULT false,
          remitted boolean NOT NULL DEFAULT false
        );
        CREATE TABLE remittances (
          id uuid PRIMARY KEY,
          client_id uuid NOT NULL,
          authorization_id uuid,
          payment_month text,
          remittance_date date NOT NULL,
          amount numeric(12, 2) NOT NULL,
          is_deleted boolean NOT NULL DEFAULT false
        );
        CREATE TABLE payment_allocations (
          id uuid PRIMARY KEY,
          payment_id uuid NOT NULL REFERENCES payments(id),
          authorization_id uuid NOT NULL,
          service_month text,
          amount numeric(12, 2) NOT NULL
        );
        CREATE TABLE fees (
          id uuid PRIMARY KEY,
          client_id uuid NOT NULL,
          authorization_id uuid,
          amount numeric(12, 2) NOT NULL,
          fee_month text,
          is_deleted boolean NOT NULL DEFAULT false,
          status text NOT NULL DEFAULT 'pending'
        );
        CREATE TABLE audit_log (
          action text NOT NULL,
          entity_type text,
          entity_id text,
          detail text
        );
        CREATE TABLE remittance_allocations (
          id uuid PRIMARY KEY,
          remittance_id uuid NOT NULL REFERENCES remittances(id),
          payment_id uuid NOT NULL REFERENCES payments(id),
          amount numeric(12, 2) NOT NULL,
          auto_matched boolean NOT NULL DEFAULT false,
          created_at timestamp with time zone NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX remittance_allocations_pair_unique
          ON remittance_allocations (remittance_id, payment_id)
      `);

      const ids = {
        client: randomUUID(),
        singleAuthorization: randomUUID(),
        ambiguousAuthorizationA: randomUUID(),
        ambiguousAuthorizationB: randomUUID(),
        singlePayment: randomUUID(),
        ambiguousPayment: randomUUID(),
        capacityPayment: randomUUID(),
        singleLine: randomUUID(),
        ambiguousLineA: randomUUID(),
        ambiguousLineB: randomUUID(),
        capacityLine: randomUUID(),
        singleRemittance: randomUUID(),
        ambiguousRemittance: randomUUID(),
        firstCapacityRemittance: randomUUID(),
        secondCapacityRemittance: randomUUID(),
        singleLegacyAllocation: randomUUID(),
        ambiguousLegacyAllocation: randomUUID(),
        firstCapacityLegacyAllocation: randomUUID(),
        secondCapacityLegacyAllocation: randomUUID(),
      };

      await client.query(
        `INSERT INTO payments (id, client_id, amount)
         VALUES ($1, $4, 100.00), ($2, $4, 100.00), ($3, $4, 200.00)`,
        [ids.singlePayment, ids.ambiguousPayment, ids.capacityPayment, ids.client],
      );
      await client.query(
        `INSERT INTO remittances (
           id, client_id, authorization_id, payment_month, remittance_date, amount
         )
         VALUES ($1, $5, $6, '2026-05', '2026-05-31', 100.00),
                ($2, $5, NULL, NULL, '2026-07-01', 25.00),
                ($3, $5, $6, '2026-05', '2026-06-01', 70.00),
                ($4, $5, $6, '2026-05', '2026-06-02', 50.00)`,
        [
          ids.singleRemittance,
          ids.ambiguousRemittance,
          ids.firstCapacityRemittance,
          ids.secondCapacityRemittance,
          ids.client,
          ids.singleAuthorization,
        ],
      );
      await client.query(
        `INSERT INTO payment_allocations (id, payment_id, authorization_id, service_month, amount)
         VALUES ($1, $4, $5, '2026-05', 100.00),
                ($2, $6, $7, '2026-05', 50.00),
                ($3, $6, $8, '2026-06', 50.00),
                ($9, $10, $5, '2026-05', 100.00)`,
        [
          ids.singleLine,
          ids.ambiguousLineA,
          ids.ambiguousLineB,
          ids.singlePayment,
          ids.singleAuthorization,
          ids.ambiguousPayment,
          ids.ambiguousAuthorizationA,
          ids.ambiguousAuthorizationB,
          ids.capacityLine,
          ids.capacityPayment,
        ],
      );
      await client.query(
        `INSERT INTO remittance_allocations (id, remittance_id, payment_id, amount)
         VALUES ($1, $5, $9, 100.00),
                ($2, $6, $10, 25.00),
                ($3, $7, $11, 70.00),
                ($4, $8, $11, 50.00)`,
        [
          ids.singleLegacyAllocation,
          ids.ambiguousLegacyAllocation,
          ids.firstCapacityLegacyAllocation,
          ids.secondCapacityLegacyAllocation,
          ids.singleRemittance,
          ids.ambiguousRemittance,
          ids.firstCapacityRemittance,
          ids.secondCapacityRemittance,
          ids.singlePayment,
          ids.ambiguousPayment,
          ids.capacityPayment,
        ],
      );

      for (const statement of targetSchemaMigrationStatements) {
        await client.query(statement.replaceAll('"public".', `"${schema}".`));
      }
      for (const statement of targetGuardMigrationStatements) {
        await client.query(statement);
      }
      for (const statement of optionABackfillStatements) {
        await client.query(statement);
      }

      const mapped = await client.query(
        `SELECT payment_allocation_id
         FROM remittance_allocations
         WHERE id = $1`,
        [ids.singleLegacyAllocation],
      );
      expect(mapped.rows[0].payment_allocation_id).toBe(ids.singleLine);

      const capacityWinner = await client.query(
        `SELECT payment_allocation_id
         FROM remittance_allocations
         WHERE id = $1`,
        [ids.firstCapacityLegacyAllocation],
      );
      expect(capacityWinner.rows[0].payment_allocation_id).toBe(ids.capacityLine);
      const capacityTotals = await client.query(
        `SELECT sum(ra.amount)::text AS allocated, pa.amount::text AS line_amount
         FROM payment_allocations pa
         JOIN remittance_allocations ra ON ra.payment_allocation_id = pa.id
         WHERE pa.id = $1
         GROUP BY pa.id, pa.amount`,
        [ids.capacityLine],
      );
      expect(capacityTotals.rows[0]).toEqual({
        allocated: "70.00",
        line_amount: "100.00",
      });

      const unresolved = await client.query(
        `SELECT id, payment_allocation_id
         FROM remittance_allocations
         WHERE id IN ($1, $2)`,
        [ids.ambiguousLegacyAllocation, ids.secondCapacityLegacyAllocation],
      );
      expect(unresolved.rows).toHaveLength(2);
      expect(unresolved.rows.every((row) => row.payment_allocation_id === null)).toBe(true);

      const paymentStatuses = await client.query(
        `SELECT id, remitted FROM payments WHERE id IN ($1, $2) ORDER BY id`,
        [ids.singlePayment, ids.ambiguousPayment],
      );
      expect(paymentStatuses.rows).toContainEqual({
        id: ids.singlePayment,
        remitted: true,
      });
      expect(paymentStatuses.rows).toContainEqual({
        id: ids.ambiguousPayment,
        remitted: false,
      });

      const checkResults = [];
      for (const statement of optionACheckStatements) {
        checkResults.push(await client.query(statement));
      }
      expect(checkResults[0].rows[0]).toEqual({
        payment_allocations_missing_line: "2",
        collected_fees_not_fully_allocated: "0",
        payment_remitted_flag_disagreements: "0",
      });
      expect(checkResults[1].rows).toHaveLength(2);
      const unresolvedById = new Map(
        checkResults[1].rows.map((row) => [row.remittance_allocation_id, row]),
      );
      expect(unresolvedById.get(ids.ambiguousLegacyAllocation)).toMatchObject({
        remittance_allocation_id: ids.ambiguousLegacyAllocation,
        payment_id: ids.ambiguousPayment,
        payment_line_count: "2",
        remittance_compatible_line_count: "2",
      });
      expect(unresolvedById.get(ids.secondCapacityLegacyAllocation)).toMatchObject({
        remittance_allocation_id: ids.secondCapacityLegacyAllocation,
        payment_id: ids.capacityPayment,
        payment_line_count: "1",
        compatible_lines_with_balance: "0",
        payment_balance_fits: true,
        remittance_balance_fits: true,
      });
    } finally {
      await client.query("SET search_path TO public");
      client.release();
    }
  });
});