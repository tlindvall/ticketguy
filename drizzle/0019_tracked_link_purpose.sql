-- Links stored before purposes were recorded are 'legacy' (their purpose is unknown); new rows default to 'reference'.
ALTER TABLE "tracked_links" ADD COLUMN "purpose" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "tracked_links" ALTER COLUMN "purpose" SET DEFAULT 'reference';--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "advice_run_id" uuid;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "event_id" uuid;
