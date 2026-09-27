SELECT
  (
    SELECT count(*)
    FROM remittance_allocations ra
    WHERE ra.payment_id IS NOT NULL
      AND ra.payment_allocation_id IS NULL
  ) AS payment_allocations_missing_line,
  (
    SELECT count(*)
    FROM fees f
    WHERE f.is_deleted = false
      AND f.status = 'collected'
      AND coalesce((
        SELECT sum(ra.amount)
        FROM remittance_allocations ra
        WHERE ra.fee_id = f.id
      ), 0) <> f.amount
  ) AS collected_fees_not_fully_allocated,
  (
    SELECT count(*)
    FROM payments p
    WHERE p.remitted IS DISTINCT FROM CASE
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
    END
  ) AS payment_remitted_flag_disagreements;

SELECT
  ra.id AS remittance_allocation_id,
  ra.payment_id,
  r.id AS remittance_id,
  r.authorization_id AS remittance_authorization_id,
  r.payment_month,
  r.is_deleted AS remittance_is_deleted,
  p.is_deleted AS payment_is_deleted,
  p.client_id = r.client_id AS payment_client_matches,
  (
    SELECT count(*)
    FROM payment_allocations pa
    WHERE pa.payment_id = ra.payment_id
  ) AS payment_line_count,
  (
    SELECT count(*)
    FROM payment_allocations pa
    WHERE pa.payment_id = ra.payment_id
      AND r.authorization_id IS NOT NULL
      AND r.payment_month IS NOT NULL
      AND pa.authorization_id = r.authorization_id
      AND pa.service_month = r.payment_month
  ) AS auth_month_line_count,
  (
    SELECT count(*)
    FROM payment_allocations pa
    WHERE pa.payment_id = ra.payment_id
      AND (r.authorization_id IS NULL OR pa.authorization_id = r.authorization_id)
      AND (r.payment_month IS NULL OR pa.service_month = r.payment_month)
  ) AS remittance_compatible_line_count,
  (
    SELECT count(*)
    FROM payment_allocations pa
    WHERE pa.payment_id = ra.payment_id
      AND (r.authorization_id IS NULL OR pa.authorization_id = r.authorization_id)
      AND (r.payment_month IS NULL OR pa.service_month = r.payment_month)
      AND coalesce((
        SELECT sum(existing.amount)
        FROM remittance_allocations existing
        WHERE existing.payment_allocation_id = pa.id
      ), 0) + ra.amount <= pa.amount
  ) AS compatible_lines_with_balance,
  coalesce((
    SELECT sum(existing.amount)
    FROM remittance_allocations existing
    WHERE existing.payment_id = p.id
      AND existing.id <> ra.id
  ), 0) + ra.amount <= p.amount AS payment_balance_fits,
  coalesce((
    SELECT sum(existing.amount)
    FROM remittance_allocations existing
    WHERE existing.remittance_id = r.id
      AND existing.id <> ra.id
  ), 0) + ra.amount <= r.amount AS remittance_balance_fits
FROM remittance_allocations ra
JOIN remittances r ON r.id = ra.remittance_id
JOIN payments p ON p.id = ra.payment_id
WHERE ra.payment_id IS NOT NULL
  AND ra.payment_allocation_id IS NULL
ORDER BY ra.id;