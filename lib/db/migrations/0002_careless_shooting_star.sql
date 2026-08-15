CREATE INDEX "clients_last_name_idx" ON "clients" USING btree ("last_name");--> statement-breakpoint
CREATE INDEX "clients_status_idx" ON "clients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clients_assigned_coordinator_id_idx" ON "clients" USING btree ("assigned_coordinator_id");--> statement-breakpoint
CREATE INDEX "vendors_name_idx" ON "vendors" USING btree ("name");--> statement-breakpoint
CREATE INDEX "vendors_w9_status_idx" ON "vendors" USING btree ("w9_status");--> statement-breakpoint
CREATE INDEX "vendors_active_idx" ON "vendors" USING btree ("active");--> statement-breakpoint
CREATE INDEX "authorizations_client_id_idx" ON "authorizations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "authorizations_vendor_id_idx" ON "authorizations" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "authorizations_status_idx" ON "authorizations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "authorizations_created_at_idx" ON "authorizations" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invoices_client_id_idx" ON "invoices" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "invoices_vendor_id_idx" ON "invoices" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invoices_created_at_idx" ON "invoices" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "remittances_client_id_idx" ON "remittances" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "remittances_status_idx" ON "remittances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "remittances_created_at_idx" ON "remittances" USING btree ("created_at" DESC NULLS LAST);