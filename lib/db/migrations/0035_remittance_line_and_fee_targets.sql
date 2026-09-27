DROP INDEX "remittance_allocations_pair_unique";--> statement-breakpoint
ALTER TABLE "remittance_allocations" ALTER COLUMN "payment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD COLUMN "payment_allocation_id" uuid;--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD COLUMN "fee_id" uuid;--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_payment_line_fk" FOREIGN KEY ("payment_allocation_id") REFERENCES "public"."payment_allocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_fee_id_fees_id_fk" FOREIGN KEY ("fee_id") REFERENCES "public"."fees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remittance_allocations_payment_allocation_id_idx" ON "remittance_allocations" USING btree ("payment_allocation_id");--> statement-breakpoint
CREATE INDEX "remittance_allocations_fee_id_idx" ON "remittance_allocations" USING btree ("fee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "remittance_allocations_payment_allocation_unique" ON "remittance_allocations" USING btree ("remittance_id","payment_allocation_id") WHERE "remittance_allocations"."payment_allocation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "remittance_allocations_fee_unique" ON "remittance_allocations" USING btree ("remittance_id","fee_id") WHERE "remittance_allocations"."fee_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_one_target" CHECK (("remittance_allocations"."fee_id" IS NULL) <> ("remittance_allocations"."payment_id" IS NULL));