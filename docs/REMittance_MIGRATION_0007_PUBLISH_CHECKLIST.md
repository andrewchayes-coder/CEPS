# Migration 0007 publish reconciliation checklist

Migration `0007_omniscient_ken_ellis.sql` creates the remittance allocation ledger and backfills each non-deleted legacy remittance that has a matched payment. Replit Publish remains responsible for production schema synchronization. Do **not** add `db:migrate` to production startup.

## Before publish

Run this read-only query and record the result:

```sql
SELECT
  count(*) FILTER (
    WHERE matched_payment_id IS NOT NULL AND is_deleted = false
  ) AS eligible_legacy_matches,
  coalesce(sum(amount) FILTER (
    WHERE matched_payment_id IS NOT NULL AND is_deleted = false
  ), 0)::numeric(12, 2) AS eligible_legacy_amount
FROM remittances;
```

Expected: the count and amount are the baseline that migration 0007 must represent. Unmatched and deleted remittances are intentionally excluded.

## After publish

Run these read-only checks after Publish reports schema synchronization complete.

```sql
-- Every eligible legacy pair has exactly one allocation for the exact legacy amount.
SELECT
  count(*) AS bad_legacy_pairs
FROM remittances r
LEFT JOIN remittance_allocations ra
  ON ra.remittance_id = r.id
 AND ra.payment_id = r.matched_payment_id
WHERE r.matched_payment_id IS NOT NULL
  AND r.is_deleted = false
  AND (ra.id IS NULL OR ra.amount <> r.amount);
```

Expected: `bad_legacy_pairs = 0`.

```sql
-- No duplicate remittance/payment pairs exist.
SELECT remittance_id, payment_id, count(*) AS pair_count
FROM remittance_allocations
GROUP BY remittance_id, payment_id
HAVING count(*) <> 1;
```

Expected: zero rows.

```sql
-- Allocation totals must not exceed either side, and remaining balances stay exact to cents.
WITH remittance_totals AS (
  SELECT r.id, r.amount, coalesce(sum(ra.amount), 0)::numeric(12, 2) AS allocated
  FROM remittances r
  LEFT JOIN remittance_allocations ra ON ra.remittance_id = r.id
  GROUP BY r.id, r.amount
),
payment_totals AS (
  SELECT p.id, p.amount, coalesce(sum(ra.amount), 0)::numeric(12, 2) AS allocated
  FROM payments p
  LEFT JOIN remittance_allocations ra ON ra.payment_id = p.id
  GROUP BY p.id, p.amount
)
SELECT
  (SELECT count(*) FROM remittance_totals WHERE allocated > amount) AS overallocated_remittances,
  (SELECT count(*) FROM payment_totals WHERE allocated > amount) AS overallocated_payments,
  (SELECT coalesce(sum(amount - allocated), 0)::numeric(12, 2) FROM remittance_totals) AS remittance_remaining,
  (SELECT coalesce(sum(amount - allocated), 0)::numeric(12, 2) FROM payment_totals) AS payment_remaining;
```

Expected: both over-allocation counts are `0`. Record both remaining totals and compare them with the same query run on the publish snapshot after applying migration 0007 in a rehearsal; they must match exactly to cents.

## Automated rehearsal evidence

`remittance-migration.test.ts` executes the checked-in migration SQL in an isolated PostgreSQL schema using matched, unmatched, deleted, and already-allocated synthetic rows. It asserts:

- one allocation per eligible legacy pair, even if the backfill statement is repeated;
- allocation total equals the eligible legacy total exactly to cents;
- unmatched and deleted rows receive no allocation;
- neither remittances nor payments are over-allocated; and
- fully matched remaining balances stay `0.00`.

Run:

```sh
pnpm --filter @workspace/api-server exec vitest run src/routes/remittance-migration.test.ts --maxWorkers=1
```