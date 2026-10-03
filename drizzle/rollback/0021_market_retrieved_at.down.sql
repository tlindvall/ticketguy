-- Reverses 0021_market_retrieved_at.sql. Group rows keep provider_as_of NULL and their provider_time_unknown flag:
-- the fetch time they used to carry there was never the provider's. Run by hand; the migrator never applies files in
-- this folder.
ALTER TABLE "market_snapshots" DROP COLUMN IF EXISTS "retrieved_at";
