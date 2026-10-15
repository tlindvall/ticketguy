-- Reverses 0024_event_preview.sql. Run by hand; the migrator never applies files in this folder.
DROP TABLE IF EXISTS "preview_images";
DELETE FROM "brand_assets" WHERE "kind" = 'event';
ALTER TABLE "brand_assets" DROP CONSTRAINT IF EXISTS "brand_assets_kind_ck";
ALTER TABLE "brand_assets" DROP COLUMN IF EXISTS "source_url";
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_kind_ck" CHECK ("kind" in ('team','performer','production','venue','category'));
