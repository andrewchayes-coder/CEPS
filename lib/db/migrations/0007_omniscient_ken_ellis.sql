CREATE TABLE "remittance_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remittance_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"auto_matched" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_remittance_id_remittances_id_fk" FOREIGN KEY ("remittance_id") REFERENCES "public"."remittances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remittance_allocations_remittance_id_idx" ON "remittance_allocations" USING btree ("remittance_id");--> statement-breakpoint
CREATE INDEX "remittance_allocations_payment_id_idx" ON "remittance_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "remittance_allocations_pair_unique" ON "remittance_allocations" USING btree ("remittance_id","payment_id");
--> statement-breakpoint
INSERT INTO "remittance_allocations" ("remittance_id", "payment_id", "amount", "auto_matched")
SELECT "id", "matched_payment_id", "amount", "auto_matched"
FROM "remittances"
WHERE "matched_payment_id" IS NOT NULL AND "is_deleted" = false
ON CONFLICT DO NOTHING;