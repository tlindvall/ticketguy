-- Reverses 0025_market_lanes.sql. Run by hand; the migrator never applies files in this folder.
ALTER TABLE "tracked_events" DROP COLUMN IF EXISTS "last_listings_as_of";
ALTER TABLE "tracked_events" DROP COLUMN IF EXISTS "last_listings_at";
ALTER TABLE "tracked_events" DROP COLUMN IF EXISTS "last_listings";
ALTER TABLE "market_fetches" DROP COLUMN IF EXISTS "lane";
