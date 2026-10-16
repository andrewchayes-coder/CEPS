ALTER TABLE "invoices" ADD COLUMN "service_start_date" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "service_end_date" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_service_dates_check" CHECK ("invoices"."service_start_date" is null or "invoices"."service_end_date" is null or "invoices"."service_start_date" <= "invoices"."service_end_date");