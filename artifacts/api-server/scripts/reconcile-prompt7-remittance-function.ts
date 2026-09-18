import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

await db.execute(sql.raw(`
CREATE OR REPLACE FUNCTION require_matching_remittance_payment(
  expected_client_id uuid, expected_authorization_id uuid, expected_payment_id uuid,
  constraint_name text, error_message text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE valid_payment boolean;
BEGIN
  IF expected_payment_id IS NULL THEN RETURN; END IF;
  SELECT (
    p.is_deleted = false AND p.client_id = expected_client_id AND (
      expected_authorization_id IS NULL OR p.authorization_id = expected_authorization_id OR EXISTS (
        SELECT 1 FROM payment_allocations pa
        WHERE pa.payment_id = p.id AND pa.authorization_id = expected_authorization_id
      )
    )
  ) INTO valid_payment
  FROM payments p WHERE p.id = expected_payment_id FOR SHARE;
  IF valid_payment IS DISTINCT FROM true THEN
    RAISE EXCEPTION '%', error_message USING ERRCODE = '23503', CONSTRAINT = constraint_name;
  END IF;
END;
$$;
`));
await pool.end();