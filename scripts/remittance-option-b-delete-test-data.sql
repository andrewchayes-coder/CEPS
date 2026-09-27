SELECT
  'before' AS checkpoint,
  (SELECT count(*) FROM remittances) AS remittance_count,
  (SELECT count(*) FROM remittance_allocations) AS allocation_count,
  (SELECT count(*) FROM payments WHERE remitted = true) AS remitted_payment_count,
  (SELECT count(*) FROM fees WHERE status = 'collected') AS collected_fee_count;

DELETE FROM remittance_allocations;

DELETE FROM remittances;

UPDATE payments
SET remitted = false;

UPDATE fees
SET status = 'pending'
WHERE status = 'collected';

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

SELECT
  'after' AS checkpoint,
  (SELECT count(*) FROM remittances) AS remittance_count,
  (SELECT count(*) FROM remittance_allocations) AS allocation_count,
  (SELECT count(*) FROM payments WHERE remitted = true) AS remitted_payment_count,
  (SELECT count(*) FROM fees WHERE status = 'collected') AS collected_fee_count;