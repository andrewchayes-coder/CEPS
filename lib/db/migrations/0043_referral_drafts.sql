CREATE TABLE "referral_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"uci_number" text,
	"label" text NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	"supporting_document_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_drafts_valid_step" CHECK ("referral_drafts"."current_step" between 0 and 5),
	CONSTRAINT "referral_drafts_data_object" CHECK (jsonb_typeof("referral_drafts"."data") = 'object')
);
--> statement-breakpoint
ALTER TABLE "referral_drafts" ADD CONSTRAINT "referral_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_drafts_owner_uci_unique" ON "referral_drafts" USING btree ("user_id","uci_number") WHERE "referral_drafts"."uci_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_drafts_owner_untitled_unique" ON "referral_drafts" USING btree ("user_id") WHERE "referral_drafts"."uci_number" is null;--> statement-breakpoint
CREATE INDEX "referral_drafts_owner_updated_idx" ON "referral_drafts" USING btree ("user_id","updated_at" DESC NULLS LAST);