ALTER TABLE "message_threads" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_threads" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "msg_threads_resolved_by_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;