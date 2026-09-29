CREATE TABLE "listing_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"attachment_id" uuid,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"kind" text NOT NULL,
	"confidence" text,
	"fields" jsonb,
	"read_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_evidence" ADD CONSTRAINT "listing_evidence_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_evidence" ADD CONSTRAINT "listing_evidence_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_evidence" ADD CONSTRAINT "listing_evidence_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_evidence_request_idx" ON "listing_evidence" USING btree ("request_id","created_at");