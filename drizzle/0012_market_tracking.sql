CREATE TABLE "market_fetches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"event_id" uuid,
	"status" text NOT NULL,
	"calls" integer DEFAULT 1 NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"entity_id" uuid,
	"venue_id" uuid,
	"event_name" text NOT NULL,
	"event_start_at" timestamp with time zone NOT NULL,
	"basket_key" text NOT NULL,
	"quantity" integer NOT NULL,
	"seat_zone" text,
	"observed_at" timestamp with time zone NOT NULL,
	"lead_time_minutes" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"median_cents" integer,
	"active_listings" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shadow_advice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"basket_key" text NOT NULL,
	"profile" text NOT NULL,
	"quantity" integer NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"lead_time_minutes" integer NOT NULL,
	"decision" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_cents" integer NOT NULL,
	"active_listings" integer,
	"checkpoint_at" timestamp with time zone NOT NULL,
	"outcome_price_cents" integer,
	"outcome_active_listings" integer,
	"outcome_at" timestamp with time zone,
	"verdict" text,
	"delta_cents" integer,
	"method_version" text NOT NULL,
	"scored_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tracked_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text,
	"state" text DEFAULT 'pending_match' NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_observed_at" timestamp with time zone,
	"match_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_history" ADD CONSTRAINT "market_history_dataset_id_market_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."market_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_history" ADD CONSTRAINT "market_history_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_history" ADD CONSTRAINT "market_history_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_advice" ADD CONSTRAINT "shadow_advice_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_events" ADD CONSTRAINT "tracked_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_fetches_provider_at_idx" ON "market_fetches" USING btree ("provider","at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_history_event_basket_time_uq" ON "market_history" USING btree ("provider_event_id","basket_key","observed_at");--> statement-breakpoint
CREATE INDEX "market_history_entity_venue_idx" ON "market_history" USING btree ("entity_id","venue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_advice_uq" ON "shadow_advice" USING btree ("event_id","basket_key","profile","decided_at");--> statement-breakpoint
CREATE INDEX "shadow_advice_unscored_idx" ON "shadow_advice" USING btree ("scored_at","checkpoint_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_events_event_provider_uq" ON "tracked_events" USING btree ("event_id","provider");--> statement-breakpoint
CREATE INDEX "tracked_events_state_next_idx" ON "tracked_events" USING btree ("state","next_poll_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_snapshots_event_basket_time_uq" ON "market_snapshots" USING btree ("event_id","basket_key","observed_at");