CREATE TABLE "market_listing_sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"marketplace" text NOT NULL,
	"listing_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "market_listing_sightings_uq" ON "market_listing_sightings" USING btree ("marketplace","listing_id","event_id");--> statement-breakpoint
CREATE INDEX "market_listing_sightings_listing_idx" ON "market_listing_sightings" USING btree ("listing_id");