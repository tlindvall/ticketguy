ALTER TABLE "watch_alerts" ALTER COLUMN "observation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "watch_alerts" ADD COLUMN "market" jsonb;--> statement-breakpoint
ALTER TABLE "watch_alerts" ADD CONSTRAINT "watch_alerts_one_evidence" CHECK (("watch_alerts"."observation_id" is null) <> ("watch_alerts"."market" is null));