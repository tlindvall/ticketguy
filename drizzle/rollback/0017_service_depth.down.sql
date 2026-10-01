-- Reverses 0017_service_depth.sql. All six columns are additive and nullable; dropping them loses only the
-- recorded policy decisions, watch constraint baskets and pause reasons (watches then fall back to reading the
-- basket from their request revision). Run by hand; the migrator never applies files in this folder.
ALTER TABLE "watches" DROP COLUMN IF EXISTS "constraints";
ALTER TABLE "watches" DROP COLUMN IF EXISTS "pause_reason";
ALTER TABLE "tracked_events" DROP COLUMN IF EXISTS "pause_reason";
ALTER TABLE "research_runs" DROP COLUMN IF EXISTS "service_policy";
ALTER TABLE "request_versions" DROP COLUMN IF EXISTS "service_policy";
ALTER TABLE "events" DROP COLUMN IF EXISTS "classification";
