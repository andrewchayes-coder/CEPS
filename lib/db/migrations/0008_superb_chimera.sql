DROP INDEX "payments_qb_check_number_unique";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "source_row_fingerprint" text;--> statement-breakpoint
CREATE INDEX "payments_qb_check_number_idx" ON "payments" USING btree ("qb_check_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_source_row_fingerprint_unique" ON "payments" USING btree ("source_row_fingerprint") WHERE "payments"."source_row_fingerprint" IS NOT NULL;