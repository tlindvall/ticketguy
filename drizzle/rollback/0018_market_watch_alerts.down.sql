-- Reverses 0018_market_watch_alerts.sql. Market alerts (rows with no observation) must be removed first, because
-- observation_id becomes required again; seller alerts are unaffected. Run by hand; the migrator never applies files
-- in this folder.
DELETE FROM "watch_alerts" WHERE "observation_id" IS NULL;
ALTER TABLE "watch_alerts" DROP CONSTRAINT IF EXISTS "watch_alerts_one_evidence";
ALTER TABLE "watch_alerts" DROP COLUMN IF EXISTS "market";
ALTER TABLE "watch_alerts" ALTER COLUMN "observation_id" SET NOT NULL;
