ALTER TABLE "market_snapshots" ADD COLUMN "retrieved_at" timestamp with time zone;--> statement-breakpoint
-- Group rows (three or more) came from listings reads and were dated by when we fetched them, not when SeatData saw
-- the prices: that time is kept as retrieved_at and the provider time is marked unknown, so they no longer date a
-- trend (TREND-ACC-01). Stats rows (one or two tickets) carry SeatData's own snapshot time and are left alone.
UPDATE "market_snapshots" SET "retrieved_at" = "observed_at", "provider_as_of" = NULL, "quality_flags" = "quality_flags" || '["provider_time_unknown"]'::jsonb WHERE "quantity" >= 3 AND "fee_basis" = 'listed_price' AND "dataset_id" = '5ea7da7a-0000-4000-8000-000000000001';
