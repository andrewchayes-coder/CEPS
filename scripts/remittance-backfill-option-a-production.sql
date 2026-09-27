WITH candidate_lines AS (
  SELECT
    ra.id AS allocation_id,
    ra.remittance_id,
    ra.payment_id,
    ra.amount AS allocation_amount,
    ra.created_at,
    r.remittance_date,
    CASE
      WHEN count(DISTINCT all_lines.id) = 1 THEN (array_agg(all_lines.id ORDER BY all_lines.id))[1]
      WHEN r.authorization_id IS NOT NULL
        AND r.payment_month IS NOT NULL
        AND count(DISTINCT matching_lines.id) = 1 THEN (array_agg(matching_lines.id ORDER BY matching_lines.id))[1]
      ELSE NULL
    END AS payment_allocation_id
  FROM remittance_allocations ra
  JOIN remittances r ON r.id = ra.remittance_id
  LEFT JOIN payment_allocations all_lines ON all_lines.payment_id = ra.payment_id
  LEFT JOIN payment_allocations matching_lines
    ON matching_lines.payment_id = ra.payment_id
   AND matching_lines.authorization_id = r.authorization_id
   AND matching_lines.service_month = r.payment_month
  WHERE ra.payment_id IS NOT NULL
    AND ra.payment_allocation_id IS NULL
  GROUP BY ra.id, ra.remittance_id, ra.payment_id, ra.amount, ra.created_at,
    r.remittance_date, r.authorization_id, r.payment_month
), guard_eligible AS (
  SELECT candidates.*, pa.amount AS target_amount
  FROM candidate_lines candidates
  JOIN remittances r ON r.id = candidates.remittance_id
  JOIN payments p ON p.id = candidates.payment_id
  JOIN payment_allocations pa
    ON pa.id = candidates.payment_allocation_id
   AND pa.payment_id = p.id
  WHERE candidates.payment_allocation_id IS NOT NULL
    AND r.is_deleted = false
    AND p.is_deleted = false
    AND p.client_id = r.client_id
    AND (r.authorization_id IS NULL OR pa.authorization_id = r.authorization_id)
    AND (r.payment_month IS NULL OR pa.service_month = r.payment_month)
    AND coalesce((
      SELECT sum(existing.amount)
      FROM remittance_allocations existing
      WHERE existing.payment_id = p.id
        AND existing.id <> candidates.allocation_id
    ), 0) + candidates.allocation_amount <= p.amount
    AND coalesce((
      SELECT sum(existing.amount)
      FROM remittance_allocations existing
      WHERE existing.remittance_id = r.id
        AND existing.id <> candidates.allocation_id
    ), 0) + candidates.allocation_amount <= r.amount
), line_reservations AS (
  SELECT
    eligible.*,
    coalesce((
      SELECT sum(existing.amount)
      FROM remittance_allocations existing
      WHERE existing.payment_allocation_id = eligible.payment_allocation_id
    ), 0)
    + sum(eligible.allocation_amount) OVER (
      PARTITION BY eligible.payment_allocation_id
      ORDER BY eligible.remittance_date, eligible.created_at, eligible.allocation_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS reserved_line_amount
  FROM guard_eligible eligible
), eligible_updates AS (
  SELECT allocation_id, payment_allocation_id
  FROM line_reservations
  WHERE reserved_line_amount <= target_amount
)
UPDATE remittance_allocations ra
SET payment_allocation_id = eligible_updates.payment_allocation_id
FROM eligible_updates
WHERE ra.id = eligible_updates.allocation_id;

WITH fee_auth AS (
  SELECT
    f.id AS fee_id,
    (
      SELECT a.id
      FROM authorizations a
      WHERE a.client_id = f.client_id
        AND a.payment_type = 'fee'
        AND a.is_deleted = false
        AND a.status <> 'canceled'
        AND f.fee_month IS NOT NULL
        AND make_date(split_part(f.fee_month, '-', 1)::integer, split_part(f.fee_month, '-', 2)::integer, 1)
          BETWEEN a.service_period_start AND a.service_period_end
      ORDER BY a.service_period_start DESC, a.id
      LIMIT 1
    ) AS authorization_id
  FROM fees f
  WHERE f.is_deleted = false
)
UPDATE fees f
SET authorization_id = fee_auth.authorization_id
FROM fee_auth
WHERE f.id = fee_auth.fee_id
  AND f.authorization_id IS DISTINCT FROM fee_auth.authorization_id;

WITH fees_to_reset AS (
  SELECT f.id
  FROM fees f
  WHERE f.status = 'collected'
    AND f.is_deleted = false
    AND coalesce((
      SELECT sum(ra.amount)
      FROM remittance_allocations ra
      WHERE ra.fee_id = f.id
    ), 0) < f.amount
), updated AS (
  UPDATE fees f
  SET status = 'pending'
  FROM fees_to_reset reset
  WHERE f.id = reset.id
  RETURNING f.id
)
INSERT INTO audit_log (action, entity_type, entity_id, detail)
SELECT
  'uncollect_fee',
  'fee',
  updated.id::text,
  'Option A migration backfill reset collected status because fee remittance allocations do not cover the fee'
FROM updated;

UPDATE payments p
SET remitted = CASE
  WHEN EXISTS (
    SELECT 1 FROM payment_allocations pa WHERE pa.payment_id = p.id
  ) THEN NOT EXISTS (
    SELECT 1
    FROM payment_allocations pa
    WHERE pa.payment_id = p.id
      AND coalesce((
        SELECT sum(ra.amount)
        FROM remittance_allocations ra
        WHERE ra.payment_allocation_id = pa.id
      ), 0) < pa.amount
  )
  ELSE coalesce((
    SELECT sum(ra.amount)
    FROM remittance_allocations ra
    WHERE ra.payment_id = p.id
  ), 0) >= p.amount
END;