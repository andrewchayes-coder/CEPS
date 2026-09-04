ALTER TABLE "remittances" ADD COLUMN "report_reference" text;--> statement-breakpoint
ALTER TABLE "remittances" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "remittances" ADD COLUMN "expected_amount" numeric(12, 2);