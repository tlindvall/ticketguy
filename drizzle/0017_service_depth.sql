ALTER TABLE "events" ADD COLUMN "classification" jsonb;--> statement-breakpoint
ALTER TABLE "request_versions" ADD COLUMN "service_policy" jsonb;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "service_policy" jsonb;--> statement-breakpoint
ALTER TABLE "tracked_events" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "constraints" jsonb;