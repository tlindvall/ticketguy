ALTER TABLE "events" ADD COLUMN "sale_status" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "public_sale_start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "public_sale_end_at" timestamp with time zone;