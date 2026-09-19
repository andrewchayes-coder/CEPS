DROP INDEX IF EXISTS "users_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_email_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_phone_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "clients_first_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "clients_last_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "clients_uci_number_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "clients_full_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "vendors_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "vendors_alta_vendor_number_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "vendors_contact_person_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "vendors_email_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "referrals_parent_email_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "referrals_intake_sent_to_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "referrals_diagnosis_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "referrals_eligibility_category_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "referrals_notes_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "authorizations_auth_number_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "authorizations_service_code_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "authorizations_activity_description_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "invoices_service_month_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "invoices_notes_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "payments_qb_check_number_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "payments_payment_month_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "remittances_alta_reference_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "remittances_payment_month_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "remittances_batch_id_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "remittances_report_reference_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "remittances_review_reason_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_log_action_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_log_entity_type_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_log_entity_id_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_log_detail_trgm_idx";--> statement-breakpoint
CREATE INDEX "users_name_fts_idx" ON "users" USING gin (to_tsvector('simple', "name"));--> statement-breakpoint
CREATE INDEX "users_email_fts_idx" ON "users" USING gin (to_tsvector('simple', "email"));--> statement-breakpoint
CREATE INDEX "clients_first_name_fts_idx" ON "clients" USING gin (to_tsvector('simple', "first_name"));--> statement-breakpoint
CREATE INDEX "clients_last_name_fts_idx" ON "clients" USING gin (to_tsvector('simple', "last_name"));--> statement-breakpoint
CREATE INDEX "clients_uci_number_fts_idx" ON "clients" USING gin (to_tsvector('simple', coalesce("uci_number", '')));--> statement-breakpoint
CREATE INDEX "clients_full_name_fts_idx" ON "clients" USING gin (to_tsvector('simple', coalesce("first_name", '') || ' ' || coalesce("last_name", '')));--> statement-breakpoint
CREATE INDEX "vendors_name_fts_idx" ON "vendors" USING gin (to_tsvector('simple', "name"));--> statement-breakpoint
CREATE INDEX "vendors_alta_vendor_number_fts_idx" ON "vendors" USING gin (to_tsvector('simple', coalesce("alta_vendor_number", '')));--> statement-breakpoint
CREATE INDEX "vendors_contact_person_fts_idx" ON "vendors" USING gin (to_tsvector('simple', coalesce("contact_person", '')));--> statement-breakpoint
CREATE INDEX "vendors_email_fts_idx" ON "vendors" USING gin (to_tsvector('simple', coalesce("email", '')));--> statement-breakpoint
CREATE INDEX "referrals_parent_email_fts_idx" ON "referrals" USING gin (to_tsvector('simple', coalesce("parent_email", '')));--> statement-breakpoint
CREATE INDEX "referrals_notes_fts_idx" ON "referrals" USING gin (to_tsvector('simple', coalesce("notes", '')));--> statement-breakpoint
CREATE INDEX "authorizations_auth_number_fts_idx" ON "authorizations" USING gin (to_tsvector('simple', "auth_number"));--> statement-breakpoint
CREATE INDEX "authorizations_service_code_fts_idx" ON "authorizations" USING gin (to_tsvector('simple', "service_code"));--> statement-breakpoint
CREATE INDEX "authorizations_activity_description_fts_idx" ON "authorizations" USING gin (to_tsvector('simple', coalesce("activity_description", '')));--> statement-breakpoint
CREATE INDEX "invoices_notes_fts_idx" ON "invoices" USING gin (to_tsvector('simple', coalesce("notes", '')));--> statement-breakpoint
CREATE INDEX "payments_qb_check_number_fts_idx" ON "payments" USING gin (to_tsvector('simple', "qb_check_number"));--> statement-breakpoint
CREATE INDEX "payments_payment_month_fts_idx" ON "payments" USING gin (to_tsvector('simple', coalesce("payment_month", '')));--> statement-breakpoint
CREATE INDEX "remittances_alta_reference_fts_idx" ON "remittances" USING gin (to_tsvector('simple', coalesce("alta_reference", '')));--> statement-breakpoint
CREATE INDEX "remittances_payment_month_fts_idx" ON "remittances" USING gin (to_tsvector('simple', coalesce("payment_month", '')));--> statement-breakpoint
CREATE INDEX "remittances_batch_id_fts_idx" ON "remittances" USING gin (to_tsvector('simple', coalesce("remittance_batch_id", '')));--> statement-breakpoint
CREATE INDEX "remittances_report_reference_fts_idx" ON "remittances" USING gin (to_tsvector('simple', coalesce("report_reference", '')));--> statement-breakpoint
CREATE INDEX "remittances_review_reason_fts_idx" ON "remittances" USING gin (to_tsvector('simple', coalesce("review_reason", '')));--> statement-breakpoint
CREATE INDEX "audit_log_action_fts_idx" ON "audit_log" USING gin (to_tsvector('simple', "action"));--> statement-breakpoint
CREATE INDEX "audit_log_entity_type_fts_idx" ON "audit_log" USING gin (to_tsvector('simple', coalesce("entity_type", '')));--> statement-breakpoint
CREATE INDEX "audit_log_entity_id_fts_idx" ON "audit_log" USING gin (to_tsvector('simple', coalesce("entity_id", '')));--> statement-breakpoint
CREATE INDEX "audit_log_detail_fts_idx" ON "audit_log" USING gin (to_tsvector('simple', coalesce("detail", '')));