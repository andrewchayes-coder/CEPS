CREATE INDEX "referrals_created_at_idx" ON "referrals" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referrals_client_id_idx" ON "referrals" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "referrals_service_coordinator_id_idx" ON "referrals" USING btree ("service_coordinator_id");--> statement-breakpoint
CREATE INDEX "referrals_status_idx" ON "referrals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payments_check_date_idx" ON "payments" USING btree ("check_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_client_id_idx" ON "payments" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "payments_vendor_id_idx" ON "payments" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "payments_authorization_id_idx" ON "payments" USING btree ("authorization_id");--> statement-breakpoint
CREATE INDEX "payments_payment_type_idx" ON "payments" USING btree ("payment_type");