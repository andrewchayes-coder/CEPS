CREATE OR REPLACE FUNCTION enforce_remittance_allocation_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  remittance_limit numeric(12, 2);
  payment_limit numeric(12, 2);
  line_limit numeric(12, 2);
  fee_limit numeric(12, 2);
  remittance_total numeric;
  payment_total numeric;
  line_total numeric;
  fee_total numeric;
BEGIN
  -- Lock order: remittances, payments, payment_allocations, then fees, each by id.
  PERFORM 1
  FROM remittances
  WHERE id IN (NEW.remittance_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.remittance_id END)
  ORDER BY id
  FOR UPDATE;

  PERFORM 1
  FROM payments
  WHERE id IN (NEW.payment_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.payment_id END)
  ORDER BY id
  FOR UPDATE;

  PERFORM 1
  FROM payment_allocations
  WHERE id IN (NEW.payment_allocation_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.payment_allocation_id END)
  ORDER BY id
  FOR UPDATE;

  PERFORM 1
  FROM fees
  WHERE id IN (NEW.fee_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.fee_id END)
  ORDER BY id
  FOR UPDATE;

  SELECT amount INTO remittance_limit FROM remittances WHERE id = NEW.remittance_id;
  SELECT coalesce(sum(amount), 0) INTO remittance_total
  FROM remittance_allocations
  WHERE remittance_id = NEW.remittance_id
    AND (TG_OP <> 'UPDATE' OR id <> OLD.id);

  IF remittance_total + NEW.amount > remittance_limit THEN
    RAISE EXCEPTION 'allocation exceeds remittance balance'
      USING ERRCODE = '23514',
            CONSTRAINT = 'remittance_allocations_remittance_balance';
  END IF;

  IF NEW.payment_id IS NOT NULL THEN
    SELECT amount INTO payment_limit FROM payments WHERE id = NEW.payment_id;
    SELECT coalesce(sum(amount), 0) INTO payment_total
    FROM remittance_allocations
    WHERE payment_id = NEW.payment_id
      AND (TG_OP <> 'UPDATE' OR id <> OLD.id);

    IF payment_total + NEW.amount > payment_limit THEN
      RAISE EXCEPTION 'allocation exceeds payment balance'
        USING ERRCODE = '23514',
              CONSTRAINT = 'remittance_allocations_payment_balance';
    END IF;

    SELECT amount INTO line_limit
    FROM payment_allocations
    WHERE id = NEW.payment_allocation_id
      AND payment_id = NEW.payment_id;

    IF line_limit IS NULL THEN
      RAISE EXCEPTION 'payment allocation target must be a line belonging to the payment'
        USING ERRCODE = '23503',
              CONSTRAINT = 'remittance_allocations_payment_line_link';
    END IF;

    SELECT coalesce(sum(amount), 0) INTO line_total
    FROM remittance_allocations
    WHERE payment_allocation_id = NEW.payment_allocation_id
      AND (TG_OP <> 'UPDATE' OR id <> OLD.id);

    IF line_total + NEW.amount > line_limit THEN
      RAISE EXCEPTION 'allocation exceeds payment line balance'
        USING ERRCODE = '23514',
              CONSTRAINT = 'remittance_allocations_line_balance';
    END IF;
  ELSE
    SELECT amount INTO fee_limit FROM fees WHERE id = NEW.fee_id;
    IF fee_limit IS NULL THEN
      RAISE EXCEPTION 'fee allocation target does not exist'
        USING ERRCODE = '23503',
              CONSTRAINT = 'remittance_allocations_fee_link';
    END IF;

    SELECT coalesce(sum(amount), 0) INTO fee_total
    FROM remittance_allocations
    WHERE fee_id = NEW.fee_id
      AND (TG_OP <> 'UPDATE' OR id <> OLD.id);

    IF fee_total + NEW.amount > fee_limit THEN
      RAISE EXCEPTION 'allocation exceeds fee balance'
        USING ERRCODE = '23514',
              CONSTRAINT = 'remittance_allocations_fee_balance';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS remittance_allocations_balance_guard ON remittance_allocations;
--> statement-breakpoint

