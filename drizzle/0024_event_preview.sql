CREATE TABLE "preview_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"source_image_url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_assets" DROP CONSTRAINT "brand_assets_kind_ck";--> statement-breakpoint
ALTER TABLE "brand_assets" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "preview_images" ADD CONSTRAINT "preview_images_asset_id_brand_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."brand_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "preview_images_asset_uq" ON "preview_images" USING btree ("asset_id");--> statement-breakpoint
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_kind_ck" CHECK ("brand_assets"."kind" in ('team','performer','production','venue','category','event'));