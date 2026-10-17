ALTER TABLE "market_fetches" ADD COLUMN "lane" text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "tracked_events" ADD COLUMN "last_listings" jsonb;--> statement-breakpoint
ALTER TABLE "tracked_events" ADD COLUMN "last_listings_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracked_events" ADD COLUMN "last_listings_as_of" timestamp with time zone;