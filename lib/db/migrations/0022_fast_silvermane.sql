ALTER TABLE "invoices" ALTER COLUMN "service_month" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "pos_notes" text;--> statement-breakpoint
ALTER TABLE "authorization_versions" ADD COLUMN "pos_notes" text;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD COLUMN "pos_notes" text;