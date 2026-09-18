CREATE TABLE "unmatched_pos_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pos_pdf_url" text NOT NULL,
	"source_file_name" text NOT NULL,
	"client_name" text,
	"client_address" text,
	"client_phone" text,
	"uci_number" text,
	"auth_number" text,
	"service_code" text,
	"activity_description" text,
	"service_period_start" text,
	"service_period_end" text,
	"units" integer,
	"monthly_amount" numeric(12, 2),
	"max_period_amount" numeric(12, 2),
	"caseworker_name" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "unmatched_pos_documents" ADD CONSTRAINT "unmatched_pos_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "unmatched_pos_documents_created_at_idx" ON "unmatched_pos_documents" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "unmatched_pos_documents_uci_number_idx" ON "unmatched_pos_documents" USING btree ("uci_number");