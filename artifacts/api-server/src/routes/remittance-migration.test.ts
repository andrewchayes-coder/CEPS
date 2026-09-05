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