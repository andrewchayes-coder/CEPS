ALTER TABLE "unmatched_pos_documents" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD COLUMN "parse_status" text DEFAULT 'parsed' NOT NULL;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD COLUMN "parse_error" text;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD COLUMN "review_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD COLUMN "discard_reason" text;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD COLUMN "suggested_authorization_id" uuid;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD COLUMN "resulting_authorization_id" uuid;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD CONSTRAINT "upos_suggested_auth_fk" FOREIGN KEY ("suggested_authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD CONSTRAINT "upos_reviewed_by_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD CONSTRAINT "upos_result_auth_fk" FOREIGN KEY ("resulting_authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upos_review_created_idx" ON "unmatched_pos_documents" USING btree ("review_status","created_at");--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD CONSTRAINT "upos_parse_status_check" CHECK ("unmatched_pos_documents"."parse_status" IN ('queued', 'parsed', 'failed'));--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD CONSTRAINT "upos_review_status_check" CHECK ("unmatched_pos_documents"."review_status" IN ('pending', 'confirmed', 'discarded'));