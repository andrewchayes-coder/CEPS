ALTER TABLE "referrals" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_vendor_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referrals_vendor_id_idx" ON "referrals" USING btree ("vendor_id");