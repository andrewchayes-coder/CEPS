ALTER TABLE "referrals" ADD COLUMN "submitted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "coordinator_review_status" text;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "coordinator_reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "coordinator_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "coordinator_review_note" text;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_coordinator_reviewed_by_users_id_fk" FOREIGN KEY ("coordinator_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_coordinator_review_status_check" CHECK ("referrals"."coordinator_review_status" is null or "referrals"."coordinator_review_status" in ('pending', 'approved', 'rejected'));