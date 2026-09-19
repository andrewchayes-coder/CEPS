ALTER TABLE "unmatched_pos_documents" ADD COLUMN "suggested_client_id" uuid;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD COLUMN "suggestion_method" text;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD COLUMN "suggested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD CONSTRAINT "unmatched_pos_documents_suggested_client_id_clients_id_fk" FOREIGN KEY ("suggested_client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD CONSTRAINT "unmatched_pos_documents_suggestion_method_check" CHECK ("suggestion_method" IS NULL OR "suggestion_method" IN ('uci', 'name'));