CREATE TABLE "request_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"message_id" uuid,
	"recommendation_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"recommendation_id" uuid,
	"url" text NOT NULL,
	"label" text,
	"affiliate" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "problem_types" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "request_outcomes" ADD CONSTRAINT "request_outcomes_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_outcomes" ADD CONSTRAINT "request_outcomes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_outcomes_request_idx" ON "request_outcomes" USING btree ("request_id","kind");--> statement-breakpoint
CREATE INDEX "tracked_links_request_idx" ON "tracked_links" USING btree ("request_id");