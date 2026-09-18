CREATE TABLE "authorization_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authorization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"vendor_id" uuid,
	"auth_number" text NOT NULL,
	"service_code" text NOT NULL,
	"payment_type" text NOT NULL,
	"activity_description" text,
	"service_period_start" date NOT NULL,
	"service_period_end" date NOT NULL,
	"monthly_amount" numeric(12, 2),
	"one_time_amount" numeric(12, 2),
	"max_period_amount" numeric(12, 2) NOT NULL,
	"units" integer,
	"status" text NOT NULL,
	"pos_pdf_url" text,
	"received_date" date,
	"is_deleted" boolean NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid,
	"changed_fields" text[]
);
--> statement-breakpoint
ALTER TABLE "authorization_versions" ADD CONSTRAINT "authorization_versions_authorization_id_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_versions" ADD CONSTRAINT "authorization_versions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_versions" ADD CONSTRAINT "authorization_versions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_versions" ADD CONSTRAINT "authorization_versions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authorization_versions_auth_changed_at_idx" ON "authorization_versions" USING btree ("authorization_id","changed_at" DESC NULLS LAST);