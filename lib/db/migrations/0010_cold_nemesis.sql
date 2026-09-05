LOCK TABLE remittances, payments, remittance_allocations IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
  invalid_ids text;
BEGIN
  SELECT string_agg(id::text, ', ' ORDER BY id)
  INTO invalid_ids
  FROM (
    SELECT id FROM remittance_allocations
    WHERE amount <= 0 OR amount = 'NaN'::numeric
    ORDER BY id LIMIT 10
  ) invalid;
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install allocation balance guards: nonpositive allocation ids: %', invalid_ids;
  END IF;

  SELECT string_agg(id::text, ', ' ORDER BY id)
  INTO invalid_ids
  FROM (
    SELECT id FROM remittances
    WHERE amount <= 0 OR amount = 'NaN'::numeric
    ORDER BY id LIMIT 10
  ) invalid;
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install allocation balance guards: invalid remittance amount ids: %', invalid_ids;
  END IF;

  SELECT string_agg(id::text, ', ' ORDER BY id)
  INTO invalid_ids
  FROM (
    SELECT id FROM payments
    WHERE amount <= 0 OR amount = 'NaN'::numeric
    ORDER BY id LIMIT 10
  ) invalid;
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install allocation balance guards: invalid payment amount ids: %', invalid_ids;
  END IF;

  SELECT string_agg(id::text, ', ' ORDER BY id)
  INTO invalid_ids
  FROM (
    SELECT r.id
    FROM remittances r
    JOIN remittance_allocations ra ON ra.remittance_id = r.id
    GROUP BY r.id, r.amount
    HAVING sum(ra.amount) > r.amount
    ORDER BY r.id LIMIT 10
  ) invalid;
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install allocation balance guards: over-allocated remittance ids: %', invalid_ids;
  END IF;

  SELECT string_agg(id::text, ', ' ORDER BY id)
  INTO invalid_ids
  FROM (
    SELECT p.id
    FROM payments p
    JOIN remittance_allocations ra ON ra.payment_id = p.id
    GROUP BY p.id, p.amount
    HAVING sum(ra.amount) > p.amount
    ORDER BY p.id LIMIT 10
  ) invalid;
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install allocation balance guards: over-allocated payment ids: %', invalid_ids;
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_positive_finite_amount" CHECK ("payments"."amount" > 0 AND "payments"."amount" <> 'NaN'::numeric);--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_positive_amount" CHECK ("remittance_allocations"."amount" > 0 AND "remittance_allocations"."amount" <> 'NaN'::numeric);--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_positive_finite_amount" CHECK ("remittances"."amount" > 0 AND "remittances"."amount" <> 'NaN'::numeric);--> statement-breakpoint
CREATE FUNCTION enforce_remittance_allocation_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  remittance_limit numeric(12, 2);
  payment_limit numeric(12, 2);
  remittance_total numeric;
  payment_total numeric;
BEGIN
  -- Every reconciliation writer must use this same lock order: all affected
  -- remittances by id first, then all affected payments by id.
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

  SELECT amount INTO remittance_limit FROM remittances WHERE id = NEW.remittance_id;
  SELECT amount INTO payment_limit FROM payments WHERE id = NEW.payment_id;

  SELECT coalesce(sum(amount), 0) INTO remittance_total
  FROM remittance_allocations
  WHERE remittance_id = NEW.remittance_id
    AND (TG_OP <> 'UPDATE' OR id <> OLD.id);

  SELECT coalesce(sum(amount), 0) INTO payment_total
  FROM remittance_allocations
  WHERE payment_id = NEW.payment_id
    AND (TG_OP <> 'UPDATE' OR id <> OLD.id);

  IF remittance_total + NEW.amount > remittance_limit THEN
    RAISE EXCEPTION 'allocation exceeds remittance balance'
      USING ERRCODE = '23514',
            CONSTRAINT = 'remittance_allocations_remittance_balance';
  END IF;

  IF payment_total + NEW.amount > payment_limit THEN
    RAISE EXCEPTION 'allocation exceeds payment balance'
      USING ERRCODE = '23514',
            CONSTRAINT = 'remittance_allocations_payment_balance';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER remittance_allocations_balance_guard
BEFORE INSERT OR UPDATE OF remittance_id, payment_id, amount
ON remittance_allocations
FOR EACH ROW
EXECUTE FUNCTION enforce_remittance_allocation_balances();--> statement-breakpoint
CREATE FUNCTION enforce_remittance_amount_not_below_allocations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.amount < (
    SELECT coalesce(sum(amount), 0)
    FROM remittance_allocations
    WHERE remittance_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'remittance amount cannot be below allocated total'
      USING ERRCODE = '23514',
            CONSTRAINT = 'remittances_amount_covers_allocations';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER remittances_amount_balance_guard
BEFORE UPDATE OF amount
ON remittances
FOR EACH ROW
EXECUTE FUNCTION enforce_remittance_amount_not_below_allocations();--> statement-breakpoint
CREATE FUNCTION enforce_payment_amount_not_below_allocations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.amount < (
    SELECT coalesce(sum(amount), 0)
    FROM remittance_allocations
    WHERE payment_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'payment amount cannot be below allocated total'
      USING ERRCODE = '23514',
            CONSTRAINT = 'payments_amount_covers_allocations';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER payments_amount_balance_guard
BEFORE UPDATE OF amount
ON payments
FOR EACH ROW
EXECUTE FUNCTION enforce_payment_amount_not_below_allocations();