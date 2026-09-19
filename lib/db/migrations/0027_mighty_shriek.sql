CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "users_name_trgm_idx" ON "users" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_email_trgm_idx" ON "users" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_phone_trgm_idx" ON "users" USING gin (coalesce("phone", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clients_first_name_trgm_idx" ON "clients" USING gin ("first_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clients_last_name_trgm_idx" ON "clients" USING gin ("last_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clients_uci_number_trgm_idx" ON "clients" USING gin ("uci_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clients_full_name_trgm_idx" ON "clients" USING gin (("first_name" || ' ' || "last_name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "vendors_name_trgm_idx" ON "vendors" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "vendors_alta_vendor_number_trgm_idx" ON "vendors" USING gin (coalesce("alta_vendor_number", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "vendors_contact_person_trgm_idx" ON "vendors" USING gin (coalesce("contact_person", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "vendors_email_trgm_idx" ON "vendors" USING gin (coalesce("email", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "referrals_parent_email_trgm_idx" ON "referrals" USING gin (coalesce("parent_email", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "referrals_intake_sent_to_trgm_idx" ON "referrals" USING gin (coalesce("intake_sent_to", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "referrals_diagnosis_trgm_idx" ON "referrals" USING gin (coalesce("diagnosis", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "referrals_eligibility_category_trgm_idx" ON "referrals" USING gin (coalesce("eligibility_category", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "referrals_notes_trgm_idx" ON "referrals" USING gin (coalesce("notes", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "authorizations_auth_number_trgm_idx" ON "authorizations" USING gin ("auth_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "authorizations_service_code_trgm_idx" ON "authorizations" USING gin ("service_code" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "authorizations_activity_description_trgm_idx" ON "authorizations" USING gin (coalesce("activity_description", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "invoices_service_month_trgm_idx" ON "invoices" USING gin (coalesce("service_month", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "invoices_notes_trgm_idx" ON "invoices" USING gin (coalesce("notes", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "payments_qb_check_number_trgm_idx" ON "payments" USING gin ("qb_check_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "payments_payment_month_trgm_idx" ON "payments" USING gin (coalesce("payment_month", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "remittances_alta_reference_trgm_idx" ON "remittances" USING gin (coalesce("alta_reference", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "remittances_payment_month_trgm_idx" ON "remittances" USING gin (coalesce("payment_month", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "remittances_batch_id_trgm_idx" ON "remittances" USING gin (coalesce("remittance_batch_id", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "remittances_report_reference_trgm_idx" ON "remittances" USING gin (coalesce("report_reference", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "remittances_review_reason_trgm_idx" ON "remittances" USING gin (coalesce("review_reason", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "audit_log_action_trgm_idx" ON "audit_log" USING gin ("action" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "audit_log_entity_type_trgm_idx" ON "audit_log" USING gin (coalesce("entity_type", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "audit_log_entity_id_trgm_idx" ON "audit_log" USING gin (coalesce("entity_id", '') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "audit_log_detail_trgm_idx" ON "audit_log" USING gin (coalesce("detail", '') gin_trgm_ops);