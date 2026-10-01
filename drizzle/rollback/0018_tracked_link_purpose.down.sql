-- Reverses 0018_tracked_link_purpose.sql. All three columns are additive; dropping them loses only which links
-- were buy links and what they were bound to (the /go route then redirects every stored link as before). Run by
-- hand; the migrator never applies files in this folder.
ALTER TABLE "tracked_links" DROP COLUMN IF EXISTS "event_id";
ALTER TABLE "tracked_links" DROP COLUMN IF EXISTS "advice_run_id";
ALTER TABLE "tracked_links" DROP COLUMN IF EXISTS "purpose";
