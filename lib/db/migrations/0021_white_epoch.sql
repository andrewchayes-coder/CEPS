CREATE TABLE "invoice_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"service_month" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_line_items_positive_amount" CHECK ("invoice_line_items"."amount" > 0 AND "invoice_line_items"."amount" <> 'NaN'::numeric),
	CONSTRAINT "invoice_line_items_valid_month" CHECK ("invoice_line_items"."service_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_positive_amount" CHECK ("payment_allocations"."amount" > 0 AND "payment_allocations"."amount" <> 'NaN'::numeric)
);
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_authorization_id_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_authorization_id_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_line_items_invoice_id_idx" ON "invoice_line_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_line_items_authorization_id_idx" ON "invoice_line_items" USING btree ("authorization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_line_items_invoice_auth_month_unique" ON "invoice_line_items" USING btree ("invoice_id","authorization_id","service_month");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_id_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_authorization_id_idx" ON "payment_allocations" USING btree ("authorization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_payment_authorization_unique" ON "payment_allocations" USING btree ("payment_id","authorization_id");
--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "service_month" DROP NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
  missing_invoice integer;
  unusable_invoice integer;
  missing_payment integer;
  unusable_payment integer;
BEGIN
  SELECT count(*) INTO missing_invoice FROM invoices
    WHERE authorization_id IS NULL OR service_month IS NULL;
  IF missing_invoice > 0 THEN
    RAISE EXCEPTION 'Prompt 7 migration precondition failed: % invoices lack legacy authorization_id or service_month; remediate these rows before migrating', missing_invoice;
  END IF;
  SELECT count(*) INTO unusable_invoice FROM invoices
    WHERE amount_requested IS NULL OR amount_requested <= 0 OR amount_requested = 'NaN'::numeric;
  IF unusable_invoice > 0 THEN
    RAISE EXCEPTION 'Prompt 7 migration precondition failed: % invoices have nonpositive or unusable amount_requested', unusable_invoice;
  END IF;
  SELECT count(*) INTO missing_payment FROM payments
    WHERE authorization_id IS NULL;
  IF missing_payment > 0 THEN
    RAISE EXCEPTION 'Prompt 7 migration precondition failed: % payments lack legacy authorization_id; remediate these rows before migrating', missing_payment;
  END IF;
  SELECT count(*) INTO unusable_payment FROM payments
    WHERE amount IS NULL OR amount <= 0 OR amount = 'NaN'::numeric;
  IF unusable_payment > 0 THEN
    RAISE EXCEPTION 'Prompt 7 migration precondition failed: % payments have nonpositive or unusable amount', unusable_payment;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "invoice_line_items" ("invoice_id", "authorization_id", "service_month", "amount")
SELECT "id", "authorization_id", "service_month", "amount_requested"
FROM "invoices"
 WHERE "authorization_id" IS NOT NULL AND "service_month" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "payment_allocations" ("payment_id", "authorization_id", "amount")
SELECT "id", "authorization_id", "amount"
FROM "payments"
 WHERE "authorization_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM invoices i
    WHERE (SELECT count(*) FROM invoice_line_items li WHERE li.invoice_id = i.id) <> 1
  ) THEN RAISE EXCEPTION 'Prompt 7 migration failed: invoice authorization backfill is not exactly one row'; END IF;
  IF EXISTS (
    SELECT 1 FROM payments p
    WHERE (SELECT count(*) FROM payment_allocations pa WHERE pa.payment_id = p.id) <> 1
  ) THEN RAISE EXCEPTION 'Prompt 7 migration failed: payment authorization backfill is not exactly one row'; END IF;
  IF EXISTS (
    SELECT 1 FROM invoices i
    JOIN invoice_line_items li ON li.invoice_id = i.id
     WHERE li.amount <> i.amount_requested
  ) THEN RAISE EXCEPTION 'Prompt 7 migration failed: invoice line amount mismatch'; END IF;
  IF EXISTS (
    SELECT 1 FROM payments p
    JOIN payment_allocations pa ON pa.payment_id = p.id
     WHERE pa.amount <> p.amount
  ) THEN RAISE EXCEPTION 'Prompt 7 migration failed: payment allocation amount mismatch'; END IF;
END $$;
--> statement-breakpoint
-- Child allocations are authoritative after Prompt 7.  Keep the existing
-- participant guard, but resolve a payment's authorization through its
-- payment_allocations when the compatibility parent column is null.
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
BEGIN
  IF expected_payment_id IS NULL THEN RETURN; END IF;
  SELECT (
    p.is_deleted = false
    AND p.client_id = expected_client_id
    AND (
      expected_authorization_id IS NULL
      OR p.authorization_id = expected_authorization_id
      OR EXISTS (
        SELECT 1 FROM payment_allocations pa
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
      USING ERRCODE = '23503', CONSTRAINT = constraint_name;
  END IF;
END;
$$;