CREATE TRIGGER remittance_allocations_balance_guard
BEFORE INSERT OR UPDATE OF remittance_id, payment_id, payment_allocation_id, fee_id, amount
ON remittance_allocations
FOR EACH ROW
EXECUTE FUNCTION enforce_remittance_allocation_balances();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION require_matching_remittance_payment(
  expected_client_id uuid,
  expected_authorization_id uuid,
  expected_payment_id uuid,
  constraint_name text,
  error_message text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  valid_payment boolean;
  expected_authorization_is_fee boolean;
BEGIN
  IF expected_payment_id IS NULL THEN RETURN; END IF;

  IF expected_authorization_id IS NOT NULL THEN
    SELECT payment_type = 'fee'
    INTO expected_authorization_is_fee
    FROM authorizations
    WHERE id = expected_authorization_id
    FOR SHARE;
  END IF;

  SELECT (
    p.is_deleted = false
    AND p.client_id = expected_client_id
    AND coalesce(expected_authorization_is_fee, false) = false
    AND (
      expected_authorization_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM payment_allocations pa
        WHERE pa.payment_id = p.id
          AND pa.authorization_id = expected_authorization_id
      )
    )
  )
  INTO valid_payment
  FROM payments p
  WHERE p.id = expected_payment_id
  FOR SHARE;

  IF valid_payment IS DISTINCT FROM true THEN
    RAISE EXCEPTION '%', error_message
      USING ERRCODE = '23503',
            CONSTRAINT = constraint_name;
  END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_remittance_allocation_parent_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_deleted = true AND OLD.is_deleted = false AND EXISTS (
    SELECT 1
    FROM remittance_allocations
    WHERE remittance_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Remittance cannot be deleted while allocations reference it'
      USING ERRCODE = '23503',
            CONSTRAINT = 'remittances_active_allocation_links';
  END IF;

  IF (
    NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
    OR NEW.payment_month IS DISTINCT FROM OLD.payment_month
  ) AND EXISTS (
    SELECT 1
    FROM remittance_allocations ra
    LEFT JOIN payments p ON p.id = ra.payment_id
    LEFT JOIN payment_allocations pa ON pa.id = ra.payment_allocation_id
    LEFT JOIN fees f ON f.id = ra.fee_id
    WHERE ra.remittance_id = OLD.id
      AND (
        (
          ra.payment_id IS NOT NULL
          AND (
            p.is_deleted IS DISTINCT FROM false
            OR p.client_id IS DISTINCT FROM NEW.client_id
            OR (
              NEW.authorization_id IS NOT NULL
              AND pa.authorization_id IS DISTINCT FROM NEW.authorization_id
            )
            OR (
              NEW.payment_month IS NOT NULL
              AND pa.service_month IS DISTINCT FROM NEW.payment_month
            )
          )
        )
        OR (
          ra.fee_id IS NOT NULL
          AND (
            f.is_deleted IS DISTINCT FROM false
            OR f.status = 'waived'
            OR f.client_id IS DISTINCT FROM NEW.client_id
            OR (
              NEW.authorization_id IS NOT NULL
              AND f.authorization_id IS DISTINCT FROM NEW.authorization_id
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Remittance client, authorization, or month cannot change while allocations would become invalid'
      USING ERRCODE = '23503',
            CONSTRAINT = 'remittances_active_allocation_links';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS remittances_financial_link_guard ON remittances;
--> statement-breakpoint

CREATE TRIGGER remittances_financial_link_guard
BEFORE UPDATE OF is_deleted, client_id, authorization_id, payment_month
ON remittances
FOR EACH ROW
EXECUTE FUNCTION enforce_remittance_allocation_parent_links();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_remittance_allocation_active_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  remittance_client_id uuid;
  remittance_authorization_id uuid;
  remittance_payment_month text;
  remittance_is_deleted boolean;
  valid_target boolean;
BEGIN
  SELECT client_id, authorization_id, payment_month, is_deleted
  INTO remittance_client_id, remittance_authorization_id, remittance_payment_month, remittance_is_deleted
  FROM remittances
  WHERE id = NEW.remittance_id
  FOR SHARE;

  IF remittance_is_deleted IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Allocation must reference an active remittance'
      USING ERRCODE = '23503',
            CONSTRAINT = 'remittance_allocations_active_remittance_link';
  END IF;

  IF NEW.fee_id IS NOT NULL THEN
    SELECT (
      f.is_deleted = false
      AND f.status <> 'waived'
      AND f.client_id = remittance_client_id
      AND (
        remittance_authorization_id IS NULL
        OR f.authorization_id = remittance_authorization_id
      )
    )
    INTO valid_target
    FROM fees f
    WHERE f.id = NEW.fee_id
    FOR SHARE;

    IF valid_target IS DISTINCT FROM true OR NEW.payment_id IS NOT NULL OR NEW.payment_allocation_id IS NOT NULL THEN
      RAISE EXCEPTION 'Allocation fee must be active, non-waived, and belong to the remittance client and authorization'
        USING ERRCODE = '23503',
              CONSTRAINT = 'remittance_allocations_active_fee_link';
    END IF;
  ELSE
    IF NEW.payment_id IS NULL OR NEW.payment_allocation_id IS NULL THEN
      RAISE EXCEPTION 'Payment allocation target must include a payment and payment line'
        USING ERRCODE = '23503',
              CONSTRAINT = 'remittance_allocations_payment_line_link';
    END IF;

    SELECT (
      p.is_deleted = false
      AND p.client_id = remittance_client_id
      AND pa.payment_id = p.id
      AND (
        remittance_authorization_id IS NULL
        OR pa.authorization_id = remittance_authorization_id
      )
      AND (
        remittance_payment_month IS NULL
        OR pa.service_month = remittance_payment_month
      )
    )
    INTO valid_target
    FROM payments p
    JOIN payment_allocations pa ON pa.payment_id = p.id
    WHERE p.id = NEW.payment_id
      AND pa.id = NEW.payment_allocation_id
    FOR SHARE OF p, pa;

    IF valid_target IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Allocation payment line must belong to an active payment for the remittance client, authorization, and month'
        USING ERRCODE = '23503',
              CONSTRAINT = 'remittance_allocations_active_payment_line_link';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS remittance_allocations_active_links_guard ON remittance_allocations;
--> statement-breakpoint

CREATE TRIGGER remittance_allocations_active_links_guard
BEFORE INSERT OR UPDATE OF remittance_id, payment_id, payment_allocation_id, fee_id
ON remittance_allocations
FOR EACH ROW
EXECUTE FUNCTION enforce_remittance_allocation_active_links();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_fee_amount_not_below_allocations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.amount < (
    SELECT coalesce(sum(amount), 0)
    FROM remittance_allocations
    WHERE fee_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'fee amount cannot be below allocated total'
      USING ERRCODE = '23514',
            CONSTRAINT = 'fees_amount_covers_allocations';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS fees_amount_balance_guard ON fees;
--> statement-breakpoint

CREATE TRIGGER fees_amount_balance_guard
BEFORE UPDATE OF amount
ON fees
FOR EACH ROW
EXECUTE FUNCTION enforce_fee_amount_not_below_allocations();