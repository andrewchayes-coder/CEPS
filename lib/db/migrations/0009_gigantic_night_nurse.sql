ALTER TABLE "referrals" ADD COLUMN "intake_sent_to" text;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "intake_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "signer_relationship" text;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "cost" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "payment_schedule" text;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "payment_type_requested" text;