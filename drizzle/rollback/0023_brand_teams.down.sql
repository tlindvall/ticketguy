-- Reverses 0023_brand_teams.sql. Run by hand; the migrator never applies files in this folder.
DELETE FROM "brand_assets" WHERE "source" = 'team_file';
ALTER TABLE "brand_assets" DROP CONSTRAINT IF EXISTS "brand_assets_image_url_ck";
ALTER TABLE "brand_assets" DROP CONSTRAINT IF EXISTS "brand_assets_rights_ck";
DROP INDEX IF EXISTS "brand_assets_aliases_idx";
ALTER TABLE "brand_assets" DROP COLUMN IF EXISTS "aliases";
ALTER TABLE "brand_assets" DROP COLUMN IF EXISTS "sport";
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_rights_ck" CHECK ("rights" in ('provider_terms','licensed','unreviewed'));
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_image_https_ck" CHECK ("image_url" is null or "image_url" like 'https://%');
