DROP INDEX "users_email_fts_idx";--> statement-breakpoint
DROP INDEX "vendors_email_fts_idx";--> statement-breakpoint
DROP INDEX "referrals_parent_email_fts_idx";--> statement-breakpoint
CREATE INDEX "users_email_fts_idx" ON "users" USING gin (to_tsvector('simple', regexp_replace("email", '[^a-zA-Z0-9]+', ' ', 'g')));--> statement-breakpoint
CREATE INDEX "vendors_email_fts_idx" ON "vendors" USING gin (to_tsvector('simple', regexp_replace(coalesce("email", ''), '[^a-zA-Z0-9]+', ' ', 'g')));--> statement-breakpoint
CREATE INDEX "referrals_parent_email_fts_idx" ON "referrals" USING gin (to_tsvector('simple', regexp_replace(coalesce("parent_email", ''), '[^a-zA-Z0-9]+', ' ', 'g')));