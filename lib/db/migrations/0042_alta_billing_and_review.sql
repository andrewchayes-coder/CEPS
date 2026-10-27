CREATE TABLE "alta_billing_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_batch_id" text NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"client_id" uuid,
	"uci_number" text NOT NULL,
	"auth_number" text NOT NULL,
	"authorization_id" uuid,
	"service_code" text NOT NULL,
	"service_month" text NOT NULL,
	"billed_amount" numeric(12, 2) NOT NULL,
	"fee_id" uuid,
	"match_status" text NOT NULL,
	"review_reason" text,
	"source_row_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "alta_billing_rows_positive_amount" CHECK ("alta_billing_rows"."billed_amount" > 0 AND "alta_billing_rows"."billed_amount" <> 'NaN'::numeric),
	CONSTRAINT "alta_billing_rows_match_status" CHECK ("alta_billing_rows"."match_status" IN ('matched', 'unmatched', 'amount_mismatch')),
	CONSTRAINT "alta_billing_rows_valid_month" CHECK ("alta_billing_rows"."service_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "alta_billing_row_lines" (
	"billing_row_id" uuid NOT NULL,
	"payment_allocation_id" uuid NOT NULL,
	"line_amount" numeric(12, 2) NOT NULL,
	CONSTRAINT "alta_billing_row_lines_billing_row_id_payment_allocation_id_pk" PRIMARY KEY("billing_row_id","payment_allocation_id"),
	CONSTRAINT "alta_billing_row_lines_positive_amount" CHECK ("alta_billing_row_lines"."line_amount" > 0 AND "alta_billing_row_lines"."line_amount" <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "review_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"payment_allocation_id" uuid,
	"fee_id" uuid,
	"reason" text NOT NULL,
	"flagged_by" uuid NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_note" text,
	CONSTRAINT "review_flags_valid_target" CHECK (("review_flags"."target_type" = 'payment_line' AND "review_flags"."payment_allocation_id" IS NOT NULL AND "review_flags"."fee_id" IS NULL) OR ("review_flags"."target_type" = 'fee' AND "review_flags"."fee_id" IS NOT NULL AND "review_flags"."payment_allocation_id" IS NULL)),
	CONSTRAINT "review_flags_reason_length" CHECK (length(btrim("review_flags"."reason")) BETWEEN 1 AND 500),
	CONSTRAINT "review_flags_resolution" CHECK (("review_flags"."resolved_at" IS NULL AND "review_flags"."resolved_by" IS NULL AND "review_flags"."resolution_note" IS NULL) OR ("review_flags"."resolved_at" IS NOT NULL AND "review_flags"."resolved_by" IS NOT NULL AND length(btrim("review_flags"."resolution_note")) BETWEEN 1 AND 500))
);
--> statement-breakpoint
ALTER TABLE "alta_billing_rows" ADD CONSTRAINT "alta_billing_rows_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alta_billing_rows" ADD CONSTRAINT "alta_billing_rows_authorization_id_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alta_billing_rows" ADD CONSTRAINT "alta_billing_rows_fee_id_fees_id_fk" FOREIGN KEY ("fee_id") REFERENCES "public"."fees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alta_billing_rows" ADD CONSTRAINT "alta_billing_rows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alta_billing_rows" ADD CONSTRAINT "alta_billing_rows_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alta_billing_row_lines" ADD CONSTRAINT "alta_billing_row_lines_source_fk" FOREIGN KEY ("billing_row_id") REFERENCES "public"."alta_billing_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alta_billing_row_lines" ADD CONSTRAINT "alta_billing_row_lines_line_fk" FOREIGN KEY ("payment_allocation_id") REFERENCES "public"."payment_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_payment_allocation_id_payment_allocations_id_fk" FOREIGN KEY ("payment_allocation_id") REFERENCES "public"."payment_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_fee_id_fees_id_fk" FOREIGN KEY ("fee_id") REFERENCES "public"."fees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_flagged_by_users_id_fk" FOREIGN KEY ("flagged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alta_billing_rows_fee_idx" ON "alta_billing_rows" USING btree ("fee_id");--> statement-breakpoint
CREATE INDEX "alta_billing_rows_client_idx" ON "alta_billing_rows" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "alta_billing_rows_batch_idx" ON "alta_billing_rows" USING btree ("import_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alta_billing_rows_fingerprint_unique" ON "alta_billing_rows" USING btree ("source_row_fingerprint") WHERE "alta_billing_rows"."source_row_fingerprint" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "alta_billing_row_lines_line_idx" ON "alta_billing_row_lines" USING btree ("payment_allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_flags_open_line_unique" ON "review_flags" USING btree ("payment_allocation_id") WHERE "review_flags"."resolved_at" IS NULL AND "review_flags"."payment_allocation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "review_flags_open_fee_unique" ON "review_flags" USING btree ("fee_id") WHERE "review_flags"."resolved_at" IS NULL AND "review_flags"."fee_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "review_flags_flagged_at_idx" ON "review_flags" USING btree ("flagged_at");