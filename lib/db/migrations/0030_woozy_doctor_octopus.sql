ALTER TABLE "magic_links" DROP CONSTRAINT "magic_links_family_representative_id_family_representatives_id_fk";
--> statement-breakpoint
ALTER TABLE "referrals" DROP CONSTRAINT "referrals_intake_sent_to_family_rep_id_family_representatives_id_fk";
--> statement-breakpoint
DROP INDEX "users_name_trgm_idx";--> statement-breakpoint
DROP INDEX "users_email_trgm_idx";--> statement-breakpoint
DROP INDEX "clients_first_name_trgm_idx";--> statement-breakpoint
DROP INDEX "clients_last_name_trgm_idx";--> statement-breakpoint
DROP INDEX "clients_uci_number_trgm_idx";--> statement-breakpoint
DROP INDEX "vendors_name_trgm_idx";--> statement-breakpoint
DROP INDEX "authorizations_auth_number_trgm_idx";--> statement-breakpoint
DROP INDEX "authorizations_service_code_trgm_idx";--> statement-breakpoint
DROP INDEX "payments_qb_check_number_trgm_idx";--> statement-breakpoint
DROP INDEX "audit_log_action_trgm_idx";--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_family_rep_fk" FOREIGN KEY ("family_representative_id") REFERENCES "public"."family_representatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_intake_family_rep_fk" FOREIGN KEY ("intake_sent_to_family_rep_id") REFERENCES "public"."family_representatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_name_trgm_idx" ON "users" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_email_trgm_idx" ON "users" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clients_first_name_trgm_idx" ON "clients" USING gin ("first_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clients_last_name_trgm_idx" ON "clients" USING gin ("last_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clients_uci_number_trgm_idx" ON "clients" USING gin ("uci_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "vendors_name_trgm_idx" ON "vendors" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "authorizations_auth_number_trgm_idx" ON "authorizations" USING gin ("auth_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "authorizations_service_code_trgm_idx" ON "authorizations" USING gin ("service_code" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "payments_qb_check_number_trgm_idx" ON "payments" USING gin ("qb_check_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "audit_log_action_trgm_idx" ON "audit_log" USING gin ("action" gin_trgm_ops);