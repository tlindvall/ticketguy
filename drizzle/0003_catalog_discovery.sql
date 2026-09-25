CREATE TABLE "catalog_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"keyword_normalized" text NOT NULL,
	"city" text,
	"window_from" text,
	"window_to" text,
	"status" text NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"trigger" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "catalog_syncs_lookup_idx" ON "catalog_syncs" USING btree ("source_id","keyword_normalized","created_at");--> statement-breakpoint
CREATE INDEX "catalog_syncs_day_idx" ON "catalog_syncs" USING btree ("source_id","created_at");