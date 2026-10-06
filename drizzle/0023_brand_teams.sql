ALTER TABLE "brand_assets" DROP CONSTRAINT "brand_assets_image_https_ck";--> statement-breakpoint
ALTER TABLE "brand_assets" DROP CONSTRAINT "brand_assets_rights_ck";--> statement-breakpoint
ALTER TABLE "brand_assets" ADD COLUMN "sport" text;--> statement-breakpoint
ALTER TABLE "brand_assets" ADD COLUMN "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "brand_assets_aliases_idx" ON "brand_assets" USING gin ("aliases");--> statement-breakpoint
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_image_url_ck" CHECK ("brand_assets"."image_url" is null or "brand_assets"."image_url" like 'https://%' or "brand_assets"."image_url" like '/%');--> statement-breakpoint
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_rights_ck" CHECK ("brand_assets"."rights" in ('approved','provider_terms','licensed','unreviewed'));