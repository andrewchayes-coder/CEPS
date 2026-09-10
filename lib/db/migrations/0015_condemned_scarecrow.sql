CREATE TABLE "family_representatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relationship" text,
	"phone" text,
	"email" text,
	"address" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"user_id" uuid,
	"created_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "family_representative_id" uuid;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "intake_sent_to_family_rep_id" uuid;--> statement-breakpoint
ALTER TABLE "family_representatives" ADD CONSTRAINT "family_representatives_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_representatives" ADD CONSTRAINT "family_representatives_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_representatives" ADD CONSTRAINT "family_representatives_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_representatives" ADD CONSTRAINT "family_representatives_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "family_representatives_client_id_idx" ON "family_representatives" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_family_representative_id_family_representatives_id_fk" FOREIGN KEY ("family_representative_id") REFERENCES "public"."family_representatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_intake_sent_to_family_rep_id_family_representatives_id_fk" FOREIGN KEY ("intake_sent_to_family_rep_id") REFERENCES "public"."family_representatives"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "family_representatives" (
  "client_id", "name", "phone", "email", "address", "is_primary"
)
SELECT c."id", c."family_rep_name", c."family_rep_phone",
  c."family_rep_email", c."family_rep_address", true
FROM "clients" c
WHERE c."family_rep_name" IS NOT NULL
  AND btrim(c."family_rep_name") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "family_representatives" fr
    WHERE fr."client_id" = c."id"
      AND fr."name" = c."family_rep_name"
      AND fr."is_deleted" = false
  );