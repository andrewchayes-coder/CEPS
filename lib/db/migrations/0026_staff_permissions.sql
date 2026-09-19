CREATE TABLE "staff_permissions" (
  "user_id" uuid NOT NULL,
  "permission" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  CONSTRAINT "staff_permissions_user_id_permission_pk" PRIMARY KEY("user_id","permission"),
  CONSTRAINT "staff_permissions_permission_check" CHECK ("staff_permissions"."permission" in ('invoice_log_validate', 'invoice_approve', 'check_writing'))
);
--> statement-breakpoint
ALTER TABLE "staff_permissions" ADD CONSTRAINT "staff_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "staff_permissions" ("user_id", "permission")
SELECT u."id", p."permission"
FROM "users" u
CROSS JOIN (VALUES ('invoice_log_validate'), ('invoice_approve'), ('check_writing')) p("permission")
WHERE u."role" = 'staff'
ON CONFLICT DO NOTHING;