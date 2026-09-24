DROP INDEX "payment_allocations_payment_authorization_unique";--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD COLUMN "service_month" text;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_payment_authorization_service_month_unique" ON "payment_allocations" USING btree ("payment_id","authorization_id","service_month");--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_valid_service_month" CHECK ("payment_allocations"."service_month" IS NULL OR "payment_allocations"."service_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');